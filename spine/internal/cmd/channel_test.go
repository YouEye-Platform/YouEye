package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func TestSetReleaseChannelChangesOnlyTheChannel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release-policy.json")
	policy := systemupdate.ReleasePolicy{Schema: systemupdate.ReleasePolicySchema, Repository: "https://github.com/YouEye-Platform/YouEye", Channel: "stable", CoreManifestSHA256: strings.Repeat("a", 64), ServiceSelection: "sealed"}
	if err := systemupdate.SaveReleasePolicy(path, policy); err != nil {
		t.Fatal(err)
	}
	for _, channel := range []string{"dev", "alpha", "beta", "stable"} {
		got, err := setReleaseChannel(path, channel)
		if err != nil {
			t.Fatal(channel, err)
		}
		saved, err := systemupdate.LoadReleasePolicy(path)
		want := policy
		want.Channel = channel
		if err != nil || got != want || saved != want {
			t.Fatalf("%s: got %+v saved %+v (%v)", channel, got, saved, err)
		}
	}
	before, _ := os.ReadFile(path)
	for _, channel := range []string{"main", "Stable", "", "feature/x", "nightly"} {
		if _, err := setReleaseChannel(path, channel); err == nil {
			t.Fatalf("channel %q accepted", channel)
		}
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("rejected channel changed the policy")
	}
	if _, err := setReleaseChannel(filepath.Join(t.TempDir(), "missing.json"), "beta"); err == nil {
		t.Fatal("missing policy created from nothing")
	}
}
