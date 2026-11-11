package systemupdate

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseSourceRejectsUnsafeProviders(t *testing.T) {
	for _, tc := range []struct{ provider, api string }{
		{"custom", "http://updates.test/releases"},
		{"forgejo", ""},
		{"unknown", "https://updates.test/releases"},
	} {
		if _, _, err := normalizeReleaseSource(tc.provider, tc.api); err == nil {
			t.Fatalf("unsafe release source accepted: %+v", tc)
		}
	}
}

func TestValidateReleaseAssetURLRejectsAttachmentAndEncodedSlash(t *testing.T) {
	api, err := url.Parse(DefaultReleasesAPI)
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		"https://github.com/YouEye-Platform/YouEye/attachments/uuid",
		"https://github.com/YouEye-Platform/YouEye/releases/download/appliance-dev-v1.2.3/nested%2Fsystem-update-manifest.json",
		"https://github.com/another/YouEye/releases/download/appliance-dev-v1.2.3/system-update-manifest.json",
	} {
		if err := validateReleaseAssetURL("github", api, "appliance-dev-v1.2.3", "system-update-manifest.json", raw); err == nil {
			t.Fatalf("unsafe asset URL accepted: %s", raw)
		}
	}
}

func TestValidateReleaseAssetURLAllowsEncodedSlashOnlyInsideSafeReleaseTag(t *testing.T) {
	api, err := url.Parse(DefaultReleasesAPI)
	if err != nil {
		t.Fatal(err)
	}
	tag := "appliance-codex/phase1-repository-builds-v1.2.3"
	raw := "https://github.com/YouEye-Platform/YouEye/releases/download/appliance-codex%2Fphase1-repository-builds-v1.2.3/system-update-manifest.json"
	if err := validateReleaseAssetURL("github", api, tag, "system-update-manifest.json", raw); err != nil {
		t.Fatalf("encoded multi-segment release tag was rejected: %v", err)
	}
}

func TestSystemUpdateRedirectsStayOnTheReleaseOrigin(t *testing.T) {
	request := func(raw string) *http.Request {
		req, err := http.NewRequest(http.MethodGet, raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		return req
	}
	githubOrigin := request("https://github.com/YouEye-Platform/YouEye/releases/download/tag/system-update-manifest.json")
	if err := validateSystemUpdateRedirect(request("https://release-assets.githubusercontent.com/asset"), []*http.Request{githubOrigin}); err != nil {
		t.Fatalf("trusted GitHub release redirect rejected: %v", err)
	}
	if err := validateSystemUpdateRedirect(request("https://untrusted.example/asset"), []*http.Request{githubOrigin}); err == nil {
		t.Fatal("cross-origin GitHub redirect was accepted")
	}
	forgejoOrigin := request("https://forgejo.example.test/owner/repo/releases/download/tag/system-update-manifest.json")
	if err := validateSystemUpdateRedirect(request("https://cdn.example.test/asset"), []*http.Request{forgejoOrigin}); err == nil {
		t.Fatal("cross-origin Forgejo redirect was accepted")
	}
}

func TestSignedGitHubDownloadRedirects(t *testing.T) {
	origin, _ := http.NewRequest("GET", "https://github.com/example/project/releases/download/v1/manifest.json", nil)
	cases := []struct {
		url     string
		allowed bool
	}{
		{"https://release-assets.githubusercontent.com/asset?sig=example&jwt=example", true},
		{"https://objects.githubusercontent.com/asset?sig=example", true},
		{"https://release-assets.githubusercontent.com:8443/asset?sig=example", false},
		{"http://release-assets.githubusercontent.com/asset?sig=example", false},
		{"https://release-assets.githubusercontent.com.evil.test/asset?sig=example", false},
		{"https://user:pass@release-assets.githubusercontent.com/asset?sig=example", false},
		{"https://release-assets.githubusercontent.com/asset?sig=example#fragment", false},
		{"https://github.com/example/project?sig=example", false},
	}
	for _, tc := range cases {
		t.Run(tc.url, func(t *testing.T) {
			req, _ := http.NewRequest("GET", tc.url, nil)
			if err := validateSystemUpdateRedirect(req, []*http.Request{origin}); (err == nil) != tc.allowed {
				t.Fatalf("redirect allowed=%v: %v", tc.allowed, err)
			}
			if err := validateRemoteURL(req.URL); tc.allowed && err == nil {
				t.Fatal("query-bearing initial source accepted")
			}
		})
	}
	other, _ := http.NewRequest("GET", "https://forge.example.test/manifest.json", nil)
	req, _ := http.NewRequest("GET", cases[0].url, nil)
	if validateSystemUpdateRedirect(req, []*http.Request{other}) == nil {
		t.Fatal("non-GitHub CDN redirect accepted")
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
