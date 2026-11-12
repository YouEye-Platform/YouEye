package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

// CheckIndependentCopyRuntime admits intermediate service preparation, never
// ordinary network access. Native commands serialize separately; the durable
// reservation continues to exclude ordinary lifecycle and background writers.
func (m CoreManager) CheckIndependentCopyRuntime(ctx context.Context, request CoreCopyRequest, b CoreLifecycleBarrier, p NativeCoreCheckpoint, observeHardware func() (string, error)) error {
	if request.Validate() != nil || observeHardware == nil {
		return fmt.Errorf("exact copy runtime request required")
	}
	hardware, err := observeHardware()
	if err != nil || hardware != request.DestinationHardware {
		return fmt.Errorf("copy runtime hardware differs")
	}
	copy, err := m.readCopy()
	if err != nil || copy.Request != request || copy.Phase != "verifying" {
		return fmt.Errorf("copy runtime admission required")
	}
	hold, err := b.ReadCopy()
	if err != nil || hold.Request != request || hold.Role != "destination" {
		return fmt.Errorf("destination copy reservation required")
	}
	for _, component := range []string{"runtime", "incus", "caddy"} {
		path := "copy-" + component + "-authority.json"
		var record struct {
			Request  CoreCopyRequest `json:"request"`
			Prepared bool            `json:"prepared"`
		}
		raw, e := ReadCoreState(filepath.Join(m.Root, path), 4<<20)
		if e != nil || json.Unmarshal(raw, &record) != nil || record.Request != request || !record.Prepared {
			return fmt.Errorf("copy %s authority is not prepared", component)
		}
	}
	source, err := m.ReadCopySource(request)
	if err != nil || !source.Quiesced {
		return fmt.Errorf("quiesced copy source required")
	}
	raw, err := p.capture(ctx, "incus", "list", "--format=json")
	if err != nil {
		return fmt.Errorf("copy runtime identity unavailable")
	}
	var rows []struct {
		Name   string            `json:"name"`
		Status string            `json:"status"`
		Config map[string]string `json:"config"`
	}
	if json.Unmarshal(raw, &rows) != nil || len(rows) != len(source.Resources.Containers) {
		return fmt.Errorf("copied workload set differs")
	}
	seen := map[string]bool{}
	for _, c := range rows {
		matched := false
		for _, want := range source.Resources.Containers {
			if c.Name == want.Name && c.Config["volatile.uuid"] == want.UUID {
				matched = true
				break
			}
		}
		if !matched || seen[c.Name] || c.Status != "Running" && c.Status != "Stopped" {
			return fmt.Errorf("copied workload identity or state differs")
		}
		seen[c.Name] = true
	}
	return nil
}

// Called only after platform preparation verifies. It restores the frozen
// boot intent without changing any current running state or releasing a hold.
func (m CoreManager) FinalizeIndependentCopyBoot(ctx context.Context, request CoreCopyRequest, b CoreLifecycleBarrier, p NativeCoreCheckpoint, observe func() (string, error)) error {
	if err := m.CheckIndependentCopyRuntime(ctx, request, b, p, observe); err != nil {
		return err
	}
	source, err := m.ReadCopySource(request)
	if err != nil {
		return err
	}
	for _, c := range source.Resources.Containers {
		want := ""
		if c.Autostart != nil {
			want = *c.Autostart
		}
		args := []string{"config", "set", c.Name, "boot.autostart", want}
		if want == "" {
			args = []string{"config", "unset", c.Name, "boot.autostart"}
		}
		if _, err = p.capture(ctx, "incus", args...); err != nil {
			return fmt.Errorf("copy boot intent requires reconciliation")
		}
		raw, e := p.capture(ctx, "incus", "config", "get", c.Name, "boot.autostart")
		if e != nil || strings.TrimSpace(string(raw)) != want {
			return fmt.Errorf("copy boot intent did not read back")
		}
	}
	return nil
}
