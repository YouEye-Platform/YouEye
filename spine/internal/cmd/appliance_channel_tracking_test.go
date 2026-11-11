package cmd

import (
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallationPinsDoNotOverwriteOwnerChoice(t *testing.T) {
	old := channels.ConfigPath
	t.Cleanup(func() { channels.ConfigPath = old })
	channels.ConfigPath = filepath.Join(t.TempDir(), "youeye.yaml")
	manifest := appliance.Manifest{ReleaseSet: &appliance.ReleaseSet{Source: "https://forge.example.test/owner/YouEye", Branch: "main", ControlPanel: appliance.ComponentRelease{Tag: "cp-v1.0.0.0.1", ArtifactSHA256: strings.Repeat("a", 64)}, UI: appliance.ComponentRelease{Tag: "ui-v1.0.0.0.1", ArtifactSHA256: strings.Repeat("c", 64)}}}
	for _, ch := range []channels.Channel{{Tag: "cp-v1.0.0.0.0", ArtifactSHA256: strings.Repeat("b", 64)}, {Source: "https://other.example.test/owner/YouEye"}, {Branch: "owner-branch"}, {Fallback: []string{"owner-fallback"}}} {
		cfg := &channels.Config{Control: ch}
		if e := cfg.Save(); e != nil {
			t.Fatal(e)
		}
		before, e := os.ReadFile(channels.ConfigPath)
		if e != nil {
			t.Fatal(e)
		}
		if e := pinDeploymentServices(manifest); e == nil {
			t.Fatal("conflicting owner choice accepted")
		}
		after, e := os.ReadFile(channels.ConfigPath)
		if e != nil {
			t.Fatal(e)
		}
		if string(after) != string(before) {
			t.Fatal("owner configuration changed on rejected selection")
		}
	}
	cfg := &channels.Config{Control: channels.Channel{Tag: manifest.ReleaseSet.ControlPanel.Tag, ArtifactSHA256: strings.Repeat("a", 64)}}
	if e := cfg.Save(); e != nil {
		t.Fatal(e)
	}
	if e := pinDeploymentServices(manifest); e != nil {
		t.Fatal(e)
	}
	got, e := channels.Load()
	if e != nil {
		t.Fatal(e)
	}
	if got.Control.PinOrigin != "" {
		t.Fatal("owner pin reclassified as bootstrap")
	}
}
