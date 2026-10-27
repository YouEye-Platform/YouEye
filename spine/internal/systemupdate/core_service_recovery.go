package systemupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
)

// RecoverServices accepts only the retained previous payloads and their already
// completed schema receipts after paired restoration. It never runs a migration
// again or substitutes fresh downloads for an unavailable recovery checkpoint.
func (s NativeCoreServices) RecoverServices(ctx context.Context, request string, observeOnly bool) (string, error) {
	m := CoreManager{Root: s.Checkpoint.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.Phase != "recovering" {
		return "", fmt.Errorf("active paired core recovery required")
	}
	active := false
	for _, step := range j.RecoverySteps {
		if step.Name == "recovery-health" && step.State == "started" {
			active = true
		}
	}
	if !active {
		return "", fmt.Errorf("recovery service startup is not authorized")
	}
	receipt, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(receipt, j.Previous) {
		return "", fmt.Errorf("previous installed receipt changed")
	}
	selection, _, err := m.Selection(j.Previous.ManifestSHA256, s.Cache.TrustKeyPath)
	if err != nil {
		return "", err
	}
	if err = s.Checkpoint.verifyReservation(j); err != nil {
		return "", err
	}
	machine, err := s.Checkpoint.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return "", fmt.Errorf("recovery machine changed")
	}
	record, err := s.Checkpoint.Read(j)
	if err != nil || (record.Phase != "paired-restored" && record.Phase != "aborted-unapplied") {
		return "", fmt.Errorf("paired recovery has not completed")
	}
	if err = s.Checkpoint.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return "", err
	}
	for _, role := range []string{"cp", "ui"} {
		if err = s.recoverService(ctx, j, record, selection, role, observeOnly); err != nil {
			return "", err
		}
	}
	return "previous exact CP/UI payloads, completed schema identities and running units verified", nil
}

func (s NativeCoreServices) recoverService(ctx context.Context, j CoreJournal, record NativeCoreCheckpointRecord, selection CoreHostSelection, role string, observeOnly bool) error {
	name, appDir := "youeye-control", s.CPAppDir
	if role == "ui" {
		name, appDir = "youeye-ui", s.UIAppDir
	}
	member, err := coreServiceMember(j.Previous.Release, role)
	if err != nil {
		return err
	}
	if err = CheckCoreMemberAuthority(member, j.Previous.Release.Channel, s.Cache.TrustKeyPath); err != nil {
		return err
	}
	var c CoreCheckpointContainer
	for _, entry := range record.Inventory.Containers {
		if entry.Name == name {
			c = entry
		}
	}
	if c.UUID == "" || !c.Running {
		return fmt.Errorf("previous core service power identity unavailable")
	}
	path := s.stagePath(j.RequestID, role) + ".recovery"
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("recovered service is still owned")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	stage := CoreServiceStage{Schema: "youeye.core-service-recovery.v1", RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Role: role, ContainerUUID: c.UUID, AppDir: appDir, ArtifactSHA256: member.Artifact.SHA256, PreviousSHA256: member.Artifact.SHA256, Phase: "recovered"}
	save := func(value CoreServiceStage) error {
		raw, err := json.Marshal(value)
		if err != nil {
			return err
		}
		return atomicWrite(path, raw, 0600)
	}
	raw, err := ReadCoreState(path, 64<<10)
	if err == nil {
		var retained CoreServiceStage
		if json.Unmarshal(raw, &retained) != nil {
			return fmt.Errorf("invalid recovered service record")
		}
		expected := stage
		expected.StartState = retained.StartState
		expected.Component = retained.Component
		if expected != retained || (retained.StartState != "" && retained.StartState != "requested" && retained.StartState != "started") {
			return fmt.Errorf("recovered service identity changed")
		}
		stage = retained
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if observeOnly {
		return fmt.Errorf("recovery startup has no retained intent")
	} else if err = save(stage); err != nil {
		return err
	}
	if stage.StartState == "" {
		if observeOnly {
			return fmt.Errorf("recovered service startup has not been requested")
		}
		if err = s.startCheckpointContainer(ctx, j, role, nativeReadCoreContainerFile, true); err != nil {
			return err
		}
	}
	actual, err := s.Checkpoint.completionContainer(ctx, c)
	if err == nil && stage.StartState == "started" && s.Checkpoint.recoveryCurrentBoot != "" {
		if actual.Status == "Stopped" {
			if err = verifyStoppedRecoveredSchema(ctx, name, stage.Component, s.Checkpoint.recoveredSchemaReader(actual)); err != nil {
				return err
			}
		}
		actual, err = s.Checkpoint.resumeRecoveredPower(ctx, j, c, actual, observeOnly)
	}
	if err != nil || actual.Status != "Running" || actual.Config["user.youeye.core-request"] != j.RequestID || actual.Config["boot.autostart"] != "false" {
		return fmt.Errorf("recovered service lacks its running owned container")
	}
	pid, err := nativeCoreContainerPID(ctx, name)
	if err != nil {
		return err
	}
	identity, err := nativeProcessIdentity(pid)
	if err != nil {
		return err
	}
	marker, err := readNativeCoreMarker(pid)
	if err != nil || marker.Role != role || marker.ArtifactSHA256 != member.Artifact.SHA256 {
		return fmt.Errorf("restored component marker differs from previous payload")
	}
	if stage.Component.Schema != "" && stage.Component != marker {
		return fmt.Errorf("recovered schema identity changed")
	}
	if err = verifyNativeCoreSchemaReceipt(pid, marker); err != nil {
		return err
	}
	index, err := (CoreManager{Root: s.Checkpoint.Root}).LoadPayloadIndex(member.Artifact.SHA256)
	if err != nil {
		return err
	}
	if err = VerifyCoreContainerPayload(ctx, name, appDir, index); err != nil {
		return err
	}
	root, err := os.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		return err
	}
	defer root.Close()
	if role == "cp" {
		if err = verifyRecoveredCoreSelection(root, selection); err != nil {
			return err
		}
	}
	stage.Component = marker
	start := stage.StartState == ""
	if start {
		if observeOnly {
			return fmt.Errorf("recovery startup lacks a durable intent")
		}
		if err = releaseCoreServiceHold(root, j, &stage, save); err != nil {
			return err
		}
	}
	if err = verifyCoreServiceHoldReleased(root); err != nil {
		return err
	}
	if err = s.startHeldCoreUnits(ctx, name, role, start); err != nil {
		return err
	}
	after, err := nativeCoreContainerPID(ctx, name)
	if err != nil || after != pid {
		return fmt.Errorf("recovered container restarted during verification")
	}
	finalIdentity, err := nativeProcessIdentity(pid)
	if err != nil || finalIdentity != identity {
		return fmt.Errorf("recovered container identity changed")
	}
	stage.StartState = "started"
	return save(stage)
}

