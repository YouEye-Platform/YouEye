package systemupdate

import (
	"context"
	"errors"
	"os"
	"syscall"
	"testing"
	"time"
)

// A Control Panel restore holds the lifecycle lock; a System update asked for meanwhile holds the admission gate
// while it waits for that lock and then gives up. The restore's archive step, started in that window, waits for
// the gate instead of failing the restore.
func TestAdmitOrdinaryWaitOutlastsSystemAdmissionThatGivesUp(t *testing.T) {
	f, b, _, _ := admissionRunnerFixture(t)
	oldPoll := ordinaryAdmissionPoll
	ordinaryAdmissionPoll = 10 * time.Millisecond
	t.Cleanup(func() { ordinaryAdmissionPoll = oldPoll })

	restore, err := b.AdmitOrdinary() // the Control Panel's hold for the whole restore
	if err != nil {
		t.Fatal(err)
	}
	defer restore()
	systemCtx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	system := make(chan error, 1)
	go func() { system <- b.BeginContext(systemCtx, f.journal, nil) }()
	deadline := time.Now().Add(time.Second)
	for {
		gate, err := b.lockFile(context.Background(), "core-admission.flock", syscall.LOCK_SH, false)
		if err != nil {
			break
		}
		gate()
		if time.Now().After(deadline) {
			t.Fatal("System did not close the admission gate")
		}
		time.Sleep(time.Millisecond)
	}
	if step, err := b.AdmitOrdinary(); err == nil {
		step()
		t.Fatal("the non-waiting admission passed a closed gate")
	} else if !errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, ErrCoreLifecycleHeld) {
		t.Fatal("a busy gate must read as busy, not as a reservation:", err)
	}

	step, err := b.AdmitOrdinaryWait(context.Background(), 5*time.Second)
	if err != nil {
		t.Fatal("archive step refused while the System update only waited:", err)
	}
	step()
	if err := <-system; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("the System admission should have given up waiting for the restore:", err)
	}
	if _, err := b.Read(); !os.IsNotExist(err) {
		t.Fatal("an admission that gave up left a reservation:", err)
	}
}

func TestAdmitOrdinaryWaitRefusesReservationAtOnce(t *testing.T) {
	f, b, _, _ := admissionRunnerFixture(t)
	if err := b.Begin(f.journal); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	release, err := b.AdmitOrdinaryWait(context.Background(), time.Minute)
	if err == nil {
		release()
		t.Fatal("admitted under a System reservation")
	}
	if !errors.Is(err, ErrCoreLifecycleHeld) || time.Since(started) > 500*time.Millisecond {
		t.Fatal(err, time.Since(started))
	}
}

func TestAdmitOrdinaryWaitIsBoundedAndCancellable(t *testing.T) {
	_, b, _, _ := admissionRunnerFixture(t)
	oldPoll := ordinaryAdmissionPoll
	ordinaryAdmissionPoll = 10 * time.Millisecond
	t.Cleanup(func() { ordinaryAdmissionPoll = oldPoll })
	gate, err := b.lockFile(context.Background(), "core-admission.flock", syscall.LOCK_EX, false)
	if err != nil {
		t.Fatal(err)
	}
	defer gate()

	started := time.Now()
	if release, err := b.AdmitOrdinaryWait(context.Background(), 100*time.Millisecond); err == nil {
		release()
		t.Fatal("admitted through a held gate")
	} else if !errors.Is(err, syscall.EWOULDBLOCK) || time.Since(started) < 50*time.Millisecond || time.Since(started) > 2*time.Second {
		t.Fatal(err, time.Since(started))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started = time.Now()
	if release, err := b.AdmitOrdinaryWait(ctx, time.Minute); err == nil {
		release()
		t.Fatal("admitted through a held gate")
	} else if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > 2*time.Second {
		t.Fatal(err, time.Since(started))
	}
}
