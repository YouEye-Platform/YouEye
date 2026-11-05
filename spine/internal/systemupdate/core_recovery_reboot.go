package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type coreRecoveredBoot struct {
	Schema       string `json:"schema"`
	Request      string `json:"request"`
	Manifest     string `json:"manifest"`
	Name         string `json:"name"`
	UUID         string `json:"uuid"`
	PreviousBoot string `json:"previous_boot"`
	CurrentBoot  string `json:"current_boot"`
	State        string `json:"state"`
}

// Explicit settled recovery can restore a frozen originally running service
// after a later host boot. Each new boot owns a separate durable start intent;
// a missing acknowledgement on that boot never admits another start.
func (p NativeCoreCheckpoint) resumeRecoveredPower(ctx context.Context, j CoreJournal, c CoreCheckpointContainer, actual coreCompletionContainer, observeOnly bool) (coreCompletionContainer, error) {
	if p.recoveryCurrentBoot == "" {
		return actual, nil
	}
	if len(p.recoveryPreviousBoot) != 36 || len(p.recoveryCurrentBoot) != 36 || p.recoveryPreviousBoot == p.recoveryCurrentBoot || j.Phase != "recovering" || !c.Running || !coreContainerName.MatchString(c.Name) {
		return actual, fmt.Errorf("distinct settled recovery boot required")
	}
	if err := p.verifyReservation(j); err != nil {
		return actual, err
	}
	machine, err := p.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return actual, fmt.Errorf("recovery reboot machine changed")
	}
	owned := func(a coreCompletionContainer) bool {
		return a.Config["volatile.uuid"] == c.UUID && a.Config["user.youeye.core-request"] == j.RequestID && a.Config["boot.autostart"] == "false" && (a.Status == "Stopped" || a.Status == "Running")
	}
	if !owned(actual) {
		return actual, fmt.Errorf("recovery reboot container ownership changed")
	}
	path := filepath.Join(filepath.Dir(p.recordPath(j.RequestID)), fmt.Sprintf("reboot-%x-%s.json", sha256.Sum256([]byte(p.recoveryCurrentBoot)), c.Name))
	unlock, err := lockCoreRunner(path + ".lock")
	if err != nil {
		return actual, err
	}
	defer unlock()
	expected := coreRecoveredBoot{Schema: "youeye.core-recovery-boot.v1", Request: j.RequestID, Manifest: j.ManifestSHA256, Name: c.Name, UUID: c.UUID, PreviousBoot: p.recoveryPreviousBoot, CurrentBoot: p.recoveryCurrentBoot, State: "requested"}
	raw, err := ReadCoreState(path, 4096)
	retained := false
	if err == nil {
		var receipt coreRecoveredBoot
		if json.Unmarshal(raw, &receipt) != nil {
			return actual, fmt.Errorf("invalid recovery reboot receipt")
		}
		expected.State = receipt.State
		if expected != receipt || (receipt.State != "requested" && receipt.State != "running") {
			return actual, fmt.Errorf("recovery reboot receipt changed")
		}
		retained = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return actual, err
	}
	save := func(state string) error {
		expected.State = state
		b, e := json.Marshal(expected)
		if e != nil {
			return e
		}
		return atomicWrite(path, b, 0600)
	}
	if actual.Status == "Stopped" {
		if retained || observeOnly {
			return actual, fmt.Errorf("recovery reboot start uncertain or unrequested; replay refused")
		}
		if err = p.requireProviderSettled(ctx); err != nil {
			return actual, err
		}
		if err = save("requested"); err != nil {
			return actual, err
		}
		_, _ = p.capture(ctx, "incus", "start", c.Name)
		actual, err = p.completionContainer(ctx, c)
		if err != nil {
			return actual, err
		}
		retained = true
	}
	if !owned(actual) || actual.Status != "Running" {
		return actual, fmt.Errorf("recovery reboot lacks owned running observation")
	}
	if retained {
		err = save("running")
	}
	return actual, err
}

