package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

func admissionRunnerFixture(t *testing.T, recovery ...bool) (*coreRunnerFixture, CoreLifecycleBarrier, NativeCoreExecutor, CoreManager) {
	t.Helper()
	name := "checkpoint"
	if len(recovery) > 0 && recovery[0] {
		name = "recovery-fence"
	}
	f := newCoreRunnerFixture(t, name)
	b := CoreLifecycleBarrier{Root: filepath.Join(t.TempDir(), "state", "app-updates")}
	e := NativeCoreExecutor{Root: f.runner.Root,
		AuthorizeAction:         func(context.Context, CoreJournal, bool) error { return nil },
		AuthorizeRecoveryAction: func(context.Context, CoreJournal) error { return nil },
		AdmitAction: func(ctx context.Context, j CoreJournal, _ CoreStep) error {
			return b.BeginContext(ctx, j, nil)
		}, ExecuteAction: f.runner.Start, ReconcileAction: f.runner.Observe,
	}
	return f, b, e, CoreManager{Root: f.runner.Root, Executor: e}
}

func TestCoreRecoveryAdmissionTimeoutKeepsSameRecoveryGraph(t *testing.T) {
	f, b, e, m := admissionRunnerFixture(t, true)
	f.journal.RecoverySteps[0].State = "pending"
	if err := m.saveCore(&f.journal); err != nil {
		t.Fatal(err)
	}
	release, err := b.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	j, err := m.Recover(ctx, f.journal.RequestID)
	if err != nil || j.Phase != "recovering" || f.starts != 0 {
		t.Fatal(j.Phase, err, f.starts)
	}
	out, err := e.ActionStatus(j, f.step)
	if err != nil || out.State != "retryable" || out.Code != "admission_timeout" || out.Evidence != "" {
		t.Fatal(out, err)
	}
	release()
	j, err = m.Recover(context.Background(), j.RequestID)
	if err != nil || j.RecoverySteps[0].RequestID != f.step.RequestID || f.starts != 1 {
		t.Fatal(j, err, f.starts)
	}
}

func TestCoreAdmissionTimeoutRetriesBeforeRunnerLaunchOnly(t *testing.T) {
	f, b, e, m := admissionRunnerFixture(t)
	for i := range f.journal.Steps {
		if f.journal.Steps[i].Name == "checkpoint" {
			f.journal.Steps[i].State = "pending"
		}
	}
	if err := m.saveCore(&f.journal); err != nil {
		t.Fatal(err)
	}
	release, err := b.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	j, err := m.Advance(ctx, f.journal.RequestID, false)
	if err != nil || j.Phase != "applying" || f.starts != 0 {
		t.Fatal(j.Phase, err, f.starts)
	}
	observed, err := e.Observe(context.Background(), j, f.step)
	if err != nil || observed.State != "retryable" || observed.Code != "admission_timeout" || observed.EffectState != "not-started" {
		t.Fatal(observed, err)
	}
	if _, err := os.Stat(f.runner.path(j, f.step)); !os.IsNotExist(err) {
		t.Fatal("runner launched during busy admission", err)
	}
	if _, err := b.Read(); !os.IsNotExist(err) {
		t.Fatal("busy admission reserved lifecycle", err)
	}
	release()
	j, err = m.Advance(context.Background(), j.RequestID, false)
	if err != nil || f.starts != 1 {
		t.Fatal(err, f.starts)
	}
	if _, err := b.Read(); err != nil {
		t.Fatal(err)
	}
	effects := 0
	_, err = f.runner.RunAction(context.Background(), j.RequestID, f.step.Name, j.ManifestSHA256,
		func(context.Context, CoreJournal, CoreStep) error { return nil },
		func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
			effects++
			return CoreActionObservation{}, fmt.Errorf("private subprocess output must not be retained")
		})
	if err == nil {
		t.Fatal("effect failure lost")
	}
	for i := 0; i < 2; i++ {
		observed, err = e.Start(context.Background(), j, f.step)
		if err != nil || observed.State != "unknown" || observed.Code != "native_action_failed" || observed.EffectState != "started" || f.starts != 1 || effects != 1 {
			t.Fatal(observed, err, f.starts, effects)
		}
	}
}

func TestCoreAdmissionDrainsReadersAndExcludesNewWork(t *testing.T) {
	f, b, _, m := admissionRunnerFixture(t)
	for i := range f.journal.Steps {
		if f.journal.Steps[i].Name == "checkpoint" {
			f.journal.Steps[i].State = "pending"
		}
	}
	if err := m.saveCore(&f.journal); err != nil {
		t.Fatal(err)
	}
	release, err := b.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	once := &sync.Once{}
	rawRelease := release
	release = func() { once.Do(rawRelease) }
	defer release()
	done := make(chan error, 1)
	go func() { _, err := m.Advance(context.Background(), f.journal.RequestID, false); done <- err }()
	deadline := time.Now().Add(time.Second)
	for {
		gate, err := b.lockFile(context.Background(), "core-admission.flock", syscall.LOCK_SH, false)
		if err != nil {
			break
		}
		gate()
		if time.Now().After(deadline) {
			t.Fatal("System did not close admission gate")
		}
		time.Sleep(time.Millisecond)
	}
	if late, err := b.AdmitOrdinary(); err == nil {
		late()
		t.Fatal("new background work overtook waiting System writer")
	}
	select {
	case err := <-done:
		t.Fatal("System did not wait for existing reader", err)
	default:
	}
	release()
	if err := <-done; err != nil || f.starts != 1 {
		t.Fatal(err, f.starts)
	}
	other := f.journal
	other.RequestID = "competing-system-request"
	if err := b.BeginContext(context.Background(), other, nil); err == nil {
		t.Fatal("competing request adopted reservation")
	}
}

