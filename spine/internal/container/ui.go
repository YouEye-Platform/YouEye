package container

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/incus"
	"gopkg.in/yaml.v3"
)

const UIEgressBlockACLName = "ye-ui-egress-block"

func uiEgressBlockRuleArgs(aclName, cpIP string) []string {
	return []string{
		"network", "acl", "rule", "add", aclName,
		"egress",
		"action=reject",
		"protocol=tcp",
		fmt.Sprintf("destination=%s/32", cpIP),
		"destination_port=3000,3001",
		"--description", "Block UI from reaching Control Panel services",
	}
}

// EnforceUIEgressBlock creates (if needed) and applies a network ACL that
// prevents the UI container from initiating connections to the CP container.
// CP→UI traffic is unaffected. This enforces the one-way bridge: CP pushes
// to UI, UI never calls CP. Browser-side iframes bypass this entirely since
// they go through Caddy, not container-to-container networking.
//
// Idempotent — safe to call on every deploy/update.
func EnforceUIEgressBlock() error {
	cpIP, err := incus.GetSystemContainerIP("youeye-control")
	if err != nil {
		return fmt.Errorf("resolve Control Panel IP for egress block: %w", err)
	}

	if err := repairUIEgressBlockACL(UIEgressBlockACLName, cpIP); err != nil {
		return err
	}
	if err := verifyUIEgressBlock(UIEgressBlockACLName, cpIP); err != nil {
		return err
	}

	fmt.Printf("  ✓ UI→Control Panel egress block enforced (ACL: %s, blocked: %s:3000,3001)\n", UIEgressBlockACLName, cpIP)
	return nil
}

func repairUIEgressBlockACL(aclName, cpIP string) error {
	// Recreate the ACL deterministically so stale rules never keep pointing at
	// an old Control Panel IP after clone/update/reconcile.
	_ = exec.Command("incus", "config", "device", "unset", "youeye-ui", "eth0", "security.acls").Run()
	_ = exec.Command("incus", "network", "acl", "delete", aclName).Run()

	if out, err := exec.Command("incus", "network", "acl", "create", aclName,
		"--description", "Block UI container from reaching Control Panel services").CombinedOutput(); err != nil {
		return fmt.Errorf("create network ACL %s: %w: %s", aclName, err, strings.TrimSpace(string(out)))
	}

	if out, err := exec.Command("incus", uiEgressBlockRuleArgs(aclName, cpIP)...).CombinedOutput(); err != nil {
		return fmt.Errorf("add egress reject rule to %s: %w: %s", aclName, err, strings.TrimSpace(string(out)))
	}

	// Apply ACL to UI container's eth0 (idempotent — set overwrites).
	// CRITICAL: set default actions to "allow" so only the explicit reject rule
	// takes effect. Without this, Incus defaults to rejecting ALL traffic that
	// doesn't match a rule, which kills all UI networking (inbound and outbound).
	if out, err := exec.Command("incus", "config", "device", "set",
		"youeye-ui", "eth0",
		"security.acls", aclName,
		"security.acls.default.ingress.action", "allow",
		"security.acls.default.egress.action", "allow",
	).CombinedOutput(); err != nil {
		return fmt.Errorf("apply ACL to youeye-ui eth0: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func verifyUIEgressBlock(aclName, cpIP string) error {
	aclOut, err := exec.Command("incus", "network", "acl", "show", aclName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("verify ACL %s exists: %w: %s", aclName, err, strings.TrimSpace(string(aclOut)))
	}
	if err := verifyUIEgressBlockACL(aclName, string(aclOut), cpIP); err != nil {
		return err
	}

	devOut, err := exec.Command("incus", "config", "device", "show", "youeye-ui").CombinedOutput()
	if err != nil {
		return fmt.Errorf("verify youeye-ui devices: %w: %s", err, strings.TrimSpace(string(devOut)))
	}
	devices := string(devOut)
	for _, want := range []string{
		fmt.Sprintf("security.acls: %s", aclName),
		"security.acls.default.ingress.action: allow",
		"security.acls.default.egress.action: allow",
	} {
		if !strings.Contains(devices, want) {
			return fmt.Errorf("youeye-ui eth0 missing %q", want)
		}
	}
	return nil
}

func verifyUIEgressBlockACL(aclName, acl, cpIP string) error {
	type aclRule struct {
		Action          string `yaml:"action"`
		State           string `yaml:"state"`
		Protocol        string `yaml:"protocol"`
		Destination     string `yaml:"destination"`
		DestinationPort string `yaml:"destination_port"`
	}
	var document struct {
		Egress []aclRule `yaml:"egress"`
	}
	if err := yaml.Unmarshal([]byte(acl), &document); err != nil {
		return fmt.Errorf("parse ACL %s: %w", aclName, err)
	}
	for _, rule := range document.Egress {
		if rule.Action == "reject" &&
			rule.State == "enabled" &&
			rule.Protocol == "tcp" &&
			rule.Destination == fmt.Sprintf("%s/32", cpIP) &&
			hasExactDestinationPorts(rule.DestinationPort, "3000", "3001") {
			return nil
		}
	}
	return fmt.Errorf("ACL %s does not contain the enabled TCP reject rule for %s ports 3000 and 3001", aclName, cpIP)
}

func hasExactDestinationPorts(value string, expected ...string) bool {
	actual := map[string]bool{}
	for _, port := range strings.Split(value, ",") {
		port = strings.TrimSpace(port)
		if port != "" {
			actual[port] = true
		}
	}
	if len(actual) != len(expected) {
		return false
	}
	for _, port := range expected {
		if !actual[port] {
			return false
		}
	}
	return true
}

func CheckUIEgressBlock() []string {
	cpIP, err := incus.GetSystemContainerIP("youeye-control")
	if err != nil {
		return []string{fmt.Sprintf("UI→CP ACL cannot resolve Control Panel IP (%v)", err)}
	}
	if err := verifyUIEgressBlock(UIEgressBlockACLName, cpIP); err != nil {
		return []string{fmt.Sprintf("UI→CP ACL drift (%v)", err)}
	}
	return nil
}
