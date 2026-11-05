package systemupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

type CoreCheckpointContainer struct {
	Name      string  `json:"name"`
	RootPool  string  `json:"root_pool,omitempty"`
	UUID      string  `json:"uuid"`
	Running   bool    `json:"running"`
	Autostart *string `json:"autostart,omitempty"`
	Snapshot  string  `json:"snapshot,omitempty"`
}

type CoreCheckpointFiles struct {
	Path       string `json:"path"` // exact relative platform path, never an arbitrary restore destination
	Present    bool   `json:"present"`
	Dataset    string `json:"dataset,omitempty"`
	Mountpoint string `json:"mountpoint,omitempty"`
	Snapshot   string `json:"snapshot,omitempty"`
}

type CoreCheckpointInventory struct {
	Bridge             string                    `json:"bridge"`
	IngressPorts       []uint16                  `json:"ingress_ports"`
	Schema             string                    `json:"schema"`
	RequestID          string                    `json:"request_id"`
	ManifestSHA256     string                    `json:"manifest_sha256"`
	Machine            CoreMachineIdentity       `json:"machine"`
	Containers         []CoreCheckpointContainer `json:"containers"`
	Files              []CoreCheckpointFiles     `json:"files"`
	AppInventorySHA256 string                    `json:"app_inventory_sha256"`
}

// NativeCoreCheckpoint owns only this appliance's frozen platform resources.
// Commands capture bounded data privately; errors never include provider output,
// SQL, container environments or owner values.
type NativeCoreCheckpoint struct {
	DNSHostAddress func(context.Context) (string, error)
	// Set only while the exact original recovery child is locked and settled.
	allowDNSRepairStart  bool
	recoveryPreviousBoot string
	recoveryCurrentBoot  string
	AvailableDataBytes   func(string) (uint64, error)
	RestoreStream        func(context.Context, io.Reader, string, ...string) error
	Stream               func(context.Context, io.Writer, string, ...string) error
	MachineObservation   func() (CoreMachineIdentity, error)
	Bridge               string
	IngressPorts         []uint16
	Root                 string
	DataRoot             string
	StatePath            string
	Capture              func(context.Context, string, ...string) ([]byte, error)
}

type coreBoundedOutput struct {
	bytes.Buffer
	limit int
}

func (w *coreBoundedOutput) Write(p []byte) (int, error) {
	if w.Len()+len(p) > w.limit {
		return 0, fmt.Errorf("native observation exceeded its bound")
	}
	return w.Buffer.Write(p)
}

func captureCoreNative(ctx context.Context, program string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if program == "incus" {
		var err error
		args, err = coreNativeIncusArgs(args)
		if err != nil {
			return nil, err
		}
	}
	cmd := exec.CommandContext(ctx, program, args...)
	out := &coreBoundedOutput{limit: 32 << 20}
	cmd.Stdout, cmd.Stderr = out, io.Discard
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("native checkpoint observation failed")
	}
	return out.Bytes(), nil
}

// Incus query rejects the global --project option. Its raw API URI must carry
// the same explicit project boundary; ordinary commands retain the CLI option.
func coreNativeIncusArgs(args []string) ([]string, error) {
	if len(args) == 0 {
		return nil, fmt.Errorf("native Incus command required")
	}
	if args[0] != "query" {
		return append([]string{"--force-local", "--project", "default"}, args...), nil
	}
	raw := len(args) == 3 && args[2] == "--raw"
	if len(args) != 2 && !raw {
		return nil, fmt.Errorf("exact native Incus query required")
	}
	u, err := url.ParseRequestURI(args[1])
	if err != nil || u.Scheme != "" || u.Host != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, "/1.0/") || u.RawPath != "" {
		return nil, fmt.Errorf("local native Incus API path required")
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return nil, fmt.Errorf("invalid native Incus query")
	}
	if values, exists := query["project"]; exists && (len(values) != 1 || values[0] != "default") {
		return nil, fmt.Errorf("native Incus query project differs")
	}
	query.Set("project", "default")
	u.RawQuery = query.Encode()
	result := []string{"--force-local", "query", u.String()}
	if raw {
		result = append(result, "--raw")
	}
	return result, nil
}

func (p NativeCoreCheckpoint) capture(ctx context.Context, program string, args ...string) ([]byte, error) {
	if p.Capture != nil {
		return p.Capture(ctx, program, args...)
	}
	return captureCoreNative(ctx, program, args...)
}

func coreCheckpointSnapshot(request string) string {
	return fmt.Sprintf("youeye-core-%x", sha256.Sum256([]byte(request)))[:44]
}

