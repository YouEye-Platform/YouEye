package systemupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

type coreServiceBoot struct {
	Schema         string `json:"schema"`
	RequestID      string `json:"request_id"`
	ManifestSHA256 string `json:"manifest_sha256"`
	Role           string `json:"role"`
	UUID           string `json:"uuid"`
	State          string `json:"state"`
}

type coreContainerFileReader func(context.Context, string, string, int64, uint32) ([]byte, error)

// StartHeldContainer verifies the persisted condition while the container is
// still stopped. A lost start acknowledgement is reconciled from exact running
// identity plus the hold; a stopped target after intent never triggers replay.
func (s NativeCoreServices) StartHeldContainer(ctx context.Context, request, role string) error {
	if role != "cp" && role != "ui" {
		return fmt.Errorf("exact core boot role required")
	}
	m := CoreManager{Root: s.Checkpoint.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.Phase != "applying" {
		return fmt.Errorf("active native apply required")
	}
	active := false
	for _, step := range j.Steps {
		if step.Name == "apply-"+role && step.State == "started" {
			active = true
		}
	}
	if !active {
		return fmt.Errorf("native component boot is not authorized")
	}
	if _, _, err = m.Selection(j.ManifestSHA256, s.Cache.TrustKeyPath); err != nil {
		return err
	}
	member, err := coreServiceMember(j.Target, role)
	if err != nil {
		return err
	}
	if err = CheckCoreMemberAuthority(member, j.Target.Channel, s.Cache.TrustKeyPath); err != nil {
		return err
	}
	return s.startHeldContainer(ctx, j, role, nativeReadCoreContainerFile)
}

func (s NativeCoreServices) startHeldContainer(ctx context.Context, j CoreJournal, role string, read coreContainerFileReader) error {
	return s.startCheckpointContainer(ctx, j, role, read, false)
}

func (s NativeCoreServices) startCheckpointContainer(ctx context.Context, j CoreJournal, role string, read coreContainerFileReader, recovered bool) error {
	if err := s.Checkpoint.verifyReservation(j); err != nil {
		return err
	}
	machine, err := s.Checkpoint.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return fmt.Errorf("core boot machine changed")
	}
	record, err := s.Checkpoint.Read(j)
	phaseOK := record.Phase == "captured"
	if recovered {
		phaseOK = record.Phase == "paired-restored" || record.Phase == "aborted-unapplied"
	}
	if err != nil || !phaseOK {
		return fmt.Errorf("complete paired checkpoint required before component boot")
	}
	if err = s.Checkpoint.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return err
	}
	if record.Phase != "aborted-unapplied" {
		if err = s.Checkpoint.verifyCapturedSnapshots(ctx, record); err != nil {
			return err
		}
	}
	name := "youeye-control"
	units := []string{"youeye-control", "youeye-id"}
	if role == "ui" {
		name = "youeye-ui"
		units = []string{"youeye-ui"}
	} else if role != "cp" {
		return fmt.Errorf("exact native core boot role required")
	}
	var container CoreCheckpointContainer
	for _, c := range record.Inventory.Containers {
		if c.Name == name {
			container = c
		}
	}
	if container.UUID == "" {
		return fmt.Errorf("core boot container absent from checkpoint")
	}
	path := s.stagePath(j.RequestID, role) + ".boot"
	if recovered {
		path += ".recovery"
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("core container boot still owned")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	expected := coreServiceBoot{Schema: "youeye.core-service-boot.v1", RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Role: role, UUID: container.UUID, State: "requested"}
	retained := false
	raw, err := ReadCoreState(path, 16384)
	if err == nil {
		var receipt coreServiceBoot
		if json.Unmarshal(raw, &receipt) != nil {
			return fmt.Errorf("invalid core boot receipt")
		}
		test := expected
		test.State = receipt.State
		if test != receipt || (receipt.State != "requested" && receipt.State != "running") {
			return fmt.Errorf("core boot identity differs")
		}
		retained = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Identity and power hold must both be present, not just a matching name.
	raw, err = s.Checkpoint.capture(ctx, "incus", "query", "/1.0/instances/"+name)
	if err != nil {
		return err
	}
	var actual struct {
		Status string            `json:"status"`
		Config map[string]string `json:"config"`
	}
	if json.Unmarshal(raw, &actual) != nil || actual.Config["volatile.uuid"] != container.UUID || actual.Config["user.youeye.core-request"] != j.RequestID || actual.Config["boot.autostart"] != "false" || (actual.Status != "Stopped" && actual.Status != "Running") {
		return fmt.Errorf("exact core boot ownership/hold required")
	}
	hold, err := read(ctx, name, "/etc/youeye/core-update-hold.json", 4096, 0600)
	if err != nil {
		return err
	}
	var marker struct {
		Request string `json:"request_id"`
		Digest  string `json:"manifest_sha256"`
	}
	if json.Unmarshal(hold, &marker) != nil || marker.Request != j.RequestID || marker.Digest != j.ManifestSHA256 {
		return fmt.Errorf("foreign stopped-container service hold")
	}
	condition := []byte("[Unit]\nConditionPathExists=!/etc/youeye/core-update-hold.json\n")
	for _, unit := range units {
		raw, err := read(ctx, name, filepath.Join("/etc/systemd/system", unit+".service.d/90-youeye-core-update.conf"), 4096, 0644)
		if err != nil || !bytes.Equal(raw, condition) {
			return fmt.Errorf("stopped-container service condition differs")
		}
	}
	save := func(state string) error {
		expected.State = state
		raw, err := json.Marshal(expected)
		if err != nil {
			return err
		}
		return atomicWrite(path, raw, 0600)
	}
	if actual.Status == "Stopped" {
		if retained {
			return fmt.Errorf("recorded container start remains uncertain; reconcile native operations before recovery")
		}
		if err = save("requested"); err != nil {
			return err
		}
		if _, err = s.Checkpoint.capture(ctx, "incus", "start", name); err != nil {
			return fmt.Errorf("core container start acknowledgement unavailable")
		}
	}
	running, err := s.Checkpoint.containerRunning(ctx, container)
	if err != nil || !running {
		return fmt.Errorf("core container boot has no running receipt")
	}
	// Read the same held files again after boot; nothing may remove the hold
	// before Stage verifies/installs the selected member and its durable marker.
	after, err := read(ctx, name, "/etc/youeye/core-update-hold.json", 4096, 0600)
	if err != nil || !bytes.Equal(after, hold) {
		return fmt.Errorf("core service hold changed during boot")
	}
	return save("running")
}

func nativeReadCoreContainerFile(ctx context.Context, container, path string, limit int64, mode uint32) ([]byte, error) {
	if !coreContainerName.MatchString(container) || !filepath.IsAbs(path) || filepath.Clean(path) != path || limit < 1 || limit > 1<<20 {
		return nil, fmt.Errorf("invalid exact container file request")
	}
	client, transport := nativeCoreIncusClient()
	defer transport.CloseIdleConnections()
	endpoint := "http://incus/1.0/instances/" + container + "/files?" + url.Values{"path": {path}, "project": {"default"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("protected container state unavailable")
	}
	defer resp.Body.Close()
	actualMode, modeErr := strconv.ParseUint(resp.Header.Get("X-Incus-mode"), 8, 32)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("X-Incus-type") != "file" || resp.Header.Get("X-Incus-uid") != "0" || modeErr != nil || uint32(actualMode) != mode {
		return nil, fmt.Errorf("container state is not the exact protected plain file")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || len(raw) == 0 || int64(len(raw)) > limit {
		return nil, fmt.Errorf("container state exceeds its bound")
	}
	return raw, nil
}
