package networkstatus

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

type testAddress string

func (value testAddress) Network() string { return "ip+net" }
func (value testAddress) String() string  { return string(value) }

func TestStatusReturnsSafeEthernetStateAndCurrentIPv4(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "network-profile.json"), []byte(`{"schema":"youeye.network-profile.v1","id":"primary","kind":"ethernet","ipv4":{"mode":"dhcp"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "network-status.json"), []byte(`{"schema":"youeye.bootstrap-network.v1","phase":"ready","interface":"ens18","kind":"ethernet","ipv4_mode":"dhcp","attempt":1,"percent":100,"updated_at":"2026-08-16T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{Root: root, Addresses: func(name string) ([]net.Addr, error) {
		if name != "ens18" {
			t.Fatalf("unexpected adapter %q", name)
		}
		return []net.Addr{testAddress("169.254.1.2/16"), testAddress("192.0.2.10/24")}, nil
	}}
	status, err := manager.Status()
	if err != nil {
		t.Fatal(err)
	}
	if status.Phase != "ready" || status.Adapter != "ens18" || status.IPv4Address != "192.0.2.10" || status.WiFiSupported || !status.CanConfigureLocal {
		t.Fatalf("unexpected host network status: %+v", status)
	}
}

func TestStatusRejectsWiFiProfile(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "network-profile.json"), []byte(`{"schema":"youeye.network-profile.v1","id":"primary","kind":"wifi","ipv4":{"mode":"dhcp"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Manager{Root: root}).Status(); err == nil {
		t.Fatal("unsupported Wi-Fi profile was exposed as valid")
	}
}
