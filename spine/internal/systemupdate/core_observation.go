package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"time"
)

// CoreInstalledObservation is fresh payload evidence, never an update or a
// replacement for the protected installed receipt. Unknown reads fail closed.
//
// State is "verified" (every shipped file is present and unchanged; Members
// say whether extra files exist), "modified" (a shipped file is changed or
// missing), "pending" (a System transaction is running) or "unverified" (the
// installation could not be observed). Only "unverified" and "pending" mean the
// observation itself did not complete. A modified installation still updates.
type CoreInstalledObservation struct {
	State          string                `json:"state"`
	ManifestSHA256 string                `json:"manifest_sha256"`
	ObservedAt     string                `json:"observed_at,omitempty"`
	Reason         string                `json:"reason,omitempty"`
	Members        []CoreInstalledMember `json:"members,omitempty"`
}

// CoreInstalledMember is what the walk of one installed service tree found.
// Findings.Paths is for an operator's terminal only; it is not durable.
type CoreInstalledMember struct {
	Role     string              `json:"role"`
	Summary  string              `json:"summary"`
	Findings CorePayloadFindings `json:"findings"`
}

// CoreInstalledSummary joins the members' states for one line of text, e.g.
// "cp verified, 2 extra files; ui modified (1 changed, 0 missing)".
func CoreInstalledSummary(members []CoreInstalledMember) string {
	parts := make([]string, 0, len(members))
	for _, member := range members {
		parts = append(parts, member.Role+" "+member.Summary)
	}
	return strings.Join(parts, "; ")
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
func (m CoreManager) ObserveInstalled(ctx context.Context, expected CoreReceipt, verify func(context.Context, CoreReceipt) ([]CoreInstalledMember, error)) CoreInstalledObservation {
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
	members, err := verify(ctx, before)
	if err != nil {
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
	out.State, out.ObservedAt, out.Members = "verified", time.Now().UTC().Format(time.RFC3339Nano), members
	for _, member := range members {
		if member.Findings.Differs() {
			out.State = "modified"
			out.Reason = "Installed System files differ from the release: " + CoreInstalledSummary(members)
		}
	}
	return out
}

// VerifyInstalled observes current membership and the live static trees and
// returns what each walk found. It never applies schema or mistakes a retained
// marker for the actual file bytes. In record mode (an observation of a box
// that is merely installed) file differences are reported, never an error; in
// strict mode (a tree just written, such as a copy destination) a changed or
// missing shipped file is an error. Identity, marker and schema-receipt
// mismatches are errors in both.
func (s NativeCoreServices) VerifyInstalled(ctx context.Context, receipt CoreReceipt, mode CorePayloadMode, host func(context.Context, CoreReceipt) error) ([]CoreInstalledMember, error) {
	m := CoreManager{Root: s.Checkpoint.Root}
	_, release, err := m.Selection(receipt.ManifestSHA256)
	if err != nil || !reflect.DeepEqual(release, receipt.Release) {
		return nil, fmt.Errorf("current installed selection unavailable")
	}
	machine, err := s.Checkpoint.observeMachine()
	if err != nil || machine != receipt.Machine {
		return nil, fmt.Errorf("installed machine identity changed")
	}
	if host == nil {
		return nil, fmt.Errorf("native host verifier required")
	}
	if err = host(ctx, receipt); err != nil {
		return nil, err
	}
	members := []CoreInstalledMember{}
	for _, role := range []string{"cp", "ui"} {
		member, err := coreServiceMember(release, role)
		if err != nil {
			return nil, err
		}
		container, appDir := "youeye-control", s.CPAppDir
		if role == "ui" {
			container, appDir = "youeye-ui", s.UIAppDir
		}
		pid, err := nativeCoreContainerPID(ctx, container)
		if err != nil {
			return nil, err
		}
		process, err := nativeProcessIdentity(pid)
		if err != nil {
			return nil, err
		}
		marker, err := readNativeCoreMarker(pid)
		if err != nil || marker.Role != role || marker.ArtifactSHA256 != member.Artifact.SHA256 {
			return nil, fmt.Errorf("installed component marker differs")
		}
		index, err := m.LoadPayloadIndex(member.Artifact.SHA256)
		if err != nil {
			return nil, err
		}
		found, err := VerifyCoreContainerPayload(ctx, container, appDir, index, mode)
		if err != nil {
			return nil, fmt.Errorf("installed %s: %w", role, err)
		}
		members = append(members, CoreInstalledMember{Role: role, Summary: found.Summary(), Findings: found})
		if err = verifyNativeCoreSchemaReceipt(pid, marker); err != nil {
			return nil, err
		}
		afterPID, err := nativeCoreContainerPID(ctx, container)
		if err != nil || afterPID != pid {
			return nil, fmt.Errorf("installed component restarted")
		}
		afterProcess, err := nativeProcessIdentity(pid)
		if err != nil || afterProcess != process {
			return nil, fmt.Errorf("installed process changed")
		}
		afterMarker, err := readNativeCoreMarker(pid)
		if err != nil || afterMarker != marker {
			return nil, fmt.Errorf("installed component marker changed")
		}
	}
	return members, nil
}
