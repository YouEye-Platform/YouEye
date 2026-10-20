package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
)

var (
	errCoreRecoveryServices = errors.New("recovered service verification unavailable")
	errCoreRecoveryPower    = errors.New("recovered platform power verification unavailable")
	errCoreRecoveryHealth   = errors.New("recovered authenticated health unavailable")
)

// ContinueRecoveryHealth is reachable only through explicit Recover. Keep the
// original native launch/result immutable; subordinate intents decide which
// operations may begin, and attempted operations can only be observed.
func (e NativeCoreExecutor) ContinueRecoveryHealth(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	if e.ContinueRecoveryHealthAction == nil {
		return e.Observe(ctx, j, s)
	}
	unknown := CoreActionObservation{State: "unknown", Stage: "execute", EffectState: "started", Evidence: "recovery health remains incomplete; retain the same request and checkpoints"}
	if err := validateRecoveryHealthContinuation(j, s); err != nil {
		return unknown, err
	}
	unlock, err := e.lockAction(s)
	if err != nil {
		return unknown, err
	}
	defer unlock()
	a, err := e.read(j, s)
	if err != nil {
		return unknown, err
	}
	if a.Result.State == "succeeded" || a.Result.State == "failed" {
		return a.Result, nil
	}
	if a.Active {
		if identity, err := nativeProcessIdentity(a.PID); err == nil && identity == a.ProcessIdentity {
			return CoreActionObservation{State: "running", Evidence: "owned recovery executor remains active"}, nil
		}
	}
	if err := e.AuthorizeRecovery(ctx, j); err != nil {
		return unknown, err
	}
	identity, err := nativeProcessIdentity(os.Getpid())
	if err != nil {
		return unknown, err
	}
	a.PID, a.ProcessIdentity, a.Active = os.Getpid(), identity, true
	a.Result = CoreActionObservation{State: "running", Stage: "execute", EffectState: "started", Evidence: "explicit recovery health continuation owns the pending substeps"}
	if err := e.save(s, a); err != nil {
		return unknown, err
	}
	result, effectErr := e.ContinueRecoveryHealthAction(ctx, j, s)
	a.Active = false
	if effectErr != nil || validateNativeResult(result) != nil {
		result = unknown
		result.Code = coreNativeFailureCode(effectErr)
	}
	a.Result = result
	if err := e.save(s, a); err != nil {
		return unknown, err
	}
	return result, effectErr
}

func validateRecoveryHealthContinuation(j CoreJournal, s CoreStep) error {
	if err := validateNativeIdentity(j, s); err != nil {
		return err
	}
	if j.Phase != "recovering" || s.Name != "recovery-health" || s.State != "started" || len(j.RecoverySteps) == 0 || j.RecoverySteps[len(j.RecoverySteps)-1] != s {
		return fmt.Errorf("exact started recovery health continuation required")
	}
	for _, previous := range j.RecoverySteps[:len(j.RecoverySteps)-1] {
		if previous.State != "succeeded" || previous.Evidence == "" {
			return fmt.Errorf("recovery predecessors have not completed")
		}
	}
	return nil
}

func (r NativeCoreRuntime) continueRecoveryHealth(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	if err := r.Validate(); err != nil {
		return CoreActionObservation{}, err
	}
	current, err := (CoreManager{Root: r.Root}).Read()
	if err != nil || !reflect.DeepEqual(current, j) {
		return CoreActionObservation{}, fmt.Errorf("recovery continuation coordinator changed")
	}
	if err := validateRecoveryHealthContinuation(current, s); err != nil {
		return CoreActionObservation{}, err
	}
	observation, err := r.Runner.Observe(ctx, current, s)
	if err != nil || observation.State != "unknown" {
		return observation, err
	}
	// The outer action lease is held by NativeCoreExecutor. Hold both original
	// runner leases until health finishes; no second child launch is permitted.
	unlock, err := r.Runner.lockSettledRecoveryHealth(ctx, current, s)
	if err != nil {
		return CoreActionObservation{}, err
	}
	defer unlock()
	if err := r.authorizeRecovery(ctx, current); err != nil {
		return CoreActionObservation{}, err
	}
	if err := r.Checkpoint.requireProviderSettled(ctx); err != nil {
		return CoreActionObservation{}, err
	}
	// RecoverServices and PrepareHealth each recheck exact machine, checkpoint,
	// reservation and held container identities. Their durable per-start records
	// allow only never-attempted starts; no migration or restore is invoked here.
	return r.execute(ctx, current, s)
}

// This proves settlement without stopping any process or changing its receipt.
// A live/unknown unit or descendant is not permission to continue.
func (r CoreSystemdRunner) lockSettledRecoveryHealth(ctx context.Context, j CoreJournal, s CoreStep) (func(), error) {
	if err := validateRecoveryHealthContinuation(j, s); err != nil {
		return nil, err
	}
	launchUnlock, err := lockCoreRunner(r.path(j, s) + ".lock")
	if err != nil {
		return nil, err
	}
	childUnlock, err := lockCoreRunner(r.path(j, s) + ".child-lock")
	if err != nil {
		launchUnlock()
		return nil, err
	}
	unlock := func() { childUnlock(); launchUnlock() }
	settled := false
	defer func() {
		if !settled {
			unlock()
		}
	}()
	launch, err := r.read(j, s)
	if err != nil {
		return nil, err
	}
	result, err := r.readResult(j, s, launch)
	if err != nil {
		return nil, err // missing child evidence cannot authorize continuation
	}
	unit, err := r.observeUnit(ctx, launch)
	if err != nil {
		return nil, err
	}
	if unit["LoadState"] != "not-found" {
		boot, err := r.boot()
		if err != nil || boot != launch.BootID || unit["InvocationID"] != result.InvocationID || (unit["ActiveState"] != "inactive" && unit["ActiveState"] != "failed") || unit["MainPID"] != "0" {
			return nil, fmt.Errorf("original recovery child has not settled under its exact invocation")
		}
		if group := unit["ControlGroup"]; group != "" && group != "/system.slice/"+launch.Unit {
			return nil, fmt.Errorf("recovery child control group changed")
		}
	}
	if err := r.requireEmptyCgroup(launch.Unit, true); err != nil {
		return nil, err
	}
	settled = true
	return unlock, nil
}
