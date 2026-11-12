package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreVersionFloorRisesOnlyOnCommit(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	target.Version, target.Tag = "0.5.39", "youeye-v0.5.39"
	j := prepareCoreFixture(t, m, target)
	if _, err := m.Cancel(context.Background(), j.RequestID); err != nil {
		t.Fatal(err)
	}
	prepare := func(id string, r releasecache.CoreRelease) error {
		raw, _ := json.Marshal(r)
		_, err := m.Prepare(context.Background(), id, raw, checksum(raw))
		return err
	}
	// A cancelled 0.5.39 never committed: a later, lower release (still above
	// the installed one) must stay installable, e.g. after a channel switch back.
	older := target
	older.Version, older.Tag = "0.5.38", "youeye-v0.5.38"
	if err := prepare("older-after-cancel", older); err != nil {
		t.Fatal("a cancelled request raised the floor:", err)
	}
	if _, err := m.Cancel(context.Background(), "older-after-cancel"); err != nil {
		t.Fatal(err)
	}
	// A committed release raises the floor: older versions and another build of
	// the same version are refused.
	raw, _ := json.Marshal(target)
	if err := m.retainSequence(target, checksum(raw), true); err != nil {
		t.Fatal(err)
	}
	if err := prepare("older-after-commit", older); err == nil {
		t.Fatal("forgot the committed higher version")
	}
	other := target
	other.Sequence++
	if err := prepare("equivocation", other); err == nil {
		t.Fatal("same version with another digest accepted")
	}
	next := target
	next.Version, next.Tag = "0.5.40", "youeye-v0.5.40"
	if err := prepare("next", next); err != nil {
		t.Fatal(err)
	}
}

func TestCorePrepareRefusesVersionBelowInstalled(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	target.Version, target.Tag = "0.5.36", "youeye-v0.5.36"
	raw, _ := json.Marshal(target)
	if _, err := m.Prepare(context.Background(), "downgrade", raw, checksum(raw)); err == nil {
		t.Fatal("downgrade below installed accepted")
	}
	target.Version, target.Tag = "0.5.37-rc.9", "youeye-v0.5.37-rc.9"
	raw, _ = json.Marshal(target)
	if _, err := m.Prepare(context.Background(), "prerelease-downgrade", raw, checksum(raw)); err == nil {
		t.Fatal("rc build of the installed line accepted as newer than the final build")
	}
}

func TestRefuseDowngrade(t *testing.T) {
	if err := RefuseDowngrade("stable", "0.6.1-rc.2", "0.6.1-rc.10"); err != nil {
		t.Fatal("numeric rc order", err)
	}
	if err := RefuseDowngrade("stable", "0.6.1-rc.2", "0.6.1-rc.2"); err != nil {
		t.Fatal("same version is not a downgrade", err)
	}
	if err := RefuseDowngrade("beta", "0.6.1-rc.10", "0.6.1-rc.9"); !errors.Is(err, ErrChannelBehind) {
		t.Fatalf("older rc: %v", err)
	}
	if err := RefuseDowngrade("dev", "0.10.0-rc.1", "0.9.9-rc.5"); !errors.Is(err, ErrChannelBehind) {
		t.Fatalf("older minor: %v", err)
	}
}
