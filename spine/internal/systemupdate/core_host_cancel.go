package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

// CancelCoreHost clears only this coordinator's owned inactive preparation.
// The running payload and all owner data remain untouched. Each cleanup is
// idempotent on exact native identity, including loss between State and journal.
func (m *Manager) CancelCoreHost(ctx context.Context, request string) error {
	unlock, err := m.lock()
	if err != nil {
		return err
	}
	defer unlock()
	j, err := (CoreManager{Root: m.config.CoreStatePath}).Read()
	if err != nil || j.RequestID != request || j.ActivationRequested || j.Phase != "cancelling" || !j.RestartRequired || len(j.RecoverySteps) > 0 {
		return fmt.Errorf("exact unactivated core request required")
	}
	staged := false
	for _, step := range j.Steps {
		if step.Name == "verify-members" || step.Name == "stage-host" {

			staged = staged || (step.Name == "stage-host" && step.State != "pending")
		} else if step.State != "pending" {
			return fmt.Errorf("activation requires paired recovery")
		}
	}
	if !staged {
		return fmt.Errorf("no complete core host stage exists")
	}
	current, state, slot, err := m.current()
	if err != nil {
		return err
	}
	host, err := loadJournal(m.config.JournalPath)
	if errors.Is(err, os.ErrNotExist) || (err == nil && host.CoreManifestSHA256 != j.ManifestSHA256) {
		// The settled child may have failed before creating its host journal.
		// Never clear a previous rollback chain or another pending transaction.
		if state.Transaction != (appliance.TransactionState{}) || state.Slots.Candidate != "" {
			return fmt.Errorf("unowned host preparation requires reconciliation")
		}
		return BindCoreImage(j.Previous.Release, current)
	}
	if err != nil {
		return err
	}
	switch host.Phase {
	case PhaseAvailable, PhaseDownload, PhaseWriting, PhaseStaged, PhaseFailed:
	case PhaseRollback:
		if host.ErrorCode != "core_stage_cancelled" {
			return fmt.Errorf("host recovery already started")
		}
	default:
		return fmt.Errorf("host activation has started; cancellation is unavailable")
	}
	if slot != host.ActiveSlot || current.ImageVersion != host.CurrentImage || state.Slots.Current != slot || state.Slots.CurrentImageVersion != current.ImageVersion {
		return fmt.Errorf("staged cancellation no longer matches the running host")
	}
	if state.Transaction != (appliance.TransactionState{}) {
		if state.Transaction.ID != host.TransactionID || state.Transaction.ManifestSHA256 != host.ManifestSHA256 || (state.Transaction.Stage != PhaseWriting && state.Transaction.Stage != PhaseStaged && state.Transaction.Stage != PhaseFailed) || state.Slots.Candidate != host.CandidateSlot || state.Slots.CandidateImageVersion != host.TargetImage {
			return fmt.Errorf("another native transaction owns the inactive slot")
		}
	} else if state.Slots.Candidate != "" {
		return fmt.Errorf("unowned candidate slot requires recovery")
	}
	layout, err := m.config.DiscoverLayout(slot)
	if err != nil {
		return err
	}
	if err = validateLayoutAgainstState(layout, state); err != nil {
		return err
	}
	if layout.InactiveSlot != host.CandidateSlot {
		return fmt.Errorf("inactive cancellation target changed")
	}
	if err = m.callRemoveBootEntries(layout); err != nil {
		return err
	}
	state.Slots.Candidate = ""
	state.Slots.CandidateImageVersion = ""
	state.Transaction = appliance.TransactionState{}
	if err = appliance.WriteStateAtomic(m.config.StatePath, state); err != nil {
		return err
	}
	host.Phase = PhaseRollback
	host.ErrorCode = "core_stage_cancelled"
	host.Error = "inactive core stage cancelled before activation"
	host.UpdatedAt = m.now()
	return writeJournal(m.config.JournalPath, host)
}
