package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var watchdogChanged = time.Date(2026, 11, 18, 20, 0, 0, 0, time.UTC)

type watchdogStarts struct {
	calls [][2]string
	err   error
}

func (s *watchdogStarts) start(_ context.Context, request, command string) (CoreControlObservation, error) {
	s.calls = append(s.calls, [2]string{request, command})
	return CoreControlObservation{RequestID: request, CommandID: command, State: "running"}, s.err
}

// watchdogAt sets the watchdog's clock to watchdogChanged plus d.
func watchdogAt(w *CoreContinuationWatchdog, d time.Duration) {
	w.Now = func() time.Time { return watchdogChanged.Add(d) }
}

// watchdogQuiet: the watchdog starts nothing at any of these times.
func watchdogQuiet(t *testing.T, w *CoreContinuationWatchdog, starts *watchdogStarts, what string, at ...time.Duration) {
	t.Helper()
	before := len(starts.calls)
	for _, d := range at {
		watchdogAt(w, d)
		if command, err := w.Check(context.Background()); command != "" || err != nil || len(starts.calls) != before {
			t.Fatalf("%s: the watchdog acted at %s: %q %v %v", what, d, command, err, starts.calls)
		}
	}
}

// lostContinuationFixture: the request as the hand-over leaves it when the new
// continuation died at once: a held service update between two steps, its
// journal last written at watchdogChanged. The watchdog belongs to an API
// service that started a minute before that, while the request was only
// prepared. It saw the lost state when it was written and looks again six
// minutes later, with no System update command running.
func lostContinuationFixture(t *testing.T) (CoreManager, CoreJournal, *CoreContinuationWatchdog, *watchdogStarts) {
	t.Helper()
	m, e, target := coreJournalFixture(t)
	m.Now = func() time.Time { return watchdogChanged.Add(-time.Minute) }
	before := prepareCoreFixture(t, m, spineChangingTarget(target))
	starts := &watchdogStarts{}
	w := &CoreContinuationWatchdog{Root: m.Root, Lifecycle: filepath.Join(t.TempDir(), "state", "app-updates"), Idle: 5 * time.Minute,
		Coordinating: func() (bool, error) { return false, nil },
		Start:        starts.start}
	watchdogQuiet(t, w, starts, "the look at the start of the API service", -time.Minute)
	m.Now = func() time.Time { return watchdogChanged }
	m.YieldAfterSpine = true
	j, err := m.Advance(context.Background(), before.RequestID, false)
	if err != nil || !CoreSpineJustApplied(before, j) || e.starts["apply-cp"] != 0 {
		t.Fatalf("fixture did not stop after the Spine step: %s %v %v", j.Phase, journalStepStates(j), err)
	}
	watchdogQuiet(t, w, starts, "the first look at the lost state", 0)
	watchdogAt(w, 6*time.Minute)
	return m, j, w, starts
}

// The new continuation died right after the hand-over: its continuation is
// started again, once for that death.
func TestCoreWatchdogRestartsALostContinuationOnce(t *testing.T) {
	m, j, w, starts := lostContinuationFixture(t)
	before := coreTreeSnapshot(t, m.Root)
	command, err := w.Check(context.Background())
	if err != nil || len(starts.calls) != 1 || starts.calls[0] != [2]string{j.RequestID, command} || w.Why() != coreWatchdogBetweenSteps {
		t.Fatalf("lost continuation: command=%q calls=%v err=%v why=%q", command, starts.calls, err, w.Why())
	}
	if !strings.HasPrefix(command, "watchdog-") || len(command) != 41 || !coreRequestPattern.MatchString(command) {
		t.Fatalf("command ID %q", command)
	}
	// The watchdog itself writes nothing; the runner does.
	if after := coreTreeSnapshot(t, m.Root); !reflect.DeepEqual(before, after) {
		t.Fatal("the watchdog changed the state directory itself")
	}
	// The same death, however often it looks and however long it lasts.
	watchdogQuiet(t, w, starts, "the same death", 7*time.Minute, time.Hour, 48*time.Hour)
	// A failed start is not repeated either.
	_, _, w, starts = lostContinuationFixture(t)
	starts.err = fmt.Errorf("continuation acknowledgement unavailable")
	if command, err := w.Check(context.Background()); command == "" || err == nil {
		t.Fatalf("failed start: %q %v", command, err)
	}
	if again, _ := w.Check(context.Background()); again != "" || len(starts.calls) != 1 {
		t.Fatalf("a failed start was repeated: %v", starts.calls)
	}
}

