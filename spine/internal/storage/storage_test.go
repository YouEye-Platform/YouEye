package storage

import "testing"

func appliancePolicy() Policy {
	return Policy{
		Mode:                "appliance",
		AutoExpandRoot:      true,
		AutoGrowIncus:       true,
		HostReserveGB:       60,
		MaxIncusPoolPercent: 85,
	}
}

func TestComputePlanUbuntuDefaultLVM(t *testing.T) {
	snap := Snapshot{
		RootSource:          "/dev/mapper/ubuntu--vg-ubuntu--lv",
		RootSourceCanonical: "/dev/dm-0",
		RootFSType:          "ext4",
		RootTotalBytes:      100 * GiB,
		RootUsedBytes:       13 * GiB,
		RootAvailBytes:      81 * GiB,
		LVs: []LogicalVolume{{
			Path:          "/dev/ubuntu-vg/ubuntu-lv",
			CanonicalPath: "/dev/dm-0",
			VGName:        "ubuntu-vg",
			Name:          "ubuntu-lv",
			SizeBytes:     100 * GiB,
		}},
		VGs: []VolumeGroup{{
			Name:      "ubuntu-vg",
			SizeBytes: 464 * GiB,
			FreeBytes: 364 * GiB,
			LVCount:   1,
			PVCount:   1,
		}},
		IncusPool: &IncusPool{
			Name:            "default",
			Driver:          "zfs",
			Source:          "/var/lib/incus/disks/default.img",
			ConfigSize:      "20GB",
			ConfigSizeBytes: ParseSizeBytes("20GB"),
			AllocatedBytes:  3 * GiB,
			ManagedLoop:     true,
		},
	}

	plan := ComputePlan(appliancePolicy(), snap)
	if !plan.RootGrow {
		t.Fatalf("RootGrow = false, reasons: %v", plan.RootSkipReasons)
	}
	if plan.RootGrowBytes != 364*GiB {
		t.Fatalf("RootGrowBytes = %d, want %d", plan.RootGrowBytes, 364*GiB)
	}
	wantReserve := (464 * GiB) * 15 / 100
	if plan.HostReserveBytes != wantReserve {
		t.Fatalf("HostReserveBytes = %s, want %s", FormatBytes(plan.HostReserveBytes), FormatBytes(wantReserve))
	}
	if plan.IncusTargetBytes != 378*GiB {
		t.Fatalf("IncusTargetBytes = %s, want 378 GiB", FormatBytes(plan.IncusTargetBytes))
	}
	if !plan.IncusGrow {
		t.Fatalf("IncusGrow = false, reasons: %v", plan.IncusSkipReasons)
	}
}

func TestComputePlanSkipsNonLVMRoot(t *testing.T) {
	snap := Snapshot{
		RootSource:     "/dev/sda2",
		RootFSType:     "ext4",
		RootTotalBytes: 200 * GiB,
		RootUsedBytes:  20 * GiB,
		RootAvailBytes: 180 * GiB,
	}

	plan := ComputePlan(appliancePolicy(), snap)
	if plan.RootGrow {
		t.Fatal("RootGrow = true for non-LVM root")
	}
	if plan.IncusTargetBytes == 0 {
		t.Fatalf("expected Incus target from root free space, got reasons: %v", plan.IncusSkipReasons)
	}
}

func TestComputePlanSkipsMultipleLVVolumeGroup(t *testing.T) {
	snap := Snapshot{
		RootSource:          "/dev/mapper/vg-root",
		RootSourceCanonical: "/dev/dm-0",
		RootFSType:          "xfs",
		RootTotalBytes:      100 * GiB,
		RootAvailBytes:      90 * GiB,
		LVs: []LogicalVolume{{
			Path:          "/dev/vg/root",
			CanonicalPath: "/dev/dm-0",
			VGName:        "vg",
		}},
		VGs: []VolumeGroup{{
			Name:      "vg",
			FreeBytes: 300 * GiB,
			LVCount:   2,
		}},
	}

	plan := ComputePlan(appliancePolicy(), snap)
	if plan.RootGrow {
		t.Fatal("RootGrow = true for multi-LV volume group")
	}
	if got := joinReasons(plan.RootSkipReasons); got != "root volume group has multiple logical volumes" {
		t.Fatalf("RootSkipReasons = %q", got)
	}
}

func TestComputePlanNeverShrinksIncus(t *testing.T) {
	snap := Snapshot{
		RootSource:     "/dev/sda2",
		RootFSType:     "ext4",
		RootTotalBytes: 180 * GiB,
		RootAvailBytes: 120 * GiB,
		IncusPool: &IncusPool{
			Name:            "default",
			Driver:          "zfs",
			Source:          "/var/lib/incus/disks/default.img",
			ConfigSizeBytes: 130 * GiB,
			AllocatedBytes:  10 * GiB,
			ManagedLoop:     true,
		},
	}

	plan := ComputePlan(appliancePolicy(), snap)
	if plan.IncusGrow {
		t.Fatal("IncusGrow = true even though current pool is above target")
	}
}

func TestParsers(t *testing.T) {
	if got := ParseSizeBytes("20GB"); got != 20*1000*1000*1000 {
		t.Fatalf("ParseSizeBytes(20GB) = %d", got)
	}
	if got := ParseSizeBytes("20GiB"); got != 20*GiB {
		t.Fatalf("ParseSizeBytes(20GiB) = %d", got)
	}

	pool := parseIncusStorageShow(`config:
  size: 20GB
  source: /var/lib/incus/disks/default.img
  zfs.pool_name: default
description: ""
name: default
driver: zfs
`)
	if pool.Driver != "zfs" || pool.Source != "/var/lib/incus/disks/default.img" || pool.ConfigSizeBytes == 0 {
		t.Fatalf("parseIncusStorageShow() = %+v", pool)
	}
}

func joinReasons(reasons []string) string {
	if len(reasons) == 0 {
		return ""
	}
	return reasons[0]
}
