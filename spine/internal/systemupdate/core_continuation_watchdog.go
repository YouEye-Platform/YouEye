package systemupdate

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// CoreContinuationWatchdog starts the continuation of a System update again
// when its coordinator was lost while the request holds the platform: the
// Control Panel and the dashboard are closed and app work is refused. Without
// it such a request waits for a reboot (the boot unit resumes it) or for
// `youeye update core resume` on the console, with no Control Panel to say so.
//
// The API service runs Check once when it starts and then once a minute.
// Check does what the console command does, through the runner the API uses
// for the Control Panel's "resume", and only when every one of these holds:
//
//   - the current request is lost in one of the ways `lost` lists: it waits
//     between two steps, a started step's coordinator and child are both
//     gone, it needs recovery or its recovery stopped half-way, or it is
//     finished and not released. In each case `resume` is what a person would
//     run: it observes, continues, restores the previous release or releases;
//   - this watchdog has seen the same journal state for at least Idle (a live
//     coordinator moves on within seconds). A state that was already there
//     when the API service started is watched like any other, from the first
//     look on: after a boot the boot unit continues it first (it counts as a
//     running command below), and when that fails, or the service alone was
//     restarted, nobody else would;
//   - no process on the host runs any `update core` command: no continuation
//     unit, boot unit, action unit or console session is at work;
//   - fewer than coreWatchdogAttempts continuations were started for this
//     situation, and the last one at least Idle ago. Two situations are the
//     exception: the release of a finished request, and a started step that
//     restarts the machine (activate-host, recovery-host) whose restart did not
//     happen. After those attempts they are started again every Slow, for as
//     long as the request holds the platform.
//
// Journal states are compared as text (request and change time) and never as
// times, and the waits are measured between this watchdog's own looks on the
// monotonic clock. A wall clock that starts wrong and is corrected later (no
// RTC battery, NTP) can therefore neither make a state look older than this
// service has watched it nor keep the watchdog silent.
//
// Attempts are counted per situation (the key `lost` returns). Between two
// steps and for a release that is the journal state: a continuation that fails
// there leaves the journal as it is. A continuation that fails over a started
// step or a recovery rewrites the journal, so those are counted per request
// and step instead; otherwise they would be started for ever. The command ID
// is derived from the key and the attempt's number, and the runner keeps a
// delivery receipt per command ID, so the attempts are counted across restarts
// of the API service (Delivered) and no attempt is launched twice. After
// coreWatchdogAttempts a request that is not finished is left for a person:
// every further continuation would start or observe actions again. A finished
// request is different. Its release changes nothing about the release that is
// installed, a release that fails leaves everything as it was and the next
// one continues it, and until it succeeds the Control Panel stays closed: so
// it is tried again every Slow (an Incus or a database that was not ready for
// a quarter of an hour used to leave the box closed until the next reboot).
//
// So is a host step whose restart is owed. Its continuation neither starts nor
// repeats an action: it asks NativeCoreRuntime.RebootAgain, which keeps its
// own record of the restarts it asked for and, for activate-host, gives the
// update up after coreOwedRebootRequests of them (the coordinator then
// restores the previous release). That count needs three continuations that
// each get as far as RebootAgain's record; one that does not (it came within
// coreOwedRebootWait of the last request, the boot ID or the child could not
// be read just then) used to use up one of exactly three attempts, and the box
// stayed held with a restart still owed. The slow attempts go on until
// RebootAgain has restarted the machine or given the update up.
//
// The slow attempts share one command ID and one continuation unit: before
// each, the previous one's unit and delivery receipt are removed (Forget), so
// a box that stays closed for weeks keeps four receipts and not one more every
// half hour. The first coreWatchdogAttempts keep their own.
type CoreContinuationWatchdog struct {
	Root string
	// Lifecycle is the app lifecycle directory (CoreAppLifecycleRoot), where a
	// request's reservation lives.
	Lifecycle string
	Idle      time.Duration
	// Now is for tests. Without it the wait is measured with time.Now, whose
	// values carry the monotonic clock.
	Now func() time.Time
	// Coordinating reports whether any `update core` command is running.
	Coordinating func() (bool, error)
	// Start is CoreControlRunner.Start.
	Start func(ctx context.Context, request, command string) (CoreControlObservation, error)
	// Delivered is CoreControlRunner.Delivered: whether a command ID has a
	// retained receipt. Nil counts only this value's own attempts.
	Delivered func(request, command string) bool
	// ChildGone is CoreSystemdRunner.ChildGone: the action child of a started
	// step positively does not run (its unit, its cgroup, its receipts). Nil is
	// "not known": a request with a started step is then never touched.
	ChildGone func(ctx context.Context, j CoreJournal, step CoreStep) bool
	// ChildLingering is CoreSystemdRunner.ChildLingering: the child's main
	// process ended without a last word and processes it started are still in
	// its cgroup. Such a step counts as lost once nothing has changed for
	// Lingering (0: six times Idle): the continuation then gives the step up and
	// the recovery fence stops what is left. Nil: never.
	ChildLingering func(ctx context.Context, j CoreJournal, step CoreStep) bool
	Lingering      time.Duration
	// Slow is the wait between two attempts without end (see above) after the
	// first coreWatchdogAttempts (0: coreWatchdogSlow).
	Slow time.Duration
	// Forget is CoreControlRunner.Forget: it removes the unit and the delivery
	// receipt of a continuation that has ended, so its command ID can be used
	// again. Nil: a slow attempt whose command ID was delivered is not made.
	Forget func(ctx context.Context, request, command string) error

	// seen is the journal state being watched; since is when this watchdog
	// first saw it or last started a continuation for it; attempts counts the
	// continuations it started per situation (see lost).
	seen     string
	since    time.Time
	attempts map[string]int
	why      string
}

