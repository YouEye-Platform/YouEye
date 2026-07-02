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
	if cfg.IncusZFSGB != 64 {
		t.Fatalf("IncusZFSGB = %d, want 64", cfg.IncusZFSGB)
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

func TestExplicitIncusZFSDiskSizeIsPreserved(t *testing.T) {
	cfg, err := configFromEnvAndOptions(envInfo{
		IsProxmox: true,
		ImagePools: []storagePool{
			{Name: "local-lvm", Type: "lvmthin"},
		},
	}, CLIOptions{Mode: "proxmox-vm", IncusZFSGB: 96, IncusZFSGBSet: true})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.IncusZFSGB != 96 {
		t.Fatalf("IncusZFSGB = %d, want explicit 96", cfg.IncusZFSGB)
	}
}

func TestIncusZFSDiskCanBeDisabled(t *testing.T) {
	cfg, err := configFromEnvAndOptions(envInfo{
		IsProxmox: true,
		ImagePools: []storagePool{
			{Name: "local-lvm", Type: "lvmthin"},
		},
	}, CLIOptions{Mode: "proxmox-vm", IncusZFSGB: 0, IncusZFSGBSet: true})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.IncusZFSGB != 0 {
		t.Fatalf("IncusZFSGB = %d, want disabled 0", cfg.IncusZFSGB)
	}
}

func TestGuestIncusZFSSetupScriptCreatesDefaultPoolOnUnusedDisk(t *testing.T) {
	script := guestIncusZFSSetupScript()
	for _, needle := range []string{
		"Components: main contrib non-free-firmware",
		"zfsutils-linux",
		"root_pk",
		"zpool create",
		"default",
		"No dedicated unused disk found for Incus ZFS",
	} {
		if !strings.Contains(script, needle) {
			t.Fatalf("guestIncusZFSSetupScript missing %q", needle)
		}
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