// Through the API's own runner: one unit for one death, even when the API
// service (and with it the watchdog's memory) is new; and the unit runs
// `update core resume` of the request.
func TestCoreWatchdogLaunchesOneContinuationUnitPerJournalState(t *testing.T) {
	m, j, w, _ := lostContinuationFixture(t)
	var launches [][]string
	units := map[string]bool{}
	runner := CoreControlRunner{Root: m.Root, Executable: "/usr/local/bin/youeye"}
	runner.Capture = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name == "systemd-run" {
			launches = append(launches, args)
			for _, arg := range args {
				if strings.HasPrefix(arg, "--unit=") {
					units[strings.TrimPrefix(arg, "--unit=")] = true
				}
			}
			return nil, nil
		}
		unit := args[len(args)-1]
		if !units[unit] {
			return []byte("Id=" + unit + "\nLoadState=not-found\n"), nil
		}
		// The restarted continuation died again without writing: its unit has failed.
		return []byte("Id=" + unit + "\nLoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nMainPID=0\nDescription=YouEye core continuation " + unit + "\nTransient=yes\nType=exec\nUser=root\nWorkingDirectory=/\nRootDirectory=\nRootImage=\nKillMode=control-group\nRestart=no\nRemainAfterExit=yes\n"), nil
	}
	w.Start = runner.Start
	first, err := w.Check(context.Background())
	if err != nil || first == "" || len(launches) != 1 {
		t.Fatalf("first look: %q %v %v", first, err, launches)
	}
	tail := launches[0][len(launches[0])-6:]
	if !reflect.DeepEqual(tail, []string{"/usr/local/bin/youeye", "update", "core", "resume", "--request", j.RequestID}) {
		t.Fatalf("the unit runs %v", tail)
	}
	// A watchdog without that memory over the same journal state (for the sake of the test: a restarted API
	// service leaves this state alone, below): the same command ID, which the runner's retained receipt refuses
	// to launch a second time.
	fresh := &CoreContinuationWatchdog{Root: w.Root, Lifecycle: w.Lifecycle, Idle: w.Idle, Coordinating: w.Coordinating, Start: runner.Start, looked: true}
	watchdogAt(fresh, 6*time.Minute)
	if command, err := fresh.Check(context.Background()); command != "" || err != nil {
		t.Fatalf("acted on a state it saw for the first time: %q %v", command, err)
	}
	watchdogAt(fresh, 12*time.Minute)
	second, err := fresh.Check(context.Background())
	if err != nil || second != first || len(launches) != 1 {
		t.Fatalf("a second launch for the same death: %q/%q %v launches=%d", first, second, err, len(launches))
	}
	// In fact a restarted API service does not even ask: the journal state was there when it started.
	restarted := &CoreContinuationWatchdog{Root: w.Root, Lifecycle: w.Lifecycle, Idle: w.Idle, Coordinating: w.Coordinating, Start: runner.Start}
	for _, d := range []time.Duration{6 * time.Minute, 12 * time.Minute, 48 * time.Hour} {
		watchdogAt(restarted, d)
		if command, err := restarted.Check(context.Background()); command != "" || err != nil || len(launches) != 1 {
			t.Fatalf("a restarted API service acted on the journal state it found: %q %v", command, err)
		}
	}
	// The continuation moved the request on and was lost again later: a new death, one more start.
	m.Now = func() time.Time { return watchdogChanged.Add(10 * time.Minute) }
	current, err := m.Read()
	if err != nil {
		t.Fatal(err)
	}
	current.Steps[3].State, current.Steps[3].Evidence = "succeeded", "fixture apply-cp"
	if err := m.saveCore(&current); err != nil {
		t.Fatal(err)
	}
	for _, d := range []time.Duration{11 * time.Minute, 15 * time.Minute} {
		watchdogAt(w, d)
		if command, _ := w.Check(context.Background()); command != "" {
			t.Fatal("acted before the new state had waited long enough")
		}
	}
	watchdogAt(w, 16*time.Minute)
	third, err := w.Check(context.Background())
	if err != nil || third == "" || third == first || len(launches) != 2 {
		t.Fatalf("a later death: %q %v launches=%d", third, err, len(launches))
	}
	// The restarted API service picks that one up too: it is not the state it found.
	for _, d := range []time.Duration{50 * time.Hour, 50*time.Hour + 4*time.Minute} {
		watchdogAt(restarted, d)
		if command, _ := restarted.Check(context.Background()); command != "" {
			t.Fatal("acted before the new state had waited long enough")
		}
	}
	watchdogAt(restarted, 50*time.Hour+5*time.Minute)
	if command, err := restarted.Check(context.Background()); err != nil || command != third || len(launches) != 2 {
		t.Fatalf("the later death, seen by the restarted service: %q/%q %v launches=%d", third, command, err, len(launches))
	}
}