// coreWatchdogAttempts: how many continuations the watchdog starts for one
// journal state. One is too few (the release of a finished request does not
// change the journal, so a single transient failure, such as Incus still busy
// after a boot, left the box closed for good); without a bound a continuation
// that can never succeed would be started every few minutes for ever.
const coreWatchdogAttempts = 3

// coreWatchdogSlow: see CoreContinuationWatchdog.Slow.
const coreWatchdogSlow = 30 * time.Minute

const (
	coreWatchdogBetweenSteps = "the request waited between two steps with no coordinator"
	coreWatchdogNotReleased  = "the finished request still held the Control Panel and app work with no coordinator"
	coreWatchdogStepLost     = "a started step had neither a coordinator nor a running action"
	coreWatchdogNeedsRecover = "the request needed recovery with no coordinator"
	coreWatchdogRecoveryLost = "the recovery had stopped with no coordinator"
)

// Why says what the last continuation was started for.
func (w *CoreContinuationWatchdog) Why() string { return w.why }

// coreContinuationLost: the journal of a held update that waits between two
// steps. Image updates count too (until 0.6.14 only service updates did): a
// request that waits for the owner's restart is `awaiting-restart`, not
// `applying`, and the reboot itself is the started step `activate-host`.
func coreContinuationLost(j CoreJournal) bool {
	if j.Phase != "applying" || len(j.RecoverySteps) > 0 {
		return false
	}
	held := false
	for _, step := range j.Steps {
		if step.State == "started" || step.State == "failed" {
			return false
		}
		if step.Name == "checkpoint" && step.State == "succeeded" {
			held = true
		}
	}
	return held
}

// coreStartedStep returns the started step of the graph that is in use.
func coreStartedStep(j CoreJournal) (CoreStep, bool) {
	steps := j.Steps
	if len(j.RecoverySteps) > 0 {
		steps = j.RecoverySteps
	}
	for _, step := range steps {
		if step.State == "started" {
			return step, true
		}
	}
	return CoreStep{}, false
}

// childGone: the journal has no started step, or that step's action child
// positively does not run, or only processes it started are left and nothing
// has changed for Lingering (waited is how long this state has been watched).
//
// A step that restarts the machine (activate-host, recovery-host) is judged
// like any other. Its child is gone when it has asked for the restart, and a
// shutdown stops this service long before Idle has passed. A box that is still
// up then, with no System update command at work, is not restarting: the
// restart failed or was called off, or the activation failed before it. Until
// 0.6.15 such a step was never judged and the box stayed held, with the
// Control Panel closed, until someone restarted it. The continuation decides
// what to do (NativeCoreRuntime.RebootAgain): it asks for the restart again,
// or restores the previous release. After a restart it reads the boot, as the
// boot unit does.
func (w *CoreContinuationWatchdog) childGone(ctx context.Context, j CoreJournal, waited time.Duration) bool {
	step, started := coreStartedStep(j)
	if !started {
		return true
	}
	if w.ChildGone == nil {
		return false
	}
	if w.ChildGone(ctx, j, step) {
		return true
	}
	lingering := w.Lingering
	if lingering <= 0 {
		lingering = 6 * w.Idle
	}
	return w.ChildLingering != nil && waited >= lingering && w.ChildLingering(ctx, j, step)
}

