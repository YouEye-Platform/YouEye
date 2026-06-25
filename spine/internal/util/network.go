package util

import (
	"os/exec"
	"strings"
	"time"
)

// IncusBridgeSubnetPrefix is the /24 prefix of the Incus bridge created
// during `spine deploy` (10.199.59.0/24 — see container/control.go and
// Incus's default for `incusbr0` after our setup). We MUST exclude any
// address from this range when detecting the host's primary IP, otherwise
// `GetPrimaryIP()` could return 10.199.59.1 (the bridge gateway) on a host
// where the LAN interface comes up after Incus's bridge — and `runHostIPCheck`
// would then write the bridge IP to every pinned location.
const IncusBridgeSubnetPrefix = "10.199.59."

// GetPrimaryIP attempts to detect the primary non-loopback, non-Incus-bridge
// IPv4 address of the host. Returns "<your-ip>" only as an absolute last
// resort — `runHostIPCheck` refuses to migrate when it sees that placeholder.
//
// Retries for up to ~10 seconds when no acceptable address is found, because
// at boot time on hosts that don't fully order spine.service after
// network-online.target, DHCP may not have assigned an address to the LAN
// interface yet. Without the retry, the very first call after boot can race
// DHCP and incorrectly classify a slow-DHCP boot as "detection failed".
func GetPrimaryIP() string {
	deadline := time.Now().Add(10 * time.Second)
	for {
		if ip := detectPrimaryIPOnce(); ip != "" {
			return ip
		}
		if time.Now().After(deadline) {
			return "<your-ip>"
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// detectPrimaryIPOnce is a single non-retrying attempt. Exposed for tests
// and so that callers that explicitly want a no-retry probe (none yet) can
// use it.
func detectPrimaryIPOnce() string {
	if ip := firstAcceptableIP(runIPv4ListCmd("ip -4 addr show | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}'")); ip != "" {
		return ip
	}
	if ip := firstAcceptableIP(runIPv4ListCmd("hostname -I | tr ' ' '\\n'")); ip != "" {
		return ip
	}
	return ""
}

// runIPv4ListCmd executes the given shell pipeline and returns its lines.
func runIPv4ListCmd(pipeline string) []string {
	out, err := exec.Command("sh", "-c", pipeline).Output()
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(out)), "\n")
}

// firstAcceptableIP returns the first IPv4 address in the slice that is
// not loopback and not in the Incus bridge subnet.
func firstAcceptableIP(lines []string) string {
	for _, line := range lines {
		ip := strings.TrimSpace(line)
		if ip == "" {
			continue
		}
		if strings.HasPrefix(ip, "127.") {
			continue
		}
		if strings.HasPrefix(ip, IncusBridgeSubnetPrefix) {
			continue
		}
		return ip
	}
	return ""
}
