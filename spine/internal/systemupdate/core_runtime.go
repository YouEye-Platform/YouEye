package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

// NativeCoreRuntime binds the durable coordinator to the actual appliance
// lifecycle. Policy and health are supplied by the appliance command layer;
// none may be omitted. There is no success fallback for an unwired capability.
type NativeCoreRuntime struct {
	Root                string
	Host                *Manager
	Cache               CoreArtifactCache
	Services            NativeCoreServices
	Checkpoint          NativeCoreCheckpoint
	Runner              CoreSystemdRunner
	AuthorizeTarget     func(context.Context, CoreJournal, bool) error
	AuthorizePrevious   func(context.Context, CoreJournal) error
	HostHealth          func(context.Context, CoreJournal) (string, error)
	AuthenticatedHealth func(context.Context, CoreJournal, bool) (string, error)
	RecoverHost         func(context.Context, CoreJournal, bool) (CoreActionObservation, error)
}

func (r NativeCoreRuntime) Validate() error {
	if !filepath.IsAbs(r.Root) || r.Host == nil || r.Host.config.CoreStatePath != r.Root || r.Checkpoint.Root != r.Root || r.Services.Checkpoint.Root != r.Root || r.Runner.Root != r.Root || r.Services.Cache.Root != r.Cache.Root || !filepath.IsAbs(r.Cache.Root) || !filepath.IsAbs(r.Checkpoint.DataRoot) || r.AuthorizeTarget == nil || r.AuthorizePrevious == nil || r.HostHealth == nil || r.AuthenticatedHealth == nil || r.RecoverHost == nil {
		return fmt.Errorf("complete native core policy, lifecycle and health implementation required")
	}
	cacheRelative, err := filepath.Rel(r.Checkpoint.DataRoot, r.Cache.Root)
	if err != nil || cacheRelative == "." || cacheRelative == ".." || strings.HasPrefix(cacheRelative, ".."+string(filepath.Separator)) || r.Checkpoint.StatePath != r.Host.config.StatePath || r.Services.Checkpoint.DataRoot != r.Checkpoint.DataRoot || r.Services.Checkpoint.StatePath != r.Checkpoint.StatePath || r.Services.Cache.TrustKeyPath != r.Cache.TrustKeyPath {
		return fmt.Errorf("core services must share exact installed state and Data-backed cache")
	}
	return nil
}

func (r NativeCoreRuntime) Executor() NativeCoreExecutor {
	return NativeCoreExecutor{Root: r.Root,
		AuthorizeAction: func(ctx context.Context, j CoreJournal, activation bool) error {
			if err := r.Validate(); err != nil {
				return err
			}
			return r.AuthorizeTarget(ctx, j, activation)
		},
		AuthorizeRecoveryAction: func(ctx context.Context, j CoreJournal) error {
			if err := r.Validate(); err != nil {
				return err
			}
			return r.authorizeRecovery(ctx, j)
		},
		AuthorizeLiveFenceAction:     r.Runner.AuthorizeLiveFence,
		ContinueRecoveryHealthAction: r.continueRecoveryHealth,
		AdmitAction: func(ctx context.Context, j CoreJournal, s CoreStep) error {
			barrier := CoreLifecycleBarrier{Root: filepath.Join(r.Checkpoint.DataRoot, "state", "app-updates")}
			return barrier.BeginContext(ctx, j, func(ctx context.Context) error {
				current, err := (CoreManager{Root: r.Root}).Read()
				if err != nil || current.RequestID != j.RequestID || current.ManifestSHA256 != j.ManifestSHA256 || current.Phase != j.Phase {
					return fmt.Errorf("native admission coordinator changed")
				}
				if s.Name == "recovery-fence" {
					return r.authorizeRecovery(ctx, current)
				}
				// Start intent is already durable, but no child has launched.
				// Recheck selection freshness using the pre-checkpoint policy
				// view; never rewrite the actual graph or bypass current trust.
				current.Steps = append([]CoreStep(nil), current.Steps...)
				for i := range current.Steps {
					if current.Steps[i].Name == "checkpoint" {
						current.Steps[i].State, current.Steps[i].Evidence = "pending", ""
					}
				}
				return r.AuthorizeTarget(ctx, current, current.ActivationRequested)
			})
		},
		CancelPreparationAction: func(ctx context.Context, j CoreJournal) error {
			if err := r.Validate(); err != nil {
				return err
			}
			if err := r.AuthorizePrevious(ctx, j); err != nil {
				return err
			}
			if err := r.Runner.SettlePreparationChildren(ctx, j.RequestID); err != nil {
				return err
			}
			for _, step := range j.Steps {
				if step.Name == "stage-host" && step.State != "pending" {
					return r.Host.CancelCoreHost(ctx, j.RequestID)
				}
			}
			return nil
		},
		ExecuteAction: r.Runner.Start, ReconcileAction: r.Observe,
	}
}

