// Package spineselect keeps the Spine an appliance runs separately from the
// Spine binary baked into the immutable OS image.
//
// The baked binary is the seed: the boot/storage-preparation and recovery
// helper, and the launcher. Selected Spine payloads live in protected State,
// addressed by SHA-256, with one small selection record per System slot
// (current, previous, trial) replaced atomically. A slot without a record runs
// the seed, so booting a fresh image (or the other slot after a rollback)
// always runs that slot's own choice.
package spineselect

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/jsonkeep"
)

const (
	// DefaultRoot holds selected Spine payloads and the selection record.
	DefaultRoot = "/var/lib/youeye-state/spine"
	// BakedPath is the seed Spine inside the immutable OS image.
	BakedPath = "/usr/local/bin/youeye"
	// HelperContract is the boot-helper contract this source implements: the
	// interface between the seed (prepare, launcher, recovery) and the units.
	HelperContract = 1
	// DiskLayout is the State/Data layout this source supports.
	DiskLayout = 1
	// MaxTrialStarts bounds how often an unconfirmed trial Spine may start
	// before the launcher abandons it and returns to the slot's current one.
	MaxTrialStarts = 3

	selectionSchema = "youeye.spine-selection.v1"
	selectionFile   = "selection.json"
	payloadName     = "youeye"
)

var digestRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Entry identifies one Spine runtime and what it was built for. SHA256 is its
// identity: the payload is stored and checked under it, and nothing compares
// the other fields with a running binary.
//
// Version, Line and SourceTree describe it for people. Version is never
// empty, because every Spine that may run on this box reads the record, and
// one up to 0.6.11 skips an entry without it: it holds the name the release
// gave this Spine (a build name up to 0.6.12), else what the binary reports,
// else the line. Line (X.Y.Z) and SourceTree (the git tree it was built from)
// are written from 0.6.12 on and absent in older entries.
//
// DescribedSHA256 says which binary Line and SourceTree describe. An older
// Spine that replaces an entry keeps the keys it does not know in place
// (jsonkeep), so they could end up next to another binary's digest; Load
// drops them unless DescribedSHA256 is the entry's own SHA256.
type Entry struct {
	SHA256          string `json:"sha256"`
	Version         string `json:"version"`
	Line            string `json:"line,omitempty"`
	SourceTree      string `json:"source_tree,omitempty"`
	DescribedSHA256 string `json:"described_sha256,omitempty"`
	HelperContract  int    `json:"helper_contract"`
	DiskLayout      int    `json:"disk_layout"`
	TrialStarts     int    `json:"trial_starts,omitempty"`
}

// describe keeps Line and SourceTree only for the binary they were written
// for, and marks them as this entry's.
func (e *Entry) describe(trusted bool) {
	if !trusted && e.DescribedSHA256 != e.SHA256 {
		e.Line, e.SourceTree = "", ""
	}
	e.DescribedSHA256 = ""
	if e.Line != "" || e.SourceTree != "" {
		e.DescribedSHA256 = e.SHA256
	}
}

// Slot is the selection of one System slot.
type Slot struct {
	Current  *Entry `json:"current,omitempty"`
	Previous *Entry `json:"previous,omitempty"`
	Trial    *Entry `json:"trial,omitempty"`
}

// Selection is the durable launcher record, keyed by System slot ("A", "B").
type Selection struct {
	Schema    string           `json:"schema"`
	Slots     map[string]*Slot `json:"slots"`
	UpdatedAt time.Time        `json:"updated_at"`
}

// Host describes the running image a selected Spine must be compatible with.
type Host struct {
	DiskLayout     int `json:"disk_layout"`
	HelperContract int `json:"helper_contract"`
}

// ThisHost is the host contract implemented by the running source.
func ThisHost() Host { return Host{DiskLayout: DiskLayout, HelperContract: HelperContract} }

// TargetSlotHost is the host to select e for on a slot an image update just
// wrote: the disk layout is this disk's, the helper contract is the target
// image's, which only that slot's launcher can check (at boot).
func TargetSlotHost(e Entry) Host {
	return Host{DiskLayout: DiskLayout, HelperContract: e.HelperContract}
}

