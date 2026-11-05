package util

import (
	"context"
	"encoding/json"
	"net"
	"os/exec"
	"strings"
	"time"
)

// GetPrimaryIP detects an assigned LAN IPv4 address from kernel route and
// interface observations. Container bridges and tunnels are never LAN evidence.
// Returns "<your-ip>" when no unambiguous address can be established.
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

type primaryIPInterface struct {
	Name     string   `json:"ifname"`
	Flags    []string `json:"flags"`
	LinkInfo struct {
		Kind string `json:"info_kind"`
	} `json:"linkinfo"`
	Addresses []struct {
		Family string `json:"family"`
		Local  string `json:"local"`
		Scope  string `json:"scope"`
	} `json:"addr_info"`
}

type primaryIPRoute struct {
	Device          string `json:"dev"`
	PreferredSource string `json:"prefsrc"`
	Source          string `json:"src"`
}

// This is a kernel lookup, not a connection to the lookup destination. Use
// argv and bounded commands: boot-time observation must not hang the updater.
func detectPrimaryIPOnce() string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	addresses, err := exec.CommandContext(ctx, "ip", "-j", "-d", "-4", "address", "show", "up").Output()
	if err != nil {
		return ""
	}
	routes, err := exec.CommandContext(ctx, "ip", "-j", "-4", "route", "get", "1.1.1.1").Output()
	if err != nil {
		routes = []byte("[]")
	}
	return selectPrimaryIP(addresses, routes)
}

func managedOrTunnelInterface(i primaryIPInterface) bool {
	for _, prefix := range []string{"incusbr", "lxdbr", "yeapp", "docker", "virbr", "veth", "br-", "fwbr", "fwpr", "fwln", "tap", "tun", "wg", "tailscale"} {
		if strings.HasPrefix(i.Name, prefix) {
			return true
		}
	}
	switch i.LinkInfo.Kind {
	case "veth", "tun", "wireguard", "vxlan", "geneve", "gre", "gretap", "ipip", "sit", "ip6tnl", "dummy":
		return true
	}
	return false
}

func assignedLANAddresses(i primaryIPInterface) []string {
	up := false
	for _, flag := range i.Flags {
		if flag == "LOOPBACK" {
			return nil
		}
		if flag == "UP" {
			up = true
		}
	}
	if !up || i.Name == "" || managedOrTunnelInterface(i) {
		return nil
	}
	var result []string
	for _, a := range i.Addresses {
		ip := net.ParseIP(a.Local)
		if a.Family == "inet" && a.Scope == "global" && ip != nil && ip.To4() != nil && ip.IsGlobalUnicast() {
			result = append(result, ip.String())
		}
	}
	return result
}

func selectPrimaryIP(addressJSON, routeJSON []byte) string {
	var interfaces []primaryIPInterface
	var routes []primaryIPRoute
	if json.Unmarshal(addressJSON, &interfaces) != nil || json.Unmarshal(routeJSON, &routes) != nil {
		return ""
	}
	// Require the preferred source to belong to the exact up interface. A stale
	// route or malformed observation must not silently choose a different address.
	if len(routes) > 1 {
		return ""
	}
	if len(routes) == 1 {
		r := routes[0]
		for _, i := range interfaces {
			if i.Name != r.Device {
				continue
			}
			if managedOrTunnelInterface(i) {
				break
			}
			source := r.PreferredSource
			if source == "" {
				source = r.Source
			}
			for _, address := range assignedLANAddresses(i) {
				if address == source {
					return address
				}
			}
			return ""
		}
		// A missing device is inconsistent; a tunnel route may instead use the
		// single physical LAN below, without treating its tunnel address as a LAN.
		found := false
		for _, i := range interfaces {
			if i.Name == r.Device {
				found = true
			}
		}
		if !found {
			return ""
		}
	}
	// Offline/early-boot fallback: exactly one address on an eligible interface.
	// Generic bridges are permitted only with explicit route evidence above.
	var candidate string
	for _, i := range interfaces {
		switch i.LinkInfo.Kind {
		case "", "vlan", "bond", "team":
		default:
			continue
		}
		for _, address := range assignedLANAddresses(i) {
			if candidate != "" {
				return ""
			}
			candidate = address
		}
	}
	return candidate
}
