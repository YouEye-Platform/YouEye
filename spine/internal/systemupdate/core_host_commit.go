package systemupdate

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const coreBootBlessExecutable = "/usr/lib/systemd/systemd-bless-boot"

// CommitCoreHost performs the real boot blessing and durable slot promotion.
// Reconciliation may finish a positively blessed boot after an acknowledgement
// was lost; it never blesses an indeterminate boot from an observation call.
func (m *Manager) CommitCoreHost(ctx context.Context, request string, observeOnly bool) (CoreActionObservation, error) {
	unknown := CoreActionObservation{State: "unknown"}
	unlock, err := m.lock()
	if err != nil {
		return unknown, err
	}
	defer unlock()
	j, err := (CoreManager{Root: m.config.CoreStatePath}).Read()
	if err != nil || j.RequestID != request {
		return unknown, fmt.Errorf("exact core host commitment request required")
	}
	host, err := loadJournal(m.config.JournalPath)
	if err != nil || host.CoreManifestSHA256 != j.ManifestSHA256 {
		return unknown, fmt.Errorf("host commitment belongs to another selection")
	}
	if err = m.requireCoreHostStep(host, "commit-host"); err != nil {
		return unknown, err
	}
	current, state, slot, err := m.current()
	if err != nil {
		return unknown, err
	}
	if slot != host.CandidateSlot || current.ImageVersion != host.TargetImage {
		return unknown, fmt.Errorf("selected host is not actually running")
	}
	if err = BindCoreImage(j.Target, current); err != nil {
		return unknown, err
	}
	if host.Phase == PhaseHealthy {
		if state.Slots.Current != slot || state.Slots.CurrentImageVersion != current.ImageVersion || state.Transaction != (appliance.TransactionState{}) {
			return unknown, fmt.Errorf("healthy host lacks durable slot commitment")
		}
		return coreActionPassed("selected host blessing and durable slot commitment read back", nil)
	}
	if host.Phase != PhaseTrial && host.Phase != PhasePending {
		return unknown, fmt.Errorf("host is not awaiting a healthy trial commitment")
	}
	if _, err = m.loadTransactionManifest(host); err != nil {
		return unknown, err
	}
	readBoot := func() (string, error) {
		raw, err := m.config.Run(ctx, coreBootBlessExecutable, "status")
		if err != nil {
			return "", fmt.Errorf("native boot blessing status unavailable")
		}
		value := strings.TrimSpace(string(raw))
		switch value {
		case "clean", "good", "indeterminate", "bad", "dirty":
			return value, nil
		}
		return "", fmt.Errorf("native boot blessing state is unknown")
	}
	boot, err := readBoot()
	if err != nil {
		return unknown, err
	}
	if boot == "indeterminate" {
		if observeOnly {
			return unknown, nil
		}
		if _, err = m.config.Run(ctx, coreBootBlessExecutable, "good"); err != nil {
			return unknown, fmt.Errorf("boot blessing acknowledgement unavailable; reconcile actual boot state")
		}
		boot, err = readBoot()
		if err != nil {
			return unknown, err
		}
	}
	if boot != "good" && boot != "clean" {
		return unknown, fmt.Errorf("selected boot has not been positively accepted")
	}
	cmdline, err := os.ReadFile(m.config.KernelCmdlinePath)
	if err != nil {
		return unknown, err
	}
	if _, err = appliance.CommitHealthySlot(m.config.StatePath, current, string(cmdline)); err != nil {
		return unknown, err
	}
	status, err := m.markHealthy(ctx)
	if err != nil {
		return unknown, err
	}
	if status.State != PhaseHealthy {
		return unknown, fmt.Errorf("host commitment has no healthy durable receipt")
	}
	return coreActionPassed("selected counted boot blessed, slot promoted and signed healthy proof retained", nil)
}
