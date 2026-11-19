package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"
)

func shortContainersWait(t *testing.T, wait time.Duration) {
	t.Helper()
	oldWait, oldPoll := coreContainersStartWait, coreContainersStartPoll
	coreContainersStartWait, coreContainersStartPoll = wait, time.Millisecond
	t.Cleanup(func() { coreContainersStartWait, coreContainersStartPoll = oldWait, oldPoll })
}

func shortSettledHealthWait(t *testing.T, wait time.Duration) {
	t.Helper()
	oldWait, oldPoll := coreSettledHealthWait, coreSettledHealthPoll
	coreSettledHealthWait, coreSettledHealthPoll = wait, time.Millisecond
	t.Cleanup(func() { coreSettledHealthWait, coreSettledHealthPoll = oldWait, oldPoll })
}

// bootingBox is the box of 2026-11-19 (bykapc 360): a promotion of the installed build (verify-members, then
// authenticated-health) requested through the real native runtime while Incus is still starting the core
// containers. running answers what Incus says about them; the children are simulated and succeed.
type bootingBox struct {
	m        CoreManager
	e        NativeCoreExecutor
	j        CoreJournal
	step     CoreStep // verify-members
	running  func() bool
	observed int
	starts   map[string]int
}

func newBootingBox(t *testing.T) *bootingBox {
	t.Helper()
	m, _, target := coreJournalFixture(t)
	installed, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	target.Members = installed.Release.Members
	b := &bootingBox{starts: map[string]int{}, running: func() bool { return false }}
	b.j = prepareCoreFixture(t, m, target)
	if !b.j.MetadataOnly || b.j.Steps[0].Name != "verify-members" {
		t.Fatal("fixture should be a promotion of the installed build")
	}
	b.step = b.j.Steps[0]
	r, _ := nativeRuntimeFixture(t, m)
	r.containerPID = func(context.Context, string) (int, error) {
		b.observed++
		if !b.running() {
			return 0, fmt.Errorf("core container is not running")
		}
		return os.Getpid(), nil
	}
	b.e = r.Executor()
	b.e.ExecuteAction = func(_ context.Context, _ CoreJournal, s CoreStep) (CoreActionObservation, error) {
		if !b.running() {
			t.Errorf("%s launched while the core containers were not running", s.Name)
		}
		b.starts[s.Name]++
		return CoreActionObservation{State: "succeeded", Evidence: "fixture " + s.Name}, nil
	}
	m.Executor = b.e
	b.m = m
	return b
}

func (b *bootingBox) installedUnchanged(t *testing.T) {
	t.Helper()
	receipt, err := b.m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(receipt, b.j.Previous) {
		t.Fatal("installed release changed", err)
	}
}

// The live case: the containers come up while the coordinator waits. The request commits in one run; nothing was
// launched before they ran, and the wait is visible as an admission that has started nothing.
func TestCoreUpdateStartedWhileCoreContainersStartWaitsForThem(t *testing.T) {
	shortContainersWait(t, time.Minute)
	b := newBootingBox(t)
	b.running = func() bool {
		if b.observed > 3 {
			return true
		}
		// Still starting: what the status API and the action record say meanwhile.
		status, err := b.e.ActionStatus(b.j, b.step)
		if err != nil || status.State != "running" || status.Stage != "admission" || status.EffectState != "not-started" {
			t.Errorf("wait not visible as a pre-launch admission: %+v %v", status, err)
		}
		if record, err := b.e.read(b.j, b.step); err != nil || record.Result.Evidence != "waiting for the core containers (youeye-control, youeye-ui) to start" {
			t.Errorf("wait has no clear evidence: %+v %v", record.Result, err)
		}
		return false
	}
	j, err := b.m.Advance(context.Background(), b.j.RequestID, false)
	if err != nil || j.Phase != "committed" || j.Error != "" {
		t.Fatalf("request did not commit after the containers started: phase=%s error=%q err=%v", j.Phase, j.Error, err)
	}
	if b.observed <= 3 || b.starts["verify-members"] != 1 || b.starts["authenticated-health"] != 1 {
		t.Fatalf("observed=%d starts=%v", b.observed, b.starts)
	}
}

