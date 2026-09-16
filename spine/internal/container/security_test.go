package container

import (
	"reflect"
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
