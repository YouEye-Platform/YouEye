// Package mdns publishes the box as youeye.local on the LAN. It runs Avahi
// with a configuration Spine writes at every start, limited to the wired LAN
// adapter (never incusbr0, app bridges or veths). systemd-resolved stays off
// for mDNS: it can't be kept off the container bridges, and on a name
// conflict it renames to "youeye11" instead of "youeye-2" (spike, Plan 8).
package mdns

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	// ConfigPath is the Avahi configuration Spine writes (tmpfs, per boot).
	ConfigPath = "/run/youeye/avahi-daemon.conf"
	// HostName is the name the box asks for; Avahi picks youeye-2, -3 … when
	// another box on the LAN already has it.
	HostName = "youeye"
	// DefaultName is shown when the published name can't be read.
	DefaultName = HostName + ".local"
)

var interfaceName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,15}$`)

// Config is the Avahi configuration for the LAN adapter iface.
func Config(iface string) (string, error) {
	if !interfaceName.MatchString(iface) {
		return "", fmt.Errorf("invalid network adapter name %q", iface)
	}
	return strings.Join([]string{
		"# Written by YouEye Spine (youeye mdns run); changes are lost at restart.",
		"[server]",
		"host-name=" + HostName,
		"use-ipv4=yes",
		"use-ipv6=no",
		"allow-interfaces=" + iface,
		"disallow-other-stacks=yes",
		"enable-dbus=yes",
		"ratelimit-interval-usec=1000000",
		"ratelimit-burst=1000",
		"",
		"[wide-area]",
		"enable-wide-area=no",
		"",
		"[publish]",
		"publish-addresses=yes",
		"publish-hinfo=no",
		"publish-workstation=no",
		"publish-domain=no",
		"publish-aaaa-on-ipv4=no",
		"publish-a-on-ipv6=no",
		"",
		"[reflector]",
		"enable-reflector=no",
		"",
	}, "\n"), nil
}

// LANInterface returns the adapter that holds the IPv4 default route, read
// from a /proc/net/route style table. Container bridges never carry it.
func LANInterface(routeTable io.Reader) (string, error) {
	scanner := bufio.NewScanner(routeTable)
	first := true
	for scanner.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(scanner.Text())
		if len(fields) < 8 {
			continue
		}
		// Destination 0 and mask 0: the default route.
		if fields[1] == "00000000" && fields[7] == "00000000" && interfaceName.MatchString(fields[0]) {
			if isContainerLink(fields[0]) {
				continue
			}
			return fields[0], nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", errors.New("no IPv4 default route yet")
}

func isContainerLink(name string) bool {
	for _, prefix := range []string{"incusbr", "yeapp", "veth", "lo", "tap", "docker"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// WriteConfig writes the configuration for the current LAN adapter.
func WriteConfig(path string) (string, error) {
	routes, err := os.Open("/proc/net/route")
	if err != nil {
		return "", err
	}
	defer routes.Close()
	iface, err := LANInterface(routes)
	if err != nil {
		return "", err
	}
	text, err := Config(iface)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0644); err != nil {
		return "", err
	}
	return iface, os.Rename(tmp, path)
}

var publishedName = regexp.MustCompile(`^"?(youeye(-[0-9]{1,4})?\.local)"?$`)

// ParseBusctl reads the reply of
// `busctl call org.freedesktop.Avahi / org.freedesktop.Avahi.Server GetHostNameFqdn`
// (`s "youeye-2.local"`).
func ParseBusctl(output string) (string, error) {
	output = strings.TrimSpace(output)
	value, ok := strings.CutPrefix(output, "s ")
	if !ok {
		return "", fmt.Errorf("unexpected Avahi reply %q", output)
	}
	match := publishedName.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return "", fmt.Errorf("unexpected published name %q", value)
	}
	return match[1], nil
}

// PublishedName asks Avahi (over D-Bus) which name it publishes now.
func PublishedName(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "busctl", "call", "--timeout=2",
		"org.freedesktop.Avahi", "/", "org.freedesktop.Avahi.Server", "GetHostNameFqdn").Output()
	if err != nil {
		return "", fmt.Errorf("read the published mDNS name: %w", err)
	}
	return ParseBusctl(string(out))
}
