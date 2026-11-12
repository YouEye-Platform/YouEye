package systemupdate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func failedRecoveryHealthRunner(t *testing.T) *coreRunnerFixture {
	t.Helper()
	f := newCoreRunnerFixture(t, "recovery-health")
	f.runner.CgroupRoot = t.TempDir()
	ctx := context.Background()
	if _, err := f.runner.Start(ctx, f.journal, f.step); err != nil {
		t.Fatal(err)
	}
	got, err := f.runner.RunAction(ctx, f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256,
		func(context.Context, CoreJournal, CoreStep) error { return nil },
		func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
			return CoreActionObservation{}, errors.Join(errCoreRecoveryServices, fmt.Errorf("fixture subordinate detail"))
		})
	if err == nil || got.State != "unknown" || got.Code != "recovery_services_unavailable" {
		t.Fatal(got, err)
	}
	f.properties["ActiveState"], f.properties["MainPID"] = "failed", "0"
	return f
}

func TestRecoveryContinuationRequiresSettledExactChild(t *testing.T) {
	for _, mode := range []string{"settled", "absent-unit", "prior-boot-absent", "active", "pid", "invocation", "foreign-boot", "foreign-group", "descendants", "child-lease", "launch-lease", "missing-result", "changed-executable", "pending-predecessor", "wrong-step"} {
		t.Run(mode, func(t *testing.T) {
			f := failedRecoveryHealthRunner(t)
			success := mode == "settled" || mode == "absent-unit" || mode == "prior-boot-absent"
			switch mode {
			case "absent-unit", "prior-boot-absent":
				f.properties = map[string]string{"Id": f.runner.unit(f.journal, f.step), "LoadState": "not-found"}
				if mode == "prior-boot-absent" {
					f.boot = "22222222-2222-2222-2222-222222222222"
				}
			case "active":
				f.properties["ActiveState"] = "active"
			case "pid":
				f.properties["MainPID"] = "123"
			case "invocation":
				f.properties["InvocationID"] = strings.Repeat("b", 32)
			case "foreign-boot":
				f.boot = "22222222-2222-2222-2222-222222222222"
			case "foreign-group":
				f.properties["ControlGroup"] = "/foreign.slice/unrelated"
			case "descendants":
				path := filepath.Join(f.runner.CgroupRoot, "system.slice", f.runner.unit(f.journal, f.step))
				if err := os.MkdirAll(path, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(path, "cgroup.events"), []byte("populated 1\n"), 0600); err != nil {
					t.Fatal(err)
				}
			case "child-lease", "launch-lease":
				suffix := ".child-lock"
				if mode == "launch-lease" {
					suffix = ".lock"
				}
				unlock, err := lockCoreRunner(f.runner.path(f.journal, f.step) + suffix)
				if err != nil {
					t.Fatal(err)
				}
				defer unlock()
			case "missing-result":
				if err := os.Remove(f.runner.path(f.journal, f.step) + ".result"); err != nil {
					t.Fatal(err)
				}
			case "changed-executable":
				f.runner.Executable = "/untrusted/youeye"
			case "pending-predecessor":
				f.journal.RecoverySteps[0].State = "pending"
			case "wrong-step":
				f.step.Name = "apply-cp"
			}
			unlock, err := f.runner.lockSettledRecoveryHealth(context.Background(), f.journal, f.step)
			if unlock != nil {
				unlock()
			}
			if (err == nil) != success || f.starts != 1 {
				t.Fatal(mode, err, f.starts)
			}
		})
	}
}

func TestExplicitRecoverContinuesHealthWithoutRelaunchOrObservationEffects(t *testing.T) {
	f := failedRecoveryHealthRunner(t)
	ctx := context.Background()
	continued, denied := 0, false
	e := NativeCoreExecutor{Root: f.runner.Root,
		AuthorizeRecoveryAction: func(context.Context, CoreJournal) error {
			if denied {
				return fmt.Errorf("current recovery policy denied")
			}
			return nil
		},
		ExecuteAction: f.runner.Start, ReconcileAction: f.runner.Observe,
		ContinueRecoveryHealthAction: func(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
			unlock, err := f.runner.lockSettledRecoveryHealth(ctx, j, s)
			if err != nil {
				return CoreActionObservation{}, err
			}
			defer unlock()
			continued++
			if continued == 1 {
				return CoreActionObservation{}, errCoreRecoveryPower
			}
			return CoreActionObservation{State: "succeeded", Evidence: "fixture pending health substeps verified"}, nil
		},
	}
	identity, err := nativeProcessIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	a := nativeCoreAction{Schema: "youeye.core-action.v1", RequestID: f.step.RequestID, ManifestSHA256: f.journal.ManifestSHA256, Name: f.step.Name, PID: os.Getpid(), ProcessIdentity: identity, Result: CoreActionObservation{State: "unknown"}}
	if err := e.save(f.step, a); err != nil {
		t.Fatal(err)
	}
	unlock, err := e.lockAction(f.step)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.ContinueRecoveryHealth(ctx, f.journal, f.step); err == nil || continued != 0 {
		t.Fatal("executor lease bypass", err)
	}
	unlock()
	a.Active = true
	if err := e.save(f.step, a); err != nil {
		t.Fatal(err)
	}
	if got, err := e.ContinueRecoveryHealth(ctx, f.journal, f.step); err != nil || got.State != "running" || continued != 0 {
		t.Fatal("live continuation was duplicated", got, err)
	}
	a.Active = false
	if err := e.save(f.step, a); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(f.runner.path(f.journal, f.step) + ".result")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := e.Observe(ctx, f.journal, f.step); err != nil || got.State != "unknown" || continued != 0 {
		t.Fatal(got, err, continued)
	}
	m := CoreManager{Root: e.Root, Executor: e}
	denied = true
	if _, err := m.Recover(ctx, f.journal.RequestID); err == nil || continued != 0 {
		t.Fatal("policy bypass", err)
	}
	denied = false
	if _, err := m.Recover(ctx, f.journal.RequestID); err == nil || continued != 1 {
		t.Fatal(err, continued)
	}
	status, err := e.ActionStatus(f.journal, f.step)
	if err != nil || status.Code != "recovery_power_unavailable" || status.State != "unknown" || status.EffectState != "started" {
		t.Fatal(status, err)
	}
	got, err := m.Recover(ctx, f.journal.RequestID)
	if err != nil || got.Phase != "rolled-back" || continued != 2 || f.starts != 1 {
		t.Fatal(got.Phase, err, continued, f.starts)
	}
	if _, err := m.Recover(ctx, f.journal.RequestID); err != nil || continued != 2 {
		t.Fatal(err, continued)
	}
	after, err := os.ReadFile(f.runner.path(f.journal, f.step) + ".result")
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("original child evidence changed", err)
	}
}
