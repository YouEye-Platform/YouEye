package systemupdate

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

// Exercise the native cold downloader as well as the mirror transport: checking
// only the transport misses its response identity being rejected by downloadHTTP.
func TestCoreMirrorColdDownloadThroughSignedGitHubCDN(t *testing.T) {
	_, _, selected := coreJournalFixture(t)
	const originalSource = "https://forge.example/owner/YouEye"
	payload := []byte("original signed component payload")
	var artifact releasecache.CoreBlob
	for i := range selected.Members {
		member := &selected.Members[i]
		if member.Role != "cp" {
			continue
		}
		member.Source = originalSource
		for _, blob := range []*releasecache.CoreBlob{&member.Artifact, &member.Checksums, &member.Signature, &member.Provenance, &member.SBOM} {
			blob.URL = originalSource + "/releases/download/" + member.Tag + "/" + blob.Name
		}
		member.Artifact.SHA256 = checksum(payload)
		member.Artifact.SizeBytes = int64(len(payload))
		artifact = member.Artifact
	}
	mirror, err := releasecache.CoreBlobTransportURL(selected, artifact)
	if err != nil {
		t.Fatal(err)
	}
	for _, corrupt := range []bool{false, true} {
		t.Run(map[bool]string{false: "exact", true: "corrupt"}[corrupt], func(t *testing.T) {
			var visited []string
			base := signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
				visited = append(visited, req.URL.Host)
				if req.Header.Get("Authorization") != "" || req.Header.Get("Cookie") != "" {
					t.Fatal("source credentials reached the mirror")
				}
				response := &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Request: req}
				if req.URL.String() == mirror {
					response.StatusCode = http.StatusFound
					response.Header.Set("Location", "https://release-assets.githubusercontent.com/exact?signature=fixture")
					response.Body = io.NopCloser(strings.NewReader(""))
					return response, nil
				}
				if req.URL.Host != "release-assets.githubusercontent.com" {
					t.Fatalf("unexpected download host %q", req.URL.Host)
				}
				body := string(payload)
				if corrupt {
					body = strings.Repeat("!", len(payload))
				}
				response.Body = io.NopCloser(strings.NewReader(body))
				return response, nil
			})
			transport, err := releasecache.CoreTransport(base, selected)
			if err != nil {
				t.Fatal(err)
			}
			manager := &Manager{config: Config{HTTPClient: &http.Client{Transport: transport, CheckRedirect: validateSystemUpdateRedirect}}}
			root := t.TempDir()
			destination := filepath.Join(root, "blob")
			err = manager.downloadSource(context.Background(), artifact.URL, destination+".partial", destination, artifact.SizeBytes, artifact.SHA256)
			if len(visited) != 2 || visited[0] != "github.com" || visited[1] != "release-assets.githubusercontent.com" {
				t.Fatal("cold download did not traverse mirror and CDN", visited)
			}
			if corrupt {
				if err == nil {
					t.Fatal("accepted corrupt mirrored bytes")
				}
				if _, statErr := os.Stat(destination); !os.IsNotExist(statErr) {
					t.Fatal("corrupt download published a complete blob", statErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(destination)
			if err != nil || string(got) != string(payload) {
				t.Fatal("exact mirrored payload unavailable", err)
			}
		})
	}
}
