package releasecache

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func coreFixture() CoreRelease {
	source := "https://github.com/YouEye-Platform/YouEye"
	r := CoreRelease{Schema: CoreReleaseSchema, Version: "0.5.38", Tag: "youeye-v0.5.38", Source: source, Branch: "main", SourceCommit: strings.Repeat("a", 40), Channel: "stable", Sequence: 2, PreviousManifestSHA256: strings.Repeat("c", 64), MinimumReader: 1, Authority: CoreReleaseAuthority, Compatibility: CoreCompatibility{StateMin: 1, StateMax: 1, DataMin: 1, DataMax: 1, MinimumRelease: "0.5.37", Capabilities: []string{"core-release-v1"}}}
	for _, role := range []string{"installer", "media", "appliance", "system-update", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap", "spine", "cp", "ui"} {
		version := "0.5.37"
		if role == "cp" {
			version = r.Version
		}
		tag := "youeye-v" + version
		blob := func(name string) CoreBlob {
			return CoreBlob{Name: name, URL: source + "/releases/download/" + tag + "/" + name, SHA256: strings.Repeat("b", 64), SizeBytes: 42}
		}
		member := CoreMember{Role: role, BuildVersion: version, Source: source, Branch: "main", SourceCommit: r.SourceCommit, Tag: tag, InputSHA256: strings.Repeat("e", 64), Artifact: blob(role + ".tar")}
		if role == "appliance" {
			inputs := blob("build-inputs.json")
			member.BuildInputs = &inputs
		}
		if role == "cp" {
			member.DependsOn = []string{"spine"}
		}
		if role == "ui" {
			member.DependsOn = []string{"cp"}
		}
		r.Members = append(r.Members, member)
	}
	return r
}

func TestFlatCoreReleaseSparseSelection(t *testing.T) {
	r := coreFixture()
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
	if r.Members[2].BuildVersion == r.Version {
		t.Fatal("fixture must retain older image identity")
	}
	raw, _ := json.Marshal(r)
	parsed, digest, err := ParseCoreRelease(raw)
	if err != nil || parsed.Version != r.Version || len(digest) != 64 {
		t.Fatalf("%+v %s %v", parsed, digest, err)
	}
	if _, _, err := ParseCoreRelease(append(raw, []byte(" {}")...)); err == nil {
		t.Fatal("accepted trailing document")
	}
}

func TestCorePublicReuseKeepsOriginalBranchAuthority(t *testing.T) {
	r := coreFixture()
	r.Version, r.Tag, r.Branch, r.Channel = "0.5.39-beta.1", "youeye-v0.5.39-beta.1", "beta", "beta"
	if err := r.Validate(); err != nil {
		t.Fatal("Beta selection rejected exact Stable members", err)
	}
	if channel, err := CoreMemberChannel(r.Members[0], r.Channel); err != nil || channel != "stable" {
		t.Fatal(channel, err)
	}
	r = coreFixture()
	m := &r.Members[len(r.Members)-1]
	oldTag := m.Tag
	m.BuildVersion, m.Tag, m.Branch = "0.5.38-beta.2", "youeye-v0.5.38-beta.2", "beta"
	m.Artifact.URL = strings.Replace(m.Artifact.URL, oldTag, m.Tag, 1)
	if err := r.Validate(); err != nil {
		t.Fatal("Stable selection rejected exact Beta member", err)
	}
	if channel, err := CoreMemberChannel(*m, r.Channel); err != nil || channel != "beta" {
		t.Fatal(channel, err)
	}
	m.Branch = "main"
	if err := r.Validate(); err == nil {
		t.Fatal("relabeled Beta bytes as main")
	}
	m.Branch = "dev"
	if err := r.Validate(); err == nil {
		t.Fatal("public group accepted private branch")
	}
}

func TestCoreReleaseRejectsAmbiguousJSON(t *testing.T) {
	raw, _ := json.Marshal(coreFixture())
	for _, raw := range []string{
		strings.Replace(string(raw), `"version":"0.5.38"`, `"version":"0.5.37","version":"0.5.38"`, 1),
		strings.Replace(string(raw), `"state_min":1`, `"state_min":2,"state_min":1`, 1),
		strings.Replace(string(raw), `"role":"installer"`, `"role":"cp","role":"installer"`, 1),
	} {
		if _, _, err := ParseCoreRelease([]byte(raw)); err == nil {
			t.Fatal("duplicate keys accepted")
		}
	}
	for _, branch := range []string{"Team/Fix", "main", "f-feature-12"} {
		if !ValidCoreBranch(branch) {
			t.Fatalf("safe raw branch rejected: %s", branch)
		}
	}
	for _, branch := range []string{"x/../main", "x@{1}", "x.lock", "x//y", "main\n", " a", "x..y"} {
		if ValidCoreBranch(branch) {
			t.Fatalf("unsafe raw branch accepted: %q", branch)
		}
	}
}

