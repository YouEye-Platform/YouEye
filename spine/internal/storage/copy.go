package storage

import (
	"fmt"
	"os/exec"
	"strings"
)

// MountIndependentCopyData opens only an existing installer-owned pool. It has
// no create, repair, force-import or dataset-property fallback. The caller has
// already bound the copied State partition to an exact native copy request.
func MountIndependentCopyData(partition, partUUID string, layoutVersion int, compatibilityProfile string) error {
	if !ZpoolExists(PoolName) {
		if err := exec.Command("zpool", "import", "-N", "-d", partition, PoolName).Run(); err != nil {
			return fmt.Errorf("copied appliance pool cannot be imported without recovery")
		}
	}
	if err := ValidateAppliancePartitionPool(partition, partUUID, layoutVersion, compatibilityProfile); err != nil {
		return err
	}
	return mountExistingCopyDatasets(func(program string, args ...string) (string, error) {
		out, err := exec.Command(program, args...).Output()
		return strings.TrimSpace(string(out)), err
	})
}

func mountExistingCopyDatasets(run func(string, ...string) (string, error)) error {
	paths := []struct{ dataset, mountpoint string }{
		{PoolName + "/data", DataMountpoint},
		{PoolName + "/incus-state", IncusStateMountpoint},
	}
	// Validate the entire existing layout before mounting any member.
	for _, path := range paths {
		value, err := run("zfs", "get", "-H", "-o", "value", "mountpoint", path.dataset)
		if err != nil || value != path.mountpoint {
			return fmt.Errorf("copied dataset %s is absent or has a different mountpoint", path.dataset)
		}
		value, err = run("zfs", "get", "-H", "-o", "value", "canmount", path.dataset)
		if err != nil || (value != "on" && value != "noauto") {
			return fmt.Errorf("copied dataset %s is not mountable", path.dataset)
		}
	}
	for _, path := range paths {
		value, err := run("zfs", "get", "-H", "-o", "value", "mounted", path.dataset)
		if err != nil || (value != "yes" && value != "no") {
			return fmt.Errorf("copied dataset mount state unavailable")
		}
		if value == "no" {
			if _, err = run("zfs", "mount", path.dataset); err != nil {
				return fmt.Errorf("copied dataset %s requires mount reconciliation", path.dataset)
			}
		}
		value, err = run("findmnt", "-n", "-o", "FSTYPE,SOURCE", "--mountpoint", path.mountpoint)
		fields := strings.Fields(value)
		if err != nil || len(fields) != 2 || fields[0] != "zfs" || fields[1] != path.dataset {
			return fmt.Errorf("copy data mount does not resolve to its exact existing dataset")
		}
	}
	return nil
}
