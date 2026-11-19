package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// /api/version keeps the binary's own value in version (a 0.6.11 Spine
// compares it during a Spine trial) and adds the installed release's version
// and the binary's git tree.
func TestVersionNamesTheInstalledRelease(t *testing.T) {
	s, receipt, _, _ := coreStatusFixture(t)
	s.version = "0.6.12-dev.3"
	answer := func() map[string]string {
		w := httptest.NewRecorder()
		s.handleVersion(w, httptest.NewRequest(http.MethodGet, "/api/version", nil))
		var body map[string]string
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		return body
	}
	body := answer()
	if body["version"] != "0.6.12-dev.3" || body["service"] != "youeye" || body["release"] != receipt.Release.Version {
		t.Fatalf("%v", body)
	}
	if _, ok := body["source_tree"]; ok {
		t.Fatalf("a binary without a baked tree reported one: %v", body)
	}
	s.SetSourceTree(strings.Repeat("c", 40))
	if body = answer(); body["source_tree"] != strings.Repeat("c", 40) {
		t.Fatalf("%v", body)
	}
	// No receipt (a fresh install before its first commit, or not an appliance): no release.
	s.coreStatePath = t.TempDir()
	if body = answer(); body["version"] != "0.6.12-dev.3" || body["release"] != "" {
		t.Fatalf("%v", body)
	}
	if _, ok := body["release"]; ok {
		t.Fatalf("release reported without a receipt: %v", body)
	}
}

// The core status names the installed release by its version and its parts by
// role, tree and sha256; never by build.
func TestCoreStatusNamesNoBuild(t *testing.T) {
	s, receipt, _, _ := coreStatusFixture(t)
	w := httptest.NewRecorder()
	s.handleCoreUpdateStatus(w, httptest.NewRequest(http.MethodGet, "/", nil))
	var status struct {
		Installed struct {
			Release map[string]any      `json:"release"`
			Members []map[string]string `json:"members"`
		} `json:"installed"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &status) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, ok := status.Installed.Release["build"]; ok || status.Installed.Release["version"] != receipt.Release.Version {
		t.Fatalf("release: %v", status.Installed.Release)
	}
	if len(status.Installed.Members) != len(receipt.Release.Members) {
		t.Fatalf("members: %v", status.Installed.Members)
	}
	for i, member := range status.Installed.Members {
		want := receipt.Release.Members[i]
		if len(member) != 3 || member["role"] != want.Role || member["source_tree"] != want.SourceTree || member["sha256"] != want.Artifact.SHA256 {
			t.Fatalf("member %d: %v", i, member)
		}
	}
}
