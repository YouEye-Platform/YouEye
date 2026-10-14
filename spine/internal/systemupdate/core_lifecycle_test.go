package systemupdate

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestCoreLifecycleRequiresSettledWorkAndExactCommit(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	b := CoreLifecycleBarrier{Root: t.TempDir()}
	if err := os.Chmod(b.Root, 0700); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(b.Root, "core-lifecycle.flock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_SH|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	if err := b.Begin(j); err == nil {
		t.Fatal("core checkpoint bypassed active app lifecycle")
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(b.Root, "operations"), 0700); err != nil {
		t.Fatal(err)
	}
	appReceipt := filepath.Join(b.Root, "operations", "fixture.json")
	if err := os.WriteFile(appReceipt, []byte(`{"schema":"youeye.app-update.v1","phase":"recovery_required","cleanupComplete":false}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := b.Begin(j); err == nil {
		t.Fatal("core checkpoint bypassed unfinished app recovery")
	}
	if err := os.WriteFile(appReceipt, []byte(`{"schema":"youeye.app-update.v1","phase":"cleanup","cleanupComplete":true,"rollbackVerifiedAt":"fixture"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := b.Begin(j); err != nil {
		t.Fatal(err)
	}
	if err := b.Begin(j); err != nil {
		t.Fatal("same reservation was not idempotent", err)
	}
	other := j
	other.RequestID = "another-request"
	if err := b.Begin(other); err == nil {
		t.Fatal("another transaction adopted reservation")
	}
	if err := b.ReleaseCommitted(m, j.RequestID); err == nil {
		t.Fatal("uncommitted coordinator cleared reservation")
	}
	if _, err := b.Read(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Advance(context.Background(), j.RequestID, false); err != nil {
		t.Fatal(err)
	}
	if err := b.ReleaseCommitted(m, "another-request"); err == nil {
		t.Fatal("wrong request cleared reservation")
	}
	if err := b.ReleaseCommitted(m, j.RequestID); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Read(); !os.IsNotExist(err) {
		t.Fatal("committed reservation not removed", err)
	}
}

func TestNativeSharedAdmissionAndRetainedMaintenance(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	data := t.TempDir()
	b := CoreLifecycleBarrier{Root: filepath.Join(data, "state", "app-updates")}
	release, err := b.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	second, err := b.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Begin(j); err == nil {
		t.Fatal("native backup lease did not block checkpoint")
	}
	release()
	second()
	maintenance := filepath.Join(data, "state", "container-maintenance", "operations", "owned.json")
	if err := atomicWrite(maintenance, []byte(`{"schema":"youeye.container-maintenance/1","state":"failed"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := b.Begin(j); err == nil {
		t.Fatal("ignored failed container operation")
	}
	if err := atomicWrite(maintenance, []byte(`{"schema":"youeye.container-maintenance/1","state":"completed","completedAt":"verified"}`), 0600); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(data, "backup-status.json")
	if err := atomicWrite(backup, []byte(`{"status":"exporting"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := b.Begin(j); err == nil {
		t.Fatal("ignored interrupted native backup")
	}
	if err := atomicWrite(backup, []byte(`{"status":"completed"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := b.Begin(j); err != nil {
		t.Fatal(err)
	}
	if lease, err := b.AdmitOrdinary(); err == nil {
		lease()
		t.Fatal("native backup entered durable core hold")
	}
}
