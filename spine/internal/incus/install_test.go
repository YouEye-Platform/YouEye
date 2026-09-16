package incus

import (
	"os"
	"strings"
	"testing"
)

func TestIncusBridgeDnsmasqStale(t *testing.T) {
	tests := []struct {
		name        string
		processList string
		expectedIP  string
		want        bool
	}{
		{
			name:       "single current bridge dnsmasq is clean",
			expectedIP: "10.82.15.1",
			processList: "268909 dnsmasq --interface=incusbr0 --listen-address=10.82.15.1 " +
				"--dhcp-range 10.82.15.100,10.82.15.254,1h",
			want: false,
		},
		{
			name:       "single old bridge dnsmasq is stale",
			expectedIP: "10.82.15.1",
			processList: "18825 dnsmasq --interface=incusbr0 --listen-address=10.47.104.1 " +
				"--dhcp-range 10.47.104.100,10.47.104.254,1h",
			want: true,
		},
		{
			name:       "multiple bridge dnsmasq processes are stale",
			expectedIP: "10.82.15.1",
			processList: "18825 dnsmasq --interface=incusbr0 --listen-address=10.47.104.1\n" +
				"268909 dnsmasq --interface=incusbr0 --listen-address=10.82.15.1",
			want: true,
		},
		{
			name:        "non-incusbr0 dnsmasq is ignored",
			expectedIP:  "10.82.15.1",
			processList: "123 dnsmasq --interface=otherbr0 --listen-address=10.10.10.1",
			want:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := incusBridgeDnsmasqStale(tt.processList, tt.expectedIP)
			if got != tt.want {
				t.Fatalf("incusBridgeDnsmasqStale() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestStaleIncusBridgeDnsmasqPIDs(t *testing.T) {
	processList := "18825 dnsmasq --interface=incusbr0 --listen-address=10.47.104.1\n" +
		"25770 dnsmasq --interface=incusbr0 --listen-address=10.85.229.1\n" +
		"283406 dnsmasq --interface=incusbr0 --listen-address=10.49.153.1\n" +
		"99999 dnsmasq --interface=otherbr0 --listen-address=10.10.10.1"

	got := staleIncusBridgeDnsmasqPIDs(processList, "10.49.153.1")
	want := []string{"18825", "25770"}
	if len(got) != len(want) {
		t.Fatalf("staleIncusBridgeDnsmasqPIDs() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("staleIncusBridgeDnsmasqPIDs() = %v, want %v", got, want)
		}
	}
}

func TestActiveIncusBridgeDnsmasqCount(t *testing.T) {
	processList := "18825 dnsmasq --interface=incusbr0 --listen-address=10.47.104.1\n" +
		"283406 dnsmasq --interface=incusbr0 --listen-address=10.49.153.1\n" +
		"283500 dnsmasq --interface=incusbr0 --listen-address=10.49.153.1"

	got := activeIncusBridgeDnsmasqCount(processList, "10.49.153.1")
	if got != 2 {
		t.Fatalf("activeIncusBridgeDnsmasqCount() = %d, want 2", got)
	}
}

func TestParseStorageShow(t *testing.T) {
	out := `config:
  size: 20GB
  source: /var/lib/incus/disks/default.img
  zfs.pool_name: default
description: ""
name: default
driver: zfs
`
	got := parseStorageShow(out)
	if got.driver != "zfs" {
		t.Fatalf("driver = %q, want zfs", got.driver)
	}
	if got.source != "/var/lib/incus/disks/default.img" {
		t.Fatalf("source = %q", got.source)
	}
	if got.size != "20GB" {
		t.Fatalf("size = %q", got.size)
	}
	if got.poolName != "default" {
		t.Fatalf("poolName = %q", got.poolName)
	}
}

func TestManagedLoopSource(t *testing.T) {
	if !managedLoopSource("/var/lib/incus/disks/default.img") {
		t.Fatal("expected default.img to be treated as a managed loop source")
	}
	if managedLoopSource("default") {
		t.Fatal("expected named zpool source to be ignored")
	}
	if managedLoopSource("/dev/nvme0n1p4") {
		t.Fatal("expected block device source to be ignored")
	}
}

// ZFS survival across unattended kernel upgrades: installZFS must install
// the kernel-headers META package (not only the exact headers) on both the
// fresh-install and already-installed paths, so the zfs-dkms kernel hook can
// build the module for a NEW kernel before its first boot. Clones .79/.80
// (2026-07-03) booted kernel 6.12.94 with a module built only for 6.12.90 —
// zero containers could start.
func TestInstallZFSEnsuresHeadersMeta(t *testing.T) {
	sourceBytes, err := os.ReadFile("install.go")
	if err != nil {
		t.Fatalf("read install.go: %v", err)
	}
	source := string(sourceBytes)

	if strings.Count(source, "ensureKernelHeadersMeta()") < 2 {
		t.Fatalf("installZFS must call ensureKernelHeadersMeta on both the already-installed and fresh-install paths")
	}
	if !strings.Contains(source, `"linux-headers-cloud-amd64"`) || !strings.Contains(source, `meta := "linux-headers-amd64"`) {
		t.Fatalf("ensureKernelHeadersMeta must pick the headers meta-package by kernel flavor")
	}
}

func TestInstallZFSRepairsEarlyModuleServiceFailure(t *testing.T) {
	sourceBytes, err := os.ReadFile("install.go")
	if err != nil {
		t.Fatalf("read install.go: %v", err)
	}
	source := string(sourceBytes)

	if strings.Count(source, "repairZFSModuleService()") < 3 {
		t.Fatalf("installZFS must repair the ZFS module unit on both the already-installed and fresh-install paths")
	}
	if !strings.Contains(source, `"reset-failed", "zfs-load-module.service"`) ||
		!strings.Contains(source, `"start", "zfs-load-module.service"`) {
		t.Fatalf("ZFS module repair must clear the premature DKMS failure and restart the oneshot unit")
	}
}
