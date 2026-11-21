package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func init() { installCoreCommands(coreUpdateCmd) }

func installCoreCommands(parent *cobra.Command) {
	parent.AddCommand(&cobra.Command{Use: "observe", Args: cobra.NoArgs, Short: "Verify current installed System membership without changing the machine", RunE: func(cmd *cobra.Command, _ []string) error {
		receipt, err := (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).ReadReceipt()
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode((coreAPIOperations{}).ObserveInstalled(cmd.Context(), receipt))
	}})
	parent.AddCommand(coreStatusCommand())
	parent.AddCommand(&cobra.Command{Use: "prune", Args: cobra.NoArgs, Short: "Remove what finished System updates left behind, except the last good checkpoint", RunE: func(cmd *cobra.Command, _ []string) error {
		runtime, err := installedCoreRuntime()
		if err != nil {
			return err
		}
		// The same pruning every finished update runs by itself; it does nothing
		// while a request is unfinished. The answer says what was removed and kept.
		return json.NewEncoder(cmd.OutOrStdout()).Encode(runtime.PruneFinished(cmd.Context()))
	}})
	parent.AddCommand(&cobra.Command{Use: "check", Args: cobra.NoArgs, Short: "Resolve the current complete System selection", RunE: func(cmd *cobra.Command, _ []string) error {
		if _, err := installedCoreRuntime(); err != nil {
			return err
		}
		selection, err := currentCoreSelection()
		if err != nil {
			return err
		}
		choice, err := systemupdate.ResolveCoreChoice(cmd.Context(), systemupdate.ReleaseHTTPClient(), selection)
		if err != nil {
			return err
		}
		release, digest := choice.Release, choice.Digest
		out := map[string]any{"release": release, "manifest_sha256": digest, "channel": selection.Channel}
		if choice.Stone {
			out["stepping_stone"], out["channel_head"], out["head_refused"] = true, choice.Head.Version, choice.HeadRefused
		}
		if receipt, err := (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).ReadReceipt(); err == nil {
			if err := systemupdate.RefuseDowngrade(selection.Channel, receipt.Release, release); err != nil {
				out["behind"], out["message"] = true, err.Error()
			}
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(out)
	}})
	for _, action := range []string{"stage", "activate", "resume", "recover", "cancel"} {
		action := action
		var request, digest string
		var once, boot bool
		command := &cobra.Command{Use: action, Args: cobra.NoArgs, Short: "Manage the exact retained System update request", RunE: func(cmd *cobra.Command, _ []string) error {
			runtime, err := installedCoreRuntime()
			if err != nil {
				return err
			}
			m := systemupdate.CoreManager{Root: runtime.Root, Executor: runtime.Executor()}
			if boot {
				if request != "" {
					return fmt.Errorf("boot continuation cannot substitute a supplied request")
				}
				j, err := m.Read()
				if errors.Is(err, os.ErrNotExist) {
					return nil
				}
				if err != nil {
					return err
				}
				request = j.RequestID
			}
			if request == "" {
				return fmt.Errorf("exact --request required")
			}
			var journal systemupdate.CoreJournal
			if action == "stage" {
				if digest == "" {
					return fmt.Errorf("reviewed --manifest-sha256 required")
				}
				prepared, prepareErr := prepareCoreRequest(cmd.Context(), m, request, digest)
				if prepareErr != nil {
					return prepareErr
				}
				current, readErr := m.Read()
				if readErr != nil {
					return readErr
				}
				if current.RequestID != prepared.RequestID {
					return json.NewEncoder(cmd.OutOrStdout()).Encode(prepared)
				}
			}
			if action == "cancel" {
				journal, err = m.Cancel(cmd.Context(), request)
				runtime.Runner.ResetFailedUnits(cmd.Context(), journal)
			} else {
				journal, err = continueCoreRequest(cmd.Context(), runtime, request, action == "activate", action == "recover", once)
			}
			if journal.RequestID != "" {
				if outputErr := json.NewEncoder(cmd.OutOrStdout()).Encode(journal); outputErr != nil {
					return outputErr
				}
			}
			return err
		}}
		command.Flags().StringVar(&request, "request", "", "stable idempotency identity for this update")
		if action == "stage" {
			command.Flags().StringVar(&digest, "manifest-sha256", "", "reviewed System core-release.json SHA-256")
		}
		if action != "cancel" {
			command.Flags().BoolVar(&once, "once", false, "perform one reconciliation pass")
		}
		if action == "resume" {
			command.Flags().BoolVar(&boot, "boot", false, "continue only the retained installed request at boot")
		}
		parent.AddCommand(command)
	}
	var request, action, digest string
	child := &cobra.Command{Use: "run-action", Hidden: true, Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		runtime, err := installedCoreRuntime()
		if err != nil {
			return err
		}
		result, err := runtime.RunAction(cmd.Context(), request, action, digest)
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
	}}
	child.Flags().StringVar(&request, "request", "", "exact core request")
	child.Flags().StringVar(&action, "action", "", "exact retained action")
	child.Flags().StringVar(&digest, "manifest-sha256", "", "exact retained manifest digest")
	parent.AddCommand(child)
}

