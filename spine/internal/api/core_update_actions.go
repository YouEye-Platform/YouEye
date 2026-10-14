package api

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

type CoreUpdateCandidate struct {
	Release         releasecache.CoreRelease `json:"release"`
	ManifestSHA256  string                   `json:"manifest_sha256"`
	RestartRequired bool                     `json:"restart_required"`
}
type CoreUpdateRequest struct {
	RequestID      string `json:"request_id"`
	CommandID      string `json:"command_id"`
	ManifestSHA256 string `json:"manifest_sha256"`
}
type CoreUpdateActionResult struct {
	RequestID      string                              `json:"request_id"`
	ManifestSHA256 string                              `json:"manifest_sha256"`
	Phase          string                              `json:"phase"`
	Control        systemupdate.CoreControlObservation `json:"control"`
}
type CoreUpdateOperations interface {
	Check(context.Context) (CoreUpdateCandidate, error)
	Submit(context.Context, string, CoreUpdateRequest) (CoreUpdateActionResult, error)
}

func (s *Server) SetCoreUpdateOperations(operations CoreUpdateOperations) {
	s.coreUpdateOperations = operations
}

var coreAPIRequest = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var coreAPIDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (s *Server) handleCoreUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.runtimeCapabilityGuard(w, appliance.ActionImageUpdate) {
		return
	}
	if s.coreUpdateOperations == nil {
		errorResponse(w, "native core operations unavailable", http.StatusServiceUnavailable)
		return
	}
	candidate, err := s.coreUpdateOperations.Check(r.Context())
	if err != nil {
		errorResponse(w, "complete System discovery requires reconciliation", http.StatusConflict)
		return
	}
	jsonResponse(w, candidate)
}
func (s *Server) handleCoreUpdateAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !s.runtimeCapabilityGuard(w, appliance.ActionImageUpdate) {
			return
		}
		if s.coreUpdateOperations == nil {
			errorResponse(w, "native core operations unavailable", http.StatusServiceUnavailable)
			return
		}
		var request CoreUpdateRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		if decodeOne(decoder, &request) != nil || !coreAPIRequest.MatchString(request.RequestID) || !coreAPIRequest.MatchString(request.CommandID) || !coreAPIDigest.MatchString(request.ManifestSHA256) {
			errorResponse(w, "exact update, delivery and manifest identities required", http.StatusBadRequest)
			return
		}
		result, err := s.coreUpdateOperations.Submit(r.Context(), action, request)
		if err != nil {
			errorResponse(w, "System action requires reconciliation; retain the same update and delivery IDs", http.StatusConflict)
			return
		}
		jsonResponse(w, result)
	}
}
