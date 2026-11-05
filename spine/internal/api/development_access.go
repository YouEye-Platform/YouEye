package api

import (
	"net/http"

	"github.com/youeye-platform/YouEye/spine/internal/developmentaccess"
)

type developmentAccessService interface {
	Status() (developmentaccess.Status, error)
	Disable() (developmentaccess.Status, error)
}

func (server *Server) handleDevelopmentAccess(response http.ResponseWriter, request *http.Request) {
	if !server.requireSealedAppliance(response) {
		return
	}
	var (
		status developmentaccess.Status
		err    error
	)
	switch request.Method {
	case http.MethodGet:
		status, err = server.developmentAccess.Status()
	case http.MethodDelete:
		status, err = server.developmentAccess.Disable()
	default:
		errorResponse(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err != nil {
		errorResponse(response, err.Error(), http.StatusConflict)
		return
	}
	jsonResponse(response, status)
}
