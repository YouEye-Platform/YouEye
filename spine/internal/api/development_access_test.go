package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/developmentaccess"
)

type fakeDevelopmentAccess struct {
	disabled bool
}

func (service *fakeDevelopmentAccess) Status() (developmentaccess.Status, error) {
	return developmentaccess.Status{Schema: developmentaccess.StatusSchema, LocalRootConsoleRequested: !service.disabled, LocalRootConsolePersisted: !service.disabled, LocalRootConsoleActive: !service.disabled, LocalRootConsoleEffective: !service.disabled, CanDisableRemotely: true}, nil
}

func (service *fakeDevelopmentAccess) Disable() (developmentaccess.Status, error) {
	service.disabled = true
	return service.Status()
}

func TestDevelopmentAccessAPIIsReadOnlyExceptForDisable(t *testing.T) {
	server, _ := remoteAccessTestServer()
	service := &fakeDevelopmentAccess{}
	server.developmentAccess = service
	for _, test := range []struct {
		method string
		code   int
	}{
		{http.MethodGet, http.StatusOK},
		{http.MethodPost, http.StatusMethodNotAllowed},
		{http.MethodPut, http.StatusMethodNotAllowed},
		{http.MethodDelete, http.StatusOK},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(test.method, "/api/appliance/development-access", nil)
		server.handleDevelopmentAccess(response, request)
		if response.Code != test.code {
			t.Fatalf("%s returned %d: %s", test.method, response.Code, response.Body.String())
		}
		if response.Code == http.StatusOK {
			var body struct {
				Schema                    string `json:"schema"`
				LocalRootConsoleRequested bool   `json:"local_root_console_requested"`
				LocalRootConsolePersisted bool   `json:"local_root_console_persisted"`
				LocalRootConsoleActive    bool   `json:"local_root_console_active"`
				LocalRootConsoleEffective bool   `json:"local_root_console_effective"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Schema != developmentaccess.StatusSchema {
				t.Fatalf("%s returned invalid v2 status: %s", test.method, response.Body.String())
			}
			if test.method == http.MethodGet && (!body.LocalRootConsoleRequested || !body.LocalRootConsolePersisted || !body.LocalRootConsoleActive || !body.LocalRootConsoleEffective) {
				t.Fatalf("GET lost v2 local-console fields: %s", response.Body.String())
			}
		}
	}
	if !service.disabled {
		t.Fatal("DELETE did not disable development access")
	}
}
