// Package incus — static IP management for system containers on incusbr0.
//
// System containers get deterministic IPs in the .10–.19 range of whatever
// /24 subnet Incus auto-assigns to incusbr0. DHCP is restricted to .100–.254
// so app containers never collide with the static range.
//
// This eliminates the failure mode where proxy devices (baked at install time
// with a system container's DHCP IP) break silently when the system container
// restarts and gets a different IP.
package incus

import (
	"fmt"
	"os/exec"
	"strings"

	"git.byka.wtf/potemsla/YouEye/spine/internal/util"
)

// SystemContainerIPOffsets maps system container names to their static IP offset
// within the incusbr0 /24 subnet. Full IP = {subnet_base}.{offset}.
var SystemContainerIPOffsets = map[string]int{
	"youeye-postgres":         10,
	"youeye-authentik":        11,
	"youeye-authentik-worker": 12,
	"youeye-caddy":            13,
	"youeye-pihole":           14,
	"youeye-ui":               15,
	"youeye-control":          16,
}

// GetSubnetBase reads the incusbr0 bridge configuration and returns the subnet
// base (e.g., "10.75.26" from "10.75.26.1/24").
func GetSubnetBase() (string, error) {
	out, err := exec.Command("incus", "network", "get", "incusbr0", "ipv4.address").Output()
	if err != nil {
		return "", fmt.Errorf("failed to read incusbr0 subnet: %w", err)
	}

	// Parse "10.75.26.1/24" → "10.75.26"
	addr := strings.TrimSpace(string(out))
	ip := strings.Split(addr, "/")[0]
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return "", fmt.Errorf("unexpected incusbr0 address format: %s", addr)
	}
	return strings.Join(parts[:3], "."), nil
}

// GetSystemContainerIP returns the static IP for a system container.
func GetSystemContainerIP(containerName string) (string, error) {
	offset, ok := SystemContainerIPOffsets[containerName]
	if !ok {
		return "", fmt.Errorf("no static IP offset defined for %s", containerName)
	}

	base, err := GetSubnetBase()
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("%s.%d", base, offset), nil
}

// ConfigureSystemDHCP restricts DHCP allocation on incusbr0 to .100–.254,
// reserving .1–.99 for static system container IPs. Called after Incus init.
func ConfigureSystemDHCP() error {
	base, err := GetSubnetBase()
	if err != nil {
		return err
	}

	dhcpRange := fmt.Sprintf("%s.100-%s.254", base, base)
	if err := exec.Command("incus", "network", "set", "incusbr0",
		"ipv4.dhcp.ranges", dhcpRange).Run(); err != nil {
		return fmt.Errorf("failed to set DHCP range: %w", err)
	}

	fmt.Printf("✓ DHCP range restricted to %s (static IPs: %s.10–%s.19)\n", dhcpRange, base, base)
	return nil
}

// SetContainerStaticIP sets a static IP device override on a system container's
// eth0 NIC. Works on both running and stopped containers. Idempotent.
func SetContainerStaticIP(containerName string) error {
	ip, err := GetSystemContainerIP(containerName)
	if err != nil {
		return err
	}

	// Try device override first (works when eth0 comes purely from the default profile)
	overrideErr := exec.Command("incus", "config", "device", "override",
		containerName, "eth0", "ipv4.address="+ip).Run()

	if overrideErr != nil {
		// Device already overridden at instance level — use set instead
		if setErr := exec.Command("incus", "config", "device", "set",
			containerName, "eth0", "ipv4.address", ip).Run(); setErr != nil {
			return fmt.Errorf("failed to set static IP %s on %s: override=%v, set=%v",
				ip, containerName, overrideErr, setErr)
		}
	}

	util.LogSuccess(fmt.Sprintf("Static IP %s assigned to %s", ip, containerName))
	return nil
}
