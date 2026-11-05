package systemupdate

import "fmt"

// RecordAttention labels an uncertain active action without inventing failure
// or clearing its start intent. Explicit resume can still reconcile positive
// subordinate evidence; recovery still requires the independent native fence.
func (m CoreManager) RecordAttention(request, digest, step string) (CoreJournal, error) {
	unlock, err := m.lockCore()
	if err != nil {
		return CoreJournal{}, err
	}
	defer unlock()
	j, err := m.Read()
	if err != nil {
		return j, err
	}
	if j.RequestID != request || j.ManifestSHA256 != digest {
		return j, fmt.Errorf("attention request changed")
	}
	if j.Phase == "committed" || j.Phase == "rolled-back" || j.Phase == "cancelled" || j.Phase == "cancelling" {
		return j, nil
	}
	graph := j.Steps
	if len(j.RecoverySteps) > 0 {
		graph = j.RecoverySteps
	}
	for _, s := range graph {
		if s.Name == step && s.State == "started" {
			j.Phase = "needs-recovery"
			j.Error = "Native action outcome is uncertain; resume its retained checks or use verified recovery"
			return j, m.saveCore(&j)
		}
	}
	return j, fmt.Errorf("active action changed before attention recording")
}
