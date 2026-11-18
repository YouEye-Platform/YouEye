package systemupdate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// holdLifecycleShared takes the named lifecycle lock the way an ordinary holder does (the Control Panel while it
// reads the reservation, a Names request for its whole network call): shared, on its own descriptor.
func holdLifecycleShared(t *testing.T, b CoreLifecycleBarrier, name string) func() {
	t.Helper()
	if err := os.MkdirAll(b.Root, 0700); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(b.Root, name), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_SH|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	return func() { _ = f.Close() }
}

func shortLifecycleWait(t *testing.T, wait time.Duration) {
	t.Helper()
	old := coreLifecycleSettleWait
	coreLifecycleSettleWait = wait
	t.Cleanup(func() { coreLifecycleSettleWait = old })
}

// The child of an admitted action waits for a busy lock instead of failing on the first attempt, on either lock.
func TestCoreLifecycleAdmittedChildWaitsForBusyLocks(t *testing.T) {
	for _, name := range []string{"core-lifecycle.flock", "core-admission.flock"} {
		t.Run(name, func(t *testing.T) {
			m, _, target := coreJournalFixture(t)
			j := prepareCoreFixture(t, m, target)
			b := CoreLifecycleBarrier{Root: filepath.Join(t.TempDir(), "state", "app-updates")}
			if err := b.Begin(j); err != nil { // the reservation as the coordinator's admission left it
				t.Fatal(err)
			}
			release := holdLifecycleShared(t, b, name)
			if err := b.Begin(j); err == nil {
				t.Fatal("fixture lock is not held")
			}
			shortLifecycleWait(t, 5*time.Second)
			started := time.Now()
			time.AfterFunc(120*time.Millisecond, release)
			if err := b.BeginAdmitted(context.Background(), j); err != nil {
				t.Fatalf("child did not wait for the lock: %v", err)
			}
			if waited := time.Since(started); waited < 100*time.Millisecond || waited > 3*time.Second {
				t.Fatalf("child waited %s for a lock held 120ms", waited)
			}
			if got, err := b.Read(); err != nil || got.RequestID != j.RequestID {
				t.Fatal("reservation lost", got, err)
			}
		})
	}
}

// When the lock stays busy for the whole bound the child reports exactly that, and has written nothing.
func TestCoreLifecycleAdmittedChildGivesUpWithoutWriting(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	b := CoreLifecycleBarrier{Root: filepath.Join(t.TempDir(), "state", "app-updates")}
	release := holdLifecycleShared(t, b, "core-lifecycle.flock")
	defer release()
	shortLifecycleWait(t, 80*time.Millisecond)
	err := b.BeginAdmitted(context.Background(), j)
	if !errors.Is(err, errCoreLifecycleUnsettled) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("busy lock not reported as unsettled: %v", err)
	}
	if _, err := b.Read(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a child that gave up wrote a reservation: %v", err)
	}
	// Anything else stays an ordinary error: it is not proof that nothing happened.
	release()
	other := j
	other.RequestID = "another-request"
	if err := b.Begin(other); err != nil {
		t.Fatal(err)
	}
	if err := b.BeginAdmitted(context.Background(), j); err == nil || errors.Is(err, errCoreLifecycleUnsettled) {
		t.Fatalf("foreign reservation reported as a busy lock: %v", err)
	}
}

// busyCheckpointFixture is refusalRuntimeFixture with the real checkpoint action as the child: the coordinator's
// admission runs first (real), then `hold` takes a lock as ordinary work would in the window before the child's
// own acquisition, and the child runs NativeCoreRuntime.execute in this process.
func busyCheckpointFixture(t *testing.T, hold func(CoreLifecycleBarrier) (release func())) (CoreManager, CoreJournal, CoreLifecycleBarrier, map[string]int) {
	t.Helper()
	m, j, r, barrier, starts := refusalRuntimeFixture(t, refusedPreflight)
	e := r.Executor()
	e.ExecuteAction = func(ctx context.Context, current CoreJournal, s CoreStep) (CoreActionObservation, error) {
		starts[s.Name]++
		if s.Name != "checkpoint" {
			return refusedPreflight(s), nil
		}
		if got, err := barrier.Read(); err != nil || got.RequestID != j.RequestID {
			t.Fatal("coordinator admission left no reservation", got, err)
		}
		release := hold(barrier)
		defer release()
		return r.execute(ctx, current, s)
	}
	m.Executor = e
	return m, j, barrier, starts
}

