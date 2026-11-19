package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func prepareRelease(m CoreManager, id string, r releasecache.CoreRelease) error {
	raw, _ := json.Marshal(r)
	_, err := m.Prepare(context.Background(), id, raw, checksum(raw))
	return err
}

func renamed(r releasecache.CoreRelease, version string, sequence uint64) releasecache.CoreRelease {
	r.Version, r.Tag, r.Sequence = version, "youeye-v"+version, sequence
	if r.Build != "" {
		r.Build = version
	}
	return r
}

func TestCoreVersionFloorRisesOnlyOnCommit(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	target = renamed(target, "0.5.39", 300)
	j := prepareCoreFixture(t, m, target)
	if _, err := m.Cancel(context.Background(), j.RequestID); err != nil {
		t.Fatal(err)
	}
	// A cancelled 0.5.39 never committed: a later, lower release (still above
	// the installed one) must stay installable, e.g. after a channel switch back.
	older := renamed(target, "0.5.38", 200)
	if err := prepareRelease(m, "older-after-cancel", older); err != nil {
		t.Fatal("a cancelled request raised the floor:", err)
	}
	if _, err := m.Cancel(context.Background(), "older-after-cancel"); err != nil {
		t.Fatal(err)
	}
	// A committed release raises the floor: older releases are refused, by
	// line and, within the line, by sequence. The message names versions only.
	raw, _ := json.Marshal(target)
	if err := m.retainSequence(target, checksum(raw), true); err != nil {
		t.Fatal(err)
	}
	err := prepareRelease(m, "older-after-commit", older)
	if err == nil || !strings.Contains(err.Error(), "YouEye 0.5.38 is older than 0.5.39") {
		t.Fatal("forgot the committed higher release:", err)
	}
	earlier := renamed(target, "0.5.39-dev.9", 250)
	earlier.Build = "0.5.39-dev.9"
	if err := prepareRelease(m, "earlier-build", earlier); err == nil {
		t.Fatal("an earlier build of the accepted line was accepted")
	}
	// The same build promoted under another channel's name is not older.
	promoted := target
	promoted.Version, promoted.Tag = "0.5.39-beta.1", "youeye-v0.5.39-beta.1"
	if err := prepareRelease(m, "renamed", promoted); err != nil {
		t.Fatal("the same build under another name was refused:", err)
	}
	if _, err := m.Cancel(context.Background(), "renamed"); err != nil {
		t.Fatal(err)
	}
	// A document with the accepted key and other files is refused.
	forged := target
	forged.Version, forged.Tag = "0.5.39-beta.2", "youeye-v0.5.39-beta.2"
	forged.Members = append([]releasecache.CoreMember{}, target.Members...)
	forged.Members[len(forged.Members)-1].Artifact.SHA256 = strings.Repeat("e", 64)
	if err := prepareRelease(m, "forged", forged); err == nil || !strings.Contains(err.Error(), "installs other files") {
		t.Fatal("the same build with other files was accepted:", err)
	}
	// A later build of the accepted line is newer whatever its name says: a
	// dev build after the promoted one, and a later line.
	later := renamed(target, "0.5.39-dev.12", 350)
	if err := prepareRelease(m, "later-build", later); err != nil {
		t.Fatal("a later build of the line was refused:", err)
	}
	if _, err := m.Cancel(context.Background(), "later-build"); err != nil {
		t.Fatal(err)
	}
	if err := prepareRelease(m, "next", renamed(target, "0.5.40", 400)); err != nil {
		t.Fatal(err)
	}
}

func TestCorePrepareRefusesReleaseBelowInstalled(t *testing.T) {
	m, _, target := coreJournalFixture(t) // installed: 0.5.37, sequence 100
	if err := prepareRelease(m, "downgrade", renamed(target, "0.5.36", 900)); err == nil || !strings.Contains(err.Error(), "YouEye 0.5.36 is older than the installed 0.5.37; a box never downgrades") {
		t.Fatal("an older line with a higher sequence was accepted:", err)
	}
	if err := prepareRelease(m, "earlier-build", renamed(target, "0.5.37-dev.9", 90)); err == nil {
		t.Fatal("an earlier build of the installed line was accepted")
	}
	// Names never decide: the installed 0.5.37 is a promoted release, and a
	// dev build of its line published after it is newer.
	if err := prepareRelease(m, "later-dev-build", renamed(target, "0.5.37-dev.10", 150)); err != nil {
		t.Fatal("a later build of the installed line was refused:", err)
	}
}

