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
	"strings"
	"syscall"

	"github.com/youeye-platform/YouEye/releasecache"
)

// NativeCoreServices only changes the frozen CP/UI members. Unit start and
// schema/health acceptance are separate actions; staging never replays them.
type NativeCoreServices struct {
	Checkpoint NativeCoreCheckpoint
	Cache      CoreArtifactCache
	CPAppDir   string
	UIAppDir   string
	CPPort     int
}

type CoreServiceStage struct {
	Schema         string              `json:"schema"`
	RequestID      string              `json:"request_id"`
	ManifestSHA256 string              `json:"manifest_sha256"`
	Role           string              `json:"role"`
	ContainerUUID  string              `json:"container_uuid"`
	AppDir         string              `json:"app_dir"`
	ArtifactSHA256 string              `json:"artifact_sha256"`
	PreviousSHA256 string              `json:"previous_sha256"`
	StageName      string              `json:"stage_name"`
	Phase          string              `json:"phase"`
	MarkerState    string              `json:"marker_state,omitempty"`
	SelectionState string              `json:"selection_state,omitempty"`
	Component      coreComponentMarker `json:"component"`
	StartState     string              `json:"start_state,omitempty"`
}

func coreServiceMember(r releasecache.CoreRelease, role string) (releasecache.CoreMember, error) {
	for _, m := range r.Members {
		if m.Role == role {
			return m, nil
		}
	}
	return releasecache.CoreMember{}, fmt.Errorf("missing core service member")
}

func (s NativeCoreServices) stagePath(request, role string) string {
	return filepath.Join(s.Checkpoint.Root, "services", fmt.Sprintf("%x", sha256.Sum256([]byte(request))), role+".json")
}
func (s NativeCoreServices) saveStage(r CoreServiceStage) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return atomicWrite(s.stagePath(r.RequestID, r.Role), raw, 0600)
}

