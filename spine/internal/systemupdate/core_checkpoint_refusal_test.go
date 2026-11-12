package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// refusalRuntimeFixture is a complete native runtime whose checkpoint child is simulated: its result comes from
// childResult, as the hidden run-action child would report it. Admission, the lifecycle barrier, child settlement,
// cancellation and recovery use the real native code.
func refusalRuntimeFixture(t *testing.T, childResult func(CoreStep) CoreActionObservation) (CoreManager, CoreJournal, NativeCoreRuntime, CoreLifecycleBarrier, map[string]int) {
	t.Helper()
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	if j.RestartRequired {
		t.Fatal("fixture should change services only")
	}
	host := newManagerFixture(t).manager
	host.config.CoreStatePath = m.Root
	data := t.TempDir()
	checkpoint := NativeCoreCheckpoint{Root: m.Root, DataRoot: data, StatePath: host.config.StatePath}
	cache := CoreArtifactCache{Root: filepath.Join(data, "cache")}
	cgroups := t.TempDir()
	runner := CoreSystemdRunner{Root: m.Root, Executable: "/usr/local/bin/youeye", CgroupRoot: cgroups,
		BootID: func() (string, error) { return "11111111-1111-1111-1111-111111111111", nil },
		Capture: func(_ context.Context, name string, args ...string) ([]byte, error) {
			// Every child unit has exited and been collected.
			if name == "systemctl" && len(args) == 3 && args[0] == "show" {
				return []byte("Id=" + args[2] + "\nLoadState=not-found\n"), nil
			}
			return nil, fmt.Errorf("unexpected native command %s %v", name, args)
		}}
	r := NativeCoreRuntime{
		Root: m.Root, Host: host, Checkpoint: checkpoint, Cache: cache,
		Services:            NativeCoreServices{Checkpoint: checkpoint, Cache: cache},
		Runner:              runner,
		AuthorizeTarget:     func(context.Context, CoreJournal, bool) error { return nil },
		AuthorizePrevious:   func(context.Context, CoreJournal) error { return nil },
		HostHealth:          func(context.Context, CoreJournal) (string, error) { return "unused", nil },
		AuthenticatedHealth: func(context.Context, CoreJournal, bool) (string, error) { return "unused", nil },
		RecoverHost: func(context.Context, CoreJournal, bool) (CoreActionObservation, error) {
			return CoreActionObservation{}, fmt.Errorf("unused")
		},
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
	starts := map[string]int{}
	e := r.Executor()
	e.ExecuteAction = func(_ context.Context, _ CoreJournal, s CoreStep) (CoreActionObservation, error) {
		starts[s.Name]++
		return childResult(s), nil
	}
	m.Executor = e
	return m, j, r, CoreLifecycleBarrier{Root: filepath.Join(data, "state", "app-updates")}, starts
}

func refusedPreflight(s CoreStep) CoreActionObservation {
	if s.Name == "checkpoint" {
		return coreCheckpointPreflightFailure(fmt.Errorf("installed application container is missing"))
	}
	if s.Name == "recovery-fence" {
		return CoreActionObservation{State: "unknown", Evidence: "fixture fence outcome"}
	}
	return CoreActionObservation{State: "succeeded", Evidence: "fixture " + s.Name}
}

func TestCoreCheckpointPreflightRefusalEndsUpdateAndReleasesHold(t *testing.T) {
	m, j, _, barrier, starts := refusalRuntimeFixture(t, refusedPreflight)
	got, err := m.Advance(context.Background(), j.RequestID, false)
	if err != nil || got.Phase != "cancelled" || got.Error != coreCheckpointRefusedError {
		t.Fatalf("refused preflight did not end the update: phase=%s error=%q err=%v", got.Phase, got.Error, err)
	}
	for _, step := range got.Steps {
		switch step.Name {
		case "verify-members":
		case "checkpoint":
			if step.State != "failed" || !strings.Contains(step.Evidence, "installed application container is missing") {
				t.Fatalf("checkpoint outcome lost: %+v", step)
			}
		default:
			if step.State != "pending" || starts[step.Name] != 0 {
				t.Fatalf("%s ran after a refused checkpoint", step.Name)
			}
		}
	}
	if len(got.RecoverySteps) != 0 || starts["checkpoint"] != 1 {
		t.Fatalf("refusal entered recovery or relaunched: %+v %v", got.RecoverySteps, starts)
	}
	if _, err := barrier.Read(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lifecycle reservation kept after the update ended: %v", err)
	}
	release, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatalf("app operations still refused: %v", err)
	}
	release()
	receipt, err := m.ReadReceipt()
	if err != nil || receipt.ManifestSHA256 != j.Previous.ManifestSHA256 {
		t.Fatal("installed release changed", err)
	}
	// The ended request stays ended: resume and recover cannot reopen it.
	if again, err := m.Advance(context.Background(), j.RequestID, true); err != nil || again.Phase != "cancelled" {
		t.Fatal(again.Phase, err)
	}
	if _, err := m.Recover(context.Background(), j.RequestID); err == nil {
		t.Fatal("cancelled request entered recovery")
	}
}

