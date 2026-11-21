package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// owedRebootFixture is an image update (or its recovery) whose host step is
// started. The step's child was launched in this boot and left the word that
// `execute` leaves when it has asked for the restart.
type owedRebootFixture struct {
	runtime NativeCoreRuntime
	journal CoreJournal
	step    CoreStep
	boot    string
	// reboots counts `systemctl reboot` requests; rebootErr fails them.
	reboots   int
	rebootErr error
}

func newOwedRebootFixture(t *testing.T, name string) *owedRebootFixture {
	t.Helper()
	m, _, target := coreJournalFixture(t)
	for i := range target.Members {
		if target.Members[i].Role == "system-root" {
			target.Members[i].Artifact.SHA256 = strings.Repeat("f", 64)
		}
	}
	j := prepareCoreFixture(t, m, target)
	if !j.RestartRequired {
		t.Fatal("fixture is not an image update")
	}
	j.Phase, j.ActivationRequested = "applying", true
	f := &owedRebootFixture{boot: "11111111-1111-1111-1111-111111111111"}
	for i := range j.Steps {
		if j.Steps[i].Name == "activate-host" {
			j.Steps[i].State = "started"
			f.step = j.Steps[i]
			break
		}
		j.Steps[i].State, j.Steps[i].Evidence = "succeeded", "fixture"
	}
	if name == "recovery-host" {
		j.Phase = "recovering"
		for _, recovery := range coreRecoveryNames(j) {
			step := CoreStep{Name: recovery, RequestID: j.RequestID + "/" + recovery, State: "succeeded", Evidence: "fixture"}
			if recovery == "recovery-host" {
				step.State, step.Evidence = "started", ""
				f.step = step
			}
			if recovery == "recovery-health" {
				step.State, step.Evidence = "pending", ""
			}
			j.RecoverySteps = append(j.RecoverySteps, step)
		}
	}
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	f.journal = j
	f.runtime, _ = nativeRuntimeFixture(t, m)
	show := f.runtime.Runner.Capture
	f.runtime.Runner.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "systemctl" && len(args) == 1 && args[0] == "reboot" {
			f.reboots++
			return nil, f.rebootErr
		}
		return show(ctx, program, args...)
	}
	f.launch(t)
	f.result(t, CoreActionObservation{State: "unknown", Evidence: "counted host boot requested; awaiting actual boot observation"})
	f.hostPhase(t, PhasePending)
	f.age(t)
	return f
}

