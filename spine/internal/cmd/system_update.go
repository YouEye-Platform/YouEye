package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var (
	systemUpdateManifest      string
	systemUpdateManifestSHA   string
	systemUpdateAllowTest     bool
	systemUpdateReplaceFailed bool
	systemUpdateJSON          bool
	systemUpdateReboot        bool
	systemUpdateHealthFailed  bool
	systemUpdatePolicyPath    string
	systemUpdateBundlePath    string
)

var systemUpdateStatusCmd = &cobra.Command{
	Use: "status", Short: "Show the durable appliance system update state",
	RunE: func(cmd *cobra.Command, args []string) error { return runSystemUpdateStatus(systemUpdateJSON) },
}

var systemUpdateCheckCmd = &cobra.Command{
	Use: "check", Short: "Verify and record an exact host update manifest",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireImageUpdate(); err != nil {
			return err
		}
		options, err := systemUpdateSourceOptions()
		if err != nil {
			return err
		}
		status, err := systemupdate.NewDefault().Discover(cmd.Context(), options)
		if err != nil {
			return err
		}
		return printSystemUpdateStatus(status, systemUpdateJSON)
	},
}

var systemUpdateStageCmd = &cobra.Command{
	Use: "stage", Short: "Download, verify, and write the inactive System slot",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireImageUpdate(); err != nil {
			return err
		}
		manager := systemupdate.NewDefault()
		options, err := systemUpdateSourceOptions()
		if err != nil {
			return err
		}
		status, err := manager.Stage(cmd.Context(), options)
		if err != nil {
			return err
		}
		return printSystemUpdateStatus(status, systemUpdateJSON)
	},
}

var systemUpdateActivateCmd = &cobra.Command{
	Use: "activate", Short: "Arm the staged slot for a counted trial boot",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireImageUpdate(); err != nil {
			return err
		}
		manager := systemupdate.NewDefault()
		var status systemupdate.Status
		var err error
		status, err = manager.Activate(cmd.Context(), systemUpdateReboot)
		if err != nil {
			return err
		}
		return printSystemUpdateStatus(status, systemUpdateJSON)
	},
}

var systemUpdateReconcileCmd = &cobra.Command{
	Use: "reconcile", Short: "Reconcile a counted appliance trial boot", Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		result, err := systemupdate.NewDefault().Reconcile(cmd.Context(), systemupdate.ReconcileOptions{HealthFailed: systemUpdateHealthFailed})
		if err != nil {
			return err
		}
		return printJSONOrSummary(result, systemUpdateJSON)
	},
}

var systemUpdateCommitGateCmd = &cobra.Command{
	Use: "check-commit", Short: "Check whether the complete release permits host commitment", Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error { return systemupdate.NewDefault().CheckCoreHostCommit() },
}

var systemUpdateMarkHealthyCmd = &cobra.Command{
	Use: "mark-healthy", Short: "Record a blessed appliance trial as healthy", Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		status, err := systemupdate.NewDefault().MarkHealthy(cmd.Context())
		if err != nil {
			return err
		}
		return printSystemUpdateStatus(status, systemUpdateJSON)
	},
}

var systemUpdateConvergeCmd = &cobra.Command{
	Use: "converge", Short: "Verify the installed media against the accepted System release", Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireImageUpdate(); err != nil {
			return err
		}
		policy, err := systemupdate.LoadReleasePolicy(systemUpdatePolicyPath)
		if err != nil {
			return err
		}
		// Install the verified media baseline behind the setup gate. Core
		// first boot then freezes current discovery and uses paired updates.
		result, err := systemupdate.VerifyCoreInstalledMedia(policy, filepath.Dir(systemUpdatePolicyPath), appliance.ManifestPath, systemUpdateBundlePath)
		if err != nil {
			return err
		}
		return printJSONOrSummary(result, systemUpdateJSON)
	},
}

