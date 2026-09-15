package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/networkstatus"
)

type fakeNetworkStatusService struct{ status networkstatus.Status }

func (service fakeNetworkStatusService) Status() (networkstatus.Status, error) {
	return service.status, nil
}

func TestNetworkStatusAPIIsSealedReadOnlyAndSafe(t *testing.T) {
	server := NewServer("test", config.Default())
	server.runtimeDetect = func() (appliance.RuntimeStatus, *appliance.Manifest, error) {
		return appliance.RuntimeStatus{Kind: appliance.RuntimeApplianceImage, ManifestValid: true}, &appliance.Manifest{}, nil
	}
	server.networkStatus = fakeNetworkStatusService{status: networkstatus.Status{
		Schema: networkstatus.StatusSchema, Phase: "ready", Adapter: "ens18", Kind: "ethernet", IPv4Mode: "dhcp", IPv4Address: "192.0.2.10",
	}}
	request := httptest.NewRequest(http.MethodGet, "/api/appliance/network", nil)
	response := httptest.NewRecorder()
	server.handleNetworkStatus(response, request)
	if response.Code != http.StatusOK || response.Body.String() == "" {
		t.Fatalf("GET status=%d body=%s", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodPost, "/api/appliance/network", nil)
	response = httptest.NewRecorder()
	server.handleNetworkStatus(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("network mutation status=%d", response.Code)
	}
}