// coreStatusRoot is where `update core status` reads. Tests point it at a fixture.
var coreStatusRoot = systemupdate.CoreStatePath

// coreStatusCommand is `update core status`. Without flags it reads two files
// (the committed receipt and the journal, each with its frozen release) and
// prints them; that answer is a contract with older coordinators and with the
// Control Panel. With --can-resume --request <id> it adds this Spine's answer
// to "can you continue this request now?" (see coreAnswerCanResume) and exits
// non-zero unless the answer is yes. A Spine without the flag fails to parse it
// and exits non-zero too, which the asking coordinator reads as "no".
func coreStatusCommand() *cobra.Command {
	var canResume bool
	var request string
	command := &cobra.Command{Use: "status", Args: cobra.NoArgs, Short: "Read the installed System release and retained transaction", RunE: func(cmd *cobra.Command, _ []string) error {
		if canResume && request == "" {
			return fmt.Errorf("exact --request required")
		}
		if !canResume && request != "" {
			return fmt.Errorf("--request is read only with --can-resume")
		}
		m := systemupdate.CoreManager{Root: coreStatusRoot}
		receipt, err := m.ReadReceipt()
		if err != nil {
			return err
		}
		out := map[string]any{"installed": receipt}
		journal, err := m.Read()
		if err == nil {
			out["transaction"] = journal
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if !canResume {
			return json.NewEncoder(cmd.OutOrStdout()).Encode(out)
		}
		refusal := coreAnswerCanResume(cmd.Context(), out, request)
		if err := json.NewEncoder(cmd.OutOrStdout()).Encode(out); err != nil {
			return err
		}
		return refusal
	}}
	command.Flags().BoolVar(&canResume, "can-resume", false, "also answer whether this Spine can continue the request named by --request; changes nothing")
	command.Flags().StringVar(&request, "request", "", "the request --can-resume asks about")
	return command
}

// coreContinuation is what the continuation loop needs from the installed
// runtime: the coordinator, what to do when the request has ended, and how to
// hand the rest of a request to the new Spine. Tests supply their own.
type coreContinuation struct {
	manager systemupdate.CoreManager
	// finished runs when the request is committed, rolled back or cancelled.
	finished func(context.Context, systemupdate.CoreJournal) error
	// handOver replaces this process with the selected Spine's continuation of
	// the same request. It returns only when it did not: the caller continues.
	handOver func(context.Context, systemupdate.CoreJournal) error
	// childState is CoreSystemdRunner.ChildState: where the action child of a
	// started step is. Nil (tests) is "gone": every outcome that cannot be
	// learned is then final at once.
	childState func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) string
	// childSucceeded is CoreSystemdRunner.ChildSucceeded: the child left
	// "succeeded" as its last word. Nil: never.
	childSucceeded func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) bool
	// rebootAgain is NativeCoreRuntime.RebootAgain: it judges a started host
	// step whose restart did not happen. Nil leaves such a step alone.
	rebootAgain func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) (bool, error)
	// lingeringWaited: the patience for a step (coreLingeringPatience,
	// coreSucceededPatience) has been spent on this request.
	lingeringWaited bool
}

// coreContinuationManager is the coordinator of `update core activate|resume|
// recover`. The hand-over probe (`update core status --can-resume`) builds the
// same one.
func coreContinuationManager(r systemupdate.NativeCoreRuntime) systemupdate.CoreManager {
	return systemupdate.CoreManager{Root: r.Root, Executor: r.Executor(), YieldAfterSpine: true}
}

