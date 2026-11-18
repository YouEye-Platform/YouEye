package setuppage

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/boxca"
)

func writeState(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestReadStatusMapsEveryState(t *testing.T) {
	cases := []struct {
		progress string
		complete bool
		state    string
	}{
		{"", false, "running"},
		{`{"state":"running","stage":"database","detail":"Setting up","percent":62,"attempt":1}`, false, "running"},
		{`{"state":"retrying","stage":"retrying","percent":40,"attempt":2}`, false, "retrying"},
		{`{"state":"running","stage":"system_restart","percent":28,"attempt":1}`, false, "restarting"},
		{`{"state":"needs_attention","stage":"needs_attention","percent":99,"attempt":8}`, false, "needs_attention"},
		{`{"state":"running","stage":"setup","percent":98,"attempt":1}`, false, "complete"},
		{`{"state":"complete","stage":"complete","percent":100,"attempt":1}`, true, "complete"},
	}
	for _, c := range cases {
		root := t.TempDir()
		if c.progress != "" {
			writeState(t, root, "first-deploy/progress.json", c.progress)
		}
		if c.complete {
			writeState(t, root, "first-deploy/complete", "")
		}
		got := ReadStatus(root, nil)
		if got.State != c.state {
			t.Errorf("progress %s: state %q, want %q", c.progress, got.State, c.state)
		}
		if got.MaxAttempts != MaxAttempts || got.Log == nil {
			t.Errorf("progress %s: incomplete status %+v", c.progress, got)
		}
	}
}

func TestReadStatusNetwork(t *testing.T) {
	root := t.TempDir()
	writeState(t, root, "bootstrap/network-status.json", `{"phase":"checking","error_code":"dns_unavailable","detail":"DNS cannot resolve the selected release source"}`)
	got := ReadStatus(root, nil).Network
	if !got.Online || got.DNS || got.Problem == "" {
		t.Fatalf("dns problem: %+v", got)
	}
	writeState(t, root, "bootstrap/network-status.json", `{"phase":"needs_attention","error_code":"link_down","detail":"The wired adapter has no link"}`)
	if got := ReadStatus(root, nil).Network; got.Online || got.DNS {
		t.Fatalf("link down: %+v", got)
	}
	writeState(t, root, "bootstrap/network-status.json", `{"phase":"ready"}`)
	if got := ReadStatus(root, nil).Network; !got.Online || !got.DNS || got.Problem != "" {
		t.Fatalf("ready: %+v", got)
	}
}

func TestRedactHidesSecrets(t *testing.T) {
	cases := map[string]string{
		"POSTGRES_PASSWORD=hunter2 started":                         "hunter2",
		`{"token":"abc123def"}`:                                     "abc123def",
		"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload":        "eyJhbGciOiJIUzI1NiJ9",
		"fetch https://user:pa55word@example.com/x":                 "pa55word",
		"X-Deploy-Secret: 0f3c9a7b5e1d2f4a6c8e0b1d3f5a7c9e1b3d5f7a": "0f3c9a7b5e1d2f4a6c8e0b1d3f5a7c9e1b3d5f7a",
		"-----BEGIN EC PRIVATE KEY----- MHcCAQEE":                   "MHcCAQEE",
		"api_key: sk-live-123456":                                   "sk-live-123456",
	}
	for line, secret := range cases {
		if got := Redact(line); strings.Contains(got, secret) {
			t.Errorf("Redact(%q) = %q still shows the secret", line, got)
		}
	}
	if got := Redact("  ✓ [2/5] Caddy deployed\x1b[0m"); got != "✓ [2/5] Caddy deployed[0m" {
		t.Errorf("plain line changed: %q", got)
	}
	if got := Redact(strings.Repeat("a ", 300)); len(got) > 250 {
		t.Errorf("long line not cut: %d", len(got))
	}
}

func newTestHandler(t *testing.T, root string, retry func(context.Context) error) *Handler {
	t.Helper()
	return NewHandler(Config{
		StateRoot:  root,
		Journal:    func(context.Context) []string { return []string{"step one", "PASSWORD=x1y2z3"} },
		Retry:      retry,
		LocalName:  func(context.Context) string { return "youeye-2.local" },
		LANAddress: func() string { return "192.168.31.24" },
	})
}

func TestHandlerServesStatusAndPage(t *testing.T) {
	root := t.TempDir()
	writeState(t, root, "first-deploy/progress.json", `{"state":"running","stage":"ui","detail":"Installing the YouEye UI","percent":84,"attempt":1}`)
	h := newTestHandler(t, root, nil)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, boxRequest(http.MethodGet, "/api/preparing", nil))
	if rec.Code != 200 || rec.Header().Get("Connection") != "close" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status response %d %v", rec.Code, rec.Header())
	}
	var status Status
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Stage != "ui" || status.Percent != 84 || status.Addresses.Local != "youeye-2.local" || status.Addresses.IP != "192.168.31.24" {
		t.Fatalf("status %+v", status)
	}
	if strings.Contains(strings.Join(status.Log, "\n"), "x1y2z3") {
		t.Fatal("journal secret reached the page")
	}

	for _, path := range []string{"/", "/login", "/setup?x=1"} {
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, boxRequest(http.MethodGet, path, nil))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Preparing YouEye") || rec.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("%s: %d %q", path, rec.Code, rec.Body.String()[:40])
		}
	}
	// Only the Control Panel answers /api/ping with 200: the page's switch.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, boxRequest(http.MethodGet, "/api/ping", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("/api/ping = %d", rec.Code)
	}
	for _, asset := range []string{"/_preparing/preparing.js", "/_preparing/preparing.css", "/_preparing/logo.svg"} {
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, boxRequest(http.MethodGet, asset, nil))
		if rec.Code != 200 {
			t.Fatalf("%s = %d", asset, rec.Code)
		}
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, boxRequest(http.MethodGet, "/_preparing/../../etc/passwd", nil))
	if rec.Code == 200 && !strings.Contains(rec.Body.String(), "Preparing YouEye") {
		t.Fatal("path escape")
	}
}