// CoreStoppedPastCheckpoint: the request is past its checkpoint (the platform
// may be held) and cannot go on by itself: phase `needs-recovery`, or a failed
// step. The coordinator restores the previous release for such a request.
func CoreStoppedPastCheckpoint(j CoreJournal) bool {
	if len(j.RecoverySteps) > 0 || (j.Phase != "needs-recovery" && j.Phase != "applying") {
		return false
	}
	checkpoint, stopped := false, j.Phase == "needs-recovery"
	for _, step := range j.Steps {
		checkpoint = checkpoint || (step.Name == "checkpoint" && step.State != "pending")
		stopped = stopped || step.State == "failed"
	}
	return checkpoint && stopped
}

// coreReleaseLost: a committed or rolled-back request whose release did not
// finish (ReleaseCompleted failed, or its process ended first). The release
// restores the power settings, opens the ingress gate, removes the lifecycle
// reservation last and then records `released` in the checkpoint record. A
// reservation that still names this request, beside a checkpoint record in a
// state the release continues from, therefore proves that holds remain. Both
// are files on this machine: Incus, nft and the network are not asked.
//
// Everything else is not lost: a request that was released (no reservation of
// its own, whatever its record says, which covers every request finished by an
// earlier Spine), one that never held anything (cancelled, or with unchanged
// payloads) and one whose files cannot be read.
func coreReleaseLost(root, lifecycle string, j CoreJournal) bool {
	if (j.Phase != "committed" && j.Phase != "rolled-back") || j.NoOp || j.MetadataOnly {
		return false
	}
	reservation, err := (CoreLifecycleBarrier{Root: lifecycle}).Read()
	if err != nil || reservation.RequestID != j.RequestID || reservation.ManifestSHA256 != j.ManifestSHA256 {
		return false
	}
	record, err := (NativeCoreCheckpoint{Root: root}).Read(j)
	return err == nil && (record.CompletionState == "" || record.CompletionState == "releasing" || record.CompletionState == "ready")
}

// lost says why the request needs its continuation started again ("" when it
// does not) and the key its attempts are counted under.
//
//   - between two steps: phase `applying`, no recovery graph, the checkpoint
//     succeeded (the platform is held; before that the Control Panel is up and
//     the owner decides), no step started or failed;
//   - finished and not released: see coreReleaseLost;
//   - a started step with nobody behind it: phase `applying` past the
//     checkpoint, and the step's action child positively does not run (the
//     caller has already seen that no `update core` process exists). `resume`
//     reads the step's result and continues, or finds none and restores the
//     previous release. For a step that restarts the machine see childGone;
//   - needs recovery: the request stopped past its checkpoint and has no
//     recovery graph; `resume` restores the previous release
//     (runCoreContinuationToAnEnd in the command layer);
//   - a recovery that stopped: a recovery graph with no failed step (a failed
//     recovery step is never run again and stays for a person), in phase
//     `recovering` or `needs-recovery`, with no action child running.
func (w *CoreContinuationWatchdog) lost(ctx context.Context, j CoreJournal, state string, waited time.Duration) (why, key string) {
	if coreContinuationLost(j) {
		return coreWatchdogBetweenSteps, state
	}
	if coreReleaseLost(w.Root, w.Lifecycle, j) {
		return coreWatchdogNotReleased, state
	}
	step, started := coreStartedStep(j)
	if len(j.RecoverySteps) > 0 {
		if j.Phase != "recovering" && j.Phase != "needs-recovery" {
			return "", ""
		}
		next := ""
		for _, s := range j.RecoverySteps {
			if s.State == "failed" {
				return "", ""
			}
			if next == "" && s.State != "succeeded" {
				next = s.Name
			}
		}
		if !w.childGone(ctx, j, waited) {
			return "", ""
		}
		return coreWatchdogRecoveryLost, j.RequestID + "\x00recovery\x00" + next
	}
	if CoreStoppedPastCheckpoint(j) {
		if !w.childGone(ctx, j, waited) {
			return "", ""
		}
		return coreWatchdogNeedsRecover, j.RequestID + "\x00recover"
	}
	if j.Phase != "applying" || !started {
		return "", ""
	}
	// Only where the platform may be held: a step after the checkpoint, or the
	// checkpoint itself once it has a record (it writes that before its first
	// effect). A checkpoint whose admission ended early holds nothing: the
	// Control Panel is open and offers Retry and Cancel.
	held := false
	for _, s := range j.Steps {
		held = held || (s.Name == "checkpoint" && s.State == "succeeded")
	}
	if step.Name == "checkpoint" {
		held = (NativeCoreCheckpoint{Root: w.Root}).requireNoCheckpointRecord(j) != nil
	}
	if held && w.childGone(ctx, j, waited) {
		return coreWatchdogStepLost, j.RequestID + "\x00step\x00" + step.Name
	}
	return "", ""
}