// Never while anything coordinates or runs, never too early.
func TestCoreWatchdogWaitsWhileAnythingIsAtWork(t *testing.T) {
	cases := map[string]func(*testing.T, CoreManager, *CoreContinuationWatchdog){
		"a System update command is running": func(_ *testing.T, _ CoreManager, w *CoreContinuationWatchdog) {
			w.Coordinating = func() (bool, error) { return true, nil }
		},
		"the processes cannot be listed": func(_ *testing.T, _ CoreManager, w *CoreContinuationWatchdog) {
			w.Coordinating = func() (bool, error) { return false, fmt.Errorf("proc unavailable") }
		},
		"the watchdog has seen this state for less than five minutes": func(_ *testing.T, _ CoreManager, w *CoreContinuationWatchdog) {
			watchdogAt(w, 5*time.Minute-time.Second)
		},
		"the journal changed since the last look, however old it says it is": func(t *testing.T, m CoreManager, _ *CoreContinuationWatchdog) {
			m.Now = func() time.Time { return watchdogChanged.Add(-24 * time.Hour) }
			current, err := m.Read()
			if err != nil {
				t.Fatal(err)
			}
			if err := m.saveCore(&current); err != nil {
				t.Fatal(err)
			}
		},
		"the journal moved while the processes were listed": func(t *testing.T, m CoreManager, w *CoreContinuationWatchdog) {
			w.Coordinating = func() (bool, error) {
				m.Now = func() time.Time { return watchdogChanged.Add(5*time.Minute + 30*time.Second) }
				current, err := m.Read()
				if err != nil {
					t.Fatal(err)
				}
				if err := m.saveCore(&current); err != nil {
					t.Fatal(err)
				}
				return false, nil
			}
		},
		"no request": func(t *testing.T, m CoreManager, _ *CoreContinuationWatchdog) {
			if err := os.Remove(filepath.Join(m.Root, "journal.json")); err != nil {
				t.Fatal(err)
			}
		},
		"an unreadable journal": func(t *testing.T, m CoreManager, _ *CoreContinuationWatchdog) {
			if err := os.WriteFile(filepath.Join(m.Root, "journal.json"), []byte("{}\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, arrange := range cases {
		t.Run(name, func(t *testing.T) {
			m, _, w, starts := lostContinuationFixture(t)
			arrange(t, m, w)
			if command, err := w.Check(context.Background()); command != "" || err != nil || len(starts.calls) != 0 {
				t.Fatalf("the watchdog acted: %q %v %v", command, err, starts.calls)
			}
		})
	}
	// Waiting is not remembered as acting: when the coordinator is gone later, the request is picked up.
	_, _, w, starts := lostContinuationFixture(t)
	w.Coordinating = func() (bool, error) { return true, nil }
	if command, _ := w.Check(context.Background()); command != "" {
		t.Fatal("acted beside a running command")
	}
	w.Coordinating = func() (bool, error) { return false, nil }
	if command, err := w.Check(context.Background()); command == "" || err != nil || len(starts.calls) != 1 {
		t.Fatalf("not picked up after the coordinator was gone: %q %v", command, err)
	}
	for name, unconfigured := range map[string]*CoreContinuationWatchdog{
		"nothing set":            {Root: w.Root},
		"no lifecycle directory": {Root: w.Root, Idle: w.Idle, Coordinating: w.Coordinating, Start: w.Start},
		"a relative root":        {Root: "core-update", Lifecycle: w.Lifecycle, Idle: w.Idle, Coordinating: w.Coordinating, Start: w.Start},
	} {
		if _, err := unconfigured.Check(context.Background()); err == nil {
			t.Fatalf("an unconfigured watchdog looked (%s)", name)
		}
	}
}

// A step that runs for hours: its coordinator is alive, and even when no
// System update process can be seen, a started step is settled by observing
// it, never by the watchdog.
func TestCoreWatchdogLeavesALongRunningStepAlone(t *testing.T) {
	m, j, w, starts := lostContinuationFixture(t)
	m.Now = func() time.Time { return watchdogChanged.Add(7 * time.Minute) }
	j.Steps[3].State = "started"
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Read(); err != nil {
		t.Fatal(err)
	}
	w.Coordinating = func() (bool, error) { return true, nil }
	watchdogQuiet(t, w, starts, "a step runs and its coordinator is alive", 8*time.Minute, 14*time.Minute, 3*time.Hour)
	w.Coordinating = func() (bool, error) { return false, nil }
	watchdogQuiet(t, w, starts, "a step is started and no command is seen", 3*time.Hour+time.Minute, 4*time.Hour, 48*time.Hour)
}

// The journal state that was there when the API service started belongs to the
// boot path, whatever the clocks say. Here the box booted with its clock
// behind the journal's last write (no RTC battery) and NTP corrected it a
// minute later: the boot unit, which waits for Incus, has not started yet, so
// no `update core` command runs.
func TestCoreWatchdogLeavesTheStateFoundAtStartToTheBootPath(t *testing.T) {
	behind := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC).Sub(watchdogChanged)
	arrange := map[string]func(*testing.T, CoreManager, CoreJournal, *CoreContinuationWatchdog){
		"a held service update between two steps": func(*testing.T, CoreManager, CoreJournal, *CoreContinuationWatchdog) {},
		"a committed request that was not released": func(t *testing.T, m CoreManager, j CoreJournal, w *CoreContinuationWatchdog) {
			finishHeldFixture(t, m, j, w, "committed", "", watchdogChanged)
		},
	}
	for name, arrange := range arrange {
		t.Run(name, func(t *testing.T) {
			m, j, w, starts := lostContinuationFixture(t)
			arrange(t, m, j, w)
			booted := &CoreContinuationWatchdog{Root: w.Root, Lifecycle: w.Lifecycle, Idle: w.Idle, Coordinating: w.Coordinating, Start: starts.start}
			watchdogQuiet(t, booted, starts, "a state from before the boot", behind, 10*time.Minute, 16*time.Minute, time.Hour, 48*time.Hour)
		})
	}
	// The boot unit continued the request and was lost later: that state is the watchdog's.
	m, j, w, starts := lostContinuationFixture(t)
	booted := &CoreContinuationWatchdog{Root: w.Root, Lifecycle: w.Lifecycle, Idle: w.Idle, Coordinating: w.Coordinating, Start: starts.start}
	watchdogQuiet(t, booted, starts, "a state from before the boot", behind, 10*time.Minute)
	m.Now = func() time.Time { return watchdogChanged.Add(11 * time.Minute) }
	j.Steps[3].State, j.Steps[3].Evidence = "succeeded", "fixture apply-cp"
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	watchdogQuiet(t, booted, starts, "a new state", 12*time.Minute, 16*time.Minute)
	watchdogAt(booted, 17*time.Minute)
	if command, err := booted.Check(context.Background()); command == "" || err != nil || len(starts.calls) != 1 {
		t.Fatalf("a continuation lost after the boot was not started again: %q %v", command, err)
	}
}

// What "found at start" means when the first look finds no request, or cannot
// read the one that is there.
func TestCoreWatchdogFirstLook(t *testing.T) {
	// No request when the API service started: the first request is watched from its first state on.
	m, _, target := coreJournalFixture(t)
	starts := &watchdogStarts{}
	w := &CoreContinuationWatchdog{Root: m.Root, Lifecycle: filepath.Join(t.TempDir(), "state", "app-updates"), Idle: 5 * time.Minute,
		Coordinating: func() (bool, error) { return false, nil }, Start: starts.start}
	watchdogQuiet(t, w, starts, "no request", -time.Hour)
	m.Now = func() time.Time { return watchdogChanged }
	before := prepareCoreFixture(t, m, spineChangingTarget(target))
	m.YieldAfterSpine = true
	if j, err := m.Advance(context.Background(), before.RequestID, false); err != nil || !coreContinuationLost(j) {
		t.Fatal(j.Phase, err)
	}
	watchdogQuiet(t, w, starts, "the first sight of the request", time.Minute, 5*time.Minute)
	watchdogAt(w, 6*time.Minute)
	if command, err := w.Check(context.Background()); command == "" || err != nil {
		t.Fatalf("a request that began under this API service was not picked up: %q %v", command, err)
	}

	// An unreadable journal at the start says nothing. The first state that can be read is taken as the one
	// that was there.
	m, j, lost, starts := lostContinuationFixture(t)
	raw, err := os.ReadFile(filepath.Join(m.Root, "journal.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.Root, "journal.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	w = &CoreContinuationWatchdog{Root: lost.Root, Lifecycle: lost.Lifecycle, Idle: lost.Idle, Coordinating: lost.Coordinating, Start: starts.start}
	watchdogQuiet(t, w, starts, "an unreadable journal", 0, time.Minute)
	if err := os.WriteFile(filepath.Join(m.Root, "journal.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if current, err := m.Read(); err != nil || current.UpdatedAt != j.UpdatedAt {
		t.Fatal(err)
	}
	watchdogQuiet(t, w, starts, "the first readable state", 2*time.Minute, 8*time.Minute, 48*time.Hour)
}

// The wait is the watchdog's own: the journal's change time is never read as
// a time. A clock that was ahead when the journal was written and was then set
// back does not keep the watchdog silent for the size of the step.
func TestCoreWatchdogWaitsByItsOwnLooks(t *testing.T) {
	m, j, w, starts := lostContinuationFixture(t)
	m.Now = func() time.Time { return watchdogChanged.Add(90 * 24 * time.Hour) }
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	watchdogQuiet(t, w, starts, "a new state", 7*time.Minute, 11*time.Minute)
	watchdogAt(w, 12*time.Minute)
	if command, err := w.Check(context.Background()); command == "" || err != nil || len(starts.calls) != 1 {
		t.Fatalf("a journal dated ahead of the clock kept the watchdog silent: %q %v", command, err)
	}
	// Without a test clock the wait is measured on the monotonic clock.
	w.Now = nil
	if _, err := w.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// Only a held service update that waits between two steps, or a finished
// request with its holds in place (the tests below). Never a request that
// needs recovery, is recovering, was only prepared, waits for a restart, has a
// started or failed step, or has not reached its checkpoint; and never one
// that has ended and holds nothing.
func TestCoreWatchdogActsOnlyOnAHeldServiceUpdateBetweenSteps(t *testing.T) {
	m, j, w, starts := lostContinuationFixture(t)
	if !coreContinuationLost(j) {
		t.Fatalf("the hand-over state is not recognised: %s %v", j.Phase, journalStepStates(j))
	}
	change := func(edit func(*CoreJournal)) CoreJournal {
		c := j
		c.Steps = append([]CoreStep(nil), j.Steps...)
		edit(&c)
		return c
	}
	succeed := func(c *CoreJournal) {
		for i := range c.Steps {
			c.Steps[i].State, c.Steps[i].Evidence = "succeeded", "fixture"
		}
	}
	// Still between steps, only later: the last step is done and the commit pass is missing.
	if !coreContinuationLost(change(succeed)) || !coreContinuationLost(change(func(c *CoreJournal) { c.Steps[3].State, c.Steps[3].Evidence = "succeeded", "fixture" })) {
		t.Fatal("a later point between two steps is not recognised")
	}
	refused := map[string]CoreJournal{
		"prepared":         change(func(c *CoreJournal) { c.Phase = "prepared" }),
		"needs-recovery":   change(func(c *CoreJournal) { c.Phase, c.Steps[3].State = "needs-recovery", "failed" }),
		"recovering":       change(func(c *CoreJournal) { c.Phase = "recovering" }),
		"rolled-back":      change(func(c *CoreJournal) { c.Phase = "rolled-back" }),
		"cancelling":       change(func(c *CoreJournal) { c.Phase = "cancelling" }),
		"cancelled":        change(func(c *CoreJournal) { c.Phase = "cancelled" }),
		"committed":        change(func(c *CoreJournal) { succeed(c); c.Phase = "committed" }),
		"awaiting-restart": change(func(c *CoreJournal) { c.Phase = "awaiting-restart" }),
		"a recovery graph": change(func(c *CoreJournal) {
			c.RecoverySteps = []CoreStep{{Name: "recovery-fence", RequestID: c.RequestID + "/recovery-fence", State: "pending"}}
		}),
		"an update with a restart": change(func(c *CoreJournal) { c.RestartRequired = true }),
		"a started step":           change(func(c *CoreJournal) { c.Steps[3].State = "started" }),
		"a failed step":            change(func(c *CoreJournal) { c.Steps[3].State = "failed" }),
		"the checkpoint is started": change(func(c *CoreJournal) {
			for i := 1; i < len(c.Steps); i++ {
				c.Steps[i].State, c.Steps[i].Evidence = "pending", ""
			}
			c.Steps[1].State = "started"
		}),
		"before the checkpoint (the Control Panel is up)": change(func(c *CoreJournal) {
			for i := 1; i < len(c.Steps); i++ {
				c.Steps[i].State, c.Steps[i].Evidence = "pending", ""
			}
		}),
	}
	for name, c := range refused {
		if coreContinuationLost(c) {
			t.Errorf("%s counted as a lost continuation", name)
		}
	}
	// From the journal on disk, for the states the journal's own validation accepts.
	for _, name := range []string{"needs-recovery", "cancelled", "a started step", "a failed step", "before the checkpoint (the Control Panel is up)", "the checkpoint is started", "committed", "prepared"} {
		c := refused[name]
		if err := m.saveCore(&c); err != nil {
			t.Fatal(name, err)
		}
		if _, err := m.Read(); err != nil {
			t.Fatalf("%s: the fixture journal is not valid: %v", name, err)
		}
		if command, err := w.Check(context.Background()); command != "" || err != nil || len(starts.calls) != 0 {
			t.Fatalf("%s: the watchdog acted: %q %v", name, command, err)
		}
	}
}

// The coordinator's own admission ran out of time before it launched the
// checkpoint: the request stays open (`applying`, the checkpoint step started,
// a retryable receipt), nothing is reserved, closed or stopped, and the
// Control Panel is up and offers to retry. The owner decides; the watchdog
// never does.
func TestCoreWatchdogLeavesAnAdmissionThatTimedOutToTheOwner(t *testing.T) {
	f, b, e, m := admissionRunnerFixture(t)
	m.Now = func() time.Time { return watchdogChanged.Add(-time.Minute) }
	for i := range f.journal.Steps {
		if f.journal.Steps[i].Name == "checkpoint" {
			f.journal.Steps[i].State = "pending"
		}
	}
	if err := m.saveCore(&f.journal); err != nil {
		t.Fatal(err)
	}
	starts := &watchdogStarts{}
	w := &CoreContinuationWatchdog{Root: m.Root, Lifecycle: b.Root, Idle: 5 * time.Minute, Coordinating: func() (bool, error) { return false, nil }, Start: starts.start}
	watchdogQuiet(t, w, starts, "the look at the start of the API service", -time.Minute)
	release, err := b.AdmitOrdinary() // other work holds the lifecycle lock for longer than the admission waits
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	m.Now = func() time.Time { return watchdogChanged }
	j, err := m.Advance(ctx, f.journal.RequestID, false)
	release()
	if err != nil || j.Phase != "applying" || f.starts != 0 || coreContinuationLost(j) || coreReleaseLost(w.Root, w.Lifecycle, j) {
		t.Fatalf("admission that timed out: phase=%s launched=%d err=%v", j.Phase, f.starts, err)
	}
	if observed, err := e.Observe(context.Background(), j, f.step); err != nil || observed.State != "retryable" || observed.Code != "admission_timeout" || observed.EffectState != "not-started" {
		t.Fatal(observed, err)
	}
	if _, err := b.Read(); !os.IsNotExist(err) {
		t.Fatal("the admission that timed out reserved the lifecycle", err)
	}
	watchdogQuiet(t, w, starts, "an admission that timed out", 0, 6*time.Minute, time.Hour, 48*time.Hour)
}

// finishHeldFixture ends the fixture request in phase (committed or
// rolled-back) at the given time and leaves what a release that did not finish
// leaves: the lifecycle reservation of the request and its checkpoint record
// in completion state. It returns the finished journal.
func finishHeldFixture(t *testing.T, m CoreManager, j CoreJournal, w *CoreContinuationWatchdog, phase, completion string, at time.Time) CoreJournal {
	t.Helper()
	if err := (CoreLifecycleBarrier{Root: w.Lifecycle}).Begin(j); err != nil {
		t.Fatal(err)
	}
	record := NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Phase: "captured", CompletionState: completion,
		Inventory: CoreCheckpointInventory{RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Machine: j.Previous.Machine, Bridge: "incusbr0", IngressPorts: []uint16{80, 443}}}
	j.Steps = append([]CoreStep(nil), j.Steps...)
	switch phase {
	case "committed":
		for i := range j.Steps {
			j.Steps[i].State, j.Steps[i].Evidence = "succeeded", "fixture"
		}
	case "rolled-back":
		record.Phase = "paired-restored"
		j.Steps[3].State, j.Steps[3].Evidence = "failed", "fixture apply-cp failed"
		for _, name := range coreRecoveryNames(j) {
			j.RecoverySteps = append(j.RecoverySteps, CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "succeeded", Evidence: "fixture"})
		}
	default:
		t.Fatalf("fixture phase %q", phase)
	}
	if err := (NativeCoreCheckpoint{Root: m.Root}).saveRecord(record); err != nil {
		t.Fatal(err)
	}
	j.Phase = phase
	m.Now = func() time.Time { return at }
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	finished, err := m.Read()
	if err != nil || finished.Phase != phase {
		t.Fatalf("the finished fixture journal is not valid: %v", err)
	}
	return finished
}

// The coordinator recorded the end of the request and ended before, or while,
// it released the holds: the ingress gate and the lifecycle reservation stay,
// and `update core resume` does the release. Its continuation is started
// again, once, at every point the release can stop at.
func TestCoreWatchdogStartsTheReleaseOfAFinishedRequestThatStillHolds(t *testing.T) {
	for _, phase := range []string{"committed", "rolled-back"} {
		for _, completion := range []string{"", "releasing", "ready"} {
			t.Run(phase+"/"+completion, func(t *testing.T) {
				m, j, w, starts := lostContinuationFixture(t)
				j = finishHeldFixture(t, m, j, w, phase, completion, watchdogChanged.Add(10*time.Minute))
				if !coreReleaseLost(w.Root, w.Lifecycle, j) {
					t.Fatal("the held finished request is not recognised")
				}
				watchdogQuiet(t, w, starts, "a finished state that has not waited long enough", 10*time.Minute, 11*time.Minute, 15*time.Minute-time.Second)
				before := [2]map[string]string{coreTreeSnapshot(t, m.Root), coreTreeSnapshot(t, w.Lifecycle)}
				watchdogAt(w, 15*time.Minute)
				command, err := w.Check(context.Background())
				if err != nil || !strings.HasPrefix(command, "watchdog-") || len(starts.calls) != 1 || starts.calls[0] != [2]string{j.RequestID, command} || w.Why() != coreWatchdogNotReleased {
					t.Fatalf("held finished request: command=%q calls=%v err=%v why=%q", command, starts.calls, err, w.Why())
				}
				if after := [2]map[string]string{coreTreeSnapshot(t, m.Root), coreTreeSnapshot(t, w.Lifecycle)}; !reflect.DeepEqual(before, after) {
					t.Fatal("the watchdog changed the state or lifecycle directory itself")
				}
				// A release that fails again leaves the journal as it is: left for a person.
				watchdogQuiet(t, w, starts, "the same finished state", 16*time.Minute, time.Hour, 48*time.Hour)
			})
		}
	}
	// The other guards hold for it too.
	m, j, w, starts := lostContinuationFixture(t)
	finishHeldFixture(t, m, j, w, "committed", "", watchdogChanged.Add(10*time.Minute))
	w.Coordinating = func() (bool, error) { return true, nil }
	watchdogQuiet(t, w, starts, "a release is running", 10*time.Minute, 16*time.Minute, 17*time.Minute)
	// The release finished between the look and the process list: nothing is left to do.
	w.Coordinating = func() (bool, error) {
		return false, os.Remove(filepath.Join(w.Lifecycle, "core-reservation.json"))
	}
	watchdogQuiet(t, w, starts, "the release finished while the processes were listed", 18*time.Minute, 19*time.Minute, 48*time.Hour)
}

// A finished request that holds nothing is never touched: one that was
// released, one that an earlier Spine finished (whatever its checkpoint record
// says, or with none), one that never held anything, and any whose files do
// not prove a hold.
func TestCoreWatchdogLeavesAFinishedRequestWithoutHoldsAlone(t *testing.T) {
	reservation := func(w *CoreContinuationWatchdog) string {
		return filepath.Join(w.Lifecycle, "core-reservation.json")
	}
	record := func(m CoreManager, j CoreJournal) string {
		return NativeCoreCheckpoint{Root: m.Root}.recordPath(j.RequestID)
	}
	remove := func(t *testing.T, path string) {
		t.Helper()
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	type arrange func(*testing.T, CoreManager, CoreJournal, *CoreContinuationWatchdog)
	cases := map[string]struct {
		phase, completion string
		then              arrange
	}{
		"released: no reservation and a record that says so": {"committed", "released", func(t *testing.T, _ CoreManager, _ CoreJournal, w *CoreContinuationWatchdog) {
			remove(t, reservation(w))
		}},
		"rolled back and released": {"rolled-back", "released", func(t *testing.T, _ CoreManager, _ CoreJournal, w *CoreContinuationWatchdog) {
			remove(t, reservation(w))
		}},
		"finished by an earlier Spine: no reservation, a record that says nothing": {"committed", "", func(t *testing.T, _ CoreManager, _ CoreJournal, w *CoreContinuationWatchdog) {
			remove(t, reservation(w))
		}},
		"finished by an earlier Spine: no reservation, no record": {"committed", "", func(t *testing.T, m CoreManager, j CoreJournal, w *CoreContinuationWatchdog) {
			remove(t, reservation(w))
			remove(t, record(m, j))
		}},
		"the final receipt was lost: no reservation, the record says ready": {"committed", "ready", func(t *testing.T, _ CoreManager, _ CoreJournal, w *CoreContinuationWatchdog) {
			remove(t, reservation(w))
		}},
		"a reservation beside a record that says released": {"committed", "released", nil},
		"a reservation and no record": {"committed", "", func(t *testing.T, m CoreManager, j CoreJournal, _ *CoreContinuationWatchdog) {
			remove(t, record(m, j))
		}},
		"a reservation and an unknown completion state": {"committed", "reopening", nil},
		"a reservation of another request": {"committed", "", func(t *testing.T, _ CoreManager, j CoreJournal, w *CoreContinuationWatchdog) {
			raw, _ := json.Marshal(CoreLifecycleReservation{Schema: "youeye.core-lifecycle.v1", RequestID: "update-0", ManifestSHA256: j.ManifestSHA256})
			if err := atomicWrite(reservation(w), raw, 0600); err != nil {
				t.Fatal(err)
			}
		}},
		"a reservation for another manifest": {"committed", "", func(t *testing.T, _ CoreManager, j CoreJournal, w *CoreContinuationWatchdog) {
			raw, _ := json.Marshal(CoreLifecycleReservation{Schema: "youeye.core-lifecycle.v1", RequestID: j.RequestID, ManifestSHA256: strings.Repeat("9", 64)})
			if err := atomicWrite(reservation(w), raw, 0600); err != nil {
				t.Fatal(err)
			}
		}},
		"an unreadable reservation": {"committed", "", func(t *testing.T, _ CoreManager, _ CoreJournal, w *CoreContinuationWatchdog) {
			if err := os.WriteFile(reservation(w), []byte("{"), 0600); err != nil {
				t.Fatal(err)
			}
		}},
		"cancelled: its resume releases nothing": {"committed", "", func(t *testing.T, m CoreManager, j CoreJournal, _ *CoreContinuationWatchdog) {
			for i := 2; i < len(j.Steps); i++ {
				j.Steps[i].State, j.Steps[i].Evidence = "pending", ""
			}
			j.Phase = "cancelled"
			if err := m.saveCore(&j); err != nil {
				t.Fatal(err)
			}
			if _, err := m.Read(); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			m, j, w, starts := lostContinuationFixture(t)
			j = finishHeldFixture(t, m, j, w, c.phase, c.completion, watchdogChanged.Add(10*time.Minute))
			if c.then != nil {
				c.then(t, m, j, w)
			}
			watchdogQuiet(t, w, starts, name, 10*time.Minute, 15*time.Minute, 16*time.Minute, time.Hour, 24*time.Hour, 30*24*time.Hour)
		})
	}
	// A request with unchanged payloads has no checkpoint: it never held anything, and its release does nothing.
	m, j, w, _ := lostContinuationFixture(t)
	j = finishHeldFixture(t, m, j, w, "committed", "", watchdogChanged.Add(10*time.Minute))
	if !coreReleaseLost(w.Root, w.Lifecycle, j) {
		t.Fatal("the held finished request is not recognised")
	}
	for name, edit := range map[string]func(*CoreJournal){
		"metadata only": func(c *CoreJournal) { c.MetadataOnly = true },
		"no-op":         func(c *CoreJournal) { c.NoOp = true },
	} {
		c := j
		edit(&c)
		if coreReleaseLost(w.Root, w.Lifecycle, c) {
			t.Fatalf("a %s request counted as held", name)
		}
	}
}

// The whole way with the real release: the first release of a committed
// request stops before it changed anything, the watchdog sees the hold and
// starts `resume`, whose release (ReleaseCompleted, here in place of the unit)
// reopens the platform. After that the watchdog is silent, and a second
// release changes nothing.
func TestCoreWatchdogReleaseOfACommittedRequestEndToEnd(t *testing.T) {
	ctx := context.Background()
	m, j, w, starts := lostContinuationFixture(t)
	data := t.TempDir()
	w.Lifecycle = filepath.Join(data, "state", "app-updates")
	barrier := CoreLifecycleBarrier{Root: w.Lifecycle}
	if err := barrier.Begin(j); err != nil {
		t.Fatal(err)
	}
	p := NativeCoreCheckpoint{Root: m.Root, DataRoot: data, MachineObservation: func() (CoreMachineIdentity, error) { return j.Previous.Machine, nil }}
	inventory := CoreCheckpointInventory{RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Machine: j.Previous.Machine, Bridge: "incusbr0", IngressPorts: []uint16{80, 443}}
	_, inventory.AppInventorySHA256, _ = p.installedOwners()
	type row struct {
		Name   string            `json:"name"`
		Status string            `json:"status"`
		Config map[string]string `json:"config"`
	}
	rows := map[string]*row{}
	yes := "true"
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-postgres"} {
		inventory.Containers = append(inventory.Containers, CoreCheckpointContainer{Name: name, UUID: "fixture-" + name, Running: true, Autostart: &yes})
		config := map[string]string{"volatile.uuid": "fixture-" + name, "boot.autostart": "false", "user.youeye.core-request": j.RequestID}
		if name == "youeye-postgres" {
			config = map[string]string{"volatile.uuid": "fixture-" + name, "boot.autostart": "true"}
		}
		rows[name] = &row{Name: name, Status: "Running", Config: config}
	}
	if err := p.saveRecord(NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Inventory: inventory, Phase: "captured"}); err != nil {
		t.Fatal(err)
	}
	gate := "youeye-core:" + fmt.Sprintf("%x", sha256.Sum256([]byte(j.RequestID)))
	busy, effects := true, 0
	p.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
		switch {
		case program == "nft" && args[0] == "--json":
			if gate == "" {
				return []byte(`{"nftables":[]}`), nil
			}
			return json.Marshal(map[string]any{"nftables": []any{map[string]any{"table": map[string]string{"family": "inet", "name": "youeye_core_gate", "comment": gate}}}})
		case program == "nft" && strings.Join(args, " ") == "delete table inet youeye_core_gate":
			effects++
			gate = ""
			return nil, nil
		case program == "incus" && args[0] == "list":
			list := []*row{}
			for _, r := range rows {
				list = append(list, r)
			}
			return json.Marshal(list)
		case program == "incus" && args[0] == "query" && args[1] == "/1.0/operations?recursion=1":
			if busy {
				return []byte(coreProviderResponse(`{"running":[{"id":"transient-exec","class":"websocket","status_code":103}]}`)), nil
			}
			return []byte(coreProviderResponse(`{}`)), nil
		case program == "incus" && args[0] == "query":
			return json.Marshal(rows[strings.TrimPrefix(args[1], "/1.0/instances/")])
		case program == "incus" && args[0] == "config" && args[1] == "unset":
			effects++
			delete(rows[args[2]].Config, args[3])
			return nil, nil
		case program == "incus" && args[0] == "config" && args[1] == "set":
			effects++
			rows[args[2]].Config[args[3]] = args[4]
			return nil, nil
		}
		t.Fatalf("unexpected native effect %s %v", program, args)
		return nil, nil
	}
	// The coordinator commits and its release ends on its time limit, with Incus still busy.
	m.Now = func() time.Time { return watchdogChanged.Add(10 * time.Minute) }
	m.YieldAfterSpine = false
	j, err := m.Advance(ctx, j.RequestID, false)
	if err != nil || j.Phase != "committed" {
		t.Fatal(j.Phase, err)
	}
	bounded, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	_, err = p.ReleaseCompleted(bounded, j.RequestID)
	cancel()
	if err == nil || effects != 0 || gate == "" {
		t.Fatalf("the fixture release did not stop before its first change: %v effects=%d", err, effects)
	}
	if m.TransactionComplete(j) {
		t.Fatal("an unreleased request counts as complete")
	}
	busy = false
	// What the watchdog starts is `update core resume`; for a finished request that is the release alone.
	w.Start = func(ctx context.Context, request, command string) (CoreControlObservation, error) {
		if _, err := p.ReleaseCompleted(ctx, request); err != nil {
			t.Fatalf("the release started by the watchdog failed: %v", err)
		}
		return starts.start(ctx, request, command)
	}
	watchdogQuiet(t, w, starts, "a committed state that has not waited long enough", 10*time.Minute, 14*time.Minute)
	watchdogAt(w, 15*time.Minute)
	if command, err := w.Check(ctx); command == "" || err != nil || len(starts.calls) != 1 {
		t.Fatalf("the held committed request was not picked up: %q %v", command, err)
	}
	if _, err := barrier.Read(); !os.IsNotExist(err) || gate != "" || !m.TransactionComplete(j) {
		t.Fatalf("the platform is still held after the release: reservation=%v gate=%q", err, gate)
	}
	for name, r := range rows {
		if r.Config["boot.autostart"] != "true" || r.Config["user.youeye.core-request"] != "" {
			t.Fatalf("%s keeps its power hold: %v", name, r.Config)
		}
	}
	// Released: the watchdog has nothing to see, also with a new memory; and a second `resume` changes nothing.
	w.handled = ""
	watchdogQuiet(t, w, starts, "a released request", 16*time.Minute, 21*time.Minute, 48*time.Hour)
	before := effects
	if evidence, err := p.ReleaseCompleted(ctx, j.RequestID); err != nil || evidence != "retained exact platform release receipt" || effects != before {
		t.Fatalf("a second release was not a no-op: %q %v effects=%d/%d", evidence, err, effects, before)
	}
}

func TestCoreCommandRunningReadsEveryProcess(t *testing.T) {
	proc := t.TempDir()
	process := func(pid string, args ...string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(proc, pid), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(proc, pid, "cmdline"), []byte(strings.Join(args, "\x00")+"\x00"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	process("1", "/sbin/init")
	process("410", "/usr/local/bin/youeye", "api", "serve")
	process("522", "/usr/local/bin/youeye", "update", "apps")
	process("523", "apt-get", "update")
	process("self", "/usr/local/bin/youeye", "update", "core", "resume")   // not a process directory
	if err := os.MkdirAll(filepath.Join(proc, "999"), 0o755); err != nil { // ended while it was read
		t.Fatal(err)
	}
	if busy, err := CoreCommandRunning(proc); busy || err != nil {
		t.Fatalf("no System update command runs: %v %v", busy, err)
	}
	for name, args := range map[string][]string{
		"the continuation unit": {"/usr/local/bin/youeye", "update", "core", "resume", "--request", "update-1"},
		"the boot unit":         {"/usr/local/bin/youeye", "update", "core", "resume", "--boot"},
		"a console session":     {"youeye", "update", "core", "activate", "--request", "update-1"},
		"an action unit":        {"/usr/local/bin/youeye", "update", "core", "run-action", "--request", "update-1", "--action", "apply-cp"},
		"a recovery":            {"/usr/local/bin/youeye", "--config", "/etc/youeye/config.yaml", "update", "core", "recover", "--request", "update-1"},
	} {
		process("700", args...)
		if busy, err := CoreCommandRunning(proc); !busy || err != nil {
			t.Fatalf("%s was not seen: %v %v", name, busy, err)
		}
	}
	if busy, err := CoreCommandRunning(filepath.Join(proc, "absent")); !busy || err == nil {
		t.Fatalf("an unreadable process list counted as idle: %v %v", busy, err)
	}
	// The real one, on this machine: readable, and this test is not a System update command.
	if _, err := CoreCommandRunning("/proc"); err != nil {
		t.Fatal(err)
	}
}
