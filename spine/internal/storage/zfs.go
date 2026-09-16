package storage

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// This file holds the imperative ZFS operations used by the deploy decision
// tree and cleanup. They shell out to zpool/zfs. Keep the command shapes in
// lockstep with the installer's guest ZFS script (the storage contract).

// ZpoolExists reports whether an imported zpool with the given name exists.
func ZpoolExists(name string) bool {
	return exec.Command("zpool", "list", name).Run() == nil
}

// PoolComment returns the pool-level `comment` property, or "" if unset/absent.
func PoolComment(name string) string {
	return PoolProperty(name, "comment")
}

func PoolProperty(name, property string) string {
	out, err := exec.Command("zpool", "get", "-H", "-o", "value", property, name).CombinedOutput()
	if err != nil {
		return ""
	}
	value := strings.TrimSpace(string(out))
	if value == "-" {
		return ""
	}
	return value
}

// DatasetProperty returns a local/inherited ZFS property value. A missing or
// unavailable property is represented as an empty string.
func DatasetProperty(dataset, property string) string {
	out, err := exec.Command("zfs", "get", "-H", "-o", "value", property, dataset).CombinedOutput()
	if err != nil {
		return ""
	}
	value := strings.TrimSpace(string(out))
	if value == "-" {
		return ""
	}
	return value
}

func IsAppliancePartitionPool(name string) bool {
	return ZpoolExists(name) &&
		DatasetProperty(name, OwnershipProperty) == OwnershipValue &&
		DatasetProperty(name, TopologyProperty) == TopologyAppliancePartition
}

// ValidateAppliancePartitionPool proves that the imported pool belongs to the
// exact YE-DATA partition recorded by the installer/state contract.
func ValidateAppliancePartitionPool(partition, partUUID string, layoutVersion int, compatibilityProfile string) error {
	return validateAppliancePartitionPoolNamed(PoolName, partition, partUUID, layoutVersion, compatibilityProfile)
}

func validateAppliancePartitionPoolNamed(pool, partition, partUUID string, layoutVersion int, compatibilityProfile string) error {
	if !IsAppliancePartitionPool(pool) {
		return fmt.Errorf("imported pool %q is not marked as appliance-partition topology", pool)
	}
	if got := DatasetProperty(pool, PartUUIDProperty); !strings.EqualFold(got, strings.TrimSpace(partUUID)) {
		return fmt.Errorf("pool %q PARTUUID property %q does not match YE-DATA %q", pool, got, partUUID)
	}
	if got := DatasetProperty(pool, LayoutProperty); got != fmt.Sprintf("%d", layoutVersion) {
		return fmt.Errorf("pool %q disk-layout property %q does not match image layout %d", pool, got, layoutVersion)
	}
	if got := DatasetProperty(pool, ZFSProfileProperty); got != compatibilityProfile {
		return fmt.Errorf("pool %q ZFS compatibility profile %q does not match image profile %q", pool, got, compatibilityProfile)
	}
	if got := PoolProperty(pool, "compatibility"); got != compatibilityProfile {
		return fmt.Errorf("pool %q active ZFS compatibility %q does not match image profile %q", pool, got, compatibilityProfile)
	}
	want := canonicalPath(partition)
	members := PoolMemberDevices(pool)
	if len(members) != 1 || canonicalPath(members[0]) != want {
		return fmt.Errorf("pool %q must have exactly the YE-DATA partition %s as its sole member (found %v)", pool, partition, members)
	}
	return nil
}

func canonicalPath(path string) string {
	path = strings.TrimSpace(path)
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	if info, err := os.Stat(path); err == nil && info.Mode()&os.ModeDevice != 0 {
		return path
	}
	return path
}

// IsYouEyeMarkedPool reports whether the pool exists AND carries the YouEye
// ownership marker. Legacy installer pools (no marker) return false.
func IsYouEyeMarkedPool(name string) bool {
	if !ZpoolExists(name) {
		return false
	}
	return PoolComment(name) == PoolMarker
}

// DatasetExists reports whether a ZFS dataset exists.
func DatasetExists(name string) bool {
	return exec.Command("zfs", "list", name).Run() == nil
}

// CreateYouEyePool creates the YouEye pool on a whole disk per the storage
// contract: whole-disk `zpool create -f` with ashift=12, the ownership marker,
// zstd/atime=off/xattr=sa/acltype=posixacl, then the default/data dataset
// mounted at /var/lib/youeye. default/incus is intentionally NOT created —
// Incus creates it itself when handed `source: default/incus`.
//
// disk should be a stable path (prefer /dev/disk/by-id, fall back to /dev/sdX).
func CreateYouEyePool(disk string) error {
	disk = strings.TrimSpace(disk)
	if disk == "" {
		return fmt.Errorf("CreateYouEyePool: empty disk path")
	}

	// Clear any prior-life residue so `zpool create` on a disk that carried
	// stale labels succeeds deterministically. -f alone can miss end-of-disk
	// label copies on some layouts; labelclear is explicit.
	exec.Command("zpool", "labelclear", "-f", disk).Run()

	createArgs := []string{
		"create", "-f",
		"-o", "ashift=12",
		"-o", "comment=" + PoolMarker,
		"-O", "compression=zstd",
		"-O", "atime=off",
		"-O", "xattr=sa",
		"-O", "acltype=posixacl",
		PoolName, disk,
	}
	if out, err := exec.Command("zpool", createArgs...).CombinedOutput(); err != nil {
		return fmt.Errorf("zpool create %s on %s failed: %w (%s)", PoolName, disk, err, strings.TrimSpace(string(out)))
	}

	if err := ensureDataDataset(); err != nil {
		return err
	}
	return nil
}

