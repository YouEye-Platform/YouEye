package incus

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// PrepareNetworkProcessState runs after persistent Incus state is mounted and
// before either Incus socket can start the daemon. A saved PID is not a process
// identity across boots: Incus may otherwise signal an unrelated process when
// it imports the previous dnsmasq record. Keep genuine live network helpers on
// same-boot service restarts; discard only their stale process records.
// Network configuration, DHCP leases and running processes are never changed.
func PrepareNetworkProcessState() error {
	return prepareNetworkProcessState("/var/lib/incus/networks", "/proc")
}

func prepareNetworkProcessState(networksRoot, procRoot string) error {
	entries, err := os.ReadDir(networksRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect Incus network process state: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		recordPath := filepath.Join(networksRoot, entry.Name(), "dnsmasq.pid")
		info, err := os.Lstat(recordPath)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect network %s process record: %w", entry.Name(), err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("network %s process record is not a regular file", entry.Name())
		}
		data, err := os.ReadFile(recordPath)
		if err != nil {
			return fmt.Errorf("read network %s process record: %w", entry.Name(), err)
		}
		var record struct {
			Name string   `yaml:"name"`
			PID  int      `yaml:"pid"`
			Args []string `yaml:"args"`
		}
		if err := yaml.Unmarshal(data, &record); err != nil || record.Name != "dnsmasq" || record.PID <= 0 {
			return fmt.Errorf("network %s has an invalid DNS process record", entry.Name())
		}
		procPath := filepath.Join(procRoot, strconv.Itoa(record.PID))
		executable, err := os.Readlink(filepath.Join(procPath, "exe"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect network %s DNS executable: %w", entry.Name(), err)
		}
		live := err == nil && filepath.Base(executable) == "dnsmasq"
		if live {
			cmdline, err := os.ReadFile(filepath.Join(procPath, "cmdline"))
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("inspect network %s DNS arguments: %w", entry.Name(), err)
			}
			args := strings.Split(string(bytes.TrimRight(cmdline, "\x00")), "\x00")
			live = err == nil && hasNetworkDNSArguments(args, networksRoot, entry.Name())
		}
		if live {
			continue
		}
		if err := os.Remove(recordPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove stale network %s DNS process record: %w", entry.Name(), err)
		}
	}
	return nil
}

func hasNetworkDNSArguments(args []string, networksRoot, network string) bool {
	interfaceArg := "--interface=" + network
	configArg := "--conf-file=" + filepath.Join(networksRoot, network, "dnsmasq.raw")
	hasInterface, hasConfig := false, false
	for _, arg := range args {
		hasInterface = hasInterface || arg == interfaceArg
		hasConfig = hasConfig || arg == configArg
	}
	return hasInterface && hasConfig
}