func TestRefuseDowngrade(t *testing.T) {
	r := func(version string, sequence uint64) releasecache.CoreRelease {
		return releasecache.CoreRelease{Version: version, Sequence: sequence}
	}
	if err := RefuseDowngrade("stable", r("0.6.1-dev.2", 20), r("0.6.1-dev.10", 100)); err != nil {
		t.Fatal("a later build", err)
	}
	if err := RefuseDowngrade("stable", r("0.6.1-dev.2", 20), r("0.6.1", 20)); err != nil {
		t.Fatal("the same build under another name is not a downgrade", err)
	}
	// A stable box that switches to dev takes the next dev build of its line.
	if err := RefuseDowngrade("dev", r("0.6.13", 500), r("0.6.13-dev.6", 600)); err != nil {
		t.Fatal("a dev build after the promoted one is not a downgrade", err)
	}
	err := RefuseDowngrade("stable", r("0.6.14-dev.2", 700), r("0.6.13", 500))
	if !errors.Is(err, ErrChannelBehind) || !strings.Contains(err.Error(), "channel stable offers 0.6.13; this box has 0.6.14-dev.2; waiting for it to catch up") {
		t.Fatalf("message: %v", err)
	}
	// A dev box on a later build of the line that switches to stable waits.
	if err := RefuseDowngrade("stable", r("0.6.13-dev.7", 700), r("0.6.13", 500)); !errors.Is(err, ErrChannelBehind) {
		t.Fatalf("stable 0.6.13 is behind a later dev build of its line: %v", err)
	}
	if err := RefuseDowngrade("alpha", r("0.6.1-dev.5", 50), r("0.6.1-alpha.1", 20)); !errors.Is(err, ErrChannelBehind) {
		t.Fatalf("alpha.1 of an older build is behind dev.5: %v", err)
	}
	if err := RefuseDowngrade("dev", r("0.10.0-dev.1", 10), r("0.9.9-dev.5", 900)); !errors.Is(err, ErrChannelBehind) {
		t.Fatalf("older minor: %v", err)
	}
	// An old-shape document's build name is ignored.
	old, later := r("0.6.11", 1795042574), r("0.6.11-dev.7", 1795050000)
	old.Build, later.Build = "0.6.11-dev.6", "0.6.11-dev.7"
	if err := RefuseDowngrade("dev", old, later); err != nil {
		t.Fatal(err)
	}
	if err := RefuseDowngrade("stable", later, old); !errors.Is(err, ErrChannelBehind) || strings.Contains(err.Error(), "dev.6") {
		t.Fatalf("old shape: %v", err)
	}
}