// ErrNoSelection means no selected Spine exists; the seed runs.
var ErrNoSelection = errors.New("no selected Spine")

func validSlot(slot string) bool { return slot == "A" || slot == "B" }

func (e Entry) valid() error {
	if !digestRE.MatchString(e.SHA256) {
		return fmt.Errorf("selected Spine digest is invalid")
	}
	if e.Version == "" || e.HelperContract <= 0 || e.DiskLayout <= 0 {
		return fmt.Errorf("selected Spine identity is incomplete")
	}
	return nil
}

// PayloadPath is the content-addressed location of a selected Spine.
func PayloadPath(root, digest string) string {
	return filepath.Join(root, digest, payloadName)
}

// Load reads the selection record. A missing record returns an empty
// selection and ErrNoSelection.
func Load(root string) (Selection, error) {
	empty := Selection{Schema: selectionSchema, Slots: map[string]*Slot{}}
	raw, err := os.ReadFile(filepath.Join(root, selectionFile))
	if os.IsNotExist(err) {
		return empty, ErrNoSelection
	}
	if err != nil {
		return empty, err
	}
	var s Selection
	if err := json.Unmarshal(raw, &s); err != nil || s.Schema != selectionSchema {
		return empty, fmt.Errorf("spine selection record is invalid")
	}
	if s.Slots == nil {
		s.Slots = map[string]*Slot{}
	}
	// One unreadable slot or entry is ignored (that slot falls back to its
	// seed Spine); the rest of the record stays usable.
	for name, slot := range s.Slots {
		if !validSlot(name) || slot == nil {
			delete(s.Slots, name)
			continue
		}
		for _, e := range []**Entry{&slot.Current, &slot.Previous, &slot.Trial} {
			if *e != nil && (*e).valid() != nil {
				*e = nil
			}
			if *e != nil {
				(*e).describe(false)
			}
		}
	}
	return s, nil
}

func (s *Selection) slot(name string) *Slot {
	if s.Slots == nil {
		s.Slots = map[string]*Slot{}
	}
	if s.Slots[name] == nil {
		s.Slots[name] = &Slot{}
	}
	return s.Slots[name]
}

// Save atomically replaces the selection record.
func Save(root string, s Selection, now time.Time) error {
	return save(root, s, now, "")
}

// save is Save; replaced names a slot whose record is written whole (an image
// update wrote the slot), so nothing the old record held for it is kept.
func save(root string, s Selection, now time.Time, replaced string) error {
	s.Schema = selectionSchema
	s.UpdatedAt = now.UTC()
	for name, slot := range s.Slots {
		if slot == nil || slot.Current == nil && slot.Previous == nil && slot.Trial == nil {
			delete(s.Slots, name)
			continue
		}
		// Entries in memory came from Load (checked) or from this Spine.
		for _, e := range []*Entry{slot.Current, slot.Previous, slot.Trial} {
			if e != nil {
				e.describe(true)
			}
		}
	}
	previous, _ := os.ReadFile(filepath.Join(root, selectionFile))
	if replaced != "" {
		previous = withoutSlot(previous, replaced)
	}
	raw, err := jsonkeep.Marshal(s, previous)
	if err != nil {
		return err
	}
	if raw, err = keepUnreadable(raw, previous); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(root, ".selection-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(root, selectionFile)); err != nil {
		return err
	}
	return syncDir(root)
}

// withoutSlot is the record without what it holds for one slot: neither keys
// this Spine doesn't know nor entries it can't read are carried over from it.
// A record that can't be taken apart is not carried over at all.
func withoutSlot(record []byte, name string) []byte {
	var fields map[string]json.RawMessage
	if len(record) == 0 || json.Unmarshal(record, &fields) != nil {
		return nil
	}
	var slots map[string]json.RawMessage
	if len(fields["slots"]) > 0 && json.Unmarshal(fields["slots"], &slots) != nil {
		return nil
	}
	if _, held := slots[name]; !held {
		return record
	}
	delete(slots, name)
	var err error
	if fields["slots"], err = json.Marshal(slots); err != nil {
		return nil
	}
	if record, err = json.Marshal(fields); err != nil {
		return nil
	}
	return record
}

