package systemupdate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIndependentCopyNetworkRebindsDHCPAndRejectsInheritedStaticAuthority(t *testing.T) {
	root := t.TempDir()
	network := filepath.Join(root, "etc/systemd/network")
	bootstrap := filepath.Join(root, "var/lib/youeye-state/bootstrap")
	for _, dir := range []string{network, bootstrap} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(network, "20-youeye.network")
	if err := os.WriteFile(file, []byte(strings.Replace(copyDHCPNetwork, "Name=en* eth*", "MACAddress=02:00:00:00:00:01", 1)), 0644); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(bootstrap, "network-profile.json")
	if err := os.WriteFile(profile, []byte(`{"adapter_mac":"02:00:00:00:00:01","ipv4":{"mode":"dhcp"},"schema":"retained-fixture"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareIndependentCopyNetwork(root); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(file)
	if string(raw) != copyDHCPNetwork {
		t.Fatal("source MAC still selected")
	}
	raw, _ = os.ReadFile(profile)
	if strings.Contains(string(raw), "02:00") || !strings.Contains(string(raw), "retained-fixture") {
		t.Fatal("profile did not retain unrelated settings")
	}
	if err := prepareIndependentCopyNetwork(root); err != nil {
		t.Fatal("replay", err)
	}
	if err := os.WriteFile(file, []byte("[Match]\nName=eth0\n[Network]\nAddress=192.168.1.12/24\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if InspectIndependentCopyNetwork(root) == nil {
		t.Fatal("inherited static address accepted")
	}
}
