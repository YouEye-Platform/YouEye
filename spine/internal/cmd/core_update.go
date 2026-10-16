package cmd

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/util"
)

var coreUpdatePolicyPath string
var coreUpdateCmd = &cobra.Command{Use: "core", Short: "Manage one complete signed YouEye System release"}
var coreInitializeCmd = &cobra.Command{
	Use: "initialize", Hidden: true, Short: "Record the exact fresh installed release after native health verification",
	RunE: func(cmd *cobra.Command, args []string) error {
		return initializeInstalledCore(cmd.Context(), coreUpdatePolicyPath)
	},
}

func init() {
	coreInitializeCmd.Flags().StringVar(&coreUpdatePolicyPath, "policy", filepath.Join(systemupdate.CoreBootstrapPath, "release-policy.json"), "protected first-boot release policy")
	coreUpdateCmd.AddCommand(coreInitializeCmd)
	updateCmd.AddCommand(coreUpdateCmd)
}

func installedCoreMachine() (systemupdate.CoreMachineIdentity, error) {
	s, err := appliance.LoadState(appliance.StatePath)
	if err != nil {
		return systemupdate.CoreMachineIdentity{}, err
	}
	i := systemupdate.CoreMachineIdentity{InstallIDRef: s.InstallIDRef, DeviceIDRef: s.DeviceIDRef, ParentDiskID: s.ParentDiskID, StatePartUUID: s.StatePartUUID, DataPartUUID: s.DataPartUUID}
	return i, i.Validate()
}

func initializeInstalledCore(ctx context.Context, policyPath string) error {
	policy, err := systemupdate.LoadReleasePolicy(policyPath)
	if err != nil {
		return err
	}
	if policy.CoreManifestSHA256 == "" {
		return fmt.Errorf("fresh core initialization requires an installed new-format selection")
	}
	root := filepath.Dir(policyPath)
	raw, err := systemupdate.ReadCoreState(filepath.Join(root, "core-release.json"), 1<<20)
	if err != nil {
		return err
	}
	sig, err := systemupdate.ReadCoreState(filepath.Join(root, "core-release.json.sig"), 64)
	if err != nil {
		return err
	}
	m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	receipt, err := m.Initialize(ctx, systemupdate.CoreHostSelection{Raw: raw, Signature: sig}, policy.CoreManifestSHA256, systemupdate.CoreDevelopmentTrustPath,
		func(ctx context.Context, release releasecache.CoreRelease) (systemupdate.CoreMachineIdentity, string, error) {
			if err := ctx.Err(); err != nil {
				return systemupdate.CoreMachineIdentity{}, "", err
			}
			if _, err := systemupdate.VerifyCoreInstalledMedia(policy, root, appliance.ManifestPath,
				"/var/lib/youeye-state/installer/appliance-manifest.json", "/var/lib/youeye-state/installer/appliance-manifest.json.sig", systemupdate.CoreDevelopmentTrustPath); err != nil {
				return systemupdate.CoreMachineIdentity{}, "", err
			}
			health := collectApplianceHealth("operational")
			if health.ExitCode != healthExitHealthy {
				return systemupdate.CoreMachineIdentity{}, "", fmt.Errorf("fresh core has not passed native operational and exact payload health")
			}
			hostIP, err := util.ReadStoredHostIP()
			if err != nil || hostIP == "" {
				return systemupdate.CoreMachineIdentity{}, "", fmt.Errorf("fresh deployment has no verified host identity")
			}
			if err := verifyDeploymentCompletion(hostIP); err != nil {
				return systemupdate.CoreMachineIdentity{}, "", err
			}
			if err := verifyFreshCorePayloads(ctx, m, systemupdate.CoreHostSelection{Raw: raw, Signature: sig}); err != nil {
				return systemupdate.CoreMachineIdentity{}, "", err
			}
			machine, err := installedCoreMachine()
			return machine, "fresh-media/exact-service-membership/installed-static-files/operational-health/bridge-and-cli-binding", err
		})
	if err != nil {
		return err
	}
	fmt.Printf("Recorded installed YouEye %s (%s)\n", receipt.Release.Version, receipt.ManifestSHA256)
	return nil
}

func verifyFreshCorePayloads(ctx context.Context, m systemupdate.CoreManager, selection systemupdate.CoreHostSelection) error {
	configuration := GetConfig()
	cache := systemupdate.CoreArtifactCache{Root: "/var/lib/youeye/cache/core-update", TrustKeyPath: systemupdate.CoreDevelopmentTrustPath}
	release, _, err := cache.StageFreshServices(ctx, selection)
	if err != nil {
		return fmt.Errorf("retain fresh service verification inputs: %w", err)
	}
	for _, member := range release.Members {
		if member.Role != "cp" && member.Role != "ui" {
			continue
		}
		index, err := cache.IndexMember(member, release.Channel)
		if err != nil {
			return fmt.Errorf("derive %s installed payload identity: %w", member.Role, err)
		}
		name, appDir := configuration.Deployment.Container.Name, configuration.Deployment.ControlPanel.AppDir
		if member.Role == "ui" {
			name, appDir = configuration.Deployment.UI.ContainerName, configuration.Deployment.UI.AppDir
		}
		if err := systemupdate.VerifyCoreContainerPayload(ctx, name, appDir, index); err != nil {
			return fmt.Errorf("verify installed %s: %w", member.Role, err)
		}
		if err := m.SavePayloadIndex(index); err != nil {
			return err
		}
	}
	return nil
}
