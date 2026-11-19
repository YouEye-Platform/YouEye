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

type coreInstalledHealthFixture struct {
	*coreDeploymentFixture
	manager   systemupdate.CoreManager
	receipt   systemupdate.CoreReceipt
	trees     map[string]string // container -> directory
	modes     map[string]systemupdate.CorePayloadMode
	walked    int
	targetRaw []byte
	target    releasecache.CoreRelease
	targetSHA string
}

// newCoreInstalledHealthFixture installs the fixture release with real CP and
// UI trees on disk, and a target release that replaces CP and reuses UI.
func newCoreInstalledHealthFixture(t *testing.T) *coreInstalledHealthFixture {
	t.Helper()
	f := &coreInstalledHealthFixture{coreDeploymentFixture: newCoreDeploymentFixture(t), trees: map[string]string{}, modes: map[string]systemupdate.CorePayloadMode{}}
	f.manager = systemupdate.CoreManager{Root: filepath.Join(f.root, "core-state")}
	oldRoot, oldCheck := coreInstalledHealthStateRoot, coreInstalledPayloadCheck
	t.Cleanup(func() { coreInstalledHealthStateRoot, coreInstalledPayloadCheck = oldRoot, oldCheck })
	coreInstalledHealthStateRoot = f.manager.Root
	write := func(name string, value any) {
		t.Helper()
		raw, ok := value.([]byte)
		if !ok {
			raw, _ = json.Marshal(value)
		}
		path := filepath.Join(f.manager.Root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(f.root, "core-release.json"))
	if err != nil {
		t.Fatal(err)
	}
	release, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	write("targets/"+digest+".json", raw)
	f.receipt = systemupdate.CoreReceipt{ManifestSHA256: digest, Release: release, AcceptedAt: "fixture-time", Evidence: "fixture acceptance",
		Machine: systemupdate.CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state", DataPartUUID: "data"}}
	write("committed.json", f.receipt)
	// The target replaces CP only.
	f.target = release
	f.target.Members = append([]releasecache.CoreMember(nil), release.Members...)
	f.target.Version, f.target.Build, f.target.Tag = "9.9.9-dev.1", "9.9.9-dev.1", "youeye-v9.9.9-dev.1"
	f.target.Sequence++
	for i := range f.target.Members {
		if f.target.Members[i].Role == "cp" {
			f.target.Members[i].Artifact.SHA256 = strings.Repeat("9", 64)
		}
	}
	f.targetRaw, _ = json.Marshal(f.target)
	if f.target, f.targetSHA, err = releasecache.ParseCoreRelease(f.targetRaw); err != nil {
		t.Fatal(err)
	}
	write("targets/"+f.targetSHA+".json", f.targetRaw)
	body := []byte("console.log('shipped');\n")
	digestOf := coreTestHash(body)
	for _, r := range []releasecache.CoreRelease{release, f.target} {
		for _, member := range r.Members {
			if member.Role != "cp" && member.Role != "ui" {
				continue
			}
			index := systemupdate.CorePayloadIndex{Schema: "youeye.core-payload.v1", ArtifactSHA256: member.Artifact.SHA256, Entries: []systemupdate.CorePayloadEntry{
				{Path: "lib", Kind: "directory", Mode: 0755}, {Path: "lib/module.js", Kind: "file", Mode: 0644, Size: int64(len(body)), SHA256: digestOf},
				{Path: "server.js", Kind: "file", Mode: 0644, Size: int64(len(body)), SHA256: digestOf}}}
			if err := f.manager.SavePayloadIndex(index); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, container := range []string{"youeye-control", "youeye-ui"} {
		dir := filepath.Join(f.root, "trees", container)
		if err := os.MkdirAll(filepath.Join(dir, "lib"), 0755); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"server.js", "lib/module.js"} {
			if err := os.WriteFile(filepath.Join(dir, name), body, 0644); err != nil {
				t.Fatal(err)
			}
		}
		f.trees[container] = dir
	}
	coreInstalledPayloadCheck = func(_ context.Context, container, _ string, index systemupdate.CorePayloadIndex, mode systemupdate.CorePayloadMode) (systemupdate.CorePayloadFindings, error) {
		f.walked++
		f.modes[container] = mode
		return systemupdate.VerifyCorePayload(f.trees[container], index, mode)
	}
	return f
}

// modify leaves a tree with a file we did not ship, a changed file and a missing one.
func (f *coreInstalledHealthFixture) modify(t *testing.T, container string) {
	t.Helper()
	dir := f.trees[container]
	for name, content := range map[string]string{"owner-secret-overlay.js": "overlay", "server.js": "tampered"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(filepath.Join(dir, "lib/module.js")); err != nil {
		t.Fatal(err)
	}
}

// journal writes an active request for the target: every step before `at` has
// succeeded, `at` is started. recovering adds the recovery graph.
func (f *coreInstalledHealthFixture) journal(t *testing.T, phase, at string, edit func(*systemupdate.CoreJournal)) {
	t.Helper()
	j := systemupdate.CoreJournal{Schema: systemupdate.CoreJournalSchema, RequestID: "update-1", ManifestSHA256: f.targetSHA, Target: f.target, Previous: f.receipt, Phase: phase}
	if edit != nil {
		edit(&j)
	}
	names := []string{"verify-members", "checkpoint", "apply-cp", "apply-ui", "authenticated-health"}
	if j.NoOp || j.MetadataOnly {
		names = []string{"verify-members", "authenticated-health"}
	}
	reached := at == ""
	for _, name := range names {
		step := systemupdate.CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"}
		if name == at {
			step.State, reached = "started", true
		} else if !reached || (at == "" && phase == "committed") {
			step.State, step.Evidence = "succeeded", "fixture evidence"
		}
		j.Steps = append(j.Steps, step)
	}
	if phase == "recovering" || phase == "rolled-back" {
		for _, name := range []string{"recovery-fence", "recovery-paired-restore", "recovery-health"} {
			step := systemupdate.CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "succeeded", Evidence: "fixture evidence"}
			if name == "recovery-health" && phase == "recovering" {
				step.State, step.Evidence = "started", ""
			}
			j.RecoverySteps = append(j.RecoverySteps, step)
		}
	}
	raw, _ := json.Marshal(j)
	if err := os.WriteFile(filepath.Join(f.manager.Root, "journal.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.Read(); err != nil {
		t.Fatal("fixture journal is not a valid journal:", err)
	}
}

func (f *coreInstalledHealthFixture) check(t *testing.T) (string, string) {
	t.Helper()
	status, summary := "", ""
	if !addCoreInstalledHealthChecks(f.image, func(name, s, text string) {
		if name != "installed core membership" || status != "" {
			t.Fatal("unexpected health check", name)
		}
		status, summary = s, text
	}) {
		t.Fatal("installed core was not checked")
	}
	return status, summary
}

// The health gate passes for a modified tree that what is running did not
// write, and fails for a damaged tree that it did write.
func TestApplianceHealthPayloadGate(t *testing.T) {
	const cp, ui = "youeye-control", "youeye-ui"
	strict, record := systemupdate.CorePayloadStrict, systemupdate.CorePayloadRecord
	for _, test := range []struct {
		name        string
		prepare     func(t *testing.T, f *coreInstalledHealthFixture)
		status      string
		cpMode      systemupdate.CorePayloadMode
		uiMode      systemupdate.CorePayloadMode
		wantSummary string
	}{
		{name: "fresh install", prepare: func(*testing.T, *coreInstalledHealthFixture) {}, status: "pass", cpMode: strict, uiMode: strict, wantSummary: "cp verified; ui verified"},
		{name: "fresh install with extra files", prepare: func(t *testing.T, f *coreInstalledHealthFixture) {
			if err := os.WriteFile(filepath.Join(f.trees[ui], "added.js"), nil, 0644); err != nil {
				t.Fatal(err)
			}
		}, status: "pass", cpMode: strict, uiMode: strict, wantSummary: "cp verified; ui verified, 1 extra file"},
		{name: "fresh install damaged", prepare: func(t *testing.T, f *coreInstalledHealthFixture) { f.modify(t, cp) }, status: "fail", cpMode: strict, wantSummary: "modified (1 changed, 1 missing), 1 extra file"},
		{name: "fresh install damaged during its no-op acceptance", prepare: func(t *testing.T, f *coreInstalledHealthFixture) {
			f.target, f.targetSHA = f.receipt.Release, f.receipt.ManifestSHA256
			f.journal(t, "applying", "authenticated-health", func(j *systemupdate.CoreJournal) { j.NoOp = true })
			f.modify(t, ui)
		}, status: "fail", cpMode: strict, uiMode: strict, wantSummary: "modified (1 changed, 1 missing), 1 extra file"},
		{name: "update: replaced tree damaged", prepare: func(t *testing.T, f *coreInstalledHealthFixture) {
			f.journal(t, "applying", "authenticated-health", nil)
			f.modify(t, cp)
		}, status: "fail", cpMode: strict, wantSummary: "modified (1 changed, 1 missing), 1 extra file"},
		{name: "update: reused tree modified", prepare: func(t *testing.T, f *coreInstalledHealthFixture) {
			f.journal(t, "applying", "authenticated-health", nil)
			f.modify(t, ui)
		}, status: "pass", cpMode: strict, uiMode: record, wantSummary: "cp verified; ui modified (1 changed, 1 missing), 1 extra file"},
		{name: "update: before its health step nothing is written yet", prepare: func(t *testing.T, f *coreInstalledHealthFixture) {
			f.journal(t, "applying", "checkpoint", nil)
			f.modify(t, cp)
		}, status: "pass", cpMode: record, uiMode: record, wantSummary: "cp modified (1 changed, 1 missing), 1 extra file; ui verified"},
		{name: "recovery-health: restored trees modified", prepare: func(t *testing.T, f *coreInstalledHealthFixture) {
			f.journal(t, "recovering", "apply-cp", nil)
			f.modify(t, cp)
			f.modify(t, ui)
		}, status: "pass", cpMode: record, uiMode: record, wantSummary: "cp modified (1 changed, 1 missing), 1 extra file; ui modified (1 changed, 1 missing), 1 extra file"},
		{name: "needs-recovery: modified", prepare: func(t *testing.T, f *coreInstalledHealthFixture) {
			f.journal(t, "needs-recovery", "apply-cp", nil)
			f.modify(t, cp)
		}, status: "pass", cpMode: record, uiMode: record, wantSummary: "cp modified (1 changed, 1 missing), 1 extra file; ui verified"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newCoreInstalledHealthFixture(t)
			test.prepare(t, f)
			status, summary := f.check(t)
			if status != test.status || !strings.Contains(summary, test.wantSummary) {
				t.Fatalf("%s: %s", status, summary)
			}
			if f.modes[cp] != test.cpMode || (test.status == "pass" && f.modes[ui] != test.uiMode) {
				t.Fatalf("modes cp=%d ui=%d", f.modes[cp], f.modes[ui])
			}
			// health.json is kept on State: counts, never a file name.
			if strings.Contains(summary, "owner-secret-overlay") || strings.Contains(summary, "module.js") {
				t.Fatal("a path reached the durable health summary:", summary)
			}
		})
	}
}

func TestCoreInstalledHealthModeTable(t *testing.T) {
	f := newCoreInstalledHealthFixture(t)
	strict, record := systemupdate.CorePayloadStrict, systemupdate.CorePayloadRecord
	journal := func(phase, healthState string, edit func(*systemupdate.CoreJournal)) *systemupdate.CoreJournal {
		j := &systemupdate.CoreJournal{Phase: phase, Target: f.target, Previous: f.receipt,
			Steps: []systemupdate.CoreStep{{Name: "apply-cp", State: "succeeded"}, {Name: "authenticated-health", State: healthState}}}
		if edit != nil {
			edit(j)
		}
		return j
	}
	for _, test := range []struct {
		name    string
		journal *systemupdate.CoreJournal
		cp, ui  systemupdate.CorePayloadMode
	}{
		{"no request", nil, strict, strict},
		{"finished request", journal("committed", "succeeded", nil), strict, strict},
		{"cancelled request", journal("cancelled", "pending", nil), strict, strict},
		{"rolled back", journal("rolled-back", "pending", nil), strict, strict},
		{"no-op acceptance", journal("applying", "started", func(j *systemupdate.CoreJournal) { j.NoOp = true }), strict, strict},
		{"health started", journal("applying", "started", nil), strict, record},
		{"health succeeded", journal("applying", "succeeded", nil), strict, record},
		{"health pending", journal("applying", "pending", nil), record, record},
		{"metadata only", journal("applying", "started", func(j *systemupdate.CoreJournal) { j.MetadataOnly = true }), record, record},
		{"prepared", journal("prepared", "pending", nil), record, record},
		{"awaiting restart", journal("awaiting-restart", "pending", nil), record, record},
		{"needs recovery", journal("needs-recovery", "started", nil), record, record},
		{"recovering", journal("recovering", "started", nil), record, record},
		{"cancelling", journal("cancelling", "pending", nil), record, record},
	} {
		if cp, ui := coreInstalledHealthMode(test.journal, "cp"), coreInstalledHealthMode(test.journal, "ui"); cp != test.cp || ui != test.ui {
			t.Fatalf("%s: cp=%d ui=%d", test.name, cp, ui)
		}
	}
}

// Boot blessing gates on `youeye appliance health --profile=operational`. On a
// box that finished first deployment, that command does not walk the installed
// trees, so a trial boot with a modified (even damaged) tree is blessed.
func TestBlessHealthNeverWalksInstalledTreesAfterFirstDeploy(t *testing.T) {
	f := newCoreInstalledHealthFixture(t)
	f.modify(t, "youeye-control")
	f.modify(t, "youeye-ui")
	old := firstDeployCompletePath
	t.Cleanup(func() { firstDeployCompletePath = old })
	firstDeployCompletePath = filepath.Join(f.root, "first-deploy-complete")
	checks := map[string]string{}
	add := func(name, status, _ string) { checks[name] = status }
	if err := os.WriteFile(firstDeployCompletePath, nil, 0600); err != nil {
		t.Fatal(err)
	}
	addInstalledReleaseChecks(f.image, add)
	if len(checks) != 0 || f.walked != 0 {
		t.Fatal("a set-up box had its installed trees checked by appliance health", checks, f.walked)
	}
	if status, _ := aggregateApplianceHealth(nil); status != "healthy" {
		t.Fatal(status)
	}
	// Before first deployment completes the same trees are the fresh install's.
	if err := os.Remove(firstDeployCompletePath); err != nil {
		t.Fatal(err)
	}
	addInstalledReleaseChecks(f.image, add)
	if checks["installed core membership"] != "fail" || f.walked == 0 {
		t.Fatal("a damaged fresh install passed", checks)
	}
}

// Decision 5: a copy is refused for a source whose shipped files are changed
// or missing, with the reason; extra files are fine. Releasing the source's
// hold is not refused for them: that would close the source to updates.
func TestCopyFromAModifiedBox(t *testing.T) {
	member := func(role string, found systemupdate.CorePayloadFindings) systemupdate.CoreInstalledMember {
		return systemupdate.CoreInstalledMember{Role: role, Summary: found.Summary(), Findings: found}
	}
	clean := systemupdate.CoreInstalledObservation{State: "verified", Members: []systemupdate.CoreInstalledMember{member("cp", systemupdate.CorePayloadFindings{}), member("ui", systemupdate.CorePayloadFindings{})}}
	extra := systemupdate.CoreInstalledObservation{State: "verified", Members: []systemupdate.CoreInstalledMember{member("cp", systemupdate.CorePayloadFindings{Unrecorded: 4}), member("ui", systemupdate.CorePayloadFindings{})}}
	modified := systemupdate.CoreInstalledObservation{State: "modified", Members: []systemupdate.CoreInstalledMember{member("cp", systemupdate.CorePayloadFindings{Changed: 1, Missing: 2, Paths: []systemupdate.CorePayloadFinding{{Path: "private/name.js", Reason: "changed-bytes"}}}), member("ui", systemupdate.CorePayloadFindings{})}}
	for _, ok := range []systemupdate.CoreInstalledObservation{clean, extra} {
		if err := copyInstalledObservation(ok); err != nil {
			t.Fatal("copy refused a source with every shipped file intact:", err)
		}
		if err := copySourceReleaseObservation(ok); err != nil {
			t.Fatal(err)
		}
	}
	err := copyInstalledObservation(modified)
	if err == nil || !strings.Contains(err.Error(), "cp modified (1 changed, 2 missing)") || strings.Contains(err.Error(), "private/name.js") {
		t.Fatal("copy from a modified source was not refused with its reason:", err)
	}
	if err := copySourceReleaseObservation(modified); err != nil {
		t.Fatal("a modified source could not release its copy hold:", err)
	}
	for _, state := range []string{"unverified", "pending", ""} {
		unknown := systemupdate.CoreInstalledObservation{State: state}
		if copyInstalledObservation(unknown) == nil || copySourceReleaseObservation(unknown) == nil {
			t.Fatal("an installation that was not observed was accepted:", state)
		}
	}
}

// The installed release decides stepping stones, by its key from the
// committed receipt. Only a box without a receipt is a fresh install; a
// receipt that cannot be read is an error, never "nothing installed" (which
// would offer the channel head whatever its minimum_release).
func TestCoreSelectionCarriesTheInstalledKey(t *testing.T) {
	f := newCoreInstalledHealthFixture(t)
	selection, err := currentCoreSelection()
	if err != nil || !selection.FreshInstall || selection.Installed != (releasecache.ReleaseKey{}) {
		t.Fatalf("a box without a receipt: %+v %v", selection, err)
	}
	coreReceiptRoot = f.manager.Root
	selection, err = currentCoreSelection()
	want := releasecache.ReleaseKey{Line: "0.6.1", Sequence: int64(f.receipt.Release.Sequence)}
	if err != nil || selection.FreshInstall || selection.Installed != want || selection.InstalledVersion != f.receipt.Release.Version || selection.Channel != "dev" {
		t.Fatalf("installed box: %+v %v", selection, err)
	}
	// The same box under a promoted name has the same key.
	promoted := selection.WithInstalled(releasecache.CoreRelease{Version: "0.6.1-beta.1", Sequence: f.receipt.Release.Sequence})
	if promoted.Installed != want || promoted.InstalledVersion != "0.6.1-beta.1" {
		t.Fatalf("promoted name changed the key: %+v", promoted)
	}
	if err := os.WriteFile(filepath.Join(f.manager.Root, "committed.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if selection, err = currentCoreSelection(); err == nil || selection.FreshInstall {
		t.Fatalf("an unreadable receipt passed for a fresh install: %+v %v", selection, err)
	}
}