func (f *owedRebootFixture) launch(t *testing.T) coreRunnerLaunch {
	t.Helper()
	launch, err := f.runtime.Runner.expected(f.journal, f.step)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(launch)
	if err := os.MkdirAll(filepath.Dir(f.runtime.Runner.path(f.journal, f.step)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := atomicWrite(f.runtime.Runner.path(f.journal, f.step), raw, 0600); err != nil {
		t.Fatal(err)
	}
	return launch
}

func (f *owedRebootFixture) result(t *testing.T, outcome CoreActionObservation) {
	t.Helper()
	raw, _ := json.Marshal(coreRunnerResult{Launch: f.launch(t), InvocationID: strings.Repeat("a", 32), PID: 4242, ProcessIdentity: "fixture", Result: outcome})
	if err := atomicWrite(f.runtime.Runner.path(f.journal, f.step)+".result", raw, 0600); err != nil {
		t.Fatal(err)
	}
}

// hostPhase records the host update of this request in the given phase,
// activated in this boot.
func (f *owedRebootFixture) hostPhase(t *testing.T, phase string) {
	t.Helper()
	host := Journal{TransactionID: "fixture", ManifestSHA256: strings.Repeat("1", 64), CoreManifestSHA256: f.journal.ManifestSHA256, CurrentImage: "old", TargetImage: "new",
		ActiveSlot: "A", CandidateSlot: "B", Phase: phase, StartedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z", ActivationBootID: f.boot}
	if err := os.MkdirAll(filepath.Dir(f.runtime.Host.config.JournalPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := writeJournal(f.runtime.Host.config.JournalPath, host); err != nil {
		t.Fatal(err)
	}
}

// age makes everything the child and RebootAgain wrote older than the wait.
func (f *owedRebootFixture) age(t *testing.T) {
	t.Helper()
	old := time.Now().Add(-2 * coreOwedRebootWait)
	base := f.runtime.Runner.path(f.journal, f.step)
	for _, name := range []string{base, base + ".result", base + ".reboots"} {
		if err := os.Chtimes(name, old, old); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
}

func (f *owedRebootFixture) again(t *testing.T) (bool, error) {
	t.Helper()
	return f.runtime.RebootAgain(context.Background(), f.journal, f.step)
}

// The child of activate-host asked for the restart and the machine is still
// up: the restart is asked for again, twice at most and never right after the
// child or the last request; then the update is given up, so that the
// coordinator restores the previous release. Before 0.6.15 nothing judged such
// a step and the box stayed held with the Control Panel closed.
func TestCoreRebootAgainAsksForARestartThatDidNotHappen(t *testing.T) {
	f := newOwedRebootFixture(t, "activate-host")
	// Just after the child: the shutdown is under way.
	f.result(t, CoreActionObservation{State: "unknown", Evidence: "counted host boot requested; awaiting actual boot observation"})
	if asked, err := f.again(t); asked || err != nil || f.reboots != 0 {
		t.Fatalf("asked again right after the child: %v %v %d", asked, err, f.reboots)
	}
	for request := 1; request <= coreOwedRebootRequests; request++ {
		f.age(t)
		if asked, err := f.again(t); !asked || err != nil || f.reboots != request {
			t.Fatalf("request %d: asked=%v err=%v reboots=%d", request, asked, err, f.reboots)
		}
		// Not again within the wait.
		if asked, err := f.again(t); asked || err != nil || f.reboots != request {
			t.Fatalf("asked twice within the wait: %v %v %d", asked, err, f.reboots)
		}
	}
	f.age(t)
	asked, err := f.again(t)
	if asked || err == nil || !strings.Contains(err.Error(), "did not happen") || f.reboots != coreOwedRebootRequests {
		t.Fatalf("not given up: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
	// And it stays given up (the coordinator looks a second time before it recovers).
	if asked, err = f.again(t); asked || err == nil || f.reboots != coreOwedRebootRequests {
		t.Fatalf("the second look: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
}

func TestCoreRebootAgainLeavesWhatIsNotOwed(t *testing.T) {
	quiet := func(t *testing.T, f *owedRebootFixture, what string) {
		t.Helper()
		if asked, err := f.again(t); asked || err != nil || f.reboots != 0 {
			t.Fatalf("%s: asked=%v err=%v reboots=%d", what, asked, err, f.reboots)
		}
	}
	// The machine has restarted since the launch: the boot is the outcome.
	f := newOwedRebootFixture(t, "activate-host")
	f.runtime.Runner.BootID = func() (string, error) { return "22222222-2222-2222-2222-222222222222", nil }
	quiet(t, f, "after a restart")

	// The child still runs (its unit is active with a main process).
	f = newOwedRebootFixture(t, "activate-host")
	if err := os.Remove(f.runtime.Runner.path(f.journal, f.step) + ".result"); err != nil {
		t.Fatal(err)
	}
	unit := f.runtime.Runner.unit(f.journal, f.step)
	f.runtime.Runner.Capture = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("Id=" + unit + "\nLoadState=loaded\nActiveState=active\nSubState=running\nDescription=" + coreRunnerDescription(unit) + "\nTransient=yes\nKillMode=control-group\nRemainAfterExit=yes\nType=exec\nUser=root\nWorkingDirectory=\nRootDirectory=\nRootImage=\nRestart=no\nMainPID=4242\nInvocationID=" + strings.Repeat("a", 32) + "\n"), nil
	}
	quiet(t, f, "a running child")

	// Another step, and a step that is not started.
	f = newOwedRebootFixture(t, "activate-host")
	other := f.step
	other.State = "succeeded"
	if asked, err := f.runtime.RebootAgain(context.Background(), f.journal, other); asked || err != nil || f.reboots != 0 {
		t.Fatal(asked, err, f.reboots)
	}
}

// An activation that failed, or never ran, leaves no pending host update: a
// restart would boot the old slot. The update is given up at once.
func TestCoreRebootAgainGivesUpAnActivationThatNeverBecamePending(t *testing.T) {
	f := newOwedRebootFixture(t, "activate-host")
	f.hostPhase(t, PhaseStaged)
	if asked, err := f.again(t); asked || err == nil || !strings.Contains(err.Error(), "not activated") || f.reboots != 0 {
		t.Fatalf("asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
	// The journal says pending (written before the boot entries are selected), the child says it failed.
	f = newOwedRebootFixture(t, "activate-host")
	f.result(t, CoreActionObservation{State: "unknown", Stage: "execute", Code: "native_action_failed", EffectState: "started", Evidence: coreRunnerEffectEvidence + ": " + coreHostActivationFailed})
	f.age(t)
	if asked, err := f.again(t); asked || err == nil || !strings.Contains(err.Error(), "not activated") || f.reboots != 0 {
		t.Fatalf("a failed activation: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
	// A restart request that failed after a complete activation is asked for again.
	f = newOwedRebootFixture(t, "activate-host")
	f.result(t, CoreActionObservation{State: "unknown", Stage: "execute", Code: "native_action_failed", EffectState: "started", Evidence: coreRunnerEffectEvidence + ": Failed to connect to bus"})
	f.age(t)
	if asked, err := f.again(t); !asked || err != nil || f.reboots != 1 {
		t.Fatalf("a failed restart request: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
	// The coordinator was lost before it asked for a child at all.
	f = newOwedRebootFixture(t, "activate-host")
	f.hostPhase(t, PhaseStaged)
	base := f.runtime.Runner.path(f.journal, f.step)
	for _, name := range []string{base, base + ".result"} {
		if err := os.Remove(name); err != nil {
			t.Fatal(err)
		}
	}
	if asked, err := f.again(t); asked || err == nil || f.reboots != 0 {
		t.Fatalf("never launched: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
}

// A restart that cannot even be requested is an error for the same recovery.
func TestCoreRebootAgainReportsARequestThatFails(t *testing.T) {
	f := newOwedRebootFixture(t, "activate-host")
	f.rebootErr = fmt.Errorf("Failed to connect to bus")
	if asked, err := f.again(t); asked || err == nil || !strings.Contains(err.Error(), "cannot be requested") || f.reboots != 1 {
		t.Fatalf("asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
}

// recovery-host on the new slot selected the previous slot and asked for the
// restart: both are repeated, as often as it takes (a recovery has nothing to
// fall back to). A record in another state is left alone.
func TestCoreRebootAgainRepeatsTheRecoveryRestart(t *testing.T) {
	f := newOwedRebootFixture(t, "recovery-host")
	var runs [][]string
	f.runtime.Host.config.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		runs = append(runs, append([]string{name}, args...))
		return nil, nil
	}
	record := func(state string) {
		t.Helper()
		raw, _ := json.Marshal(coreHostRecovery{Schema: "youeye.core-host-recovery.v1", RequestID: f.journal.RequestID, ManifestSHA256: f.journal.ManifestSHA256, PreviousSHA256: f.journal.Previous.ManifestSHA256, ActiveSlot: "A", CandidateSlot: "B", State: state})
		path := filepath.Join(f.runtime.Root, "host-recovery", checksum([]byte(f.journal.RequestID))+".json")
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := atomicWrite(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	record("prepared")
	if asked, err := f.again(t); asked || err != nil || len(runs) != 0 {
		t.Fatalf("a record that asked for nothing: %v %v %v", asked, err, runs)
	}
	record("reboot-requested")
	for request := 1; request <= coreOwedRebootRequests+2; request++ {
		f.age(t)
		runs = nil
		asked, err := f.again(t)
		want := "[[bootctl set-default youeye-system-a.conf] [bootctl set-oneshot youeye-system-a.conf] [systemctl --no-block reboot]]"
		if !asked || err != nil || fmt.Sprint(runs) != want {
			t.Fatalf("request %d: asked=%v err=%v runs=%v", request, asked, err, runs)
		}
	}
}

// ChildState calls a child that left any last word "gone"; ChildSucceeded tells the good word from the others.
func TestCoreChildSucceededReadsTheLastWord(t *testing.T) {
	f := newOwedRebootFixture(t, "activate-host")
	ctx := context.Background()
	if f.runtime.Runner.ChildSucceeded(ctx, f.journal, f.step) {
		t.Fatal("an unknown outcome counted as success")
	}
	f.result(t, CoreActionObservation{State: "succeeded", Evidence: "fixture"})
	if !f.runtime.Runner.ChildSucceeded(ctx, f.journal, f.step) || f.runtime.Runner.ChildState(ctx, f.journal, f.step) != CoreChildGone {
		t.Fatal("a child that succeeded was not recognised")
	}
	f.result(t, CoreActionObservation{State: "failed", Evidence: "fixture"})
	if f.runtime.Runner.ChildSucceeded(ctx, f.journal, f.step) {
		t.Fatal("a failed child counted as success")
	}
	if err := os.Remove(f.runtime.Runner.path(f.journal, f.step) + ".result"); err != nil {
		t.Fatal(err)
	}
	if f.runtime.Runner.ChildSucceeded(ctx, f.journal, f.step) {
		t.Fatal("no last word counted as success")
	}
}

// The child of activate-host was killed without a last word and left processes in its unit. They are waited for,
// then the step is judged like one whose child is gone. Until 0.6.15 it never was: every continuation the watchdog
// started ended without doing anything and the box stayed held.
func TestCoreRebootAgainJudgesAStepWhoseChildLeftProcessesBehind(t *testing.T) {
	f := newOwedRebootFixture(t, "activate-host")
	if err := os.Remove(f.runtime.Runner.path(f.journal, f.step) + ".result"); err != nil {
		t.Fatal(err)
	}
	f.runtime.Runner.CgroupRoot = t.TempDir()
	group := filepath.Join(f.runtime.Runner.CgroupRoot, "system.slice", f.runtime.Runner.unit(f.journal, f.step))
	if err := os.MkdirAll(group, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(group, "cgroup.events"), []byte("populated 1\nfrozen 0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	show := f.runtime.Runner.Capture
	f.runtime.Runner.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "systemctl" && len(args) > 0 && args[0] == "show" {
			return []byte("Id=" + args[len(args)-1] + "\nLoadState=not-found\n"), nil
		}
		return show(ctx, program, args...)
	}
	if state := f.runtime.Runner.ChildState(context.Background(), f.journal, f.step); state != CoreChildLingering {
		t.Fatalf("the fixture's child is %q, not lingering", state)
	}
	// Launched two minutes ago (the fixture's age): the processes are waited for.
	if asked, err := f.again(t); asked || err != nil || f.reboots != 0 {
		t.Fatalf("judged while the processes were waited for: %v %v %d", asked, err, f.reboots)
	}
	old := time.Now().Add(-2 * coreOwedLingeringWait)
	if err := os.Chtimes(f.runtime.Runner.path(f.journal, f.step), old, old); err != nil {
		t.Fatal(err)
	}
	// The host update is pending in this boot: the restart is asked for (it ends what is left).
	if asked, err := f.again(t); !asked || err != nil || f.reboots != 1 {
		t.Fatalf("not judged after the wait: %v %v %d", asked, err, f.reboots)
	}
}

// lingeringOwedRebootFixture is a host step whose child left no last word and processes in its unit.
func lingeringOwedRebootFixture(t *testing.T, name string) *owedRebootFixture {
	t.Helper()
	f := newOwedRebootFixture(t, name)
	if err := os.Remove(f.runtime.Runner.path(f.journal, f.step) + ".result"); err != nil {
		t.Fatal(err)
	}
	f.runtime.Runner.CgroupRoot = t.TempDir()
	group := filepath.Join(f.runtime.Runner.CgroupRoot, "system.slice", f.runtime.Runner.unit(f.journal, f.step))
	if err := os.MkdirAll(group, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(group, "cgroup.events"), []byte("populated 1\nfrozen 0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	show := f.runtime.Runner.Capture
	f.runtime.Runner.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "systemctl" && len(args) > 0 && args[0] == "show" {
			return []byte("Id=" + args[len(args)-1] + "\nLoadState=not-found\n"), nil
		}
		return show(ctx, program, args...)
	}
	if state := f.runtime.Runner.ChildState(context.Background(), f.journal, f.step); state != CoreChildLingering {
		t.Fatalf("the fixture's child is %q, not lingering", state)
	}
	return f
}

// launched sets the time of the child's launch record.
func (f *owedRebootFixture) launched(t *testing.T, at time.Time) {
	t.Helper()
	if err := os.Chtimes(f.runtime.Runner.path(f.journal, f.step), at, at); err != nil {
		t.Fatal(err)
	}
}

// requested sets the time of the last request RebootAgain made.
func (f *owedRebootFixture) requested(t *testing.T, at time.Time) {
	t.Helper()
	if err := os.Chtimes(f.runtime.Runner.path(f.journal, f.step)+".reboots", at, at); err != nil {
		t.Fatal(err)
	}
}

// The wait for the processes a child left counts from the child, not from the last request: after the first
// request the second comes coreOwedRebootWait later, and then the update is given up. Until 0.6.15 every request
// started the 30 minutes again, and a box whose restart did not come was held for hours before it was restored.
func TestCoreRebootAgainCountsOutAStepWithLingeringProcesses(t *testing.T) {
	f := lingeringOwedRebootFixture(t, "activate-host")
	f.launched(t, time.Now().Add(-coreOwedLingeringWait-time.Minute))
	for request := 1; request <= coreOwedRebootRequests; request++ {
		if asked, err := f.again(t); !asked || err != nil || f.reboots != request {
			t.Fatalf("request %d: asked=%v err=%v reboots=%d", request, asked, err, f.reboots)
		}
		// Not again right after the request.
		if asked, err := f.again(t); asked || err != nil || f.reboots != request {
			t.Fatalf("asked twice within the wait: %v %v %d", asked, err, f.reboots)
		}
		// The next look that counts comes after coreOwedRebootWait, far less than the lingering wait.
		f.requested(t, time.Now().Add(-coreOwedRebootWait-time.Second))
	}
	if asked, err := f.again(t); asked || err == nil || !strings.Contains(err.Error(), "did not happen") || f.reboots != coreOwedRebootRequests {
		t.Fatalf("not given up: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
}

// A launch record from the future is a clock that was set back. It does not end the wait (the processes may be the
// activation, still at work) and the wait does not last for as long as the clock was set back either: it begins
// anew, from now.
func TestCoreRebootAgainBeginsTheLingeringWaitAnewOnAClockThatWasSetBack(t *testing.T) {
	f := lingeringOwedRebootFixture(t, "activate-host")
	f.launched(t, time.Now().Add(24*time.Hour))
	for look := 0; look < 2; look++ {
		if asked, err := f.again(t); asked || err != nil || f.reboots != 0 {
			t.Fatalf("a time in the future counted as waited: asked=%v err=%v reboots=%d", asked, err, f.reboots)
		}
	}
	info, err := os.Lstat(f.runtime.Runner.path(f.journal, f.step))
	if err != nil || info.ModTime().After(time.Now()) || time.Since(info.ModTime()) > time.Minute {
		t.Fatalf("the wait did not begin anew from now: %v %v", info.ModTime(), err)
	}
	f.launched(t, time.Now().Add(-coreOwedLingeringWait-time.Minute))
	if asked, err := f.again(t); !asked || err != nil || f.reboots != 1 {
		t.Fatalf("not judged after the wait: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
}

// Between requests only the time of the last request counts. A child's time that a clock set back puts in the
// future let every look ask again, and the update was counted out within seconds. A request's own time in the
// future begins the wait anew.
func TestCoreRebootAgainKeepsTheWaitBetweenRequestsOnAClockThatWasSetBack(t *testing.T) {
	f := newOwedRebootFixture(t, "activate-host")
	if asked, err := f.again(t); !asked || err != nil || f.reboots != 1 {
		t.Fatalf("first request: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
	f.launched(t, time.Now().Add(24*time.Hour))
	if asked, err := f.again(t); asked || err != nil || f.reboots != 1 {
		t.Fatalf("asked again right after a request: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
	f.requested(t, time.Now().Add(24*time.Hour))
	for look := 0; look < 2; look++ {
		if asked, err := f.again(t); asked || err != nil || f.reboots != 1 {
			t.Fatalf("a request in the future counted as waited: asked=%v err=%v reboots=%d", asked, err, f.reboots)
		}
	}
	f.requested(t, time.Now().Add(-coreOwedRebootWait-time.Second))
	if asked, err := f.again(t); !asked || err != nil || f.reboots != 2 {
		t.Fatalf("second request: asked=%v err=%v reboots=%d", asked, err, f.reboots)
	}
}

// A host update that is not pending is given up under lingering processes too, after they were waited for and
// not before (the activation may be what still runs).
func TestCoreRebootAgainGivesUpAnActivationWithLingeringProcessesThatIsNotPending(t *testing.T) {
	f := lingeringOwedRebootFixture(t, "activate-host")
	f.hostPhase(t, PhaseStaged)
	if asked, err := f.again(t); asked || err != nil || f.reboots != 0 {
		t.Fatalf("judged while the processes were waited for: %v %v %d", asked, err, f.reboots)
	}
	f.launched(t, time.Now().Add(-coreOwedLingeringWait-time.Minute))
	for look := 0; look < 2; look++ {
		if asked, err := f.again(t); asked || err == nil || !strings.Contains(err.Error(), "not activated") || f.reboots != 0 {
			t.Fatalf("look %d: asked=%v err=%v reboots=%d", look, asked, err, f.reboots)
		}
	}
}

// recovery-host with processes left behind: they are waited for once, then the restart into the previous slot is
// repeated every coreOwedRebootWait, without a count.
func TestCoreRebootAgainRepeatsTheRecoveryRestartUnderLingeringProcesses(t *testing.T) {
	f := lingeringOwedRebootFixture(t, "recovery-host")
	runs := 0
	f.runtime.Host.config.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name == "systemctl" {
			runs++
		}
		return nil, nil
	}
	raw, _ := json.Marshal(coreHostRecovery{Schema: "youeye.core-host-recovery.v1", RequestID: f.journal.RequestID, ManifestSHA256: f.journal.ManifestSHA256, PreviousSHA256: f.journal.Previous.ManifestSHA256, ActiveSlot: "A", CandidateSlot: "B", State: "reboot-requested"})
	path := filepath.Join(f.runtime.Root, "host-recovery", checksum([]byte(f.journal.RequestID))+".json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := atomicWrite(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if asked, err := f.again(t); asked || err != nil || runs != 0 {
		t.Fatalf("judged while the processes were waited for: %v %v %d", asked, err, runs)
	}
	f.launched(t, time.Now().Add(-coreOwedLingeringWait-time.Minute))
	for request := 1; request <= coreOwedRebootRequests+2; request++ {
		if asked, err := f.again(t); !asked || err != nil || runs != request {
			t.Fatalf("request %d: asked=%v err=%v runs=%d", request, asked, err, runs)
		}
		if asked, err := f.again(t); asked || err != nil || runs != request {
			t.Fatalf("asked twice within the wait: %v %v %d", asked, err, runs)
		}
		f.requested(t, time.Now().Add(-coreOwedRebootWait-time.Second))
	}
}
