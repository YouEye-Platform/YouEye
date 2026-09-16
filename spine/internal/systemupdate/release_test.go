package systemupdate

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestResolveReleaseSelectsLatestChannelAndExactDigest(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "50" {
			t.Errorf("custom pagination limit = %q, want 50", r.URL.Query().Get("limit"))
		}
		if r.URL.Query().Get("page") != "1" {
			fmt.Fprint(w, `[]`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `[
		  {"tag_name":"appliance-dev-v0.5.23.0.0.12","body":"old","published_at":"2026-08-13T00:00:00Z","assets":[
		    {"name":"system-update-manifest.json","browser_download_url":%q},
		    {"name":"system-update-manifest.json.sig","browser_download_url":%q}]},
		  {"tag_name":"appliance-dev-v0.5.23.0.0.14","body":"Latest notes","published_at":"2026-08-13T02:00:00Z","assets":[
		    {"name":"system-update-manifest.json","browser_download_url":%q},
		    {"name":"system-update-manifest.json.sig","browser_download_url":%q}]},
		  {"tag_name":"appliance-v0.5.23.0.0.13","body":"Stable notes","published_at":"2026-08-13T01:00:00Z","assets":[
		    {"name":"system-update-manifest.json","browser_download_url":%q},
            {"name":"system-update-manifest.json.sig","browser_download_url":%q}]}
        ]`,
			server.URL+"/owner/YouEye/releases/download/appliance-dev-v0.5.23.0.0.12/system-update-manifest.json", server.URL+"/owner/YouEye/releases/download/appliance-dev-v0.5.23.0.0.12/system-update-manifest.json.sig",
			server.URL+"/owner/YouEye/releases/download/appliance-dev-v0.5.23.0.0.14/system-update-manifest.json", server.URL+"/owner/YouEye/releases/download/appliance-dev-v0.5.23.0.0.14/system-update-manifest.json.sig",
			server.URL+"/owner/YouEye/releases/download/appliance-v0.5.23.0.0.13/system-update-manifest.json", server.URL+"/owner/YouEye/releases/download/appliance-v0.5.23.0.0.13/system-update-manifest.json.sig")
	}))
	defer server.Close()

	options, metadata, err := ResolveRelease(context.Background(), server.Client(), ReleaseSelection{Provider: "custom", Channel: "development", ReleasesAPI: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Provider != "custom" || metadata.Tag != "appliance-dev-v0.5.23.0.0.14" || metadata.ReleaseNotes != "Latest notes" || options.ManifestSource != server.URL+"/owner/YouEye/releases/download/appliance-dev-v0.5.23.0.0.14/system-update-manifest.json" {
		t.Fatalf("development selection = %+v %+v", options, metadata)
	}

	options, metadata, err = ResolveRelease(context.Background(), server.Client(), ReleaseSelection{Provider: "custom", ReleasesAPI: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Channel != "stable" || metadata.Tag != "appliance-v0.5.23.0.0.13" || options.ManifestSource != server.URL+"/owner/YouEye/releases/download/appliance-v0.5.23.0.0.13/system-update-manifest.json" {
		t.Fatalf("default stable selection = %+v %+v", options, metadata)
	}

	digest := strings.Repeat("a", 64)
	options, metadata, err = ResolveRelease(context.Background(), server.Client(), ReleaseSelection{
		Provider: "custom", Channel: "exact", ExactTag: "appliance-v0.5.23.0.0.13", ManifestSHA256: digest, ReleasesAPI: server.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Channel != "exact" || options.ExpectedManifestSHA256 != digest || options.ReleaseTag != "appliance-v0.5.23.0.0.13" {
		t.Fatalf("exact selection = %+v %+v", options, metadata)
	}
}

func TestSelectReleaseUsesPublicationOrderAcrossVersionLineage(t *testing.T) {
	legacyPublished := time.Date(2026, 8, 10, 8, 40, 17, 0, time.UTC)
	currentPublished := time.Date(2026, 8, 13, 22, 42, 43, 0, time.UTC)
	release, err := selectRelease([]release{
		{TagName: "appliance-dev-v0.5.23.0.0.23", PublishedAt: legacyPublished},
		{TagName: "appliance-dev-v0.5.6.0.2.3", PublishedAt: currentPublished},
	}, "development", "")
	if err != nil {
		t.Fatal(err)
	}
	if release.TagName != "appliance-dev-v0.5.6.0.2.3" {
		t.Fatalf("development release = %q, want newest publication", release.TagName)
	}
}

func TestResolveReleaseCandidatesKeepsBranchTrackAndSafeOrder(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("page") != "1" {
			fmt.Fprint(response, `[]`)
			return
		}
		asset := func(tag, name string) string {
			return server.URL + "/owner/YouEye/releases/download/" + tag + "/" + name
		}
		fmt.Fprintf(response, `[
          {"tag_name":"appliance-f-test-v1.2.0","published_at":"2026-08-16T02:00:00Z","assets":[
            {"name":"system-update-manifest.json","browser_download_url":%q},
            {"name":"system-update-manifest.json.sig","browser_download_url":%q}]},
          {"tag_name":"appliance-f-test-v1.1.0","published_at":"2026-08-16T01:00:00Z","assets":[
            {"name":"system-update-manifest.json","browser_download_url":%q},
            {"name":"system-update-manifest.json.sig","browser_download_url":%q}]},
          {"tag_name":"appliance-dev-v9.0.0","published_at":"2026-08-16T03:00:00Z","assets":[]}
        ]`,
			asset("appliance-f-test-v1.2.0", "system-update-manifest.json"), asset("appliance-f-test-v1.2.0", "system-update-manifest.json.sig"),
			asset("appliance-f-test-v1.1.0", "system-update-manifest.json"), asset("appliance-f-test-v1.1.0", "system-update-manifest.json.sig"))
	}))
	defer server.Close()

	options, metadata, err := ResolveReleaseCandidates(context.Background(), server.Client(), ReleaseSelection{
		Provider: "custom", ReleasesAPI: server.URL, Channel: "branch", Branch: "f-test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(options) != 2 || metadata[0].Tag != "appliance-f-test-v1.2.0" || metadata[1].Tag != "appliance-f-test-v1.1.0" {
		t.Fatalf("unexpected ordered branch candidates: options=%+v metadata=%+v", options, metadata)
	}
	for _, option := range options {
		if option.ExpectedReleaseBranch != "f-test" || option.Channel != "branch" {
			t.Fatalf("branch provenance expectation was not retained: %+v", option)
		}
	}
}

func TestResolveReleaseRejectsUnsafeOrIncompleteSelection(t *testing.T) {
	tests := []ReleaseSelection{
		{Provider: "custom", Channel: "branch", ReleasesAPI: "https://updates.test/releases"},
		{Provider: "custom", Channel: "exact", ExactTag: "appliance-dev-v1.2.3", ReleasesAPI: "https://updates.test/releases"},
		{Provider: "custom", Channel: "development", ExactTag: "appliance-dev-v1.2.3", ReleasesAPI: "https://updates.test/releases"},
		{Provider: "custom", Channel: "development", ReleasesAPI: "http://updates.test/releases"},
		{Provider: "forgejo", Channel: "development"},
		{Provider: "unknown", Channel: "development", ReleasesAPI: "https://updates.test/releases"},
	}
	for _, selection := range tests {
		if _, _, err := ResolveRelease(context.Background(), nil, selection); err == nil {
			t.Fatalf("unsafe selection accepted: %+v", selection)
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
	if !validExactReleaseTag(tag) {
		t.Fatalf("safe multi-segment exact release tag was rejected: %s", tag)
	}
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
