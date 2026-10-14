package systemupdate

import (
	"context"
	"fmt"
	"reflect"
)

// coreCheckpointUnapplied is positive graph evidence, not a deduction from a
// missing process or action receipt. Every payload-changing action persists its
// started state before acquiring native authority. A started/failed action can
// have changed data even when its acknowledgement was lost.
func coreCheckpointUnapplied(j CoreJournal) bool {
	if j.NoOp || validateCoreSteps(j) != nil {
		return false
	}
	checkpoint := false
	for _, step := range j.Steps {
		if checkpoint && step.State != "pending" {
			return false
		}
		if step.Name == "checkpoint" {
			if step.State == "pending" {
				return false
			}
			checkpoint = true
		}
	}
	return checkpoint
}

// AbortCheckpoint settles the paired-restore action without restoring data
// when activation provably never started. The recovery fence must already have
// settled this request's children and provider operations, stopped writers and
// completed any partial maintenance holds. It retains snapshots/archives for
// reference-aware cleanup. This is not baseline health or permission to reopen
// ingress; the remaining recovery graph and original power intent still apply.
func (p NativeCoreCheckpoint) AbortCheckpoint(ctx context.Context, request string) (NativeCoreCheckpointRecord, error) {
	var empty NativeCoreCheckpointRecord
	m := CoreManager{Root: p.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.Phase != "recovering" || !coreCheckpointUnapplied(j) {
		return empty, fmt.Errorf("checkpoint abort requires positive evidence that activation never started")
	}
	fenced, active := false, false
	for _, step := range j.RecoverySteps {
		if step.Name == "recovery-fence" && step.State == "succeeded" && step.Evidence != "" {
			fenced = true
		}
		if step.Name == "recovery-paired-restore" && step.State == "started" {
			active = true
		}
	}
	if !fenced || !active {
		return empty, fmt.Errorf("verified recovery fence and active paired recovery required")
	}
	installed, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(installed, j.Previous) {
		return empty, fmt.Errorf("installed baseline changed during checkpoint abort")
	}
	if err = p.verifyReservation(j); err != nil {
		return empty, err
	}
	machine, err := p.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return empty, fmt.Errorf("checkpoint abort machine changed")
	}
	record, err := p.Read(j)
	if err != nil {
		return record, err
	}
	switch record.Phase {
	case "prepared", "quiescing", "quiesced", "capturing-roots", "roots-captured", "capturing-files", "files-captured", "capturing-databases", "captured", "aborted-unapplied":
	default:
		return record, fmt.Errorf("checkpoint already entered restoration or unknown state")
	}
	if err = p.verifyContainerIdentities(ctx, record.Inventory, true); err != nil {
		return record, err
	}
	_, digest, err := p.installedOwners()
	if err != nil || digest != record.Inventory.AppInventorySHA256 {
		return record, fmt.Errorf("checkpoint abort application inventory changed")
	}
	// This also proves no unowned database writer remains. Do not compare an
	// incomplete capture's security digest or rewind a new grant/user change.
	if err = p.requireClosedDatabaseWriters(ctx); err != nil {
		return record, err
	}
	record.Phase = "aborted-unapplied"
	return record, p.saveRecord(record)
}
