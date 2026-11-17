// Package setuppage serves the "Preparing YouEye" page during first
// deployment. The setup gate redirects the box's ports 80 and 443 to it until
// first deployment opens setup; then the server stops (closing every
// connection) and the same address shows the claim page.
package setuppage

import (
	"context"
	"crypto/tls"
	"embed"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/boxca"
)

//go:embed assets/*
var assets embed.FS

// Config wires the server to the box (tests replace the functions).
type Config struct {
	StateRoot string
	CADir     string
	HTTPAddr  string
	HTTPSAddr string
	// Journal returns the last lines of the first-deploy journal.
	Journal func(ctx context.Context) []string
	// Retry starts first deployment again after needs_attention.
	Retry func(ctx context.Context) error
	// LocalName returns the published mDNS name ("" when unknown).
	LocalName func(ctx context.Context) string
	// LANAddress returns the box's LAN IPv4 address ("" when unknown).
	LANAddress func() string
	Now        func() time.Time
	// RetryInterval limits POST /api/preparing/retry.
	RetryInterval time.Duration
}

// Handler serves the page and its API.
type Handler struct {
	cfg       Config
	mu        sync.Mutex
	lastRetry time.Time
	nameAt    time.Time
	name      string
	// The journal is read at most once a second, however many browsers poll.
	journalMu    sync.Mutex
	journalAt    time.Time
	journalLines []string
	fingerprint  string
}

// NewHandler returns the page's HTTP handler.
func NewHandler(cfg Config) *Handler {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.RetryInterval == 0 {
		cfg.RetryInterval = time.Minute
	}
	return &Handler{cfg: cfg}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	if !allowedHost(r.Host) {
		// Only the box's own addresses: a DNS-rebinding page can't read the
		// status or press Retry through another name.
		header.Set("Connection", "close")
		http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
		return
	}
	// Every response closes its connection, so no browser keeps a connection
	// to this server alive past the switch to the Control Panel.
	header.Set("Connection", "close")
	header.Set("Cache-Control", "no-store")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Frame-Options", "DENY")
	switch {
	case r.URL.Path == "/api/preparing":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.serveStatus(w, r)
	case r.URL.Path == "/api/preparing/retry":
		h.serveRetry(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/"):
		// The page probes a Control Panel path (/api/ping); only the Control
		// Panel answers it with 200.
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "YouEye is still being prepared"})
	case strings.HasPrefix(r.URL.Path, "/_preparing/"):
		h.serveAsset(w, r, strings.TrimPrefix(r.URL.Path, "/_preparing/"))
	default:
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "YouEye is still being prepared", http.StatusServiceUnavailable)
			return
		}
		h.serveAsset(w, r, "index.html")
	}
}

func (h *Handler) serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	types := map[string]string{
		"index.html":    "text/html; charset=utf-8",
		"preparing.js":  "text/javascript; charset=utf-8",
		"preparing.css": "text/css; charset=utf-8",
		"logo.svg":      "image/svg+xml",
	}
	kind, ok := types[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	raw, err := assets.ReadFile("assets/" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(raw)
	}
}

func (h *Handler) status(ctx context.Context) Status {
	status := ReadStatus(h.cfg.StateRoot, h.journal(ctx))
	status.CAFingerprint = h.fingerprint
	if h.cfg.LANAddress != nil {
		status.Addresses.IP = h.cfg.LANAddress()
	}
	status.Addresses.Local = h.localName(ctx)
	return status
}

func (h *Handler) journal(ctx context.Context) []string {
	if h.cfg.Journal == nil {
		return nil
	}
	h.journalMu.Lock()
	defer h.journalMu.Unlock()
	if now := h.cfg.Now(); h.journalAt.IsZero() || now.Sub(h.journalAt) >= time.Second {
		h.journalLines, h.journalAt = h.cfg.Journal(ctx), now
	}
	return h.journalLines
}

// allowedHost: an IPv4 literal, the box's mDNS name or loopback, with an
// optional port.
func allowedHost(host string) bool {
	name := strings.ToLower(host)
	if h, _, err := net.SplitHostPort(name); err == nil {
		name = h
	}
	if ip := net.ParseIP(name); ip != nil {
		return ip.To4() != nil
	}
	return name == "localhost" || IsSetupName(name)
}

func (h *Handler) localName(ctx context.Context) string {
	if h.cfg.LocalName == nil {
		return ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if now := h.cfg.Now(); now.Sub(h.nameAt) > 10*time.Second {
		h.name, h.nameAt = h.cfg.LocalName(ctx), now
	}
	return h.name
}

func (h *Handler) serveStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.status(r.Context()))
}

