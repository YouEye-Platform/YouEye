package storage

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// DecisionInputs are the runtime facts the deploy storage decision tree needs
// beyond the policy. Injected so ResolveDecision is unit-testable.
type DecisionInputs struct {
	// Policy is the normalized storage policy (mode etc.).
	Policy Policy

	// RootTotalBytes / RootAvailBytes describe the root filesystem after any
	// safe growth (from the storage Plan).
	RootTotalBytes int64
	RootAvailBytes int64

	// LargeTargetBytes is the historical ComputePlan Incus target (60 GiB
	// reserve policy). Used directly for large roots.
	LargeTargetBytes int64

	// InContainer is true inside an LXC/container (dir driver mandatory).
	InContainer bool

	// ZFSAvailable reports whether ZFS tooling+kernel support is usable.
	ZFSAvailable bool

	// ZFSInstallable is true when ZFS is NOT yet available but could be
	// installed (i.e. not a container). When false and !ZFSAvailable, we can
	// only use the dir driver.
	ZFSInstallable bool

	// MarkedPoolImported / LegacyPoolImported describe an already-imported
	// pool named PoolName. Marked wins.
	MarkedPoolImported bool
	LegacyPoolImported bool

	// Devices is the block-device tree (for blank-disk detection).
	Devices []BlockDevice

	// RootDisks / FstabDevs / SwapDevs are the exclusion sets.
	RootDisks map[string]bool
	FstabDevs map[string]bool
	SwapDevs  map[string]bool
}

// ResolveDecision implements the deploy storage decision tree (plan step 1,
// a→d). It is pure — all effects (zpool create, mount, incus init) happen in
// the caller based on the returned StorageDecision.
func ResolveDecision(in DecisionInputs) StorageDecision {
	// (a) YouEye-marked pool already imported → adopt with dataset layout.
	if in.MarkedPoolImported {
		return StorageDecision{
			Kind:      DecisionAdoptMarkedPool,
			DataOnZFS: true,
			Reason:    fmt.Sprintf("imported pool %q carries the %q marker; reusing default/incus + default/data", PoolName, PoolMarker),
		}
	}
	// (a, legacy) Pool named default WITHOUT the marker → backward-compatible
	// whole-pool reuse (installer-v0.5.2/0.5.3 layout, data stays on root).
	if in.LegacyPoolImported {
		return StorageDecision{
			Kind:      DecisionReuseLegacyPool,
			DataOnZFS: false,
			Reason:    fmt.Sprintf("imported pool %q has no YouEye marker (legacy install); reusing whole pool as source=default", PoolName),
		}
	}

	// Containers can never do ZFS — dir driver, data on root.
	if in.InContainer {
		return StorageDecision{
			Kind:      DecisionDir,
			DataOnZFS: false,
			Reason:    "running inside a container; using dir driver",
		}
	}

	// (b) No pool, appliance mode, a blank secondary disk exists → create pool.
	if strings.EqualFold(in.Policy.Mode, "appliance") {
		candidate, _, staleHint := selectBlankDisk(diskCandidateInput{
			Devices:   in.Devices,
			RootDisks: in.RootDisks,
			FstabDevs: in.FstabDevs,
			SwapDevs:  in.SwapDevs,
		})
		if candidate != nil {
			return StorageDecision{
				Kind:      DecisionCreateOnDisk,
				Disk:      candidate.Path,
				DiskBytes: candidate.SizeBytes,
				DataOnZFS: true,
				Reason: fmt.Sprintf("appliance mode, no imported pool, blank secondary disk %s (%s) available; creating YouEye pool",
					candidate.Path, FormatBytes(candidate.SizeBytes)),
			}
		}
		// A disk carrying only stale ZFS residue is NOT auto-claimed — surface
		// an actionable hint and fall through to the single-disk path.
		if staleHint != "" {
			// carried into the loop/dir decision below via Hint.
			dec := resolveSingleDisk(in)
			dec.Hint = staleHint
			return dec
		}
	}

	// (c) Single-disk / no candidate → adaptive loop pool (or dir).
	return resolveSingleDisk(in)
}

