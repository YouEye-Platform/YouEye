package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/config"
)

type coreAPIFixture struct {
	calls   int
	request CoreUpdateRequest
	fail    bool
}

func (f *coreAPIFixture) Check(context.Context) (CoreUpdateCandidate, error) {
	return CoreUpdateCandidate{}, nil
}
func (f *coreAPIFixture) Submit(_ context.Context, _ string, r CoreUpdateRequest) (CoreUpdateActionResult, error) {
	f.calls++
	f.request = r
	if f.fail {
		return CoreUpdateActionResult{}, fmt.Errorf("private-secret")
	}
	return CoreUpdateActionResult{RequestID: r.RequestID, ManifestSHA256: r.ManifestSHA256, Phase: "prepared"}, nil
}
func TestCoreAPIActionsRequireExactBoundedInputsAndNativeCapability(t *testing.T) {
	s := NewServer("test", config.Default())
	f := &coreAPIFixture{}
	s.SetCoreUpdateOperations(f)
	s.runtimeDetect = func() (appliance.RuntimeStatus, *appliance.Manifest, error) {
		return appliance.RuntimeStatus{Kind: appliance.RuntimeApplianceImage, ManifestValid: true, Capabilities: appliance.Capabilities{ImageUpdate: true}}, &appliance.Manifest{}, nil
	}
	valid := `{"request_id":"update-1","command_id":"delivery-1","manifest_sha256":"` + strings.Repeat("a", 64) + `"}`
	for _, body := range []string{`{}`, strings.Replace(valid, "delivery-1", "../escape", 1), strings.Replace(valid, `"command_id"`, `"unexpected"`, 1), valid + `{}`, strings.Repeat(" ", 5000) + valid} {
		w := httptest.NewRecorder()
		s.handleCoreUpdateAction("stage")(w, httptest.NewRequest("POST", "/", strings.NewReader(body)))
		if w.Code != 400 || f.calls != 0 {
			t.Fatal(w.Code, f.calls)
		}
	}
	w := httptest.NewRecorder()
	s.handleCoreUpdateAction("stage")(w, httptest.NewRequest("POST", "/", strings.NewReader(valid)))
	if w.Code != 200 || f.calls != 1 || f.request.CommandID != "delivery-1" {
		t.Fatal(w.Code, f.calls)
	}
	f.fail = true
	w = httptest.NewRecorder()
	s.handleCoreUpdateAction("resume")(w, httptest.NewRequest("POST", "/", strings.NewReader(valid)))
	if w.Code != http.StatusConflict || strings.Contains(w.Body.String(), "private-secret") {
		t.Fatal(w.Code, w.Body.String())
	}
	s.runtimeDetect = applianceTestRuntime
	w = httptest.NewRecorder()
	s.handleCoreUpdateAction("stage")(w, httptest.NewRequest("POST", "/", strings.NewReader(valid)))
	if w.Code != http.StatusConflict || f.calls != 2 {
		t.Fatal(w.Code, f.calls)
	}
}