func continueCoreRequest(ctx context.Context, r systemupdate.NativeCoreRuntime, request string, activate, recover, once bool) (systemupdate.CoreJournal, error) {
	return runCoreContinuationToAnEnd(ctx, coreContinuation{
		manager: coreContinuationManager(r),
		finished: func(ctx context.Context, j systemupdate.CoreJournal) error {
			var err error
			if j.Phase != "cancelled" {
				var evidence string
				evidence, err = r.Checkpoint.ReleaseCompleted(ctx, j.RequestID)
				// A release that had to start containers (after a reboot or power cut) says so.
				if err == nil && (strings.Contains(evidence, "started after a restart") || strings.Contains(evidence, "could not be started")) {
					coreNotice("release of request " + j.RequestID + ": " + evidence)
				}
			}
			r.Runner.ResetFailedUnits(ctx, j)
			if err == nil {
				// The platform is open again: remove the old service trees that this and
				// earlier finished requests left under their stage names. Best effort.
				r.Services.RemoveFinishedStageTrees(ctx)
				// And what earlier finished requests left on the disks, except the
				// last good checkpoint (NativeCoreRuntime.PruneFinished). Best effort.
				if pruned := r.PruneFinished(ctx); pruned.Changed() {
					coreNotice(pruned.String())
				}
			}
			return err
		},
		handOver:       coreHandOverToSelectedSpine,
		childState:     r.Runner.ChildState,
		childSucceeded: r.Runner.ChildSucceeded,
		rebootAgain:    r.RebootAgain,
	}, request, activate, recover, once)
}

// runCoreContinuationToAnEnd is the continuation loop plus the one thing a
// person would otherwise have to do on the console: when an update that is
// past its checkpoint cannot go on (a step failed, or its outcome cannot be
// learned, for example after a power cut in the middle of a step), the
// previous release is restored, by the same recovery `update core recover`
// runs. "Cannot be learned" is decided by coreUncertainStep, from the step's
// child and never from a look that failed; a host step whose restart did not
// happen is judged by coreHostStepUnknown.
//
// Past its checkpoint an update holds the platform: the Control Panel and the
// dashboard are closed, so nobody can press "Restore previous release", and a
// request left in needs-recovery kept the box closed until someone ran
// `recover` over SSH or on the console. The recovery is started at most once
// per request, here: a request that already has a recovery graph is continued
// by `resume` as before, and a recovery that fails stays for a person. A
// single pass (--once) never starts one.
func runCoreContinuationToAnEnd(ctx context.Context, c coreContinuation, request string, activate, recover, once bool) (systemupdate.CoreJournal, error) {
	j, err := runCoreContinuation(ctx, c, request, activate, recover, once)
	if err == nil || recover || once || !coreUpdateNeedsRecovery(c.manager, request) {
		return j, err
	}
	if !coreUpdateStepFailed(c.manager, request) {
		// No step failed: an outcome could not be learned (a lost acknowledgement,
		// a provider that did not answer). Look once more after a moment before
		// giving the update up: a child that runs after all is followed to its end.
		timer := time.NewTimer(coreRecoveryGrace)
		select {
		case <-ctx.Done():
			timer.Stop()
			return j, err
		case <-timer.C:
		}
		// The first look has waited for what a child left running; this one does not.
		c.lingeringWaited = true
		j, err = runCoreContinuation(ctx, c, request, false, false, false)
		if err == nil || !coreUpdateNeedsRecovery(c.manager, request) {
			return j, err
		}
	}
	coreNotice(fmt.Sprintf("the update of request %s cannot continue (%v); restoring the previous release", request, err))
	return runCoreContinuation(ctx, c, request, false, true, false)
}

// coreRecoveryGrace: the pause before the second look at an uncertain step.
var coreRecoveryGrace = 15 * time.Second

func coreUpdateStepFailed(m systemupdate.CoreManager, request string) bool {
	j, err := m.Read()
	if err != nil || j.RequestID != request {
		return false
	}
	for _, step := range j.Steps {
		if step.State == "failed" {
			return true
		}
	}
	return false
}

// coreUpdateNeedsRecovery: the request stopped past its checkpoint with no
// recovery graph yet. Read from the journal, not from what the loop returned.
// Before the checkpoint nothing is held and the panel offers Cancel; a
// checkpoint whose admission ended early leaves the request `applying` with no
// failed step (Retry or Cancel); a refused checkpoint preflight was cancelled
// by the coordinator.
func coreUpdateNeedsRecovery(m systemupdate.CoreManager, request string) bool {
	j, err := m.Read()
	return err == nil && j.RequestID == request && systemupdate.CoreStoppedPastCheckpoint(j)
}

