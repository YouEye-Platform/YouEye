package systemupdate

import (
	"encoding/json"
	"testing"
)

func TestIndependentCopyRefusesExternalBacking(t *testing.T) {
	devices := map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": "default"}, "eth0": {"type": "nic", "network": "youeye0"}, "data": {"type": "disk", "source": "/var/lib/youeye/app-notes", "path": "/data"}}
	raw := func() []byte {
		b, _ := json.Marshal([]any{map[string]any{"name": "app-notes", "expanded_devices": devices}})
		return b
	}
	if err := validateCopyContainerDevices(raw(), "/var/lib/youeye"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []map[string]string{{"type": "disk", "path": "/data", "source": "/mnt/remote"}, {"type": "disk", "path": "/data", "source": "/var/lib/youeye/../foreign"}, {"type": "disk", "path": "/data", "pool": "remote", "source": "data"}, {"type": "nic", "nictype": "physical", "parent": "eth1"}, {"type": "unix-char", "path": "/dev/tpm0"}} {
		previous := devices["data"]
		devices["data"] = bad
		if err := validateCopyContainerDevices(raw(), "/var/lib/youeye"); err == nil {
			t.Fatalf("accepted external device: %v", bad)
		}
		devices["data"] = previous
	}
	delete(devices, "root")
	if err := validateCopyContainerDevices(raw(), "/var/lib/youeye"); err == nil {
		t.Fatal("accepted missing root")
	}
}

func TestIndependentCopyProxyAndNetworkInventory(t *testing.T) {
	raw := []byte(`[{"name":"youeye-control","expanded_devices":{"root":{"type":"disk","pool":"default","path":"/"},"eth0":{"type":"nic","network":"youeye0","ipv4.address":"10.3.0.10"},"api":{"type":"proxy","bind":"host","listen":"tcp:127.0.0.1:3000","connect":"tcp:10.3.0.10:3000"},"spine":{"type":"proxy","bind":"container","connect":"unix:/var/run/youeye/youeye.sock","listen":"unix:/var/run/youeye/youeye.sock"}}}]`)
	if err := validateCopyContainerDevices(raw, "/var/lib/youeye"); err != nil {
		t.Fatal(err)
	}
	if err := validateCopyNetworks(raw, []byte(`[{"name":"youeye0","type":"bridge","managed":true}]`)); err != nil {
		t.Fatal(err)
	}
	for _, networks := range []string{`[]`, `[{"name":"youeye0","type":"physical","managed":true}]`, `[{"name":"youeye0","type":"bridge","managed":false}]`} {
		if validateCopyNetworks(raw, []byte(networks)) == nil {
			t.Fatal("accepted external network")
		}
	}
}