// A journal that already recorded the refusal (or whose coordinator never observed it) ends the same way through
// explicit cancel or recover, which is what the Control Panel offers on needs-recovery.
func TestCoreCheckpointPreflightRefusalCancelAndRecoverEndTheUpdate(t *testing.T) {
	for _, action := range []string{"cancel", "recover"} {
		t.Run(action, func(t *testing.T) {
			m, j, _, barrier, starts := refusalRuntimeFixture(t, refusedPreflight)
			// Let the child refuse, then put the journal back as if its coordinator was lost before observing.
			if _, err := m.Advance(context.Background(), j.RequestID, false); err != nil {
				t.Fatal(err)
			}
			current, err := m.Read()
			if err != nil {
				t.Fatal(err)
			}
			current.Phase, current.Error = "needs-recovery", ""
			for i := range current.Steps {
				if current.Steps[i].Name == "checkpoint" {
					current.Steps[i].State = "started"
					if action == "cancel" {
						current.Steps[i].State = "failed"
					}
				}
			}
			if err := m.saveCore(&current); err != nil {
				t.Fatal(err)
			}
			if err := barrier.Begin(j); err != nil { // the hold as admission left it
				t.Fatal(err)
			}
			var got CoreJournal
			if action == "cancel" {
				got, err = m.Cancel(context.Background(), j.RequestID)
			} else {
				got, err = m.Recover(context.Background(), j.RequestID)
			}
			if err != nil || got.Phase != "cancelled" || len(got.RecoverySteps) != 0 || starts["recovery-fence"] != 0 {
				t.Fatalf("%s did not end the refused update: %s %v %v", action, got.Phase, err, starts)
			}
			if _, err := barrier.Read(); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("lifecycle reservation kept: %v", err)
			}
		})
	}
}

// A checkpoint with any trace of writer closure, or without the preflight refusal code, must go through full
// paired recovery: the fence runs, the hold stays, and cancel stays refused.
func TestCoreCheckpointRefusalAfterWriterClosureKeepsFullRecovery(t *testing.T) {
	cases := map[string]func(CoreStep) CoreActionObservation{
		"record exists": refusedPreflight,
		"ordinary failure": func(s CoreStep) CoreActionObservation {
			if s.Name == "checkpoint" {
				return CoreActionObservation{State: "failed", Stage: "execute", Code: "native_action_failed", EffectState: "started", Evidence: "capture failed after writers stopped"}
			}
			return refusedPreflight(s)
		},
	}
	for name, child := range cases {
		t.Run(name, func(t *testing.T) {
			m, j, r, barrier, starts := refusalRuntimeFixture(t, child)
			if name == "record exists" {
				// Quiesce saved its record (and may have stopped writers) before the failure.
				record := NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Phase: "quiescing", Inventory: CoreCheckpointInventory{RequestID: j.RequestID}}
				if err := r.Checkpoint.saveRecord(record); err != nil {
					t.Fatal(err)
				}
			}
			got, err := m.Advance(context.Background(), j.RequestID, false)
			if err != nil || got.Phase != "needs-recovery" {
				t.Fatalf("unproven refusal ended the update: %s %v", got.Phase, err)
			}
			if _, err := m.Cancel(context.Background(), j.RequestID); err == nil {
				t.Fatal("cancel skipped recovery of a checkpoint that may have stopped writers")
			}
			if _, err := barrier.Read(); err != nil {
				t.Fatalf("lifecycle hold released before recovery: %v", err)
			}
			got, err = m.Recover(context.Background(), j.RequestID)
			if err != nil || got.Phase != "recovering" || len(got.RecoverySteps) == 0 || got.RecoverySteps[0].Name != "recovery-fence" || got.RecoverySteps[0].State != "started" || starts["recovery-fence"] != 1 {
				t.Fatalf("full recovery did not start with the fence: %s %+v %v %v", got.Phase, got.RecoverySteps, err, starts)
			}
			if _, err := barrier.Read(); err != nil {
				t.Fatalf("lifecycle hold released during recovery: %v", err)
			}
			if _, err := m.Cancel(context.Background(), j.RequestID); err == nil {
				t.Fatal("recovering request cancelled")
			}
		})
	}
}

func TestCoreLifecycleRefusedReleaseRequiresCancelIntent(t *testing.T) {
	m, j, _, barrier, _ := refusalRuntimeFixture(t, refusedPreflight)
	if err := barrier.Begin(j); err != nil {
		t.Fatal(err)
	}
	if err := barrier.ReleaseRefusedCheckpoint(context.Background(), m, j.RequestID); err == nil {
		t.Fatal("released a hold without a refused checkpoint and cancel intent")
	}
	if _, err := barrier.Read(); err != nil {
		t.Fatal("reservation removed", err)
	}
}
