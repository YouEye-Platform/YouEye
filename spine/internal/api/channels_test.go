package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/channels"
)

// setupChannelConfig points BOTH the api config path and the channels package
// path at one temp file so config PATCH/GET and channels.Save see the same file.
func setupChannelConfig(t *testing.T, content string) func() {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "youeye.yaml")
	if content != "" {
		if err := os.WriteFile(p, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	origAPI := youeyeConfigPath
	origCh := channels.ConfigPath
	youeyeConfigPath = p
	channels.ConfigPath = p
	return func() {
		youeyeConfigPath = origAPI
		channels.ConfigPath = origCh
	}
}

func TestConfigGETIncludesChannels(t *testing.T) {
	defer setupChannelConfig(t, "site_name: T\nrelease_channels:\n  default: { branch: main, fallback: [main] }\n  spine: { branch: f-x, fallback: [] }\n")()

	s := testServer()
	req := httptest.NewRequest("GET", "/api/config", nil)
	w := httptest.NewRecorder()
	s.handleYouEyeConfig(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body)

	rc, ok := body["release_channels"].(map[string]interface{})
	if !ok {
		t.Fatalf("release_channels missing: %v", body["release_channels"])
	}
	eff, ok := rc["effective"].(map[string]interface{})
	if !ok {
		t.Fatal("effective missing")
	}
	spine, ok := eff["spine"].(map[string]interface{})
	if !ok {
		t.Fatal("effective.spine missing")
	}
	if spine["branch"] != "f-x" {
		t.Errorf("effective spine branch = %v", spine["branch"])
	}
	// Disabled fallback must serialize as an empty array, not absent.
	fb, ok := spine["fallback"].([]interface{})
	if !ok || len(fb) != 0 {
		t.Errorf("spine fallback = %v, want [] (disabled)", spine["fallback"])
	}
}

func TestConfigPATCHSetsChannel(t *testing.T) {
	defer setupChannelConfig(t, "site_name: T\n")()

	s := testServer()
	patch := map[string]interface{}{
		"release_channels": map[string]interface{}{
			"spine": map[string]interface{}{"branch": "f-y", "fallback": []interface{}{}},
		},
	}
	body, _ := json.Marshal(patch)
	req := httptest.NewRequest("PATCH", "/api/config", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.handleYouEyeConfig(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}

	// Reload from disk and confirm persisted.
	c, err := channels.Load()
	if err != nil {
		t.Fatal(err)
	}
	eff := c.Effective(channels.ComponentSpine, s.cfg)
	if eff.Branch != "f-y" {
		t.Errorf("persisted spine branch = %q", eff.Branch)
	}
	if eff.Fallback == nil || len(eff.Fallback) != 0 {
		t.Errorf("persisted spine fallback = %v, want disabled", eff.Fallback)
	}
	// Unrelated key preserved.
	raw, _ := os.ReadFile(youeyeConfigPath)
	if !bytes.Contains(raw, []byte("site_name: T")) {
		t.Errorf("site_name lost:\n%s", raw)
	}
}

func TestConfigPATCHClearsChannelWithNull(t *testing.T) {
	defer setupChannelConfig(t, "release_channels:\n  default: { branch: main, fallback: [main] }\n  spine: { branch: f-x }\n")()

	s := testServer()
	patch := map[string]interface{}{
		"release_channels": map[string]interface{}{
			"spine": nil,
		},
	}
	body, _ := json.Marshal(patch)
	req := httptest.NewRequest("PATCH", "/api/config", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.handleYouEyeConfig(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}

	c, _ := channels.Load()
	if !c.Spine.IsZero() {
		t.Errorf("spine override not cleared: %+v", c.Spine)
	}
}

func TestConfigPATCHRejectsBadBranch(t *testing.T) {
	defer setupChannelConfig(t, "")()

	s := testServer()
	patch := map[string]interface{}{
		"release_channels": map[string]interface{}{
			"spine": map[string]interface{}{"branch": "bad/slash"},
		},
	}
	body, _ := json.Marshal(patch)
	req := httptest.NewRequest("PATCH", "/api/config", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.handleYouEyeConfig(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for bad branch", w.Code)
	}
}

func TestConfigPATCHPreservesChannelsOnUnrelatedEdit(t *testing.T) {
	defer setupChannelConfig(t, "release_channels:\n  default: { branch: dev, fallback: [main] }\n  spine: { branch: f-x, fallback: [] }\n")()

	s := testServer()
	// PATCH something unrelated (site_name) — release_channels must survive.
	patch := map[string]interface{}{"site_name": "Renamed"}
	body, _ := json.Marshal(patch)
	req := httptest.NewRequest("PATCH", "/api/config", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.handleYouEyeConfig(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}

	c, _ := channels.Load()
	if c.Spine.Branch != "f-x" {
		t.Errorf("spine override lost after unrelated edit: %+v", c.Spine)
	}
	if c.DefaultBranch() != "dev" {
		t.Errorf("default branch lost: %q", c.DefaultBranch())
	}
	raw, _ := os.ReadFile(youeyeConfigPath)
	if !bytes.Contains(raw, []byte("Renamed")) {
		t.Errorf("site_name not updated:\n%s", raw)
	}
}

func TestComponentUpdateMergeMakesLegacyFieldsChannelAuthoritative(t *testing.T) {
	entry := map[string]interface{}{
		"current":   "0.5.22.0.1",
		"latest":    "0.5.22.0.2",
		"available": true,
	}
	componentUpdateInfo{
		candidate:       versionRef{Version: "0.5.22.0.1", Branch: "main", Tag: "cp-v0.5.22.0.1"},
		updateAvailable: false,
	}.merge(entry)

	if entry["latest"] != "0.5.22.0.1" || entry["available"] != false {
		t.Fatalf("legacy fields remain contradictory: %#v", entry)
	}
}
