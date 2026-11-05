package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/youeye-platform/YouEye/spine/internal/container"
	"github.com/youeye-platform/YouEye/spine/internal/incus"
	hoststorage "github.com/youeye-platform/YouEye/spine/internal/storage"
)

var installCmd = &cobra.Command{
	Use:   "install",
	Short: "Install components",
	Long:  `Install Incus or Control Panel components.`,
}

var installIncusCmd = &cobra.Command{
	Use:   "incus",
	Short: "Install and initialize Incus",
	RunE: func(cmd *cobra.Command, args []string) error {
		return installIncus()
	},
}

var installControlCmd = &cobra.Command{
	Use:   "control",
	Short: "Deploy Control Panel container",
	RunE: func(cmd *cobra.Command, args []string) error {
		return installControl()
	},
}

func init() {
	installCmd.AddCommand(installIncusCmd)
	installCmd.AddCommand(installControlCmd)
}

func installIncus() error {
	// Reuse the decision resolved (and storage prepared) by runDeploy when
	// present. Only re-resolve + prepare when invoked standalone.
	if deployStorageDecision != nil {
		opts := incus.InstallOptions{
			DesiredZFSSize: deployStoragePlan.IncusTargetSize(),
			AutoGrowZFS:    deployStoragePolicy.AutoGrowIncus,
			Decision:       *deployStorageDecision,
		}
		if opts.Decision.Kind == hoststorage.DecisionAdoptAppliancePartition {
			return incus.ReconcileAppliance(opts)
		}
		return incus.InstallWithOptions(opts)
	}

	decision, plan, policy, err := resolveStorageDecision()
	if err != nil {
		return err
	}
	if decision.Hint != "" {
		fmt.Printf("  ℹ %s\n", decision.Hint)
	}
	if decision.Kind == hoststorage.DecisionFail {
		return fmt.Errorf("storage: %s", decision.Reason)
	}
	fmt.Printf("  Storage plan: %s — %s\n", decision.Kind, decision.Reason)

	// Ensure the data storage exists+mounted BEFORE any container is created.
	// For loop-pool single-disk machines, install ZFS first so the explicitly
	// sized pool can be created (replacing the old dir fallback).
	if err := prepareApplianceStorage(decision); err != nil {
		return err
	}

	opts := incus.InstallOptions{
		DesiredZFSSize: plan.IncusTargetSize(),
		AutoGrowZFS:    policy.AutoGrowIncus,
		Decision:       decision,
	}
	if decision.Kind == hoststorage.DecisionAdoptAppliancePartition {
		return incus.ReconcileAppliance(opts)
	}
	return incus.InstallWithOptions(opts)
}

// resolveStorageDecision runs the appliance storage growth planner and then the
// deploy storage decision tree, returning the resolved decision, the final
// storage plan, and the policy.
func resolveStorageDecision() (hoststorage.StorageDecision, hoststorage.Plan, hoststorage.Policy, error) {
	cfg := GetConfig()
	policy := hoststorage.PolicyFromConfig(cfg.Deployment.Storage)
	status, manifest, err := applianceRuntime()
	if err != nil {
		return hoststorage.StorageDecision{}, hoststorage.Plan{}, policy, err
	}
	if status.Kind == "appliance-image" {
		if manifest == nil {
			return hoststorage.StorageDecision{}, hoststorage.Plan{}, policy, fmt.Errorf("appliance manifest is unavailable")
		}
		if err := verifyApplianceImagePrerequisites(*manifest); err != nil {
			return hoststorage.StorageDecision{}, hoststorage.Plan{}, policy, err
		}
		decision, err := resolveApplianceStorage(*manifest)
		return decision, hoststorage.Plan{}, policy, err
	}

	result, err := hoststorage.EnsureApplianceStorage(policy)
	if err != nil {
		return hoststorage.StorageDecision{}, hoststorage.Plan{}, policy, fmt.Errorf("storage preparation failed: %w", err)
	}
	plan := result.FinalPlan

	inputs := hoststorage.CollectDecisionInputs(
		policy,
		plan.RootTotalAfterBytes,
		plan.RootAvailAfterBytes,
		plan.IncusTargetBytes,
		incus.ZFSAvailable(),
	)
	decision := hoststorage.ResolveDecision(inputs)
	return decision, plan, policy, nil
}

// prepareApplianceStorage performs the effectful storage setup that must run
// BEFORE createDataDirectories() and Incus init:
//   - CreateOnDisk: install ZFS, create the YouEye pool on the blank disk,
//     create+mount default/data at /var/lib/youeye.
//   - AdoptMarkedPool: ensure default/data exists+mounted.
//   - LoopPool: install ZFS (so the explicitly sized loop pool is possible).
//   - ReuseLegacyPool / Dir: nothing (data stays on root; Incus creates the pool).
func prepareApplianceStorage(decision hoststorage.StorageDecision) error {
	switch decision.Kind {
	case hoststorage.DecisionCreateOnDisk:
		if err := incus.InstallZFS(); err != nil {
			return fmt.Errorf("installing ZFS for dedicated data disk: %w", err)
		}
		disk := decision.Disk
		if byID := hoststorage.ResolveDiskByID(disk); byID != "" {
			disk = byID
		}
		fmt.Printf("  Claiming blank disk %s for YouEye ZFS pool %q...\n", disk, hoststorage.PoolName)
		if err := preserveInstallerSeedsAcrossDataMount(hoststorage.DataMountpoint, func() error {
			return hoststorage.CreateYouEyePool(disk)
		}); err != nil {
			return fmt.Errorf("creating YouEye pool on %s: %w", disk, err)
		}
		fmt.Printf("  ✓ Pool %q created; %s mounted at %s\n", hoststorage.PoolName, hoststorage.DataDataset, hoststorage.DataMountpoint)
	case hoststorage.DecisionAdoptMarkedPool:
		fmt.Printf("  Ensuring %s is mounted at %s...\n", hoststorage.DataDataset, hoststorage.DataMountpoint)
		if err := preserveInstallerSeedsAcrossDataMount(hoststorage.DataMountpoint, hoststorage.EnsureMarkedPoolLayout); err != nil {
			return fmt.Errorf("preparing marked pool layout: %w", err)
		}
		fmt.Printf("  ✓ %s mounted at %s\n", hoststorage.DataDataset, hoststorage.DataMountpoint)
	case hoststorage.DecisionAdoptAppliancePartition:
		fmt.Printf("  Preparing persistent appliance datasets on YE-DATA PARTUUID %s...\n", decision.PartUUID)
		if err := prepareAppliancePartitionStorage(decision); err != nil {
			return fmt.Errorf("preparing appliance partition storage: %w", err)
		}
		fmt.Printf("  ✓ %s and %s mounted without modifying parent disk %s\n", hoststorage.DataDataset, hoststorage.IncusStateDataset, decision.ParentDisk)
	case hoststorage.DecisionLoopPool:
		if err := incus.InstallZFS(); err != nil {
			return fmt.Errorf("installing ZFS for managed loop pool: %w", err)
		}
	}
	return nil
}

func installControl() error {
	cfg := GetConfig()
	return container.DeployControlPanel(cfg)
}