// coreWatchdogCommand is the command ID of the n-th continuation (from 1) for
// a journal state.
func coreWatchdogCommand(key string, n int) string {
	if n > 1 {
		key += "\x00" + strconv.Itoa(n)
	}
	return fmt.Sprintf("watchdog-%x", sha256.Sum256([]byte(key)))[:41]
}

// Check looks once. It returns the command ID it started a continuation with,
// or "" when it started none.
func (w *CoreContinuationWatchdog) Check(ctx context.Context) (string, error) {
	if w.Coordinating == nil || w.Start == nil || w.Idle <= 0 || !filepath.IsAbs(w.Root) || !filepath.IsAbs(w.Lifecycle) {
		return "", fmt.Errorf("continuation watchdog is not configured")
	}
	now := time.Now()
	if w.Now != nil {
		now = w.Now()
	}
	m := CoreManager{Root: w.Root}
	j, err := m.Read()
	if errors.Is(err, os.ErrNotExist) {
		w.seen = ""
		return "", nil
	}
	if err != nil {
		// Unreadable: nothing is learned.
		return "", nil
	}
	state := j.RequestID + "\x00" + j.UpdatedAt
	if state != w.seen {
		w.seen, w.since = state, now
		return "", nil
	}
	if now.Sub(w.since) < w.Idle {
		return "", nil
	}
	// Processes first: a started step is judged only when no coordinator and
	// no action process exists.
	if busy, err := w.Coordinating(); err != nil || busy {
		return "", nil
	}
	// Nothing moved while the processes were listed, and the request is still
	// lost: a release that finished meanwhile has removed its reservation.
	again, err := m.Read()
	if err != nil || again.RequestID != j.RequestID || again.UpdatedAt != j.UpdatedAt {
		return "", nil
	}
	waited := now.Sub(w.since)
	why, key := w.lost(ctx, again, state, waited)
	if why == "" {
		return "", nil
	}
	// Tried without end: the release of a finished request, and a host step
	// whose restart is owed (RebootAgain counts those itself).
	endless := why == coreWatchdogNotReleased
	if step, started := coreStartedStep(again); started && (why == coreWatchdogStepLost || why == coreWatchdogRecoveryLost) {
		endless = step.Name == "activate-host" || step.Name == "recovery-host"
	}
	// The next attempt is the first one this value has not made and the runner
	// holds no receipt for (an earlier API service may have made it).
	if w.attempts == nil {
		w.attempts = map[string]int{}
	}
	attempt := w.attempts[key] + 1
	for attempt <= coreWatchdogAttempts && w.Delivered != nil && w.Delivered(j.RequestID, coreWatchdogCommand(key, attempt)) {
		attempt++
	}
	if attempt > coreWatchdogAttempts {
		slow := w.Slow
		if slow <= 0 {
			slow = coreWatchdogSlow
		}
		if !endless || waited < slow {
			return "", nil
		}
		// Every slow attempt is the same delivery, made again: what the last one
		// left (its unit and its receipt) goes first.
		attempt = coreWatchdogAttempts + 1
		command := coreWatchdogCommand(key, attempt)
		if w.Delivered != nil && w.Delivered(j.RequestID, command) {
			if w.Forget == nil {
				return "", nil
			}
			if err := w.Forget(ctx, j.RequestID, command); err != nil {
				// Not counted and not waited for: the next look tries again.
				w.why = why
				return command, fmt.Errorf("the previous attempt's unit could not be removed: %w", err)
			}
		}
	}
	w.attempts[key], w.since, w.why = attempt, now, why
	command := coreWatchdogCommand(key, attempt)
	_, err = w.Start(ctx, j.RequestID, command)
	return command, err
}

// CoreCommandRunning reports whether any process visible under proc (normally
// /proc) has the consecutive arguments `update core`: every coordinator
// (`activate`, `resume`, `recover`, `stage`), every action (`run-action`) and
// every other System update command, however it was started. A process that
// ends while it is read is skipped; when the list itself cannot be read the
// answer is "yes".
func CoreCommandRunning(proc string) (bool, error) {
	entries, err := os.ReadDir(proc)
	if err != nil {
		return true, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "" || strings.Trim(name, "0123456789") != "" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(proc, name, "cmdline"))
		if err != nil {
			continue
		}
		args := strings.Split(string(raw), "\x00")
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "update" && args[i+1] == "core" {
				return true, nil
			}
		}
	}
	return false, nil
}