// A previously started recovered CP/UI may boot without replaying migration
// only when its protected stopped-filesystem marker and schema completion still
// match the verified recovery record. Running payload checks follow startup.
func verifyStoppedRecoveredSchema(ctx context.Context, name string, marker coreComponentMarker, read coreContainerFileReader) error {
	if marker.Schema != "youeye.core-component.v1" || !coreRequestPattern.MatchString(marker.RequestID) || !validSHA256(marker.ManifestSHA256) || !validSHA256(marker.ArtifactSHA256) || (marker.Role != "cp" && marker.Role != "ui") {
		return fmt.Errorf("completed recovered component identity required")
	}
	if (marker.Role == "cp" && name != "youeye-control") || (marker.Role == "ui" && name != "youeye-ui") {
		return fmt.Errorf("recovered component role changed")
	}
	raw, err := read(ctx, name, "/etc/youeye/core-component.json", 4096, 0600)
	var actual coreComponentMarker
	if err != nil || json.Unmarshal(raw, &actual) != nil || actual != marker {
		return fmt.Errorf("stopped recovered component marker differs")
	}
	directory := "/var/lib/youeye/state/core-component-schemas"
	if marker.Role == "ui" {
		directory = "/var/lib/youeye/ui-data/.core-component-schemas"
	}
	key := sha256.Sum256([]byte(strings.Join([]string{marker.Role, marker.RequestID, marker.ManifestSHA256, marker.ArtifactSHA256}, "\x00")))
	raw, err = read(ctx, name, filepath.Join(directory, fmt.Sprintf("%x.json", key)), 4096, 0600)
	var receipt struct {
		coreComponentMarker
		State string `json:"state"`
	}
	if err != nil || json.Unmarshal(raw, &receipt) != nil || receipt.coreComponentMarker != marker || receipt.State != "completed" {
		return fmt.Errorf("stopped recovered schema is not completed")
	}
	return nil
}

// Incus's stopped-filesystem API does not mount external Data devices. Read a
// schema receipt from protected host Data only after checking its exact native
// binding; the component marker still comes from the stopped root filesystem.
func (p NativeCoreCheckpoint) recoveredSchemaReader(actual coreCompletionContainer) coreContainerFileReader {
	return func(ctx context.Context, name, path string, limit int64, mode uint32) ([]byte, error) {
		if !strings.HasPrefix(path, "/var/lib/youeye/") {
			return nativeReadCoreContainerFile(ctx, name, path, limit, mode)
		}
		destination := "/var/lib/youeye"
		relative := "state/core-component-schemas"
		if name == "youeye-ui" {
			destination += "/ui-data"
			relative = "ui-data/.core-component-schemas"
		} else if name != "youeye-control" {
			return nil, fmt.Errorf("exact recovered schema role required")
		}
		source := p.DataRoot
		if name == "youeye-ui" {
			source = filepath.Join(source, "ui-data")
		}
		matches := 0
		for _, d := range actual.Devices {
			if d["type"] != "disk" || d["path"] == "/" {
				continue
			}
			mount := d["path"]
			if mount == path || strings.HasPrefix(path, mount+"/") {
				if mount != destination || d["source"] != source || d["shift"] != "true" {
					return nil, fmt.Errorf("recovered schema Data binding changed")
				}
				matches++
			}
		}
		if matches != 1 || filepath.Dir(path) != "/var/lib/youeye/"+relative || mode != 0600 {
			return nil, fmt.Errorf("protected recovered schema Data binding required")
		}
		root, err := os.Open(p.DataRoot)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		dir, err := openCorePayloadDirectory(int(root.Fd()), relative)
		if err != nil {
			return nil, err
		}
		defer dir.Close()
		return readCoreContainerStateAtLimit(dir, filepath.Base(path), limit)
	}
}
