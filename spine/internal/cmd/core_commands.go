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
	parent.AddCommand(&cobra.Command{Use: "status", Args: cobra.NoArgs, Short: "Read the installed System release and retained transaction", RunE: func(cmd *cobra.Command, _ []string) error {
		m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
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
		return json.NewEncoder(cmd.OutOrStdout()).Encode(out)
	}})
	parent.AddCommand(&cobra.Command{Use: "check", Args: cobra.NoArgs, Short: "Resolve the current signed complete System selection", RunE: func(cmd *cobra.Command, _ []string) error {
		if _, err := installedCoreRuntime(); err != nil {
			return err
		}
		selection, err := currentCoreSelection()
		if err != nil {
			return err
		}
		_, release, digest, err := systemupdate.ResolveCoreRelease(cmd.Context(), systemupdate.ReleaseHTTPClient(), selection, systemupdate.CoreDevelopmentTrustPath)
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"release": release, "manifest_sha256": digest})
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
			command.Flags().StringVar(&digest, "manifest-sha256", "", "reviewed signed System manifest SHA-256")
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

// A caller can detach without canceling the separately owned native action.
// Continuation observes its receipt before admitting another graph step. It
// never infers that an unknown child should be launched a second time.
func continueCoreRequest(ctx context.Context, r systemupdate.NativeCoreRuntime, request string, activate, recover, once bool) (systemupdate.CoreJournal, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Hour)
	defer cancel()
	m := systemupdate.CoreManager{Root: r.Root, Executor: r.Executor()}
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
		if current.Phase == "rolled-back" || current.Phase == "committed" {
			_, err = r.Checkpoint.ReleaseCompleted(ctx, request)
			return current, err
		}
		if current.Phase == "cancelled" {
			return current, nil
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
			_, err = r.Checkpoint.ReleaseCompleted(ctx, request)
			return j, err
		}
		if j.Phase == "needs-recovery" {
			return j, fmt.Errorf("core action requires recovery; retained data and ownership remain held")
		}
		if once || j.Phase == "awaiting-restart" {
			return j, nil
		}
		steps := j.Steps
		if recover {
			steps = j.RecoverySteps
		}
		for _, step := range steps {
			if step.State == "started" {
				observed, err := r.Observe(ctx, j, step)
				if err != nil {
					if marked, markErr := m.RecordAttention(j.RequestID, j.ManifestSHA256, step.Name); markErr == nil {
						j = marked
					}
					return j, err
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
