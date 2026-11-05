package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// CopyResourceInventory contains identities and digests, never container config,
// credential values or user data. Infra retains it with the exact copy request.
type CopyResourceInventory struct {
	Schema                 string                    `json:"schema"`
	Containers             []CoreCheckpointContainer `json:"containers"`
	AppInventorySHA256     string                    `json:"app_inventory_sha256"`
	RuntimeAuthoritySHA256 string                    `json:"runtime_authority_sha256"`
	IncusAuthority         CopyIncusAuthority        `json:"incus_authority"`
	CaddyAuthoritySHA256   string                    `json:"caddy_authority_sha256"`
	SHA256                 string                    `json:"sha256"`
}

// InspectCopyResources is read-only. The native coordinator repeats it after
// acquiring source lifecycle ownership and before permitting a cold shutdown.
func (p NativeCoreCheckpoint) InspectCopyResources(ctx context.Context, supportedContainers []string) (CopyResourceInventory, error) {
	var result CopyResourceInventory
	owned, digest, err := p.installedOwners()
	if err != nil {
		return result, err
	}
	expected := map[string]bool{"youeye-control": true, "youeye-ui": true, "youeye-postgres": true, "youeye-caddy": true, "youeye-pihole": true, "youeye-pointer": true}
	for _, name := range supportedContainers {
		if !coreContainerName.MatchString(name) || expected[name] {
			return result, fmt.Errorf("ambiguous native copy container inventory")
		}
		expected[name] = true
	}
	if len(expected) != len(owned) {
		return result, fmt.Errorf("native and application copy inventories differ")
	}
	for name := range owned {
		if !expected[name] {
			return result, fmt.Errorf("unhandled installed copy workload")
		}
	}
	raw, err := p.capture(ctx, "incus", "list", "--format=json")
	if err != nil {
		return result, err
	}
	networks, err := p.capture(ctx, "incus", "query", "/1.0/networks?recursion=1")
	if err != nil {
		return result, err
	}
	if err = validateCopyNetworks(raw, networks); err != nil {
		return result, err
	}
	containers, err := coreCheckpointContainers(raw, owned, "")
	if err != nil {
		return result, err
	}
	// Every writable disk must belong to the single appliance pool or a bound
	// persistent platform directory. Never import a host path, remote volume,
	// extra device or snapshot as though it were part of the full VM disk.
	if err = validateCopyContainerDevices(raw, p.DataRoot); err != nil {
		return result, err
	}
	var observed []struct {
		Devices map[string]map[string]string `json:"expanded_devices"`
	}
	if json.Unmarshal(raw, &observed) != nil {
		return result, fmt.Errorf("invalid copied device observation")
	}
	for _, container := range observed {
		for _, device := range container.Devices {
			source := device["source"]
			if device["type"] != "disk" || device["pool"] != "" || source == "/proc/meminfo" {
				continue
			}
			resolved, e := filepath.EvalSymlinks(source)
			if e != nil || !(resolved == p.DataRoot || strings.HasPrefix(resolved, p.DataRoot+"/")) {
				return result, fmt.Errorf("copy host mount escapes appliance data")
			}
			if _, e = os.Stat(resolved); e != nil {
				return result, fmt.Errorf("copy host mount is unavailable")
			}
			filesystem, e := p.capture(ctx, "findmnt", "--noheadings", "--output", "FSTYPE,SOURCE", "--target", resolved)
			parts := strings.Fields(string(filesystem))
			if e != nil || len(parts) != 2 || parts[0] != "zfs" || !(parts[1] == "default" || strings.HasPrefix(parts[1], "default/")) {
				return result, fmt.Errorf("copy host mount has external backing")
			}
		}
	}
	for i := range containers {
		containers[i].Snapshot = ""
	}
	if err = p.inspectCopyPihole(ctx); err != nil {
		return result, err
	}
	authority, err := inspectCopyRuntimeAuthority(ctx, p)
	if err != nil {
		return result, err
	}
	incusAuthority, err := p.InspectCopyIncusAuthority(ctx)
	if err != nil {
		return result, err
	}
	caddyAuthority, err := p.InspectCopyCaddyAuthority()
	if err != nil {
		return result, err
	}
	result = CopyResourceInventory{Schema: "youeye.copy-resources.v1", Containers: containers, AppInventorySHA256: digest, RuntimeAuthoritySHA256: authority, IncusAuthority: incusAuthority, CaddyAuthoritySHA256: caddyAuthority}
	payload, _ := json.Marshal(result)
	result.SHA256 = fmt.Sprintf("%x", sha256.Sum256(payload))
	return result, nil
}
func validateCopyContainerDevices(raw []byte, dataRoot string) error {
	var containers []struct {
		Name    string                       `json:"name"`
		Devices map[string]map[string]string `json:"expanded_devices"`
	}
	if !filepath.IsAbs(dataRoot) || filepath.Clean(dataRoot) != dataRoot || json.Unmarshal(raw, &containers) != nil {
		return fmt.Errorf("invalid native copy resource observation")
	}
	local := map[string]bool{"127.0.0.1": true, "::1": true}
	for _, c := range containers {
		for _, d := range c.Devices {
			if d["type"] == "nic" {
				for _, key := range []string{"ipv4.address", "ipv6.address"} {
					if ip := net.ParseIP(d[key]); ip != nil {
						local[ip.String()] = true
					}
				}
			}
		}
	}
	for _, c := range containers {
		root := false
		names := make([]string, 0, len(c.Devices))
		for name := range c.Devices {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			d := c.Devices[name]
			switch d["type"] {
			case "nic":
				// A managed Incus network is inside the copied machine. Host bridges,
				// physical NICs, SR-IOV and macvlan remain external resources.
				if d["network"] == "" || !coreContainerName.MatchString(d["network"]) {
					return fmt.Errorf("copy workload %s has an external network device", c.Name)
				}
			case "proxy":
				if (c.Name == "youeye-control" || c.Name == "youeye-ui") && d["connect"] == "unix:/var/run/youeye/youeye.sock" && d["listen"] == d["connect"] && (d["bind"] == "container" || d["bind"] == "instance") {
					continue
				}
				protocol, endpoint, ok := strings.Cut(d["connect"], ":")
				host, port, err := net.SplitHostPort(endpoint)
				number, parseErr := strconv.Atoi(port)
				if !ok || (protocol != "tcp" && protocol != "udp") || err != nil || parseErr != nil || number < 1 || number > 65535 || !local[host] {
					return fmt.Errorf("copy workload %s has an external proxy target", c.Name)
				}
				// The listener owns no external data/credentials. It stays quarantined at
				// the VM boundary until the destination's platform authority is prepared.
			case "disk":
				if c.Name == "youeye-control" && d["source"] == "/proc/meminfo" && d["readonly"] == "true" {
					continue
				}
				if d["path"] == "/" {
					if root || d["pool"] != "default" || d["source"] != "" {
						return fmt.Errorf("copy workload %s has unsupported root storage", c.Name)
					}
					root = true
					continue
				}
				if d["pool"] != "" {
					if d["pool"] != "default" || !coreContainerName.MatchString(d["source"]) {
						return fmt.Errorf("copy workload %s has external volume storage", c.Name)
					}
					continue
				}
				source := d["source"]
				if !filepath.IsAbs(source) || filepath.Clean(source) != source || !(source == dataRoot || strings.HasPrefix(source, dataRoot+"/")) {
					return fmt.Errorf("copy workload %s has an unhandled host mount", c.Name)
				}
			default:
				return fmt.Errorf("copy workload %s has an unhandled device type", c.Name)
			}
		}
		if !root {
			return fmt.Errorf("copy workload %s has no observed root storage", c.Name)
		}
	}
	return nil
}

func validateCopyNetworks(instances, networks []byte) error {
	var observed []struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		Managed bool   `json:"managed"`
	}
	var containers []struct {
		Devices map[string]map[string]string `json:"expanded_devices"`
	}
	if json.Unmarshal(networks, &observed) != nil || json.Unmarshal(instances, &containers) != nil {
		return fmt.Errorf("copy network observation unavailable")
	}
	local := map[string]bool{}
	for _, network := range observed {
		if network.Managed && network.Type == "bridge" {
			local[network.Name] = true
		}
	}
	for _, container := range containers {
		for _, device := range container.Devices {
			if device["type"] == "nic" && !local[device["network"]] {
				return fmt.Errorf("copy network is not an appliance-owned bridge")
			}
		}
	}
	return nil
}