func TestCoreAdmissionCancellationReauthorizesAndPreservesUnfinishedWork(t *testing.T) {
	f, b, e, _ := admissionRunnerFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := e.Start(ctx, f.journal, f.step)
	if err != nil || out.State != "retryable" || out.Code != "admission_cancelled" || f.starts != 0 {
		t.Fatal(out, err)
	}
	denied := errors.New("policy changed")
	e.AdmitAction = func(ctx context.Context, j CoreJournal, _ CoreStep) error {
		return b.BeginContext(ctx, j, func(context.Context) error { return denied })
	}
	out, err = e.Start(context.Background(), f.journal, f.step)
	if err != nil || out.State != "retryable" || out.Code != "admission_rejected" || f.starts != 0 {
		t.Fatal(out, err)
	}
	if _, err := b.Read(); !os.IsNotExist(err) {
		t.Fatal("revoked policy created reservation", err)
	}
	for _, tc := range []struct{ path, body string }{
		{"state/app-updates/operations/app.json", `{"schema":"youeye.app-update.v1","phase":"recovery_required","cleanupComplete":false}`},
		{"state/container-maintenance/operations/container.json", `{"schema":"youeye.container-maintenance/1","state":"failed"}`},
		{"backup-status.json", `{"status":"exporting"}`},
	} {
		t.Run(tc.path, func(t *testing.T) {
			f, b, e, _ := admissionRunnerFixture(t)
			data := filepath.Dir(filepath.Dir(b.Root))
			if err := atomicWrite(filepath.Join(data, tc.path), []byte(tc.body), 0600); err != nil {
				t.Fatal(err)
			}
			out, err := e.Start(context.Background(), f.journal, f.step)
			if err != nil || out.State != "retryable" || out.EffectState != "not-started" || f.starts != 0 {
				t.Fatal(out, err, f.starts)
			}
		})
	}
}

func TestCoreAdmissionLostProcessEvidenceNeverAuthorizesRetry(t *testing.T) {
	f, _, e, _ := admissionRunnerFixture(t)
	// A crash may happen after admission intent or reservation, but before
	// launch acknowledgement. Neither an absent child nor this receipt proves
	// a safely completed pre-effect timeout.
	a := nativeCoreAction{Schema: "youeye.core-action.v1", RequestID: f.step.RequestID, Name: f.step.Name, ManifestSHA256: f.journal.ManifestSHA256, PID: os.Getpid(), ProcessIdentity: "different-process", Active: true,
		Result: CoreActionObservation{State: "running", Stage: "admission", EffectState: "not-started"}}
	if err := e.save(f.step, a); err != nil {
		t.Fatal(err)
	}
	out, err := e.Start(context.Background(), f.journal, f.step)
	if err != nil || out.State != "unknown" || f.starts != 0 {
		t.Fatal(out, err, f.starts)
	}
	for _, forged := range []CoreActionObservation{
		{State: "retryable", Stage: "execute", Code: "admission_timeout", EffectState: "not-started", Evidence: "forged"},
		{State: "retryable", Stage: "admission", Code: "admission_timeout", EffectState: "started", Evidence: "forged"},
		{State: "retryable", Stage: "admission", Code: "native_action_failed", EffectState: "not-started", Evidence: "forged"},
	} {
		if validateNativeResult(forged) == nil {
			t.Fatal("invalid retry proof accepted", forged)
		}
	}
}

func TestCoreAdmissionRechecksFreshSelectionWithoutChangingStartedGraph(t *testing.T) {
	f := newCoreRunnerFixture(t, "checkpoint")
	r := NativeCoreRuntime{Root: f.runner.Root, Checkpoint: NativeCoreCheckpoint{DataRoot: t.TempDir()}}
	calls := 0
	r.AuthorizeTarget = func(_ context.Context, j CoreJournal, _ bool) error {
		calls++
		if !coreBeforeCheckpoint(j) {
			t.Fatal("freshness policy skipped after admission wait")
		}
		return nil
	}
	if err := r.Executor().AdmitAction(context.Background(), f.journal, f.step); err != nil {
		t.Fatal(err)
	}
	current, err := (CoreManager{Root: f.runner.Root}).Read()
	if err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
	for _, s := range current.Steps {
		if s.Name == "checkpoint" && s.State != "started" {
			t.Fatal("rewrote coordinator start intent")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	b := CoreLifecycleBarrier{Root: t.TempDir()}
	if err := os.Chmod(b.Root, 0700); err != nil {
		t.Fatal(err)
	}
	err = b.BeginContext(ctx, f.journal, func(context.Context) error { cancel(); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation during policy check ignored", err)
	}
	if _, err := b.Read(); !os.IsNotExist(err) {
		t.Fatal("cancelled authorization reserved lifecycle", err)
	}
}
