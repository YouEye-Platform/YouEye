package systemupdate

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestCoreMetadataArtifactRedirectPolicy(t *testing.T) {
	for _, target := range []string{
		"https://release-assets.githubusercontent.com/asset?signature=private-value",
		"https://objects.githubusercontent.com/asset?signature=private-value",
		"https://hostile.example/asset?signature=private-value",
		"http://release-assets.githubusercontent.com/asset",
		"https://user:password@release-assets.githubusercontent.com/asset",
	} {
		t.Run(target, func(t *testing.T) {
			allowed := strings.HasPrefix(target, "https://release-assets.") || strings.HasPrefix(target, "https://objects.")
			client := ReleaseHTTPClient()
			client.Transport = signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
				if req.URL.Host == "github.com" {
					return &http.Response{StatusCode: 302, Header: http.Header{"Location": {target}}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
				}
				if !allowed {
					t.Fatal("contacted untrusted redirect")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("signed metadata")), Request: req}, nil
			})
			raw, err := readCoreMetadata(context.Background(), client, "https://github.com/owner/YouEye/releases/download/youeye-v1.2.3/core-release.json", 100)
			if allowed && (err != nil || string(raw) != "signed metadata") {
				t.Fatal(string(raw), err)
			}
			if !allowed && (err == nil || strings.Contains(err.Error(), "private-value")) {
				t.Fatal("unsafe redirect/error", err)
			}
			// Metadata requests must not mutate the API client's same-origin rule.
			r, _ := http.NewRequest("GET", target, nil)
			origin, _ := http.NewRequest("GET", "https://github.com/owner/YouEye", nil)
			if err := client.CheckRedirect(r, []*http.Request{origin}); err == nil {
				t.Fatal("API redirect policy changed")
			}
		})
	}
}

func TestCoreArtifactRedirectStripsCredentialsAndKeepsCustomOrigin(t *testing.T) {
	client := CoreArtifactHTTPClient(nil)
	origin, _ := http.NewRequest("GET", "https://github.com/owner/YouEye/releases/download/tag/file", nil)
	next, _ := http.NewRequest("GET", "https://release-assets.githubusercontent.com/file?signed=value", nil)
	for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie"} {
		next.Header.Set(name, "secret")
	}
	if err := client.CheckRedirect(next, []*http.Request{origin}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie"} {
		if next.Header.Get(name) != "" {
			t.Fatal("forwarded", name)
		}
	}
	origin, _ = http.NewRequest("GET", "https://forge.example/owner/YouEye/releases/download/tag/file", nil)
	if err := client.CheckRedirect(next, []*http.Request{origin}); err == nil {
		t.Fatal("custom source crossed origin")
	}
	if err := client.CheckRedirect(origin, []*http.Request{origin, origin, origin, origin, origin}); err == nil {
		t.Fatal("redirect loop accepted")
	}
}

func TestCoreMetadataSizeAndTransportErrorBounds(t *testing.T) {
	for _, size := range []int64{-1, 4} {
		client := &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: http.Header{}, ContentLength: size, Body: io.NopCloser(strings.NewReader("four")), Request: req}, nil
		})}
		if _, err := readCoreMetadata(context.Background(), client, "https://github.com/owner/YouEye/releases/download/tag/file", 3); err == nil {
			t.Fatal("oversized metadata accepted")
		}
	}
	client := &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) { return nil, fmt.Errorf("connection unavailable") })}
	if _, err := readCoreMetadata(context.Background(), client, "https://github.com/owner/YouEye/releases/download/tag/file", 100); err == nil {
		t.Fatal("transport failure accepted")
	}
}
