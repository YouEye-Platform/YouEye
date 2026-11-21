package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

type coreAPIFixture struct {
	calls   int
	request CoreUpdateRequest
	fail    bool
	// pruning: this many calls find the coordinator lock held by the pruning.
	pruning int
}

func (f *coreAPIFixture) Check(context.Context) (CoreUpdateCandidate, error) {
	return CoreUpdateCandidate{}, nil
}
func (f *coreAPIFixture) Submit(_ context.Context, _ string, r CoreUpdateRequest) (CoreUpdateActionResult, error) {
	f.calls++
	f.request = r
	if f.pruning > 0 {
		f.pruning--
		return CoreUpdateActionResult{}, fmt.Errorf("core update cannot start yet: %w", systemupdate.ErrCorePruning)
	}
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

// An Update pressed while finished updates are being pruned waits for the next gap (the pruning holds the
// coordinator lock for one finished request at a time) instead of answering 409.
func TestCoreAPIActionWaitsForAGapInThePruning(t *testing.T) {
	oldWait, oldPoll := coreActionPruneWait, coreActionPrunePoll
	coreActionPruneWait, coreActionPrunePoll = 2*time.Second, time.Millisecond
	defer func() { coreActionPruneWait, coreActionPrunePoll = oldWait, oldPoll }()
	s := NewServer("test", config.Default())
	s.runtimeDetect = func() (appliance.RuntimeStatus, *appliance.Manifest, error) {
		return appliance.RuntimeStatus{Kind: appliance.RuntimeApplianceImage, ManifestValid: true, Capabilities: appliance.Capabilities{ImageUpdate: true}}, &appliance.Manifest{}, nil
	}
	valid := `{"request_id":"update-1","command_id":"delivery-1","manifest_sha256":"` + strings.Repeat("a", 64) + `"}`
	f := &coreAPIFixture{pruning: 3}
	s.SetCoreUpdateOperations(f)
	w := httptest.NewRecorder()
	s.handleCoreUpdateAction("stage")(w, httptest.NewRequest("POST", "/", strings.NewReader(valid)))
	if w.Code != 200 || f.calls != 4 {
		t.Fatalf("status %d after %d calls, want 200 after the pruning let go (4 calls)", w.Code, f.calls)
	}
	// A pruning that does not end within the wait is still a refusal, and any other error is not waited for.
	coreActionPruneWait = 20 * time.Millisecond
	f = &coreAPIFixture{pruning: 1 << 30}
	s.SetCoreUpdateOperations(f)
	w = httptest.NewRecorder()
	s.handleCoreUpdateAction("stage")(w, httptest.NewRequest("POST", "/", strings.NewReader(valid)))
	if w.Code != http.StatusConflict || f.calls < 2 {
		t.Fatalf("status %d after %d calls", w.Code, f.calls)
	}
	f = &coreAPIFixture{fail: true}
	s.SetCoreUpdateOperations(f)
	w = httptest.NewRecorder()
	s.handleCoreUpdateAction("stage")(w, httptest.NewRequest("POST", "/", strings.NewReader(valid)))
	if w.Code != http.StatusConflict || f.calls != 1 {
		t.Fatalf("status %d after %d calls, want one call for an error that is not the pruning", w.Code, f.calls)
	}
}