func (p NativeCoreCheckpoint) installedOwners() (map[string]bool, string, error) {
	owned := map[string]bool{"youeye-control": true, "youeye-ui": true, "youeye-postgres": true, "youeye-caddy": true, "youeye-pihole": true, "youeye-pointer": true}
	entries, err := os.ReadDir(p.DataRoot)
	if err != nil {
		return nil, "", err
	}
	hash := sha256.New()
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "app-") {
			continue
		}
		if !entry.IsDir() {
			return nil, "", fmt.Errorf("application ownership path is not a directory")
		}
		raw, err := ReadCoreState(filepath.Join(p.DataRoot, entry.Name(), "install.json"), 4<<20)
		if os.IsNotExist(err) {
			continue
		} // retained-only data is not a live writer
		if err != nil {
			return nil, "", err
		}
		var meta struct {
			AppID      string `json:"appId"`
			Containers []struct {
				ContainerName string `json:"containerName"`
			} `json:"containers"`
			Lifecycle *struct {
				State string `json:"state"`
			} `json:"lifecycleOperation"`
		}
		if json.Unmarshal(raw, &meta) != nil || entry.Name() != "app-"+meta.AppID || meta.AppID == "" || len(meta.Containers) == 0 {
			return nil, "", fmt.Errorf("application ownership metadata is invalid")
		}
		if meta.Lifecycle != nil && meta.Lifecycle.State != "completed" {
			return nil, "", fmt.Errorf("application lifecycle must settle before core checkpoint")
		}
		for _, c := range meta.Containers {
			if !coreContainerName.MatchString(c.ContainerName) || owned[c.ContainerName] {
				return nil, "", fmt.Errorf("application container ownership is ambiguous")
			}
			owned[c.ContainerName] = true
		}
		_, _ = hash.Write([]byte(entry.Name() + "\x00"))
		_, _ = hash.Write(raw)
		_, _ = hash.Write([]byte{0})
	}
	return owned, fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func coreCheckpointContainers(raw []byte, owned map[string]bool, snapshot string) ([]CoreCheckpointContainer, error) {
	var observed []struct {
		Name            string                       `json:"name"`
		Status          string                       `json:"status"`
		Config          map[string]string            `json:"config"`
		ExpandedDevices map[string]map[string]string `json:"expanded_devices"`
	}
	if err := json.Unmarshal(raw, &observed); err != nil {
		return nil, fmt.Errorf("native container inventory is unreadable")
	}
	seen := map[string]bool{}
	var out []CoreCheckpointContainer
	for _, c := range observed {
		if !owned[c.Name] || seen[c.Name] || c.Config["volatile.uuid"] == "" {
			return nil, fmt.Errorf("foreign or ambiguous container prevents writer closure")
		}
		if c.Status != "Running" && c.Status != "Stopped" {
			return nil, fmt.Errorf("container state is not settled")
		}
		if c.Config["user.youeye.update_operation"] != "" || c.Config["user.youeye.core-request"] != "" {
			return nil, fmt.Errorf("container belongs to retained maintenance")
		}
		seen[c.Name] = true
		entry := CoreCheckpointContainer{Name: c.Name, UUID: c.Config["volatile.uuid"], Running: c.Status == "Running"}
		if value, ok := c.Config["boot.autostart"]; ok {
			entry.Autostart = &value
		}
		if c.Name == "youeye-control" || c.Name == "youeye-ui" {
			if !entry.Running {
				return nil, fmt.Errorf("core service containers must be operational before an ordinary update")
			}
			pool, err := coreRootPool(c.ExpandedDevices)
			if err != nil {
				return nil, err
			}
			entry.RootPool, entry.Snapshot = pool, snapshot
		}
		if (c.Name == "youeye-postgres" || c.Name == "youeye-caddy" || c.Name == "youeye-pihole") && !entry.Running {
			return nil, fmt.Errorf("required database and networking services must already be running")
		}
		out = append(out, entry)
	}
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-postgres", "youeye-caddy", "youeye-pihole"} {
		if !seen[name] {
			return nil, fmt.Errorf("required platform container is missing")
		}
	}
	for name := range owned {
		if name != "youeye-pointer" && !seen[name] {
			return nil, fmt.Errorf("installed application container is missing")
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Inspect performs read-only native preflight under the global lifecycle hold.
// It records no secret/configuration values and never stops an unknown workload.
func (p NativeCoreCheckpoint) Inspect(ctx context.Context, j CoreJournal) (CoreCheckpointInventory, error) {
	var inventory CoreCheckpointInventory
	if !filepath.IsAbs(p.Root) || !filepath.IsAbs(p.DataRoot) || !filepath.IsAbs(p.StatePath) || !coreRequestPattern.MatchString(j.RequestID) || !validSHA256(j.ManifestSHA256) {
		return inventory, fmt.Errorf("exact native checkpoint roots and request required")
	}
	if !coreContainerName.MatchString(p.Bridge) || len(p.IngressPorts) == 0 || len(p.IngressPorts) > 16 {
		return inventory, fmt.Errorf("observed core bridge and ingress ports required")
	}
	for _, port := range p.IngressPorts {
		if port == 0 {
			return inventory, fmt.Errorf("invalid core ingress port")
		}
	}
	reservation, err := (CoreLifecycleBarrier{Root: filepath.Join(p.DataRoot, "state", "app-updates")}).Read()
	if err != nil || reservation.RequestID != j.RequestID || reservation.ManifestSHA256 != j.ManifestSHA256 {
		return inventory, fmt.Errorf("exact core lifecycle reservation required")
	}
	machine, err := p.observeMachine()
	if err != nil {
		return inventory, err
	}
	if machine != j.Previous.Machine || machine.Validate() != nil {
		return inventory, fmt.Errorf("installed machine changed before checkpoint")
	}
	owned, digest, err := p.installedOwners()
	if err != nil {
		return inventory, err
	}
	raw, err := p.capture(ctx, "incus", "list", "--format=json")
	if err != nil {
		return inventory, err
	}
	snapshot := coreCheckpointSnapshot(j.RequestID)
	containers, err := coreCheckpointContainers(raw, owned, snapshot)
	if err != nil {
		return inventory, err
	}
	datasets, err := p.capture(ctx, "zfs", "list", "-H", "-o", "name,mountpoint", "-t", "filesystem")
	if err != nil {
		return inventory, err
	}
	files, err := p.checkpointFileInventory(string(datasets), snapshot)
	if err != nil {
		return inventory, err
	}
	return CoreCheckpointInventory{Schema: "youeye.core-checkpoint-inventory.v1", RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Machine: machine, Containers: containers, Files: files, AppInventorySHA256: digest, Bridge: p.Bridge, IngressPorts: append([]uint16{}, p.IngressPorts...)}, nil
}

func (p NativeCoreCheckpoint) observeMachine() (CoreMachineIdentity, error) {
	if p.MachineObservation != nil {
		return p.MachineObservation()
	}
	state, err := appliance.LoadState(p.StatePath)
	if err != nil {
		return CoreMachineIdentity{}, fmt.Errorf("native machine state is unavailable")
	}
	_, manifest, err := appliance.Detect()
	if err != nil || manifest == nil {
		return CoreMachineIdentity{}, fmt.Errorf("verified appliance runtime required")
	}
	partitions, err := appliance.DiscoverPartitions()
	if err != nil {
		return CoreMachineIdentity{}, fmt.Errorf("native partition identity is unavailable")
	}
	if err := appliance.ValidateStateContract(*manifest, state, partitions); err != nil {
		return CoreMachineIdentity{}, fmt.Errorf("actual appliance hardware differs from retained state")
	}
	return CoreMachineIdentity{InstallIDRef: state.InstallIDRef, DeviceIDRef: state.DeviceIDRef, ParentDiskID: state.ParentDiskID, StatePartUUID: state.StatePartUUID, DataPartUUID: state.DataPartUUID}, nil
}

func (p NativeCoreCheckpoint) checkpointFileInventory(datasetText, snapshot string) ([]CoreCheckpointFiles, error) {
	var files []CoreCheckpointFiles
	for _, relative := range []string{"control", "config", "ui", "ui-data", "pointer"} {
		entry := CoreCheckpointFiles{Path: relative}
		destination := filepath.Join(p.DataRoot, relative)
		info, err := os.Lstat(destination)
		if os.IsNotExist(err) {
			files = append(files, entry)
			continue
		}
		if err != nil || !info.IsDir() {
			return nil, fmt.Errorf("core persistent path is not a directory")
		}
		entry.Present = true
		for _, line := range strings.Split(strings.TrimSpace(datasetText), "\n") {
			parts := strings.Split(line, "\t")
			if len(parts) != 2 || !filepath.IsAbs(parts[1]) {
				continue
			}
			mount := filepath.Clean(parts[1])
			if mount != p.DataRoot && !strings.HasPrefix(mount, p.DataRoot+"/") {
				continue
			}
			if strings.HasPrefix(mount, destination+"/") {
				return nil, fmt.Errorf("nested core data datasets require explicit checkpoint coverage")
			}
			if (destination == mount || strings.HasPrefix(destination, mount+"/")) && len(mount) > len(entry.Mountpoint) {
				entry.Dataset, entry.Mountpoint, entry.Snapshot = parts[0], mount, snapshot
			}
		}
		if !validCoreDataset(entry.Dataset) {
			return nil, fmt.Errorf("core persistent files lack exact ZFS snapshot coverage")
		}
		files = append(files, entry)
	}
	return files, nil
}

// Resolve the expanded root device so inherited profile changes cannot silently
// move the rollback source to another pool.
func coreRootPool(devices map[string]map[string]string) (string, error) {
	pool := ""
	for _, d := range devices {
		if d["type"] != "disk" || d["path"] != "/" {
			continue
		}
		if pool != "" || !coreContainerName.MatchString(d["pool"]) {
			return "", fmt.Errorf("core root storage identity is ambiguous")
		}
		pool = d["pool"]
	}
	if pool == "" {
		return "", fmt.Errorf("core root storage identity is missing")
	}
	return pool, nil
}
