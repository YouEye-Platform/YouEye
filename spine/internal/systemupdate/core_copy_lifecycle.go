package systemupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type CopyLifecycleReservation struct {
	Schema  string          `json:"schema"`
	Role    string          `json:"role"`
	Request CoreCopyRequest `json:"request"`
}

// AdmitOutsideCopy lets automatic host convergence finish before a source is
// frozen, and keeps it out of an unfinished source or destination copy. System
// updates retain their existing boot-convergence behavior; this lease governs
// the independent-copy reservation only.
func (b CoreLifecycleBarrier) AdmitOutsideCopy() (func(), error) {
	release, err := b.lockMode(syscall.LOCK_SH)
	if err != nil {
		return nil, err
	}
	if _, err = b.ReadCopy(); !errors.Is(err, os.ErrNotExist) {
		release()
		return nil, fmt.Errorf("independent copy owns host convergence")
	}
	return release, nil
}

func (b CoreLifecycleBarrier) ReadCopy() (CopyLifecycleReservation, error) {
	var r CopyLifecycleReservation
	raw, err := ReadCoreState(filepath.Join(b.Root, "copy-reservation.json"), 4096)
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(raw, &r); err != nil {
		return r, err
	}
	if r.Schema != "youeye.copy-lifecycle.v1" || (r.Role != "source" && r.Role != "destination") || r.Request.Validate() != nil {
		return r, fmt.Errorf("invalid independent copy lifecycle reservation")
	}
	return r, nil
}

// BeginCopy closes ordinary app/container/native lifecycle admission. It uses a
// distinct durable protocol, never a fabricated System update journal. A cold
// destination inherits the source reservation and may adopt it only after an
// actual observation of the request's different destination hardware.
func (b CoreLifecycleBarrier) BeginCopy(request CoreCopyRequest, role string, observeHardware func() (string, error)) error {
	if request.Validate() != nil || (role != "source" && role != "destination") || observeHardware == nil {
		return fmt.Errorf("exact copy lifecycle request required")
	}
	actual, err := observeHardware()
	if err != nil {
		return err
	}
	expected := request.SourceHardware
	if role == "destination" {
		expected = request.DestinationHardware
	}
	if actual != expected {
		return fmt.Errorf("copy lifecycle hardware changed")
	}
	unlock, err := b.lock()
	if err != nil {
		return err
	}
	defer unlock()
	if _, err = b.Read(); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("System lifecycle must settle before copy")
	}
	old, err := b.ReadCopy()
	want := CopyLifecycleReservation{Schema: "youeye.copy-lifecycle.v1", Role: role, Request: request}
	if err == nil {
		if old == want {
			return nil
		}
		if !(old.Request == request && old.Role == "source" && role == "destination") {
			return fmt.Errorf("another independent copy owns the platform")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else {
		if role == "destination" {
			return fmt.Errorf("destination has no inherited source copy reservation")
		}
		if _, e := ReadCoreState(filepath.Join(b.Root, "copy-completions", request.RequestID+"-source.json"), 4096); !errors.Is(e, os.ErrNotExist) {
			return fmt.Errorf("source copy request already completed or needs reconciliation")
		}
	}
	if err = b.checkQuiescent(); err != nil {
		return err
	}
	raw, err := json.Marshal(want)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(b.Root, "copy-reservation.json"), raw, 0600)
}

// ReleaseCopy requires the owning coordinator's positive native completion
// evidence. Process exit, a missing worker or elapsed time cannot release it.
func (b CoreLifecycleBarrier) ReleaseCopy(request CoreCopyRequest, role string, verify func() error) error {
	if request.Validate() != nil || verify == nil || (role != "source" && role != "destination") {
		return fmt.Errorf("copy completion verification required")
	}
	unlock, err := b.lock()
	if err != nil {
		return err
	}
	defer unlock()
	want := CopyLifecycleReservation{Schema: "youeye.copy-lifecycle.v1", Role: role, Request: request}
	done := filepath.Join(b.Root, "copy-completions", request.RequestID+"-"+role+".json")
	r, err := b.ReadCopy()
	if errors.Is(err, os.ErrNotExist) {
		raw, readErr := ReadCoreState(done, 4096)
		if readErr != nil || json.Unmarshal(raw, &r) != nil || r != want {
			return fmt.Errorf("copy completion receipt unavailable")
		}
		return verify()
	}
	if err != nil || r != want {
		return fmt.Errorf("copy reservation changed before completion")
	}
	if err = verify(); err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(done), 0700); err != nil {
		return err
	}
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if err = atomicWrite(done, raw, 0600); err != nil {
		return err
	}
	if err = os.Remove(filepath.Join(b.Root, "copy-reservation.json")); err != nil {
		return err
	}
	dir, err := os.Open(b.Root)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// ReserveIndependentCopySource follows the same core -> app lock order as native
// System activation. It freezes admission only after the exact signed source
// receipt, actual hardware and all retained native transactions are settled.
func (m CoreManager) ReserveIndependentCopySource(request CoreCopyRequest, trustKeyPath string, b CoreLifecycleBarrier, observeHardware func() (string, error)) error {
	if request.Validate() != nil || observeHardware == nil {
		return fmt.Errorf("exact native source copy request required")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return err
	}
	defer unlock()
	receipt, err := m.ReadReceipt()
	if err != nil || CoreReceiptDigest(receipt) != request.SourceReceiptSHA256 || receipt.ManifestSHA256 != request.ManifestSHA256 {
		return fmt.Errorf("copy source receipt changed")
	}
	if _, _, err = m.Selection(request.ManifestSHA256, trustKeyPath); err != nil {
		return err
	}
	if j, err := m.Read(); err == nil {
		if !m.TransactionComplete(j) {
			return fmt.Errorf("unfinished native transaction blocks copy")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if prior, err := m.readCopy(); err == nil {
		if prior.Phase != "committed" {
			return fmt.Errorf("unfinished native copy blocks source reservation")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return b.BeginCopy(request, "source", observeHardware)
}
func (m CoreManager) AdmitIndependentCopyDestination(request CoreCopyRequest, trustKeyPath string, b CoreLifecycleBarrier, observeHardware func() (string, error)) error {
	if request.Validate() != nil || observeHardware == nil {
		return fmt.Errorf("exact native destination copy request required")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return err
	}
	defer unlock()
	if err = b.BeginCopy(request, "destination", observeHardware); err != nil {
		return err
	}
	// A failed membership check retains quarantine/lifecycle ownership for repair.
	_, err = m.beginCopyLocked(request, trustKeyPath)
	return err
}
