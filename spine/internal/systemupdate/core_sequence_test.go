package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreVersionFloorRisesOnlyOnCommit(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	target.Version, target.Build, target.Tag = "0.5.39", "0.5.39", "youeye-v0.5.39"
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
	older.Version, older.Build, older.Tag = "0.5.38", "0.5.38", "youeye-v0.5.38"
	if err := prepare("older-after-cancel", older); err != nil {
		t.Fatal("a cancelled request raised the floor:", err)
	}
	if _, err := m.Cancel(context.Background(), "older-after-cancel"); err != nil {
		t.Fatal(err)
	}
	// A committed release raises the floor: older builds are refused.
	raw, _ := json.Marshal(target)
	if err := m.retainSequence(target, checksum(raw), true); err != nil {
		t.Fatal(err)
	}
	if err := prepare("older-after-commit", older); err == nil {
		t.Fatal("forgot the committed higher version")
	}
	// The same build promoted under another channel's name is not older.
	renamed := target
	renamed.Version, renamed.Tag = "0.5.39-beta.1", "youeye-v0.5.39-beta.1"
	if err := prepare("renamed", renamed); err != nil {
		t.Fatal("the same build under another name was refused:", err)
	}
	if _, err := m.Cancel(context.Background(), "renamed"); err != nil {
		t.Fatal(err)
	}
	// A document claiming the accepted build with other files is refused.
	forged := target
	forged.Version, forged.Tag = "0.5.39-beta.2", "youeye-v0.5.39-beta.2"
	forged.Members = append([]releasecache.CoreMember{}, target.Members...)
	forged.Members[len(forged.Members)-1].Artifact.SHA256 = strings.Repeat("e", 64)
	if err := prepare("forged", forged); err == nil {
		t.Fatal("the same build with other files was accepted")
	}
	next := target
	next.Version, next.Build, next.Tag = "0.5.40", "0.5.40", "youeye-v0.5.40"
	if err := prepare("next", next); err != nil {
		t.Fatal(err)
	}
}

func TestCorePrepareRefusesVersionBelowInstalled(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	target.Version, target.Build, target.Tag = "0.5.36", "0.5.36", "youeye-v0.5.36"
	raw, _ := json.Marshal(target)
	if _, err := m.Prepare(context.Background(), "downgrade", raw, checksum(raw)); err == nil {
		t.Fatal("downgrade below installed accepted")
	}
	target.Version, target.Build, target.Tag = "0.5.37-dev.9", "0.5.37-dev.9", "youeye-v0.5.37-dev.9"
	raw, _ = json.Marshal(target)
	if _, err := m.Prepare(context.Background(), "prerelease-downgrade", raw, checksum(raw)); err == nil {
		t.Fatal("rc build of the installed line accepted as newer than the final build")
	}
}

func TestRefuseDowngrade(t *testing.T) {
	r := func(version, build string) releasecache.CoreRelease {
		return releasecache.CoreRelease{Version: version, Build: build}
	}
	if err := RefuseDowngrade("stable", r("0.6.1-dev.2", "0.6.1-dev.2"), r("0.6.1-dev.10", "0.6.1-dev.10")); err != nil {
		t.Fatal("numeric build order", err)
	}
	if err := RefuseDowngrade("stable", r("0.6.1-dev.2", "0.6.1-dev.2"), r("0.6.1", "0.6.1-dev.2")); err != nil {
		t.Fatal("the same build under another name is not a downgrade", err)
	}
	if err := RefuseDowngrade("alpha", r("0.6.1-dev.5", "0.6.1-dev.5"), r("0.6.1-alpha.1", "0.6.1-dev.2")); !errors.Is(err, ErrChannelBehind) {
		t.Fatalf("alpha.1 of an older build is behind dev.5: %v", err)
	}
	if err := RefuseDowngrade("beta", r("0.6.1-beta.1", "0.6.1-dev.10"), r("0.6.1-beta.2", "0.6.1-dev.9")); !errors.Is(err, ErrChannelBehind) {
		t.Fatalf("older build: %v", err)
	}
	if err := RefuseDowngrade("dev", r("0.10.0-dev.1", "0.10.0-dev.1"), r("0.9.9-dev.5", "0.9.9-dev.5")); !errors.Is(err, ErrChannelBehind) {
		t.Fatalf("older minor: %v", err)
	}
}
