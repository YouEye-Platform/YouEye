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

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

type coreHostRecovery struct {
	Schema         string `json:"schema"`
	RequestID      string `json:"request_id"`
	ManifestSHA256 string `json:"manifest_sha256"`
	PreviousSHA256 string `json:"previous_sha256"`
	ActiveSlot     string `json:"active_slot"`
	CandidateSlot  string `json:"candidate_slot"`
	State          string `json:"state"`
}

// RecoverCoreHost selects only the retained known-good slot after paired
// service/data restoration. A reboot is requested once. Its acknowledgement is
// not success: only the actual previous immutable boot can complete recovery.
func (m *Manager) RecoverCoreHost(ctx context.Context, request string, observeOnly bool) (CoreActionObservation, error) {
	unknown := CoreActionObservation{State: "unknown"}
	unlock, err := m.lock()
	if err != nil {
		return unknown, err
	}
	defer unlock()
	cm := CoreManager{Root: m.config.CoreStatePath}
	j, err := cm.Read()
	if err != nil || j.RequestID != request || j.Phase != "recovering" || !j.RestartRequired {
		return unknown, fmt.Errorf("exact active core host recovery required")
	}
	active := false
	for _, step := range j.RecoverySteps {
		if step.Name == "recovery-host" && step.State == "started" {
			active = true
		}
	}
	if !active {
		return unknown, fmt.Errorf("paired recovery has not authorized previous-host startup")
	}
	receipt, err := cm.ReadReceipt()
	if err != nil || !reflect.DeepEqual(receipt, j.Previous) {
		return unknown, fmt.Errorf("installed core receipt advanced; historical host recovery refused")
	}
	host, err := loadJournal(m.config.JournalPath)
	if err != nil || host.CoreManifestSHA256 != j.ManifestSHA256 || host.Phase == PhaseHealthy {
		return unknown, fmt.Errorf("host recovery identity changed or already committed")
	}
	current, state, slot, err := m.current()
	if err != nil {
		return unknown, err
	}
	if state.Slots.Current != host.ActiveSlot || state.Slots.CurrentImageVersion != host.CurrentImage {
		return unknown, fmt.Errorf("current slot was promoted; reconcile commitment instead of recovery")
	}
	if state.Transaction == (appliance.TransactionState{}) {
		if state.Slots.Candidate != "" || state.Slots.CandidateImageVersion != "" {
			return unknown, fmt.Errorf("unowned candidate cannot be recovered")
		}
	} else if state.Transaction.ID != host.TransactionID || state.Transaction.ManifestSHA256 != host.ManifestSHA256 || state.Slots.Candidate != host.CandidateSlot || state.Slots.CandidateImageVersion != host.TargetImage {
		return unknown, fmt.Errorf("another native transaction owns recovery state")
	}
	previousBoot := slot == host.ActiveSlot && current.ImageVersion == host.CurrentImage
	targetBoot := slot == host.CandidateSlot && current.ImageVersion == host.TargetImage
	if targetBoot && state.Transaction == (appliance.TransactionState{}) {
		return unknown, fmt.Errorf("running candidate lacks its native transaction")
	}
	if !previousBoot && !targetBoot {
		return unknown, fmt.Errorf("running host matches neither retained side of recovery")
	}
	if previousBoot {
		if err = BindCoreImage(j.Previous.Release, current); err != nil {
			return unknown, err
		}
	} else if err = BindCoreImage(j.Target, current); err != nil {
		return unknown, err
	}
	path := filepath.Join(cm.Root, "host-recovery", fmt.Sprintf("%x.json", sha256.Sum256([]byte(request))))
	record := coreHostRecovery{Schema: "youeye.core-host-recovery.v1", RequestID: request, ManifestSHA256: j.ManifestSHA256, PreviousSHA256: j.Previous.ManifestSHA256, ActiveSlot: host.ActiveSlot, CandidateSlot: host.CandidateSlot, State: "prepared"}
	raw, err := ReadCoreState(path, 16384)
	if err == nil {
		var old coreHostRecovery
		if json.Unmarshal(raw, &old) != nil {
			return unknown, fmt.Errorf("invalid retained host recovery receipt")
		}
		expected := record
		expected.State = old.State
		if expected != old || (old.State != "prepared" && old.State != "reboot-requested" && old.State != "complete") {
			return unknown, fmt.Errorf("host recovery receipt identity changed")
		}
		record = old
	} else if !errors.Is(err, os.ErrNotExist) {
		return unknown, err
	} else if observeOnly {
		return unknown, nil
	}
	save := func(phase string) error {
		record.State = phase
		raw, err := json.Marshal(record)
		if err != nil {
			return err
		}
		return atomicWrite(path, raw, 0600)
	}
	if err != nil {
		if err = save("prepared"); err != nil {
			return unknown, err
		}
	}
	if !previousBoot {
		if observeOnly || record.State == "reboot-requested" {
			return unknown, nil
		}
		if record.State != "prepared" {
			return unknown, fmt.Errorf("completed host recovery no longer matches running boot")
		}
		if err = save("reboot-requested"); err != nil {
			return unknown, err
		}
		for _, args := range [][]string{{"set-default", stableEntryID(host.ActiveSlot)}, {"set-oneshot", stableEntryID(host.ActiveSlot)}} {
			if _, err = m.config.Run(ctx, "bootctl", args...); err != nil {
				return unknown, fmt.Errorf("previous boot selection acknowledgement unavailable; inspect retained recovery")
			}
		}
		if _, err = m.config.Run(ctx, "systemctl", "--no-block", "reboot"); err != nil {
			return unknown, fmt.Errorf("recovery reboot acknowledgement unavailable; observe the same request")
		}
		return unknown, nil
	}
	if record.State == "complete" {
		if host.Phase != PhaseRollback || state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
			return unknown, fmt.Errorf("completed host recovery lacks its native postconditions")
		}
		return coreActionPassed("actual previous immutable host and durable recovery receipt verified", nil)
	}
	// Actual previous boot is positive evidence. These exact boot/state cleanup
	// operations are idempotent; no database restoration or reboot is repeated.
	layout, err := m.config.DiscoverLayout(slot)
	if err != nil {
		return unknown, err
	}
	if err = validateLayoutAgainstState(layout, state); err != nil {
		return unknown, err
	}
	if layout.InactiveSlot != host.CandidateSlot {
		return unknown, fmt.Errorf("recovery inactive slot changed")
	}
	if _, err = m.config.Run(ctx, "bootctl", "set-default", stableEntryID(host.ActiveSlot)); err != nil {
		return unknown, fmt.Errorf("previous known-good boot default unavailable")
	}
	if _, err = m.config.Run(ctx, "bootctl", "set-oneshot", ""); err != nil {
		return unknown, fmt.Errorf("trial one-shot clearing requires reconciliation")
	}
	if err = m.callRemoveBootEntries(layout); err != nil {
		return unknown, err
	}
	state.Slots.Candidate = ""
	state.Slots.CandidateImageVersion = ""
	state.Transaction = appliance.TransactionState{}
	if err = appliance.WriteStateAtomic(m.config.StatePath, state); err != nil {
		return unknown, err
	}
	host.Phase = PhaseRollback
	host.ErrorCode = "core_paired_recovery"
	host.Error = "previous host resumed after paired core recovery"
	host.UpdatedAt = m.now()
	if err = writeJournal(m.config.JournalPath, host); err != nil {
		return unknown, err
	}
	if err = save("complete"); err != nil {
		return unknown, err
	}
	return coreActionPassed("actual previous immutable host resumed and failed candidate boot selection cleared", nil)
}