// CreateAppliancePartitionPool creates the pool only on the exact YE-DATA
// partition. It deliberately never resolves to, label-clears, or wipes the
// parent disk. The installer owns the GPT and recovery/image partitions.
func CreateAppliancePartitionPool(partition, partUUID string, layoutVersion int, compatibilityProfile string) error {
	return createAppliancePartitionPoolNamed(PoolName, partition, partUUID, layoutVersion, compatibilityProfile, DataMountpoint, IncusStateMountpoint)
}

func createAppliancePartitionPoolNamed(pool, partition, partUUID string, layoutVersion int, compatibilityProfile, dataMountpoint, incusStateMountpoint string) error {
	partition = strings.TrimSpace(partition)
	partUUID = strings.TrimSpace(partUUID)
	compatibilityProfile = strings.TrimSpace(compatibilityProfile)
	if partition == "" || partUUID == "" || layoutVersion < 1 || compatibilityProfile == "" {
		return fmt.Errorf("appliance partition, PARTUUID, layout version, and ZFS compatibility profile are required")
	}
	createArgs := appliancePartitionPoolCreateArgs(pool, partition, compatibilityProfile)
	if out, err := exec.Command("zpool", createArgs...).CombinedOutput(); err != nil {
		return fmt.Errorf("zpool create %s on appliance partition %s failed: %w (%s)", pool, partition, err, strings.TrimSpace(string(out)))
	}
	properties := map[string]string{
		OwnershipProperty:  OwnershipValue,
		TopologyProperty:   TopologyAppliancePartition,
		PartUUIDProperty:   partUUID,
		LayoutProperty:     fmt.Sprintf("%d", layoutVersion),
		ZFSProfileProperty: compatibilityProfile,
	}
	for property, value := range properties {
		if out, err := exec.Command("zfs", "set", property+"="+value, pool).CombinedOutput(); err != nil {
			return fmt.Errorf("set %s on %s: %w (%s)", property, pool, err, strings.TrimSpace(string(out)))
		}
	}
	return ensureAppliancePoolLayoutNamed(pool, dataMountpoint, incusStateMountpoint)
}

func appliancePartitionPoolCreateArgs(pool, partition, compatibilityProfile string) []string {
	return []string{
		"create", "-f",
		"-o", "ashift=12",
		"-o", "comment=" + PoolMarker,
		"-o", "compatibility=" + compatibilityProfile,
		"-O", "compression=zstd",
		"-O", "atime=off",
		"-O", "xattr=sa",
		"-O", "acltype=posixacl",
		"-O", "mountpoint=none",
		"-O", "canmount=off",
		pool, partition,
	}
}

// EnsureAppliancePoolLayout verifies the immutable topology marker and mounts
// both persistent host-state datasets. It never changes pool feature flags.
func EnsureAppliancePoolLayout() error {
	return ensureAppliancePoolLayoutNamed(PoolName, DataMountpoint, IncusStateMountpoint)
}

func ensureAppliancePoolLayoutNamed(pool, dataMountpoint, incusStateMountpoint string) error {
	if !IsAppliancePartitionPool(pool) {
		return fmt.Errorf("pool %q does not carry the appliance partition topology contract", pool)
	}
	if err := ensureDatasetMounted(pool+"/data", dataMountpoint); err != nil {
		return err
	}
	return ensureDatasetMounted(pool+"/incus-state", incusStateMountpoint)
}

// EnsureMarkedPoolLayout is used when a YouEye-marked pool is already imported:
// it guarantees default/data exists and is mounted at /var/lib/youeye. It does
// NOT touch default/incus (Incus owns that).
func EnsureMarkedPoolLayout() error {
	if !ZpoolExists(PoolName) {
		return fmt.Errorf("pool %q is not imported", PoolName)
	}
	return ensureDataDataset()
}

// ensureDataDataset creates (if missing) and mounts default/data at
// /var/lib/youeye. Idempotent.
func ensureDataDataset() error {
	return ensureDatasetMounted(DataDataset, DataMountpoint)
}

