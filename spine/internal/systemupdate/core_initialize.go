package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

type CoreMachineIdentity struct {
	InstallIDRef  string `json:"install_id_ref"`
	DeviceIDRef   string `json:"device_id_ref"`
	ParentDiskID  string `json:"parent_disk_id"`
	StatePartUUID string `json:"state_part_uuid"`
	DataPartUUID  string `json:"data_part_uuid"`
}

func (i CoreMachineIdentity) Validate() error {
	for _, s := range []string{i.InstallIDRef, i.DeviceIDRef, i.ParentDiskID, i.StatePartUUID, i.DataPartUUID} {
		if s == "" || len(s) > 512 || strings.TrimSpace(s) != s || strings.ContainsAny(s, "\x00\r\n") {
			return fmt.Errorf("complete installed machine identity required")
		}
	}
	return nil
}

func (m CoreManager) retainSelection(selection CoreHostSelection, digest string) error {
	if err := atomicWrite(filepath.Join(m.Root, "targets", digest+".json"), selection.Raw, 0600); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(m.Root, "targets", digest+".json.sig"), selection.Signature, 0600)
}

func (m CoreManager) Selection(digest string, trustKeyPath string) (CoreHostSelection, releasecache.CoreRelease, error) {
	var s CoreHostSelection
	if !validSHA256(digest) {
		return s, releasecache.CoreRelease{}, fmt.Errorf("exact core digest required")
	}
	raw, err := ReadCoreState(filepath.Join(m.Root, "targets", digest+".json"), 1<<20)
	if err != nil {
		return s, releasecache.CoreRelease{}, err
	}
	sig, err := ReadCoreState(filepath.Join(m.Root, "targets", digest+".json.sig"), 64)
	if err != nil {
		return s, releasecache.CoreRelease{}, err
	}
	s = CoreHostSelection{Raw: raw, Signature: sig}
	r, actual, err := VerifyCoreSelection(raw, sig, trustKeyPath)
	if err != nil {
		return s, r, err
	}
	if actual != digest {
		return s, r, fmt.Errorf("retained core selection digest changed")
	}
	return s, r, nil
}

func (m CoreManager) PrepareSigned(ctx context.Context, requestID string, selection CoreHostSelection, expectedDigest, trustKeyPath string) (CoreJournal, error) {
	_, digest, err := VerifyCoreSelection(selection.Raw, selection.Signature, trustKeyPath)
	if err != nil {
		return CoreJournal{}, err
	}
	if digest != expectedDigest {
		return CoreJournal{}, fmt.Errorf("selected core digest differs from request")
	}
	// Immutable signed inputs may be retained before lifecycle admission. No
	// executable effect occurs here, and the executor rechecks current policy.
	if err := m.retainSelection(selection, digest); err != nil {
		return CoreJournal{}, err
	}
	return m.Prepare(ctx, requestID, selection.Raw, digest)
}

// Initialize creates the first shared receipt only after a native verifier has
// inspected fresh installed payloads, exact machine identity and operational
// health. The callback is read-only; this is not an old-install migration path.
func (m CoreManager) Initialize(ctx context.Context, selection CoreHostSelection, expectedDigest, trustKeyPath string, verifyInstalled func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error)) (CoreReceipt, error) {
	unlock, err := m.lockCore()
	if err != nil {
		return CoreReceipt{}, err
	}
	defer unlock()
	r, digest, err := VerifyCoreSelection(selection.Raw, selection.Signature, trustKeyPath)
	if err != nil {
		return CoreReceipt{}, err
	}
	if digest != expectedDigest || verifyInstalled == nil {
		return CoreReceipt{}, fmt.Errorf("exact fresh selection and native verifier required")
	}
	machine, evidence, err := verifyInstalled(ctx, r)
	if err != nil {
		return CoreReceipt{}, err
	}
	if err := machine.Validate(); err != nil {
		return CoreReceipt{}, err
	}
	if evidence == "" || len(evidence) > 32768 {
		return CoreReceipt{}, fmt.Errorf("fresh installed acceptance evidence required")
	}
	old, err := m.ReadReceipt()
	if err == nil {
		if old.ManifestSHA256 != digest || !reflect.DeepEqual(old.Release, r) || old.Machine != machine {
			return old, fmt.Errorf("fresh initialization cannot replace an installed core receipt")
		}
		return old, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return old, err
	}
	if _, err := m.Read(); !errors.Is(err, os.ErrNotExist) {
		return CoreReceipt{}, fmt.Errorf("fresh initialization cannot replace an existing update journal")
	}
	if err := m.retainSelection(selection, digest); err != nil {
		return CoreReceipt{}, err
	}
	if err := m.retainSequence(r, digest, true); err != nil {
		return CoreReceipt{}, err
	}
	receipt := CoreReceipt{ManifestSHA256: digest, Release: r, AcceptedAt: m.now(), Machine: machine, Evidence: evidence}
	raw, err := json.Marshal(receipt)
	if err != nil {
		return CoreReceipt{}, err
	}
	return receipt, atomicWrite(filepath.Join(m.Root, "committed.json"), raw, 0600)
}
