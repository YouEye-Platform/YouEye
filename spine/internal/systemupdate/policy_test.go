package systemupdate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleasePolicyStrictValidation(t *testing.T) {
	digest := strings.Repeat("c", 64)
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"branch","branch":"f-test","core_manifest_sha256":"`+digest+`","freshness":"require-current"}`), 0600); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadReleasePolicy(path)
	if err != nil {
		t.Fatal(err)
	}
	if policy.Track != "branch" || policy.Branch != "f-test" || policy.Provider != "github" {
		t.Fatalf("unexpected policy: %+v", policy)
	}
	policy.Branch = "codex/phase1-repository-builds"
	if err := policy.Validate(); err != nil {
		t.Fatalf("safe multi-segment branch was rejected: %v", err)
	}
	// Every installation records the exact core-release.json it accepted.
	withoutCore := policy
	withoutCore.CoreManifestSHA256 = ""
	if err := withoutCore.Validate(); err == nil {
		t.Fatal("policy without its accepted core-release.json digest was accepted")
	}
	exact := ReleasePolicy{Schema: ReleasePolicySchema, Provider: "github", Mode: "exact", ExactTag: "appliance-v0.5.23.0.4", ManifestSHA256: strings.Repeat("a", 64), CoreManifestSHA256: digest, Freshness: "require-current"}
	if err := exact.Validate(); err == nil {
		t.Fatal("legacy appliance tag accepted as an exact System release")
	}
	exact.ExactTag = "youeye-v0.6.0"
	if err := exact.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"stable","core_manifest_sha256":"`+digest+`","freshness":"require-current","unknown":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadReleasePolicy(path); err == nil {
		t.Fatal("unknown release-policy field was accepted")
	}
}
