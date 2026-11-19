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
		"bad build":        func(d map[string]any) { d["build"] = "dev2" },
		"bad member build": func(d map[string]any) { member(d, 3)["build_version"] = "dev2" },
		"bad minimum":      func(d map[string]any) { d["compatibility"].(map[string]any)["minimum_release"] = "0.6" },
		"no sequence":      func(d map[string]any) { delete(d, "sequence") },
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
		"reader 3": func(d map[string]any) { d["minimum_reader"] = 3; d["members"] = "a different shape" },
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

func TestPromotedCoreReleaseIsTheSameRelease(t *testing.T) {
	// A promotion renames the release and keeps the sequence and every member:
	// the same key and the same payload.
	dev, _, err := ParseCoreRelease(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	raw := mutate(t, func(d map[string]any) { d["version"], d["tag"] = "0.6.1", "youeye-v0.6.1" })
	r, _, err := ParseCoreRelease(raw)
	if err != nil || r.Version != "0.6.1" || r.Build != "0.6.1-dev.1" {
		t.Fatalf("promoted document: %+v %v", r, err)
	}
	if CompareReleases(r.Key(), dev.Key()) != 0 || r.PayloadSHA256() != dev.PayloadSHA256() {
		t.Fatalf("a promotion is another release: %+v %+v", r.Key(), dev.Key())
	}
}

// Reader 2 reads both shapes: documents up to 0.6.12 carry build and a
// build_version per member; later ones carry neither and say minimum_reader 2.
func TestCoreReleaseWithoutBuildNames(t *testing.T) {
	raw, err := os.ReadFile("testdata/core-release-no-build.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{`"build"`, `"build_version"`, "-dev."} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("the fixture without build names contains %s", forbidden)
		}
	}
	r, digest, err := ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != "0.6.13" || r.Build != "" || r.MinimumReader != 2 || r.Compatibility.MinimumRelease != "0.6.12" || len(digest) != 64 {
		t.Fatalf("unexpected document %+v", r)
	}
	if key := r.Key(); key.Line != "0.6.13" || key.Sequence != 1795200000 {
		t.Fatalf("key %+v", key)
	}
	for _, m := range r.Members {
		if m.BuildVersion != "" {
			t.Fatalf("%s has a build version", m.Role)
		}
	}
	// A receipt or journal holds the parsed document as JSON: writing it back
	// must not invent the old fields, and must keep them for an old document.
	again, err := json.Marshal(r)
	if err != nil || strings.Contains(string(again), `"build"`) || strings.Contains(string(again), "build_version") {
		t.Fatalf("round trip added build names: %s %v", again, err)
	}
	old, _, err := ParseCoreRelease(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	again, _ = json.Marshal(old)
	if strings.Count(string(again), `"build_version":"0.6.1-dev.1"`) != len(CoreRoles) || !strings.Contains(string(again), `"build":"0.6.1-dev.1"`) {
		t.Fatalf("round trip lost the old fields: %s", again)
	}
	back, _, err := ParseCoreRelease(again)
	if err != nil || back.PayloadSHA256() != old.PayloadSHA256() {
		t.Fatalf("round trip changed the payload: %v", err)
	}
	// The old shape without its top-level build is still a valid document
	// (build is optional and unused).
	if _, _, err := ParseCoreRelease(mutate(t, func(d map[string]any) { delete(d, "build") })); err != nil {
		t.Fatal(err)
	}
}

// Boxes keep payload digests on State (the version floor) and compare them
// across Spine versions. These two values must never change: they are what a
// 0.6.11 Spine computed for the old-shape fixture, and what reader 2 computes
// for the fixture without build names.
func TestPayloadDigestIsFrozen(t *testing.T) {
	for name, want := range map[string]string{
		"testdata/core-release.json":          "d9939a059d316d89c1f854455045b11306ed1ba2e94275414836fca05312d1ba",
		"testdata/core-release-no-build.json": "28a2bdddb2965a86e281b47ec6a1d4f37d4b43ee44fd1e22a1e471be383351f5",
	} {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		r, _, err := ParseCoreRelease(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := r.PayloadSHA256(); got != want {
			t.Errorf("%s: payload digest %s, frozen %s", name, got, want)
		}
	}
	// The hashed text itself, for the first member of the old shape: field
	// names, their order and the omitted empty fields.
	old, _, _ := ParseCoreRelease(fixture(t))
	member, _ := json.Marshal(old.Members[0])
	if string(member) != `{"role":"installer","build_version":"0.6.1-dev.1","source_tree":"1111111111111111111111111111111111111111","input_sha256":"9b2abab70e1120c9d3805d4d0cfa612d8a94b34d9576476f7457f9ce7b716bcb","artifact":{"name":"youeye-installer-linux-amd64","sha256":"ec5940f572eff34142f800751bd90863805b2e9f33b7dcb024f0b69370b493a9","size_bytes":37}}` {
		t.Errorf("member JSON changed: %s", member)
	}
	compatibility, _ := json.Marshal(old.Compatibility)
	if string(compatibility) != `{"state_min":1,"state_max":1,"data_min":1,"data_max":1,"minimum_release":"0.6.1-dev.1","capabilities":["core-release-v1"]}` {
		t.Errorf("compatibility JSON changed: %s", compatibility)
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
