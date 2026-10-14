package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
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

func TestCoreHostStagesAliasedPayloadsAndRetainsSignedSelection(t *testing.T) {
	f := newManagerFixture(t)
	f.manager.config.CoreStatePath = filepath.Join(f.dir, "core")
	keyRaw, err := os.ReadFile(filepath.Join(filepath.Dir(f.manifestPath), "trust.key"))
	if err != nil {
		t.Fatal(err)
	}
	key := ed25519.PrivateKey(keyRaw)
	der, _ := x509.MarshalPKIXPublicKey(key.Public())
	keyID := checksum(der)
	source := "https://forge.example/owner/YouEye"
	// Re-sign the host fixture under a development source. The current image
	// retains the same selected source, so no source transition is implicit.
	current, _ := os.ReadFile(f.manager.config.CurrentManifestPath)
	current = bytes.ReplaceAll(current, []byte(releasecache.OfficialRepository), []byte(source))
	if err := os.Chmod(f.manager.config.CurrentManifestPath, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.manager.config.CurrentManifestPath, current, 0600); err != nil {
		t.Fatal(err)
	}
	f.update.ReleaseSet.Source = source
	f.update.Trust.KeyID, _ = publicKeyID(key.Public().(ed25519.PublicKey))
	hostRaw, _ := json.Marshal(f.update)
	hostSig := ed25519.Sign(key, hostRaw)
	for name, raw := range map[string][]byte{f.manifestPath: hostRaw, f.signaturePath: hostSig} {
		if err := os.WriteFile(name, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	r.Source, r.Branch, r.Channel, r.Version, r.Tag = source, "dev", "dev", "0.6.0-dev.28", "youeye-v0.6.0-dev.28"
	r.SignerSHA256 = keyID
	responses := map[string][]byte{}
	for i := range r.Members {
		m := &r.Members[i]
		m.Source, m.Branch, m.SourceCommit, m.KeyID = source, "dev", targetCommit, keyID
		m.Tag, m.BuildVersion = "youeye-v0.6.0-dev.27", "0.6.0-dev.27"
		if m.Role == "system-update" {
			m.Artifact.Name, m.Artifact.SHA256, m.Artifact.SizeBytes = "system-update-manifest.json", checksum(hostRaw), int64(len(hostRaw))
			m.DocumentSignature.Name, m.DocumentSignature.SHA256, m.DocumentSignature.SizeBytes = "system-update-manifest.json.sig", checksum(hostSig), int64(len(hostSig))
		}
		for _, a := range f.update.Artifacts {
			if a.Role == m.Role {
				m.Artifact.Name, m.Artifact.SHA256, m.Artifact.SizeBytes = a.Path, a.SHA256, a.SizeBytes
			}
		}
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM, m.DocumentSignature, m.ReleaseLock} {
			if b != nil {
				b.URL = source + "/releases/download/" + m.Tag + "/appliance-" + b.Name
			}
		}
		if m.Role == "system-update" {
			responses[m.Artifact.URL], responses[m.DocumentSignature.URL] = hostRaw, hostSig
		}
		if data, ok := f.files[m.Artifact.Name]; ok {
			responses[m.Artifact.URL] = data
		}
	}
	raw, _ = json.Marshal(r)
	selection := CoreHostSelection{Raw: raw, Signature: ed25519.Sign(key, raw)}
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
	changedOptions, err := f.manager.CoreHostOptions(CoreHostSelection{Raw: changedRaw, Signature: ed25519.Sign(key, changedRaw)})
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
	image.ReleaseSet.Source = source
	for _, member := range r.Members {
		if member.Role == "spine" {
			image.ReleaseSet.Spine = appliance.ComponentRelease{Version: member.BuildVersion, Tag: member.Tag, SourceCommit: member.SourceCommit, ArtifactSHA256: member.Artifact.SHA256}
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
