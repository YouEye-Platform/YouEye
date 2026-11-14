// Package jsonkeep lets an older Spine rewrite a JSON record that a newer
// Spine extended, without dropping the fields it doesn't know.
//
// The rule for records on State and Data (docs/spine.md): readers ignore
// unknown keys; writers keep them. Marshal(value, previous) encodes value and
// copies every key of previous that value's type doesn't declare, at every
// object level the type describes. Keys the type declares are always taken
// from value, so a cleared field stays cleared. Lists of structs are merged by
// the field tagged `jsonkeep:"key"` (else taken as they are).
package jsonkeep

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
)

// Marshal encodes value as indented JSON with a trailing newline, keeping the
// keys of previous (a former version of the same record, may be nil or
// invalid) that value's type doesn't know.
func Marshal(value any, previous []byte) ([]byte, error) {
	current, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	merged := current
	if len(bytes.TrimSpace(previous)) > 0 {
		if out, ok := merge(current, previous, reflect.TypeOf(value)); ok {
			merged = out
		}
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, merged, "", "  "); err != nil {
		return nil, err
	}
	buf.WriteByte('\n')
	return buf.Bytes(), nil
}

// merge returns current plus the unknown keys of previous for type t. ok is
// false when either side is not a JSON object (then current is used as is).
func merge(current, previous []byte, t reflect.Type) ([]byte, bool) {
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t != nil && t.Kind() == reflect.Map && t.Key().Kind() == reflect.String {
		return mergeMap(current, previous, t.Elem())
	}
	if t != nil && t.Kind() == reflect.Slice {
		return mergeSlice(current, previous, t.Elem())
	}
	if t == nil || t.Kind() != reflect.Struct {
		return current, false
	}
	var now, before map[string]json.RawMessage
	if json.Unmarshal(current, &now) != nil || json.Unmarshal(previous, &before) != nil || now == nil || before == nil {
		return current, false
	}
	known := fields(t)
	for key, old := range before {
		fieldType, declared := known[key]
		if !declared {
			now[key] = old
			continue
		}
		if fresh, present := now[key]; present {
			if out, ok := merge(fresh, old, fieldType); ok {
				now[key] = out
			}
		}
	}
	out, err := json.Marshal(now)
	return out, err == nil
}

// mergeSlice merges the elements of a list of structs that carry the same
// identity: the field tagged `jsonkeep:"key"`. Without such a field the list
// is taken as it is. An element missing from current is not brought back.
func mergeSlice(current, previous []byte, elem reflect.Type) ([]byte, bool) {
	for elem.Kind() == reflect.Pointer {
		elem = elem.Elem()
	}
	if elem.Kind() != reflect.Struct {
		return current, false
	}
	key := ""
	for i := 0; i < elem.NumField(); i++ {
		if f := elem.Field(i); f.Tag.Get("jsonkeep") == "key" {
			key, _, _ = strings.Cut(f.Tag.Get("json"), ",")
		}
	}
	if key == "" {
		return current, false
	}
	var now, before []json.RawMessage
	if json.Unmarshal(current, &now) != nil || json.Unmarshal(previous, &before) != nil {
		return current, false
	}
	identity := func(raw json.RawMessage) string {
		var object map[string]json.RawMessage
		if json.Unmarshal(raw, &object) != nil {
			return ""
		}
		return string(object[key])
	}
	old := map[string]json.RawMessage{}
	for _, raw := range before {
		if id := identity(raw); id != "" {
			old[id] = raw
		}
	}
	for i, raw := range now {
		if previous, ok := old[identity(raw)]; ok && identity(raw) != "" {
			if out, ok := merge(raw, previous, elem); ok {
				now[i] = out
			}
		}
	}
	out, err := json.Marshal(now)
	return out, err == nil
}

// mergeMap merges the entries present in both maps (a map key missing from
// current was deleted on purpose, so it is not brought back).
func mergeMap(current, previous []byte, elem reflect.Type) ([]byte, bool) {
	var now, before map[string]json.RawMessage
	if json.Unmarshal(current, &now) != nil || json.Unmarshal(previous, &before) != nil || now == nil || before == nil {
		return current, false
	}
	for key, fresh := range now {
		if old, ok := before[key]; ok {
			if out, ok := merge(fresh, old, elem); ok {
				now[key] = out
			}
		}
	}
	out, err := json.Marshal(now)
	return out, err == nil
}

// fields maps the JSON names a struct type declares (including embedded
// structs' fields) to their types.
func fields(t reflect.Type) map[string]reflect.Type {
	out := map[string]reflect.Type{}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "-" || (!f.IsExported() && !f.Anonymous) {
			continue
		}
		name, _, _ := strings.Cut(tag, ",")
		ft := f.Type
		if f.Anonymous && name == "" {
			for ft.Kind() == reflect.Pointer {
				ft = ft.Elem()
			}
			if ft.Kind() == reflect.Struct {
				for k, v := range fields(ft) {
					out[k] = v
				}
				continue
			}
		}
		if name == "" {
			name = f.Name
		}
		out[name] = ft
	}
	return out
}
