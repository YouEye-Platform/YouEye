package systemupdate

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const copyDHCPNetwork = "[Match]\nName=en* eth*\n\n[Network]\nDHCP=ipv4\nIPv6AcceptRA=no\nLinkLocalAddressing=ipv4\n"

// The supported copy layout uses native IPv4 DHCP. Static addresses, additional
// network units and explicit client/DUID identities need a copy adapter; silently
// retaining them could reuse the source address before any product probe.
func InspectIndependentCopyNetwork(root string) error {
	directory := filepath.Join(root, "etc/systemd/network")
	entries, err := os.ReadDir(directory)
	if err != nil {
		return fmt.Errorf("native network configuration unavailable")
	}
	for _, entry := range entries {
		if entry.Name() != "20-youeye.network" {
			return fmt.Errorf("additional host network configuration requires a copy adapter")
		}
	}
	raw, err := os.ReadFile(filepath.Join(directory, "20-youeye.network"))
	if err != nil {
		return err
	}
	section := ""
	dhcp := false
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if line == "[Match]" || line == "[Network]" {
			section = line
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("host network requires a copy adapter")
		}
		if section == "[Match]" && (key == "Name" || key == "MACAddress") {
			continue
		}
		if section == "[Network]" && ((key == "DHCP" && value == "ipv4") || (key == "IPv6AcceptRA" && value == "no") || (key == "LinkLocalAddressing" && value == "ipv4")) {
			if key == "DHCP" {
				dhcp = true
			}
			continue
		}
		return fmt.Errorf("host static/custom network authority requires a copy adapter")
	}
	if !dhcp {
		return fmt.Errorf("independent copy requires native IPv4 DHCP")
	}
	for _, file := range []string{"network-profile.json", "network-last-good-profile.json"} {
		raw, err = os.ReadFile(filepath.Join(root, "var/lib/youeye-state/bootstrap", file))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		var profile struct {
			IPv4 struct {
				Mode string `json:"mode"`
			} `json:"ipv4"`
		}
		if json.Unmarshal(raw, &profile) != nil || profile.IPv4.Mode != "dhcp" {
			return fmt.Errorf("retained network profile requires a copy adapter")
		}
	}
	return nil
}

func prepareIndependentCopyNetwork(root string) error {
	if err := InspectIndependentCopyNetwork(root); err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(root, "etc/systemd/network/20-youeye.network"), []byte(copyDHCPNetwork), 0644); err != nil {
		return err
	}
	for _, file := range []string{"network-profile.json", "network-last-good-profile.json"} {
		path := filepath.Join(root, "var/lib/youeye-state/bootstrap", file)
		raw, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		var profile map[string]json.RawMessage
		if json.Unmarshal(raw, &profile) != nil {
			return fmt.Errorf("invalid copied network profile")
		}
		// Empty means discover the fresh physical Ethernet adapter at boot.
		profile["adapter_mac"] = json.RawMessage(`""`)
		raw, err = json.Marshal(profile)
		if err != nil {
			return err
		}
		if err = atomicWrite(path, raw, 0600); err != nil {
			return err
		}
	}
	lastGood := filepath.Join(root, "var/lib/youeye-state/bootstrap/network-last-good.network")
	if _, err := os.Stat(lastGood); err == nil {
		if err = atomicWrite(lastGood, []byte(copyDHCPNetwork), 0600); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}
