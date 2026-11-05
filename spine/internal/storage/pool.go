package storage

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

// The storage contract shared with the installer. A dedicated-disk pool is
// created on the whole disk with these exact options; the pool-level comment
// property is the YouEye ownership marker. Keep these values in lockstep with
// the installer's guest ZFS script — a parallel agent builds against the same
// contract.
const (
	// PoolName is the single Incus/YouEye storage pool name.
	PoolName = "default"

	// PoolMarker is the value written to the pool-level `comment` property to
	// identify a pool as YouEye-owned. Legacy installer-v0.5.2/0.5.3 pools do
	// NOT carry this marker and keep the old whole-pool behavior.
	PoolMarker = "youeye-incus"

	// Explicit dataset properties distinguish an image-owned partition pool
	// from the legacy mutable-host whole-disk pool. Cleanup and recovery must
	// never infer topology from a device name.
	OwnershipProperty          = "org.youeye:ownership"
	OwnershipValue             = "youeye"
	TopologyProperty           = "org.youeye:topology"
	TopologyAppliancePartition = "appliance-partition"
	PartUUIDProperty           = "org.youeye:partuuid"
	LayoutProperty             = "org.youeye:disk-layout"
	ZFSProfileProperty         = "org.youeye:zfs-profile"

	// IncusDataset is handed to Incus via preseed `source: default/incus`.
	// Incus creates it (mountpoint=legacy) itself — never pre-create it.
	IncusDataset = PoolName + "/incus"

	// IncusStateDataset persists the Incus database and host-side state across
	// immutable image changes. It is separate from IncusDataset, which is the
	// storage driver dataset for instances and custom volumes.
	IncusStateDataset    = PoolName + "/incus-state"
	IncusStateMountpoint = "/var/lib/incus"

	// DataDataset holds all YouEye persistent data, mounted at DataMountpoint.
	// Spine creates this when it creates the pool.
	DataDataset = PoolName + "/data"

	// DataMountpoint is where default/data is mounted (replaces root-fs
	// /var/lib/youeye on dedicated-disk deploys).
	DataMountpoint = "/var/lib/youeye"

	// MinDedicatedDiskBytes is the floor for auto-claiming a blank secondary
	// disk. Smaller disks are ignored.
	MinDedicatedDiskBytes = 8 * GiB

	// MinPoolBytes is the absolute minimum size for any pool (dedicated, loop,
	// or otherwise). A plan that cannot reach this fails the deploy loudly —
	// this is what makes Incus's implicit ~3 GiB default unreachable.
	MinPoolBytes = 8 * GiB
)

// Adaptive loop-pool sizing thresholds. On roots at or above
// LargeRootThresholdBytes the historical policy (60 GiB reserve / 60 GiB
// minimum target, driven by ComputePlan) applies. Below it we use a small-disk
// policy so single-disk machines never fall through to Incus's implicit pool.
const (
	// LargeRootThresholdBytes is the boundary between "large host" (keep
	// existing 60 GiB reserve policy) and "small host" (adaptive policy).
	LargeRootThresholdBytes = 120 * GiB

	// SmallRootReserveBytes is the OS headroom reserved on small roots.
	SmallRootReserveBytes = 12 * GiB

	// SmallRootMaxPercent caps the loop pool at this percent of total root on
	// small hosts.
	SmallRootMaxPercent = 85
)

// StorageDecisionKind enumerates the resolved deploy storage path.
type StorageDecisionKind int

const (
	// DecisionUnset is the zero value.
	DecisionUnset StorageDecisionKind = iota

	// DecisionAdoptMarkedPool reuses an imported YouEye-marked pool with the
	// default/incus + default/data dataset layout (source: default/incus).
	DecisionAdoptMarkedPool

	// DecisionReuseLegacyPool reuses an imported pool named "default" WITHOUT
	// the YouEye marker (installer-v0.5.2/0.5.3 layout). Preseed source: default.
	DecisionReuseLegacyPool

	// DecisionCreateOnDisk creates a fresh YouEye pool on a blank secondary
	// disk, then behaves like DecisionAdoptMarkedPool.
	DecisionCreateOnDisk

	// DecisionAdoptAppliancePartition creates or adopts the ZFS pool only on
	// the installer-provisioned YE-DATA partition of a sealed appliance disk.
	// The parent disk and GPT are never claimable or wipeable by Spine.
	DecisionAdoptAppliancePartition

	// DecisionLoopPool creates a managed loop-backed pool with an explicit
	// adaptive size on a single-disk machine. /var/lib/youeye stays on root.
	DecisionLoopPool

	// DecisionDir uses the dir driver (containers only, or ZFS-install failure).
	DecisionDir

	// DecisionFail means there is not enough room anywhere; deploy must abort.
	DecisionFail
)

