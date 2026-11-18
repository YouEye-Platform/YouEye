package cmd

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// lostWatchdog is the watchdog of an API service that started before the
// request existed, has seen the request's current journal state once and now
// looks again after the idle time, with no System update command running.
func lostWatchdog(t *testing.T, m systemupdate.CoreManager) *systemupdate.CoreContinuationWatchdog {
	t.Helper()
	now := time.Now()
	watchdog := &systemupdate.CoreContinuationWatchdog{Root: m.Root, Lifecycle: filepath.Join(t.TempDir(), "state", "app-updates"), Idle: coreWatchdogIdle,
		Now:          func() time.Time { return now },
		Coordinating: func() (bool, error) { return false, nil },
		Start: func(context.Context, string, string) (systemupdate.CoreControlObservation, error) {
			t.Error("a look of the fixture started a continuation")
			return systemupdate.CoreControlObservation{}, nil
		}}
	journal, aside := filepath.Join(m.Root, "journal.json"), filepath.Join(m.Root, "journal.json.aside")
	if err := os.Rename(journal, aside); err != nil {
		t.Fatal(err)
	}
	checkCoreContinuation(watchdog) // the look at the start of the service: no request
	if err := os.Rename(aside, journal); err != nil {
		t.Fatal(err)
	}
	checkCoreContinuation(watchdog) // the first sight of the request
	now = now.Add(coreWatchdogIdle + time.Minute)
	return watchdog
}

// The API service's loop around the watchdog: a look that starts a
// continuation is one call of the runner, and a look that panics or fails does
// not take the API service with it.
func TestCoreWatchdogLookNeverTakesTheAPIServiceDown(t *testing.T) {
	m, _ := statusFixture(t) // a held service update between two steps
	started := 0
	watchdog := lostWatchdog(t, m)
	watchdog.Start = func(_ context.Context, request, _ string) (systemupdate.CoreControlObservation, error) {
		started++
		if request != "update-1" {
			t.Errorf("started a continuation of %q", request)
		}
		return systemupdate.CoreControlObservation{State: "running"}, nil
	}
	checkCoreContinuation(watchdog)
	checkCoreContinuation(watchdog)
	if started != 1 {
		t.Fatalf("the runner was called %d times for one lost continuation", started)
	}
	watchdog = lostWatchdog(t, m)
	panicked := false
	watchdog.Start = func(context.Context, string, string) (systemupdate.CoreControlObservation, error) {
		panicked = true
		panic("fixture: the runner panics")
	}
	checkCoreContinuation(watchdog)
	if !panicked {
		t.Fatal("the fixture never reached the runner")
	}
	watchdog = lostWatchdog(t, m)
	listed := false
	watchdog.Start = func(context.Context, string, string) (systemupdate.CoreControlObservation, error) {
		t.Error("a continuation was started after the process list failed")
		return systemupdate.CoreControlObservation{}, nil
	}
	watchdog.Coordinating = func() (bool, error) {
		listed = true
		panic("fixture: the process list panics")
	}
	checkCoreContinuation(watchdog)
	if !listed {
		t.Fatal("the fixture never reached the process list")
	}
	checkCoreContinuation(&systemupdate.CoreContinuationWatchdog{}) // not configured: an error, no panic

	if coreWatchdogIdle != 5*time.Minute || coreWatchdogInterval != time.Minute {
		t.Fatalf("watchdog times changed (%s, %s): the docs name five minutes", coreWatchdogIdle, coreWatchdogInterval)
	}
}

// The watchdog the API service starts is complete (an incomplete one refuses
// every look, and nothing would say so), reads the installed state and the app
// lifecycle directory, and measures its wait on the monotonic clock.
func TestCoreWatchdogOfTheAPIServiceIsConfigured(t *testing.T) {
	watchdog := newCoreContinuationWatchdog()
	if watchdog.Root != systemupdate.CoreStatePath || watchdog.Lifecycle != systemupdate.CoreAppLifecycleRoot || watchdog.Idle != coreWatchdogIdle || watchdog.Now != nil || watchdog.Coordinating == nil || watchdog.Start == nil {
		t.Fatalf("watchdog of the API service: %+v", watchdog)
	}
	// A configured watchdog over an empty state directory looks without an error.
	watchdog.Root, watchdog.Lifecycle = t.TempDir(), t.TempDir()
	watchdog.Start = func(context.Context, string, string) (systemupdate.CoreControlObservation, error) {
		t.Error("started a continuation without a request")
		return systemupdate.CoreControlObservation{}, nil
	}
	if command, err := watchdog.Check(context.Background()); command != "" || err != nil {
		t.Fatalf("first look: %q %v", command, err)
	}
}

