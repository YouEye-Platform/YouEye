package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
)

type CopySourceContext struct {
	Schema    string                `json:"schema"`
	Request   CoreCopyRequest       `json:"request"`
	Resources CopyResourceInventory `json:"resources"`
	Platform  json.RawMessage       `json:"platform"`
	Quiesced  bool                  `json:"quiesced"`
}

func validateCopySourceResources(resources CopyResourceInventory) error {
	digest := resources.SHA256
	resources.SHA256 = ""
	raw, err := json.Marshal(resources)
	if err != nil || resources.Schema != "youeye.copy-resources.v1" || !validSHA256(resources.AppInventorySHA256) || fmt.Sprintf("%x", sha256.Sum256(raw)) != digest {
		return fmt.Errorf("copy source resource inventory digest differs")
	}
	return nil
}

func (m CoreManager) ReadCopySource(request CoreCopyRequest) (CopySourceContext, error) {
	var source CopySourceContext
	raw, err := ReadCoreState(filepath.Join(m.Root, "copy-source.json"), 2<<20)
	if err != nil {
		return source, err
	}
	if json.Unmarshal(raw, &source) != nil || source.Schema != "youeye.copy-source.v1" || source.Request != request || request.Validate() != nil || source.Resources.Schema != "youeye.copy-resources.v1" || !validSHA256(source.Resources.SHA256) || !json.Valid(source.Platform) {
		return source, fmt.Errorf("invalid native copy source inventory")
	}
	if err = validateCopySourceResources(source.Resources); err != nil {
		return source, err
	}
	seen := map[string]bool{}
	if len(source.Resources.Containers) < 5 || len(source.Resources.Containers) > 128 {
		return source, fmt.Errorf("unsupported copy workload inventory")
	}
	for _, c := range source.Resources.Containers {
		if !coreContainerName.MatchString(c.Name) || seen[c.Name] || c.UUID == "" {
			return source, fmt.Errorf("ambiguous copy workload identity")
		}
		seen[c.Name] = true
	}
	return source, nil
}
func (m CoreManager) SaveCopySource(request CoreCopyRequest, b CoreLifecycleBarrier, resources CopyResourceInventory, platform json.RawMessage) error {
	if request.Validate() != nil || validateCopySourceResources(resources) != nil || !json.Valid(platform) || len(platform) > 1<<20 {
		return fmt.Errorf("exact source copy inventory required")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return err
	}
	defer unlock()
	reservation, err := b.ReadCopy()
	if err != nil || reservation.Role != "source" || reservation.Request != request {
		return fmt.Errorf("source copy reservation required")
	}
	next := CopySourceContext{Schema: "youeye.copy-source.v1", Request: request, Resources: resources, Platform: platform}
	old, err := m.ReadCopySource(request)
	if err == nil {
		if !reflect.DeepEqual(old.Resources, resources) || string(old.Platform) != string(platform) {
			return fmt.Errorf("source copy inventory changed")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		// A source may be copied again only after the previous source hold settled.
		raw, e := ReadCoreState(filepath.Join(m.Root, "copy-source.json"), 2<<20)
		if e != nil {
			return e
		}
		var prior CopySourceContext
		if json.Unmarshal(raw, &prior) != nil || prior.Request.Validate() != nil || prior.Request.RequestID == request.RequestID {
			return err
		}
		completed, e := ReadCoreState(filepath.Join(b.Root, "copy-completions", prior.Request.RequestID+"-source.json"), 4096)
		var done CopyLifecycleReservation
		if e != nil || json.Unmarshal(completed, &done) != nil || done.Role != "source" || done.Request != prior.Request {
			return fmt.Errorf("earlier copy source requires completion")
		}
		if e = atomicWrite(filepath.Join(m.Root, "copy-source-history", prior.Request.RequestID, "source-context.json"), raw, 0600); e != nil {
			return e
		}
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(m.Root, "copy-source.json"), raw, 0600)
}

// SetCopySourceRuntime gracefully stops the exact frozen writer set before a
// cold copy, or restores its original states after provider power restoration.
// It neither starts the VM nor releases the retained source reservation.
func (m CoreManager) SetCopySourceRuntime(ctx context.Context, request CoreCopyRequest, b CoreLifecycleBarrier, p NativeCoreCheckpoint, restore bool, observeHardware func() (string, error)) error {
	return m.setCopyRuntime(ctx, request, b, p, "source", restore, observeHardware)
}

// QuiesceCopyDestination stops inherited writers before identity preparation.
// The destination cannot restore the source runtime through this entry point.
func (m CoreManager) QuiesceCopyDestination(ctx context.Context, request CoreCopyRequest, b CoreLifecycleBarrier, p NativeCoreCheckpoint, observeHardware func() (string, error)) error {
	return m.setCopyRuntime(ctx, request, b, p, "destination", false, observeHardware)
}

func (m CoreManager) setCopyRuntime(ctx context.Context, request CoreCopyRequest, b CoreLifecycleBarrier, p NativeCoreCheckpoint, role string, restore bool, observeHardware func() (string, error)) error {
	if request.Validate() != nil || observeHardware == nil {
		return fmt.Errorf("exact copy source runtime context required")
	}
	actual, err := observeHardware()
	expectedHardware := request.SourceHardware
	if role == "destination" {
		expectedHardware = request.DestinationHardware
	}
	if err != nil || actual != expectedHardware {
		return fmt.Errorf("copy runtime hardware changed")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return err
	}
	defer unlock()
	reservation, err := b.ReadCopy()
	if err != nil || reservation.Role != role || reservation.Request != request {
		return fmt.Errorf("exact copy runtime reservation required")
	}
	source, err := m.ReadCopySource(request)
	if err != nil {
		return err
	}
	if role == "destination" && !source.Quiesced {
		return fmt.Errorf("destination did not inherit a quiesced copy source")
	}
	bootIntent := map[string]string{}
	observe := func() (map[string]string, error) {
		raw, err := p.capture(ctx, "incus", "list", "--format=json")
		if err != nil {
			return nil, err
		}
		var actual []struct {
			Name   string            `json:"name"`
			Status string            `json:"status"`
			Config map[string]string `json:"config"`
		}
		if json.Unmarshal(raw, &actual) != nil || len(actual) != len(source.Resources.Containers) {
			return nil, fmt.Errorf("source copy workload set changed")
		}
		seen := map[string]string{}
		for _, c := range actual {
			var expected *CoreCheckpointContainer
			for i := range source.Resources.Containers {
				if source.Resources.Containers[i].Name == c.Name {
					expected = &source.Resources.Containers[i]
					break
				}
			}
			if expected == nil || seen[c.Name] != "" || c.Config["volatile.uuid"] != expected.UUID || (c.Status != "Running" && c.Status != "Stopped") {
				return nil, fmt.Errorf("source copy workload identity or state changed")
			}
			original := ""
			if expected.Autostart != nil {
				original = *expected.Autostart
			}
			if current := c.Config["boot.autostart"]; current != original && current != "false" {
				return nil, fmt.Errorf("copy workload boot intent changed outside preparation")
			}
			bootIntent[c.Name] = c.Config["boot.autostart"]
			seen[c.Name] = c.Status
		}
		return seen, nil
	}
	if _, err = observe(); err != nil {
		return err
	}
	names := append([]CoreCheckpointContainer{}, source.Resources.Containers...)
	order := func(name string) int {
		switch name {
		case "youeye-control":
			return 0
		case "youeye-ui":
			return 1
		case "youeye-postgres":
			return 8
		case "youeye-caddy", "youeye-pihole":
			return 9
		default:
			return 2
		}
	}
	sort.Slice(names, func(i, j int) bool {
		a, b := order(names[i].Name), order(names[j].Name)
		if a == b {
			return names[i].Name < names[j].Name
		}
		if restore {
			return a > b
		}
		return a < b
	})
	for _, c := range names {
		states, e := observe()
		if e != nil {
			return e
		}
		// A cold boot must not revive inherited services before their destination
		// authority is prepared. The source's original boot intent is durable and
		// is restored only by its own recovery path, never by destination replay.
		autostart := "false"
		if restore {
			autostart = ""
			if c.Autostart != nil {
				autostart = *c.Autostart
			}
		}
		bootArgs := []string{"config", "set", c.Name, "boot.autostart", autostart}
		if autostart == "" {
			bootArgs = []string{"config", "unset", c.Name, "boot.autostart"}
		}
		if bootIntent[c.Name] != autostart {
			if _, err = p.capture(ctx, "incus", bootArgs...); err != nil {
				return fmt.Errorf("copy boot intent requires reconciliation")
			}
			states, e = observe()
			if e != nil || bootIntent[c.Name] != autostart {
				return fmt.Errorf("copy workload boot intent did not converge")
			}
		}
		want := "Stopped"
		if restore && c.Running {
			want = "Running"
		}
		if states[c.Name] == want {
			continue
		}
		args := []string{"stop", c.Name, "--timeout", "120"}
		if want == "Running" {
			args = []string{"start", c.Name}
		}
		// No force flag. After an uncertain transport result, a retry observes the
		// retained exact UUID/state before deciding whether a command is needed.
		if _, err = p.capture(ctx, "incus", args...); err != nil {
			return fmt.Errorf("copy source runtime requires reconciliation")
		}
		states, e = observe()
		if e != nil || states[c.Name] != want {
			return fmt.Errorf("copy source runtime state did not converge")
		}
	}
	source.Quiesced = !restore
	raw, _ := json.Marshal(source)
	return atomicWrite(filepath.Join(m.Root, "copy-source.json"), raw, 0600)
}
