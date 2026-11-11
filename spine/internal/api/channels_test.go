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

func patchConfig(t *testing.T, s *Server, patch map[string]interface{}) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(patch)
	req := httptest.NewRequest("PATCH", "/api/config", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.handleYouEyeConfig(w, req)
	return w
}

func TestConfigPATCHSetsAppChannel(t *testing.T) {
	defer setupChannelConfig(t, "site_name: T\n")()

	s := testServer()
	w := patchConfig(t, s, map[string]interface{}{
		"release_channels": map[string]interface{}{
			"app:wiki": map[string]interface{}{"source": "https://forge.example.test/apps/Wiki", "branch": "f-y", "fallback": []interface{}{}},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}

	// Reload from disk and confirm persisted.
	c, err := channels.Load()
	if err != nil {
		t.Fatal(err)
	}
	eff := c.Effective("app:wiki", s.cfg)
	if eff.Branch != "f-y" || eff.Source != "https://forge.example.test/apps/Wiki" {
		t.Errorf("persisted app channel = %+v", eff)
	}
	if eff.Fallback == nil || len(eff.Fallback) != 0 {
		t.Errorf("persisted app fallback = %v, want disabled", eff.Fallback)
	}
	// Unrelated key preserved.
	raw, _ := os.ReadFile(youeyeConfigPath)
	if !bytes.Contains(raw, []byte("site_name: T")) {
		t.Errorf("site_name lost:\n%s", raw)
	}
}

func TestConfigPATCHClearsAppChannelWithNull(t *testing.T) {
	defer setupChannelConfig(t, "release_channels:\n  default: { branch: main, fallback: [main] }\n  apps:\n    wiki: { branch: f-x }\n")()

	s := testServer()
	w := patchConfig(t, s, map[string]interface{}{"release_channels": map[string]interface{}{"app:wiki": nil}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}

	c, _ := channels.Load()
	if _, ok := c.Apps["wiki"]; ok {
		t.Errorf("app override not cleared: %+v", c.Apps)
	}
}

func TestConfigPATCHRejectsBadBranch(t *testing.T) {
	defer setupChannelConfig(t, "")()

	s := testServer()
	w := patchConfig(t, s, map[string]interface{}{
		"release_channels": map[string]interface{}{
			"app:wiki": map[string]interface{}{"branch": "bad branch"},
		},
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for bad branch", w.Code)
	}
}

// The Control Panel reaches this API from its container. It must never choose
// what the host installs: the System selection and the core channels are
// host-owned, including exact tag/digest pins and resets.
func TestConfigPATCHRefusesHostOwnedChannels(t *testing.T) {
	const initial = "site_name: T\nrelease_channels:\n  default: { branch: main, fallback: [main] }\n  control: { tag: youeye-v0.6.0, artifact_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, fallback: [] }\n"
	digest := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	for _, tc := range []struct {
		name  string
		patch map[string]interface{}
	}{
		{"system source", map[string]interface{}{"system": map[string]interface{}{"source": "https://attacker.example.test/team/YouEye", "branch": "main"}}},
		{"system pin", map[string]interface{}{"system": map[string]interface{}{"tag": "youeye-v9.9.9", "artifact_sha256": digest}}},
		{"system reset", map[string]interface{}{"system": nil}},
		{"default source", map[string]interface{}{"default": map[string]interface{}{"source": "https://attacker.example.test/team/YouEye"}}},
		{"spine branch", map[string]interface{}{"spine": map[string]interface{}{"branch": "evil"}}},
		{"control pin", map[string]interface{}{"control": map[string]interface{}{"tag": "youeye-v9.9.9", "artifact_sha256": digest}}},
		{"control reset", map[string]interface{}{"control": nil}},
		{"ui source", map[string]interface{}{"ui": map[string]interface{}{"source": "https://attacker.example.test/team/YouEye"}}},
		{"mixed with app", map[string]interface{}{"app:wiki": map[string]interface{}{"branch": "f-x"}, "system": map[string]interface{}{"branch": "evil"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer setupChannelConfig(t, initial)()
			before, _ := os.ReadFile(youeyeConfigPath)
			w := patchConfig(t, testServer(), map[string]interface{}{"release_channels": tc.patch})
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", w.Code, w.Body.String())
			}
			after, _ := os.ReadFile(youeyeConfigPath)
			if !bytes.Equal(before, after) {
				t.Fatalf("refused patch changed youeye.yaml:\n%s", after)
			}
		})
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
