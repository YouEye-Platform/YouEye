package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
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
}

// coreContinuationManager is the coordinator of `update core activate|resume|
// recover`. The hand-over probe (`update core status --can-resume`) builds the
// same one.
func coreContinuationManager(r systemupdate.NativeCoreRuntime) systemupdate.CoreManager {
	return systemupdate.CoreManager{Root: r.Root, Executor: r.Executor(), YieldAfterSpine: true}
}

func continueCoreRequest(ctx context.Context, r systemupdate.NativeCoreRuntime, request string, activate, recover, once bool) (systemupdate.CoreJournal, error) {
	return runCoreContinuation(ctx, coreContinuation{
		manager: coreContinuationManager(r),
		finished: func(ctx context.Context, j systemupdate.CoreJournal) error {
			var err error
			if j.Phase != "cancelled" {
				_, err = r.Checkpoint.ReleaseCompleted(ctx, j.RequestID)
			}
			r.Runner.ResetFailedUnits(ctx, j)
			if err == nil {
				// The platform is open again: remove the old service trees that this and
				// earlier finished requests left under their stage names. Best effort.
				r.Services.RemoveFinishedStageTrees(ctx)
			}
			return err
		},
		handOver: coreHandOverToSelectedSpine,
	}, request, activate, recover, once)
}

// A caller can detach without canceling the separately owned native action.
// Continuation observes its receipt before admitting another graph step. It
// never infers that an unknown child should be launched a second time.
func runCoreContinuation(ctx context.Context, c coreContinuation, request string, activate, recover, once bool) (systemupdate.CoreJournal, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Hour)
	defer cancel()
	m := c.manager
	var j systemupdate.CoreJournal
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
		activate = false
		if err != nil {
			graph := j.Steps
			if len(j.RecoverySteps) > 0 {
				graph = j.RecoverySteps
			}
			for _, step := range graph {
				if step.State == "started" {
					if marked, markErr := m.RecordAttention(j.RequestID, j.ManifestSHA256, step.Name); markErr == nil {
						j = marked
					}
					break
				}
			}
			return j, err
		}
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
		steps := j.Steps
		if recover {
			steps = j.RecoverySteps
		}
		for _, step := range steps {
			if step.State == "started" {
				observed, err := m.Executor.Observe(ctx, j, step)
				if err != nil {
					if marked, markErr := m.RecordAttention(j.RequestID, j.ManifestSHA256, step.Name); markErr == nil {
						j = marked
					}
					return j, err
				}
				if observed.State == "retryable" {
					// Admission is bounded per explicit continuation. A timeout
					// does not launch a child or spin another automatic attempt.
					return j, nil
				}
				if observed.State == "unknown" {
					if step.Name == "activate-host" || step.Name == "recovery-host" {
						return j, nil
					}
					if marked, markErr := m.RecordAttention(j.RequestID, j.ManifestSHA256, step.Name); markErr == nil {
						j = marked
					}
					return j, fmt.Errorf("native action acknowledgement uncertain; reconcile the same request")
				}
				break
			}
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return j, ctx.Err()
		case <-timer.C:
		}
	}
}