func (h *Handler) serveRetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// A custom header can't be sent cross-origin without a CORS preflight,
	// which this server never allows: other sites can't press Retry.
	if r.Header.Get("X-YouEye-Preparing") != "retry" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "missing request header"})
		return
	}
	status := ReadStatus(h.cfg.StateRoot, nil)
	if status.State != "needs_attention" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "first deployment is not waiting for a retry"})
		return
	}
	h.mu.Lock()
	now := h.cfg.Now()
	if !h.lastRetry.IsZero() && now.Sub(h.lastRetry) < h.cfg.RetryInterval {
		h.mu.Unlock()
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "a retry was started a moment ago"})
		return
	}
	h.lastRetry = now
	h.mu.Unlock()
	if h.cfg.Retry == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "retry is not available"})
		return
	}
	if err := h.cfg.Retry(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "first deployment could not be restarted"})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"state": "retrying"})
}

func writeJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

// Complete reports whether first deployment finished.
func Complete(stateRoot string) bool {
	info, err := os.Stat(filepath.Join(stateRoot, "first-deploy/complete"))
	return err == nil && info.Mode().IsRegular()
}

// Run serves HTTP and HTTPS until ctx ends or first deployment is complete,
// then shuts both servers down (closing kept-alive connections).
func Run(ctx context.Context, cfg Config) error {
	if Complete(cfg.StateRoot) {
		return nil
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	root, err := boxca.Ensure(cfg.CADir, cfg.Now())
	if err != nil {
		return err
	}
	handler := NewHandler(cfg)
	handler.fingerprint = boxca.Fingerprint(root.Cert)
	certs := &leafCache{root: root, now: cfg.Now, local: cfg.LocalName, leaves: map[string]*tls.Certificate{}}
	plain := &http.Server{Addr: cfg.HTTPAddr, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Second}
	secure := &http.Server{
		Addr: cfg.HTTPSAddr, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Second,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: certs.get},
	}
	plain.SetKeepAlivesEnabled(false)
	secure.SetKeepAlivesEnabled(false)
	plainListener, err := net.Listen("tcp", cfg.HTTPAddr)
	if err != nil {
		return err
	}
	secureListener, err := net.Listen("tcp", cfg.HTTPSAddr)
	if err != nil {
		plainListener.Close()
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errs := make(chan error, 2)
	go func() { errs <- plain.Serve(plainListener) }()
	go func() { errs <- secure.ServeTLS(secureListener, "", "") }()
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if Complete(cfg.StateRoot) {
					cancel()
					return
				}
			}
		}
	}()
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-errs:
	}
	shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	_ = plain.Shutdown(shutdown)
	_ = secure.Shutdown(shutdown)
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		return serveErr
	}
	return nil
}

// leafCache makes one leaf per host name or IP a browser asks for.
type leafCache struct {
	root   *boxca.Root
	now    func() time.Time
	local  func(context.Context) string
	mu     sync.Mutex
	leaves map[string]*tls.Certificate
}

func (c *leafCache) get(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	host := strings.ToLower(strings.TrimSuffix(hello.ServerName, "."))
	if host != "" && !IsSetupName(host) {
		// Only the box's local names get a certificate; anything else gets
		// the youeye.local one (the browser will warn either way).
		host = ""
	}
	address := ""
	if hello.Conn != nil {
		if tcp, ok := hello.Conn.LocalAddr().(*net.TCPAddr); ok && tcp.IP.To4() != nil {
			address = tcp.IP.To4().String()
		}
	}
	key := host + "|" + address
	c.mu.Lock()
	defer c.mu.Unlock()
	if leaf, ok := c.leaves[key]; ok && c.now().Before(leaf.Leaf.NotAfter.Add(-time.Hour)) {
		return leaf, nil
	}
	hosts := []string{"youeye.local"}
	if host != "" && host != "youeye.local" {
		hosts = append(hosts, host)
	}
	if address != "" {
		hosts = append(hosts, address)
	}
	leaf, err := c.root.Leaf(hosts, c.now())
	if err != nil {
		return nil, err
	}
	if len(c.leaves) > 32 {
		c.leaves = map[string]*tls.Certificate{}
	}
	c.leaves[key] = &leaf
	return &leaf, nil
}

var setupName = regexp.MustCompile(`^youeye(-[0-9]{1,4})?\.local$`)

// IsSetupName reports whether name is one of the box's mDNS names
// (youeye.local, or youeye-2.local … after a conflict).
func IsSetupName(name string) bool { return setupName.MatchString(name) }
