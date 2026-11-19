package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/spineselect"
)

// fakeSpine is an executable that answers `spine contract` with report.
func fakeSpine(t *testing.T, report string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "youeye")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n[ \"$1 $2\" = \"spine contract\" ] || exit 9\nprintf '%s\\n' '"+report+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

// A selection entry is identified by its digest. Its version is only a name,
// and never empty (a Spine up to 0.6.11 skips an entry without one): the
// release's name for the Spine when the document has one, else what the binary
// calls itself, else the release's line.
func TestSpineEntryNamesTheSpineWithoutIdentifyingByIt(t *testing.T) {
	digest, tree := strings.Repeat("a", 64), strings.Repeat("1", 40)
	for name, c := range map[string]struct {
		report      string
		identity    spineIdentity
		version     string
		line        string
		wantFailure bool
	}{
		"document up to 0.6.12 names the build":       {`{"disk_layout":1,"helper_contract":1,"version":"0.6.12-dev.3"}`, spineIdentity{SHA256: digest, Version: "0.6.12-dev.3", Line: "0.6.12", SourceTree: tree}, "0.6.12-dev.3", "0.6.12", false},
		"the document's name wins over the binary's":  {`{"disk_layout":1,"helper_contract":1,"version":"0.0.0"}`, spineIdentity{SHA256: digest, Version: "0.6.12-dev.3", Line: "0.6.12", SourceTree: tree}, "0.6.12-dev.3", "0.6.12", false},
		"no name in the document: the binary's line":  {`{"disk_layout":1,"helper_contract":1,"version":"0.6.13"}`, spineIdentity{SHA256: digest, Line: "0.6.14", SourceTree: tree}, "0.6.13", "0.6.13", false},
		"a Spine that does not say: the release line": {`{"disk_layout":1,"helper_contract":1}`, spineIdentity{SHA256: digest, Line: "0.6.13", SourceTree: tree}, "0.6.13", "0.6.13", false},
		"a binary that says nonsense":                 {`{"disk_layout":1,"helper_contract":1,"version":"dev build"}`, spineIdentity{SHA256: digest, Line: "0.6.13", SourceTree: tree}, "0.6.13", "0.6.13", false},
		"nothing names it at all":                     {`{"disk_layout":1,"helper_contract":1}`, spineIdentity{SHA256: digest}, "aaaaaaaaaaaa", "", false},
		"no contract":                                 {`{"version":"0.6.13"}`, spineIdentity{SHA256: digest, Line: "0.6.13"}, "", "", true},
	} {
		e, err := spineEntry(context.Background(), fakeSpine(t, c.report), c.identity)
		if c.wantFailure {
			if err == nil {
				t.Errorf("%s: accepted", name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if e.SHA256 != digest || e.Version != c.version || e.Version == "" || e.Line != c.line || e.SourceTree != c.identity.SourceTree || e.DiskLayout != 1 || e.HelperContract != 1 {
			t.Errorf("%s: entry %+v", name, e)
		}
	}
}

func TestReleaseSpineIdentityInBothDocumentShapes(t *testing.T) {
	for name, want := range map[string]spineIdentity{
		"core-release.json":          {Version: "0.6.1-dev.1", Line: "0.6.1"},
		"core-release-no-build.json": {Version: "", Line: "0.6.13"},
	} {
		raw, err := os.ReadFile("../../../releasecache/testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		release, _, err := releasecache.ParseCoreRelease(raw)
		if err != nil {
			t.Fatal(err)
		}
		member, _ := release.Member("spine")
		got := releaseSpineIdentity(release, member)
		if got.SHA256 != member.Artifact.SHA256 || got.SourceTree != member.SourceTree || got.Version != want.Version || got.Line != want.Line || got.label() == "" {
			t.Errorf("%s: %+v", name, got)
		}
	}
}

// `spine contract` is asked by the Spine that installs this one, which may be
// older: it reads the two contract numbers and ignores the rest.
func TestSpineContractReportIsReadableByOlderSpines(t *testing.T) {
	old := Version
	t.Cleanup(func() { Version = old })
	Version = "0.6.12-dev.3"
	var out bytes.Buffer
	contract, _, err := spineCmd.Find([]string{"contract"})
	if err != nil {
		t.Fatal(err)
	}
	contract.SetOut(&out)
	if err := contract.RunE(contract, nil); err != nil {
		t.Fatal(err)
	}
	var host spineselect.Host
	if err := json.Unmarshal(out.Bytes(), &host); err != nil || host != spineselect.ThisHost() {
		t.Fatalf("an older Spine cannot read the contract: %s %v", out.String(), err)
	}
	var report spineContractReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil || report.Version != "0.6.12-dev.3" || report.Host != spineselect.ThisHost() {
		t.Fatalf("contract report: %s", out.String())
	}
}
