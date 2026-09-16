package cmd

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/incus"
	hoststorage "github.com/youeye-platform/YouEye/spine/internal/storage"
)

func applianceRuntime() (appliance.RuntimeStatus, *appliance.Manifest, error) {
	status, manifest, err := appliance.Detect()
	if err != nil {
		return status, manifest, fmt.Errorf("sealed appliance marker is present but invalid; boot recovery: %w", err)
	}
	return status, manifest, nil
}

func requireRuntimeCapability(action string) error {
	status, _, err := applianceRuntime()
	if err != nil {
		return err
	}
	return appliance.RequireCapability(status, action)
}

func resolveApplianceStorage(manifest appliance.Manifest) (hoststorage.StorageDecision, error) {
	contract, err := appliance.DiscoverPartitions()
	if err != nil {
		return hoststorage.StorageDecision{}, fmt.Errorf("discover appliance persistent partitions: %w", err)
	}
	state, err := appliance.LoadOrInitializeState(manifest, contract)
	if err != nil {
		return hoststorage.StorageDecision{}, err
	}
	if state.Lifecycle == appliance.LifecycleRepairRequired {
		return hoststorage.StorageDecision{}, fmt.Errorf("appliance persistent state requires repair; boot recovery")
	}
	partition := "/dev/disk/by-partuuid/" + contract.DataPartUUID
	decision := hoststorage.StorageDecision{
		Kind: hoststorage.DecisionAdoptAppliancePartition,
		Disk: partition, ParentDisk: contract.ParentDevice,
		PartUUID: contract.DataPartUUID, StatePartUUID: contract.StatePartUUID,
		LayoutVersion: manifest.DiskLayoutVersion, ZFSCompatibilityProfile: manifest.ZFSFeatureProfile, DataOnZFS: true,
		Reason: fmt.Sprintf("sealed appliance image; using installer-owned %s partition %s without touching parent disk %s", appliance.DataPartitionLabel, contract.DataPartUUID, contract.ParentDevice),
	}
	if !hoststorage.ZpoolExists(hoststorage.PoolName) {
		// An existing but unimported appliance pool is recovery state, not a
		// blank partition. Never let zpool -f silently replace it.
		if out, err := exec.Command("zpool", "import", "-N", "-d", partition, hoststorage.PoolName).CombinedOutput(); err == nil {
			if err := hoststorage.ValidateAppliancePartitionPool(partition, contract.DataPartUUID, manifest.DiskLayoutVersion, manifest.ZFSFeatureProfile); err != nil {
				return hoststorage.StorageDecision{}, fmt.Errorf("validate imported appliance pool: %w; boot recovery", err)
			}
			return decision, nil
		} else if signature, _ := exec.Command("blkid", "-o", "value", "-s", "TYPE", partition).CombinedOutput(); strings.TrimSpace(string(signature)) != "" {
			return hoststorage.StorageDecision{}, fmt.Errorf("YE-DATA contains an unrecognized or non-importable storage signature; boot recovery rather than replacing persistent data: %s", strings.TrimSpace(string(out)))
		}
		decision.CreatePool = true
		return decision, nil
	}
	if err := hoststorage.ValidateAppliancePartitionPool(partition, contract.DataPartUUID, manifest.DiskLayoutVersion, manifest.ZFSFeatureProfile); err != nil {
		return hoststorage.StorageDecision{}, fmt.Errorf("validate imported appliance pool: %w; boot recovery", err)
	}
	return decision, nil
}

func prepareAppliancePartitionStorage(decision hoststorage.StorageDecision) error {
	status, manifest, err := applianceRuntime()
	if err != nil {
		return err
	}
	if status.Kind != appliance.RuntimeApplianceImage || manifest == nil {
		return fmt.Errorf("appliance partition decision cannot be applied on runtime %s", status.Kind)
	}
	prepare := func() error {
		if decision.CreatePool {
			if err := hoststorage.CreateAppliancePartitionPool(decision.Disk, decision.PartUUID, decision.LayoutVersion, decision.ZFSCompatibilityProfile); err != nil {
				return err
			}
		}
		if err := hoststorage.ValidateAppliancePartitionPool(decision.Disk, decision.PartUUID, decision.LayoutVersion, decision.ZFSCompatibilityProfile); err != nil {
			return err
		}
		return hoststorage.EnsureAppliancePoolLayout()
	}
	if err := preserveInstallerSeedsAcrossDataMount(hoststorage.DataMountpoint, prepare); err != nil {
		return err
	}
	state, err := appliance.LoadState(appliance.StatePath)
	if err != nil {
		return fmt.Errorf("reload appliance state: %w", err)
	}
	if _, err := appliance.EnsureDataSchema(state, *manifest); err != nil {
		return err
	}
	return nil
}

func verifyApplianceImagePrerequisites(manifest appliance.Manifest) error {
	return incus.VerifyBakedPrerequisites(manifest)
}

func enableBakedSpineService() error {
	if err := stopDetachedAPIServer(); err != nil {
		return err
	}
	out, err := exec.Command("systemctl", "show", "youeye.service", "-p", "FragmentPath", "--value").CombinedOutput()
	if err != nil {
		return fmt.Errorf("inspect baked youeye.service: %w: %s", err, strings.TrimSpace(string(out)))
	}
	fragment := strings.TrimSpace(string(out))
	want := "/usr/lib/systemd/system/youeye.service"
	resolved, resolveErr := filepath.EvalSymlinks(fragment)
	if resolveErr == nil {
		fragment = resolved
	}
	if fragment != want {
		return fmt.Errorf("youeye.service must be the baked vendor unit %s (found %q); boot recovery", want, fragment)
	}
	if err := verifySystemdState("youeye.service", "is-enabled", "enabled"); err != nil {
		return fmt.Errorf("baked image must preset youeye.service enabled: %w", err)
	}
	if out, err := exec.Command("systemctl", "start", "youeye.service").CombinedOutput(); err != nil {
		return fmt.Errorf("start baked youeye.service: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if err := verifySystemdState("youeye.service", "is-active", "active"); err != nil {
		return err
	}
	if err := waitForSocket(GetConfig().API.SocketPath, 5*time.Second); err != nil {
		if out, restartErr := exec.Command("systemctl", "restart", "youeye.service").CombinedOutput(); restartErr != nil {
			return fmt.Errorf("repair baked youeye.service API socket: %w: %s", restartErr, strings.TrimSpace(string(out)))
		}
		if retryErr := waitForSocket(GetConfig().API.SocketPath, 5*time.Second); retryErr != nil {
			return fmt.Errorf("baked youeye.service API socket is unavailable after restart: %w", retryErr)
		}
	}
	return verifyLoadedIncusDependency()
}

func verifyLoadedIncusDependency() error {
	for _, property := range []string{"After", "Wants"} {
		out, err := exec.Command("systemctl", "show", "incus-startup.service", "-p", property, "--value").CombinedOutput()
		if err != nil {
			return fmt.Errorf("read loaded Incus %s dependency: %w: %s", property, err, strings.TrimSpace(string(out)))
		}
		if !strings.Contains(string(out), "youeye.service") {
			return fmt.Errorf("baked Incus %s dependency does not include youeye.service", property)
		}
	}
	return nil
}