// coreUncertainPause is the pause before the next look at a started step whose
// outcome could not be learned while its child may still run.
// coreLingeringPatience is how long processes that outlive their action's main
// process are waited for before the step is given up (the recovery fence then
// stops them).
// coreSucceededPatience is how long a step whose child left "succeeded" is
// looked at again while every look fails, before it is given up.
var (
	coreUncertainPause    = 5 * time.Second
	coreLingeringPatience = 10 * time.Minute
	coreSucceededPatience = 30 * time.Minute
)

// coreUncertainWaits is when each bounded wait for the current step began. Each has its own beginning: looks can
// fail for hours while a child runs (which is waited for without a limit), and until 0.6.15 the one shared
// beginning made the child's end, succeeded or with processes left, count as waited for already.
type coreUncertainWaits struct {
	// step: the step the waits are for. Another step's waits begin anew: failing passes can go from one step to
	// the next without a look that succeeds in between.
	step string
	// succeeded: the first failed look that found the child gone with "succeeded" as its last word.
	succeeded time.Time
	// lingering: the first failed look that found only processes the child left.
	lingering time.Time
}

// coreStartedStep returns the started step of the graph that is in use.
func coreStartedStep(j systemupdate.CoreJournal) (systemupdate.CoreStep, bool) {
	graph := j.Steps
	if len(j.RecoverySteps) > 0 {
		graph = j.RecoverySteps
	}
	for _, step := range graph {
		if step.State == "started" {
			return step, true
		}
	}
	return systemupdate.CoreStep{}, false
}

// coreUncertainStep decides what a started step whose outcome could not be
// learned (cause: an error from the coordinator or the executor, or an unknown
// outcome) means for the request. Giving the step up marks the request
// needs-recovery, and the coordinator then restores the previous release: that
// must follow from the step, never from a look that failed.
//
//   - Another executor holds the action's lock at this moment (a second
//     coordinator, which the boot unit, "Resume" and the console can each
//     start): nothing was learned about the step. Look again.
//   - The step's child runs, or systemd cannot say (`systemctl show` failed):
//     look again. A child ends by itself (RuntimeMaxSec), and a recovery could
//     not fence a child that cannot be observed either.
//   - Only processes the child started are left in its cgroup: look again for
//     coreLingeringPatience (from the first such look), then give the step up.
//   - The child is positively gone and left "succeeded" as its last word: the
//     step succeeded and only the look failed (the executor could not read or
//     accept it just then). Look again, for coreSucceededPatience (from the
//     first such look); the next look that works records the step and the update goes on. A step
//     whose success no look can record for that long is given up after all:
//     the box must not stay held for ever over it.
//   - The child is positively gone with any other last word, or none: give the
//     step up.
//
// Until 0.6.15 every such error gave the step up, and two of them 15 seconds
// apart (the action lock briefly held by a second coordinator, `systemctl
// show` failing twice) made the coordinator fence a live child and restore the
// previous release over a healthy update. And "gone" covered a child that had
// succeeded, so a look that failed after the child's end still rolled back an
// update whose step had done its work.
func (c coreContinuation) coreUncertainStep(ctx context.Context, j systemupdate.CoreJournal, step systemupdate.CoreStep, cause error, waits *coreUncertainWaits) (lookAgain bool) {
	if waits.step != step.Name {
		*waits = coreUncertainWaits{step: step.Name}
	}
	if errors.Is(cause, systemupdate.ErrCoreActionOwned) {
		return true
	}
	if c.childState == nil {
		return false
	}
	switch c.childState(ctx, j, step) {
	case systemupdate.CoreChildGone:
		if c.childSucceeded == nil || c.lingeringWaited || !c.childSucceeded(ctx, j, step) {
			return false
		}
		if waits.succeeded.IsZero() {
			waits.succeeded = time.Now()
		}
		return time.Since(waits.succeeded) < coreSucceededPatience
	case systemupdate.CoreChildLingering:
		if c.lingeringWaited {
			return false
		}
		if waits.lingering.IsZero() {
			waits.lingering = time.Now()
		}
		return time.Since(waits.lingering) < coreLingeringPatience
	}
	return true
}

