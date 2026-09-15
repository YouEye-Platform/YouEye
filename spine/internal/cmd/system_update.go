package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var (
	systemUpdateManifest      string
	systemUpdateSignature     string
	systemUpdateChannel       string
	systemUpdateBranch        string
	systemUpdateExactTag      string
	systemUpdateManifestSHA   string
	systemUpdateProvider      string
	systemUpdateReleasesAPI   string
	systemUpdateAllowTest     bool
	systemUpdateReplaceFailed bool
	systemUpdateBootstrap     bool
	systemUpdateJSON          bool
	systemUpdateReboot        bool
	systemUpdateHealthFailed  bool
	systemUpdatePolicyPath    string
	systemUpdateBundlePath    string
	systemUpdateBundleSigPath string
)

var systemUpdateStatusCmd = &cobra.Command{
	Use: "status", Short: "Show the durable appliance system update state",
	RunE: func(cmd *cobra.Command, args []string) error { return runSystemUpdateStatus(systemUpdateJSON) },
}

var systemUpdateCheckCmd = &cobra.Command{
	Use: "check", Short: "Verify and record an exact signed system update",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireImageUpdate(systemUpdateBootstrap); err != nil {
			return err
		}
		options, err := systemUpdateSourceOptions(cmd.Context())
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
		if err := requireImageUpdate(systemUpdateBootstrap); err != nil {
			return err
		}
		manager := systemupdate.NewDefault()
		options, err := systemUpdateSourceOptions(cmd.Context())
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
		if err := requireImageUpdate(systemUpdateBootstrap); err != nil {
			return err
		}
		manager := systemupdate.NewDefault()
		var status systemupdate.Status
		var err error
		if systemUpdateBootstrap {
			status, err = manager.ActivateBootstrap(cmd.Context(), systemUpdateReboot)
		} else {
			status, err = manager.Activate(cmd.Context(), systemUpdateReboot)
		}
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
	Use: "converge", Short: "Converge first boot to one signed platform bundle", Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireImageUpdate(false); err != nil {
			return err
		}
		policy, err := systemupdate.LoadReleasePolicy(systemUpdatePolicyPath)
		if err != nil {
			return err
		}
		var result systemupdate.ConvergenceResult
		if policy.Mode == "exact" {
			result, err = systemupdate.VerifyExactInstalled(
				policy, appliance.ManifestPath, systemUpdateBundlePath, systemUpdateBundleSigPath,
				"/usr/share/youeye/appliance-development.pub",
			)
			if err != nil {
				result, err = systemupdate.NewDefault().VerifyHealthyPromotedExact(policy, systemUpdateBundlePath, systemUpdateBundleSigPath)
			}
		} else {
			var candidates []systemupdate.SourceOptions
			candidates, err = systemupdate.ResolvePolicyCandidates(cmd.Context(), systemupdate.ReleaseHTTPClient(), policy)
			if err != nil && policy.Freshness == "prefer-current" {
				result, err = systemupdate.VerifyCurrentTrack(policy, appliance.ManifestPath)
			} else if err == nil {
				result, err = systemupdate.NewDefault().Converge(cmd.Context(), candidates, systemUpdateReboot)
			}
		}
		if err != nil {
			return err
		}
		return printJSONOrSummary(result, systemUpdateJSON)
	},
}

