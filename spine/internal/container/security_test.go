package container

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestUIEgressBlockRuleArgsTargetsBothControlServices(t *testing.T) {
	got := uiEgressBlockRuleArgs("ye-ui-egress-block", "10.251.54.16")
	want := []string{
		"network", "acl", "rule", "add", "ye-ui-egress-block",
		"egress",
		"action=reject",
		"protocol=tcp",
		"destination=10.251.54.16/32",
		"destination_port=3000,3001",
		"--description", "Block UI from reaching Control Panel services",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("uiEgressBlockRuleArgs() = %#v, want %#v", got, want)
	}
}

func TestVerifyUIEgressBlockACLAcceptsIncusEgressSection(t *testing.T) {
	acl := `name: ye-ui-egress-block
description: Block UI container from reaching Control Panel services
egress:
  - action: reject
    destination: 10.251.54.16/32
    protocol: tcp
    destination_port: 3000,3001
    description: Block UI from reaching Control Panel services
    state: enabled
ingress: []
config: {}
`
	if err := verifyUIEgressBlockACL("ye-ui-egress-block", acl, "10.251.54.16"); err != nil {
		t.Fatalf("verifyUIEgressBlockACL returned error: %v", err)
	}
}

func TestVerifyUIEgressBlockACLRejectsIncompletePortSet(t *testing.T) {
	acl := `name: ye-ui-egress-block
egress:
  - action: reject
    destination: 10.251.54.16/32
    protocol: tcp
    destination_port: 3000
    state: enabled
`
	if err := verifyUIEgressBlockACL("ye-ui-egress-block", acl, "10.251.54.16"); err == nil {
		t.Fatal("verifyUIEgressBlockACL should require both Control Panel ports")
	}
}

func TestVerifyUIEgressBlockACLRejectsMissingEgress(t *testing.T) {
	acl := `name: ye-ui-egress-block
ingress:
  - action: reject
    destination: 10.251.54.16/32
    protocol: tcp
    destination_port: "3000,3001"
    state: enabled
`
	if err := verifyUIEgressBlockACL("ye-ui-egress-block", acl, "10.251.54.16"); err == nil {
		t.Fatal("verifyUIEgressBlockACL should reject ACLs without an egress rule section")
	}
}

func TestControlPanelPortProxyArgsBindLocalhostOnly(t *testing.T) {
	got := controlPanelPortProxyArgs("youeye-control", 3000)
	want := []string{
		"config", "device", "add", "youeye-control", "port3000", "proxy",
		"bind=host",
		"listen=tcp:127.0.0.1:3000",
		"connect=tcp:127.0.0.1:3000",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("controlPanelPortProxyArgs() = %#v, want %#v", got, want)
	}
}

// fakeIncusProxy puts an `incus` in PATH that keeps youeye-control's devices
// in a file and logs every call.
func fakeIncusProxy(t *testing.T, devices string) (calls func() []string) {
	t.Helper()
	dir := t.TempDir()
	state, log := filepath.Join(dir, "devices"), filepath.Join(dir, "log")
	if err := os.WriteFile(state, []byte(devices), 0o600); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
echo "$*" >> "` + log + `"
case "$1 $2 $3" in
"config device show") cat "` + state + `" ;;
"config device remove") grep -q '^port3000:' "` + state + `" || exit 1; : > "` + state + `" ;;
"config device add") printf 'port3000:\n  bind: host\n  connect: tcp:127.0.0.1:3000\n  listen: tcp:127.0.0.1:3000\n  type: proxy\n' > "` + state + `" ;;
*) exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "incus"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	return func() []string {
		raw, _ := os.ReadFile(log)
		return strings.Split(strings.TrimSpace(string(raw)), "\n")
	}
}

const rightControlPanelProxy = "port3000:\n  bind: host\n  connect: tcp:127.0.0.1:3000\n  listen: tcp:127.0.0.1:3000\n  type: proxy\n"

// A proxy device that is already right is left alone: removing and adding it
// cuts every connection through it (the CLI's update stream ended with
// "unexpected EOF" at every start of the API service). Before 0.6.15 the
// repair always removed and added it.
func TestRepairControlPanelPortProxyLeavesARightDeviceAlone(t *testing.T) {
	calls := fakeIncusProxy(t, rightControlPanelProxy)
	if err := RepairControlPanelPortProxy("youeye-control", 3000); err != nil {
		t.Fatal(err)
	}
	for _, call := range calls() {
		if strings.Contains(call, "device remove") || strings.Contains(call, "device add") {
			t.Fatalf("a correct proxy device was changed: %v", calls())
		}
	}
}

func TestRepairControlPanelPortProxyRepairsDrift(t *testing.T) {
	for name, devices := range map[string]string{
		"listening on every interface": "port3000:\n  bind: host\n  connect: tcp:127.0.0.1:3000\n  listen: tcp:0.0.0.0:3000\n  type: proxy\n",
		"missing":                      "eth0:\n  type: nic\n",
		"connecting elsewhere":         "port3000:\n  bind: host\n  connect: tcp:127.0.0.1:3001\n  listen: tcp:127.0.0.1:3000\n  type: proxy\n",
	} {
		t.Run(name, func(t *testing.T) {
			calls := fakeIncusProxy(t, devices)
			if err := RepairControlPanelPortProxy("youeye-control", 3000); err != nil {
				t.Fatal(err)
			}
			added := 0
			for _, call := range calls() {
				if strings.HasPrefix(call, "config device add youeye-control port3000 proxy") {
					added++
				}
			}
			if added != 1 || VerifyControlPanelPortProxy("youeye-control", 3000) != nil {
				t.Fatalf("drift was not repaired: %v", calls())
			}
		})
	}
}

// The check reads the port3000 device itself, not any line of the listing:
// another device's `bind: host` or `type: proxy` proves nothing about it.
func TestVerifyControlPanelPortProxyReadsItsOwnDevice(t *testing.T) {
	other := "spine-socket:\n  bind: host\n  connect: unix:/run/youeye/spine.sock\n  listen: unix:/run/spine.sock\n  type: proxy\n"
	fakeIncusProxy(t, other+"port3000:\n  connect: tcp:127.0.0.1:3000\n  listen: tcp:127.0.0.1:3000\n  type: nic\n")
	if err := VerifyControlPanelPortProxy("youeye-control", 3000); err == nil {
		t.Fatal("a port3000 device that is no host proxy passed because another device is one")
	}
	fakeIncusProxy(t, other+rightControlPanelProxy+"eth0:\n  name: eth0\n  type: nic\n")
	if err := VerifyControlPanelPortProxy("youeye-control", 3000); err != nil {
		t.Fatal(err)
	}
}