// floor0611 is the floor record as a Spine up to 0.6.11 reads and writes it.
type floor0611 struct {
	Schema         string `json:"schema"`
	Build          string `json:"build"`
	PayloadSHA256  string `json:"payload_sha256"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

func readFloorFile(t *testing.T, m CoreManager) (map[string]any, floor0611) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(m.Root, "version-floor.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	var old floor0611
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(raw, &old) != nil {
		t.Fatalf("unreadable floor %s", raw)
	}
	// What core_sequence.go of 0.6.11 requires before it compares anything.
	if old.Schema != "youeye.core-version-floor.v1" || !releasecache.ValidCoreVersion(old.Build) || !validSHA256(old.PayloadSHA256) || !validSHA256(old.ManifestSHA256) {
		t.Fatalf("a 0.6.11 Spine in the other slot refuses this floor: %s", raw)
	}
	return fields, old
}

// The floor is shared by both slots. This Spine writes it in both shapes: the
// build name a 0.6.11 Spine requires, and the key (line, sequence).
func TestCoreVersionFloorIsWrittenInBothShapes(t *testing.T) {
	m, _, target := coreJournalFixture(t) // old shape: Build is set
	target = renamed(target, "0.5.39-beta.1", 300)
	target.Build = "0.5.39-dev.4"
	raw, _ := json.Marshal(target)
	if err := m.retainSequence(target, checksum(raw), true); err != nil {
		t.Fatal(err)
	}
	fields, old := readFloorFile(t, m)
	if old.Build != "0.5.39-dev.4" || fields["line"] != "0.5.39" || fields["sequence"] != float64(300) || fields["version"] != "0.5.39-beta.1" || old.ManifestSHA256 != checksum(raw) || old.PayloadSHA256 != target.PayloadSHA256() {
		t.Fatalf("floor %v", fields)
	}
	// A document without build names: the old field holds its version, so an
	// older Spine still reads the record (and refuses everything older by its
	// own rule).
	clean := renamed(target, "0.5.40", 400)
	clean.Build, clean.MinimumReader = "", 2
	clean.Members = append([]releasecache.CoreMember{}, target.Members...)
	for i := range clean.Members {
		clean.Members[i].BuildVersion = ""
	}
	raw, _ = json.Marshal(clean)
	if strings.Contains(string(raw), `"build"`) || strings.Contains(string(raw), "build_version") {
		t.Fatalf("fixture has build names: %s", raw)
	}
	if err := m.retainSequence(clean, checksum(raw), true); err != nil {
		t.Fatal(err)
	}
	fields, old = readFloorFile(t, m)
	if old.Build != "0.5.40" || fields["line"] != "0.5.40" || fields["sequence"] != float64(400) || fields["version"] != "0.5.40" {
		t.Fatalf("floor %v", fields)
	}
	// Its own floor is enforced by the key.
	if err := m.checkSequence(renamed(clean, "0.5.40-dev.3", 390), strings.Repeat("1", 64), true); err == nil {
		t.Fatal("an earlier build of the floor's line passed")
	}
	if err := m.checkSequence(renamed(clean, "0.5.40-beta.1", 400), strings.Repeat("1", 64), true); err != nil {
		t.Fatal("the same build under another name was refused:", err)
	}
	// A record whose key fields are damaged is refused, never guessed.
	for _, damaged := range []string{`"line":"0.5.40-dev.1","sequence":400`, `"line":"0.5.40","sequence":-1`, `"line":"","sequence":400`, `"line":"0.5.40"`} {
		record := `{"schema":"youeye.core-version-floor.v1","build":"0.5.40",` + damaged + `,"payload_sha256":"` + old.PayloadSHA256 + `","manifest_sha256":"` + old.ManifestSHA256 + `"}`
		if err := atomicWrite(filepath.Join(m.Root, "version-floor.json"), []byte(record), 0600); err != nil {
			t.Fatal(err)
		}
		if err := m.checkSequence(renamed(clean, "0.5.41", 500), strings.Repeat("1", 64), true); err == nil || !strings.Contains(err.Error(), "retained version floor is invalid") {
			t.Fatalf("%s: %v", damaged, err)
		}
	}
}

// A box that arrives from 0.6.11 has a floor without a sequence. Its document
// is retained under targets/, and says the sequence.
func TestCoreVersionFloorFrom0611IsRead(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	accepted := renamed(target, "0.5.39", 300)
	accepted.Build = "0.5.39-dev.6"
	raw, _ := json.Marshal(accepted)
	digest := checksum(raw)
	if err := atomicWrite(filepath.Join(m.Root, "targets", digest+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	writeOld := func(build, payload, manifest string) {
		t.Helper()
		record, _ := json.Marshal(floor0611{Schema: "youeye.core-version-floor.v1", Build: build, PayloadSHA256: payload, ManifestSHA256: manifest})
		if err := atomicWrite(filepath.Join(m.Root, "version-floor.json"), record, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeOld("0.5.39-dev.6", accepted.PayloadSHA256(), digest)
	// The old rule would call dev.9 newer than dev.6 and 0.5.39-alpha.1 equal
	// to nothing; the key decides instead.
	earlier := renamed(accepted, "0.5.39-dev.9", 250)
	if err := m.checkSequence(earlier, strings.Repeat("1", 64), true); err == nil || !strings.Contains(err.Error(), "is older than 0.5.39") || strings.Contains(err.Error(), "dev.6") {
		t.Fatalf("an earlier build passed an old floor: %v", err)
	}
	promoted := accepted
	promoted.Version, promoted.Tag = "0.5.39-alpha.1", "youeye-v0.5.39-alpha.1"
	if err := m.checkSequence(promoted, strings.Repeat("1", 64), true); err != nil {
		t.Fatal("the floor's own build under another name was refused:", err)
	}
	if fields, _ := readFloorFile(t, m); fields["sequence"] != nil {
		t.Fatal("a check rewrote the floor")
	}
	// Accepting the same release again completes the record in both shapes.
	if err := m.retainSequence(accepted, digest, false); err != nil {
		t.Fatal(err)
	}
	fields, old := readFloorFile(t, m)
	if old.Build != "0.5.39-dev.6" || fields["line"] != "0.5.39" || fields["sequence"] != float64(300) || old.ManifestSHA256 != digest {
		t.Fatalf("floor not completed: %v", fields)
	}
	// A 0.6.11 Spine in the other slot raises the floor in its one shape; this
	// Spine reads that again.
	next := renamed(accepted, "0.5.40-dev.2", 400)
	next.Build = "0.5.40-dev.2"
	raw, _ = json.Marshal(next)
	if err := atomicWrite(filepath.Join(m.Root, "targets", checksum(raw)+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	writeOld("0.5.40-dev.2", next.PayloadSHA256(), checksum(raw))
	if err := m.checkSequence(accepted, digest, true); err == nil {
		t.Fatal("the release below an older Spine's floor passed")
	}
	if err := m.retainSequence(renamed(next, "0.5.40-dev.3", 450), strings.Repeat("2", 64), true); err != nil {
		t.Fatal(err)
	}
	if fields, old := readFloorFile(t, m); old.Build != "0.5.40-dev.3" || fields["sequence"] != float64(450) {
		t.Fatalf("floor not raised: %v", fields)
	}
	// The floor's document is gone (it never is on a real box): its line and
	// its build name are what is left. Older lines are still refused, and its
	// own line is ordered by the build name, as the Spine that wrote it did.
	writeOld("0.5.41-dev.5", accepted.PayloadSHA256(), strings.Repeat("3", 64))
	if err := m.checkSequence(renamed(accepted, "0.5.40", 999), strings.Repeat("1", 64), true); err == nil {
		t.Fatal("an older line passed a floor whose document is gone")
	}
	if err := m.checkSequence(renamed(accepted, "0.5.41-dev.1", 999), strings.Repeat("1", 64), true); err == nil || !strings.Contains(err.Error(), "is older than 0.5.41") || strings.Contains(err.Error(), "dev.5") {
		t.Fatalf("an earlier build of the floor's line passed without its document: %v", err)
	}
	if err := m.checkSequence(renamed(accepted, "0.5.41-dev.6", 5), strings.Repeat("1", 64), true); err != nil {
		t.Fatal("a later build of the floor's line was refused without its document:", err)
	}
	// A floor that is neither shape is refused.
	writeOld("not a version", accepted.PayloadSHA256(), digest)
	if err := m.checkSequence(accepted, digest, true); err == nil {
		t.Fatal("an invalid floor was accepted")
	}
}

// The floor is never lowered. A floor from a Spine up to 0.6.11 whose
// document is gone has no sequence to compare with, and it may stand above
// the installed release (a recovery leaves the floor at the release that was
// rolled back). Prepare retains the installed release first: that must not
// replace the higher floor of the same line.
func TestCoreVersionFloorWithoutItsDocumentIsNeverLowered(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	floorFile := filepath.Join(m.Root, "version-floor.json")
	writeOld := func(build, payload string) []byte {
		t.Helper()
		record, _ := json.Marshal(floor0611{Schema: "youeye.core-version-floor.v1", Build: build, PayloadSHA256: payload, ManifestSHA256: strings.Repeat("3", 64)})
		if err := atomicWrite(floorFile, record, 0600); err != nil {
			t.Fatal(err)
		}
		return record
	}
	unchanged := func(want []byte, what string) {
		t.Helper()
		if got, err := os.ReadFile(floorFile); err != nil || string(got) != string(want) {
			t.Fatalf("%s changed the floor: %s (%v)", what, got, err)
		}
	}
	// Accepted and rolled back: 0.5.41-dev.6. Installed again: 0.5.41-dev.4.
	rolledBack := renamed(target, "0.5.41-dev.6", 600)
	installed := renamed(target, "0.5.41-dev.4", 400)
	record := writeOld("0.5.41-dev.6", rolledBack.PayloadSHA256())
	// What Prepare does with the installed release: retain, never require.
	if err := m.retainSequence(installed, strings.Repeat("4", 64), false); err != nil {
		t.Fatal(err)
	}
	unchanged(record, "retaining the installed, older release")
	// So the build between the two is still refused, and so is the installed
	// one as a target; the names in the message are versions and the line.
	between := renamed(target, "0.5.41-dev.5", 500)
	for _, older := range []releasecache.CoreRelease{between, installed} {
		if err := m.checkSequence(older, strings.Repeat("1", 64), true); err == nil || !strings.Contains(err.Error(), "YouEye "+older.Version+" is older than 0.5.41, which this box already accepted") {
			t.Fatalf("%s passed a floor that stands above it: %v", older.Version, err)
		}
		if err := m.retainSequence(older, strings.Repeat("1", 64), true); err == nil {
			t.Fatalf("%s replaced a floor that stands above it", older.Version)
		}
	}
	unchanged(record, "a refused release")
	// A promoted name does not decide either way: the build name does.
	promotedOlder := renamed(target, "0.5.41", 500)
	promotedOlder.Build = "0.5.41-dev.5"
	if err := m.checkSequence(promotedOlder, strings.Repeat("1", 64), true); err == nil {
		t.Fatal("an earlier build under a promoted name passed")
	}
	// The floor's own build under another name: the same files pass, other
	// files are refused.
	same := renamed(target, "0.5.41-beta.1", 600)
	same.Build = "0.5.41-dev.6"
	if err := m.checkSequence(same, strings.Repeat("1", 64), true); err != nil {
		t.Fatal("the floor's own build was refused:", err)
	}
	forged := same
	forged.Members = append([]releasecache.CoreMember{}, same.Members...)
	forged.Members[len(forged.Members)-1].Artifact.SHA256 = strings.Repeat("e", 64)
	if err := m.checkSequence(forged, strings.Repeat("1", 64), true); err == nil || !strings.Contains(err.Error(), "installs other files") {
		t.Fatalf("the floor's build with other files passed: %v", err)
	}
	unchanged(record, "a check")
	// A document without a build name cannot be placed against it: it is left
	// to the installed receipt, and it does not replace the floor, whatever
	// its sequence says.
	clean := renamed(target, "0.5.41-dev.2", 999)
	clean.Build, clean.MinimumReader = "", 2
	if err := m.checkSequence(clean, strings.Repeat("1", 64), true); err != nil {
		t.Fatal("a release that names no build was refused by a floor it cannot be compared with:", err)
	}
	if err := m.retainSequence(clean, strings.Repeat("1", 64), false); err != nil {
		t.Fatal(err)
	}
	unchanged(record, "a release that names no build")
	// An older line never passes, a later build of the line and a later line
	// raise the floor, written in both shapes from then on.
	if err := m.retainSequence(renamed(target, "0.5.40", 9999), strings.Repeat("1", 64), true); err == nil {
		t.Fatal("an older line passed")
	}
	unchanged(record, "an older line")
	later := renamed(target, "0.5.41-dev.7", 700)
	if err := m.retainSequence(later, strings.Repeat("5", 64), true); err != nil {
		t.Fatal("a later build of the floor's line was refused:", err)
	}
	if fields, old := readFloorFile(t, m); old.Build != "0.5.41-dev.7" || fields["line"] != "0.5.41" || fields["sequence"] != float64(700) || old.ManifestSHA256 != strings.Repeat("5", 64) {
		t.Fatalf("floor not raised: %v", fields)
	}
	// Accepting the floor's own build again completes the record.
	writeOld("0.5.41-dev.6", rolledBack.PayloadSHA256())
	if err := m.retainSequence(same, strings.Repeat("6", 64), false); err != nil {
		t.Fatal(err)
	}
	if fields, old := readFloorFile(t, m); old.Build != "0.5.41-dev.6" || fields["sequence"] != float64(600) || fields["version"] != "0.5.41-beta.1" {
		t.Fatalf("floor not completed: %v", fields)
	}
	writeOld("0.5.41-dev.6", rolledBack.PayloadSHA256())
	if err := m.retainSequence(renamed(clean, "0.5.42", 5), strings.Repeat("7", 64), true); err != nil {
		t.Fatal("a later line was refused:", err)
	}
	if fields, old := readFloorFile(t, m); old.Build != "0.5.42" || fields["line"] != "0.5.42" || fields["sequence"] != float64(5) {
		t.Fatalf("floor not raised to the later line: %v", fields)
	}
}

func TestCompareBuildNames(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"0.6.11-dev.5", "0.6.11-dev.6", -1}, {"0.6.11-dev.10", "0.6.11-dev.9", 1}, {"0.6.11-dev.6", "0.6.11-dev.6", 0},
		// The label never decides; a name without a suffix comes last.
		{"0.6.11-alpha.7", "0.6.11-dev.6", 1}, {"0.6.11-beta.1", "0.6.11-dev.6", -1}, {"0.6.11-rc-x.6", "0.6.11-dev.6", 0},
		{"0.6.11", "0.6.11-dev.99", 1}, {"0.6.11-dev.99", "0.6.11", -1}, {"0.6.11", "0.6.11", 0},
	} {
		if got := compareBuildNames(c.a, c.b); got != c.want {
			t.Errorf("compareBuildNames(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}
