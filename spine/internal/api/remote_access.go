package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/remoteaccess"
)

type remoteAccessService interface {
	List() ([]remoteaccess.Key, error)
	Add(string, string) (remoteaccess.Key, error)
	Delete(string, bool) (remoteaccess.Key, error)
}

type remoteAccessAddRequest struct {
	PublicKey string `json:"public_key"`
}

type remoteAccessDeleteRequest struct {
	ConfirmLastKey bool `json:"confirm_last_key"`
}

func (s *Server) requireSealedAppliance(w http.ResponseWriter) bool {
	status, _, err := s.runtimeDetect()
	if err != nil {
		jsonStatusResponse(w, map[string]any{"code": "appliance_recovery_required", "message": "sealed appliance marker is invalid; boot recovery", "runtime": status}, http.StatusServiceUnavailable)
		return false
	}
	if status.Kind != appliance.RuntimeApplianceImage {
		jsonStatusResponse(w, map[string]any{"code": "appliance_required", "message": "managed remote access is available only on a sealed appliance", "runtime": status}, http.StatusConflict)
		return false
	}
	return true
}

func (s *Server) handleRemoteAccessKeys(w http.ResponseWriter, r *http.Request) {
	if !s.requireSealedAppliance(w) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		keys, err := s.remoteAccess.List()
		if err != nil {
			errorResponse(w, err.Error(), http.StatusConflict)
			return
		}
		rootPasswordLocked := true
		if status, statusErr := s.developmentAccess.Status(); statusErr == nil {
			rootPasswordLocked = !status.LocalRootConsoleRequested && !status.RootPasswordSSHRequested
		}
		jsonResponse(w, map[string]any{"schema": remoteaccess.Schema, "keys": remoteaccess.Metadata(keys), "root_password_locked": rootPasswordLocked})
	case http.MethodPost:
		var request remoteAccessAddRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20*1024))
		decoder.DisallowUnknownFields()
		if err := decodeOne(decoder, &request); err != nil || strings.TrimSpace(request.PublicKey) == "" {
			errorResponse(w, "a valid SSH public key is required", http.StatusBadRequest)
			return
		}
		key, err := s.remoteAccess.Add(request.PublicKey, "settings")
		if err != nil {
			errorResponse(w, err.Error(), http.StatusBadRequest)
			return
		}
		jsonStatusResponse(w, key.Metadata(), http.StatusCreated)
	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleRemoteAccessKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireSealedAppliance(w) {
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/appliance/remote-access/keys/")
	if id == "" || strings.Contains(id, "/") || len(id) != 24 {
		errorResponse(w, "a valid SSH key ID is required", http.StatusBadRequest)
		return
	}
	request := remoteAccessDeleteRequest{}
	if r.Body != nil && r.ContentLength != 0 {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024))
		decoder.DisallowUnknownFields()
		if err := decodeOne(decoder, &request); err != nil {
			errorResponse(w, "a valid deletion request is required", http.StatusBadRequest)
			return
		}
	}
	key, err := s.remoteAccess.Delete(id, request.ConfirmLastKey)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			errorResponse(w, "SSH key not found", http.StatusNotFound)
			return
		}
		errorResponse(w, err.Error(), http.StatusConflict)
		return
	}
	jsonResponse(w, key.Metadata())
}
