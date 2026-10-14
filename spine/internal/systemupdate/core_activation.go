package systemupdate

import (
	"context"
	"fmt"
)

// RequestActivation durably records the owner's restart action without coupling
// native work to the request transport. It cannot arm an incompletely staged
// host. The detached coordinator rechecks policy before checkpoint capture.
func (m CoreManager) RequestActivation(ctx context.Context, request, digest string) (CoreJournal, error) {
	if m.Executor == nil {
		return CoreJournal{}, fmt.Errorf("native lifecycle executor required")
	}
	unlock, err := m.lockCore()
	if err != nil {
		return CoreJournal{}, err
	}
	defer unlock()
	j, err := m.Read()
	if err != nil {
		return j, err
	}
	if j.RequestID != request || j.ManifestSHA256 != digest || !j.RestartRequired || len(j.RecoverySteps) != 0 {
		return j, fmt.Errorf("exact staged host request required")
	}
	if j.Phase == "cancelled" || j.Phase == "rolled-back" || j.Phase == "needs-recovery" {
		return j, fmt.Errorf("host request no longer admits activation")
	}
	if j.ActivationRequested {
		return j, nil
	}
	if j.Phase != "awaiting-restart" {
		return j, fmt.Errorf("host staging has not completed")
	}
	for _, step := range j.Steps {
		if (step.Name == "verify-members" || step.Name == "stage-host") && step.State != "succeeded" {
			return j, fmt.Errorf("verified complete host stage required")
		}
	}
	if err = m.Executor.Authorize(ctx, j, true); err != nil {
		return j, err
	}
	j.ActivationRequested, j.Phase = true, "applying"
	return j, m.saveCore(&j)
}