func TestRetryOnlyWhenNeedsAttention(t *testing.T) {
	root := t.TempDir()
	writeState(t, root, "first-deploy/progress.json", `{"state":"running","stage":"ui","percent":84,"attempt":1}`)
	retries := 0
	h := newTestHandler(t, root, func(context.Context) error { retries++; return nil })
	post := func(header bool) int {
		req := boxRequest(http.MethodPost, "/api/preparing/retry", nil)
		if header {
			req.Header.Set("X-YouEye-Preparing", "retry")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := post(true); code != http.StatusConflict {
		t.Fatalf("retry while running = %d", code)
	}
	writeState(t, root, "first-deploy/progress.json", `{"state":"needs_attention","stage":"needs_attention","percent":99,"attempt":8}`)
	if code := post(false); code != http.StatusForbidden {
		t.Fatalf("retry without header = %d", code)
	}
	if code := post(true); code != http.StatusAccepted || retries != 1 {
		t.Fatalf("retry = %d (%d)", code, retries)
	}
	if code := post(true); code != http.StatusTooManyRequests || retries != 1 {
		t.Fatalf("second retry = %d (%d)", code, retries)
	}
	h.cfg.Now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	h.cfg.Retry = func(context.Context) error { return errors.New("boom") }
	if code := post(true); code != http.StatusInternalServerError {
		t.Fatalf("failing retry = %d", code)
	}
	req := boxRequest(http.MethodGet, "/api/preparing/retry", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET retry = %d", rec.Code)
	}
}

func TestIsSetupName(t *testing.T) {
	for name, want := range map[string]bool{"youeye.local": true, "youeye-2.local": true, "a.b.local": false, ".local": false, "youeye.example": false, "YOUEYE.local": false, "foo.local": false, "youeye-x.local": false} {
		if got := IsSetupName(name); got != want {
			t.Errorf("IsSetupName(%q) = %v", name, got)
		}
	}
}

func TestRunServesAndStopsWhenComplete(t *testing.T) {
	stateRoot := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Config{StateRoot: stateRoot, CADir: filepath.Join(stateRoot, "tls"), HTTPAddr: "127.0.0.1:18080", HTTPSAddr: "127.0.0.1:18443"})
	}()
	var resp *http.Response
	var err error
	for i := 0; i < 50; i++ {
		if resp, err = http.Get("http://127.0.0.1:18080/api/preparing"); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	var running Status
	_ = json.NewDecoder(resp.Body).Decode(&running)
	resp.Body.Close()
	if len(running.CAFingerprint) != 95 {
		t.Fatalf("CA fingerprint %q", running.CAFingerprint)
	}
	if !resp.Close {
		t.Fatal("response did not close the connection")
	}
	// HTTPS: the leaf chains to the box CA for the IP and youeye.local.
	root, err := boxca.Load(filepath.Join(stateRoot, "tls"))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(root.Cert)
	for _, serverName := range []string{"", "youeye.local"} {
		client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: serverName}}}
		resp, err := client.Get("https://127.0.0.1:18443/")
		if err != nil {
			t.Fatalf("HTTPS (%q): %v", serverName, err)
		}
		resp.Body.Close()
	}
	writeState(t, stateRoot, "first-deploy/complete", "")
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("server kept running after first deployment completed")
	}
}

// boxRequest is a request addressed to the box's IP, as browsers on the LAN send it.
func boxRequest(method, target string, body io.Reader) *http.Request {
	req := httptest.NewRequest(method, target, body)
	req.Host = "192.168.31.24"
	return req
}

func TestHandlerRefusesOtherHosts(t *testing.T) {
	h := newTestHandler(t, t.TempDir(), nil)
	for host, want := range map[string]int{
		"192.168.31.24": 200, "192.168.31.24:80": 200, "youeye.local": 200, "youeye-2.local:443": 200, "localhost:47080": 200,
		"attacker.example": http.StatusMisdirectedRequest, "evil.local": http.StatusMisdirectedRequest, "[fd00::1]": http.StatusMisdirectedRequest,
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/preparing", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("Host %q = %d, want %d", host, rec.Code, want)
		}
	}
}

func TestJournalReadAtMostOncePerSecond(t *testing.T) {
	calls := 0
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	h := NewHandler(Config{StateRoot: t.TempDir(), Now: func() time.Time { return now },
		Journal: func(context.Context) []string { calls++; return []string{"line"} }})
	for i := 0; i < 5; i++ {
		h.ServeHTTP(httptest.NewRecorder(), boxRequest(http.MethodGet, "/api/preparing", nil))
	}
	now = now.Add(1100 * time.Millisecond)
	h.ServeHTTP(httptest.NewRecorder(), boxRequest(http.MethodGet, "/api/preparing", nil))
	if calls != 2 {
		t.Fatalf("journal read %d times, want 2", calls)
	}
}
