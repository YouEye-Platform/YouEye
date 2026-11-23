package systemupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"reflect"

	"github.com/youeye-platform/YouEye/releasecache"
	"golang.org/x/sys/unix"
)

// The Control Panel's recorded selection is the file core-release.json in
// coreSelectionDirectory of the youeye-control container. After a finished
// request it holds the installed release document: apply-cp writes it for an
// update, a promotion (a metadata-only request) writes it in its health step,
// and a recovery puts the previous document back.
const coreSelectionDirectory = "var/lib/youeye-state/core-selection"

// coreSelectionTemp is the name a request writes a selection under before the
// rename. purpose separates the request's writers.
func coreSelectionTemp(request, purpose string) string {
	return fmt.Sprintf(".youeye-core-%x%s.core-release.json", sha256.Sum256([]byte(request+"\x00cp")), purpose)
}

// recordedSelectionStandsFor decides whether the bytes recorded in the Control
// Panel stand for the release expected. The exact document does. So does
// another document of the same build: a Spine before 0.6.11 committed a
// promotion without rewriting the file, so a box that took a build on one
// channel and its promotion on the next still records the earlier document.
// Such a document is accepted only when this box retains the same bytes under
// their own digest (Spine accepted them as a release once) and they name the
// same payloads and compatibility as the expected release (sameCorePayloads).
// Anything else is foreign, as before.
func (m CoreManager) recordedSelectionStandsFor(recorded []byte, expected CoreHostSelection) bool {
	if bytes.Equal(recorded, expected.Raw) {
		return true
	}
	release, digest, err := releasecache.ParseCoreRelease(recorded)
	if err != nil {
		return false
	}
	retained, _, err := m.Selection(digest)
	if err != nil || !bytes.Equal(retained.Raw, recorded) {
		return false
	}
	wanted, _, err := releasecache.ParseCoreRelease(expected.Raw)
	return err == nil && sameCorePayloads(release, wanted)
}

// CP needs the complete current selection even when its own payload is reused.
// Both files remain behind the service hold until this pair is verified. A
// crash between their atomic renames leaves a recorded, reconcilable partial
// pair; it cannot expose an unverified or silently re-resolved selection.
// What is replaced must stand for the previous release (recordedSelectionStandsFor).
func installCoreServiceSelection(m CoreManager, root *os.File, r *CoreServiceStage, previous, next CoreHostSelection, save func(CoreServiceStage) error) error {
	if r.Role != "cp" || (r.Phase != "swapped" && r.Phase != "reused") || fmt.Sprintf("%x", sha256.Sum256(next.Raw)) != r.ManifestSHA256 {
		return fmt.Errorf("verified CP core selection required")
	}
	if r.SelectionState != "" && r.SelectionState != "requested" && r.SelectionState != "installed" {
		return fmt.Errorf("unknown CP selection state")
	}
	dir, err := openCorePayloadDirectory(int(root.Fd()), coreSelectionDirectory)
	if err != nil {
		return err
	}
	defer dir.Close()
	type part struct {
		name        string
		old, new    []byte
		limit       int64
		optionalOld bool
	}
	parts := []part{{"core-release.json", previous.Raw, next.Raw, 1 << 20, false}}
	for _, p := range parts {
		actual, err := readCoreContainerStateAtLimit(dir, p.name, p.limit)
		if err != nil {
			if errors.Is(err, unix.ENOENT) && p.optionalOld && r.SelectionState != "installed" {
				continue
			}
			return err
		}
		isNew := bytes.Equal(actual, p.new)
		if r.SelectionState == "installed" {
			if !isNew {
				return fmt.Errorf("installed CP selection changed")
			}
			continue
		}
		if !m.recordedSelectionStandsFor(actual, CoreHostSelection{Raw: p.old}) && !(r.SelectionState == "requested" && isNew) {
			return fmt.Errorf("CP selection differs from retained transition")
		}
	}
	if r.SelectionState == "installed" {
		return nil
	}
	r.SelectionState = "requested"
	if err = save(*r); err != nil {
		return err
	}
	for _, p := range parts {
		if err = writeCoreContainerFileAt(dir, p.name, r.StageName+"."+p.name, p.new, p.limit); err != nil {
			return err
		}
	}
	r.SelectionState = "installed"
	return save(*r)
}

// recordPromotedCoreSelection is the one effect of a metadata-only request: the
// Control Panel gets the promoted document, so that what it records is the
// installed release and what it downloads is named as the box's channel names
// it. It replaces only a recorded document of the same build (the previous
// release's, or an earlier one an older Spine left there), and writing the same
// bytes again changes nothing.
func recordPromotedCoreSelection(m CoreManager, root *os.File, j CoreJournal) error {
	if !j.MetadataOnly {
		return fmt.Errorf("metadata-only core request required")
	}
	next, _, err := m.Selection(j.ManifestSHA256)
	if err != nil {
		return err
	}
	dir, err := openCorePayloadDirectory(int(root.Fd()), coreSelectionDirectory)
	if err != nil {
		return err
	}
	defer dir.Close()
	actual, err := readCoreContainerStateAtLimit(dir, "core-release.json", 1<<20)
	if err != nil {
		return err
	}
	// The target names the previous release's payloads (validateCoreSteps), so a
	// document that stands for the target stands for the previous release too.
	if !m.recordedSelectionStandsFor(actual, next) {
		return fmt.Errorf("CP selection differs from retained transition")
	}
	return writeCoreContainerFileAt(dir, "core-release.json", coreSelectionTemp(j.RequestID, ""), next.Raw, 1<<20)
}