// The containers never start within the bound. The request is left as a retryable admission (never
// needs-recovery, never an unknown outcome): `resume` waits again and continues once they run.
func TestCoreUpdateWhoseCoreContainersDoNotStartResumesWithoutCancel(t *testing.T) {
	shortContainersWait(t, 40*time.Millisecond)
	b := newBootingBox(t)
	for attempt := 0; attempt < 2; attempt++ { // the first run, then a resume that is still too early
		j, err := b.m.Advance(context.Background(), b.j.RequestID, false)
		if err != nil || j.Phase != "applying" || j.Error != coreContainersNotRunningError || j.Steps[0].State != "started" {
			t.Fatalf("attempt %d: phase=%s error=%q step=%+v err=%v", attempt, j.Phase, j.Error, j.Steps[0], err)
		}
		// What the continuation loop reads next: retryable ends the command without recording attention.
		observed, err := b.m.Executor.Observe(context.Background(), j, j.Steps[0])
		if err != nil || observed.State != "retryable" || observed.Stage != "admission" || observed.Code != "admission_timeout" || observed.EffectState != "not-started" {
			t.Fatalf("attempt %d: %+v %v", attempt, observed, err)
		}
		if len(b.starts) != 0 {
			t.Fatal("an action was launched", b.starts)
		}
	}
	b.installedUnchanged(t)
	b.running = func() bool { return true }
	j, err := b.m.Advance(context.Background(), b.j.RequestID, false)
	if err != nil || j.Phase != "committed" || j.Error != "" || b.starts["verify-members"] != 1 || b.starts["authenticated-health"] != 1 {
		t.Fatalf("resume did not finish the request: phase=%s error=%q starts=%v err=%v", j.Phase, j.Error, b.starts, err)
	}
}

// The same request can also be cancelled: nothing was launched, so there is nothing to settle.
func TestCoreUpdateWhoseCoreContainersDoNotStartCancels(t *testing.T) {
	shortContainersWait(t, 40*time.Millisecond)
	b := newBootingBox(t)
	if j, err := b.m.Advance(context.Background(), b.j.RequestID, false); err != nil || j.Phase != "applying" {
		t.Fatal(j.Phase, err)
	}
	j, err := b.m.Cancel(context.Background(), b.j.RequestID)
	if err != nil || j.Phase != "cancelled" || len(b.starts) != 0 {
		t.Fatalf("phase=%s starts=%v err=%v", j.Phase, b.starts, err)
	}
	b.installedUnchanged(t)
}

// A caller that goes away during the wait (its context ends) leaves the same retryable admission.
func TestCoreContainersWaitCancelledByCallerIsRetryable(t *testing.T) {
	shortContainersWait(t, time.Minute)
	b := newBootingBox(t)
	ctx, cancel := context.WithCancel(context.Background())
	b.running = func() bool {
		if b.observed > 2 {
			cancel()
		}
		return false
	}
	b.j.Steps[0].State, b.j.Phase = "started", "applying"
	if err := b.m.saveCore(&b.j); err != nil {
		t.Fatal(err)
	}
	out, err := b.e.Start(ctx, b.j, b.j.Steps[0])
	if err != nil || out.State != "retryable" || out.Code != "admission_cancelled" || out.EffectState != "not-started" || len(b.starts) != 0 {
		t.Fatalf("%+v %v %v", out, err, b.starts)
	}
}

// The coordinator is lost while it waits (a reboot, a killed console command): its record still says
// "waiting", from a process that no longer exists. For verify-members that proves nothing was launched, so the
// next coordinator admits the request again. A record that reached the launch stays unknown, and so does a lost
// checkpoint admission (TestCoreAdmissionLostProcessEvidenceNeverAuthorizesRetry).
func TestCoreContainersWaitLostCoordinatorIsAdmittedAgain(t *testing.T) {
	lost := func(b *bootingBox, stage, effect string) {
		t.Helper()
		b.j.Steps[0].State, b.j.Phase = "started", "applying"
		if err := b.m.saveCore(&b.j); err != nil {
			t.Fatal(err)
		}
		b.step = b.j.Steps[0]
		a := nativeCoreAction{Schema: "youeye.core-action.v1", RequestID: b.step.RequestID, Name: b.step.Name, ManifestSHA256: b.j.ManifestSHA256, PID: os.Getpid(), ProcessIdentity: "another-boot:1", Active: true,
			Result: CoreActionObservation{State: "running", Stage: stage, EffectState: effect}}
		if err := b.e.save(b.step, a); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("during the wait", func(t *testing.T) {
		shortContainersWait(t, 40*time.Millisecond)
		b := newBootingBox(t)
		lost(b, "admission", "not-started")
		observed, err := b.e.Observe(context.Background(), b.j, b.step)
		if err != nil || observed.State != "retryable" || observed.Code != "admission_cancelled" || observed.Stage != "admission" || observed.EffectState != "not-started" {
			t.Fatalf("%+v %v", observed, err)
		}
		b.running = func() bool { return true }
		j, err := b.m.Advance(context.Background(), b.j.RequestID, false)
		if err != nil || j.Phase != "committed" || b.starts["verify-members"] != 1 {
			t.Fatalf("phase=%s starts=%v err=%v", j.Phase, b.starts, err)
		}
	})
	t.Run("after the launch was recorded", func(t *testing.T) {
		b := newBootingBox(t)
		b.running = func() bool { return true }
		lost(b, "launch", "")
		for i := 0; i < 2; i++ {
			observed, err := b.e.Start(context.Background(), b.j, b.step)
			if err != nil || observed.State != "unknown" || len(b.starts) != 0 {
				t.Fatalf("lost launch was not kept unknown: %+v %v %v", observed, err, b.starts)
			}
		}
	})
}

// The runtime's admission of verify-members only waits for the containers: no lifecycle reservation, and both
// containers the walk reads are asked for.
func TestCoreContainersWaitReservesNothing(t *testing.T) {
	shortContainersWait(t, time.Minute)
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	r, barrier := nativeRuntimeFixture(t, m)
	asked := map[string]int{}
	r.containerPID = func(_ context.Context, name string) (int, error) {
		asked[name]++
		if name == "youeye-ui" && asked[name] < 3 {
			return 0, fmt.Errorf("core container is not running")
		}
		return os.Getpid(), nil
	}
	if err := r.Executor().AdmitAction(context.Background(), j, j.Steps[0]); err != nil {
		t.Fatal(err)
	}
	if asked["youeye-control"] != 3 || asked["youeye-ui"] != 3 || len(asked) != 2 {
		t.Fatal(asked)
	}
	if _, err := barrier.Read(); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("waiting for the containers reserved the lifecycle", err)
	}
	release, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal("app work refused after the wait", err)
	}
	release()
}