func init() {
	for _, command := range []*cobra.Command{systemUpdateCommitGateCmd, systemUpdateStatusCmd, systemUpdateCheckCmd, systemUpdateStageCmd, systemUpdateActivateCmd, systemUpdateReconcileCmd, systemUpdateMarkHealthyCmd, systemUpdateConvergeCmd} {
		command.Flags().BoolVar(&systemUpdateJSON, "json", false, "emit machine-readable JSON")
		updateSystemCmd.AddCommand(command)
	}
	systemUpdateConvergeCmd.Flags().StringVar(&systemUpdatePolicyPath, "policy", "/var/lib/youeye-state/bootstrap/release-policy.json", "protected first-boot release policy")
	systemUpdateConvergeCmd.Flags().StringVar(&systemUpdateBundlePath, "installed-manifest", "/var/lib/youeye-state/installer/appliance-manifest.json", "installed appliance manifest")
	systemUpdateConvergeCmd.Flags().BoolVar(&systemUpdateReboot, "reboot", false, "accepted for compatibility; the media baseline never restarts")
	for _, command := range []*cobra.Command{systemUpdateCheckCmd, systemUpdateStageCmd} {
		command.Flags().StringVar(&systemUpdateManifest, "manifest", "", "exact system update manifest URL or path (requires --manifest-sha256)")
		command.Flags().StringVar(&systemUpdateManifestSHA, "manifest-sha256", "", "exact expected system update manifest SHA-256")
		command.Flags().BoolVar(&systemUpdateAllowTest, "allow-test-artifact", false, "allow a test-only image")
		command.Flags().BoolVar(&systemUpdateReplaceFailed, "replace-failed", false, "replace a different failed transaction after renewed confirmation")
	}
	systemUpdateActivateCmd.Flags().BoolVar(&systemUpdateReboot, "reboot", false, "reboot immediately after activation")
	systemUpdateReconcileCmd.Flags().BoolVar(&systemUpdateHealthFailed, "health-failed", false, "record an operational health failure")
}

// systemUpdateSourceOptions builds a host-only exact request. Installations
// with a complete core release refuse it and update through "update core".
func systemUpdateSourceOptions() (systemupdate.SourceOptions, error) {
	if strings.TrimSpace(systemUpdateManifest) == "" || strings.TrimSpace(systemUpdateManifestSHA) == "" {
		return systemupdate.SourceOptions{}, errors.New("--manifest and --manifest-sha256 are required")
	}
	return systemupdate.SourceOptions{
		ManifestSource: systemUpdateManifest, ExpectedManifestSHA256: systemUpdateManifestSHA, Channel: "exact-artifact",
		AllowTest: systemUpdateAllowTest, ReplaceFailed: systemUpdateReplaceFailed,
	}, nil
}

func requireImageUpdate() error {
	status, _, err := applianceRuntime()
	if err != nil {
		return err
	}
	if status.Kind != appliance.RuntimeApplianceImage {
		return errors.New("transactional system images are available only on a sealed appliance")
	}
	if !status.Capabilities.ImageUpdate {
		return fmt.Errorf("this appliance predates native system updates; reinstall it")
	}
	return nil
}

func runSystemUpdateStatus(asJSON bool) error {
	status, _, err := applianceRuntime()
	if err != nil {
		return err
	}
	if status.Kind != appliance.RuntimeApplianceImage {
		return errors.New("transactional system update status is available only on a sealed appliance")
	}
	result, err := systemupdate.NewDefault().Status()
	if err != nil {
		return err
	}
	return printSystemUpdateStatus(result, asJSON)
}

func printSystemUpdateStatus(status systemupdate.Status, asJSON bool) error {
	if asJSON {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(status)
	}
	fmt.Printf("System update: %s\n", status.State)
	fmt.Printf("  Running: %s (System %s)\n", status.RunningImage, status.ActiveSlot)
	if status.TargetImage != "" {
		fmt.Printf("  Target:  %s (System %s)\n", status.TargetImage, status.CandidateSlot)
	}
	if status.RebootRequired {
		fmt.Println("  Reboot required: yes")
	}
	if status.Error != "" {
		fmt.Printf("  Last error: %s\n", status.Error)
	}
	return nil
}

func printJSONOrSummary(value any, asJSON bool) error {
	if asJSON {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(value)
	}
	if result, ok := value.(systemupdate.ReconcileResult); ok {
		return printSystemUpdateStatus(result.Status, false)
	}
	return json.NewEncoder(os.Stdout).Encode(value)
}