// A caller can detach without canceling the separately owned native action.
// Continuation observes its receipt before admitting another graph step. It
// never infers that an unknown child should be launched a second time.
func runCoreContinuation(ctx context.Context, c coreContinuation, request string, activate, recover, once bool) (systemupdate.CoreJournal, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Hour)
	defer cancel()
	m := c.manager
	var j systemupdate.CoreJournal
	// waits: the bounded waits for the current step, from when each began.
	var waits coreUncertainWaits
	// uncertain handles a started step whose outcome could not be learned. It
	// returns true when the loop looks again (after a pause), and otherwise the
	// journal and error the continuation ends with.
	uncertain := func(step systemupdate.CoreStep, cause error) (bool, systemupdate.CoreJournal, error) {
		if c.coreUncertainStep(ctx, j, step, cause, &waits) {
			if once {
				// A single pass reports what it met and gives nothing up.
				return false, j, cause
			}
			timer := time.NewTimer(coreUncertainPause)
			select {
			case <-ctx.Done():
				timer.Stop()
				return false, j, cause
			case <-timer.C:
			}
			return true, j, nil
		}
		if marked, markErr := m.RecordAttention(j.RequestID, j.ManifestSHA256, step.Name); markErr == nil {
			j = marked
		}
		return false, j, cause
	}
	for {
		current, err := m.Read()
		if err != nil {
			return j, err
		}
		if current.RequestID != request {
			return current, fmt.Errorf("current core request changed")
		}
		if len(current.RecoverySteps) > 0 {
			recover = true
		}
		if current.Phase == "rolled-back" || current.Phase == "committed" || current.Phase == "cancelled" {
			return current, c.finished(ctx, current)
		}
		if recover {
			j, err = m.Recover(ctx, request)
		} else {
			j, err = m.Advance(ctx, request, activate)
		}
		if err != nil {
			if step, started := coreStartedStep(j); started {
				if again, out, outErr := uncertain(step, err); !again {
					return out, outErr
				}
				// activate is kept: this pass may not have recorded it.
				continue
			}
			return j, err
		}
		activate = false
		if j.Phase == "committed" || j.Phase == "rolled-back" {
			return j, c.finished(ctx, j)
		}
		if j.Phase == "needs-recovery" {
			return j, fmt.Errorf("core action requires recovery; retained data and ownership remain held")
		}
		if once || j.Phase == "awaiting-restart" {
			return j, nil
		}
		if !recover && c.handOver != nil && systemupdate.CoreSpineJustApplied(current, j) {
			// The Spine step is done and nothing after it has started. The new Spine
			// coordinates the rest: this process becomes its `resume` of the same
			// request. No lock, descriptor or hold lives in this process between
			// steps, so the journal is exactly what a lost coordinator leaves and
			// what `resume` continues. A hand-over that cannot be made changes
			// nothing: this Spine carries on, as before.
			if err := c.handOver(ctx, j); err != nil {
				coreNotice(fmt.Sprintf("this Spine keeps coordinating the request: %v", err))
			}
			continue
		}
		if step, started := coreStartedStep(j); started {
			observed, err := m.Executor.Observe(ctx, j, step)
			if err == nil && observed.State == "retryable" {
				// Admission is bounded per explicit continuation. A timeout
				// does not launch a child or spin another automatic attempt.
				return j, nil
			}
			if err == nil && observed.State == "unknown" {
				if step.Name == "activate-host" || step.Name == "recovery-host" {
					return c.coreHostStepUnknown(ctx, j, step)
				}
				err = fmt.Errorf("native action acknowledgement uncertain; reconcile the same request")
			}
			if err != nil {
				if again, out, outErr := uncertain(step, err); !again {
					return out, outErr
				}
				continue
			}
		}
		waits = coreUncertainWaits{}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return j, ctx.Err()
		case <-timer.C:
		}
	}
}

// coreHostStepUnknown ends a continuation over a started activate-host or
// recovery-host whose outcome is unknown. Such a step ends in a restart and
// the next boot is its outcome, so the continuation ends here without an
// error. RebootAgain judges the one case where that would leave the box held
// for ever: the restart did not happen. For activate-host its error gives the
// step up (the coordinator restores the previous release); a recovery has
// nothing to fall back to and stays as it is.
func (c coreContinuation) coreHostStepUnknown(ctx context.Context, j systemupdate.CoreJournal, step systemupdate.CoreStep) (systemupdate.CoreJournal, error) {
	if c.rebootAgain == nil {
		return j, nil
	}
	asked, err := c.rebootAgain(ctx, j, step)
	if asked {
		coreNotice(fmt.Sprintf("the restart that %s of request %s asked for did not happen; asked for it again", step.Name, j.RequestID))
	}
	if err == nil {
		return j, nil
	}
	if step.Name == "activate-host" {
		if marked, markErr := c.manager.RecordAttention(j.RequestID, j.ManifestSHA256, step.Name); markErr == nil {
			j = marked
		}
	}
	return j, err
}