// What the watchdog starts for a finished request is `update core resume`.
// For a request that is committed or rolled back that command goes straight to
// the end of the request (where continueCoreRequest releases the holds), asks
// the executor nothing and leaves the journal as it is, however often it runs.
func TestCoreResumeOfAFinishedRequestOnlyFinishes(t *testing.T) {
	finish := map[string]func(*testing.T, systemupdate.CoreManager, systemupdate.CoreJournal){
		"committed": func(t *testing.T, m systemupdate.CoreManager, j systemupdate.CoreJournal) {
			run := runContinuation(context.Background(), m, j.RequestID, true, neverHandOver(t))
			if run.err != nil || run.finished != 1 {
				t.Fatalf("fixture: finished=%d err=%v", run.finished, run.err)
			}
		},
		"rolled-back": func(t *testing.T, m systemupdate.CoreManager, j systemupdate.CoreJournal) {
			j.Phase = "rolled-back"
			for i := range j.Steps {
				switch j.Steps[i].Name {
				case "verify-members", "checkpoint":
					j.Steps[i].State, j.Steps[i].Evidence = "succeeded", "fixture"
				case "apply-cp":
					j.Steps[i].State, j.Steps[i].Evidence = "failed", "fixture apply-cp failed"
				}
			}
			for _, name := range []string{"recovery-fence", "recovery-paired-restore", "recovery-health"} {
				j.RecoverySteps = append(j.RecoverySteps, systemupdate.CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "succeeded", Evidence: "fixture"})
			}
			raw, err := json.Marshal(j)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(m.Root, "journal.json"), append(raw, '\n'), 0600); err != nil {
				t.Fatal(err)
			}
		},
	}
	for phase, finish := range finish {
		t.Run(phase, func(t *testing.T) {
			m, executor, j := continuationFixture(t, false)
			finish(t, m, j)
			if current, err := m.Read(); err != nil || current.Phase != phase {
				t.Fatalf("fixture journal: %s %v", current.Phase, err)
			}
			before, starts := treeSnapshot(t, m.Root), len(executor.starts)
			refuse := systemupdate.CoreManager{Root: m.Root, Executor: refusingExecutor{t}, YieldAfterSpine: true}
			for attempt := 1; attempt <= 2; attempt++ {
				resumed := runContinuation(context.Background(), refuse, j.RequestID, false, neverHandOver(t))
				if resumed.err != nil || resumed.journal.Phase != phase || resumed.finished != 1 {
					t.Fatalf("resume %d: phase=%s finished=%d err=%v", attempt, resumed.journal.Phase, resumed.finished, resumed.err)
				}
			}
			if after := treeSnapshot(t, m.Root); !reflect.DeepEqual(before, after) || len(executor.starts) != starts {
				t.Fatal("resume of a finished request changed the state directory or started an action")
			}
		})
	}
}

// refusingExecutor fails the test when the coordinator asks it anything.
type refusingExecutor struct{ t *testing.T }

func (e refusingExecutor) Authorize(context.Context, systemupdate.CoreJournal, bool) error {
	e.t.Error("a finished request was authorised again")
	return nil
}

func (e refusingExecutor) Start(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) (systemupdate.CoreActionObservation, error) {
	e.t.Error("a finished request started an action")
	return systemupdate.CoreActionObservation{}, nil
}

func (e refusingExecutor) Observe(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) (systemupdate.CoreActionObservation, error) {
	e.t.Error("a finished request observed an action")
	return systemupdate.CoreActionObservation{}, nil
}
