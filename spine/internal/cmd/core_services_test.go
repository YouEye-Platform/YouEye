package cmd

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func TestCoreInitialChannelRetainsExactPinAndFallback(t *testing.T) {
	previousPath, previousConfig := channels.ConfigPath, cfg
	t.Cleanup(func() { channels.ConfigPath, cfg = previousPath, previousConfig })
	channels.ConfigPath = filepath.Join(t.TempDir(), "youeye.yaml")
	cfg = config.Default()
	c := &channels.Config{Default: channels.Channel{Fallback: []string{"Team/Fallback", "main"}}, Apps: map[string]channels.Channel{"notes": {Branch: "Notes/Owner", Fallback: []string{}}}}
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	r := releasecache.CoreRelease{Source: "https://forge.example/owner/YouEye", Branch: "Team/Fix", Tag: "youeye-v0.6.0-team-abcd.10"}
	digest := strings.Repeat("a", 64)
	if err := initializeSystemChannel(r, digest, systemupdate.ReleasePolicy{Mode: "exact"}); err != nil {
		t.Fatal(err)
	}
	stored, err := channels.Load()
	if err != nil {
		t.Fatal(err)
	}
	if stored.System.Tag != r.Tag || stored.System.ArtifactSHA256 != digest || stored.System.Branch != r.Branch || !reflect.DeepEqual(stored.System.Fallback, c.Default.Fallback) || !reflect.DeepEqual(stored.Apps, c.Apps) {
		t.Fatal(stored)
	}
	if err := initializeSystemChannel(r, digest, systemupdate.ReleasePolicy{Mode: "exact"}); err != nil {
		t.Fatal(err)
	}
	stored.System.Tag = "youeye-v0.6.0-team-abcd.11"
	if err := stored.Save(); err != nil {
		t.Fatal(err)
	}
	if err := initializeSystemChannel(r, digest, systemupdate.ReleasePolicy{Mode: "exact"}); err == nil {
		t.Fatal("owner pin silently replaced")
	}
}