func TestCoreContainersWaitEndsWithTheContextError(t *testing.T) {
	down := func(context.Context, string) (int, error) { return 0, fmt.Errorf("core container is not running") }
	shortContainersWait(t, 30*time.Millisecond)
	if err := waitCoreContainersRunning(context.Background(), down); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitCoreContainersRunning(ctx, down); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestCoreSettledHealthWaitRepeatsTheCheck(t *testing.T) {
	notYet := errors.New("platform operational health failed")
	t.Run("passes once the box has started", func(t *testing.T) {
		shortSettledHealthWait(t, time.Minute)
		calls := 0
		evidence, err := waitCoreSettledHealth(context.Background(), func(context.Context) (string, error) {
			calls++
			if calls < 4 {
				return "", notYet
			}
			return "healthy", nil
		})
		if err != nil || evidence != "healthy" || calls != 4 {
			t.Fatal(evidence, err, calls)
		}
	})
	t.Run("returns the check's own error when the wait ends", func(t *testing.T) {
		shortSettledHealthWait(t, 30*time.Millisecond)
		calls := 0
		_, err := waitCoreSettledHealth(context.Background(), func(context.Context) (string, error) { calls++; return "", notYet })
		if err != notYet || calls < 2 {
			t.Fatal(err, calls)
		}
	})
	t.Run("stops with the caller", func(t *testing.T) {
		shortSettledHealthWait(t, time.Minute)
		ctx, cancel := context.WithCancel(context.Background())
		calls := 0
		_, err := waitCoreSettledHealth(ctx, func(context.Context) (string, error) { calls++; cancel(); return "", notYet })
		if err != notYet || calls != 1 {
			t.Fatal(err, calls)
		}
	})
}

// The final check of a request without apply steps is repeated by the action itself; the check of the installed
// release (a no-op request) passes here on its third run.
func TestCoreUnappliedRequestHealthWaitsForAStartingBox(t *testing.T) {
	shortSettledHealthWait(t, time.Minute)
	m, _, _ := coreJournalFixture(t)
	installed, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(installed.Release)
	j, err := m.Prepare(context.Background(), "no-op", raw, installed.ManifestSHA256)
	if err != nil || !j.NoOp {
		t.Fatal(j.NoOp, err)
	}
	j.Phase = "applying"
	j.Steps[0].State, j.Steps[0].Evidence = "succeeded", "fixture verify-members"
	j.Steps[1].State = "started"
	if err = m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	r, _ := nativeRuntimeFixture(t, m)
	checks := 0
	r.AuthenticatedHealth = func(context.Context, CoreJournal, bool) (string, error) {
		checks++
		if checks < 3 {
			return "", fmt.Errorf("platform operational health failed")
		}
		return "fixture health", nil
	}
	got, err := r.execute(context.Background(), j, j.Steps[1])
	if err != nil || got.State != "succeeded" || got.Evidence != "fixture health" || checks != 3 {
		t.Fatalf("%+v err=%v checks=%d", got, err, checks)
	}
}
