package appliance

import "testing"

func TestFindPartitionsContract(t *testing.T) {
	devices := []BlockDevice{{Name: "sda", Path: "/dev/sda", Type: "disk", Serial: "APPLIANCE-001", Children: []BlockDevice{
		{Name: "sda5", Path: "/dev/sda5", Type: "part", PartLabel: StatePartitionLabel, PartUUID: "state-uuid", FSType: "ext4"},
		{Name: "sda6", Path: "/dev/sda6", Type: "part", PartLabel: DataPartitionLabel, PartUUID: "data-uuid"},
	}}}
	got, err := FindPartitions(devices, "")
	if err != nil {
		t.Fatal(err)
	}
	if got.StateParentDevice != "/dev/sda" || got.DataParentDevice != "/dev/sda" || got.ParentDevice != "/dev/sda" || got.StateDevice != "/dev/sda5" || got.DataPartUUID != "data-uuid" {
		t.Fatalf("unexpected contract: %+v", got)
	}
	if got.StateParentID != "serial:appliance-001" || got.DataParentID != "serial:appliance-001" {
		t.Fatalf("unexpected stable parent identities: %+v", got)
	}
}

func TestFindPartitionsRejectsAmbiguityWrongDiskAndRecoverySource(t *testing.T) {
	base := []BlockDevice{
		{Name: "sda", Path: "/dev/sda", Type: "disk", Children: []BlockDevice{
			{Name: "sda5", Path: "/dev/sda5", Type: "part", PartLabel: StatePartitionLabel, PartUUID: "s", FSType: "ext4"},
			{Name: "sda6", Path: "/dev/sda6", Type: "part", PartLabel: DataPartitionLabel, PartUUID: "d"},
		}},
	}
	if _, err := FindPartitions(base, ""); err != nil {
		t.Fatalf("one-drive State/Data layout must be accepted: %v", err)
	}
	base[0].Children[1].PartLabel = StatePartitionLabel
	if _, err := FindPartitions(base, ""); err == nil {
		t.Fatal("expected duplicate state rejection")
	}
	base = []BlockDevice{
		{Name: "sda", Path: "/dev/sda", Type: "disk", Children: []BlockDevice{{Name: "sda5", Path: "/dev/sda5", Type: "part", PartLabel: StatePartitionLabel, PartUUID: "s", FSType: "ext4"}}},
		{Name: "sdb", Path: "/dev/sdb", Type: "disk", Children: []BlockDevice{{Name: "sdb6", Path: "/dev/sdb6", Type: "part", PartLabel: DataPartitionLabel, PartUUID: "d"}}},
	}
	if _, err := FindPartitions(base, ""); err == nil {
		t.Fatal("expected split-parent rejection")
	}
	base = []BlockDevice{{Name: "sda", Path: "/dev/sda", Type: "disk", Children: []BlockDevice{
		{Name: "sda5", Path: "/dev/sda5", Type: "part", PartLabel: StatePartitionLabel, PartUUID: "s", FSType: "ext4"},
		{Name: "sda6", Path: "/dev/sda6", Type: "part", PartLabel: DataPartitionLabel, PartUUID: "d"},
	}}}
	if _, err := FindPartitions(base, "/dev/sda"); err == nil {
		t.Fatal("expected active-source installation-drive rejection")
	}
}

func TestFindPartitionsRejectsRemovableMedia(t *testing.T) {
	devices := []BlockDevice{{Name: "sdc", Path: "/dev/sdc", Type: "disk", Removable: true, Children: []BlockDevice{
		{Name: "sdc1", Path: "/dev/sdc1", Type: "part", PartLabel: StatePartitionLabel, PartUUID: "s", FSType: "ext4"},
		{Name: "sdc2", Path: "/dev/sdc2", Type: "part", PartLabel: DataPartitionLabel, PartUUID: "d"},
	}}}
	if _, err := FindPartitions(devices, ""); err == nil {
		t.Fatal("expected removable-media rejection")
	}
}

func TestFindPartitionsRejectsUnexpectedFilesystemSignatures(t *testing.T) {
	base := []BlockDevice{{Name: "sda", Path: "/dev/sda", Type: "disk", Children: []BlockDevice{
		{Name: "sda3", Path: "/dev/sda3", Type: "part", PartLabel: StatePartitionLabel, PartUUID: "s", FSType: "xfs"},
		{Name: "sda6", Path: "/dev/sda6", Type: "part", PartLabel: DataPartitionLabel, PartUUID: "d"},
	}}}
	if _, err := FindPartitions(base, ""); err == nil {
		t.Fatal("expected non-ext4 YE-STATE rejection")
	}
	base[0].Children[0].FSType = "ext4"
	base[0].Children[1].FSType = "crypto_LUKS"
	if _, err := FindPartitions(base, ""); err == nil {
		t.Fatal("expected unexpected YE-DATA signature rejection")
	}
	base[0].Children[1].FSType = "zfs_member"
	if _, err := FindPartitions(base, ""); err != nil {
		t.Fatalf("existing ZFS member must be adoptable: %v", err)
	}
}

func TestFindPartitionsPrefersOneParentWWN(t *testing.T) {
	devices := []BlockDevice{
		{Name: "vda", Type: "disk", Serial: "appliance", WWN: "0xAABB", Children: []BlockDevice{
			{Name: "vda5", Path: "/dev/vda5", Type: "part", PartLabel: StatePartitionLabel, PartUUID: "state", FSType: "ext4"},
			{Name: "vda6", Path: "/dev/vda6", Type: "part", PartLabel: DataPartitionLabel, PartUUID: "data"},
		}},
	}
	contract, err := FindPartitions(devices, "")
	if err != nil {
		t.Fatal(err)
	}
	if contract.StateParentID != "wwn:0xaabb" || contract.DataParentID != "wwn:0xaabb" {
		t.Fatalf("WWN identities not normalized: %+v", contract)
	}
}