func (r NativeCoreRuntime) RunAction(ctx context.Context, request, name, digest string) (CoreActionObservation, error) {
	if err := r.Validate(); err != nil {
		return CoreActionObservation{}, err
	}
	return r.Runner.RunAction(ctx, request, name, digest, func(ctx context.Context, j CoreJournal, s CoreStep) error {
		if strings.HasPrefix(s.Name, "recovery-") {
			return r.authorizeRecovery(ctx, j)
		}
		return r.AuthorizeTarget(ctx, j, j.ActivationRequested)
	}, r.execute)
}

func coreActionPassed(evidence string, err error) (CoreActionObservation, error) {
	if err != nil {
		return CoreActionObservation{State: "unknown"}, err
	}
	if evidence == "" {
		return CoreActionObservation{State: "unknown"}, fmt.Errorf("native action lacks acceptance evidence")
	}
	return CoreActionObservation{State: "succeeded", Evidence: evidence}, nil
}

func (r NativeCoreRuntime) execute(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	m := CoreManager{Root: r.Root}
	switch s.Name {
	case "verify-members":
		selection, _, err := m.Selection(j.ManifestSHA256, r.Cache.TrustKeyPath)
		if err != nil {
			return CoreActionObservation{}, err
		}
		_, digest, err := r.Cache.StageUpdate(ctx, selection, j.Previous.Release)
		if err != nil || digest != j.ManifestSHA256 {
			return CoreActionObservation{}, fmt.Errorf("complete selected members did not verify")
		}
		current, _, _, err := r.Host.current()
		if err != nil {
			return CoreActionObservation{}, err
		}
		if err = BindCoreImage(j.Previous.Release, current); err != nil {
			return CoreActionObservation{}, err
		}
		for _, role := range []string{"cp", "ui"} {
			index, err := r.Cache.IndexSelected(m, j, role)
			if err != nil {
				return CoreActionObservation{}, err
			}
			if err = m.SavePayloadIndex(index); err != nil {
				return CoreActionObservation{}, err
			}
			old, err := coreServiceMember(j.Previous.Release, role)
			if err != nil {
				return CoreActionObservation{}, err
			}
			index, err = m.LoadPayloadIndex(old.Artifact.SHA256)
			if err != nil {
				return CoreActionObservation{}, err
			}
			name, appDir := "youeye-control", r.Services.CPAppDir
			if role == "ui" {
				name, appDir = "youeye-ui", r.Services.UIAppDir
			}
			if err = VerifyCoreContainerPayload(ctx, name, appDir, index); err != nil {
				if failed, known := corePayloadVerificationFailure(role, err); known {
					return failed, nil
				}
				return CoreActionObservation{}, err
			}
		}
		return coreActionPassed("complete scoped membership/cache and previous running host/static payloads verified", nil)
	case "stage-host":
		selection, _, err := m.Selection(j.ManifestSHA256, r.Cache.TrustKeyPath)
		if err != nil {
			return CoreActionObservation{}, err
		}
		options, err := r.Host.CoreHostOptions(selection)
		if err != nil {
			return CoreActionObservation{}, err
		}
		status, err := r.Host.Stage(ctx, options)
		if err != nil || status.State != PhaseStaged {
			return CoreActionObservation{}, fmt.Errorf("selected host stage has no complete receipt")
		}
		return coreActionPassed("inactive host and boot artifacts staged under exact core membership", nil)
	case "checkpoint":
		barrier := CoreLifecycleBarrier{Root: filepath.Join(r.Checkpoint.DataRoot, "state", "app-updates")}
		if err := barrier.Begin(j); err != nil {
			return CoreActionObservation{}, err
		}
		if _, _, err := r.Services.PreflightCheckpoint(ctx, j.RequestID); err != nil {
			return CoreActionObservation{}, err
		}
		record, err := r.Checkpoint.Quiesce(ctx, j)
		if err != nil {
			return CoreActionObservation{}, err
		}
		indexes := []CorePayloadIndex{}
		for _, role := range []string{"cp", "ui"} {
			index, err := r.Cache.IndexSelected(m, j, role)
			if err != nil {
				return CoreActionObservation{}, err
			}
			indexes = append(indexes, index)
		}
		if _, err = r.Checkpoint.CheckCompleteCapacity(ctx, record.Inventory, indexes); err != nil {
			return CoreActionObservation{}, err
		}
		if _, err = r.Checkpoint.capturePayloadRoots(ctx, j, indexes); err != nil {
			return CoreActionObservation{}, err
		}
		if _, err = r.Checkpoint.CaptureFiles(ctx, j); err != nil {
			return CoreActionObservation{}, err
		}
		if _, err = r.Checkpoint.CaptureDatabases(ctx, j); err != nil {
			return CoreActionObservation{}, err
		}
		return coreActionPassed("paired root/file snapshots and protected SQL archives captured after writer closure", nil)
	case "activate-host":
		status, err := r.Host.Activate(ctx, false)
		if err != nil || status.State != PhasePending {
			return CoreActionObservation{}, fmt.Errorf("host activation has no exact pending receipt")
		}
		// The runner's child intent is already durable. A reboot may prevent a
		// terminal acknowledgement; Observe accepts only actual selected boot.
		if _, err = r.Runner.capture(ctx, "systemctl", "reboot"); err != nil {
			return CoreActionObservation{}, err
		}
		return CoreActionObservation{State: "unknown", Evidence: "counted host boot requested; awaiting actual boot observation"}, nil
	case "host-health":
		return coreActionPassed(r.HostHealth(ctx, j))
	case "apply-cp", "apply-ui":
		role := strings.TrimPrefix(s.Name, "apply-")
		if err := r.Services.StartHeldContainer(ctx, j.RequestID, role); err != nil {
			return CoreActionObservation{}, err
		}
		if _, err := r.Services.Stage(ctx, j.RequestID, role); err != nil {
			return CoreActionObservation{}, err
		}
		if _, err := r.Services.Start(ctx, j.RequestID, role); err != nil {
			return CoreActionObservation{}, err
		}
		return r.waitSchema(ctx, j, role)
	case "authenticated-health":
		if err := r.Checkpoint.PrepareHealth(ctx, j.RequestID, false, false); err != nil {
			return CoreActionObservation{}, err
		}
		return coreActionPassed(r.AuthenticatedHealth(ctx, j, false))
	case "commit-host":
		return r.Host.CommitCoreHost(ctx, j.RequestID, false)
	case "recovery-fence":
		return coreActionPassed(r.Checkpoint.Fence(ctx, j.RequestID, r.Runner))
	case "recovery-paired-restore":
		if coreCheckpointUnapplied(j) {
			_, err := r.Checkpoint.AbortCheckpoint(ctx, j.RequestID)
			return coreActionPassed("activation never started; current data preserved and incomplete checkpoint aborted", err)
		}
		if _, err := r.Checkpoint.RestoreDatabases(ctx, j); err != nil {
			return CoreActionObservation{}, err
		}
		if _, err := r.Checkpoint.RestoreFiles(ctx, j); err != nil {
			return CoreActionObservation{}, err
		}
		if _, err := r.Checkpoint.RestoreRoots(ctx, j); err != nil {
			return CoreActionObservation{}, err
		}
		return coreActionPassed("paired databases, portable files and core roots restored with current authority preserved", nil)
	case "recovery-host":
		return r.RecoverHost(ctx, j, false)
	case "recovery-health":
		if _, err := r.Services.RecoverServices(ctx, j.RequestID, false); err != nil {
			return CoreActionObservation{}, errors.Join(errCoreRecoveryServices, err)
		}
		if err := r.Checkpoint.PrepareHealth(ctx, j.RequestID, true, false); err != nil {
			return CoreActionObservation{}, errors.Join(errCoreRecoveryPower, err)
		}
		evidence, err := r.AuthenticatedHealth(ctx, j, true)
		if err != nil {
			return CoreActionObservation{}, errors.Join(errCoreRecoveryHealth, err)
		}
		return coreActionPassed(evidence, nil)
	}
	return CoreActionObservation{}, fmt.Errorf("unsupported exact native action")
}