func ensureDatasetMounted(dataset, mountpoint string) error {
	if !DatasetExists(dataset) {
		out, err := exec.Command("zfs", "create",
			"-o", "mountpoint="+mountpoint,
			dataset).CombinedOutput()
		if err != nil {
			return fmt.Errorf("creating dataset %s failed: %w (%s)", dataset, err, strings.TrimSpace(string(out)))
		}
	} else {
		if datasetMountpointNeedsSet(DatasetProperty(dataset, "mountpoint"), mountpoint) {
			// Ensure the mountpoint is correct even if the dataset predates this code.
			if out, err := exec.Command("zfs", "set", "mountpoint="+mountpoint, dataset).CombinedOutput(); err != nil {
				return fmt.Errorf("setting mountpoint on %s failed: %w (%s)", dataset, err, strings.TrimSpace(string(out)))
			}
		}
	}

	// Mount it now so createDataDirectories() populates ZFS, not the root fs.
	if !DatasetMounted(dataset) {
		if out, err := exec.Command("zfs", "mount", dataset).CombinedOutput(); err != nil {
			// A stale directory at the mountpoint can block the mount.
			return fmt.Errorf("mounting %s at %s failed: %w (%s)", dataset, mountpoint, err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

func datasetMountpointNeedsSet(current, desired string) bool {
	return strings.TrimSpace(current) != strings.TrimSpace(desired)
}

// DatasetMounted reports whether a dataset is currently mounted.
func DatasetMounted(name string) bool {
	out, err := exec.Command("zfs", "get", "-H", "-o", "value", "mounted", name).CombinedOutput()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "yes"
}

// PoolMemberDevices returns the block devices that back a pool, using
// `zpool status -P` (full paths). Used by cleanup to labelclear/wipefs the
// right devices before the disk is considered blank again.
//
// zpool reports members by whatever path the pool was created with — often a
// /dev/disk/by-id symlink (e.g. .../scsi-0QEMU...-part1). Suffix math like
// WholeDiskOf breaks on those (".../...-part" is not a device; wipefs then
// silently misses the real disk — BUG-6, live-tested 2026-07-02), so every
// member is resolved to its canonical /dev node first.
func PoolMemberDevices(name string) []string {
	out, err := exec.Command("zpool", "status", "-P", name).CombinedOutput()
	if err != nil {
		return nil
	}
	members := parsePoolMembers(string(out))
	resolved := make([]string, 0, len(members))
	for _, m := range members {
		if real, err := filepath.EvalSymlinks(m); err == nil {
			resolved = append(resolved, real)
		} else {
			resolved = append(resolved, m)
		}
	}
	return resolved
}

// parsePoolMembers extracts /dev/* leaf vdev paths from `zpool status -P`
// output. Header/pool/mirror/raidz lines are skipped; only rows whose first
// field is an absolute device path are treated as members.
func parsePoolMembers(out string) []string {
	var members []string
	seen := map[string]bool{}
	inConfig := false
	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "config:") {
			inConfig = true
			continue
		}
		if !inConfig {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) == 0 {
			continue
		}
		dev := fields[0]
		if strings.HasPrefix(dev, "/dev/") && !seen[dev] {
			seen[dev] = true
			members = append(members, dev)
		}
	}
	return members
}

// WholeDiskOf returns the parent whole-disk device for a partition device
// (e.g. /dev/sdb1 → /dev/sdb, /dev/nvme0n1p1 → /dev/nvme0n1). If dev is
// already a whole disk it is returned unchanged.
//
// Device names whose base already ends in a digit (nvme0n1, mmcblk0) use a
// "p<N>" partition suffix, so we only strip after a trailing "p<digits>". For
// classic sd/vd/hd names (no digit in the base), a trailing run of digits IS
// the partition number and is stripped.
func WholeDiskOf(dev string) string {
	dev = strings.TrimSpace(dev)
	if dev == "" {
		return ""
	}
	base := dev
	name := base
	if idx := strings.LastIndex(base, "/"); idx >= 0 {
		name = base[idx+1:]
	}

	// nvme / mmcblk / loop style: base ends in a digit, partitions are "p<N>".
	// Only strip a "p<digits>" suffix where the char before "p" is a digit.
	if usesPPartitionSuffix(name) {
		if idx := strings.LastIndex(base, "p"); idx > 0 && allDigits(base[idx+1:]) &&
			base[idx-1] >= '0' && base[idx-1] <= '9' {
			return base[:idx]
		}
		return base // already a whole disk (e.g. nvme0n1)
	}

	// sdX / vdX / hdX style: strip a trailing run of digits (the partition #).
	i := len(base)
	for i > 0 && base[i-1] >= '0' && base[i-1] <= '9' {
		i--
	}
	if i == len(base) {
		return base // no trailing digits → already a whole disk
	}
	return base[:i]
}

// usesPPartitionSuffix reports whether a device name uses the "p<N>" partition
// naming convention (nvme, mmcblk, loop, etc.) — i.e. its whole-disk base ends
// in a digit.
func usesPPartitionSuffix(name string) bool {
	for _, prefix := range []string{"nvme", "mmcblk", "loop", "md", "nbd", "zd"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
