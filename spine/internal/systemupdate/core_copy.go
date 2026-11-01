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
	"regexp"
)

// Copy is a separate native acceptance path. It cannot change installed release
// bytes, lower a sequence floor, initialize schemas, or adopt source journals as
// destination recovery authority. The caller must keep networking quarantined
// until machine/service identity preparation and this verification succeed.
type CoreCopyRequest struct {
	RequestID           string `json:"request_id"`
	SourceHardware      string `json:"source_hardware"`
	DestinationHardware string `json:"destination_hardware"`
	SourceReceiptSHA256 string `json:"source_receipt_sha256"`
	ManifestSHA256      string `json:"manifest_sha256"`
}
type CoreCopyJournal struct {
	Schema      string          `json:"schema"`
	Request     CoreCopyRequest `json:"request"`
	Source      CoreReceipt     `json:"source"`
	Destination *CoreReceipt    `json:"destination,omitempty"`
	Phase       string          `json:"phase"`
}

var copyHardwarePattern = regexp.MustCompile(`^smbios:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func CoreReceiptDigest(r CoreReceipt) string {
	raw, _ := json.Marshal(r)
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}
func (r CoreCopyRequest) Validate() error {
	if !coreRequestPattern.MatchString(r.RequestID) || !copyHardwarePattern.MatchString(r.SourceHardware) || !copyHardwarePattern.MatchString(r.DestinationHardware) || r.SourceHardware == r.DestinationHardware || !validSHA256(r.SourceReceiptSHA256) || !validSHA256(r.ManifestSHA256) {
		return fmt.Errorf("copy requires distinct exact hardware, source receipt and signed selection")
	}
	return nil
}
func (m CoreManager) readCopy() (CoreCopyJournal, error) {
	var j CoreCopyJournal
	raw, err := ReadCoreState(filepath.Join(m.Root, "copy.json"), 4<<20)
	if err != nil {
		return j, err
	}
	if err = json.Unmarshal(raw, &j); err != nil {
		return j, err
	}
	if j.Schema != "youeye.core-copy.v1" || j.Request.Validate() != nil || CoreReceiptDigest(j.Source) != j.Request.SourceReceiptSHA256 || j.Source.ManifestSHA256 != j.Request.ManifestSHA256 {
		return j, fmt.Errorf("invalid native copy journal")
	}
	if j.Phase != "verifying" && j.Phase != "verified" && j.Phase != "committed" {
		return j, fmt.Errorf("unknown copy state")
	}
	if j.Source.Machine.Validate() != nil || j.Source.Release.Validate() != nil {
		return j, fmt.Errorf("invalid copy source receipt")
	}
	if j.Phase == "verifying" && j.Destination != nil {
		return j, fmt.Errorf("unverified copy has a destination receipt")
	}
	if j.Phase != "verifying" {
		d := j.Destination
		if d == nil || d.Machine.Validate() != nil || d.AcceptedAt == "" || d.Evidence == "" || d.ManifestSHA256 != j.Source.ManifestSHA256 || !reflect.DeepEqual(d.Release, j.Source.Release) || d.Machine.InstallIDRef == j.Source.Machine.InstallIDRef || d.Machine.DeviceIDRef == j.Source.Machine.DeviceIDRef {
			return j, fmt.Errorf("invalid independent destination receipt")
		}
	}
	return j, nil
}
func (m CoreManager) saveCopy(j CoreCopyJournal) error {
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(m.Root, "copy.json"), raw, 0600)
}

// VerifyIndependentCopy accepts only read-only native evidence of the prepared
// destination. verify must inspect actual hardware, signed static membership,
// partition/data ownership and independent current service identity/health.
// It must not return success based on these request fields alone.
func (m CoreManager) VerifyIndependentCopy(ctx context.Context, request CoreCopyRequest, trustKeyPath string, verify func(context.Context, CoreReceipt, CoreCopyRequest) (CoreMachineIdentity, string, error)) (CoreReceipt, error) {
	if err := request.Validate(); err != nil {
		return CoreReceipt{}, err
	}
	if verify == nil {
		return CoreReceipt{}, fmt.Errorf("native copy verifier required")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return CoreReceipt{}, err
	}
	defer unlock()
	j, err := m.beginCopyLocked(request, trustKeyPath)
	if err != nil {
		return CoreReceipt{}, err
	}
	machine, evidence, err := verify(ctx, j.Source, request)
	if err != nil {
		return CoreReceipt{}, err
	}
	if err = machine.Validate(); err != nil {
		return CoreReceipt{}, err
	}
	if machine.InstallIDRef == j.Source.Machine.InstallIDRef || machine.DeviceIDRef == j.Source.Machine.DeviceIDRef || evidence == "" || len(evidence) > 32768 {
		return CoreReceipt{}, fmt.Errorf("independent destination identity and native evidence required")
	}
	if j.Destination != nil {
		if j.Destination.Machine != machine {
			return CoreReceipt{}, fmt.Errorf("destination machine changed during copy")
		}
	} else {
		receipt := CoreReceipt{Machine: machine, Evidence: evidence, ManifestSHA256: j.Source.ManifestSHA256, Release: j.Source.Release, AcceptedAt: m.now()}
		j.Destination = &receipt
		j.Phase = "verified"
		if err = m.saveCopy(j); err != nil {
			return CoreReceipt{}, err
		}
	}
	if j.Phase == "committed" {
		current, err := m.ReadReceipt()
		if err != nil || !reflect.DeepEqual(current, *j.Destination) {
			return CoreReceipt{}, fmt.Errorf("committed copy receipt changed")
		}
		return current, nil
	}
	// Retain complete source recovery history under an inert namespace. Never
	// replay source-bound update requests on the new installation.
	archive := filepath.Join(m.Root, "copy-source-history", request.RequestID)
	if err = os.MkdirAll(archive, 0700); err != nil {
		return CoreReceipt{}, err
	}
	for _, name := range []string{"journal.json", "requests", "checkpoints"} {
		source, destination := filepath.Join(m.Root, name), filepath.Join(archive, name)
		_, err := os.Lstat(source)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return CoreReceipt{}, err
		}
		if _, err = os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
			return CoreReceipt{}, fmt.Errorf("copy source history conflict")
		}
		if err = os.Rename(source, destination); err != nil {
			return CoreReceipt{}, err
		}
	}
	for _, dir := range []string{archive, m.Root} {
		f, e := os.Open(dir)
		if e != nil {
			return CoreReceipt{}, e
		}
		e = f.Sync()
		f.Close()
		if e != nil {
			return CoreReceipt{}, e
		}
	}
	raw, err := json.Marshal(j.Destination)
	if err != nil {
		return CoreReceipt{}, err
	}
	if err = atomicWrite(filepath.Join(m.Root, "committed.json"), raw, 0600); err != nil {
		return CoreReceipt{}, err
	}
	j.Phase = "committed"
	if err = m.saveCopy(j); err != nil {
		return CoreReceipt{}, err
	}
	return *j.Destination, nil
}

func (m CoreManager) IndependentCopyReceipt(request CoreCopyRequest) (CoreReceipt, error) {
	j, err := m.readCopy()
	if err != nil || j.Request != request || j.Phase != "committed" || j.Destination == nil {
		return CoreReceipt{}, fmt.Errorf("exact committed copy receipt unavailable")
	}
	actual, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(actual, *j.Destination) {
		return CoreReceipt{}, fmt.Errorf("committed copy receipt changed")
	}
	return actual, nil
}

// BeginIndependentCopy freezes the copy request before destination preparation.
// Callers must retain quarantine and the platform lifecycle reservation until
// VerifyIndependentCopy and the service identity coordinator have completed.
func (m CoreManager) BeginIndependentCopy(request CoreCopyRequest, trustKeyPath string, observeHardware func() (string, error)) error {
	if err := request.Validate(); err != nil {
		return err
	}
	if observeHardware == nil {
		return fmt.Errorf("native hardware observation required")
	}
	actual, err := observeHardware()
	if err != nil {
		return err
	}
	if actual != request.DestinationHardware {
		return fmt.Errorf("copy admission reached different hardware")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return err
	}
	defer unlock()
	_, err = m.beginCopyLocked(request, trustKeyPath)
	return err
}
func (m CoreManager) beginCopyLocked(request CoreCopyRequest, trustKeyPath string) (CoreCopyJournal, error) {
	j, err := m.readCopy()
	if err == nil && j.Request != request {
		// A later cold copy may inherit a completed copy receipt. Keep that
		// provenance, but never reinterpret an unfinished operation or change
		// a retained request's payload. The native callback still proves the
		// actual new hardware and independent prepared identity.
		if j.Phase != "committed" || j.Request.RequestID == request.RequestID || j.Request.DestinationHardware != request.SourceHardware {
			return CoreCopyJournal{}, fmt.Errorf("another copy owns this destination")
		}
		current, readErr := m.ReadReceipt()
		if readErr != nil || CoreReceiptDigest(current) != request.SourceReceiptSHA256 {
			return CoreCopyJournal{}, fmt.Errorf("inherited copy source receipt changed")
		}
		priorRaw, marshalErr := json.Marshal(j)
		if marshalErr != nil {
			return CoreCopyJournal{}, marshalErr
		}
		archive := filepath.Join(m.Root, "copy-history")
		if err = os.MkdirAll(archive, 0700); err != nil {
			return CoreCopyJournal{}, err
		}
		if err = atomicWrite(filepath.Join(archive, j.Request.RequestID+".json"), priorRaw, 0600); err != nil {
			return CoreCopyJournal{}, err
		}
		// Leave the old committed journal in place until the new journal is
		// atomically durable. A failed replacement cannot erase provenance.
		err = os.ErrNotExist
	}
	if errors.Is(err, os.ErrNotExist) {
		source, e := m.ReadReceipt()
		if e != nil {
			return CoreCopyJournal{}, e
		}
		if source.ManifestSHA256 != request.ManifestSHA256 || CoreReceiptDigest(source) != request.SourceReceiptSHA256 {
			return CoreCopyJournal{}, fmt.Errorf("source receipt changed")
		}
		prior, e := m.Read()
		if e == nil && !m.TransactionComplete(prior) {
			return CoreCopyJournal{}, fmt.Errorf("unfinished source update cannot be copied")
		}
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			return CoreCopyJournal{}, e
		}
		j = CoreCopyJournal{Schema: "youeye.core-copy.v1", Request: request, Source: source, Phase: "verifying"}
		if e = m.saveCopy(j); e != nil {
			return CoreCopyJournal{}, e
		}
	} else if err != nil {
		return CoreCopyJournal{}, err
	}
	_, release, err := m.Selection(request.ManifestSHA256, trustKeyPath)
	if err != nil {
		return CoreCopyJournal{}, err
	}
	if !reflect.DeepEqual(release, j.Source.Release) {
		return CoreCopyJournal{}, fmt.Errorf("copy signed membership differs from source")
	}
	return j, nil
}