func TestCorePromotedSelectionRetainsDevelopmentMembers(t *testing.T) {
	r := coreFixture()
	original := "https://build.example.test/owner/YouEye"
	for i := range r.Members {
		m := &r.Members[i]
		m.Source, m.Branch, m.BuildVersion = original, "dev", "0.5.38-dev.1"
		m.Tag = "youeye-v" + m.BuildVersion
		blobs := []*CoreBlob{&m.Artifact}
		if m.BuildInputs != nil {
			blobs = append(blobs, m.BuildInputs)
		}
		for _, b := range blobs {
			b.URL = original + "/releases/download/" + m.Tag + "/" + b.Name
		}
	}
	if err := r.Validate(); err != nil {
		t.Fatal("Stable selection rejected original Dev membership", err)
	}
	blob := r.Members[0].Artifact
	url, err := CoreBlobTransportURL(r, blob)
	if err != nil || url != r.Source+"/releases/download/"+r.Tag+"/blob-"+blob.SHA256 {
		t.Fatal("promoted payload depended on private original transport", url, err)
	}
	if r.Members[0].Source != original || r.Members[0].BuildVersion != "0.5.38-dev.1" {
		t.Fatal("transport relabeled original build identity")
	}
}

func TestSharedCoreProtocolFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := ParseCoreRelease(raw)
	if err != nil || r.Version != "0.5.38" || len(r.Members) != 14 {
		t.Fatal("shared TS/Go fixture rejected", err)
	}
	for _, m := range r.Members {
		if m.Role == "appliance" && m.BuildVersion != "0.5.37" {
			t.Fatal("relabelled reused member")
		}
	}
}

func TestCoreReleaseRejectsIncompleteOrUnsafeMembership(t *testing.T) {
	cases := map[string]func(*CoreRelease){
		"missing role":    func(r *CoreRelease) { r.Members = r.Members[1:] },
		"duplicate role":  func(r *CoreRelease) { r.Members = append(r.Members, r.Members[0]) },
		"foreign payload": func(r *CoreRelease) { r.Members[0].Artifact.URL = "https://other.example/a.tar" },
		"mutable path":    func(r *CoreRelease) { r.Members[0].Artifact.URL = r.Source + "/releases/latest/download/a.tar" },
		"escaped traversal": func(r *CoreRelease) {
			r.Members[0].Artifact.URL = r.Source + "/releases/download/youeye-v0.5.37/%2e%2e%2fsecret"
		},
		"unknown reader":     func(r *CoreRelease) { r.MinimumReader++ },
		"missing artifact":   func(r *CoreRelease) { r.Members[0].Artifact = CoreBlob{} },
		"missing authority":  func(r *CoreRelease) { r.Authority = "" },
		"signed authority":   func(r *CoreRelease) { r.Authority = "ed25519" },
		"missing inputs":     func(r *CoreRelease) { r.Members[2].BuildInputs = nil },
		"stray inputs":       func(r *CoreRelease) { r.Members[0].BuildInputs = r.Members[2].BuildInputs },
		"public private mix": func(r *CoreRelease) { r.Members[0].Branch = "dev" },
		"cyclic graph":       func(r *CoreRelease) { r.Members[0].DependsOn = []string{"ui"} },
		"missing dependency": func(r *CoreRelease) { r.Members[len(r.Members)-1].DependsOn = nil },
		"wrong track":        func(r *CoreRelease) { r.Version = "0.5.38-dev.1"; r.Tag = "youeye-v" + r.Version },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := coreFixture()
			mutate(&r)
			if err := r.Validate(); err == nil {
				t.Fatal("invalid membership accepted")
			}
		})
	}
}

func TestCoreReleaseRejectsRemovedSignatureFields(t *testing.T) {
	raw, _ := json.Marshal(coreFixture())
	for _, raw := range []string{
		strings.Replace(string(raw), `"authority":"digest"`, `"authority":"digest","signature":{}`, 1),
		strings.Replace(string(raw), `"role":"installer"`, `"role":"installer","key_id":"`+strings.Repeat("d", 64)+`"`, 1),
	} {
		if _, _, err := ParseCoreRelease([]byte(raw)); err == nil {
			t.Fatal("unknown signing field accepted")
		}
	}
}

// An explicit empty depends_on and an omitted one must parse to the same value,
// so a release round-tripped through a receipt (omitempty) still DeepEquals.
func TestCoreReleaseEmptyDependsOnSurvivesJSONRoundTrip(t *testing.T) {
	raw, err := os.ReadFile("testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, m := range doc["members"].([]any) {
		member := m.(map[string]any)
		if _, ok := member["depends_on"]; !ok {
			member["depends_on"] = []any{}
		}
	}
	withEmpty, _ := json.Marshal(doc)
	parsed, _, err := ParseCoreRelease(withEmpty)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		t.Fatal(err)
	}
	var roundTripped CoreRelease
	if err := json.Unmarshal(encoded, &roundTripped); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(parsed, roundTripped) {
		t.Fatal("core release with empty depends_on changed across a JSON round trip")
	}
}
