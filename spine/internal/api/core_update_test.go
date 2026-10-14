package api

import (
	"encoding/json"
	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/config"
)

func TestCoreStatusAndComponentUpdateFailClosedOnDamagedReceipt(t *testing.T) {
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
	for name, handler := range map[string]http.HandlerFunc{"status": s.handleCoreUpdateStatus, "control": s.handleUpdateControl} {
		t.Run(name, func(t *testing.T) {
			method := http.MethodGet
			if name == "control" {
				method = http.MethodPost
			}
			w := httptest.NewRecorder()
			handler(w, httptest.NewRequest(method, "/", nil))
			if w.Code != http.StatusConflict {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}

func TestCoreStatusDoesNotExposeRawMachineIdentityOrImplyFreshObservation(t *testing.T) {
	s := NewServer("test", config.Default())
	s.coreStatePath = t.TempDir()
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
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
	w = httptest.NewRecorder()
	s.handleCoreUpdateStatus(w, httptest.NewRequest(http.MethodGet, "/?observe=1", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"payload_observation":"unverified"`) || strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "protected-evidence") {
		t.Fatal("explicit observation without native verifier inferred freshness or exposed protected data", w.Body.String())
	}
}
