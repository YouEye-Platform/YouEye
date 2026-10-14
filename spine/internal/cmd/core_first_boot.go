package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

type coreFirstBootResult struct {
	Initialized     bool   `json:"initialized"`
	Converged       bool   `json:"converged"`
	RebootRequested bool   `json:"reboot_requested"`
	ManifestSHA256  string `json:"manifest_sha256,omitempty"`
	RequestID       string `json:"request_id,omitempty"`
}

func init() {
	var policyPath string
	var resumeOnly bool
	cmd := &cobra.Command{Use: "first-boot", Hidden: true, Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		result, err := convergeFreshCore(cmd.Context(), policyPath, resumeOnly)
		if outputErr := json.NewEncoder(cmd.OutOrStdout()).Encode(result); outputErr != nil {
			return outputErr
		}
		return err
	}}
	cmd.Flags().StringVar(&policyPath, "policy", filepath.Join(systemupdate.CoreBootstrapPath, "release-policy.json"), "protected installation policy")
	cmd.Flags().BoolVar(&resumeOnly, "resume-only", false, "return uninitialized before the fresh baseline is deployed")
	coreUpdateCmd.AddCommand(cmd)
}
func convergeFreshCore(ctx context.Context, policyPath string, resumeOnly bool) (coreFirstBootResult, error) {
	var out coreFirstBootResult
	if _, err := os.Lstat("/var/lib/youeye-state/first-deploy/complete"); !errors.Is(err, os.ErrNotExist) {
		return out, fmt.Errorf("first boot cannot update an exposed installation")
	}
	runtime, err := installedCoreRuntime()
	if err != nil {
		return out, err
	}
	m := systemupdate.CoreManager{Root: runtime.Root, Executor: runtime.Executor()}
	_, err = m.ReadReceipt()
	if errors.Is(err, os.ErrNotExist) && resumeOnly {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.Initialized = true
	policy, err := systemupdate.LoadReleasePolicy(policyPath)
	if err != nil {
		return out, err
	}
	root := filepath.Dir(policyPath)
	raw, err := systemupdate.ReadCoreState(filepath.Join(root, "core-release.json"), 1<<20)
	if err != nil {
		return out, err
	}
	sig, err := systemupdate.ReadCoreState(filepath.Join(root, "core-release.json.sig"), 64)
	if err != nil {
		return out, err
	}
	frozen, selection, err := m.FreezeFirstBoot(ctx, policy, systemupdate.CoreHostSelection{Raw: raw, Signature: sig}, systemupdate.CoreDevelopmentTrustPath, func(ctx context.Context) (systemupdate.CoreHostSelection, error) {
		current, err := currentCoreSelection()
		if err != nil {
			return systemupdate.CoreHostSelection{}, err
		}
		selected, _, _, err := systemupdate.ResolveCoreRelease(ctx, runtime.Cache.Client, current, systemupdate.CoreDevelopmentTrustPath)
		return selected, err
	})
	if err != nil {
		return out, err
	}
	out.RequestID, out.ManifestSHA256 = frozen.RequestID, frozen.ManifestSHA256
	if _, err = m.PrepareSigned(ctx, frozen.RequestID, selection, frozen.ManifestSHA256, systemupdate.CoreDevelopmentTrustPath); err != nil {
		return out, err
	}
	journal, err := continueCoreRequest(ctx, runtime, frozen.RequestID, true, false, false)
	if err != nil {
		return out, err
	}
	if journal.Phase == "committed" {
		out.Converged = true
		return out, nil
	}
	if journal.Phase == "applying" || journal.Phase == "recovering" {
		steps := journal.Steps
		if journal.Phase == "recovering" {
			steps = journal.RecoverySteps
		}
		for _, step := range steps {
			if step.State == "started" && (step.Name == "activate-host" || step.Name == "recovery-host") {
				out.RebootRequested = true
				return out, nil
			}
		}
	}
	return out, fmt.Errorf("fresh tracked selection remains unaccepted; setup stays closed")
}