// RecordPromotedSelection runs in the health action of a metadata-only request,
// before the health checks: the Control Panel then answers them with the
// promoted document. The container must be the running one that holds the
// release's Control Panel.
func (s NativeCoreServices) RecordPromotedSelection(ctx context.Context, request string) error {
	m := CoreManager{Root: s.Checkpoint.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.Phase != "applying" || !j.MetadataOnly {
		return fmt.Errorf("active metadata-only core request required")
	}
	active := false
	for _, step := range j.Steps {
		if step.Name == "authenticated-health" && step.State == "started" {
			active = true
		}
	}
	if !active {
		return fmt.Errorf("coordinator has not started core health action")
	}
	receipt, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(receipt, j.Previous) {
		return fmt.Errorf("installed core commitment changed")
	}
	machine, err := s.Checkpoint.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return fmt.Errorf("core selection machine changed")
	}
	member, err := coreServiceMember(j.Target, "cp")
	if err != nil {
		return err
	}
	pid, err := nativeCoreContainerPID(ctx, "youeye-control")
	if err != nil {
		return err
	}
	identity, err := nativeProcessIdentity(pid)
	if err != nil {
		return err
	}
	marker, err := readNativeCoreMarker(pid)
	if err != nil || marker.Role != "cp" || marker.ArtifactSHA256 != member.Artifact.SHA256 {
		return fmt.Errorf("selection component differs from selected payload")
	}
	root, err := os.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		return fmt.Errorf("core selection filesystem unavailable")
	}
	defer root.Close()
	if err = recordPromotedCoreSelection(m, root, j); err != nil {
		return err
	}
	after, err := nativeCoreContainerPID(ctx, "youeye-control")
	if err != nil || after != pid {
		return fmt.Errorf("core selection container restarted")
	}
	actual, err := nativeProcessIdentity(pid)
	if err != nil || actual != identity {
		return fmt.Errorf("core selection process identity changed")
	}
	return nil
}

func writeCoreContainerFileAt(dir *os.File, name, temp string, data []byte, limit int64) error {
	if len(data) == 0 || int64(len(data)) > limit {
		return fmt.Errorf("invalid core state write bound")
	}
	actual, err := readCoreContainerStateAtLimit(dir, name, limit)
	if err == nil && bytes.Equal(actual, data) {
		return nil
	}
	if err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	if err = placeCoreTempAt(dir, temp, limit, data, func(existing []byte) bool { return bytes.Equal(existing, data) }); err != nil {
		return err
	}
	if err = mutateCoreMapped(dir, func() error {
		return unix.Renameat(int(dir.Fd()), temp, int(dir.Fd()), name)
	}); err != nil {
		return err
	}
	return dir.Sync()
}

// placeCoreTempAt leaves temp holding exactly data, ready to be renamed over its target, which the caller has found to
// differ from data (so the target was never renamed from it). Temp names are scoped to the request and the step
// (`<stage>.<file>`, `coreSelectionTemp(request)`, a recovery's repair temp), and only that step's action child writes
// them, holding the step's child lock (`.child-lock`, core_runner.go); nothing reads them. So a temp found here was
// left by an earlier attempt of this same step, cut short by a failed write or a power loss. A complete one (matches)
// is kept and renamed. Any other is removed and written again, never trusted, and never a reason to ask for
// a paired recovery (YE-42). A write that fails removes its own temp.
func placeCoreTempAt(dir *os.File, temp string, limit int64, data []byte, matches func([]byte) bool) error {
	var owner unix.Stat_t
	if unix.Fstat(int(dir.Fd()), &owner) != nil || owner.Mode&0022 != 0 {
		return fmt.Errorf("unsafe core state directory")
	}
	existing, err := readCoreContainerStateAtLimit(dir, temp, limit)
	if err == nil && matches(existing) {
		return nil
	}
	if !errors.Is(err, unix.ENOENT) {
		if err = removeCoreTempAt(dir, temp); err != nil {
			return fmt.Errorf("interrupted core state write could not be removed: %w", err)
		}
	}
	fd, err := openCoreMappedExclusive(dir, temp, 0600)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), "core-state")
	_, err = file.Write(data)
	if err == nil {
		err = unix.Fchown(fd, int(owner.Uid), int(owner.Gid))
	}
	if err == nil {
		err = syncCoreTemp(file)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = removeCoreTempAt(dir, temp)
		return err
	}
	return nil
}

// syncCoreTemp flushes a written temp; tests replace it to cut a write short.
var syncCoreTemp = func(file *os.File) error { return file.Sync() }

// removeCoreTempAt unlinks a temp file of a core state write (never a directory); one already gone is fine.
func removeCoreTempAt(dir *os.File, temp string) error {
	return mutateCoreMapped(dir, func() error {
		if err := unix.Unlinkat(int(dir.Fd()), temp, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return err
		}
		return nil
	})
}