// keepUnreadable puts back the slots and entries of previous that Load
// skipped (another Spine wrote them in a form this one can't use), unless the
// new record has something in their place: they belong to that Spine.
func keepUnreadable(raw, previous []byte) ([]byte, error) {
	var before struct {
		Slots map[string]map[string]json.RawMessage `json:"slots"`
	}
	if len(previous) == 0 || json.Unmarshal(previous, &before) != nil || len(before.Slots) == 0 {
		return raw, nil
	}
	var after map[string]json.RawMessage
	if err := json.Unmarshal(raw, &after); err != nil {
		return nil, err
	}
	slots := map[string]map[string]json.RawMessage{}
	if len(after["slots"]) > 0 && string(after["slots"]) != "null" {
		if err := json.Unmarshal(after["slots"], &slots); err != nil {
			return nil, err
		}
	}
	changed := false
	for name, roles := range before.Slots {
		for role, entryRaw := range roles {
			var e Entry
			readable := validSlot(name) && (role == "current" || role == "previous" || role == "trial") &&
				json.Unmarshal(entryRaw, &e) == nil && e.valid() == nil
			if readable || slots[name][role] != nil {
				continue
			}
			if slots[name] == nil {
				slots[name] = map[string]json.RawMessage{}
			}
			slots[name][role], changed = entryRaw, true
		}
	}
	if !changed {
		return raw, nil
	}
	var err error
	if after["slots"], err = json.Marshal(slots); err != nil {
		return nil, err
	}
	out, err := json.MarshalIndent(after, "", "  ")
	return append(out, '\n'), err
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// Compatible reports whether e can run on host.
func Compatible(e Entry, host Host) error {
	if e.DiskLayout != host.DiskLayout {
		return fmt.Errorf("selected Spine %s targets disk layout %d, host is %d", e.label(), e.DiskLayout, host.DiskLayout)
	}
	if e.HelperContract != host.HelperContract {
		return fmt.Errorf("selected Spine %s needs helper contract %d, host provides %d", e.label(), e.HelperContract, host.HelperContract)
	}
	return nil
}

// Verify checks that a selected Spine payload is intact and compatible.
func Verify(root string, e Entry, host Host) (string, error) {
	if err := e.valid(); err != nil {
		return "", err
	}
	if err := Compatible(e, host); err != nil {
		return "", err
	}
	path := PayloadPath(root, e.SHA256)
	info, err := os.Lstat(path)
	if err != nil {
		return "", fmt.Errorf("selected Spine %s payload is missing", e.label())
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
		return "", fmt.Errorf("selected Spine %s payload has unsafe type or permissions", e.label())
	}
	got, err := FileDigest(path)
	if err != nil {
		return "", err
	}
	if got != e.SHA256 {
		return "", fmt.Errorf("selected Spine %s payload digest mismatch", e.label())
	}
	return path, nil
}

// FileDigest is the lowercase hex SHA-256 of a file.
func FileDigest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Resolution is the launcher's decision for one slot.
type Resolution struct {
	Path  string `json:"path,omitempty"` // empty means run the seed
	Entry *Entry `json:"entry,omitempty"`
	Role  string `json:"role"` // "trial", "current", "previous" or "seed"
	// Skipped records why preferred selections were not used.
	Skipped []string `json:"skipped,omitempty"`
}

// Resolve chooses which Spine a slot runs: an unconfirmed trial while it has
// start attempts left, otherwise current, then previous, then the seed.
// countTrialStart records a start attempt for the trial (the API service does
// this; other commands only read).
func Resolve(root, slotName string, host Host, countTrialStart bool, now time.Time) (Resolution, error) {
	s, err := Load(root)
	if errors.Is(err, ErrNoSelection) {
		return Resolution{Role: "seed"}, nil
	}
	if err != nil {
		return Resolution{Role: "seed", Skipped: []string{err.Error()}}, nil
	}
	slot := s.Slots[slotName]
	if slot == nil {
		return Resolution{Role: "seed"}, nil
	}
	var res Resolution
	if slot.Trial != nil {
		if slot.Trial.TrialStarts >= MaxTrialStarts {
			res.Skipped = append(res.Skipped, fmt.Sprintf("trial Spine %s abandoned after %d unconfirmed starts", slot.Trial.label(), slot.Trial.TrialStarts))
			slot.Trial = nil
			if err := Save(root, s, now); err != nil {
				return res, err
			}
		} else if path, verr := Verify(root, *slot.Trial, host); verr != nil {
			res.Skipped = append(res.Skipped, verr.Error())
		} else {
			if countTrialStart {
				slot.Trial.TrialStarts++
				if err := Save(root, s, now); err != nil {
					return res, err
				}
			}
			t := *slot.Trial
			res.Path, res.Entry, res.Role = path, &t, "trial"
			return res, nil
		}
	}
	for _, c := range []struct {
		role string
		e    *Entry
	}{{"current", slot.Current}, {"previous", slot.Previous}} {
		if c.e == nil {
			continue
		}
		path, verr := Verify(root, *c.e, host)
		if verr != nil {
			res.Skipped = append(res.Skipped, verr.Error())
			continue
		}
		e := *c.e
		res.Path, res.Entry, res.Role = path, &e, c.role
		return res, nil
	}
	res.Role = "seed"
	return res, nil
}

// Stage copies a Spine binary into State under its digest, verifying it. The
// digest must already be authenticated by the caller (accepted release).
func Stage(root, src string, e Entry) error {
	if err := e.valid(); err != nil {
		return err
	}
	dir := filepath.Join(root, e.SHA256)
	final := PayloadPath(root, e.SHA256)
	if got, err := FileDigest(final); err == nil && got == e.SHA256 {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(dir, ".stage-")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), in); err != nil {
		tmp.Close()
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != e.SHA256 {
		tmp.Close()
		return fmt.Errorf("staged Spine %s digest mismatch", e.label())
	}
	if err := tmp.Chmod(0o500); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, final); err != nil {
		return err
	}
	return syncDir(dir)
}

