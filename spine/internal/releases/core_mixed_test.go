package releases

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
)

type mixedCoreRoundTrip func(*http.Request) (*http.Response, error)

func (f mixedCoreRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func mixedMemberHash(raw []byte) string                                        { return fmt.Sprintf("%x", sha256.Sum256(raw)) }

func TestMixedCoreOriginalMemberUsesDigestAndHashMirror(t *testing.T) {
	t.Setenv("YOUEYE_RELEASE_CACHE", t.TempDir())
	root := t.TempDir()
	oldRoot, oldChannels := coreSelectionRoot, channels.ConfigPath
	t.Cleanup(func() { coreSelectionRoot, channels.ConfigPath = oldRoot, oldChannels })
	coreSelectionRoot, channels.ConfigPath = root, filepath.Join(root, "channels.yaml")
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("original Control Panel built elsewhere")
	var cp releasecache.CoreMember
	for i := range r.Members {
		m := &r.Members[i]
		if m.Role != "cp" {
			continue
		}
		m.Artifact.SHA256, m.Artifact.SizeBytes = mixedMemberHash(payload), int64(len(payload))
		cp = *m
	}
	execution, _ := json.Marshal(r)
	policy := fmt.Sprintf(`{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"stable","core_manifest_sha256":"%s","freshness":"require-current"}`, mixedMemberHash(execution))
	for name, data := range map[string][]byte{"core-release.json": execution, "release-policy.json": []byte(policy)} {
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := (&channels.Config{Control: channels.Channel{Source: cp.Source, Branch: cp.Branch, Tag: cp.Tag, ArtifactSHA256: cp.Artifact.SHA256, Fallback: []string{}}}).Save(); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Releases.RepoURL = r.Source
	candidate, err := ResolveComponent(cfg, channels.ComponentControl, cfg.Releases.Repositories.ControlPanel, "cp")
	if err != nil {
		t.Fatal(err)
	}
	if candidate.Source != cp.Source || candidate.Branch != cp.Branch || candidate.Tag != cp.Tag || candidate.ArtifactSHA256 != cp.Artifact.SHA256 {
		t.Fatal("original identity replaced by release")
	}
	mirror := r.Source + "/releases/download/" + r.Tag + "/blob-" + cp.Artifact.SHA256
	client := &http.Client{Transport: selectedCoreTransport{base: mixedCoreRoundTrip(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			return nil, fmt.Errorf("credentials crossed mirror boundary")
		}
		if request.URL.String() != mirror {
			return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("unpublished original")), Header: http.Header{}, Request: request}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(payload)), ContentLength: int64(len(payload)), Header: http.Header{}, Request: request}, nil
	})}}
	response, err := client.Get(candidate.ArtifactURL)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 {
		t.Fatal(err, response.StatusCode)
	}
	artifact := filepath.Join(root, "cp.tar")
	if err := os.WriteFile(artifact, got, 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyReleaseArtifact(candidate.ArtifactURL, artifact, candidate.ArtifactSHA256, "cp"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, append(got, '!'), 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifySelectedCoreArtifact(context.Background(), candidate.ArtifactURL, artifact, candidate.ArtifactSHA256, "cp"); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatal("modified artifact accepted", err)
	}
	if err := os.WriteFile(artifact, got, 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifySelectedCoreArtifact(context.Background(), r.Source+"/releases/download/"+r.Tag+"/other-"+cp.Artifact.Name, artifact, candidate.ArtifactSHA256, "cp"); err == nil {
		t.Fatal("release address relabeled original member")
	}
	// The selection is only accepted under the digest recorded by the installer.
	r.Members[0].Artifact.SHA256 = strings.Repeat("f", 64)
	changed, _ := json.Marshal(r)
	if err := os.WriteFile(filepath.Join(root, "core-release.json"), changed, 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifySelectedCoreArtifact(context.Background(), candidate.ArtifactURL, artifact, candidate.ArtifactSHA256, "cp"); err == nil {
		t.Fatal("changed selection accepted")
	}
}

func TestReleaseArtifactWithoutDigestFailsClosed(t *testing.T) {
	artifact := filepath.Join(t.TempDir(), "spine")
	if err := os.WriteFile(artifact, []byte("bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyReleaseArtifact("https://forge.example/owner/YouEye/releases/download/spine-v1.0.0/spine-linux-amd64", artifact, "", "spine"); err == nil {
		t.Fatal("artifact without digest accepted")
	}
	if err := VerifyReleaseArtifact("https://forge.example/owner/YouEye/releases/download/spine-v1.0.0/spine-linux-amd64", artifact, mixedMemberHash([]byte("bytes")), "spine"); err != nil {
		t.Fatal(err)
	}
	if err := VerifyReleaseArtifact("https://forge.example/owner/YouEye/releases/download/spine-v1.0.0/spine-linux-amd64", artifact, strings.Repeat("0", 64), "spine"); err == nil {
		t.Fatal("wrong digest accepted")
	}
}