func (r NativeCoreRuntime) waitSchema(ctx context.Context, j CoreJournal, role string) (CoreActionObservation, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	// systemctl start proves process launch, not that HTTP is listening. Wait
	// only on positively classified GET readiness failures before the first
	// schema POST. Reauthorize and revalidate the full identity on every probe.
	observation, err := waitCoreSchemaReadiness(ctx, func(probe context.Context) (CoreActionObservation, error) {
		if err := r.AuthorizeTarget(probe, j, j.ActivationRequested); err != nil {
			return CoreActionObservation{State: "unknown"}, err
		}
		return r.Services.Schema(probe, j.RequestID, role, true)
	}, time.Second)
	if err != nil {
		return observation, err
	}
	for observation.State != "succeeded" && observation.State != "failed" {
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return CoreActionObservation{State: "unknown"}, ctx.Err()
		case <-timer.C:
		}
		// Polling never posts migrations again, including after a lost response.
		if err = r.AuthorizeTarget(ctx, j, j.ActivationRequested); err != nil {
			return CoreActionObservation{State: "unknown"}, err
		}
		observation, err = r.Services.Schema(ctx, j.RequestID, role, false)
		if err != nil {
			return observation, err
		}
	}
	return observation, nil
}

func waitCoreSchemaReadiness(ctx context.Context, probe func(context.Context) (CoreActionObservation, error), interval time.Duration) (CoreActionObservation, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	for {
		observation, err := probe(ctx)
		if !errors.Is(err, errCoreSchemaNotReady) {
			return observation, err
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return CoreActionObservation{State: "unknown"}, ctx.Err()
		case <-timer.C:
		}
	}
}

