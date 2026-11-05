package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// The CP persists blocks Spine doesn't model (e.g. nested identity config)
// through PATCH /api/config. They must round-trip: persist as native yaml,
// survive unrelated edits, appear on GET, and delete on explicit null.
// Regression for the youeye-id "Repairing migrated config" log spam, whose
// root cause was PATCH silently dropping non-string unknown keys.
func TestConfigForeignBlockRoundTrip(t *testing.T) {
	defer setupChannelConfig(t, "site_name: DevVM\ndomain: devvm.test\n")()
	s := testServer()

	doPatch := func(payload map[string]interface{}) *httptest.ResponseRecorder {
		body, _ := json.Marshal(payload)
		req := httptest.NewRequest("PATCH", "/api/config", bytes.NewReader(body))
		w := httptest.NewRecorder()
		s.handleYouEyeConfig(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("PATCH status = %d, body=%s", w.Code, w.Body.String())
		}
		return w
	}
	doGet := func() map[string]interface{} {
		req := httptest.NewRequest("GET", "/api/config", nil)
		w := httptest.NewRecorder()
		s.handleYouEyeConfig(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("GET status = %d, body=%s", w.Code, w.Body.String())
		}
		var out map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("GET body not JSON: %v", err)
		}
		return out
	}

	// 1. PATCH a nested foreign object.
	doPatch(map[string]interface{}{
		"identity": map[string]interface{}{"provider": "youeye-id"},
	})
	raw, _ := os.ReadFile(youeyeConfigPath)
	if !bytes.Contains(raw, []byte("identity:")) || !bytes.Contains(raw, []byte("provider: youeye-id")) {
		t.Fatalf("nested identity block not persisted as native yaml:\n%s", raw)
	}

	// 2. GET returns it.
	got := doGet()
	identity, ok := got["identity"].(map[string]interface{})
	if !ok || identity["provider"] != "youeye-id" {
		t.Fatalf("GET missing foreign identity block: %v", got["identity"])
	}

	// 3. Unrelated PATCH (string key → Extra path) preserves it.
	doPatch(map[string]interface{}{"site_name": "Renamed"})
	raw, _ = os.ReadFile(youeyeConfigPath)
	if !bytes.Contains(raw, []byte("provider: youeye-id")) {
		t.Fatalf("identity block lost on unrelated edit:\n%s", raw)
	}
	if !bytes.Contains(raw, []byte("Renamed")) {
		t.Fatalf("unrelated edit not applied:\n%s", raw)
	}

	// 4. Explicit null deletes the foreign key.
	doPatch(map[string]interface{}{"identity": nil})
	raw, _ = os.ReadFile(youeyeConfigPath)
	if bytes.Contains(raw, []byte("identity:")) && bytes.Contains(raw, []byte("provider: youeye-id")) {
		t.Fatalf("identity block not deleted on explicit null:\n%s", raw)
	}
	got = doGet()
	if _, present := got["identity"]; present {
		t.Fatalf("deleted foreign key still returned on GET: %v", got["identity"])
	}
}
