package systemupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"syscall"

	"golang.org/x/sys/unix"
)

// Start records permission to remove this operation's service condition and
// starts (never restarts) its exact units. A successful start is not accepted
// schema/health. Observe Schema before deciding that the component action passed.
func (s NativeCoreServices) Start(ctx context.Context, request, role string) (CoreServiceStage, error) {
	var stage CoreServiceStage
	if role != "cp" && role != "ui" {
		return stage, fmt.Errorf("exact core start role required")
	}
	m := CoreManager{Root: s.Checkpoint.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.Phase != "applying" {
		return stage, fmt.Errorf("active core component action required")
	}
	active := false
	for _, step := range j.Steps {
		if step.Name == "apply-"+role && step.State == "started" {
			active = true
		}
	}
	if !active {
		return stage, fmt.Errorf("core service start is not authorized")
	}
	current, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(current, j.Previous) {
		return stage, fmt.Errorf("core service commitment changed")
	}
	if _, _, err = m.Selection(j.ManifestSHA256, s.Cache.TrustKeyPath); err != nil {
		return stage, err
	}
	machine, err := s.Checkpoint.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return stage, fmt.Errorf("core start machine changed")
	}
	if err = s.Checkpoint.verifyReservation(j); err != nil {
		return stage, err
	}
	record, err := s.Checkpoint.Read(j)
	if err != nil || record.Phase != "captured" {
		return stage, fmt.Errorf("complete paired checkpoint required")
	}
	if err = s.Checkpoint.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return stage, err
	}
	// Share the stage lock: neither a second caller nor a stale retry may alter
	// static files while the same component is releasing its startup hold.
	lock, err := os.OpenFile(s.stagePath(request, role)+".lock", os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return stage, err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return stage, fmt.Errorf("core service operation still active")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	raw, err := ReadCoreState(s.stagePath(request, role), 64<<10)
	if err != nil {
		return stage, err
	}
	if json.Unmarshal(raw, &stage) != nil || stage.Schema != "youeye.core-service-stage.v1" || stage.RequestID != request || stage.Role != role || stage.ManifestSHA256 != j.ManifestSHA256 || (stage.Phase != "reused" && stage.Phase != "swapped") || (stage.Phase == "swapped" && stage.MarkerState != "installed") || (role == "cp" && stage.SelectionState != "installed") {
		return stage, fmt.Errorf("complete core service stage required")
	}
	if stage.StartState != "" && stage.StartState != "requested" && stage.StartState != "started" {
		return stage, fmt.Errorf("unknown service start state")
	}
	container := "youeye-control"
	if role == "ui" {
		container = "youeye-ui"
	}
	member, err := coreServiceMember(j.Target, role)
	if err != nil || member.Artifact.SHA256 != stage.ArtifactSHA256 {
		return stage, fmt.Errorf("service start target differs")
	}
	if err = CheckCoreMemberAuthority(member, j.Target.Channel, s.Cache.TrustKeyPath); err != nil {
		return stage, err
	}
	index, err := m.LoadPayloadIndex(member.Artifact.SHA256)
	if err != nil {
		return stage, err
	}
	if err = VerifyCoreContainerPayload(ctx, container, stage.AppDir, index); err != nil {
		return stage, err
	}
	pid, err := nativeCoreContainerPID(ctx, container)
	if err != nil {
		return stage, err
	}
	marker, err := readNativeCoreMarker(pid)
	if err != nil || marker != stage.Component {
		return stage, fmt.Errorf("service marker differs from stage receipt")
	}
	root, err := os.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		return stage, fmt.Errorf("core start filesystem unavailable")
	}
	defer root.Close()
	start := stage.StartState == ""
	if start {
		if err = releaseCoreServiceHold(root, j, &stage, s.saveStage); err != nil {
			return stage, err
		}
	}
	if err = verifyCoreServiceHoldReleased(root); err != nil {
		return stage, err
	}
	if err = s.startHeldCoreUnits(ctx, container, role, start); err != nil {
		return stage, err
	}
	stage.StartState = "started"
	return stage, s.saveStage(stage)
}

func verifyCoreServiceHoldReleased(root *os.File) error {
	dir, err := openCorePayloadDirectory(int(root.Fd()), "etc/youeye")
	if err != nil {
		return err
	}
	defer dir.Close()
	_, err = readCoreContainerStateAt(dir, "core-update-hold.json")
	if !errors.Is(err, unix.ENOENT) {
		return fmt.Errorf("core service startup hold has not been released")
	}
	return nil
}

func releaseCoreServiceHold(root *os.File, j CoreJournal, stage *CoreServiceStage, save func(CoreServiceStage) error) error {
	units := []string{"youeye-control", "youeye-id"}
	if stage.Role == "ui" {
		units = []string{"youeye-ui"}
	} else if stage.Role != "cp" {
		return fmt.Errorf("exact core service hold role required")
	}
	expected := []byte("[Unit]\nConditionPathExists=!/etc/youeye/core-update-hold.json\n")
	for _, unit := range units {
		dir, err := openCorePayloadDirectory(int(root.Fd()), filepath.Join("etc/systemd/system", unit+".service.d"))
		if err != nil {
			return err
		}
		fd, err := unix.Openat(int(dir.Fd()), "90-youeye-core-update.conf", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		var owner unix.Stat_t
		owned := unix.Fstat(int(dir.Fd()), &owner) == nil && owner.Mode&0022 == 0
		dir.Close()
		if err != nil {
			return fmt.Errorf("retained service condition required")
		}
		file := os.NewFile(uintptr(fd), "core-service-condition")
		var stat unix.Stat_t
		valid := owned && unix.Fstat(fd, &stat) == nil && stat.Mode&unix.S_IFMT == unix.S_IFREG && stat.Mode&07777 == 0644 && stat.Uid == owner.Uid && stat.Size == int64(len(expected))
		raw, err := io.ReadAll(io.LimitReader(file, int64(len(expected))+1))
		file.Close()
		if !valid || err != nil || !bytes.Equal(raw, expected) {
			return fmt.Errorf("core service condition changed")
		}
	}
	dir, err := openCorePayloadDirectory(int(root.Fd()), "etc/youeye")
	if err != nil {
		return err
	}
	defer dir.Close()
	raw, err := readCoreContainerStateAt(dir, "core-update-hold.json")
	if errors.Is(err, unix.ENOENT) {
		if stage.StartState == "requested" || stage.StartState == "started" {
			return nil
		}
		return fmt.Errorf("core service hold disappeared without start intent")
	}
	if err != nil {
		return err
	}
	var hold struct {
		Request string `json:"request_id"`
		Digest  string `json:"manifest_sha256"`
	}
	if json.Unmarshal(raw, &hold) != nil || hold.Request != j.RequestID || hold.Digest != j.ManifestSHA256 {
		return fmt.Errorf("foreign core service hold")
	}
	if stage.StartState == "started" {
		return fmt.Errorf("completed service acquired a new hold")
	}
	stage.StartState = "requested"
	if err = save(*stage); err != nil {
		return err
	}
	if err = unix.Unlinkat(int(dir.Fd()), "core-update-hold.json", 0); err != nil {
		return err
	}
	return dir.Sync()
}
