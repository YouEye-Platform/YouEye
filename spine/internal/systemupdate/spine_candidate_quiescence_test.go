package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestSpineCandidateQuiescenceDrainsOrdinaryLeaseBeforeEffects(t *testing.T) {
	f := newFrozenCandidateFixture(t)
	barrier := f.manager.barrier()
	release, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	released := false
	defer func() {
		if !released {
			release()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	called, done := make(chan struct{}), make(chan error, 1)
	go func() {
		done <- f.manager.WithQuiescent(ctx, func() error { close(called); return nil })
	}()
	// The exclusive admission gate must close while the existing shared
	// lifecycle lease drains, excluding new ordinary work from overtaking it.
	deadline := time.Now().Add(time.Second)
	gateClosed := false
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			t.Fatalf("binding did not wait for the active ordinary lease: %v", err)
		default:
		}
		other, err := barrier.AdmitOrdinary()
		if err != nil {
			gateClosed = true
			break
		}
		other()
		time.Sleep(5 * time.Millisecond)
	}
	if !gateClosed {
		t.Fatal("ordinary admission remained open while candidate waited")
	}
	select {
	case err := <-done:
		t.Fatalf("candidate stopped instead of draining the shared lease: %v", err)
	case <-called:
		t.Fatal("binding effects ran while an ordinary lifecycle lease was active")
	case <-time.After(50 * time.Millisecond):
	}
	release()
	released = true
	select {
	case err := <-done:
		if err != nil {
			t.Fatal("settled ordinary work still rejected candidate admission", err)
		}
	case <-ctx.Done():
		t.Fatal("candidate did not continue after the shared lease settled")
	}
	select {
	case <-called:
	default:
		t.Fatal("binding callback was never reached")
	}
	other, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal("binding completion leaked lifecycle locks", err)
	}
	other()
}

func TestSpineCandidateQuiescenceWaitHonorsDeadlineAndCancellation(t *testing.T) {
	for _, lock := range []string{"core-admission.flock", "core-lifecycle.flock"} {
		for _, stop := range []string{"deadline", "cancel"} {
			t.Run(lock+"/"+stop, func(t *testing.T) {
				f := newFrozenCandidateFixture(t)
				barrier := f.manager.barrier()
				release, err := barrier.lockFile(context.Background(), lock, syscall.LOCK_SH, false)
				if err != nil {
					t.Fatal(err)
				}
				released := false
				defer func() {
					if !released {
						release()
					}
				}()
				var ctx context.Context
				var cancel context.CancelFunc
				want := context.DeadlineExceeded
				if stop == "deadline" {
					ctx, cancel = context.WithTimeout(context.Background(), 60*time.Millisecond)
				} else {
					ctx, cancel = context.WithCancel(context.Background())
					want = context.Canceled
					timer := time.AfterFunc(30*time.Millisecond, cancel)
					defer timer.Stop()
				}
				defer cancel()
				called := false
				err = f.manager.WithQuiescent(ctx, func() error { called = true; return nil })
				if !errors.Is(err, want) || !strings.Contains(err.Error(), lock) || called {
					t.Fatalf("busy %s ignored %s or entered callback: %v called=%v", lock, stop, err, called)
				}
				// Even while the original reader still holds its shared lease, a
				// new ordinary reader can enter once the canceled writer releases.
				other, err := barrier.AdmitOrdinary()
				if err != nil {
					t.Fatal("canceled candidate leaked its exclusive admission gate", err)
				}
				other()
				release()
				released = true
				retryCtx, retryCancel := context.WithTimeout(context.Background(), time.Second)
				defer retryCancel()
				if err := f.manager.WithQuiescent(retryCtx, func() error { return nil }); err != nil {
					t.Fatal("canceled candidate leaked another native lock", err)
				}
				if _, err := barrier.Read(); !os.IsNotExist(err) {
					t.Fatal("waiting created a durable lifecycle reservation", err)
				}
				if _, err := f.manager.core().Read(); !os.IsNotExist(err) {
					t.Fatal("waiting created a native update journal", err)
				}
			})
		}
	}
}

func TestSpineCandidateQuiescenceKeepsUnfinishedReservationAfterDrain(t *testing.T) {
	f := newFrozenCandidateFixture(t)
	barrier := f.manager.barrier()
	release, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	var releaseOnce sync.Once
	releaseOriginal := func() { releaseOnce.Do(release) }
	defer releaseOriginal()
	raw, _ := json.Marshal(CoreLifecycleReservation{Schema: "youeye.core-lifecycle.v1", RequestID: "existing-request", ManifestSHA256: strings.Repeat("a", 64)})
	path := filepath.Join(barrier.Root, "core-reservation.json")
	if err := atomicWrite(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	timer := time.AfterFunc(40*time.Millisecond, releaseOriginal)
	defer timer.Stop()
	called := false
	err = f.manager.WithQuiescent(ctx, func() error { called = true; return nil })
	if err == nil || !strings.Contains(err.Error(), "System lifecycle reservation requires reconciliation") || called {
		t.Fatal("draining ordinary work bypassed the unfinished reservation", err, called)
	}
	retained, err := os.ReadFile(path)
	if err != nil || string(retained) != string(raw) {
		t.Fatal("candidate changed another operation's reservation", err)
	}
}
