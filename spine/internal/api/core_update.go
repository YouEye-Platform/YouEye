package api

import (
	"context"
	"errors"
	"net/http"
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

type coreInstalledObserver interface {
	ObserveInstalled(context.Context, systemupdate.CoreReceipt) systemupdate.CoreInstalledObservation
}

func (s *Server) coreRoot() string {
	if s.coreStatePath != "" {
		return s.coreStatePath
	}
	return systemupdate.CoreStatePath
}

func (s *Server) handleCoreUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	m := systemupdate.CoreManager{Root: s.coreRoot()}
	receipt, err := m.ReadReceipt()
	if errors.Is(err, os.ErrNotExist) {
		jsonResponse(w, map[string]any{"schema": "youeye.core-status.v1", "managed": false})
		return
	}
	if err != nil {
		errorResponse(w, "installed core receipt requires recovery", http.StatusConflict)
		return
	}
	out := map[string]any{"schema": "youeye.core-status.v1", "managed": true, "installed": map[string]any{
		"manifest_sha256": receipt.ManifestSHA256, "accepted_at": receipt.AcceptedAt, "machine_bound": true,
		"payload_observation": "not-observed", // A retained receipt is not a fresh installed scan.
		"release": map[string]any{"version": receipt.Release.Version, "tag": receipt.Release.Tag,
			"source": receipt.Release.Source, "branch": receipt.Release.Branch, "sequence": receipt.Release.Sequence, "source_commit": receipt.Release.SourceCommit},
	}}
	installed := out["installed"].(map[string]any)
	members := []map[string]string{}
	for _, member := range receipt.Release.Members {
		members = append(members, map[string]string{"role": member.Role, "version": member.BuildVersion, "source": member.Source, "branch": member.Branch, "tag": member.Tag, "commit": member.SourceCommit, "sha256": member.Artifact.SHA256})
	}
	installed["members"] = members
	// Ordinary status polling stays cheap. A machine observation explicitly
	// requests the bounded native scan; receipt age never substitutes for it.
	if r.URL.Query().Get("observe") == "1" {
		observation := systemupdate.CoreInstalledObservation{State: "unverified", ManifestSHA256: receipt.ManifestSHA256, Reason: "Native payload verifier is unavailable"}
		if observer, ok := s.coreUpdateOperations.(coreInstalledObserver); ok {
			observation = observer.ObserveInstalled(r.Context(), receipt)
		}
		installed["observation"] = observation
		installed["payload_observation"] = observation.State
	}
	j, err := m.Read()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		errorResponse(w, "core transaction requires recovery", http.StatusConflict)
		return
	}
	if err == nil {
		steps := []map[string]string{}
		graph := j.Steps
		if len(j.RecoverySteps) > 0 {
			graph = j.RecoverySteps
		}
		for _, step := range graph {
			steps = append(steps, map[string]string{"name": step.Name, "state": step.State})
		}
		complete := m.TransactionComplete(j)
		out["transaction"] = map[string]any{"request_id": j.RequestID, "manifest_sha256": j.ManifestSHA256,
			"phase": j.Phase, "restart_required": j.RestartRequired, "activation_requested": j.ActivationRequested, "error": j.Error,
			"target_version": j.Target.Version, "complete": complete, "steps": steps}
	}
	jsonResponse(w, out)
}
