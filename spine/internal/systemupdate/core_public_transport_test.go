package systemupdate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt-in transport acceptance against an exact pinned public release.
func TestCorePublicTransportIntegration(t *testing.T) {
	if os.Getenv("YOUEYE_TEST_CORE_TAG") == "" {
		t.Skip("requires an explicit pinned tag and manifest digest")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Minute)
	defer cancel()
	selection, release, digest, err := ResolveCoreRelease(ctx, nil, CoreReleaseSelection{
		Source: "https://github.com/YouEye-Platform/YouEye", Branch: "main",
		Tag: os.Getenv("YOUEYE_TEST_CORE_TAG"), ManifestSHA256: os.Getenv("YOUEYE_TEST_CORE_SHA256"),
	})
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
		index, err := cache.IndexMember(member)
		if err != nil {
			t.Fatal(member.Role, err)
		}
		t.Logf("verified public %s %s; payload %s; indexed files: %d", release.Tag, member.Role, member.Artifact.SHA256, len(index.Entries))
	}
}
