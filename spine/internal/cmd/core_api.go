package cmd

import (
	"context"
	"fmt"

	"github.com/youeye-platform/YouEye/spine/internal/api"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

type coreAPIOperations struct{}

func (coreAPIOperations) Check(ctx context.Context) (api.CoreUpdateCandidate, error) {
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
	_, release, digest, err := systemupdate.ResolveCoreRelease(ctx, runtime.Cache.Client, policy, systemupdate.CoreDevelopmentTrustPath)
	if err != nil {
		return out, err
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
func (coreAPIOperations) Submit(ctx context.Context, action string, request api.CoreUpdateRequest) (api.CoreUpdateActionResult, error) {
	var out api.CoreUpdateActionResult
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
	runner := systemupdate.CoreControlRunner{Root: runtime.Root, Executable: runtime.Runner.Executable}
	out.Control, err = runner.Start(ctx, request.RequestID, request.CommandID)
	return out, err
}
