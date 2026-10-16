package releasecache

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCorePrivateMirrorKeepsIdentityAndStripsOriginCredentials(t *testing.T) {
	var seen int
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen++
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("origin credentials forwarded")
		}
		if strings.HasPrefix(r.URL.Path, "/owner/") {
			http.Redirect(w, r, "/attachments/exact", http.StatusFound)
			return
		}
		if r.URL.Path != "/attachments/exact" {
			t.Error("unexpected mirror path")
		}
		io.WriteString(w, "exact bytes")
	}))
	defer server.Close()
	r := coreFixture()
	r.Source = server.URL + "/owner/YouEye"
	r.Channel = "alpha"
	r.Version = "0.5.38-alpha.1"
	r.Tag = "youeye-v" + r.Version
	original := r.Members[0].Artifact
	transport, err := CoreTransport(server.Client().Transport, r)
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, original.URL, nil)
	request.Header.Set("Authorization", "fixture-origin")
	request.Header.Set("Cookie", "fixture-origin")
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if string(raw) != "exact bytes" || seen != 2 {
		t.Fatal("private mirror did not deliver", seen)
	}
	if request.URL.String() != original.URL || request.Header.Get("Authorization") == "" || r.Members[0].Artifact != original {
		t.Fatal("mutated original identity/request")
	}
	if _, err := CoreBlobTransportURL(r, CoreBlob{}); err == nil {
		t.Fatal("foreign blob obtained mirror authority")
	}
	public := coreFixture()
	u, err := CoreBlobTransportURL(public, public.Members[0].Artifact)
	if err != nil || u != public.Members[0].Artifact.URL {
		t.Fatal("public identity remapped", err)
	}
}

func TestCorePrivateMirrorRejectsForeignRedirect(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://foreign.invalid/payload", http.StatusFound)
	}))
	defer server.Close()
	r := coreFixture()
	r.Source = server.URL + "/owner/YouEye"
	r.Channel = "alpha"
	r.Version = "0.5.38-alpha.1"
	r.Tag = "youeye-v" + r.Version
	transport, err := CoreTransport(server.Client().Transport, r)
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodGet, r.Members[0].Artifact.URL, nil)
	if _, err = transport.RoundTrip(request); err == nil {
		t.Fatal("foreign mirror redirect accepted")
	}
}

func TestCorePublicWrapperUsesHashMirrorOnlyWhenOriginalAbsent(t *testing.T) {
	r := coreFixture()
	original := r.Members[0].Artifact
	mirror := r.Source + "/releases/download/" + r.Tag + "/blob-" + original.SHA256
	for _, status := range []int{http.StatusOK, http.StatusNotFound, http.StatusForbidden} {
		var seen []string
		base := distributionRT(func(req *http.Request) (*http.Response, error) {
			seen = append(seen, req.URL.String())
			code := status
			if req.URL.String() == mirror {
				if req.Header.Get("Authorization") != "" {
					t.Error("credentials forwarded to alternate transport")
				}
				code = http.StatusOK
			}
			return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("original bytes")), Request: req}, nil
		})
		transport, err := CoreTransport(base, r)
		if err != nil {
			t.Fatal(err)
		}
		request, _ := http.NewRequest(http.MethodGet, original.URL, nil)
		request.Header.Set("Authorization", "fixture-original")
		response, err := transport.RoundTrip(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if status == http.StatusNotFound {
			if len(seen) != 2 || seen[1] != mirror || response.StatusCode != 200 {
				t.Fatal(seen, response.StatusCode)
			}
		} else if len(seen) != 1 || response.StatusCode != status {
			t.Fatal("replaced a successful or forbidden original", seen)
		}
		if request.URL.String() != original.URL || request.Header.Get("Authorization") != "fixture-original" {
			t.Fatal("changed original request")
		}
	}
}
