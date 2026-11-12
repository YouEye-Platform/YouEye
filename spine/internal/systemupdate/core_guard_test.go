package systemupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLegacyComponentGuardDoesNotTreatDamagedCoreAsLegacy(t *testing.T) {
	if err := RequireLegacyUpdateAllowed(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	m, _, _ := coreJournalFixture(t)
	if err := RequireLegacyUpdateAllowed(m.Root); err == nil {
		t.Fatal("allowed partial update of a committed core")
	}
	r, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(m.Root, "targets", r.ManifestSHA256+".json")); err != nil {
		t.Fatal(err)
	}
	if err := RequireLegacyUpdateAllowed(m.Root); err == nil {
		t.Fatal("missing retained input allowed partial update")
	}
	if err := os.WriteFile(filepath.Join(m.Root, "committed.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := RequireLegacyUpdateAllowed(m.Root); err == nil {
		t.Fatal("corrupt receipt allowed partial update")
	}
}
