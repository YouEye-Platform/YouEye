package systemupdate

import (
	"context"
	"fmt"
	"reflect"
)

// Recovery authorizes the retained previous release and current machine/policy,
// independently of the failed target's authority. A revoked target must not
// prevent safe recovery, or silently restore an obsolete trust policy.
type CoreRecoveryExecutor interface {
	AuthorizeRecovery(context.Context, CoreJournal) error
}

// A native executor may admit explicit recovery of a live action only after
// verifying its exact owned service. The recovery fence must still stop that
// service and settle descendants/provider effects before any restoration.
type CoreLiveRecoveryExecutor interface {
	AuthorizeLiveFence(context.Context, CoreJournal, CoreStep) error
}

func coreRecoveryNames(j CoreJournal) []string {
	names := []string{"recovery-fence", "recovery-paired-restore"}
	if j.RestartRequired {
		names = append(names, "recovery-host")
	}
	return append(names, "recovery-health")
}

func validateCoreRecovery(j CoreJournal) error {
	if len(j.RecoverySteps) == 0 {
		if j.Phase == "recovering" || j.Phase == "rolled-back" {
			return fmt.Errorf("core recovery has no retained graph")
		}
		return nil
	}
	if j.Phase != "recovering" && j.Phase != "needs-recovery" && j.Phase != "rolled-back" {
		return fmt.Errorf("core recovery conflicts with apply phase")
	}
	names := coreRecoveryNames(j)
	if len(j.RecoverySteps) != len(names) {
		return fmt.Errorf("core recovery graph changed")
	}
	unfinished := false
	for i, s := range j.RecoverySteps {
		if s.Name != names[i] || s.RequestID != j.RequestID+"/"+names[i] {
			return fmt.Errorf("core recovery identity differs")
		}
		if unfinished && s.State != "pending" {
			return fmt.Errorf("core recovery advanced before its dependency")
		}
		switch s.State {
		case "succeeded":
			if s.Evidence == "" {
				return fmt.Errorf("core recovery lacks evidence")
			}
		case "pending", "started", "failed":
			unfinished = true
		default:
			return fmt.Errorf("invalid core recovery state")
		}
	}
	if j.Phase == "rolled-back" && unfinished {
		return fmt.Errorf("core rollback has unfinished recovery")
	}
	return nil
}

// Recover records one immutable rollback graph. The fence action must establish
// that all writers/native children are stopped before paired restoration; a
// missing PID is insufficient. Running apply actions are observed, never killed
// by this coordinator. Unknown outcomes remain owned until the native fence
// proves exclusion. Restoration and health each require durable native evidence.
// Ingress and lifecycle holds remain until the rolled-back receipt is read back.
func (m CoreManager) Recover(ctx context.Context, requestID string) (CoreJournal, error) {
	recovery, ok := m.Executor.(CoreRecoveryExecutor)
	if !ok {
		return CoreJournal{}, fmt.Errorf("native paired recovery executor required")
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
	if j.RequestID != requestID {
		return j, fmt.Errorf("exact core recovery request required")
	}
	if j.Phase == "committed" || j.Phase == "cancelled" || j.Phase == "cancelling" {
		return j, fmt.Errorf("completed core request cannot roll back")
	}
	current, err := m.ReadReceipt()
	if err != nil {
		return j, err
	}
	// A commit may be durable even if journal acknowledgement was lost. Never
	// turn that successful update into an unrequested historical data restore.
	if !reflect.DeepEqual(current, j.Previous) {
		return j, fmt.Errorf("installed receipt advanced; reconcile commitment instead of rollback")
	}
	for _, step := range j.Steps {
		if step.Name == "commit-host" && step.State == "succeeded" {
			return j, fmt.Errorf("host commitment completed; reconcile the shared receipt instead of rollback")
		}
	}
	if j.Phase == "rolled-back" {
		return j, nil
	}
	if err := recovery.AuthorizeRecovery(ctx, j); err != nil {
		return j, err
	}
	if len(j.RecoverySteps) == 0 {
		checkpointStarted := false
		for _, s := range j.Steps {
			if s.Name == "checkpoint" && s.State != "pending" {
				checkpointStarted = true
			}
		}
		if !checkpointStarted {
			return j, fmt.Errorf("no activation checkpoint exists; use staged cancellation")
		}
		// Persist the authorized recovery intent before reconciling interrupted
		// apply work. Otherwise an applying journal still invokes forward schema
		// probes, which cannot complete a partially staged service. This admits
		// no restore: exact live-child ownership and the native fence remain below.
		if j.Phase != "needs-recovery" {
			j.Phase = "needs-recovery"
			if err := m.saveCore(&j); err != nil {
				return j, err
			}
		}
		for _, s := range j.Steps {
			if s.State == "started" {
				observation, err := m.Executor.Observe(ctx, j, s)
				if err != nil {
					return j, err
				}
				if observation.State == "running" {
					fencer, ok := m.Executor.(CoreLiveRecoveryExecutor)
					if !ok {
						return j, fmt.Errorf("native apply action is still running; reconcile before recovery")
					}
					if err := fencer.AuthorizeLiveFence(ctx, j, s); err != nil {
						return j, err
					}
				}
			}
		}
		for _, name := range coreRecoveryNames(j) {
			j.RecoverySteps = append(j.RecoverySteps, CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"})
		}
		j.Phase = "recovering"
		if err := m.saveCore(&j); err != nil {
			return j, err
		}
	}
	if j.Phase == "needs-recovery" {
		j.Phase = "recovering"
		if err = m.saveCore(&j); err != nil {
			return j, err
		}
	}
	for i := range j.RecoverySteps {
		s := &j.RecoverySteps[i]
		if s.State == "succeeded" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return j, err
		}
		if err := recovery.AuthorizeRecovery(ctx, j); err != nil {
			return j, err
		}
		observation := CoreActionObservation{State: "absent"}
		if s.State != "pending" {
			observation, err = m.Executor.Observe(ctx, j, *s)
			if err != nil {
				return j, err
			}
		}
		if observation.State == "absent" {
			if s.State != "pending" {
				return j, fmt.Errorf("uncertain recovery effect cannot be replayed")
			}
			s.State, j.Phase, j.Error = "started", "recovering", ""
			if err := m.saveCore(&j); err != nil {
				return j, err
			}
			observation, err = m.Executor.Start(ctx, j, *s)
			if err != nil {
				j.Error = "Recovery acknowledgement unavailable; reconcile the same request"
				_ = m.saveCore(&j)
				return j, err
			}
		}
		switch observation.State {
		case "succeeded":
			if observation.Evidence == "" {
				return j, fmt.Errorf("recovery action has no evidence")
			}
			s.State, s.Evidence = "succeeded", observation.Evidence
			if err := m.saveCore(&j); err != nil {
				return j, err
			}
		case "failed":
			s.State, s.Evidence, j.Phase = "failed", observation.Evidence, "needs-recovery"
			j.Error = "Paired recovery requires repair; retain checkpoints and lifecycle hold"
			return j, m.saveCore(&j)
		case "running", "unknown":
			j.Phase = "recovering"
			return j, m.saveCore(&j)
		default:
			return j, fmt.Errorf("invalid native recovery observation")
		}
	}
	if err := recovery.AuthorizeRecovery(ctx, j); err != nil {
		return j, err
	}
	current, err = m.ReadReceipt()
	if err != nil {
		return j, err
	}
	if !reflect.DeepEqual(current, j.Previous) {
		return j, fmt.Errorf("installed receipt changed during recovery")
	}
	j.Phase, j.Error = "rolled-back", ""
	return j, m.saveCore(&j)
}
