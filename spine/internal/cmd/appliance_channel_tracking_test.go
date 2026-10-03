package cmd

import (
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFinishTrackedChannelsPreservesOwnerPinsAndSnapshot(t *testing.T) {
	root := t.TempDir()
	snapshot := filepath.Join(root, "installation.json")
	if err := os.WriteFile(snapshot, []byte("immutable accepted selection"), 0600); err != nil {
		t.Fatal(err)
	}
	oldPolicy, oldConfig := deploymentPolicyPath, channels.ConfigPath
	t.Cleanup(func() { deploymentPolicyPath, channels.ConfigPath = oldPolicy, oldConfig })
	deploymentPolicyPath = filepath.Join(root, "policy.json")
	channels.ConfigPath = filepath.Join(root, "youeye.yaml")
	for _, tc := range []struct {
		name, mode, selection string
		wantTag               bool
	}{
		{"tracked", "track", "", false}, {"exact", "exact", "", true}, {"sealed", "track", "sealed", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := `{"schema":"youeye.release-policy.v1","provider":"custom","releases_api":"https://forge.example.test/api/v1/repos/example/YouEye/releases","mode":"` + tc.mode + `","track":"stable","freshness":"require-current","service_selection":"` + tc.selection + `"}`
			if tc.mode == "exact" {
				policy = `{"schema":"youeye.release-policy.v1","provider":"custom","releases_api":"https://forge.example.test/api/v1/repos/example/YouEye/releases","mode":"exact","exact_tag":"appliance-v0.5.23.0.4","manifest_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","freshness":"require-current"}`
			}
			if err := os.WriteFile(deploymentPolicyPath, []byte(policy), 0600); err != nil {
				t.Fatal(err)
			}
			cfg := &channels.Config{Control: channels.Channel{Source: "https://forge.example.test/example/YouEye", Branch: "main", Tag: "cp-v0.5.33.0.4", ArtifactSHA256: "digest", PinOrigin: "installation", Fallback: []string{}}, UI: channels.Channel{Tag: "ui-v0.5.11.0.4", ArtifactSHA256: "owner-digest"}}
			if err := cfg.Save(); err != nil {
				t.Fatal(err)
			}
			if err := finishApplianceServiceChannels(); err != nil {
				t.Fatal(err)
			}
			got, err := channels.Load()
			if err != nil {
				t.Fatal(err)
			}
			if (got.Control.Tag != "") != tc.wantTag {
				t.Fatalf("wrong CP policy: %+v", got.Control)
			}
			raw, err := os.ReadFile(snapshot)
			if err != nil || string(raw) != "immutable accepted selection" {
				t.Fatal("installation snapshot changed")
			}
			if got.UI.Tag != "ui-v0.5.11.0.4" || got.UI.ArtifactSHA256 != "owner-digest" {
				t.Fatal("owner pin changed")
			}
			if got.Control.Source != cfg.Control.Source || got.Control.Branch != "main" || got.Control.Fallback == nil {
				t.Fatal("source/channel policy lost")
			}
		})
	}
}

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
