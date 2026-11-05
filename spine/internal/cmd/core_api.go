package cmd

import (
	"context"
	"fmt"

	"github.com/youeye-platform/YouEye/spine/internal/api"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

type coreAPIOperations struct {
	reader *coreAPIReaderBridge
}

func (o coreAPIOperations) Check(ctx context.Context) (api.CoreUpdateCandidate, error) {
	var out api.CoreUpdateCandidate
	runtime, err := installedCoreRuntime()
	if err != nil {
		return out, err
	}
	installed, err := (systemupdate.CoreManager{Root: runtime.Root}).ReadReceipt()
	if err != nil {
		return out, err
	}
	policy, err := currentCoreSelection()
	if err != nil {
		return out, err
	}
	selected, release, digest, err := systemupdate.ResolveCoreReleaseWithMetadata(ctx, runtime.Cache.Client, policy, systemupdate.CoreDevelopmentTrustPath, runtime.Cache.Root)
	if err != nil {
		return out, err
	}
	if o.reader != nil {
		if err := o.reader.verify(digest); err != nil {
			return out, err
		}
	} else {
		ready, acquireErr := acquireCoreReader(ctx, runtime, selected, release, digest, installed)
		err = acquireErr
		if err != nil {
			return out, err
		}
		if ready != nil {
			out.ReaderReady = &api.CoreReaderReadySummary{State: ready.State, Version: ready.Version, ManifestSHA256: ready.ManifestSHA256, ArtifactSHA256: ready.ArtifactSHA256, MachineBound: true}
		}
	}
	out.Release, out.ManifestSHA256 = release, digest
	for _, role := range []string{"appliance", "spine", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki"} {
		before, after := "", ""
		for _, m := range installed.Release.Members {
			if m.Role == role {
				before = m.Artifact.SHA256
			}
		}
		for _, m := range release.Members {
			if m.Role == role {
				after = m.Artifact.SHA256
			}
		}
		if before != after {
			out.RestartRequired = true
		}
	}
	return out, nil
}
func (o coreAPIOperations) Submit(ctx context.Context, action string, request api.CoreUpdateRequest) (api.CoreUpdateActionResult, error) {
	var out api.CoreUpdateActionResult
	if o.reader == nil {
		managedCoreAPISubmit.Lock()
		defer managedCoreAPISubmit.Unlock()
	}
	reader := o.reader
	if action == "stage" {
		var err error
		reader, err = o.stageReader(ctx, systemupdate.CoreManager{Root: systemupdate.CoreStatePath}, request.ManifestSHA256, request.RequestID)
		if err != nil {
			return out, err
		}
		if reader != nil && reader.managedLease != nil {
			defer reader.managedLease()
		}
	}
	if reader != nil {
		// Serialize this adapter's stage/register/cancel boundary. Native journal
		// and command locks still own cross-process admission and no-replay.
		reader.mu.Lock()
		defer reader.mu.Unlock()
		if action == "stage" {
			if err := reader.verify(request.ManifestSHA256); err != nil {
				return out, err
			}
		}
	}
	runtime, err := installedCoreRuntime()
	if err != nil {
		return out, err
	}
	m := systemupdate.CoreManager{Root: runtime.Root, Executor: runtime.Executor()}
	var j systemupdate.CoreJournal
	if action == "stage" {
		j, err = prepareCoreRequest(ctx, m, request.RequestID, request.ManifestSHA256)
	} else {
		j, err = m.Read()
		if err == nil && (j.RequestID != request.RequestID || j.ManifestSHA256 != request.ManifestSHA256) {
			err = fmt.Errorf("exact current request required")
		}
	}
	if err != nil {
		return out, err
	}
	switch action {
	case "stage", "resume":
	case "activate":
		j, err = m.RequestActivation(ctx, request.RequestID, request.ManifestSHA256)
	case "recover":
		j, err = m.Recover(ctx, request.RequestID)
	case "cancel":
		j, err = m.Cancel(ctx, request.RequestID)
	default:
		return out, fmt.Errorf("unsupported core action")
	}
	if err != nil {
		return out, err
	}
	out = api.CoreUpdateActionResult{RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Phase: j.Phase, Control: systemupdate.CoreControlObservation{RequestID: j.RequestID, CommandID: request.CommandID, State: "settled"}}
	if j.Phase == "cancelled" {
		return out, finishCoreBootstrap(ctx, request.RequestID)
	}
	current, err := m.Read()
	if err != nil {
		return out, err
	}
	if current.RequestID != j.RequestID {
		out.Control.State = "retained"
		return out, nil
	}
	if reader != nil {
		bound, err := reader.bindStage(action, current, m.TransactionComplete(current),
			func(request, digest, executable string) (string, error) {
				return m.RegisterBootstrap(request, digest, executable, systemupdate.CoreDevelopmentTrustPath)
			}, writeCoreBootstrapOverride)
		if err != nil {
			return out, err
		}
		if bound {
			// Registration must precede native continuation: the canonical baked
			// reader may be too old to parse this exact selection.
			runtime, err = installedCoreRuntime()
			if err != nil {
				return out, err
			}
		}
		if !m.TransactionComplete(current) && !coreAPIReaderTerminal(current) && runtime.Runner.Executable != reader.executable {
			return out, fmt.Errorf("the signed reader must be registered by the retained Stage request before continuation")
		}
	}
	runner := systemupdate.CoreControlRunner{Root: runtime.Root, Executable: runtime.Runner.Executable}
	out.Control, err = runner.Start(ctx, request.RequestID, request.CommandID)
	return out, err
}
