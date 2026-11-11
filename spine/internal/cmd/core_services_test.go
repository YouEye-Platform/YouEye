package cmd

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// The System update source is host-owned. A channel configuration written
// through the Spine API (and so reachable by the Control Panel) never changes
// what the host selects.
func TestCoreSelectionIgnoresTamperedChannelConfig(t *testing.T) {
	f := newMixedCoreDeploymentFixture(t)
	previous := coreSelectionRoot
	t.Cleanup(func() { coreSelectionRoot = previous })
	coreSelectionRoot = f.root
	tampered := "release_channels:\n" +
		"  system: { source: https://attacker.example.test/team/YouEye, branch: evil, tag: youeye-v9.9.9, artifact_sha256: " + mixedCoreHash([]byte("x")) + " }\n" +
		"  default: { source: https://attacker.example.test/team/YouEye, branch: evil, fallback: [evil] }\n"
	if err := os.WriteFile(channels.ConfigPath, []byte(tampered), 0600); err != nil {
		t.Fatal(err)
	}
	selection, err := currentCoreSelection()
	if err != nil {
		t.Fatal(err)
	}
	want := systemupdate.CoreReleaseSelection{Source: f.release.Source, Branch: f.release.Branch, Fallback: []string{}, Tag: f.release.Tag, ManifestSHA256: f.policy.CoreManifestSHA256}
	if !reflect.DeepEqual(selection, want) {
		t.Fatalf("exact installation selection = %+v, want %+v", selection, want)
	}

	// A tracking installation follows its recorded source and raw branch only.
	f.policy.Mode, f.policy.Track, f.policy.ExactTag, f.policy.ManifestSHA256 = "track", "stable", "", ""
	raw, _ := json.Marshal(f.policy)
	if err := os.WriteFile(deploymentPolicyPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	selection, err = currentCoreSelection()
	if err != nil {
		t.Fatal(err)
	}
	want.Tag, want.ManifestSHA256 = "", ""
	if !reflect.DeepEqual(selection, want) {
		t.Fatalf("tracking selection = %+v, want %+v", selection, want)
	}

	// A policy that names another repository than its accepted document fails.
	f.policy.ReleasesAPI = "https://api.github.com/repos/attacker/YouEye/releases"
	raw, _ = json.Marshal(f.policy)
	if err := os.WriteFile(deploymentPolicyPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := currentCoreSelection(); err == nil {
		t.Fatal("policy source differing from its accepted release was used")
	}
}
