package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
)

func testServer() *Server {
	cfg := config.Default()
	return NewServer("0.2.6.1", cfg)
}

func TestHandleHealth(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/health", nil)
	w := httptest.NewRecorder()

	s.handleHealth(w, req)

	if w.Code != 200 {
		t.Errorf("status = %d, want 200", w.Code)
	}

	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["status"] != "ok" {
		t.Errorf("status = %q, want %q", body["status"], "ok")
	}

	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestHandleVersion(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/version", nil)
	w := httptest.NewRecorder()

	s.handleVersion(w, req)

	if w.Code != 200 {
		t.Errorf("status = %d, want 200", w.Code)
	}

	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["version"] != "0.2.6.1" {
		t.Errorf("version = %q, want %q", body["version"], "0.2.6.1")
	}
	if body["service"] != "spine" {
		t.Errorf("service = %q, want %q", body["service"], "spine")
	}
}

func TestHandleUpdatesCheck_MethodNotAllowed(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("POST", "/api/updates/check", nil)
	w := httptest.NewRecorder()

	s.handleUpdatesCheck(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleAuthVerify_MethodNotAllowed(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/auth/verify", nil)
	w := httptest.NewRecorder()

	s.handleAuthVerify(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleAuthVerify_MissingBody(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("POST", "/api/auth/verify", nil)
	w := httptest.NewRecorder()

	s.handleAuthVerify(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleAuthVerify_EmptyCredentials(t *testing.T) {
	s := testServer()
	body := `{"username":"","password":""}`
	req := httptest.NewRequest("POST", "/api/auth/verify", strings.NewReader(body))
	w := httptest.NewRecorder()

	s.handleAuthVerify(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestJsonResponse(t *testing.T) {
	w := httptest.NewRecorder()
	data := map[string]string{"key": "value"}
	jsonResponse(w, data)

	if w.Code != 200 {
		t.Errorf("status = %d, want 200", w.Code)
	}

	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["key"] != "value" {
		t.Errorf("key = %q, want %q", body["key"], "value")
	}
}

func TestErrorResponse(t *testing.T) {
	w := httptest.NewRecorder()
	errorResponse(w, "not found", 404)

	if w.Code != 404 {
		t.Errorf("status = %d, want 404", w.Code)
	}

	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["error"] != "not found" {
		t.Errorf("error = %q, want %q", body["error"], "not found")
	}
}

func TestNewServer(t *testing.T) {
	cfg := config.Default()
	s := NewServer("1.0.0", cfg)

	if s.version != "1.0.0" {
		t.Errorf("version = %q, want %q", s.version, "1.0.0")
	}
	if s.socketPath != cfg.API.SocketPath {
		t.Errorf("socketPath = %q, want %q", s.socketPath, cfg.API.SocketPath)
	}
	if s.mux == nil {
		t.Error("mux should not be nil")
	}
	if s.authLimiter == nil {
		t.Error("authLimiter should not be nil")
	}
}

func TestRateLimiter_AllowsUnderLimit(t *testing.T) {
	cfg := config.Default()
	cfg.API.Auth.MaxAttempts = 3
	cfg.API.Auth.WindowMinutes = 5
	limiter := newAuthRateLimiter(cfg)

	for i := 0; i < 3; i++ {
		allowed, remaining := limiter.checkRateLimit("testuser")
		if !allowed {
			t.Errorf("attempt %d should be allowed", i+1)
		}
		expectedRemaining := 2 - i
		if remaining != expectedRemaining {
			t.Errorf("attempt %d: remaining = %d, want %d", i+1, remaining, expectedRemaining)
		}
	}
}

func TestRateLimiter_BlocksOverLimit(t *testing.T) {
	cfg := config.Default()
	cfg.API.Auth.MaxAttempts = 2
	cfg.API.Auth.WindowMinutes = 5
	limiter := newAuthRateLimiter(cfg)

	limiter.checkRateLimit("testuser")
	limiter.checkRateLimit("testuser")

	allowed, remaining := limiter.checkRateLimit("testuser")
	if allowed {
		t.Error("third attempt should be blocked")
	}
	if remaining != 0 {
		t.Errorf("remaining = %d, want 0", remaining)
	}
}

func TestRateLimiter_SeparateUsers(t *testing.T) {
	cfg := config.Default()
	cfg.API.Auth.MaxAttempts = 1
	cfg.API.Auth.WindowMinutes = 5
	limiter := newAuthRateLimiter(cfg)

	limiter.checkRateLimit("user1")

	// user2 should still be allowed
	allowed, _ := limiter.checkRateLimit("user2")
	if !allowed {
		t.Error("different user should have separate limit")
	}
}

func TestRateLimiter_Cleanup(t *testing.T) {
	cfg := config.Default()
	cfg.API.Auth.MaxAttempts = 1
	cfg.API.Auth.WindowMinutes = 0 // Effectively expired immediately
	limiter := newAuthRateLimiter(cfg)

	// Add some attempts
	limiter.mu.Lock()
	limiter.attempts["old-user"] = &authAttempt{
		attempts: []time.Time{time.Now().Add(-10 * time.Minute)},
	}
	limiter.mu.Unlock()

	limiter.cleanup()

	limiter.mu.Lock()
	_, exists := limiter.attempts["old-user"]
	limiter.mu.Unlock()

	if exists {
		t.Error("cleanup should remove expired entries")
	}
}

func TestRoutesRegistered(t *testing.T) {
	s := testServer()

	routes := []struct {
		method string
		path   string
	}{
		{"GET", "/api/health"},
		{"GET", "/api/version"},
	}

	for _, r := range routes {
		req := httptest.NewRequest(r.method, r.path, nil)
		w := httptest.NewRecorder()
		s.mux.ServeHTTP(w, req)

		if w.Code == 404 {
			t.Errorf("route %s %s returned 404 — not registered", r.method, r.path)
		}
	}
}

func TestHandleYouEyeConfig_MethodNotAllowed(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("DELETE", "/api/config", nil)
	w := httptest.NewRecorder()

	s.handleYouEyeConfig(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleUpdateSelf_MethodNotAllowed(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/update/self", nil)
	w := httptest.NewRecorder()

	s.handleUpdateSelf(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleUpdateControl_MethodNotAllowed(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/update/control", nil)
	w := httptest.NewRecorder()

	s.handleUpdateControl(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

// ─── /api/status ─────────────────────────────────────────────────────────────

func TestHandleStatus_Returns200(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/status", nil)
	w := httptest.NewRecorder()

	s.handleStatus(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}

	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
}

func TestHandleStatus_ContainsSpineVersion(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/status", nil)
	w := httptest.NewRecorder()

	s.handleStatus(w, req)

	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body) //nolint:errcheck

	spine, ok := body["spine"].(map[string]interface{})
	if !ok {
		t.Fatalf("body[\"spine\"] not a map: %v", body["spine"])
	}
	if spine["version"] != "0.2.6.1" {
		t.Errorf("spine.version = %v, want %q", spine["version"], "0.2.6.1")
	}
}

func TestHandleStatus_ContentType(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/status", nil)
	w := httptest.NewRecorder()

	s.handleStatus(w, req)

	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

// ─── /api/updates/check ───────────────────────────────────────────────────────

func TestHandleUpdatesCheck_Returns200(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/updates/check", nil)
	w := httptest.NewRecorder()

	s.handleUpdatesCheck(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

func TestHandleUpdatesCheck_ResponseShape(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/updates/check", nil)
	w := httptest.NewRecorder()

	s.handleUpdatesCheck(w, req)

	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}

	// Required top-level keys
	for _, key := range []string{"checked_at", "spine", "control", "ui", "incus", "system", "apps"} {
		if _, ok := body[key]; !ok {
			t.Errorf("response missing key %q", key)
		}
	}
}

func TestHandleUpdatesCheck_SpineHasCurrentVersion(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("GET", "/api/updates/check", nil)
	w := httptest.NewRecorder()

	s.handleUpdatesCheck(w, req)

	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body) //nolint:errcheck

	spineRaw, ok := body["spine"]
	if !ok {
		t.Fatal("body[\"spine\"] missing")
	}
	spine, ok := spineRaw.(map[string]interface{})
	if !ok {
		t.Fatalf("body[\"spine\"] not a map: %T", spineRaw)
	}
	if spine["current"] != "0.2.6.1" {
		t.Errorf("spine.current = %v, want %q", spine["current"], "0.2.6.1")
	}
}

func TestHandleUpdatesCheck_MethodNotAllowed_POST(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("POST", "/api/updates/check", nil)
	w := httptest.NewRecorder()

	s.handleUpdatesCheck(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/updates/check = %d, want 405", w.Code)
	}
}

// ─── /api/config ─────────────────────────────────────────────────────────────

// setupTestConfig overrides youeyeConfigPath to a temp file for the duration of the test.
// Returns a cleanup function that restores the original path.
func setupTestConfig(t *testing.T, content string) func() {
	t.Helper()
	orig := youeyeConfigPath
	dir := t.TempDir()
	tmpPath := filepath.Join(dir, "youeye.yaml")
	if content != "" {
		if err := os.WriteFile(tmpPath, []byte(content), 0644); err != nil {
			t.Fatalf("setupTestConfig: %v", err)
		}
	}
	youeyeConfigPath = tmpPath
	return func() { youeyeConfigPath = orig }
}

func TestHandleYouEyeConfig_GET_Returns200(t *testing.T) {
	cleanup := setupTestConfig(t, "site_name: TestSite\ndomain: example.com\n")
	defer cleanup()

	s := testServer()
	req := httptest.NewRequest("GET", "/api/config", nil)
	w := httptest.NewRecorder()

	s.handleYouEyeConfig(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}

	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if body["site_name"] != "TestSite" {
		t.Errorf("site_name = %v, want %q", body["site_name"], "TestSite")
	}
}

func TestHandleYouEyeConfig_GET_DefaultsWhenNoFile(t *testing.T) {
	cleanup := setupTestConfig(t, "") // empty — file does not exist
	defer cleanup()
	os.Remove(youeyeConfigPath) // ensure file is gone

	s := testServer()
	req := httptest.NewRequest("GET", "/api/config", nil)
	w := httptest.NewRecorder()

	s.handleYouEyeConfig(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}

	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body) //nolint:errcheck
	if body["site_name"] != "YouEye" {
		t.Errorf("default site_name = %v, want %q", body["site_name"], "YouEye")
	}
}

func TestHandleYouEyeConfig_PATCH_UpdatesSiteName(t *testing.T) {
	cleanup := setupTestConfig(t, "site_name: Original\ndomain: test.local\nsubdomains:\n  control: control\n  auth: auth\n  dns: dns\n")
	defer cleanup()

	s := testServer()
	body := `{"site_name": "Patched"}`
	req := httptest.NewRequest("PATCH", "/api/config", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.handleYouEyeConfig(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp) //nolint:errcheck
	if resp["status"] != "updated" {
		t.Errorf("status = %v, want %q", resp["status"], "updated")
	}

	// Verify the file was actually updated
	verify := httptest.NewRequest("GET", "/api/config", nil)
	vw := httptest.NewRecorder()
	s.handleYouEyeConfig(vw, verify)
	var vBody map[string]interface{}
	json.NewDecoder(vw.Body).Decode(&vBody) //nolint:errcheck
	if vBody["site_name"] != "Patched" {
		t.Errorf("after PATCH, site_name = %v, want %q", vBody["site_name"], "Patched")
	}
}

func TestHandleYouEyeConfig_PATCH_InvalidBody(t *testing.T) {
	cleanup := setupTestConfig(t, "")
	defer cleanup()

	s := testServer()
	req := httptest.NewRequest("PATCH", "/api/config", strings.NewReader("not valid json{{{"))
	w := httptest.NewRecorder()

	s.handleYouEyeConfig(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestHandleYouEyeConfig_MethodDelete_NotAllowed(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("DELETE", "/api/config", nil)
	w := httptest.NewRecorder()

	s.handleYouEyeConfig(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", w.Code)
	}
}