// resolveSingleDisk handles the no-dedicated-disk path: adaptive loop pool when
// ZFS is (or can be made) available with enough room; dir only inside
// containers or when ZFS install fails; fail loudly when genuinely too small.
func resolveSingleDisk(in DecisionInputs) StorageDecision {
	// dir driver only for containers (handled earlier) — here, if ZFS is
	// neither available nor installable, dir is the last resort with a loud
	// warning surfaced by the caller.
	if !in.ZFSAvailable && !in.ZFSInstallable {
		return StorageDecision{
			Kind:      DecisionDir,
			DataOnZFS: false,
			Reason:    "ZFS unavailable and cannot be installed here; falling back to dir driver",
		}
	}

	target := computeLoopPoolTarget(in.RootTotalBytes, in.RootAvailBytes, in.LargeTargetBytes)
	if target < MinPoolBytes {
		// (d) genuinely not enough room → fail loudly.
		return StorageDecision{
			Kind: DecisionFail,
			Reason: fmt.Sprintf(
				"not enough room for a %s+ storage pool: root %s total, %s free (reserve %s). "+
					"Attach a dedicated data disk or grow the root filesystem",
				FormatBytes(MinPoolBytes), FormatBytes(in.RootTotalBytes), FormatBytes(in.RootAvailBytes), FormatBytes(SmallRootReserveBytes)),
		}
	}
	return StorageDecision{
		Kind:          DecisionLoopPool,
		LoopSizeBytes: target,
		DataOnZFS:     false,
		Reason:        fmt.Sprintf("single-disk machine; managed loop pool sized %s (data stays on root filesystem)", FormatBytes(target)),
	}
}

// CollectDecisionInputs gathers the live runtime facts for ResolveDecision.
// Effect-bearing (reads lsblk/fstab/swapon/zpool) — used by cmd/install.go.
func CollectDecisionInputs(policy Policy, rootTotal, rootAvail, largeTarget int64, zfsAvailable bool) DecisionInputs {
	return collectDecisionInputs(policy, rootTotal, rootAvail, largeTarget, zfsAvailable, osRunner{})
}

func collectDecisionInputs(policy Policy, rootTotal, rootAvail, largeTarget int64, zfsAvailable bool, runner commandRunner) DecisionInputs {
	in := DecisionInputs{
		Policy:           normalizePolicy(policy),
		RootTotalBytes:   rootTotal,
		RootAvailBytes:   rootAvail,
		LargeTargetBytes: largeTarget,
		ZFSAvailable:     zfsAvailable,
	}

	// Container detection (dir mandatory / ZFS not installable).
	if out, err := runner.Run("systemd-detect-virt", "-c"); err == nil {
		vtype := strings.TrimSpace(out)
		in.InContainer = vtype != "" && vtype != "none"
	}
	in.ZFSInstallable = !in.InContainer

	// Imported-pool classification.
	if ZpoolExists(PoolName) {
		if PoolComment(PoolName) == PoolMarker {
			in.MarkedPoolImported = true
		} else {
			in.LegacyPoolImported = true
		}
	}

	// Block devices + exclusion sets.
	in.Devices = collectBlockDevices(runner)

	rootSource, rootCanonical := detectRootSource(runner)
	in.RootDisks = rootDiskPaths(in.Devices, rootCanonical, rootSource)

	if content, err := os.ReadFile("/etc/fstab"); err == nil {
		in.FstabDevs = parseFstabDevices(string(content))
	} else {
		in.FstabDevs = map[string]bool{}
	}

	if out, err := runner.Run("swapon", "--show=NAME", "--noheadings", "--raw"); err == nil {
		in.SwapDevs = parseSwapDevices(out)
	} else {
		in.SwapDevs = map[string]bool{}
	}

	return in
}

func detectRootSource(runner commandRunner) (source, canonical string) {
	if out, err := runner.Run("findmnt", "-n", "-o", "SOURCE", "/"); err == nil {
		source = strings.TrimSpace(out)
		canonical = canonicalDevice(runner, source)
	}
	return source, canonical
}

// ResolveDiskByID returns the stable /dev/disk/by-id path for a whole-disk
// device when one exists, else the input path. Best-effort (OpenZFS FAQ
// recommends by-id over /dev/sdX).
func ResolveDiskByID(dev string) string {
	dev = strings.TrimSpace(dev)
	if dev == "" {
		return dev
	}
	target := canonicalDevice(osRunner{}, dev)
	entries, err := os.ReadDir("/dev/disk/by-id")
	if err != nil {
		return dev
	}
	for _, e := range entries {
		link := "/dev/disk/by-id/" + e.Name()
		resolved, err := exec.Command("readlink", "-f", link).Output()
		if err != nil {
			continue
		}
		if strings.TrimSpace(string(resolved)) == target {
			// Prefer wwn-/ata-/nvme- ids over shorter aliases; first match is fine.
			return link
		}
	}
	return dev
}