// BeginTrial records a staged Spine as the slot's trial selection.
func BeginTrial(root, slotName string, e Entry, host Host, now time.Time) error {
	if !validSlot(slotName) {
		return fmt.Errorf("unknown System slot %q", slotName)
	}
	if _, err := Verify(root, e, host); err != nil {
		return err
	}
	s, err := Load(root)
	if err != nil && !errors.Is(err, ErrNoSelection) {
		return err
	}
	e.TrialStarts = 0
	s.slot(slotName).Trial = &e
	return Save(root, s, now)
}

// Commit promotes a healthy trial: trial becomes current, current becomes previous.
func Commit(root, slotName, digest string, now time.Time) error {
	s, err := Load(root)
	if err != nil {
		return err
	}
	slot := s.Slots[slotName]
	if slot == nil || slot.Trial == nil || slot.Trial.SHA256 != digest {
		return fmt.Errorf("no trial Spine %s to commit on slot %s", digest, slotName)
	}
	t := *slot.Trial
	t.TrialStarts = 0
	if slot.Current != nil && slot.Current.SHA256 != t.SHA256 {
		prev := *slot.Current
		slot.Previous = &prev
	}
	slot.Current, slot.Trial = &t, nil
	return Save(root, s, now)
}

// Abort drops the slot's trial selection; its current selection keeps running.
func Abort(root, slotName string, now time.Time) error {
	s, err := Load(root)
	if errors.Is(err, ErrNoSelection) {
		return nil
	}
	if err != nil {
		return err
	}
	slot := s.Slots[slotName]
	if slot == nil || slot.Trial == nil {
		return nil
	}
	slot.Trial = nil
	return Save(root, s, now)
}