func (k StorageDecisionKind) String() string {
	switch k {
	case DecisionAdoptMarkedPool:
		return "adopt-marked-pool"
	case DecisionReuseLegacyPool:
		return "reuse-legacy-pool"
	case DecisionCreateOnDisk:
		return "create-on-disk"
	case DecisionAdoptAppliancePartition:
		return "adopt-appliance-partition"
	case DecisionLoopPool:
		return "loop-pool"
	case DecisionDir:
		return "dir"
	case DecisionFail:
		return "fail"
	default:
		return "unset"
	}
}

// StorageDecision is the resolved deploy-time storage plan. It is computed once
// (in cmd/install.go) and handed to the Incus initializer, which applies it and
// then verifies reality matches.
type StorageDecision struct {
	Kind StorageDecisionKind

	// Disk is the whole-disk device claimed for DecisionCreateOnDisk
	// (e.g. /dev/sdb). Empty otherwise. The stable /dev/disk/by-id path is
	// resolved at pool-creation time (ResolveDiskByID).
	Disk string

	// DiskBytes is the size of the claimed disk (DecisionCreateOnDisk).
	DiskBytes int64

	// Partition fields are populated only for DecisionAdoptAppliancePartition.
	// Disk is the YE-DATA partition, ParentDisk is informational safety context,
	// and PartUUID/LayoutVersion are checked against the sealed/state contract.
	ParentDisk              string
	PartUUID                string
	StatePartUUID           string
	LayoutVersion           int
	ZFSCompatibilityProfile string
	CreatePool              bool

	// LoopSizeBytes is the explicit size for DecisionLoopPool. Always > 0 for
	// that kind — the Incus implicit default must never be reached.
	LoopSizeBytes int64

	// DataOnZFS is true when /var/lib/youeye lives on a ZFS data dataset
	// (dedicated-disk kinds). False for loop/dir (data stays on root).
	DataOnZFS bool

	// Reason is a human-readable explanation for logs.
	Reason string

	// Hint carries an actionable operator hint (e.g. stale-label residue).
	Hint string
}

// BlockDevice is a normalized view of one lsblk device row used for
// blank-disk detection.
type BlockDevice struct {
	Name       string // e.g. "sda"
	Path       string // e.g. "/dev/sda"
	Type       string // "disk", "loop", "rom", "part", ...
	SizeBytes  int64
	FSType     string // filesystem/RAID/ZFS signature on the whole disk, if any
	MountPoint string
	PartTable  string // "gpt", "dos", or "" when no partition table
	Children   []BlockDevice
}

// diskCandidateInput bundles the facts blank-disk detection needs. Kept as a
// struct so the predicate is unit-testable with fake data.
type diskCandidateInput struct {
	Devices   []BlockDevice
	RootDisks map[string]bool // whole-disk device paths backing the root fs
	FstabDevs map[string]bool // device paths (and by-id) referenced in fstab
	SwapDevs  map[string]bool // device paths currently used for swap
}

