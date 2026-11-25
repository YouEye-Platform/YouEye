package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/config"
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
	if body["service"] != "youeye" {
		t.Errorf("service = %q, want %q", body["service"], "youeye")
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
	if s.pamGate == nil {
		t.Error("pamGate should not be nil")
	}
}

func TestPrepareSocketPathRefusesReachableListener(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "youeye.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	if err := prepareSocketPath(socketPath); err == nil || !strings.Contains(err.Error(), "already served") {
		t.Fatalf("prepareSocketPath error = %v, want active-listener refusal", err)
	}
	if _, err := os.Stat(socketPath); err != nil {
		t.Fatalf("active socket path was removed: %v", err)
	}
}

func TestPrepareSocketPathRemovesStaleSocket(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "youeye.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	unixListener, ok := listener.(*net.UnixListener)
	if !ok {
		t.Fatal("expected Unix listener")
	}
	unixListener.SetUnlinkOnClose(false)
	listener.Close()

	if err := prepareSocketPath(socketPath); err != nil {
		t.Fatalf("prepareSocketPath rejected stale path: %v", err)
	}
	if _, err := os.Stat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("stale socket path remains: %v", err)
	}
}

func TestPrepareSocketPathRefusesUnexpectedFile(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "youeye.sock")
	if err := os.WriteFile(socketPath, []byte("do not remove"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareSocketPath(socketPath); err == nil || !strings.Contains(err.Error(), "non-socket") {
		t.Fatalf("unexpected-file result = %v", err)
	}
	if raw, err := os.ReadFile(socketPath); err != nil || string(raw) != "do not remove" {
		t.Fatalf("unexpected file was changed: %q %v", raw, err)
	}
}

func TestSocketOwnershipPreventsConcurrentStaleProbe(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "youeye.sock")
	owner, err := acquireSocketOwnership(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	if err := prepareSocketPath(socketPath); err == nil || !strings.Contains(err.Error(), "ownership") {
		t.Fatalf("concurrent prepare result = %v", err)
	}
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("owned listener became unreachable: %v", err)
	}
	conn.Close()
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
	subdomains, ok := body["subdomains"].(map[string]interface{})
	if !ok {
		t.Fatalf("subdomains missing or invalid: %v", body["subdomains"])
	}
	if subdomains["identity"] != "id" {
		t.Errorf("default identity subdomain = %v, want %q", subdomains["identity"], "id")
	}
	if subdomains["auth"] == "auth" {
		t.Errorf("default auth subdomain should not be restored after Authentik removal")
	}
}

func TestHandleYouEyeConfig_PATCHAtomicallyProtectsConfig(t *testing.T) {
	cleanup := setupTestConfig(t, "site_name: Before\n")
	defer cleanup()

	s := testServer()
	req := httptest.NewRequest(http.MethodPatch, "/api/config", strings.NewReader(`{"site_name":"After"}`))
	w := httptest.NewRecorder()
	s.handleYouEyeConfig(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	info, err := os.Stat(youeyeConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("config mode = %04o, want 0600", info.Mode().Perm())
	}
	entries, err := os.ReadDir(filepath.Dir(youeyeConfigPath))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".youeye.yaml.") {
			t.Fatalf("temporary config remains: %s", entry.Name())
		}
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

func TestHandleAuthVerify_RefusesBadUsername(t *testing.T) {
	s := testServer()
	checked := 0
	s.pamGate.check = func(context.Context, string, string) bool { checked++; return true }
	for _, name := range []string{strings.Repeat("a", 33), "-v", "--help", "a b", "ad.min", "owner;id"} {
		body, _ := json.Marshal(map[string]string{"username": name, "password": "secret"})
		w := httptest.NewRecorder()
		s.handleAuthVerify(w, httptest.NewRequest("POST", "/api/auth/verify", bytes.NewReader(body)))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%q: status = %d, want 400", name, w.Code)
		}
	}
	if checked != 0 {
		t.Fatalf("PAM was asked %d times about names no account can have", checked)
	}
	s.pamGate.mu.Lock()
	keys := len(s.pamGate.failures)
	s.pamGate.mu.Unlock()
	if keys != 0 {
		t.Fatalf("the gate keeps %d keys for refused names", keys)
	}
	for _, name := range []string{"owner", "Owner_1", "a", "_svc", strings.Repeat("x", 32)} {
		body, _ := json.Marshal(map[string]string{"username": name, "password": "secret"})
		w := httptest.NewRecorder()
		s.handleAuthVerify(w, httptest.NewRequest("POST", "/api/auth/verify", bytes.NewReader(body)))
		if w.Code != http.StatusOK {
			t.Errorf("%q: status = %d, want 200", name, w.Code)
		}
	}
}

func TestHandleAuthVerify_BodyOver4KiB(t *testing.T) {
	s := testServer()
	checked := 0
	s.pamGate.check = func(context.Context, string, string) bool { checked++; return true }
	body := `{"username":"owner","password":"` + strings.Repeat("p", 10*1024) + `"}`
	w := httptest.NewRecorder()
	s.handleAuthVerify(w, httptest.NewRequest("POST", "/api/auth/verify", strings.NewReader(body)))
	if w.Code != http.StatusBadRequest || checked != 0 {
		t.Fatalf("10 KiB body: status = %d, checks %d; want 400 and none", w.Code, checked)
	}
}