// Select makes e the only selected Spine of a slot an image update just
// wrote: the new slot boots with its release's Spine. What the record held for
// the slot belonged to the image that was there before, so none of it stays,
// not as previous either: an older Spine may not read what the new release
// writes (the installed receipt, the records on State). When e cannot run, the
// slot falls back to the seed of its own image, which is the release's Spine
// or the one its image was built with.
func Select(root, slotName string, e Entry, host Host, now time.Time) error {
	if !validSlot(slotName) {
		return fmt.Errorf("unknown System slot %q", slotName)
	}
	if _, err := Verify(root, e, host); err != nil {
		return err
	}
	s, err := Load(root)
	if err != nil && !errors.Is(err, ErrNoSelection) {
		return err
	}
	e.TrialStarts = 0
	s.Slots[slotName] = &Slot{Current: &e}
	return save(root, s, now, slotName)
}

// DropUndescribedFallbacks removes the previous and trial entries of a slot
// that no Spine from 0.6.12 on wrote: those without a description of their own
// (described_sha256). A Spine up to 0.6.11 kept the slot's previous entry when
// it selected a Spine for an image update, so the slot that holds the 0.6.12
// image can still name a 0.6.11 Spine. That one reads release documents up to
// reader 1: on a failed current payload, or on `youeye spine rollback`, it
// would run against a receipt it calls broken. Without the entries the slot
// falls back to the seed of its own image.
//
// The slot's current entry stays, described or not: it is the Spine that ran
// the slot's release. The caller names a slot whose image seeds a Spine that
// reads what the box now writes (the update engine: the slot an image update
// to a reader-2 release was staged from). It returns what it removed; payloads
// stay on State. A record that cannot be read has nothing to remove: its slots
// run their seeds.
func DropUndescribedFallbacks(root, slotName string, now time.Time) ([]Entry, error) {
	if !validSlot(slotName) {
		return nil, fmt.Errorf("unknown System slot %q", slotName)
	}
	s, err := Load(root)
	if err != nil {
		return nil, nil
	}
	slot := s.Slots[slotName]
	if slot == nil {
		return nil, nil
	}
	var dropped []Entry
	// Load cleared every description that is not the entry's own.
	for _, e := range []**Entry{&slot.Previous, &slot.Trial} {
		if *e != nil && (*e).DescribedSHA256 == "" {
			dropped = append(dropped, **e)
			*e = nil
		}
	}
	if len(dropped) == 0 {
		return nil, nil
	}
	return dropped, Save(root, s, now)
}

// Rollback makes the slot's previous Spine current again.
func Rollback(root, slotName string, now time.Time) error {
	s, err := Load(root)
	if err != nil {
		return err
	}
	slot := s.Slots[slotName]
	if slot == nil || slot.Previous == nil {
		return fmt.Errorf("slot %s has no previous Spine (`youeye spine use-seed` runs the seed of its image)", slotName)
	}
	slot.Current, slot.Previous, slot.Trial = slot.Previous, slot.Current, nil
	return Save(root, s, now)
}

// UseSeed clears the slot's selection: the slot runs the seed baked into its image.
func UseSeed(root, slotName string, now time.Time) error {
	s, err := Load(root)
	if errors.Is(err, ErrNoSelection) {
		return nil
	}
	if err != nil {
		return err
	}
	delete(s.Slots, slotName)
	return Save(root, s, now)
}

// Running reports whether digest is a Spine the slot may run: the seed, or one
// of the slot's selected entries. This replaces any identity binding between
// the running Spine and the image release set.
func Running(root, slotName, digest, seedDigest string) error {
	if digest == seedDigest {
		return nil
	}
	s, err := Load(root)
	if err != nil {
		return fmt.Errorf("running Spine %s is not the seed and no selection is readable: %w", digest, err)
	}
	if slot := s.Slots[slotName]; slot != nil {
		for _, e := range []*Entry{slot.Trial, slot.Current, slot.Previous} {
			if e != nil && e.SHA256 == digest {
				return nil
			}
		}
	}
	return fmt.Errorf("running Spine %s is neither the seed nor selected for slot %s", digest, slotName)
}
