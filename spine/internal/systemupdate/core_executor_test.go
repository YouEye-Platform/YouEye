package systemupdate

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestNativeCoreExecutorNeverReplaysUncertainEffects(t *testing.T) {
	ctx := context.Background()
	j := CoreJournal{RequestID: "request", ManifestSHA256: strings.Repeat("a", 64), Target: releasecache.CoreRelease{Version: "0.5.38"}}
	s := CoreStep{Name: "apply-cp", RequestID: "request/apply-cp"}
	starts := 0
	reconciled := CoreActionObservation{State: "absent"}
	e := NativeCoreExecutor{Root: t.TempDir(), AuthorizeAction: func(context.Context, CoreJournal, bool) error { return nil },
		ExecuteAction: func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
			starts++
			return CoreActionObservation{}, fmt.Errorf("acknowledgement lost")
		},
		ReconcileAction: func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) { return reconciled, nil },
	}
	if _, err := e.Start(ctx, j, s); err == nil {
		t.Fatal("lost acknowledgement accepted")
	}
	for i := 0; i < 3; i++ {
		result, err := e.Start(ctx, j, s)
		if err != nil || result.State != "unknown" || starts != 1 {
			t.Fatal(result, starts, err)
		}
	}
	reconciled = CoreActionObservation{State: "succeeded", Evidence: "exact-target receipt"}
	result, err := e.Observe(ctx, j, s)
	if err != nil || result.State != "succeeded" {
		t.Fatal(result, err)
	}
	// A later caller with the same action ID receives the retained receipt,
	// even when it can no longer reach the original operation owner.
	e.ReconcileAction = func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
		t.Fatal("reconciled terminal action again")
		return CoreActionObservation{}, nil
	}
	if result, err := e.Start(ctx, j, s); err != nil || result.State != "succeeded" || starts != 1 {
		t.Fatal(result, starts, err)
	}
	j.ManifestSHA256 = strings.Repeat("b", 64)
	if _, err := e.Start(ctx, j, s); err == nil {
		t.Fatal("action ID rebound to another selection")
	}
}

func TestNativeRecoveryUsesSeparateCurrentAuthority(t *testing.T) {
	m, _, j := failedCoreFixture(t)
	j.Phase = "recovering"
	for _, name := range coreRecoveryNames(j) {
		j.RecoverySteps = append(j.RecoverySteps, CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"})
	}
	j.RecoverySteps[0].State = "started"
	denied := false
	e := NativeCoreExecutor{Root: m.Root,
		AuthorizeAction: func(context.Context, CoreJournal, bool) error { return fmt.Errorf("target authority revoked") },
		AuthorizeRecoveryAction: func(context.Context, CoreJournal) error {
			if denied {
				return fmt.Errorf("previous release denied")
			}
			return nil
		},
		ExecuteAction: func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
			return CoreActionObservation{State: "succeeded", Evidence: "native fence verified"}, nil
		},
		ReconcileAction: func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
			return CoreActionObservation{State: "unknown"}, nil
		},
	}
	if got, err := e.Start(context.Background(), j, j.RecoverySteps[0]); err != nil || got.State != "succeeded" {
		t.Fatal(got, err)
	}
	j.RecoverySteps[0].State, j.RecoverySteps[0].Evidence = "succeeded", "native fence verified"
	j.RecoverySteps[1].State = "started"
	denied = true
	if _, err := e.Start(context.Background(), j, j.RecoverySteps[1]); err == nil {
		t.Fatal("recovery bypassed denied previous authority")
	}
}

func TestNativeCoreExecutorReconcilesReturnedBackgroundAction(t *testing.T) {
	ctx := context.Background()
	j := CoreJournal{RequestID: "request", ManifestSHA256: strings.Repeat("a", 64)}
	s := CoreStep{Name: "activate-host", RequestID: "request/activate-host"}
	e := NativeCoreExecutor{Root: t.TempDir(), AuthorizeAction: func(context.Context, CoreJournal, bool) error { return nil },
		ExecuteAction: func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
			return CoreActionObservation{State: "running"}, nil
		},
		ReconcileAction: func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
			return CoreActionObservation{State: "succeeded", Evidence: "exact boot identity"}, nil
		},
	}
	if result, err := e.Start(ctx, j, s); err != nil || result.State != "running" {
		t.Fatal(result, err)
	}
	// The executor process is still alive; its returned action must nevertheless
	// consult the host's actual reboot journal, not stick at process liveness.
	if result, err := e.Observe(ctx, j, s); err != nil || result.State != "succeeded" {
		t.Fatal(result, err)
	}
	unlock, err := e.lockAction(s)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, err := e.Start(ctx, j, s); err == nil {
		t.Fatal("concurrent executor bypassed action lock")
	}
}
