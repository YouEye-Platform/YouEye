package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func applianceTestRuntime() (appliance.RuntimeStatus, *appliance.Manifest, error) {
	m := &appliance.Manifest{ImageVersion: "1.0.0"}
	return appliance.RuntimeStatus{
		Kind: appliance.RuntimeApplianceImage, ManifestValid: true, ImageVersion: "1.0.0",
		Capabilities: appliance.Capabilities{ControlUpdate: true, UIUpdate: true, AppUpdate: true, Health: true},
	}, m, nil
}

type fakeSystemUpdateService struct {
	status systemupdate.Status
}

func (f *fakeSystemUpdateService) Status() (systemupdate.Status, error) { return f.status, nil }

func TestApplianceHostUpdateHandlersReturnTypedConflictBeforeMutation(t *testing.T) {
	s := NewServer("test", config.Default())
	s.runtimeDetect = applianceTestRuntime
	for name, handler := range map[string]http.HandlerFunc{
		"incus": s.handleUpdateIncus, "system": s.handleUpdateSystem,
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/update/"+name, nil)
			rec := httptest.NewRecorder()
			handler(rec, req)
			if rec.Code != http.StatusConflict {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			var body appliance.CapabilityError
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Code != "capability_not_supported" || body.Runtime != appliance.RuntimeApplianceImage {
				t.Fatalf("unexpected response: %+v", body)
			}
		})
	}
}

func TestApplianceControlAndAppCapabilitiesRemainAvailable(t *testing.T) {
	status, _, _ := applianceTestRuntime()
	for _, action := range []string{appliance.ActionControlUpdate, appliance.ActionUIUpdate, appliance.ActionAppUpdate} {
		if err := appliance.RequireCapability(status, action); err != nil {
			t.Errorf("%s: %v", action, err)
		}
	}
}

func TestApplianceSystemUpdateAPIExposesDurableStates(t *testing.T) {
	s := NewServer("test", config.Default())
	s.runtimeDetect = func() (appliance.RuntimeStatus, *appliance.Manifest, error) {
		manifest := &appliance.Manifest{ImageVersion: "0.6.0-dev.27"}
		return appliance.RuntimeStatus{
			Kind: appliance.RuntimeApplianceImage, ManifestValid: true, ImageVersion: manifest.ImageVersion,
			Capabilities: appliance.Capabilities{ImageUpdate: true, Recovery: true, Health: true},
		}, manifest, nil
	}
	fake := &fakeSystemUpdateService{status: systemupdate.Status{
		Schema: systemupdate.StatusSchema, State: systemupdate.PhaseHealthy,
		CurrentImage: "0.6.0-dev.27", RunningImage: "0.6.0-dev.27", ActiveSlot: "B",
	}}
	s.systemUpdate = fake

	req := httptest.NewRequest(http.MethodGet, "/api/appliance/system-update/status", nil)
	recorder := httptest.NewRecorder()
	s.handleSystemUpdateStatus(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var status systemupdate.Status
	if err := json.Unmarshal(recorder.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.State != systemupdate.PhaseHealthy {
		t.Fatalf("state=%q", status.State)
	}
	// The Control Panel can no longer select, stage or activate a host System
	// by URL or channel; only the core-update API (policy-owned source) remains.
	for _, path := range []string{"/api/appliance/system-update/check", "/api/appliance/system-update/stage", "/api/appliance/system-update/activate"} {
		recorder := httptest.NewRecorder()
		s.mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"manifest":"https://updates.test/system-update-manifest.json","manifest_sha256":"`+strings.Repeat("a", 64)+`"}`)))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status=%d", path, recorder.Code)
		}
	}
}