// G6, as seen live: a shared holder at the moment the checkpoint child starts. The request ends cleanly on the
// installed release (cancelled, hold released), never in needs-recovery.
func TestCoreCheckpointBusyLifecycleLockEndsAsRefusedPreflight(t *testing.T) {
	for _, name := range []string{"core-lifecycle.flock", "core-admission.flock"} {
		t.Run(name, func(t *testing.T) {
			shortLifecycleWait(t, 80*time.Millisecond)
			m, j, barrier, starts := busyCheckpointFixture(t, func(b CoreLifecycleBarrier) func() {
				return holdLifecycleShared(t, b, name) // held until the child has given up
			})
			got, err := m.Advance(context.Background(), j.RequestID, false)
			if err != nil || got.Phase != "cancelled" || got.Error != coreCheckpointRefusedError {
				t.Fatalf("busy lock did not end the update cleanly: phase=%s error=%q err=%v", got.Phase, got.Error, err)
			}
			for _, step := range got.Steps {
				switch step.Name {
				case "verify-members":
				case "checkpoint":
					if step.State != "failed" || !strings.Contains(step.Evidence, errCoreLifecycleUnsettled.Error()) {
						t.Fatalf("checkpoint does not say why it stopped: %+v", step)
					}
				default:
					if step.State != "pending" || starts[step.Name] != 0 {
						t.Fatalf("%s ran after the refused checkpoint", step.Name)
					}
				}
			}
			if len(got.RecoverySteps) != 0 || starts["checkpoint"] != 1 {
				t.Fatalf("busy lock entered recovery or relaunched the checkpoint: %+v %v", got.RecoverySteps, starts)
			}
			if _, err := barrier.Read(); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("lifecycle reservation kept after the update ended: %v", err)
			}
			lease, err := barrier.AdmitOrdinary()
			if err != nil {
				t.Fatalf("app operations still refused: %v", err)
			}
			lease()
			if receipt, err := m.ReadReceipt(); err != nil || receipt.ManifestSHA256 != j.Previous.ManifestSHA256 {
				t.Fatal("installed release changed", err)
			}
		})
	}
}

// A holder that lets go within the bound only delays the checkpoint: the child gets past the lifecycle locks and
// runs its preflight (which, in this fixture without containers, is what then refuses).
func TestCoreCheckpointWaitsOutAShortLifecycleHolder(t *testing.T) {
	shortLifecycleWait(t, 5*time.Second)
	m, j, _, starts := busyCheckpointFixture(t, func(b CoreLifecycleBarrier) func() {
		release := holdLifecycleShared(t, b, "core-lifecycle.flock")
		time.AfterFunc(120*time.Millisecond, release)
		return func() {}
	})
	started := time.Now()
	got, err := m.Advance(context.Background(), j.RequestID, false)
	if err != nil || starts["checkpoint"] != 1 {
		t.Fatal(got.Phase, err, starts)
	}
	if waited := time.Since(started); waited < 100*time.Millisecond {
		t.Fatalf("checkpoint did not wait for the holder (%s)", waited)
	}
	for _, step := range got.Steps {
		if step.Name != "checkpoint" {
			continue
		}
		if strings.Contains(step.Evidence, errCoreLifecycleUnsettled.Error()) {
			t.Fatalf("checkpoint gave up on a lock that was released in time: %+v", step)
		}
		if step.State != "failed" || !strings.Contains(step.Evidence, "checkpoint preflight refused") {
			t.Fatalf("checkpoint did not reach its preflight: %+v", step)
		}
	}
	if got.Phase == "needs-recovery" {
		t.Fatal("a waited-out holder left the request in needs-recovery")
	}
}

// The commit and rollback release waits for ordinary readers too: a moment's shared hold must not leave the
// finished request's reservation behind.
func TestCoreLifecycleReleaseWaitsForReaders(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	b := CoreLifecycleBarrier{Root: filepath.Join(t.TempDir(), "state", "app-updates")}
	if err := b.Begin(j); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Advance(context.Background(), j.RequestID, false); err != nil {
		t.Fatal(err)
	}
	shortLifecycleWait(t, 5*time.Second)
	release := holdLifecycleShared(t, b, "core-lifecycle.flock")
	time.AfterFunc(120*time.Millisecond, release)
	if err := b.ReleaseCommitted(m, j.RequestID); err != nil {
		t.Fatalf("release failed on a reader's short hold: %v", err)
	}
	if _, err := b.Read(); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("committed reservation not removed", err)
	}
	// Still bounded: a holder that never leaves fails the release and keeps the reservation.
	other := CoreLifecycleBarrier{Root: filepath.Join(t.TempDir(), "state", "app-updates")}
	if err := other.Begin(j); err != nil {
		t.Fatal(err)
	}
	defer holdLifecycleShared(t, other, "core-lifecycle.flock")()
	shortLifecycleWait(t, 60*time.Millisecond)
	if err := other.ReleaseCommitted(m, j.RequestID); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("release did not stay bounded: %v", err)
	}
	if _, err := other.Read(); err != nil {
		t.Fatal("reservation removed without the lock", err)
	}
}
