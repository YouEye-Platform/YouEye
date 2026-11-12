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
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func TestCoreHostStagesAliasedPayloadsAndRetainsSelection(t *testing.T) {
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
	r.Version, r.Tag = "0.6.0-rc.28", "youeye-v0.6.0-rc.28"
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
				b.Release = "youeye-v0.6.0-rc.27"
			}
		}
		if m.Role == "system-update" {
			responses[releasecache.AssetURL(repository, r.Tag, m.Artifact)] = hostRaw
		}
		if data, ok := f.files[m.Artifact.Name]; ok {
			responses[releasecache.AssetURL(repository, r.Tag, m.Artifact)] = data
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
	j, err := loadJournal(f.manager.config.JournalPath)
	if err != nil || j.CoreManifestSHA256 != checksum(raw) {
		t.Fatal(j, err)
	}
	if _, err := f.manager.loadTransactionManifest(j); err != nil {
		t.Fatal(err)
	}
	// A legacy caller cannot adopt this core transaction even with identical
	// host bytes; neither can a new assembly silently reuse its active journal.
	legacy := options
	legacy.Core = nil
	if _, err := f.manager.Stage(context.Background(), legacy); err == nil {
		t.Fatal("legacy caller adopted core transaction")
	}
	changed := r
	changed.Sequence++
	changedRaw, _ := json.Marshal(changed)
	changedOptions, err := f.manager.CoreHostOptions(CoreHostSelection{Raw: changedRaw})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.Stage(context.Background(), changedOptions); err == nil {
		t.Fatal("another assembly adopted staged host")
	}
	// Reboot-time readback must verify the protected assembly again.
	path := filepath.Join(f.manager.transactionDir(j.TransactionID), "core-release.json")
	if err := os.WriteFile(path, bytes.Replace(raw, []byte("0.6.0-dev.28"), []byte("0.6.0-dev.29"), 1), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.Activate(context.Background(), false); err == nil {
		t.Fatal("tampered frozen core activated")
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.Activate(context.Background(), false); err == nil {
		t.Fatal("host activated without core checkpoint authorization")
	}
	// A durable coordinator with the same target and completed checkpoint is
	// the only path to activation; host commitment waits for all later steps.
	jCore := CoreJournal{Schema: CoreJournalSchema, RequestID: "fixture", Target: r, ManifestSHA256: checksum(raw), Phase: "applying", RestartRequired: true, ActivationRequested: true}
	for _, name := range coreStepNames(true) {
		state, evidence := "pending", ""
		if name == "verify-members" || name == "stage-host" || name == "checkpoint" {
			state, evidence = "succeeded", "fixture"
		}
		if name == "activate-host" {
			state = "started"
		}
		jCore.Steps = append(jCore.Steps, CoreStep{Name: name, RequestID: "fixture/" + name, State: state, Evidence: evidence})
	}
	cm := CoreManager{Root: f.manager.config.CoreStatePath}
	if err := atomicWrite(filepath.Join(cm.Root, "targets", checksum(raw)+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := cm.saveCore(&jCore); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.Activate(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.CheckCoreHostCommit(); err == nil {
		t.Fatal("host committed before service acceptance")
	}
	for i := range jCore.Steps {
		jCore.Steps[i].State, jCore.Steps[i].Evidence = "succeeded", "fixture"
		if jCore.Steps[i].Name == "commit-host" {
			jCore.Steps[i].State = "started"
		}
	}
	if err := cm.saveCore(&jCore); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.CheckCoreHostCommit(); err != nil {
		t.Fatal(err)
	}
	// Reconcile a lost blessing acknowledgement without blessing twice.
	image := testApplianceManifest("0.6.0-dev.27", targetCommit)
	for _, member := range r.Members {
		if member.Role == "spine" {
			image.ReleaseSet.Spine = appliance.ComponentRelease{Version: member.BuildVersion, SourceTree: member.SourceTree, ArtifactSHA256: member.Artifact.SHA256}
		}
	}
	imageRaw, _ := json.Marshal(image)
	if err := os.WriteFile(f.manager.config.CurrentManifestPath, imageRaw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.manager.config.KernelCmdlinePath, []byte("root=PARTLABEL=YE-SYSTEM-B ro"), 0600); err != nil {
		t.Fatal(err)
	}
	bootStatus, blessCalls := "indeterminate", 0
	priorRun := f.manager.config.Run
	f.manager.config.Run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == coreBootBlessExecutable {
			if len(args) == 1 && args[0] == "status" {
				return []byte(bootStatus), nil
			}
			if len(args) == 1 && args[0] == "good" {
				blessCalls++
				bootStatus = "good"
				return nil, fmt.Errorf("fixture lost blessing acknowledgement")
			}
			return nil, fmt.Errorf("unexpected blessing effect")
		}
		return priorRun(ctx, name, args...)
	}
	if observation, err := f.manager.CommitCoreHost(context.Background(), "fixture", true); err != nil || observation.State != "unknown" || blessCalls != 0 {
		t.Fatal(observation, err, blessCalls)
	}
	if _, err := f.manager.CommitCoreHost(context.Background(), "fixture", false); err == nil || blessCalls != 1 {
		t.Fatal("lost blessing acknowledgement not retained", err, blessCalls)
	}
	if observation, err := f.manager.CommitCoreHost(context.Background(), "fixture", true); err != nil || observation.State != "succeeded" || blessCalls != 1 {
		t.Fatal(observation, err, blessCalls)
	}
	if observation, err := f.manager.CommitCoreHost(context.Background(), "fixture", true); err != nil || observation.State != "succeeded" || blessCalls != 1 {
		t.Fatal("repeated commitment changed effect", observation, err, blessCalls)
	}
	// The original signed host identity remains distinct from the shared one.
	state, _ := appliance.LoadState(f.manager.config.StatePath)
	if !strings.HasSuffix(state.Slots.CurrentImageVersion, ".27") || state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
		t.Fatal(state)
	}
}
