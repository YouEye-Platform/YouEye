package systemupdate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt-in transport acceptance uses public anchors exported from an independently
// pinned public source commit. It never changes the installed trust policy.
func TestCorePublicTransportIntegration(t *testing.T) {
	trustPath := os.Getenv("YOUEYE_TEST_PUBLIC_TRUST")
	if trustPath == "" {
		t.Skip("requires explicit pinned public trust, tag and manifest digest")
	}
	trust, err := os.ReadFile(trustPath)
	if err != nil {
		t.Fatal(err)
	}
	prior := publicReleaseTrustJSON
	publicReleaseTrustJSON = trust
	t.Cleanup(func() { publicReleaseTrustJSON = prior })
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Minute)
	defer cancel()
	selection, release, digest, err := ResolveCoreRelease(ctx, nil, CoreReleaseSelection{
		Source: "https://github.com/YouEye-Platform/YouEye", Branch: "main",
		Tag: os.Getenv("YOUEYE_TEST_CORE_TAG"), ManifestSHA256: os.Getenv("YOUEYE_TEST_CORE_SHA256"),
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	cache := CoreArtifactCache{Root: filepath.Join(t.TempDir(), "public-inputs")}
	if _, got, err := cache.StageFreshServices(ctx, selection); err != nil || got != digest {
		t.Fatal(got, err)
	}
	for _, member := range release.Members {
		if member.Role != "cp" && member.Role != "ui" {
			continue
		}
		index, err := cache.IndexMember(member, release.Channel)
		if err != nil {
			t.Fatal(member.Role, err)
		}
		t.Logf("verified public %s %s; payload %s; indexed files: %d", release.Tag, member.Role, member.Artifact.SHA256, len(index.Entries))
	}
}
