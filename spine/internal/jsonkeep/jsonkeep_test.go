package jsonkeep

import (
	"encoding/json"
	"testing"
)

type inner struct {
	A string `json:"a"`
	B string `json:"b,omitempty"`
}

type record struct {
	Name  string `json:"name"`
	Inner inner  `json:"inner"`
	Gone  string `json:"gone,omitempty"`
	Skip  string `json:"-"`
}

func TestMarshalKeepsUnknownKeysAtEveryLevel(t *testing.T) {
	previous := []byte(`{"name":"old","gone":"was set","future":{"x":1},"inner":{"a":"old","b":"old","later":[1,2]}}`)
	out, err := Marshal(record{Name: "new", Inner: inner{A: "new"}}, previous)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	in := got["inner"].(map[string]any)
	if got["name"] != "new" || got["future"] == nil || in["a"] != "new" || in["later"] == nil {
		t.Fatalf("unknown keys lost or known keys not replaced: %s", out)
	}
	// Declared fields come from the new value: cleared ones stay cleared.
	if _, ok := got["gone"]; ok {
		t.Fatalf("cleared field came back: %s", out)
	}
	if _, ok := in["b"]; ok {
		t.Fatalf("cleared nested field came back: %s", out)
	}
	// No or broken previous content: just the value.
	for _, prev := range [][]byte{nil, []byte("{"), []byte(`[1]`)} {
		if out, err := Marshal(record{Name: "x"}, prev); err != nil || string(out) != "{\n  \"name\": \"x\",\n  \"inner\": {\n    \"a\": \"\"\n  }\n}\n" {
			t.Fatalf("%q: %q %v", prev, out, err)
		}
	}
}

type slots struct {
	Slots map[string]*inner `json:"slots"`
}

func TestMarshalMergesMapEntries(t *testing.T) {
	previous := []byte(`{"slots":{"A":{"a":"1","pin":"x"},"B":{"a":"2"}}}`)
	out, err := Marshal(slots{Slots: map[string]*inner{"A": {A: "3"}}}, previous)
	if err != nil {
		t.Fatal(err)
	}
	var got struct{ Slots map[string]map[string]string }
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.Slots["A"]["a"] != "3" || got.Slots["A"]["pin"] != "x" || got.Slots["B"] != nil {
		t.Fatalf("map merge: %s", out)
	}
}

type item struct {
	ID   string `json:"id" jsonkeep:"key"`
	Name string `json:"name"`
}

type list struct {
	Items []item `json:"items"`
}

func TestMarshalMergesListElementsByKey(t *testing.T) {
	previous := []byte(`{"items":[{"id":"a","name":"x","shell":"zsh"},{"id":"b","name":"y","extra":1},{"id":"c"}]}`)
	out, err := Marshal(list{Items: []item{{ID: "b", Name: "Y"}, {ID: "a", Name: "X"}}}, previous)
	if err != nil {
		t.Fatal(err)
	}
	var got struct{ Items []map[string]any }
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Items) != 2 || got.Items[0]["extra"] == nil || got.Items[0]["name"] != "Y" || got.Items[1]["shell"] != "zsh" {
		t.Fatalf("list merge: %s", out)
	}
}
