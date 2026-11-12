package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// systemUpdateService reports the durable host slot state. The Control Panel
// cannot select, stage or activate a host System: complete System updates go
// through the core-update API, whose source is the installer-recorded policy.
type systemUpdateService interface {
	Status() (systemupdate.Status, error)
}

func (s *Server) handleSystemUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.runtimeCapabilityGuard(w, appliance.ActionImageUpdate) {
		return
	}
	status, err := s.systemUpdate.Status()
	if err != nil {
		errorResponse(w, err.Error(), http.StatusConflict)
		return
	}
	jsonResponse(w, status)
}

func decodeOne(decoder *json.Decoder, target any) error {
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("request contains trailing JSON")
	}
	return nil
}
