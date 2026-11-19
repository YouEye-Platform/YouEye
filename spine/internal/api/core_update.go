package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"

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

func (s *Server) coreSelectionRoot() string {
	if s.coreBootstrapPath != "" {
		return s.coreBootstrapPath
	}
	return systemupdate.CoreBootstrapPath
}

const coreStepEvidenceLimit = 600

// coreStepEvidence makes retained failure evidence fit for a status answer:
// one line of printable text, at most coreStepEvidenceLimit characters, with
// absolute file paths (words starting with "/") replaced by "…".
func coreStepEvidence(evidence string) string {
	clean := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r == utf8.RuneError || !unicode.IsPrint(r) {
			return -1
		}
		return r
	}, evidence)
	words := strings.Fields(clean)
	for i, word := range words {
		bare := strings.TrimLeft(word, "\"'([")
		if end := coreEvidencePunctuation(bare); strings.HasPrefix(bare, "/") && len(bare)-len(end) > 1 {
			words[i] = word[:len(word)-len(bare)] + "…" + end
		}
	}
	clean = strings.Join(words, " ")
	if runes := []rune(clean); len(runes) > coreStepEvidenceLimit {
		clean = string(runes[:coreStepEvidenceLimit]) + "…"
	}
	return clean
}

// coreEvidencePunctuation keeps the punctuation that ends a redacted path, so
// "open /x/y: denied" reads "open …: denied".
func coreEvidencePunctuation(word string) string {
	return word[len(strings.TrimRight(word, "\"')]:;,.")):]
}

// coreStatusEvidence is the reason shown for one step, or "". A failed step
// carries the reason it was recorded with. A step left started when the
// request needs recovery has an unknown outcome; its reason is the error its
// action's child recorded (for example a strict payload refusal), if any. The
// evidence of every other step stays private.
func coreStatusEvidence(runner systemupdate.CoreSystemdRunner, j systemupdate.CoreJournal, step systemupdate.CoreStep, uncertain bool) string {
	switch {
	case step.State == "failed":
		return coreStepEvidence(step.Evidence)
	case step.State == "started" && uncertain:
		return coreStepEvidence(runner.RetainedEvidence(j, step))
	}
	return ""
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
			"sequence": receipt.Release.Sequence, "source_tree": receipt.Release.SourceTree},
	}}
	// The System update source is read-only here: it is the installer-recorded
	// release policy, never a setting the Control Panel can change.
	if selection, err := systemupdate.PolicyCoreSelection(s.coreSelectionRoot()); err == nil {
		out["selection"] = map[string]any{"repository": selection.Repository, "channel": selection.Channel}
	}
	installed := out["installed"].(map[string]any)
	members := []map[string]string{}
	for _, member := range receipt.Release.Members {
		// Members are named by role, tree and sha256; the release's version names them all.
		members = append(members, map[string]string{"role": member.Role, "source_tree": member.SourceTree, "sha256": member.Artifact.SHA256})
	}
	installed["members"] = members
	// Ordinary status polling stays cheap. A machine observation explicitly
	// requests the bounded native scan; receipt age never substitutes for it.
	if r.URL.Query().Get("observe") == "1" {
		observation := systemupdate.CoreInstalledObservation{State: "unverified", ManifestSHA256: receipt.ManifestSHA256, Reason: "Native payload verifier is unavailable"}
		if observer, ok := s.coreUpdateOperations.(coreInstalledObserver); ok {
			observation = observer.ObserveInstalled(r.Context(), receipt)
		}
		// States and counts only. File names stay on the operator's terminal
		// (`youeye update core observe`).
		for i := range observation.Members {
			observation.Members[i].Findings.Paths = nil
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
		runner := systemupdate.CoreSystemdRunner{Root: s.coreRoot()}
		for _, step := range graph {
			item := map[string]string{"name": step.Name, "state": step.State}
			if observed, err := (systemupdate.NativeCoreExecutor{Root: s.coreRoot()}).ActionStatus(j, step); err == nil {
				item["action_state"], item["stage"], item["code"], item["effect_state"] = observed.State, observed.Stage, observed.Code, observed.EffectState
			}
			// Why a step failed, or why its outcome is uncertain, is the one piece
			// of evidence the owner needs. Evidence of other steps stays private
			// (ActionStatus blanks it), and this one is cut short: it can embed raw
			// error text.
			if evidence := coreStatusEvidence(runner, j, step, j.Phase == "needs-recovery"); evidence != "" {
				item["evidence"] = evidence
			}
			steps = append(steps, item)
		}
		complete := m.TransactionComplete(j)
		out["transaction"] = map[string]any{"request_id": j.RequestID, "manifest_sha256": j.ManifestSHA256,
			"phase": j.Phase, "restart_required": j.RestartRequired, "activation_requested": j.ActivationRequested, "error": j.Error,
			"target_version": j.Target.Version, "complete": complete, "steps": steps}
		// Once recovery owns the request, steps lists the recovery graph. The
		// apply step that stopped the update (failed, or started with an
		// uncertain outcome) is reported on its own, so a rolled-back update
		// still says which step stopped it and why.
		if len(j.RecoverySteps) > 0 {
			for _, step := range j.Steps {
				if step.State != "failed" && step.State != "started" {
					continue
				}
				stopped := map[string]string{"name": step.Name, "state": step.State}
				if evidence := coreStatusEvidence(runner, j, step, true); evidence != "" {
					stopped["evidence"] = evidence
				}
				out["transaction"].(map[string]any)["stopped_step"] = stopped
				break
			}
		}
	}
	jsonResponse(w, out)
}
