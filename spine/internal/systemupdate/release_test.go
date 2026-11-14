package systemupdate

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Release files are checked by digest, so any HTTPS host may serve them.
func TestSystemUpdateRedirectsAnyHTTPSHost(t *testing.T) {
	origin, _ := http.NewRequest("GET", "https://github.com/example/project/releases/download/v1/manifest.json", nil)
	cases := []struct {
		url     string
		allowed bool
	}{
		{"https://release-assets.githubusercontent.com/asset?sig=example&jwt=example", true},
		{"https://objects.githubusercontent.com/asset?sig=example", true},
		{"https://cdn.example.test/youeye/asset", true},
		{"https://mirror.example.test:8443/asset?sig=example", true},
		{"http://release-assets.githubusercontent.com/asset?sig=example", false},
		{"https://user:pass@release-assets.githubusercontent.com/asset?sig=example", false},
		{"https://release-assets.githubusercontent.com/asset?sig=example#fragment", false},
		{"https://api.github.com/repos/example/project/releases", false},
		{"https://forge.example.test/api/v1/repos/o/r/releases", false},
	}
	for _, tc := range cases {
		t.Run(tc.url, func(t *testing.T) {
			req, _ := http.NewRequest("GET", tc.url, nil)
			if err := validateSystemUpdateRedirect(req, []*http.Request{origin}); (err == nil) != tc.allowed {
				t.Fatalf("redirect allowed=%v: %v", tc.allowed, err)
			}
		})
	}
	// The original URL itself stays exact: no query, no credentials.
	for _, raw := range []string{"https://github.com/o/r/releases/download/t/a?x=1", "https://u:p@github.com/o/r/releases/download/t/a"} {
		req, _ := http.NewRequest("GET", raw, nil)
		if validateSystemUpdateRedirect(req, nil) == nil {
			t.Fatalf("inexact initial URL accepted: %s", raw)
		}
	}
	other, _ := http.NewRequest("GET", "http://forge.example.test/manifest.json", nil)
	req, _ := http.NewRequest("GET", "http://cdn.example.test/asset", nil)
	if validateSystemUpdateRedirect(req, []*http.Request{other}) != nil {
		t.Fatal("plain HTTP origin may redirect over HTTP (tests and local forges)")
	}
}

type signedRedirectTransport func(*http.Request) (*http.Response, error)

func (f signedRedirectTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestDownloadFollowsSignedGitHubRedirect(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HTTPClient.Transport = signedRedirectTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "github.com" {
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://release-assets.githubusercontent.com/asset?sig=test"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("signed metadata")), Request: r}, nil
	})
	m := &Manager{config: cfg}
	path := filepath.Join(t.TempDir(), "metadata")
	if err := m.downloadHTTP(context.Background(), "https://github.com/example/project/releases/download/v1/manifest.json", path, 1024); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "signed metadata" {
		t.Fatalf("download=%q err=%v", got, err)
	}
}
