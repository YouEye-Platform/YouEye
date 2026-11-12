package releasecache

import (
	"encoding/json"
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
	if r.Version != "0.6.1-rc.1" || len(digest) != 64 || len(r.Members) != len(CoreRoles) {
		t.Fatalf("unexpected fixture identity %+v", r)
	}
	ui, ok := r.Member("ui")
	if !ok || AssetURL("https://example.test/o/YouEye", r.Tag, ui.Artifact) != "https://example.test/o/YouEye/releases/download/youeye-v0.6.1-rc.1/ui-standalone.tar" {
		t.Fatalf("asset URL is wrong")
	}
	ui.Artifact.Release = "youeye-v0.6.0-rc.2"
	if AssetURL("https://example.test/o/YouEye", r.Tag, ui.Artifact) != "https://example.test/o/YouEye/releases/download/youeye-v0.6.0-rc.2/ui-standalone.tar" {
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
		"host field":       func(d map[string]any) { d["source"] = "https://github.com/YouEye-Platform/YouEye" },
		"channel field":    func(d map[string]any) { d["channel"] = "stable" },
		"blob url":         func(d map[string]any) { member(d, 0)["artifact"].(map[string]any)["url"] = "https://x/y" },
		"commit not tree":  func(d map[string]any) { d["source_commit"] = strings.Repeat("a", 40) },
		"bad tree":         func(d map[string]any) { d["source_tree"] = "xyz" },
		"tag mismatch":     func(d map[string]any) { d["tag"] = "youeye-v9.9.9" },
		"missing role":     func(d map[string]any) { d["members"] = d["members"].([]any)[1:] },
		"foreign release":  func(d map[string]any) { member(d, 0)["artifact"].(map[string]any)["release"] = "v1.0.0" },
		"signature field":  func(d map[string]any) { d["signatures"] = []any{} },
		"bad member tree":  func(d map[string]any) { member(d, 2)["source_tree"] = "" },
		"cp without spine": func(d map[string]any) { delete(member(d, 12), "depends_on") },
	}
	for name, change := range cases {
		if _, _, err := ParseCoreRelease(mutate(t, change)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	dup := strings.Replace(string(fixture(t)), `"version": "0.6.1-rc.1",`, `"version": "0.6.1-rc.1", "version": "0.6.1-rc.1",`, 1)
	if _, _, err := ParseCoreRelease([]byte(dup)); err == nil {
		t.Error("duplicate key accepted")
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
	ordered := []string{"0.5.9-rc.3", "0.6.0-rc.1", "0.6.0-rc.2", "0.6.0-rc.10", "0.6.0", "0.6.1-rc.1", "1.0.0-rc.1"}
	for i := 1; i < len(ordered); i++ {
		if CompareVersions(ordered[i-1], ordered[i]) >= 0 || CompareVersions(ordered[i], ordered[i-1]) <= 0 {
			t.Fatalf("%s should sort before %s", ordered[i-1], ordered[i])
		}
	}
	if CompareVersions("0.6.1-rc.4", "0.6.1-rc.4") != 0 {
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
