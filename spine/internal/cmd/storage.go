package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"

	"github.com/youeye-platform/YouEye/spine/internal/incus"
	hoststorage "github.com/youeye-platform/YouEye/spine/internal/storage"
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

	// ── Pool layout ──
	printPoolLayout(snap)

	if plan.IncusGrow {
		fmt.Printf("  Incus action: grow by %s\n", hoststorage.FormatBytes(plan.IncusGrowBytes))
	} else if plan.IncusTargetBytes > 0 {
		fmt.Printf("  Incus loop target: %s (managed loop pools only)\n", hoststorage.FormatBytes(plan.IncusTargetBytes))
	}
}

// printPoolLayout describes the live storage topology: dedicated-disk (ZFS
// pool with YouEye marker + datasets), managed loop pool, or dir driver.
func printPoolLayout(snap hoststorage.Snapshot) {
	if snap.IncusPool == nil {
		fmt.Println("  Incus pool: not initialized")
		return
	}
	pool := snap.IncusPool

	switch {
	case pool.Driver == "dir":
		fmt.Printf("  Storage mode: dir (directory-backed, no quotas), source %s\n", emptyDash(pool.Source))
		fmt.Println("  Data location: /var/lib/youeye on the root filesystem")
	case pool.Driver == "zfs" && pool.ManagedLoop:
		fmt.Printf("  Storage mode: managed ZFS loop pool\n")
		fmt.Printf("  Loop image: %s\n", emptyDash(pool.Source))
		fmt.Printf("  Pool size: planned %s\n", emptyDash(pool.ConfigSize))
		printLivePoolSize()
		fmt.Println("  Data location: /var/lib/youeye on the root filesystem")
	case pool.Driver == "zfs":
		// Real ZFS pool: dedicated-disk (source default/incus) or legacy (default).
		marker := hoststorage.PoolComment(hoststorage.PoolName)
		if marker == hoststorage.PoolMarker {
			fmt.Printf("  Storage mode: dedicated-disk ZFS pool (YouEye-owned, marker=%q)\n", marker)
		} else {
			fmt.Printf("  Storage mode: ZFS pool (legacy layout, no YouEye marker)\n")
		}
		fmt.Printf("  Incus source: %s\n", emptyDash(pool.Source))
		printDatasetLayout()
		printLivePoolSize()
	default:
		fmt.Printf("  Incus pool: %s, source %s\n", pool.Driver, emptyDash(pool.Source))
	}
}

// printDatasetLayout lists the YouEye pool datasets and where default/data is
// mounted.
func printDatasetLayout() {
	if hoststorage.DatasetExists(hoststorage.IncusDataset) {
		fmt.Printf("  Dataset %s: Incus-owned container storage\n", hoststorage.IncusDataset)
	}
	if hoststorage.DatasetExists(hoststorage.DataDataset) {
		mounted := "not mounted"
		if hoststorage.DatasetMounted(hoststorage.DataDataset) {
			mounted = "mounted at " + hoststorage.DataMountpoint
		}
		fmt.Printf("  Dataset %s: YouEye app data (%s)\n", hoststorage.DataDataset, mounted)
	}
}

// printLivePoolSize prints the actual zpool size when readable.
func printLivePoolSize() {
	out, err := exec.Command("zpool", "list", "-Hp", "-o", "size,alloc,free", hoststorage.PoolName).Output()
	if err != nil {
		return
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) < 3 {
		return
	}
	fmt.Printf("  Pool size: actual %s (%s allocated, %s free)\n",
		hoststorage.FormatBytes(hoststorage.ParseSizeBytes(fields[0])),
		hoststorage.FormatBytes(hoststorage.ParseSizeBytes(fields[1])),
		hoststorage.FormatBytes(hoststorage.ParseSizeBytes(fields[2])))
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
