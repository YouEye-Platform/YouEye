package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

type coreTestExecutor struct {
	starts         map[string]int
	results        map[string]CoreActionObservation
	lose           string
	denyActivation bool
}

func (e *coreTestExecutor) Authorize(_ context.Context, _ CoreJournal, activation bool) error {
	if activation && e.denyActivation {
		return fmt.Errorf("authority revoked after staging")
	}
	return nil
}
func (e *coreTestExecutor) Start(_ context.Context, _ CoreJournal, s CoreStep) (CoreActionObservation, error) {
	e.starts[s.Name]++
	out := CoreActionObservation{State: "succeeded", Evidence: "fixture-receipt/" + s.RequestID}
	e.results[s.RequestID] = out
	if e.lose == s.Name {
		e.lose = ""
		return CoreActionObservation{}, fmt.Errorf("lost acknowledgement")
	}
	return out, nil
}
func (e *coreTestExecutor) Observe(_ context.Context, _ CoreJournal, s CoreStep) (CoreActionObservation, error) {
	if result, ok := e.results[s.RequestID]; ok {
		return result, nil
	}
	return CoreActionObservation{State: "unknown"}, nil
}

func coreJournalFixture(t *testing.T) (CoreManager, *coreTestExecutor, releasecache.CoreRelease) {
	t.Helper()
	source := "https://github.com/YouEye-Platform/YouEye"
	r := releasecache.CoreRelease{Schema: releasecache.CoreReleaseSchema, Version: "0.5.37", Tag: "youeye-v0.5.37", Source: source, Branch: "main", SourceCommit: strings.Repeat("a", 40), Channel: "stable", Sequence: 1, MinimumReader: 1, SignerSHA256: strings.Repeat("b", 64), Compatibility: releasecache.CoreCompatibility{StateMin: 1, StateMax: 1, DataMin: 1, DataMax: 1, MinimumRelease: "0.5.37", Capabilities: []string{"core-release-v1"}}}
	for _, role := range []string{"installer", "media", "appliance", "system-update", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap", "spine", "cp", "ui"} {
		blob := func(name string) releasecache.CoreBlob {
			return releasecache.CoreBlob{Name: name, URL: source + "/releases/download/youeye-v0.5.37/" + name, SHA256: strings.Repeat("c", 64), SizeBytes: 42}
		}
		member := releasecache.CoreMember{Role: role, BuildVersion: r.Version, Source: source, Branch: "main", SourceCommit: r.SourceCommit, Tag: r.Tag, InputSHA256: strings.Repeat("d", 64), Artifact: blob(role + ".tar"), Checksums: blob("SHA256SUMS"), Signature: blob("SHA256SUMS.sig"), Provenance: blob("provenance.json"), SBOM: blob("sbom.json"), KeyID: r.SignerSHA256}
		if role == "appliance" || role == "system-update" {
			signature := blob(role + ".json.sig")
			member.DocumentSignature = &signature
		}
		if role == "appliance" {
			lock := blob("release-lock.json")
			member.ReleaseLock = &lock
		}
		if role == "cp" {
			member.DependsOn = []string{"spine"}
		}
		if role == "ui" {
			member.DependsOn = []string{"cp"}
		}
		r.Members = append(r.Members, member)
	}
	e := &coreTestExecutor{starts: map[string]int{}, results: map[string]CoreActionObservation{}}
	m := CoreManager{Root: t.TempDir(), Executor: e}
	raw, _ := json.Marshal(r)
	_, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicWrite(filepath.Join(m.Root, "targets", digest+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	receipt := CoreReceipt{ManifestSHA256: digest, Release: r, AcceptedAt: m.now(), Machine: CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state", DataPartUUID: "data"}, Evidence: "fixture acceptance"}
	encoded, _ := json.Marshal(receipt)
	if err := atomicWrite(filepath.Join(m.Root, "committed.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	r.Version = "0.5.38"
	r.Tag = "youeye-v0.5.38"
	r.Sequence = 2
	r.PreviousManifestSHA256 = digest
	return m, e, r
}

func prepareCoreFixture(t *testing.T, m CoreManager, r releasecache.CoreRelease) CoreJournal {
	t.Helper()
	raw, _ := json.Marshal(r)
	_, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	j, err := m.Prepare(context.Background(), "update-1", raw, digest)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestCoreJournalServiceOnlyAndLostAcknowledgement(t *testing.T) {
	m, e, r := coreJournalFixture(t)
	e.lose = "apply-cp"
	j := prepareCoreFixture(t, m, r)
	if j.RestartRequired {
		t.Fatal("unchanged host requested reboot")
	}
	if _, err := m.Advance(context.Background(), j.RequestID, false); err == nil {
		t.Fatal("missing lost acknowledgement")
	}
	receipt, err := m.ReadReceipt()
	if err != nil || receipt.Release.Version != "0.5.37" {
		t.Fatal("committed before convergence", err)
	}
	j, err = m.Advance(context.Background(), j.RequestID, false)
	if err != nil || j.Phase != "committed" {
		t.Fatal(j.Phase, err)
	}
	if e.starts["apply-cp"] != 1 || e.starts["activate-host"] != 0 {
		t.Fatal("effect replay or unnecessary reboot", e.starts)
	}
	receipt, err = m.ReadReceipt()
	if err != nil || receipt.Release.Version != r.Version {
		t.Fatal("missing complete receipt", err)
	}
}

func TestCoreJournalHostWaitAndRevocation(t *testing.T) {
	m, e, r := coreJournalFixture(t)
	for i := range r.Members {
		if r.Members[i].Role == "system-root" {
			r.Members[i].Artifact.SHA256 = strings.Repeat("e", 64)
		}
	}
	j := prepareCoreFixture(t, m, r)
	j, err := m.Advance(context.Background(), j.RequestID, false)
	if err != nil || j.Phase != "awaiting-restart" {
		t.Fatal(j.Phase, err)
	}
	if e.starts["apply-cp"] != 0 || e.starts["activate-host"] != 0 || e.starts["checkpoint"] != 0 {
		t.Fatal("activated before chosen restart")
	}
	e.denyActivation = true
	if _, err := m.Advance(context.Background(), j.RequestID, true); err == nil {
		t.Fatal("activated revoked staged target")
	}
	if e.starts["activate-host"] != 0 {
		t.Fatal("activation had effects after authority rejection")
	}
	// This is a unit fixture of explicit trust restoration, not a runtime test.
	e.denyActivation = false
	j, err = m.Advance(context.Background(), j.RequestID, true)
	if err != nil || j.Phase != "committed" {
		t.Fatal(j.Phase, err)
	}
	if e.starts["stage-host"] != 1 || e.starts["commit-host"] != 1 {
		t.Fatal("host lifecycle was not exact", e.starts)
	}
}

func TestCoreJournalUnknownDoesNotReplayAndTargetCannotChange(t *testing.T) {
	m, e, r := coreJournalFixture(t)
	e.lose = "apply-ui"
	j := prepareCoreFixture(t, m, r)
	_, _ = m.Advance(context.Background(), j.RequestID, false)
	delete(e.results, j.RequestID+"/apply-ui")
	j, err := m.Advance(context.Background(), j.RequestID, false)
	if err != nil || j.Phase == "committed" || e.starts["apply-ui"] != 1 {
		t.Fatal("unknown effect was replayed", j.Phase, err)
	}
	r.Version = "0.5.39"
	r.Tag = "youeye-v0.5.39"
	raw, _ := json.Marshal(r)
	_, digest, _ := releasecache.ParseCoreRelease(raw)
	if _, err := m.Prepare(context.Background(), j.RequestID, raw, digest); err == nil {
		t.Fatal("repurposed accepted request")
	}
	if _, err := m.Prepare(context.Background(), "another", raw, digest); err == nil {
		t.Fatal("overlapped unfinished lifecycle")
	}
	if err := os.WriteFile(filepath.Join(m.Root, "targets", j.ManifestSHA256+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Read(); err == nil {
		t.Fatal("changed frozen manifest accepted")
	}
}

func TestCoreRequestRemainsBoundAfterLaterUpdate(t *testing.T) {
	m, e, first := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, first)
	if _, err := m.Advance(context.Background(), j.RequestID, false); err != nil {
		t.Fatal(err)
	}
	second := first
	second.Version, second.Tag, second.Sequence = "0.5.39", "youeye-v0.5.39", 3
	raw, _ := json.Marshal(second)
	_, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Prepare(context.Background(), "update-2", raw, digest); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Advance(context.Background(), "update-2", false); err != nil {
		t.Fatal(err)
	}
	starts := e.starts["apply-cp"]
	firstRaw, _ := json.Marshal(first)
	retained, err := m.Prepare(context.Background(), j.RequestID, firstRaw, j.ManifestSHA256)
	if err != nil || retained.Phase != "committed" || retained.ManifestSHA256 != j.ManifestSHA256 {
		t.Fatal("old request lost its receipt", retained.Phase, err)
	}
	if _, err = m.Prepare(context.Background(), j.RequestID, raw, digest); err == nil {
		t.Fatal("old request ID rebound after a later update")
	}
	current, err := m.Read()
	if err != nil || current.RequestID != "update-2" || e.starts["apply-cp"] != starts {
		t.Fatal("historical lookup changed active state or replayed an action")
	}
}

func TestCoreNoOpVerifiesWithoutCheckpointOrMigration(t *testing.T) {
	m, executor, _ := coreJournalFixture(t)
	receipt, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(receipt.Release)
	j, err := m.Prepare(context.Background(), "no-op", raw, receipt.ManifestSHA256)
	if err != nil || !j.NoOp || j.RestartRequired {
		t.Fatal(j, err)
	}
	j, err = m.Advance(context.Background(), "no-op", false)
	if err != nil || j.Phase != "committed" {
		t.Fatal(j, err)
	}
	if len(executor.starts) != 2 || executor.starts["verify-members"] != 1 || executor.starts["authenticated-health"] != 1 {
		t.Fatal(executor.starts)
	}
	current, err := m.ReadReceipt()
	if err != nil || current.ManifestSHA256 != receipt.ManifestSHA256 || current.Machine != receipt.Machine || current.AcceptedAt != receipt.AcceptedAt {
		t.Fatal(current, err)
	}
}

func TestCoreCoordinatorDoesNotReplayStartedActionReportedAbsent(t *testing.T) {
	m, e, target := coreJournalFixture(t)
	e.lose = "apply-cp"
	j := prepareCoreFixture(t, m, target)
	if _, err := m.Advance(context.Background(), j.RequestID, false); err == nil {
		t.Fatal("missing lost acknowledgement")
	}
	e.results[j.RequestID+"/apply-cp"] = CoreActionObservation{State: "absent"}
	current, err := m.Advance(context.Background(), j.RequestID, false)
	if err != nil || current.Phase == "committed" || e.starts["apply-cp"] != 1 {
		t.Fatal("missing action receipt replayed effect", current.Phase, e.starts["apply-cp"], err)
	}
}
