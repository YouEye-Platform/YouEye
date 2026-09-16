package storage

import (
	"slices"
	"testing"
)

func TestAppliancePartitionPoolRootCannotMountOnImmutableRoot(t *testing.T) {
	args := appliancePartitionPoolCreateArgs("default", "/dev/disk/by-partuuid/data", "openzfs-2.2")
	for _, property := range []string{"mountpoint=none", "canmount=off"} {
		index := slices.Index(args, property)
		if index < 1 || args[index-1] != "-O" {
			t.Fatalf("appliance zpool create args missing -O %s: %v", property, args)
		}
	}
	if args[len(args)-2] != "default" || args[len(args)-1] != "/dev/disk/by-partuuid/data" {
		t.Fatalf("pool and exact partition must terminate create args: %v", args)
	}
}