func init() {
	for _, command := range []*cobra.Command{systemUpdateStatusCmd, systemUpdateCheckCmd, systemUpdateStageCmd, systemUpdateActivateCmd, systemUpdateReconcileCmd, systemUpdateMarkHealthyCmd, systemUpdateConvergeCmd} {
		command.Flags().BoolVar(&systemUpdateJSON, "json", false, "emit machine-readable JSON")
		updateSystemCmd.AddCommand(command)
	}
	systemUpdateConvergeCmd.Flags().StringVar(&systemUpdatePolicyPath, "policy", "/var/lib/youeye-state/bootstrap/release-policy.json", "protected first-boot release policy")
	systemUpdateConvergeCmd.Flags().StringVar(&systemUpdateBundlePath, "installed-manifest", "/var/lib/youeye-state/installer/appliance-manifest.json", "installed signed appliance manifest")
	systemUpdateConvergeCmd.Flags().StringVar(&systemUpdateBundleSigPath, "installed-signature", "/var/lib/youeye-state/installer/appliance-manifest.json.sig", "installed appliance manifest signature")
	systemUpdateConvergeCmd.Flags().BoolVar(&systemUpdateReboot, "reboot", false, "restart into a required inactive System slot")
	for _, command := range []*cobra.Command{systemUpdateCheckCmd, systemUpdateStageCmd} {
		command.Flags().StringVar(&systemUpdateManifest, "manifest", "", "exact signed system update manifest URL or path")
		command.Flags().StringVar(&systemUpdateSignature, "signature", "", "detached manifest signature URL or path (defaults to manifest + .sig)")
		command.Flags().StringVar(&systemUpdateChannel, "channel", "", "signed appliance channel: stable, development, or exact")
		command.Flags().StringVar(&systemUpdateBranch, "branch", "", "signed branch-associated release track")
		command.Flags().StringVar(&systemUpdateExactTag, "exact-tag", "", "exact appliance release tag")
		command.Flags().StringVar(&systemUpdateManifestSHA, "manifest-sha256", "", "exact expected system update manifest SHA-256")
		command.Flags().StringVar(&systemUpdateProvider, "provider", systemupdate.DefaultReleaseProvider, "release provider: github, forgejo, or custom")
		command.Flags().StringVar(&systemUpdateReleasesAPI, "releases-api", "", "HTTPS appliance releases API (required for Forgejo or custom)")
		command.Flags().BoolVar(&systemUpdateAllowTest, "allow-test-artifact", false, "allow a signed test-only image")
		command.Flags().BoolVar(&systemUpdateReplaceFailed, "replace-failed", false, "replace a different failed transaction after renewed confirmation")
		command.Flags().BoolVar(&systemUpdateBootstrap, "bootstrap-plan1", false, "authorize the signed first transition from the pre-updater Plan 1 image")
	}
	systemUpdateActivateCmd.Flags().BoolVar(&systemUpdateBootstrap, "bootstrap-plan1", false, "authorize the signed first transition from the pre-updater Plan 1 image")
	systemUpdateActivateCmd.Flags().BoolVar(&systemUpdateReboot, "reboot", false, "reboot immediately after activation")
	systemUpdateReconcileCmd.Flags().BoolVar(&systemUpdateHealthFailed, "health-failed", false, "record an operational health failure")
}

func systemUpdateSourceOptions(ctx context.Context) (systemupdate.SourceOptions, error) {
	if strings.TrimSpace(systemUpdateManifest) == "" {
		options, _, err := systemupdate.ResolveRelease(ctx, systemupdate.ReleaseHTTPClient(), systemupdate.ReleaseSelection{
			Provider: systemUpdateProvider,
			Channel:  systemUpdateChannel, Branch: systemUpdateBranch, ExactTag: systemUpdateExactTag,
			ManifestSHA256: systemUpdateManifestSHA, ReleasesAPI: systemUpdateReleasesAPI,
		})
		if err != nil {
			return systemupdate.SourceOptions{}, err
		}
		options.AllowTest = systemUpdateAllowTest
		options.ReplaceFailed = systemUpdateReplaceFailed
		options.Bootstrap = systemUpdateBootstrap
		return options, nil
	}
	if strings.TrimSpace(systemUpdateChannel) != "" || strings.TrimSpace(systemUpdateBranch) != "" || strings.TrimSpace(systemUpdateExactTag) != "" || strings.TrimSpace(systemUpdateProvider) != systemupdate.DefaultReleaseProvider || strings.TrimSpace(systemUpdateReleasesAPI) != "" {
		return systemupdate.SourceOptions{}, errors.New("--manifest cannot be combined with --provider, --releases-api, --channel, --branch, or --exact-tag")
	}
	return systemupdate.SourceOptions{
		ManifestSource: systemUpdateManifest, SignatureSource: systemUpdateSignature,
		ExpectedManifestSHA256: systemUpdateManifestSHA, Channel: "exact-artifact",
		AllowTest: systemUpdateAllowTest, ReplaceFailed: systemUpdateReplaceFailed,
		Bootstrap: systemUpdateBootstrap,
	}, nil
}

func requireImageUpdate(bootstrap bool) error {
	status, _, err := applianceRuntime()
	if err != nil {
		return err
	}
	if status.Kind != appliance.RuntimeApplianceImage {
		return errors.New("transactional system images are available only on a sealed appliance")
	}
	if status.Capabilities.ImageUpdate {
		if bootstrap {
			return errors.New("--bootstrap-plan1 is only valid on the pre-updater Plan 1 image")
		}
		return nil
	}
	if bootstrap {
		return nil
	}
	return fmt.Errorf("this appliance predates native system updates; use the signed Plan 1 bootstrap artifact once")
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
