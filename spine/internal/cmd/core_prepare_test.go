package cmd

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func TestCorePrepareRetryUsesFrozenRequestWithoutDiscovery(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	release, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	m := systemupdate.CoreManager{Root: t.TempDir()}
	if err = os.Mkdir(filepath.Join(m.Root, "targets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(m.Root, "targets", digest+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	j := systemupdate.CoreJournal{Schema: systemupdate.CoreJournalSchema, RequestID: "lost-response", ManifestSHA256: digest, Target: release, Phase: "prepared"}
	for _, name := range []string{"verify-members", "checkpoint", "apply-cp", "apply-ui", "authenticated-health"} {
		j.Steps = append(j.Steps, systemupdate.CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"})
	}
	encoded, _ := json.Marshal(j)
	if err = os.WriteFile(filepath.Join(m.Root, "journal.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	// This fixture has neither installed runtime policy nor network authority.
	got, err := prepareCoreRequest(context.Background(), m, j.RequestID, digest)
	if err != nil || got.ManifestSHA256 != digest || got.RequestID != j.RequestID {
		t.Fatal(got.RequestID, err)
	}
	if _, err = prepareCoreRequest(context.Background(), m, j.RequestID, strings.Repeat("f", 64)); err == nil {
		t.Fatal("retained request rebound")
	}
}