// Observe first reconciles the owned child. A lost child may be accepted only
// from exact subordinate completion evidence; it never invokes execute again.
func (r NativeCoreRuntime) Observe(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	if err := r.Validate(); err != nil {
		return CoreActionObservation{}, err
	}
	observation, err := r.Runner.Observe(ctx, j, s)
	if err != nil || observation.State != "unknown" {
		return observation, err
	}
	if (j.Phase == "needs-recovery" || j.Phase == "recovering") && !strings.HasPrefix(s.Name, "recovery-") {
		// An interrupted apply may have no service-stage receipt at all. Its
		// forward probes require applying and cannot authorize recovery. Keep
		// the outcome unknown until the native fence settles the owned action;
		// previous-release authority and the durable host-commit guard still
		// apply, even if the owner's current target selection has changed.
		return observation, r.authorizeRecovery(ctx, j)
	}
	if strings.HasPrefix(s.Name, "recovery-") {
		err = r.authorizeRecovery(ctx, j)
	} else {
		err = r.AuthorizeTarget(ctx, j, j.ActivationRequested)
	}
	if err != nil {
		return observation, err
	}
	switch s.Name {
	case "apply-cp", "apply-ui":
		return r.Services.Schema(ctx, j.RequestID, strings.TrimPrefix(s.Name, "apply-"), false)
	case "activate-host":
		result, err := r.Host.Reconcile(ctx, ReconcileOptions{})
		if err != nil {
			return observation, err
		}
		host, err := loadJournal(r.Host.config.JournalPath)
		if err != nil || host.CoreManifestSHA256 != j.ManifestSHA256 {
			return observation, fmt.Errorf("host activation belongs to another core selection")
		}
		if result.Status.State == PhaseRollback {
			return CoreActionObservation{State: "failed", Evidence: "selected host returned to previous slot before core commitment"}, nil
		}
		if result.Status.State != PhaseTrial {
			return observation, nil
		}
		current, _, _, err := r.Host.current()
		if err != nil {
			return observation, err
		}
		if err = BindCoreImage(j.Target, current); err != nil {
			return observation, err
		}
		return coreActionPassed("actual selected immutable host resumed in counted trial boot", nil)
	case "authenticated-health":
		if err = r.Checkpoint.PrepareHealth(ctx, j.RequestID, false, true); err != nil {
			return observation, err
		}
		return coreActionPassed(r.AuthenticatedHealth(ctx, j, false))
	case "recovery-health":
		if _, err = r.Services.RecoverServices(ctx, j.RequestID, true); err != nil {
			return observation, err
		}
		if err = r.Checkpoint.PrepareHealth(ctx, j.RequestID, true, true); err != nil {
			return observation, err
		}
		return coreActionPassed(r.AuthenticatedHealth(ctx, j, true))
	case "commit-host":
		return r.Host.CommitCoreHost(ctx, j.RequestID, true)
	case "recovery-host":
		return r.RecoverHost(ctx, j, true)
	}
	return observation, nil
}

// A host commit can outlive a lost child/shared-receipt acknowledgement. Never
// rewind databases after that commit; finish the same core commitment instead.
func (r NativeCoreRuntime) authorizeRecovery(ctx context.Context, j CoreJournal) error {
	if err := r.AuthorizePrevious(ctx, j); err != nil {
		return err
	}
	if !j.RestartRequired {
		return nil
	}
	host, err := loadJournal(r.Host.config.JournalPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if host.CoreManifestSHA256 == j.ManifestSHA256 && host.Phase == PhaseHealthy {
		return fmt.Errorf("host already committed; reconcile the shared core receipt")
	}
	if host.CoreManifestSHA256 == j.ManifestSHA256 {
		current, state, slot, err := r.Host.current()
		if err != nil {
			return err
		}
		if slot == host.CandidateSlot && current.ImageVersion == host.TargetImage && state.Slots.Current == slot && state.Slots.CurrentImageVersion == current.ImageVersion && state.Slots.Candidate == "" && state.Transaction == (appliance.TransactionState{}) {
			return fmt.Errorf("host slot promotion is durable; reconcile commitment instead of restoring data")
		}
	}
	return nil
}