func verifyRecoveredCoreSelection(root *os.File, selection CoreHostSelection) error {
	dir, err := openCorePayloadDirectory(int(root.Fd()), "var/lib/youeye-state/core-selection")
	if err != nil {
		return err
	}
	defer dir.Close()
	for _, part := range []struct {
		name  string
		raw   []byte
		limit int64
	}{{"core-release.json", selection.Raw, 1 << 20}, {"core-release.json.sig", selection.Signature, 64}} {
		actual, err := readCoreContainerStateAtLimit(dir, part.name, part.limit)
		if err != nil || !bytes.Equal(actual, part.raw) {
			return fmt.Errorf("restored CP selection is not the exact previous signed pair")
		}
	}
	return nil
}

// Once hold removal has a durable intent, observation can accept running units
// but never issue a second start after a lost acknowledgement.
func (s NativeCoreServices) startHeldCoreUnits(ctx context.Context, name, role string, start bool) error {
	units := []string{"youeye-control", "youeye-id"}
	if role == "ui" {
		units = []string{"youeye-ui"}
	}
	if (role != "cp" && role != "ui") || (role == "cp" && name != "youeye-control") || (role == "ui" && name != "youeye-ui") {
		return fmt.Errorf("exact recovered service role required")
	}
	if start {
		if _, err := s.Checkpoint.capture(ctx, "incus", "exec", name, "--", "systemctl", "daemon-reload"); err != nil {
			return fmt.Errorf("core unit load acknowledgement unavailable")
		}
		args := append([]string{"exec", name, "--", "systemctl", "start"}, units...)
		_, _ = s.Checkpoint.capture(ctx, "incus", args...) // accept only native active readback
	}
	for _, unit := range units {
		raw, err := s.Checkpoint.capture(ctx, "incus", "exec", name, "--", "systemctl", "is-active", unit)
		if err != nil || strings.TrimSpace(string(raw)) != "active" {
			return fmt.Errorf("core service startup has no positive active receipt")
		}
	}
	return nil
}
