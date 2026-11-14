package systemupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func TestCoreHostRolledBackImageCanBeRetriedByALaterRelease(t *testing.T) {
	f := newManagerFixture(t)
	f.manager.config.CoreStatePath = filepath.Join(f.dir, "core")
	repository := useBoxRepository(t)
	hostRaw, _ := json.Marshal(f.update)
	if err := os.WriteFile(f.manifestPath, hostRaw, 0600); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	r.Version, r.Build, r.Tag = "0.6.0-dev.28", "0.6.0-dev.28", "youeye-v0.6.0-dev.28"
	responses := map[string][]byte{}
	for i := range r.Members {
		m := &r.Members[i]
		m.SourceTree, m.BuildVersion = targetCommit, "0.6.0-dev.27"
		if m.Role == "system-update" {
			m.Artifact.Name, m.Artifact.SHA256, m.Artifact.SizeBytes = "system-update-manifest.json", checksum(hostRaw), int64(len(hostRaw))
		}
		for _, a := range f.update.Artifacts {
			if a.Role == m.Role {
				m.Artifact.Name, m.Artifact.SHA256, m.Artifact.SizeBytes = a.Path, a.SHA256, a.SizeBytes
			}
		}
		// Unchanged host files are reused from the earlier release.
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, m.BuildInputs} {
			if b != nil {
				b.Release = "youeye-v0.6.0-dev.27"
			}
		}
		if m.Role == "system-update" {
			responses[releasecache.AssetURL(repository, "", r.Tag, m.Artifact)] = hostRaw
		}
		if data, ok := f.files[m.Artifact.Name]; ok {
			responses[releasecache.AssetURL(repository, "", r.Tag, m.Artifact)] = data
		}
	}
	raw, _ = json.Marshal(r)
	selection := CoreHostSelection{Raw: raw}
	options, err := f.manager.CoreHostOptions(selection)
	if err != nil {
		t.Fatal(err)
	}
	f.manager.config.HTTPClient = &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		data, ok := responses[req.URL.String()]
		if !ok {
			return nil, fmt.Errorf("undeclared host URL %s", req.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
	})}
	status, err := f.manager.Stage(context.Background(), options)
	if err != nil || status.State != PhaseStaged {
		t.Fatal(status, err)
	}
	// The core update recovered: the host transaction is rolled back and the slot state cleared.
	j, err := loadJournal(f.manager.config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	j.Phase = PhaseRollback
	if err := writeJournal(f.manager.config.JournalPath, j); err != nil {
		t.Fatal(err)
	}
	state, err := appliance.LoadState(f.manager.config.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	state.Slots.Candidate, state.Slots.CandidateImageVersion, state.Transaction = "", "", appliance.TransactionState{}
	if err := appliance.WriteStateAtomic(f.manager.config.StatePath, state); err != nil {
		t.Fatal(err)
	}
	// A later release reusing the same host image stages it again, bound to the new release.
	later := r
	later.Version, later.Build, later.Tag, later.Sequence = "0.6.0-dev.29", "0.6.0-dev.29", "youeye-v0.6.0-dev.29", r.Sequence+1
	laterRaw, _ := json.Marshal(later)
	laterOptions, err := f.manager.CoreHostOptions(CoreHostSelection{Raw: laterRaw})
	if err != nil {
		t.Fatal(err)
	}
	status, err = f.manager.Stage(context.Background(), laterOptions)
	if err != nil || status.State != PhaseStaged {
		t.Fatal("rolled-back host image could not be retried:", status, err)
	}
	if j, err = loadJournal(f.manager.config.JournalPath); err != nil || j.CoreManifestSHA256 != checksum(laterRaw) {
		t.Fatal(j, err)
	}
}
