package cmd

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
)

func releaseSetFixture(t *testing.T) (appliance.Manifest, *config.Config) {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "youeye")
	contents := []byte("exact spine binary")
	if err := os.WriteFile(binary, contents, 0o755); err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(contents))
	oldExecutable := applianceExecutablePath
	applianceExecutablePath = func() (string, error) { return binary, nil }
	t.Cleanup(func() { applianceExecutablePath = oldExecutable })

	source := "https://github.com/YouEye-Platform/YouEye"
	controlDigest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	uiDigest := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	channelPath := filepath.Join(t.TempDir(), "youeye.yaml")
	channelYAML := fmt.Sprintf(`release_branch: dev
release_channels:
  default: {source: %q, branch: dev, fallback: []}
  control: {tag: cp-dev-v2.0.0, artifact_sha256: %s}
  ui: {tag: ui-dev-v3.0.0, artifact_sha256: %s}
`, source, controlDigest, uiDigest)
	if err := os.WriteFile(channelPath, []byte(channelYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	oldChannelPath := channels.ConfigPath
	channels.ConfigPath = channelPath
	t.Cleanup(func() { channels.ConfigPath = oldChannelPath })

	commit := "0123456789012345678901234567890123456789"
	manifest := appliance.Manifest{ReleaseSet: &appliance.ReleaseSet{
		Source: source, Branch: "dev", Fallback: []string{},
		Spine:        appliance.ComponentRelease{Version: "1.0.0", SourceCommit: commit, ArtifactSHA256: digest},
		ControlPanel: appliance.ComponentRelease{Version: "2.0.0", Tag: "cp-dev-v2.0.0", SourceCommit: commit, ArtifactSHA256: controlDigest},
		UI:           appliance.ComponentRelease{Version: "3.0.0", Tag: "ui-dev-v3.0.0", SourceCommit: commit, ArtifactSHA256: uiDigest},
	}}
	cfg := config.Default()
	cfg.Releases.RepoURL = source
	return manifest, cfg
}

func TestVerifyApplianceReleaseSetAcceptsExactDevPayload(t *testing.T) {
	manifest, cfg := releaseSetFixture(t)
	oldVersion := Version
	Version = manifest.ReleaseSet.Spine.Version
	t.Cleanup(func() { Version = oldVersion })
	if err := verifyApplianceReleaseSet(manifest, cfg); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyApplianceReleaseSetRejectsStableFallbackAndDigestDrift(t *testing.T) {
	for _, mutation := range []struct {
		name string
		edit func(*appliance.Manifest, *config.Config)
	}{
		{name: "wrong source", edit: func(_ *appliance.Manifest, cfg *config.Config) {
			cfg.Releases.RepoURL = "https://github.com/youeye-platform/YouEye"
		}},
		{name: "wrong baked digest", edit: func(m *appliance.Manifest, _ *config.Config) {
			m.ReleaseSet.Spine.ArtifactSHA256 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
		}},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			manifest, cfg := releaseSetFixture(t)
			oldVersion := Version
			Version = manifest.ReleaseSet.Spine.Version
			t.Cleanup(func() { Version = oldVersion })
			mutation.edit(&manifest, cfg)
			if err := verifyApplianceReleaseSet(manifest, cfg); err == nil {
				t.Fatal("expected release-set verification failure")
			}
		})
	}
}
