package systemupdate

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreSequenceSurvivesCancellationAndRestoredInstalledReceipt(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	target.Sequence = 10
	j := prepareCoreFixture(t, m, target)
	if _, err := m.Cancel(context.Background(), j.RequestID); err != nil {
		t.Fatal(err)
	}
	prepare := func(id string, r releasecache.CoreRelease) error {
		raw, _ := json.Marshal(r)
		_, err := m.Prepare(context.Background(), id, raw, checksum(raw))
		return err
	}
	// The installed receipt is still sequence 1; preparation's sequence 10
	// remains a durable floor even though there was no committed data change.
	target.Sequence = 9
	if err := prepare("older-after-cancel", target); err == nil {
		t.Fatal("forgot accepted higher sequence")
	}
	target.Sequence = 10
	target.Version, target.Tag = "0.5.39", "youeye-v0.5.39"
	if err := prepare("equivocation", target); err == nil {
		t.Fatal("same sequence changed bytes")
	}
	target.Sequence = 11
	if err := prepare("next", target); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Cancel(context.Background(), "next"); err != nil {
		t.Fatal(err)
	}
	installed, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	if err := prepare("installed-no-op", installed.Release); err != nil {
		t.Fatal("no-op was treated as a downgrade", err)
	}
	if _, err := m.Cancel(context.Background(), "installed-no-op"); err != nil {
		t.Fatal(err)
	}
	target.Sequence = 10
	if err := prepare("still-older", target); err == nil {
		t.Fatal("no-op lowered retained floor")
	}
}
