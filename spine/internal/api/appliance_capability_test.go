package api

import (
	"context"
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
	status       systemupdate.Status
	discovered   systemupdate.SourceOptions
	staged       systemupdate.SourceOptions
	activateBoot bool
}

func (f *fakeSystemUpdateService) Status() (systemupdate.Status, error) { return f.status, nil }
func (f *fakeSystemUpdateService) Discover(_ context.Context, options systemupdate.SourceOptions) (systemupdate.Status, error) {
	f.discovered = options
	f.status.State = systemupdate.PhaseAvailable
	return f.status, nil
}
func (f *fakeSystemUpdateService) Stage(_ context.Context, options systemupdate.SourceOptions) (systemupdate.Status, error) {
	f.staged = options
	f.status.State = systemupdate.PhaseStaged
	return f.status, nil
}
func (f *fakeSystemUpdateService) Activate(_ context.Context, reboot bool) (systemupdate.Status, error) {
	f.activateBoot = reboot
	f.status.State = systemupdate.PhasePending
	return f.status, nil
}

func TestApplianceHostUpdateHandlersReturnTypedConflictBeforeMutation(t *testing.T) {
	s := NewServer("test", config.Default())
	s.runtimeDetect = applianceTestRuntime
	for name, handler := range map[string]http.HandlerFunc{
		"spine": s.handleUpdateSelf, "incus": s.handleUpdateIncus, "system": s.handleUpdateSystem,
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

	for _, tc := range []struct {
		name, method, path, body, wantState string
		handler                             http.HandlerFunc
	}{
		{name: "status", method: http.MethodGet, path: "/api/appliance/system-update/status", wantState: systemupdate.PhaseHealthy, handler: s.handleSystemUpdateStatus},
		{name: "check", method: http.MethodPost, path: "/api/appliance/system-update/check", body: `{"manifest":"https://updates.test/system-update-manifest.json"}`, wantState: systemupdate.PhaseAvailable, handler: s.handleSystemUpdateCheck},
		{name: "stage", method: http.MethodPost, path: "/api/appliance/system-update/stage", body: `{"manifest":"https://updates.test/system-update-manifest.json"}`, wantState: systemupdate.PhaseStaged, handler: s.handleSystemUpdateStage},
		{name: "activate", method: http.MethodPost, path: "/api/appliance/system-update/activate", body: `{"reboot":true}`, wantState: systemupdate.PhasePending, handler: s.handleSystemUpdateActivate},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			recorder := httptest.NewRecorder()
			tc.handler(recorder, req)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			var status systemupdate.Status
			if err := json.Unmarshal(recorder.Body.Bytes(), &status); err != nil {
				t.Fatal(err)
			}
			if status.State != tc.wantState {
				t.Fatalf("state=%q want=%q", status.State, tc.wantState)
			}
		})
	}
	if fake.staged.ManifestSource == "" || !fake.activateBoot {
		t.Fatalf("stage=%+v activateBoot=%v", fake.staged, fake.activateBoot)
	}
}
