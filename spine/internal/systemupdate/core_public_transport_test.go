package systemupdate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

// Opt-in transport acceptance against the public head of a channel.
func TestCorePublicTransportIntegration(t *testing.T) {
	channel := os.Getenv("YOUEYE_TEST_CORE_CHANNEL")
	if channel == "" {
		t.Skip("requires an explicit channel (YOUEYE_TEST_CORE_CHANNEL)")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Minute)
	defer cancel()
	repository := releasecache.OfficialRepository
	old := BoxRepository
	BoxRepository = func() (string, error) { return repository, nil }
	t.Cleanup(func() { BoxRepository = old })
	selection, release, digest, err := ResolveCoreRelease(ctx, nil, CoreReleaseSelection{Repository: repository, Channel: channel})
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