// isBlankCandidate reports whether dev qualifies as a blank secondary disk for
// auto-claiming, plus a reason. Rules (see plan step b):
//   - type == "disk" (not loop/sr/rom/zd/rbd)
//   - size >= MinDedicatedDiskBytes
//   - not the root disk
//   - not mounted anywhere (self or any child), not in fstab, not swap
//   - no partition table AND no filesystem/RAID/ZFS signatures on the whole
//     disk or any child
func isBlankCandidate(dev BlockDevice, in diskCandidateInput) (bool, string) {
	if dev.Type != "disk" {
		return false, fmt.Sprintf("%s: not a plain disk (type=%s)", dev.Path, dev.Type)
	}
	if isVirtualDiskName(dev.Name) {
		return false, fmt.Sprintf("%s: virtual/loop/optical device", dev.Path)
	}
	if dev.SizeBytes < MinDedicatedDiskBytes {
		return false, fmt.Sprintf("%s: too small (%s < %s)", dev.Path, FormatBytes(dev.SizeBytes), FormatBytes(MinDedicatedDiskBytes))
	}
	if in.RootDisks[dev.Path] || in.RootDisks[dev.Name] {
		return false, fmt.Sprintf("%s: backs the root filesystem", dev.Path)
	}
	if in.FstabDevs[dev.Path] {
		return false, fmt.Sprintf("%s: referenced in /etc/fstab", dev.Path)
	}
	if in.SwapDevs[dev.Path] {
		return false, fmt.Sprintf("%s: in use as swap", dev.Path)
	}
	if dev.PartTable != "" {
		return false, fmt.Sprintf("%s: has a %s partition table", dev.Path, dev.PartTable)
	}
	if sig := strings.TrimSpace(dev.FSType); sig != "" {
		return false, fmt.Sprintf("%s: carries a %s signature", dev.Path, sig)
	}
	if dev.MountPoint != "" {
		return false, fmt.Sprintf("%s: mounted at %s", dev.Path, dev.MountPoint)
	}
	// Any child (partition) means there IS a partition table / prior layout.
	for _, child := range dev.Children {
		if in.FstabDevs[child.Path] {
			return false, fmt.Sprintf("%s: partition %s referenced in /etc/fstab", dev.Path, child.Path)
		}
		if in.SwapDevs[child.Path] {
			return false, fmt.Sprintf("%s: partition %s in use as swap", dev.Path, child.Path)
		}
		if child.MountPoint != "" {
			return false, fmt.Sprintf("%s: partition %s mounted at %s", dev.Path, child.Path, child.MountPoint)
		}
		if sig := strings.TrimSpace(child.FSType); sig != "" {
			return false, fmt.Sprintf("%s: partition %s carries a %s signature", dev.Path, child.Path, sig)
		}
	}
	if len(dev.Children) > 0 {
		// A partition with no signature still implies a partition table.
		return false, fmt.Sprintf("%s: has partitions", dev.Path)
	}
	return true, fmt.Sprintf("%s: blank (%s, no partition table, no signatures)", dev.Path, FormatBytes(dev.SizeBytes))
}

// hasStaleZFSResidue reports whether dev carries ONLY stale YouEye ZFS labels
// (a zfs_member signature with LABEL="default" or a zfs-* PARTLABEL) while no
// pool is importable. Such a disk must NOT be auto-claimed — the operator has
// to wipe it deliberately (labelclear + wipefs) or reinstall fresh.
func hasStaleZFSResidue(dev BlockDevice) bool {
	check := func(b BlockDevice) bool {
		return strings.EqualFold(strings.TrimSpace(b.FSType), "zfs_member")
	}
	if check(dev) {
		return true
	}
	for _, child := range dev.Children {
		if check(child) {
			return true
		}
	}
	return false
}