// Stage requires an already-running container with the exact retained service
// hold. The native runner owns safe start/boot and action settlement. An absent
// process never authorizes retrying this method's uncertain extraction.
func (s NativeCoreServices) Stage(ctx context.Context, request, role string) (CoreServiceStage, error) {
	var empty CoreServiceStage
	if role != "cp" && role != "ui" {
		return empty, fmt.Errorf("exact core service role required")
	}
	m := CoreManager{Root: s.Checkpoint.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.Phase != "applying" {
		return empty, fmt.Errorf("active core service action required")
	}
	started := false
	for _, step := range j.Steps {
		if step.Name == "apply-"+role && step.State == "started" {
			started = true
		}
	}
	if !started {
		return empty, fmt.Errorf("coordinator has not started core service action")
	}
	current, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(current, j.Previous) {
		return empty, fmt.Errorf("installed core commitment changed")
	}
	selection, _, err := m.Selection(j.ManifestSHA256, s.Cache.TrustKeyPath)
	if err != nil {
		return empty, err
	}
	record, err := s.Checkpoint.Read(j)
	if err != nil || record.Phase != "captured" {
		return empty, fmt.Errorf("complete paired checkpoint required")
	}
	if err = s.Checkpoint.verifyReservation(j); err != nil {
		return empty, err
	}
	machine, err := s.Checkpoint.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return empty, fmt.Errorf("core staging machine changed")
	}
	if err = s.Checkpoint.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return empty, err
	}
	if err = s.Checkpoint.verifyCapturedSnapshots(ctx, record); err != nil {
		return empty, err
	}
	container, appDir := "youeye-control", s.CPAppDir
	if role == "ui" {
		container, appDir = "youeye-ui", s.UIAppDir
	}
	if !filepath.IsAbs(appDir) || filepath.Clean(appDir) != appDir || appDir == "/" {
		return empty, fmt.Errorf("exact core application directory required")
	}
	uuid := ""
	for _, c := range record.Inventory.Containers {
		if c.Name == container {
			uuid = c.UUID
		}
	}
	if uuid == "" {
		return empty, fmt.Errorf("core container not in paired checkpoint")
	}
	member, err := coreServiceMember(j.Target, role)
	if err != nil {
		return empty, err
	}
	previous, err := coreServiceMember(j.Previous.Release, role)
	if err != nil {
		return empty, err
	}
	nextIndex, err := s.Cache.IndexSelected(m, j, role)
	if err != nil {
		return empty, err
	}
	oldIndex, err := m.LoadPayloadIndex(previous.Artifact.SHA256)
	if err != nil {
		return empty, err
	}
	// Index is retained before writing executable bytes; recovery never guesses
	// static identity from a version string or a freshly generated local index.
	if err = m.SavePayloadIndex(nextIndex); err != nil {
		return empty, err
	}
	stage := CoreServiceStage{Schema: "youeye.core-service-stage.v1", RequestID: request, ManifestSHA256: j.ManifestSHA256, Role: role, ContainerUUID: uuid, AppDir: appDir, ArtifactSHA256: member.Artifact.SHA256, PreviousSHA256: previous.Artifact.SHA256, StageName: fmt.Sprintf(".youeye-core-%x", sha256.Sum256([]byte(request+"\x00"+role))), Phase: "prepared"}
	if err = os.MkdirAll(filepath.Dir(s.stagePath(request, role)), 0700); err != nil {
		return empty, err
	}
	lock, err := os.OpenFile(s.stagePath(request, role)+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return empty, err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return empty, fmt.Errorf("core service staging already active")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	raw, err := ReadCoreState(s.stagePath(request, role), 64<<10)
	if err == nil {
		var old CoreServiceStage
		if json.Unmarshal(raw, &old) != nil {
			return empty, fmt.Errorf("invalid core stage receipt")
		}
		expected := stage
		expected.Phase = old.Phase
		expected.MarkerState = old.MarkerState
		expected.SelectionState = old.SelectionState
		expected.Component = old.Component
		expected.StartState = old.StartState
		if old != expected {
			return empty, fmt.Errorf("core stage identity changed")
		}
		stage = old
	} else if !errors.Is(err, os.ErrNotExist) {
		return empty, err
	} else if err = s.saveStage(stage); err != nil {
		return empty, err
	}
	if stage.StartState != "" {
		return stage, fmt.Errorf("service start already requested; observe its durable schema receipt")
	}
	pid, err := nativeCoreContainerPID(ctx, container)
	if err != nil {
		return stage, err
	}
	identity, err := nativeProcessIdentity(pid)
	if err != nil {
		return stage, err
	}
	root, err := os.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		return stage, fmt.Errorf("held core filesystem unavailable")
	}
	defer root.Close()
	if err = verifyCoreServiceHold(root, j); err != nil {
		return stage, err
	}
	// The hold protects reboot/start; explicit stop also settles any services
	// that were already running before the hold was restored.
	units := []string{"youeye-control", "youeye-id"}
	if role == "ui" {
		units = []string{"youeye-ui"}
	}
	args := append([]string{"exec", container, "--", "systemctl", "stop"}, units...)
	if _, err = s.Checkpoint.capture(ctx, "incus", args...); err != nil {
		return stage, err
	}
	parent, _, err := corePayloadParent(root, strings.TrimPrefix(appDir, "/"))
	if err != nil {
		return stage, err
	}
	defer parent.Close()
	var archive *os.File
	if member.Artifact.SHA256 != previous.Artifact.SHA256 {
		archive, err = s.Cache.open(member.Artifact)
		if err != nil {
			return stage, err
		}
		defer archive.Close()
	}
	if err = stageCoreServiceTree(ctx, parent, archive, &stage, oldIndex, nextIndex, s.saveStage); err != nil {
		return stage, err
	}
	if err = installCoreComponentMarker(root, j, &stage, s.saveStage); err != nil {
		return stage, err
	}
	component, e := readNativeCoreMarker(pid)
	if e != nil {
		return stage, e
	}
	if stage.Component.Schema != "" && stage.Component != component {
		return stage, fmt.Errorf("retained component identity changed")
	}
	stage.Component = component
	if e = s.saveStage(stage); e != nil {
		return stage, e
	}
	if role == "cp" {
		baselineRaw, e := ReadCoreState(filepath.Join(m.Root, "targets", j.Previous.ManifestSHA256+".json"), 1<<20)
		if e != nil {
			return stage, e
		}
		baselineSig, e := ReadCoreState(filepath.Join(m.Root, "targets", j.Previous.ManifestSHA256+".json.sig"), 64)
		if e != nil {
			return stage, e
		}
		if e = installCoreServiceSelection(root, &stage, CoreHostSelection{Raw: baselineRaw, Signature: baselineSig}, selection, s.saveStage); e != nil {
			return stage, e
		}
	}
	after, err := nativeCoreContainerPID(ctx, container)
	if err != nil || after != pid {
		return stage, fmt.Errorf("core staging container restarted")
	}
	actual, err := nativeProcessIdentity(pid)
	if err != nil || actual != identity {
		return stage, fmt.Errorf("core staging process identity changed")
	}
	return stage, nil
}

func verifyCoreServiceHold(root *os.File, j CoreJournal) error {
	etc, err := openCorePayloadDirectory(int(root.Fd()), "etc/youeye")
	if err != nil {
		return err
	}
	defer etc.Close()
	raw, err := readCoreContainerStateAt(etc, "core-update-hold.json")
	if err != nil {
		return fmt.Errorf("exact protected core service hold required")
	}

	var held struct {
		Request string `json:"request_id"`
		Digest  string `json:"manifest_sha256"`
	}
	if json.Unmarshal(raw, &held) != nil || held.Request != j.RequestID || held.Digest != j.ManifestSHA256 {
		return fmt.Errorf("foreign core service hold")
	}
	return nil
}
