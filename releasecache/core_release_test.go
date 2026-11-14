package releasecache

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func fixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestSharedCoreReleaseFixture(t *testing.T) {
	r, digest, err := ParseCoreRelease(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != "0.6.1-dev.1" || len(digest) != 64 || len(r.Members) != len(CoreRoles) {
		t.Fatalf("unexpected fixture identity %+v", r)
	}
	ui, ok := r.Member("ui")
	if !ok || AssetURL("https://example.test/o/YouEye", "", r.Tag, ui.Artifact) != "https://example.test/o/YouEye/releases/download/youeye-v0.6.1-dev.1/ui-standalone.tar" {
		t.Fatalf("asset URL is wrong")
	}
	ui.Artifact.Release = "youeye-v0.6.0-dev.2"
	if AssetURL("https://example.test/o/YouEye", "", r.Tag, ui.Artifact) != "https://example.test/o/YouEye/releases/download/youeye-v0.6.0-dev.2/ui-standalone.tar" {
		t.Fatalf("referenced release is not used")
	}
}

func mutate(t *testing.T, change func(map[string]any)) []byte {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(fixture(t), &doc); err != nil {
		t.Fatal(err)
	}
	change(doc)
	raw, _ := json.Marshal(doc)
	return raw
}

func TestCoreReleaseRejectsBadDocuments(t *testing.T) {
	member := func(doc map[string]any, i int) map[string]any { return doc["members"].([]any)[i].(map[string]any) }
	cases := map[string]func(map[string]any){
		"bad tree":         func(d map[string]any) { d["source_tree"] = "xyz" },
		"tag mismatch":     func(d map[string]any) { d["tag"] = "youeye-v9.9.9" },
		"missing role":     func(d map[string]any) { d["members"] = d["members"].([]any)[1:] },
		"duplicate role":   func(d map[string]any) { d["members"] = append(d["members"].([]any), d["members"].([]any)[0]) },
		"foreign release":  func(d map[string]any) { member(d, 0)["artifact"].(map[string]any)["release"] = "v1.0.0" },
		"bad member tree":  func(d map[string]any) { member(d, 2)["source_tree"] = "" },
		"cp without spine": func(d map[string]any) { delete(member(d, 12), "depends_on") },
		"no build":         func(d map[string]any) { delete(d, "build") },
		"bad build":        func(d map[string]any) { d["build"] = "dev2" },
		"other schema":     func(d map[string]any) { d["schema"] = "youeye.core-release.v2" },
		"no reader":        func(d map[string]any) { delete(d, "minimum_reader") },
	}
	for name, change := range cases {
		if _, _, err := ParseCoreRelease(mutate(t, change)); err == nil || errors.Is(err, ErrNeedsNewerReader) {
			t.Errorf("%s: %v", name, err)
		}
	}
	dup := strings.Replace(string(fixture(t)), `"version": "0.6.1-dev.1",`, `"version": "0.6.1-dev.1", "version": "0.6.1-dev.1",`, 1)
	if _, _, err := ParseCoreRelease([]byte(dup)); err == nil {
		t.Error("duplicate key accepted")
	}
}

// A document from a later release: unknown fields are ignored; a higher
// minimum_reader or an unknown role is "needs a newer reader".
func TestFutureCoreRelease(t *testing.T) {
	member := func(doc map[string]any, i int) map[string]any { return doc["members"].([]any)[i].(map[string]any) }
	ignored := map[string]func(map[string]any){
		"top-level field": func(d map[string]any) { d["signatures"] = []any{map[string]any{"key": "k1"}} },
		"member field":    func(d map[string]any) { member(d, 0)["sbom"] = "x" },
		"blob field":      func(d map[string]any) { member(d, 0)["artifact"].(map[string]any)["mirrors"] = []any{"https://m.test"} },
		"compat field":    func(d map[string]any) { d["compatibility"].(map[string]any)["kernel_min"] = "6.12" },
	}
	for name, change := range ignored {
		if _, _, err := ParseCoreRelease(mutate(t, change)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	newer := map[string]func(map[string]any){
		"reader 2": func(d map[string]any) { d["minimum_reader"] = 2; d["members"] = "a different shape" },
		"new role": func(d map[string]any) {
			extra := map[string]any{}
			for k, v := range member(d, 0) {
				extra[k] = v
			}
			extra["role"] = "firmware"
			d["members"] = append(d["members"].([]any), extra)
		},
	}
	for name, change := range newer {
		if _, _, err := ParseCoreRelease(mutate(t, change)); !errors.Is(err, ErrNeedsNewerReader) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestCoreReleaseEmptyDependsOnSurvivesJSONRoundTrip(t *testing.T) {
	raw := mutate(t, func(d map[string]any) { d["members"].([]any)[0].(map[string]any)["depends_on"] = []any{} })
	r, _, err := ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := json.Marshal(r)
	r2, _, err := ParseCoreRelease(again)
	if err != nil || r.Members[0].DependsOn != nil || r2.Members[0].DependsOn != nil {
		t.Fatalf("depends_on did not normalise: %v", err)
	}
}

func TestCompareVersions(t *testing.T) {
	ordered := []string{"0.5.9-dev.3", "0.6.0-dev.1", "0.6.0-dev.2", "0.6.0-dev.10", "0.6.0", "0.6.1-dev.1", "1.0.0-dev.1"}
	for i := 1; i < len(ordered); i++ {
		if CompareVersions(ordered[i-1], ordered[i]) >= 0 || CompareVersions(ordered[i], ordered[i-1]) <= 0 {
			t.Fatalf("%s should sort before %s", ordered[i-1], ordered[i])
		}
	}
	if CompareVersions("0.6.1-dev.4", "0.6.1-dev.4") != 0 {
		t.Fatal("equal versions differ")
	}
}

func TestCanonicalRepository(t *testing.T) {
	for raw, want := range map[string]string{
		"https://GitHub.com/YouEye-Platform/YouEye":     OfficialRepository,
		"https://github.com/YouEye-Platform/YouEye.git": OfficialRepository,
		"https://forge.example.test/owner/YouEye/":      "https://forge.example.test/owner/YouEye",
	} {
		if got, err := CanonicalRepository(raw); err != nil || got != want {
			t.Errorf("%s: got %q %v", raw, got, err)
		}
	}
	for _, raw := range []string{"http://github.com/a/b", "https://u:p@github.com/a/b", "https://github.com/a", "https://github.com/a/b/c", "https://github.com/a/b?x=1", "https://github.com/../b"} {
		if _, err := CanonicalRepository(raw); err == nil {
			t.Errorf("%s accepted", raw)
		}
	}
}

func TestPromotedCoreReleaseKeepsItsBuild(t *testing.T) {
	// A promotion renames the release and keeps the build and every member.
	raw := mutate(t, func(d map[string]any) { d["version"], d["tag"] = "0.6.1", "youeye-v0.6.1" })
	r, _, err := ParseCoreRelease(raw)
	if err != nil || r.Version != "0.6.1" || r.Build != "0.6.1-dev.1" {
		t.Fatalf("promoted document: %+v %v", r, err)
	}
}

func TestPayloadIgnoresWhereFilesLive(t *testing.T) {
	r, _, err := ParseCoreRelease(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	promoted := r
	promoted.Version, promoted.Tag = "0.6.1-alpha.1", "youeye-v0.6.1-alpha.1"
	promoted.Members = append([]CoreMember{}, r.Members...)
	for i := range promoted.Members {
		promoted.Members[i].Artifact.Release = "youeye-v0.6.1-dev.1"
	}
	if promoted.PayloadSHA256() != r.PayloadSHA256() {
		t.Fatal("the same files in another release changed the payload digest")
	}
	promoted.Members[0].Artifact.SHA256 = strings.Repeat("f", 64)
	if promoted.PayloadSHA256() == r.PayloadSHA256() {
		t.Fatal("another file did not change the payload digest")
	}
	if r.Members[0].Artifact.Release != "" && r.Members[0].Artifact.Release == "youeye-v0.6.1-dev.1" {
		t.Fatal("PayloadSHA256 changed its input")
	}
}
