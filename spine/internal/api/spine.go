package api

import (
	"net/http"
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/spineselect"
)

// handleSpineStatus reports the seed baked into the image, the Spine the
// booted slot runs and the selection of both slots.
func (s *Server) handleSpineStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cmdline, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		errorResponse(w, "booted slot unavailable", http.StatusServiceUnavailable)
		return
	}
	slot, err := appliance.SystemSlotFromKernelCommandLine(string(cmdline))
	if err != nil {
		errorResponse(w, "not an appliance image", http.StatusServiceUnavailable)
		return
	}
	seed := ""
	if _, image, err := s.runtimeDetect(); err == nil && image != nil && image.ReleaseSet != nil {
		seed = image.ReleaseSet.Spine.Version
	}
	report, err := spineselect.Status(spineselect.DefaultRoot, slot, seed)
	if err != nil {
		errorResponse(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonResponse(w, map[string]any{"version": s.version, "spine": report})
}
