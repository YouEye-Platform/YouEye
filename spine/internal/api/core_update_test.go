package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"

	"github.com/youeye-platform/YouEye/spine/internal/config"
)

func TestCoreStatusFailsClosedOnDamagedReceipt(t *testing.T) {
	s := NewServer("test", config.Default())
	s.coreStatePath = t.TempDir()
	s.runtimeDetect = applianceTestRuntime
	w := httptest.NewRecorder()
	s.handleCoreUpdateStatus(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"managed":false`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := os.WriteFile(filepath.Join(s.coreStatePath, "committed.json"), []byte(`{"broken":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	s.handleCoreUpdateStatus(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != http.StatusConflict {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestCoreStatusDoesNotExposeRawMachineIdentityOrImplyFreshObservation(t *testing.T) {
	s := NewServer("test", config.Default())
	s.coreStatePath = t.TempDir()
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	release, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(s.coreStatePath, "targets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.coreStatePath, "targets", digest+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	receipt := systemupdate.CoreReceipt{ManifestSHA256: digest, Release: release, AcceptedAt: "fixture-time", Evidence: "protected-evidence", Machine: systemupdate.CoreMachineIdentity{InstallIDRef: "private-install", DeviceIDRef: "private-device", ParentDiskID: "private-disk", StatePartUUID: "private-state", DataPartUUID: "private-data"}}
	encoded, _ := json.Marshal(receipt)
	if err := os.WriteFile(filepath.Join(s.coreStatePath, "committed.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.handleCoreUpdateStatus(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "protected-evidence") {
		t.Fatal("raw protected receipt exposed")
	}
	if !strings.Contains(w.Body.String(), `"machine_bound":true`) || !strings.Contains(w.Body.String(), `"payload_observation":"not-observed"`) {
		t.Fatal(w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"selection"`) {
		t.Fatal("selection reported without an accepted release policy", w.Body.String())
	}
	// The read-only System source comes from the installer-recorded policy.
	s.coreBootstrapPath = t.TempDir()
	policy, _ := json.Marshal(systemupdate.ReleasePolicy{Schema: systemupdate.ReleasePolicySchema, Repository: "https://forge.example/owner/YouEye", Channel: "beta", CoreManifestSHA256: digest})
	for name, data := range map[string][]byte{"core-release.json": raw, "release-policy.json": policy} {
		if err := os.WriteFile(filepath.Join(s.coreBootstrapPath, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	w = httptest.NewRecorder()
	s.handleCoreUpdateStatus(w, httptest.NewRequest(http.MethodGet, "/", nil))
	var status struct {
		Selection map[string]string `json:"selection"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil || status.Selection["repository"] != "https://forge.example/owner/YouEye" || status.Selection["channel"] != "beta" || len(status.Selection) != 2 {
		t.Fatal("policy selection not reported", w.Body.String(), err)
	}
	w = httptest.NewRecorder()
	s.handleCoreUpdateStatus(w, httptest.NewRequest(http.MethodGet, "/?observe=1", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"payload_observation":"unverified"`) || strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "protected-evidence") {
		t.Fatal("explicit observation without native verifier inferred freshness or exposed protected data", w.Body.String())
	}
}
