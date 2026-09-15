package api

import (
	"net/http"

	"github.com/youeye-platform/YouEye/spine/internal/networkstatus"
)

type networkStatusService interface {
	Status() (networkstatus.Status, error)
}

func (server *Server) handleNetworkStatus(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		errorResponse(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !server.requireSealedAppliance(response) {
		return
	}
	status, err := server.networkStatus.Status()
	if err != nil {
		errorResponse(response, err.Error(), http.StatusConflict)
		return
	}
	jsonResponse(response, status)
}
