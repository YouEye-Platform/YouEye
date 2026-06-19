package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"git.potemk.in/potemsla/YouEye/spine/internal/incus"
	hoststorage "git.potemk.in/potemsla/YouEye/spine/internal/storage"
)

var storagePlanJSON bool

var storageCmd = &cobra.Command{
	Use:   "storage",
	Short: "Inspect and repair host storage for YouEye",
}

var storageStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show YouEye storage status and planned actions",
	RunE: func(cmd *cobra.Command, args []string) error {
		result, err := planStorage()
		if err != nil {
			return err
		}
		if storagePlanJSON {
			return printStorageJSON(result)
		}
		printStorageStatus(result)
		return nil
	},
}

var storageGrowCmd = &cobra.Command{
	Use:   "grow",
	Short: "Apply safe appliance storage growth",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg := GetConfig()
		policy := hoststorage.PolicyFromConfig(cfg.Deployment.Storage)
		result, err := hoststorage.EnsureApplianceStorage(policy)
		if err != nil {
			return err
		}
		if policy.AutoGrowIncus {
			if err := incus.GrowDefaultManagedZFSLoopPool(result.FinalPlan.IncusTargetSize()); err != nil {
				return err
			}
		}
		return nil
	},
}

var storagePlanCmd = &cobra.Command{
	Use:   "plan",
	Short: "Show the storage plan as JSON",
	RunE: func(cmd *cobra.Command, args []string) error {
		result, err := planStorage()
		if err != nil {
			return err
		}
		return printStorageJSON(result)
	},
}

func init() {
	storageStatusCmd.Flags().BoolVar(&storagePlanJSON, "json", false, "print storage plan as JSON")
	storageCmd.AddCommand(storageStatusCmd)
	storageCmd.AddCommand(storageGrowCmd)
	storageCmd.AddCommand(storagePlanCmd)
}

func planStorage() (hoststorage.Result, error) {
	cfg := GetConfig()
	policy := hoststorage.PolicyFromConfig(cfg.Deployment.Storage)
	return hoststorage.PlanCurrentStorage(policy), nil
}

func printStorageStatus(result hoststorage.Result) {
	snap := result.FinalSnapshot
	plan := result.FinalPlan
	fmt.Println("YouEye Storage")
	fmt.Printf("  Root source: %s\n", emptyDash(snap.RootSource))
	fmt.Printf("  Root filesystem: %s\n", emptyDash(snap.RootFSType))
	fmt.Printf("  Root size: %s total, %s free\n", hoststorage.FormatBytes(snap.RootTotalBytes), hoststorage.FormatBytes(snap.RootAvailBytes))
	if plan.RootGrow {
		fmt.Printf("  Root action: grow by %s\n", hoststorage.FormatBytes(plan.RootGrowBytes))
	} else {
		fmt.Printf("  Root action: unchanged (%s)\n", joinOrDash(plan.RootSkipReasons))
	}
	if snap.IncusPool != nil {
		fmt.Printf("  Incus pool: %s %s, source %s\n", snap.IncusPool.Driver, emptyDash(snap.IncusPool.ConfigSize), emptyDash(snap.IncusPool.Source))
	} else {
		fmt.Println("  Incus pool: not initialized")
	}
	if plan.IncusTargetBytes > 0 {
		fmt.Printf("  Incus target: %s\n", hoststorage.FormatBytes(plan.IncusTargetBytes))
	} else {
		fmt.Printf("  Incus target: unavailable (%s)\n", joinOrDash(plan.IncusSkipReasons))
	}
	if plan.IncusGrow {
		fmt.Printf("  Incus action: grow by %s\n", hoststorage.FormatBytes(plan.IncusGrowBytes))
	} else {
		fmt.Printf("  Incus action: unchanged (%s)\n", joinOrDash(plan.IncusSkipReasons))
	}
}

func printStorageJSON(result hoststorage.Result) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(result)
}

func emptyDash(v string) string {
	if v == "" {
		return "-"
	}
	return v
}

func joinOrDash(values []string) string {
	if len(values) == 0 {
		return "-"
	}
	return strings.Join(values, "; ")
}
