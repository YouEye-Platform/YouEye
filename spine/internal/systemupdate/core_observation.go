package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"time"
)

// CoreInstalledObservation is fresh payload evidence, never an update or a
// replacement for the protected installed receipt. Unknown reads fail closed.
type CoreInstalledObservation struct {
	State          string `json:"state"`
	ManifestSHA256 string `json:"manifest_sha256"`
	ObservedAt     string `json:"observed_at,omitempty"`
	Reason         string `json:"reason,omitempty"`
}

func (m CoreManager) TransactionComplete(j CoreJournal) bool {
	if j.Phase == "cancelled" || (j.NoOp || j.MetadataOnly) && j.Phase == "committed" {
		return true
	}
	if j.Phase != "committed" && j.Phase != "rolled-back" {
		return false
	}
	r, err := (NativeCoreCheckpoint{Root: m.Root}).Read(j)
	return err == nil && r.CompletionState == "released"
}

// ObserveInstalled brackets the native scan with exact receipt and transaction
// reads. It does not create locks, journals, caches, update jobs or migrations.
func (m CoreManager) ObserveInstalled(ctx context.Context, expected CoreReceipt, verify func(context.Context, CoreReceipt) error) CoreInstalledObservation {
	out := CoreInstalledObservation{State: "unverified", ManifestSHA256: expected.ManifestSHA256}
	fail := func(reason string) CoreInstalledObservation { out.Reason = reason; return out }
	before, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(before, expected) {
		return fail("Installed receipt changed or is unavailable")
	}
	j, err := m.Read()
	absent := errors.Is(err, os.ErrNotExist)
	if err != nil && !absent {
		return fail("System transaction requires reconciliation")
	}
	if !absent && !m.TransactionComplete(j) {
		out.State = "pending"
		return fail("System transaction has not completed")
	}
	if verify == nil {
		return fail("Native payload verifier is unavailable")
	}
	if err = verify(ctx, before); err != nil {
		return fail("Current hardware, authority or installed payloads could not be verified")
	}
	after, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(before, after) {
		return fail("Installed receipt changed during observation")
	}
	afterJournal, err := m.Read()
	if absent {
		if !errors.Is(err, os.ErrNotExist) {
			return fail("System transaction changed during observation")
		}
	} else if err != nil || !reflect.DeepEqual(j, afterJournal) || !m.TransactionComplete(afterJournal) {
		return fail("System transaction changed during observation")
	}
	if ctx.Err() != nil {
		return fail("Installed observation timed out")
	}
	out.State, out.ObservedAt = "verified", time.Now().UTC().Format(time.RFC3339Nano)
	return out
}

// VerifyInstalled observes current signed membership and live static trees. It
// never applies schema or mistakes a retained marker for the actual file bytes.
func (s NativeCoreServices) VerifyInstalled(ctx context.Context, receipt CoreReceipt, host func(context.Context, CoreReceipt) error) error {
	m := CoreManager{Root: s.Checkpoint.Root}
	_, release, err := m.Selection(receipt.ManifestSHA256, s.Cache.TrustKeyPath)
	if err != nil || !reflect.DeepEqual(release, receipt.Release) {
		return fmt.Errorf("current signed installed selection unavailable")
	}
	for _, member := range release.Members {
		if err = CheckCoreMemberAuthority(member, release.Channel, s.Cache.TrustKeyPath); err != nil {
			return err
		}
	}
	machine, err := s.Checkpoint.observeMachine()
	if err != nil || machine != receipt.Machine {
		return fmt.Errorf("installed machine identity changed")
	}
	if host == nil {
		return fmt.Errorf("native host verifier required")
	}
	if err = host(ctx, receipt); err != nil {
		return err
	}
	for _, role := range []string{"cp", "ui"} {
		member, err := coreServiceMember(release, role)
		if err != nil {
			return err
		}
		container, appDir := "youeye-control", s.CPAppDir
		if role == "ui" {
			container, appDir = "youeye-ui", s.UIAppDir
		}
		pid, err := nativeCoreContainerPID(ctx, container)
		if err != nil {
			return err
		}
		process, err := nativeProcessIdentity(pid)
		if err != nil {
			return err
		}
		marker, err := readNativeCoreMarker(pid)
		if err != nil || marker.Role != role || marker.ArtifactSHA256 != member.Artifact.SHA256 {
			return fmt.Errorf("installed component marker differs")
		}
		index, err := m.LoadPayloadIndex(member.Artifact.SHA256)
		if err != nil {
			return err
		}
		if err = VerifyCoreContainerPayload(ctx, container, appDir, index); err != nil {
			return err
		}
		if err = verifyNativeCoreSchemaReceipt(pid, marker); err != nil {
			return err
		}
		afterPID, err := nativeCoreContainerPID(ctx, container)
		if err != nil || afterPID != pid {
			return fmt.Errorf("installed component restarted")
		}
		afterProcess, err := nativeProcessIdentity(pid)
		if err != nil || afterProcess != process {
			return fmt.Errorf("installed process changed")
		}
		afterMarker, err := readNativeCoreMarker(pid)
		if err != nil || afterMarker != marker {
			return fmt.Errorf("installed component marker changed")
		}
	}
	return nil
}