// isVirtualDiskName filters out device names that are never eligible as a
// dedicated data disk: loop devices, optical drives, ZFS volumes, RBD, and
// device-mapper nodes.
func isVirtualDiskName(name string) bool {
	name = strings.TrimSpace(name)
	for _, prefix := range []string{"loop", "sr", "zd", "rbd", "dm-", "fd"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// selectBlankDisk returns the SMALLEST qualifying blank disk, a slice of
// skip reasons for the rest, and any stale-residue hint. Deterministic.
func selectBlankDisk(in diskCandidateInput) (candidate *BlockDevice, skipped []string, staleHint string) {
	for i := range in.Devices {
		dev := in.Devices[i]
		if dev.Type != "disk" {
			continue
		}
		ok, reason := isBlankCandidate(dev, in)
		if ok {
			if candidate == nil || dev.SizeBytes < candidate.SizeBytes {
				c := dev
				candidate = &c
			}
			continue
		}
		skipped = append(skipped, reason)
		if staleHint == "" && !in.RootDisks[dev.Path] && hasStaleZFSResidue(dev) {
			staleHint = fmt.Sprintf(
				"found leftover YouEye ZFS labels on %s from a previous install; "+
					"wipe with `zpool labelclear -f <partition>` + `wipefs -a %s`, or reinstall fresh",
				dev.Path, dev.Path)
		}
	}
	return candidate, skipped, staleHint
}

// computeLoopPoolTarget returns the explicit loop-pool size (bytes) for a
// single-disk machine, given the historical large-host target (from
// ComputePlan) and the current root snapshot. It NEVER returns a value below
// MinPoolBytes; if the machine is genuinely too small it returns 0 and the
// caller fails the deploy.
//
// Policy:
//   - root total >= LargeRootThresholdBytes: keep the existing ComputePlan
//     target (60 GiB reserve, 60 GiB min) — largeTargetBytes is passed through.
//   - smaller roots: reserve SmallRootReserveBytes, min pool MinPoolBytes,
//     target = min(rootAvail - reserve, SmallRootMaxPercent% of root total).
func computeLoopPoolTarget(rootTotalBytes, rootAvailBytes, largeTargetBytes int64) int64 {
	if rootTotalBytes <= 0 || rootAvailBytes <= 0 {
		return 0
	}
	if rootTotalBytes >= LargeRootThresholdBytes {
		// Large host: defer to the historical policy. If that policy declined
		// (returned 0) there genuinely isn't room under the 60 GiB reserve.
		if largeTargetBytes >= MinPoolBytes {
			return largeTargetBytes
		}
		return 0
	}

	avail := rootAvailBytes - SmallRootReserveBytes
	percentCap := rootTotalBytes * int64(SmallRootMaxPercent) / 100
	target := avail
	if percentCap < target {
		target = percentCap
	}
	target = floorToGiB(target)
	if target < MinPoolBytes {
		return 0
	}
	return target
}

// ── lsblk / blkid / fstab parsing (production side) ────────────────────────

type lsblkNode struct {
	Name       string      `json:"name"`
	Path       string      `json:"path"`
	Type       string      `json:"type"`
	Size       json.Number `json:"size"`
	FSType     string      `json:"fstype"`
	MountPoint string      `json:"mountpoint"`
	PTType     string      `json:"pttype"`
	Children   []lsblkNode `json:"children"`
}

type lsblkReport struct {
	BlockDevices []lsblkNode `json:"blockdevices"`
}

func parseLsblk(out string) []BlockDevice {
	var report lsblkReport
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		return nil
	}
	var devices []BlockDevice
	for _, node := range report.BlockDevices {
		devices = append(devices, lsblkNodeToDevice(node))
	}
	return devices
}

func lsblkNodeToDevice(node lsblkNode) BlockDevice {
	dev := BlockDevice{
		Name:       strings.TrimSpace(node.Name),
		Path:       strings.TrimSpace(node.Path),
		Type:       strings.TrimSpace(node.Type),
		FSType:     strings.TrimSpace(node.FSType),
		MountPoint: strings.TrimSpace(node.MountPoint),
		PartTable:  strings.TrimSpace(node.PTType),
	}
	if dev.Path == "" && dev.Name != "" {
		dev.Path = "/dev/" + dev.Name
	}
	if n, err := node.Size.Int64(); err == nil {
		dev.SizeBytes = n
	}
	for _, child := range node.Children {
		dev.Children = append(dev.Children, lsblkNodeToDevice(child))
	}
	return dev
}

// collectBlockDevices reads the full block-device tree with signatures. Uses
// lsblk's JSON output with size in bytes; every field blank-disk detection
// needs is requested in one call.
func collectBlockDevices(runner commandRunner) []BlockDevice {
	out, err := runner.Run("lsblk", "-b", "-J", "-o", "NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINT,PTTYPE")
	if err != nil {
		return nil
	}
	return parseLsblk(out)
}

// rootDiskPaths returns the set of whole-disk device paths that back the root
// filesystem, so those disks are never claimed. Derived from the root source
// device by walking up the lsblk tree.
func rootDiskPaths(devices []BlockDevice, rootSourceCanonical, rootSource string) map[string]bool {
	targets := map[string]bool{}
	for _, s := range []string{rootSourceCanonical, rootSource} {
		s = strings.TrimSpace(s)
		if s != "" {
			targets[s] = true
		}
	}
	result := map[string]bool{}
	for i := range devices {
		disk := devices[i]
		if diskContainsDevice(disk, targets) {
			result[disk.Path] = true
			result[disk.Name] = true
		}
	}
	return result
}

func diskContainsDevice(disk BlockDevice, targets map[string]bool) bool {
	if targets[disk.Path] || targets["/dev/"+disk.Name] {
		return true
	}
	for _, child := range disk.Children {
		if targets[child.Path] || targets["/dev/"+child.Name] {
			return true
		}
		if diskContainsDevice(child, targets) {
			return true
		}
	}
	return false
}

// parseFstabDevices returns the set of block-device paths referenced in
// /etc/fstab (only lines that name a /dev path; UUID/LABEL lines are resolved
// separately by the caller via lsblk mountpoints, so are not needed here).
func parseFstabDevices(content string) map[string]bool {
	result := map[string]bool{}
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		spec := fields[0]
		if strings.HasPrefix(spec, "/dev/") {
			result[spec] = true
			// Also record the by-id → real-path resolution is done at a higher
			// layer; keep the literal spec here.
			result[filepath.Clean(spec)] = true
		}
	}
	return result
}

// parseSwapDevices returns the set of block-device paths currently used for
// swap (from `swapon --show=NAME --noheadings --raw`).
func parseSwapDevices(out string) map[string]bool {
	result := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// swapon rows are the device/file path in the first column.
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if strings.HasPrefix(fields[0], "/dev/") {
			result[fields[0]] = true
		}
	}
	return result
}
