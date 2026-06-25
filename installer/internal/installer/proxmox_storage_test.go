package installer

import (
	"strings"
	"testing"
)

func TestProxmoxVMDefaultsToImageStoragePool(t *testing.T) {
	cfg, err := configFromEnvAndOptions(envInfo{
		IsProxmox: true,
		RootdirPools: []storagePool{
			{Name: "local", Type: "dir"},
		},
		ImagePools: []storagePool{
			{Name: "local-lvm", Type: "lvmthin"},
		},
	}, CLIOptions{Mode: "auto"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Mode != modeVM {
		t.Fatalf("Mode = %v, want modeVM", cfg.Mode)
	}
	if cfg.StoragePool != "local-lvm" {
		t.Fatalf("StoragePool = %q, want image-capable local-lvm", cfg.StoragePool)
	}
}

func TestExplicitProxmoxVMStorageIsPreserved(t *testing.T) {
	cfg, err := configFromEnvAndOptions(envInfo{
		IsProxmox: true,
		ImagePools: []storagePool{
			{Name: "local-lvm", Type: "lvmthin"},
		},
	}, CLIOptions{Mode: "proxmox-vm", StoragePool: "fast-zfs"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.StoragePool != "fast-zfs" {
		t.Fatalf("StoragePool = %q, want explicit fast-zfs", cfg.StoragePool)
	}
}

func TestVMStorageValidationRejectsRootdirOnlyPool(t *testing.T) {
	err := validateVMImageStoragePool("local", []storagePool{
		{Name: "local-lvm", Type: "lvmthin"},
		{Name: "fast-zfs", Type: "zfspool"},
	})
	if err == nil {
		t.Fatal("expected local to be rejected for VM image storage")
	}
	for _, needle := range []string{"local", "does not support VM images", "local-lvm", "fast-zfs"} {
		if !strings.Contains(err.Error(), needle) {
			t.Fatalf("error %q missing %q", err.Error(), needle)
		}
	}
}

func TestVMStorageValidationFailsClearlyWhenNoImagePoolsExist(t *testing.T) {
	err := validateVMImageStoragePool("local", nil)
	if err == nil {
		t.Fatal("expected no image pools to fail")
	}
	if !strings.Contains(err.Error(), "no Proxmox storage pool supports VM images") {
		t.Fatalf("unexpected error: %q", err.Error())
	}
}
