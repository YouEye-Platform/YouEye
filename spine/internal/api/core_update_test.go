package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
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

type coreStatusObserver struct {
	CoreUpdateOperations
	observation systemupdate.CoreInstalledObservation
}

func (o coreStatusObserver) ObserveInstalled(context.Context, systemupdate.CoreReceipt) systemupdate.CoreInstalledObservation {
	return o.observation
}

// coreStatusFixture installs the fixture release and returns a target that
// replaces the Control Panel.
func coreStatusFixture(t *testing.T) (*Server, systemupdate.CoreReceipt, releasecache.CoreRelease, string) {
	t.Helper()
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
	receipt := systemupdate.CoreReceipt{ManifestSHA256: digest, Release: release, AcceptedAt: "fixture-time", Evidence: "protected-evidence", Machine: systemupdate.CoreMachineIdentity{InstallIDRef: "private-install", DeviceIDRef: "private-device", ParentDiskID: "private-disk", StatePartUUID: "private-state", DataPartUUID: "private-data"}}
	encoded, _ := json.Marshal(receipt)
	target := release
	target.Members = append([]releasecache.CoreMember(nil), release.Members...)
	target.Version, target.Build, target.Tag = "9.9.9-dev.1", "9.9.9-dev.1", "youeye-v9.9.9-dev.1"
	target.Sequence++
	for i := range target.Members {
		if target.Members[i].Role == "cp" {
			target.Members[i].Artifact.SHA256 = strings.Repeat("9", 64)
		}
	}
	targetRaw, _ := json.Marshal(target)
	target, targetDigest, err := releasecache.ParseCoreRelease(targetRaw)
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{"committed.json": encoded, "targets/" + digest + ".json": raw, "targets/" + targetDigest + ".json": targetRaw} {
		if err := os.WriteFile(filepath.Join(s.coreStatePath, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return s, receipt, target, targetDigest
}

// coreStatusJournal writes a journal over the fixture's graph with the given
// step states and evidence, and returns it.
func coreStatusJournal(t *testing.T, s *Server, receipt systemupdate.CoreReceipt, target releasecache.CoreRelease, digest, phase string, states map[string][2]string, recovery map[string][2]string) systemupdate.CoreJournal {
	t.Helper()
	j := systemupdate.CoreJournal{Schema: systemupdate.CoreJournalSchema, RequestID: "update-1", ManifestSHA256: digest, Target: target, Previous: receipt, Phase: phase, Error: "fixture journal error"}
	for _, name := range []string{"verify-members", "checkpoint", "apply-cp", "apply-ui", "authenticated-health"} {
		step := systemupdate.CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"}
		if state, ok := states[name]; ok {
			step.State, step.Evidence = state[0], state[1]
		}
		j.Steps = append(j.Steps, step)
	}
	if recovery != nil {
		for _, name := range []string{"recovery-fence", "recovery-paired-restore", "recovery-health"} {
			step := systemupdate.CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"}
			if state, ok := recovery[name]; ok {
				step.State, step.Evidence = state[0], state[1]
			}
			j.RecoverySteps = append(j.RecoverySteps, step)
		}
	}
	raw, _ := json.Marshal(j)
	if err := os.WriteFile(filepath.Join(s.coreStatePath, "journal.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	return j
}

// coreStatusRunnerResult writes what an action's child leaves when its effect
// returned an error (CoreSystemdRunner.RunAction): an unknown result whose
// evidence is the generic prefix and the error.
func coreStatusRunnerResult(t *testing.T, s *Server, j systemupdate.CoreJournal, name, effectErr string) {
	t.Helper()
	unit := fmt.Sprintf("youeye-core-%x.service", sha256.Sum256([]byte(j.RequestID+"/"+name+"\x00"+j.ManifestSHA256)))
	launch := map[string]string{"schema": "youeye.core-runner.v1", "request_id": j.RequestID + "/" + name, "manifest_sha256": j.ManifestSHA256, "unit": unit, "executable": "/usr/local/bin/youeye", "boot_id": "11111111-1111-1111-1111-111111111111"}
	result := map[string]any{"launch": launch, "invocation_id": strings.Repeat("a", 32), "pid": 4242, "process_identity": "fixture",
		"result": map[string]string{"State": "unknown", "Stage": "execute", "Code": "native_action_failed", "EffectState": "started",
			"Evidence": "native action entered effect execution; reconcile retained effect evidence before recovery: " + effectErr}}
	raw, _ := json.Marshal(result)
	dir := filepath.Join(s.coreStatePath, "runners", unit)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "launch.json.result"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

type coreStatusTransaction struct {
	Phase       string              `json:"phase"`
	Complete    bool                `json:"complete"`
	Steps       []map[string]string `json:"steps"`
	StoppedStep map[string]string   `json:"stopped_step"`
}

func readCoreStatusTransaction(t *testing.T, s *Server) (coreStatusTransaction, string) {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleCoreUpdateStatus(w, httptest.NewRequest(http.MethodGet, "/", nil))
	var status struct {
		Transaction coreStatusTransaction `json:"transaction"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &status) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	return status.Transaction, w.Body.String()
}

// coreStatusEvidenceOf maps step names to the evidence the answer carries.
func coreStatusEvidenceOf(steps []map[string]string) map[string]string {
	out := map[string]string{}
	for _, step := range steps {
		if evidence, ok := step["evidence"]; ok {
			out[step["name"]] = evidence
		}
	}
	return out
}

func assertOneBoundedLine(t *testing.T, evidence string) {
	t.Helper()
	if n := len([]rune(evidence)); n != coreStepEvidenceLimit+1 || !strings.HasSuffix(evidence, "…") || strings.ContainsAny(evidence, "\n\x00\x1b") {
		t.Fatalf("evidence is not one bounded line: %d runes", n)
	}
}

// The owner sees why a step failed, and nothing else from the journal's
// evidence: only a failed step carries it, as one bounded line.
func TestCoreStatusShowsEvidenceOfFailedStepsOnly(t *testing.T) {
	s, receipt, target, digest := coreStatusFixture(t)
	long := "checkpoint preflight refused before any writer was stopped: " + strings.Repeat("raw error text ", 200) + "\nsecond line\x00\x1b[31m"
	coreStatusJournal(t, s, receipt, target, digest, "needs-recovery", map[string][2]string{
		"verify-members": {"succeeded", "installed cp differs: 3 unrecorded, 0 changed, 0 missing; continuing"},
		"checkpoint":     {"failed", long},
	}, nil)
	status, body := readCoreStatusTransaction(t, s)
	if len(status.Steps) != 5 {
		t.Fatal(body)
	}
	evidence := coreStatusEvidenceOf(status.Steps)
	if len(evidence) != 1 || !strings.HasPrefix(evidence["checkpoint"], "checkpoint preflight refused before any writer was stopped: raw error text") {
		t.Fatal(evidence)
	}
	assertOneBoundedLine(t, evidence["checkpoint"])
	if strings.Contains(body, "3 unrecorded") {
		t.Fatal("evidence of a succeeded step exposed")
	}
	if got := coreStepEvidence(" a\tb\r\nc \x07"); got != "a b c" {
		t.Fatalf("%q", got)
	}
	// File paths never reach the answer; the punctuation around them stays.
	if got := coreStepEvidence(`open /var/lib/youeye-state/core/x.json: denied ("/tmp/a") CP/UI / ok`); got != `open …: denied ("…") CP/UI / ok` {
		t.Fatalf("%q", got)
	}
}

// A refused preflight ends the request by cancellation at once. The finished
// request still says which step failed and why; other steps say nothing.
func TestCoreStatusShowsWhyACancelledOrRolledBackRequestStopped(t *testing.T) {
	s, receipt, target, digest := coreStatusFixture(t)
	coreStatusJournal(t, s, receipt, target, digest, "cancelled", map[string][2]string{
		"verify-members": {"succeeded", "installed cp differs: 3 unrecorded, 0 changed, 0 missing; continuing"},
		"checkpoint":     {"failed", "checkpoint preflight refused before any writer was stopped: insufficient combined Data checkpoint/staging/recovery capacity"},
	}, nil)
	status, body := readCoreStatusTransaction(t, s)
	if status.Phase != "cancelled" || !status.Complete || status.StoppedStep != nil {
		t.Fatal(body)
	}
	if evidence := coreStatusEvidenceOf(status.Steps); len(evidence) != 1 || evidence["checkpoint"] != "checkpoint preflight refused before any writer was stopped: insufficient combined Data checkpoint/staging/recovery capacity" {
		t.Fatal(evidence)
	}

	// Rolled back after an uncertain apply-cp: steps is the recovery graph, and
	// the apply step that stopped the update is reported with its reason.
	s, receipt, target, digest = coreStatusFixture(t)
	j := coreStatusJournal(t, s, receipt, target, digest, "rolled-back", map[string][2]string{
		"verify-members": {"succeeded", "verified"}, "checkpoint": {"succeeded", "paired checkpoint"},
		"apply-cp": {"started", "owned native service invocation is active"},
	}, map[string][2]string{"recovery-fence": {"succeeded", "fenced"}, "recovery-paired-restore": {"succeeded", "restored"}, "recovery-health": {"succeeded", "healthy"}})
	coreStatusRunnerResult(t, s, j, "apply-cp", "cp payload before start: installed payload differs from its recorded files: 0 unrecorded, 2 changed, 1 missing")
	status, body = readCoreStatusTransaction(t, s)
	if len(status.Steps) != 3 || len(coreStatusEvidenceOf(status.Steps)) != 0 {
		t.Fatal(body)
	}
	want := map[string]string{"name": "apply-cp", "state": "started", "evidence": "cp payload before start: installed payload differs from its recorded files: 0 unrecorded, 2 changed, 1 missing"}
	if !reflect.DeepEqual(status.StoppedStep, want) {
		t.Fatal(status.StoppedStep)
	}
	if strings.Contains(body, "invocation is active") || strings.Contains(body, "native action entered") {
		t.Fatal("private or generic evidence exposed", body)
	}
}

// A strict payload refusal leaves the step started and the request in
// needs-recovery. The answer carries the refusal its child recorded, as one
// bounded line, only while recovery is needed.
func TestCoreStatusShowsWhyAnUncertainStepStopped(t *testing.T) {
	s, receipt, target, digest := coreStatusFixture(t)
	states := map[string][2]string{
		"verify-members": {"succeeded", "installed cp differs: 3 unrecorded, 0 changed, 0 missing; continuing"},
		"checkpoint":     {"succeeded", "paired checkpoint"}, "apply-cp": {"succeeded", "core-component/cp"}, "apply-ui": {"succeeded", "core-component/ui"},
		"authenticated-health": {"started", "owned native service invocation is active"},
	}
	j := coreStatusJournal(t, s, receipt, target, digest, "needs-recovery", states, nil)
	refusal := "cp payload health: installed payload differs from its recorded files: 1 unrecorded, 4 changed, 0 missing (changed-bytes 4)"
	coreStatusRunnerResult(t, s, j, "authenticated-health", refusal)
	status, body := readCoreStatusTransaction(t, s)
	if evidence := coreStatusEvidenceOf(status.Steps); len(evidence) != 1 || evidence["authenticated-health"] != refusal {
		t.Fatal(evidence, body)
	}
	if strings.Contains(body, "invocation is active") || strings.Contains(body, "3 unrecorded") || status.StoppedStep != nil {
		t.Fatal("private evidence exposed", body)
	}

	// While the request is still applying, a started step says nothing.
	coreStatusJournal(t, s, receipt, target, digest, "applying", states, nil)
	if status, _ = readCoreStatusTransaction(t, s); len(coreStatusEvidenceOf(status.Steps)) != 0 {
		t.Fatal(status.Steps)
	}

	// A started step without a child result has no reason to show.
	s, receipt, target, digest = coreStatusFixture(t)
	coreStatusJournal(t, s, receipt, target, digest, "needs-recovery", states, nil)
	if status, _ = readCoreStatusTransaction(t, s); len(coreStatusEvidenceOf(status.Steps)) != 0 {
		t.Fatal(status.Steps)
	}

	// Raw child error text is cut to one line without paths.
	j = coreStatusJournal(t, s, receipt, target, digest, "needs-recovery", states, nil)
	coreStatusRunnerResult(t, s, j, "authenticated-health", "open /var/lib/youeye/secret: "+strings.Repeat("raw error text ", 200)+"\nsecond line")
	status, body = readCoreStatusTransaction(t, s)
	evidence := coreStatusEvidenceOf(status.Steps)["authenticated-health"]
	if !strings.HasPrefix(evidence, "open …: raw error text") || strings.Contains(body, "/var/lib") {
		t.Fatal(evidence)
	}
	assertOneBoundedLine(t, evidence)
}

// The status answer reports the three states with counts. File names stay on
// the operator's terminal.
func TestCoreStatusObservationReportsStatesWithoutPaths(t *testing.T) {
	s, receipt, _, _ := coreStatusFixture(t)
	found := systemupdate.CorePayloadFindings{Unrecorded: 2, Changed: 1, Missing: 1, Reasons: map[string]int{"changed-bytes": 1},
		Paths: []systemupdate.CorePayloadFinding{{Path: "private/owner-file.js", Reason: "unrecorded-path"}}}
	s.coreUpdateOperations = coreStatusObserver{observation: systemupdate.CoreInstalledObservation{State: "modified", ManifestSHA256: receipt.ManifestSHA256, ObservedAt: "now",
		Members: []systemupdate.CoreInstalledMember{{Role: "cp", Summary: found.Summary(), Findings: found}, {Role: "ui", Summary: "verified"}}}}
	w := httptest.NewRecorder()
	s.handleCoreUpdateStatus(w, httptest.NewRequest(http.MethodGet, "/?observe=1", nil))
	body := w.Body.String()
	if w.Code != 200 || !strings.Contains(body, `"payload_observation":"modified"`) || !strings.Contains(body, `"summary":"modified (1 changed, 1 missing), 2 extra files"`) || !strings.Contains(body, `"unrecorded":2`) {
		t.Fatal(w.Code, body)
	}
	if strings.Contains(body, "owner-file") || strings.Contains(body, `"paths"`) {
		t.Fatal("file names reached the status answer", body)
	}
}
