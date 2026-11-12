package systemupdate

import (
	"net/http"
	"testing"
)

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
