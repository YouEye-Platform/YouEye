package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/spineselect"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// continuationExecutor stands for the native executor: what it knows (which
// actions were started and how they ended) is durable, as the real receipts
// are, so a second coordinator process can be given the same executor.
type continuationExecutor struct {
	mu      sync.Mutex
	starts  map[string]int
	results map[string]systemupdate.CoreActionObservation
	// running names a step whose child does not finish until finish() is called.
	running string
}

func newContinuationExecutor() *continuationExecutor {
	return &continuationExecutor{starts: map[string]int{}, results: map[string]systemupdate.CoreActionObservation{}}
}

func (e *continuationExecutor) Authorize(context.Context, systemupdate.CoreJournal, bool) error {
	return nil
}

func (e *continuationExecutor) Start(_ context.Context, _ systemupdate.CoreJournal, s systemupdate.CoreStep) (systemupdate.CoreActionObservation, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.starts[s.Name]++
	out := systemupdate.CoreActionObservation{State: "succeeded", Evidence: "fixture " + s.RequestID}
	if e.running == s.Name {
		out = systemupdate.CoreActionObservation{State: "running", Evidence: "fixture child is running"}
	}
	e.results[s.RequestID] = out
	return out, nil
}

func (e *continuationExecutor) Observe(_ context.Context, _ systemupdate.CoreJournal, s systemupdate.CoreStep) (systemupdate.CoreActionObservation, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if result, ok := e.results[s.RequestID]; ok {
		return result, nil
	}
	return systemupdate.CoreActionObservation{State: "unknown"}, nil
}

func (e *continuationExecutor) finish(request, name string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.running = ""
	e.results[request+"/"+name] = systemupdate.CoreActionObservation{State: "succeeded", Evidence: "fixture child finished"}
}

func (e *continuationExecutor) started(name string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.starts[name]
}

// continuationFixture prepares a service update on an installed release. With
// spine it also changes the Spine, so the request has an apply-spine step.
func continuationFixture(t *testing.T, spine bool) (systemupdate.CoreManager, *continuationExecutor, systemupdate.CoreJournal) {
	t.Helper()
	roles := []string{"cp"}
	if spine {
		roles = append(roles, "spine")
	}
	m, executor, j := continuationFixtureChanging(t, roles...)
	if j.SpineChanged != spine || j.RestartRequired {
		t.Fatalf("fixture graph: spine=%v restart=%v", j.SpineChanged, j.RestartRequired)
	}
	return m, executor, j
}

// continuationFixtureChanging prepares an update that changes the members of
// the given roles ("system-root" makes it an image update).
func continuationFixtureChanging(t *testing.T, changed ...string) (systemupdate.CoreManager, *continuationExecutor, systemupdate.CoreJournal) {
	t.Helper()
	release := releasecache.CoreRelease{Schema: releasecache.CoreReleaseSchema, Version: "0.5.37", Build: "0.5.37", Tag: "youeye-v0.5.37", SourceTree: strings.Repeat("a", 40), Sequence: 1, MinimumReader: 1, Authority: releasecache.CoreReleaseAuthority,
		Compatibility: releasecache.CoreCompatibility{StateMin: 1, StateMax: 1, DataMin: 1, DataMax: 1, MinimumRelease: "0.5.37", Capabilities: []string{"core-release-v1"}}}
	for _, role := range []string{"installer", "media", "appliance", "system-update", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "spine", "cp", "ui"} {
		blob := func(name string) releasecache.CoreBlob {
			return releasecache.CoreBlob{Name: name, SHA256: strings.Repeat("c", 64), SizeBytes: 42}
		}
		member := releasecache.CoreMember{Role: role, BuildVersion: release.Version, SourceTree: release.SourceTree, InputSHA256: strings.Repeat("d", 64), Artifact: blob(role + ".tar")}
		switch role {
		case "appliance":
			inputs := blob("build-inputs.json")
			member.BuildInputs = &inputs
		case "cp":
			member.DependsOn = []string{"spine"}
		case "ui":
			member.DependsOn = []string{"cp"}
		}
		release.Members = append(release.Members, member)
	}
	executor := newContinuationExecutor()
	m := systemupdate.CoreManager{Root: t.TempDir(), Executor: executor, YieldAfterSpine: true}
	write := func(path string, value any) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	digestOf := func(r releasecache.CoreRelease) ([]byte, string) {
		t.Helper()
		raw, err := json.Marshal(r)
		if err != nil {
			t.Fatal(err)
		}
		_, digest, err := releasecache.ParseCoreRelease(raw)
		if err != nil {
			t.Fatal(err)
		}
		return raw, digest
	}
	raw, digest := digestOf(release)
	if err := os.MkdirAll(filepath.Join(m.Root, "targets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.Root, "targets", digest+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(m.Root, "committed.json"), systemupdate.CoreReceipt{ManifestSHA256: digest, Release: release, AcceptedAt: time.Now().UTC().Format(time.RFC3339Nano), Evidence: "fixture acceptance",
		Machine: systemupdate.CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state", DataPartUUID: "data"}})
	release.Version, release.Build, release.Tag, release.Sequence = "0.5.38", "0.5.38", "youeye-v0.5.38", 2
	for i := range release.Members {
		for _, role := range changed {
			if release.Members[i].Role == role {
				release.Members[i].Artifact.SHA256 = strings.Repeat("e", 64)
			}
		}
	}
	raw, digest = digestOf(release)
	j, err := m.Prepare(context.Background(), "update-1", raw, digest)
	if err != nil {
		t.Fatal(err)
	}
	return m, executor, j
}

type continuationRun struct {
	journal   systemupdate.CoreJournal
	err       error
	finished  int
	handOvers []systemupdate.CoreJournal
	replaced  bool // the hand-over replaced the process: the loop never returned
}

// runContinuation runs the real continuation loop as one coordinator process.
// handOver decides what the hand-over does: an error means it could not be
// made (the process continues); "replace" ends the process there, as a
// successful exec does.
func runContinuation(ctx context.Context, m systemupdate.CoreManager, request string, activate bool, handOver func() (replace bool, err error)) *continuationRun {
	run := &continuationRun{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		returned := false
		defer func() { run.replaced = !returned }()
		run.journal, run.err = runCoreContinuation(ctx, coreContinuation{
			manager:  m,
			finished: func(context.Context, systemupdate.CoreJournal) error { run.finished++; return nil },
			handOver: func(_ context.Context, j systemupdate.CoreJournal) error {
				run.handOvers = append(run.handOvers, j)
				replace, err := handOver()
				if replace {
					runtime.Goexit() // exec: nothing of this process runs any more
				}
				return err
			},
		}, request, activate, false, false)
		returned = true
	}()
	<-done
	return run
}

func stepStates(j systemupdate.CoreJournal) map[string]string {
	states := map[string]string{}
	for _, step := range j.Steps {
		states[step.Name] = step.State
	}
	return states
}

func neverHandOver(t *testing.T) func() (bool, error) {
	return func() (bool, error) {
		t.Helper()
		t.Error("a continuation that did not apply the Spine itself handed over")
		return false, fmt.Errorf("unexpected")
	}
}

// After apply-spine the old coordinator is replaced; the new one finishes the same request.
func TestCoreContinuationHandsOverAfterSpineStep(t *testing.T) {
	m, executor, j := continuationFixture(t, true)
	old := runContinuation(context.Background(), m, j.RequestID, true, func() (bool, error) {
		// At the hand-over nothing after the Spine step has been started.
		if executor.started("apply-spine") != 1 || executor.started("apply-cp") != 0 {
			t.Errorf("hand-over at the wrong point: %v", executor.starts)
		}
		return true, nil
	})
	if !old.replaced || len(old.handOvers) != 1 || old.finished != 0 {
		t.Fatalf("old coordinator: replaced=%v handOvers=%d finished=%d err=%v", old.replaced, len(old.handOvers), old.finished, old.err)
	}
	onDisk, err := m.Read()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"verify-members": "succeeded", "checkpoint": "succeeded", "apply-spine": "succeeded", "apply-cp": "pending", "apply-ui": "pending", "authenticated-health": "pending"}
	if onDisk.Phase != "applying" || !reflect.DeepEqual(stepStates(onDisk), want) || !reflect.DeepEqual(stepStates(old.handOvers[0]), want) {
		t.Fatalf("journal at hand-over: %s %v", onDisk.Phase, stepStates(onDisk))
	}
	// The new Spine's `resume` of the same request: a new process, the same durable state.
	next := runContinuation(context.Background(), m, j.RequestID, false, neverHandOver(t))
	if next.err != nil || next.replaced || next.journal.Phase != "committed" || next.finished != 1 || len(next.handOvers) != 0 {
		t.Fatalf("new coordinator: phase=%s finished=%d err=%v", next.journal.Phase, next.finished, next.err)
	}
	for _, name := range []string{"verify-members", "checkpoint", "apply-spine", "apply-cp", "apply-ui", "authenticated-health"} {
		if executor.started(name) != 1 {
			t.Fatalf("%s started %d times across the hand-over", name, executor.started(name))
		}
	}
	if receipt, err := m.ReadReceipt(); err != nil || receipt.ManifestSHA256 != j.ManifestSHA256 {
		t.Fatal("release not committed", err)
	}
}

// A hand-over that cannot be made changes nothing: the same coordinator finishes the request.
func TestCoreContinuationKeepsCoordinatingWhenHandOverIsRefused(t *testing.T) {
	m, executor, j := continuationFixture(t, true)
	run := runContinuation(context.Background(), m, j.RequestID, true, func() (bool, error) {
		return false, fmt.Errorf("the new Spine did not answer a status request")
	})
	if run.err != nil || run.replaced || run.journal.Phase != "committed" || run.finished != 1 || len(run.handOvers) != 1 {
		t.Fatalf("phase=%s finished=%d handOvers=%d err=%v", run.journal.Phase, run.finished, len(run.handOvers), run.err)
	}
	if executor.started("apply-spine") != 1 || executor.started("apply-cp") != 1 {
		t.Fatalf("steps repeated or skipped: %v", executor.starts)
	}
}

// The new continuation starts and dies at once (or never gets to run): the request is left exactly as a lost
// coordinator leaves it, and `resume` finishes it.
func TestCoreContinuationLostAfterHandOverIsResumable(t *testing.T) {
	m, executor, j := continuationFixture(t, true)
	old := runContinuation(context.Background(), m, j.RequestID, true, func() (bool, error) { return true, nil })
	if !old.replaced || old.finished != 0 {
		t.Fatalf("old coordinator: replaced=%v finished=%d", old.replaced, old.finished)
	}
	// Nothing coordinates now. The journal is unfinished, nothing is started, nothing is uncertain.
	left, err := m.Read()
	if err != nil || left.Phase != "applying" || len(left.RecoverySteps) != 0 || left.Error != "" {
		t.Fatalf("state after a lost continuation: %s %q %v", left.Phase, left.Error, err)
	}
	for name, state := range stepStates(left) {
		if state == "started" || state == "failed" {
			t.Fatalf("%s is %s after a lost continuation", name, state)
		}
	}
	if receipt, err := m.ReadReceipt(); err != nil || receipt.ManifestSHA256 != j.Previous.ManifestSHA256 {
		t.Fatal("installed release changed before the request finished", err)
	}
	// `youeye update core resume --request <id>` (or the boot unit) continues it.
	resumed := runContinuation(context.Background(), m, j.RequestID, false, neverHandOver(t))
	if resumed.err != nil || resumed.journal.Phase != "committed" || resumed.finished != 1 {
		t.Fatalf("resume did not finish the request: %s %v", resumed.journal.Phase, resumed.err)
	}
	if executor.started("apply-spine") != 1 || executor.started("checkpoint") != 1 {
		t.Fatalf("resume repeated a finished step: %v", executor.starts)
	}
}

// A request that does not change the Spine has no hand-over and finishes as before.
func TestCoreContinuationWithoutSpineChangeDoesNotHandOver(t *testing.T) {
	m, executor, j := continuationFixture(t, false)
	if _, has := stepStates(j)["apply-spine"]; has {
		t.Fatal("fixture has a Spine step")
	}
	run := runContinuation(context.Background(), m, j.RequestID, true, neverHandOver(t))
	if run.err != nil || run.replaced || run.journal.Phase != "committed" || run.finished != 1 {
		t.Fatalf("phase=%s finished=%d err=%v", run.journal.Phase, run.finished, run.err)
	}
	for _, name := range []string{"verify-members", "checkpoint", "apply-cp", "apply-ui", "authenticated-health"} {
		if executor.started(name) != 1 {
			t.Fatalf("%s started %d times", name, executor.started(name))
		}
	}
}

// A coordinator lost while a step runs (a reboot): the boot unit's `resume` observes the step's retained result
// and finishes the request. It does not hand over, although the request has a Spine step.
func TestCoreContinuationResumesAfterALostCoordinator(t *testing.T) {
	m, executor, j := continuationFixture(t, true)
	executor.running = "apply-cp"
	ctx, cancel := context.WithCancel(context.Background())
	handOvers := 0
	go func() {
		// The first process dies while apply-cp is running.
		for executor.started("apply-cp") == 0 {
			time.Sleep(5 * time.Millisecond)
		}
		cancel()
	}()
	first := runContinuation(ctx, m, j.RequestID, true, func() (bool, error) {
		handOvers++
		return false, fmt.Errorf("fixture: stay in this process")
	})
	if first.err == nil || first.finished != 0 || handOvers != 1 {
		t.Fatalf("first coordinator: err=%v finished=%d handOvers=%d", first.err, first.finished, handOvers)
	}
	left, err := m.Read()
	if err != nil || left.Phase != "applying" || stepStates(left)["apply-cp"] != "started" {
		t.Fatalf("state after the coordinator was lost: %s %v %v", left.Phase, stepStates(left), err)
	}
	executor.finish(j.RequestID, "apply-cp") // the child's terminal receipt survives
	resumed := runContinuation(context.Background(), m, j.RequestID, false, neverHandOver(t))
	if resumed.err != nil || resumed.journal.Phase != "committed" || resumed.finished != 1 {
		t.Fatalf("resume after a lost coordinator: %s %v", resumed.journal.Phase, resumed.err)
	}
	if executor.started("apply-cp") != 1 || executor.started("apply-spine") != 1 {
		t.Fatalf("resume started a step again: %v", executor.starts)
	}
}

// captureCoreNotices collects what the coordinator writes to standard error.
func captureCoreNotices(t *testing.T) *[]string {
	t.Helper()
	old := coreNotice
	t.Cleanup(func() { coreNotice = old })
	lines := &[]string{}
	coreNotice = func(line string) { *lines = append(*lines, line) }
	return lines
}

// What the coordinator decided at the hand-over is one line on standard error
// (the system journal, in a continuation unit): which Spine it hands the
// request to, or that it keeps coordinating and why. A running step writes
// nothing there.
func TestCoreHandOverDecisionIsWritten(t *testing.T) {
	notices := captureCoreNotices(t)
	j := handOverJournal(t)
	target, _ := j.Target.Member("spine")
	yes := func() ([]byte, error) { return canResumeAnswer(t, j, j.RequestID, true), nil }
	handing := "handing request update-1 over to Spine of YouEye " + strings.TrimPrefix(partVersion(j.Target, target), "from ") + " (sha256 eeeeeeeeeeee)"

	// Handed over: the line is written before the exec. (The stub exec returns, which the real one does not.)
	stubHandOver(t, target.Artifact.SHA256, yes, nil)
	_ = coreHandOverToSelectedSpine(context.Background(), j)
	if !reflect.DeepEqual(*notices, []string{handing}) {
		t.Fatalf("hand-over: %q", *notices)
	}
	// Refused before the exec: nothing says "handing over".
	*notices = nil
	stubHandOver(t, target.Artifact.SHA256, func() ([]byte, error) { return nil, fmt.Errorf("exit status 1") }, nil)
	if err := coreHandOverToSelectedSpine(context.Background(), j); err == nil || len(*notices) != 0 {
		t.Fatalf("refused hand-over: %v %q", err, *notices)
	}

	// The loop: a hand-over that could not be made is one line with the reason, and the steps that then run in
	// this coordinator (each observed about once a second) add none.
	*notices = nil
	m, executor, prepared := continuationFixture(t, true)
	executor.running = "apply-cp"
	go func() {
		for executor.started("apply-cp") == 0 {
			time.Sleep(10 * time.Millisecond)
		}
		time.Sleep(1500 * time.Millisecond) // at least one more pass of the loop over the running step
		executor.finish(prepared.RequestID, "apply-cp")
	}()
	run := runContinuation(context.Background(), m, prepared.RequestID, true, func() (bool, error) {
		return false, fmt.Errorf("the new Spine did not confirm that it can continue this request: exit status 1")
	})
	if run.err != nil || run.journal.Phase != "committed" {
		t.Fatalf("phase=%s err=%v", run.journal.Phase, run.err)
	}
	if !reflect.DeepEqual(*notices, []string{"this Spine keeps coordinating the request: the new Spine did not confirm that it can continue this request: exit status 1"}) {
		t.Fatalf("kept request: %q", *notices)
	}
}

func handOverJournal(t *testing.T) systemupdate.CoreJournal {
	t.Helper()
	m, _, j := continuationFixture(t, true)
	m.YieldAfterSpine = true
	j, err := m.Advance(context.Background(), j.RequestID, true)
	if err != nil || j.Phase != "applying" || stepStates(j)["apply-spine"] != "succeeded" || stepStates(j)["apply-cp"] != "pending" {
		t.Fatalf("fixture did not stop after the Spine step: %s %v %v", j.Phase, stepStates(j), err)
	}
	return j
}

// statusAnswer is what `update core status` prints without flags: what a Spine
// before the --can-resume question answers when asked for its status.
func statusAnswer(t *testing.T, j systemupdate.CoreJournal) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"installed": j.Previous, "transaction": j})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// canResumeAnswer is the answer to `update core status --can-resume --request <request>`.
func canResumeAnswer(t *testing.T, j systemupdate.CoreJournal, request string, can bool) []byte {
	t.Helper()
	answer := map[string]any{"installed": j.Previous, "transaction": j, "can_resume": can, "can_resume_request": request}
	if !can {
		answer["can_resume_reason"] = "fixture refusal"
	}
	raw, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

type handOverCalls struct {
	probes   int
	requests []string
	execs    [][]string
	env      []string
}

func stubHandOver(t *testing.T, current string, probe func() ([]byte, error), execErr error) *handOverCalls {
	t.Helper()
	calls := &handOverCalls{}
	oldExec, oldCurrent, oldProbe := coreHandOverExec, coreHandOverCurrent, coreHandOverProbe
	t.Cleanup(func() { coreHandOverExec, coreHandOverCurrent, coreHandOverProbe = oldExec, oldCurrent, oldProbe })
	coreHandOverCurrent = func() (string, error) {
		if current == "" {
			return "", fmt.Errorf("fixture: no committed Spine")
		}
		return current, nil
	}
	coreHandOverProbe = func(_ context.Context, executable, request string, env []string) ([]byte, error) {
		calls.probes++
		calls.requests = append(calls.requests, request)
		if executable != coreBakedExecutable {
			t.Errorf("probe ran %s, not the baked launcher", executable)
		}
		for _, entry := range env {
			if strings.HasPrefix(entry, spineselect.DelegatedEnv+"=") {
				t.Error("the launcher marker was passed to the probe: the baked launcher would answer itself")
			}
		}
		return probe()
	}
	coreHandOverExec = func(path string, argv, env []string) error {
		calls.execs = append(calls.execs, append([]string{path}, argv...))
		calls.env = env
		return execErr
	}
	return calls
}

func TestCoreHandOverStartsTheNewSpinesResume(t *testing.T) {
	j := handOverJournal(t)
	target, _ := j.Target.Member("spine")
	t.Setenv(spineselect.DelegatedEnv, "1")
	calls := stubHandOver(t, target.Artifact.SHA256, func() ([]byte, error) { return canResumeAnswer(t, j, j.RequestID, true), nil }, nil)
	// The stub exec returns, which the real one does only on failure.
	if err := coreHandOverToSelectedSpine(context.Background(), j); err == nil {
		t.Fatal("a returning exec was reported as a hand-over")
	}
	want := []string{coreBakedExecutable, coreBakedExecutable, "update", "core", "resume", "--request", j.RequestID}
	if calls.probes != 1 || len(calls.execs) != 1 || !reflect.DeepEqual(calls.execs[0], want) {
		t.Fatalf("hand-over ran %v after %d probes, want %v", calls.execs, calls.probes, want)
	}
	if !reflect.DeepEqual(calls.requests, []string{j.RequestID}) {
		t.Fatalf("the new Spine was asked about %v", calls.requests)
	}
	for _, entry := range calls.env {
		if strings.HasPrefix(entry, spineselect.DelegatedEnv+"=") {
			t.Fatal("the launcher marker was passed on: the baked launcher would not delegate")
		}
	}
}

func TestCoreHandOverIsRefusedUnlessTheNewSpineReadsThisRequest(t *testing.T) {
	j := handOverJournal(t)
	target, _ := j.Target.Member("spine")
	previous, _ := j.Previous.Release.Member("spine")
	other := j
	other.RequestID = "another-request"
	otherDigest := j
	otherDigest.ManifestSHA256 = strings.Repeat("9", 64)
	otherPhase := j
	otherPhase.Phase = "needs-recovery"
	fewer := j
	fewer.Steps = j.Steps[:len(j.Steps)-1]
	behind := j
	behind.Steps = append([]systemupdate.CoreStep(nil), j.Steps...)
	for i := range behind.Steps {
		if behind.Steps[i].Name == "apply-spine" {
			behind.Steps[i].State = "started"
		}
	}
	// "Yes" for this request, beside the transaction the answering Spine reads.
	yes := func(reads systemupdate.CoreJournal) func() ([]byte, error) {
		return func() ([]byte, error) { return canResumeAnswer(t, reads, j.RequestID, true), nil }
	}
	silent, err := json.Marshal(map[string]any{"installed": j.Previous, "transaction": j, "can_resume_request": j.RequestID})
	if err != nil {
		t.Fatal(err)
	}
	word, err := json.Marshal(map[string]any{"installed": j.Previous, "transaction": j, "can_resume": "true", "can_resume_request": j.RequestID})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		current string
		probe   func() ([]byte, error)
		probes  int
	}{
		"no committed Spine":             {"", yes(j), 0},
		"the old Spine is still current": {previous.Artifact.SHA256, yes(j), 0},
		"the new Spine does not answer":  {target.Artifact.SHA256, func() ([]byte, error) { return nil, fmt.Errorf("exit status 1") }, 1},
		"an unreadable answer":           {target.Artifact.SHA256, func() ([]byte, error) { return []byte("not json"), nil }, 1},
		"an answer followed by more":     {target.Artifact.SHA256, func() ([]byte, error) { return append(canResumeAnswer(t, j, j.RequestID, true), "Error: x"...), nil }, 1},
		"no transaction": {target.Artifact.SHA256, func() ([]byte, error) {
			return []byte(`{"installed":{},"can_resume":true,"can_resume_request":"update-1"}`), nil
		}, 1},
		// What a Spine before the question would print if it ignored the flag.
		"a status answer without the question's answer": {target.Artifact.SHA256, func() ([]byte, error) { return statusAnswer(t, j), nil }, 1},
		"the answer is missing":                         {target.Artifact.SHA256, func() ([]byte, error) { return silent, nil }, 1},
		"the answer is not a boolean":                   {target.Artifact.SHA256, func() ([]byte, error) { return word, nil }, 1},
		"the new Spine cannot resume":                   {target.Artifact.SHA256, func() ([]byte, error) { return canResumeAnswer(t, j, j.RequestID, false), nil }, 1},
		"the answer is about another request":           {target.Artifact.SHA256, func() ([]byte, error) { return canResumeAnswer(t, j, "another-request", true), nil }, 1},
		"another request":                               {target.Artifact.SHA256, yes(other), 1},
		"another release":                               {target.Artifact.SHA256, yes(otherDigest), 1},
		"another phase":                                 {target.Artifact.SHA256, yes(otherPhase), 1},
		"another state of the request":                  {target.Artifact.SHA256, yes(behind), 1},
		"fewer steps":                                   {target.Artifact.SHA256, yes(fewer), 1},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			calls := stubHandOver(t, test.current, test.probe, nil)
			if err := coreHandOverToSelectedSpine(context.Background(), j); err == nil {
				t.Fatal("hand-over was not refused")
			}
			if len(calls.execs) != 0 || calls.probes != test.probes {
				t.Fatalf("refused hand-over ran exec %v after %d probes", calls.execs, calls.probes)
			}
		})
	}
	// An exec that fails is reported; the caller keeps coordinating.
	calls := stubHandOver(t, target.Artifact.SHA256, yes(j), fmt.Errorf("exec format error"))
	if err := coreHandOverToSelectedSpine(context.Background(), j); err == nil || !strings.Contains(err.Error(), "exec format error") || len(calls.execs) != 1 {
		t.Fatalf("failed exec: %v %v", err, calls.execs)
	}
}

// recoveringExecutor is the continuation executor with recovery, and with
// steps that can be made to fail or to leave no word (a killed child, a power
// cut).
type recoveringExecutor struct {
	*continuationExecutor
	fail, lose map[string]bool
}

func (e recoveringExecutor) AuthorizeRecovery(context.Context, systemupdate.CoreJournal) error {
	return nil
}

func (e recoveringExecutor) Start(ctx context.Context, j systemupdate.CoreJournal, s systemupdate.CoreStep) (systemupdate.CoreActionObservation, error) {
	out, err := e.continuationExecutor.Start(ctx, j, s)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.fail[s.Name] {
		out = systemupdate.CoreActionObservation{State: "failed", Evidence: "fixture: " + s.Name + " failed"}
		e.results[s.RequestID] = out
	}
	if e.lose[s.Name] {
		out = systemupdate.CoreActionObservation{State: "unknown", Evidence: "fixture: no word from " + s.Name}
		e.results[s.RequestID] = out
	}
	return out, err
}

func runToAnEnd(m systemupdate.CoreManager, request string, once bool) (systemupdate.CoreJournal, error, []string) {
	old := coreRecoveryGrace
	coreRecoveryGrace = time.Millisecond
	defer func() { coreRecoveryGrace = old }()
	finished := []string{}
	j, err := runCoreContinuationToAnEnd(context.Background(), coreContinuation{
		manager: m,
		finished: func(_ context.Context, j systemupdate.CoreJournal) error {
			finished = append(finished, j.Phase)
			return nil
		},
	}, request, false, false, once)
	return j, err, finished
}

// An update that stops past its checkpoint holds the platform with the Control
// Panel closed. Its coordinator restores the previous release itself, whether
// a step failed or left no word (a power cut in the middle of a step, seen by
// the boot continuation). Before 0.6.15 the request stayed in needs-recovery
// and the box stayed closed until someone ran `recover` on the console.
func TestCoreContinuationRestoresThePreviousReleaseWhenAnUpdateCannotGoOn(t *testing.T) {
	for _, tc := range []struct{ name, step, how string }{
		{"a step failed", "apply-cp", "fail"},
		{"a step left no word", "apply-ui", "lose"},
		{"the checkpoint left no word", "checkpoint", "lose"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lines := captureCoreNotices(t)
			m, base, j := continuationFixture(t, false)
			e := recoveringExecutor{continuationExecutor: base, fail: map[string]bool{}, lose: map[string]bool{}}
			if tc.how == "fail" {
				e.fail[tc.step] = true
			} else {
				e.lose[tc.step] = true
			}
			m.Executor = e
			got, err, finished := runToAnEnd(m, j.RequestID, false)
			if err != nil || got.Phase != "rolled-back" || fmt.Sprint(finished) != "[rolled-back]" {
				t.Fatalf("the previous release was not restored: phase=%s finished=%v err=%v steps=%v", got.Phase, finished, err, stepStates(got))
			}
			if e.started("recovery-fence") != 1 || e.started("recovery-paired-restore") != 1 || e.started("recovery-health") != 1 {
				t.Fatalf("recovery steps: %v", e.starts)
			}
			if len(*lines) != 1 || !strings.Contains((*lines)[0], "restoring the previous release") {
				t.Fatalf("the decision was not written: %v", *lines)
			}
			// The ended request stays ended.
			again, err, finished := runToAnEnd(m, j.RequestID, false)
			if err != nil || again.Phase != "rolled-back" || e.started("recovery-fence") != 1 || fmt.Sprint(finished) != "[rolled-back]" {
				t.Fatal(again.Phase, err, e.starts, finished)
			}
		})
	}
}

// Never before the checkpoint (nothing is held; the panel offers Cancel),
// never in a single pass, and never a second time when the recovery itself
// stops.
func TestCoreContinuationStartsNoRecoveryItShouldNot(t *testing.T) {
	// Before the checkpoint.
	m, base, j := continuationFixture(t, false)
	e := recoveringExecutor{continuationExecutor: base, fail: map[string]bool{"verify-members": true}, lose: map[string]bool{}}
	m.Executor = e
	got, err, finished := runToAnEnd(m, j.RequestID, false)
	if err == nil || got.Phase != "needs-recovery" || len(got.RecoverySteps) != 0 || len(finished) != 0 || e.started("recovery-fence") != 0 {
		t.Fatalf("a failed preparation step: phase=%s err=%v recovery=%v", got.Phase, err, got.RecoverySteps)
	}

	// A single pass.
	m, base, j = continuationFixture(t, false)
	e = recoveringExecutor{continuationExecutor: base, fail: map[string]bool{"apply-cp": true}, lose: map[string]bool{}}
	m.Executor = e
	got, err, _ = runToAnEnd(m, j.RequestID, true)
	if err == nil || got.Phase != "needs-recovery" || e.started("recovery-fence") != 0 {
		t.Fatalf("a single pass started a recovery: phase=%s err=%v", got.Phase, err)
	}
	// The next continuation without --once (the boot unit, the watchdog, "Resume") restores.
	if got, err, _ = runToAnEnd(m, j.RequestID, false); err != nil || got.Phase != "rolled-back" {
		t.Fatalf("a request found in needs-recovery was not restored: phase=%s err=%v", got.Phase, err)
	}

	// The recovery itself fails: it is left for a person, and resuming does not start another.
	m, base, j = continuationFixture(t, false)
	e = recoveringExecutor{continuationExecutor: base, fail: map[string]bool{"apply-cp": true, "recovery-paired-restore": true}, lose: map[string]bool{}}
	m.Executor = e
	got, err, finished = runToAnEnd(m, j.RequestID, false)
	if err == nil || got.Phase != "needs-recovery" || len(got.RecoverySteps) == 0 || len(finished) != 0 || e.started("recovery-paired-restore") != 1 {
		t.Fatalf("a failed recovery: phase=%s err=%v starts=%v", got.Phase, err, e.starts)
	}
	got, err, _ = runToAnEnd(m, j.RequestID, false)
	if err == nil || got.Phase != "needs-recovery" || e.started("recovery-fence") != 1 || e.started("recovery-paired-restore") != 1 {
		t.Fatalf("a failed recovery was started again: phase=%s err=%v starts=%v", got.Phase, err, e.starts)
	}
}

// An outcome that could not be learned at first (a lost launch acknowledgement)
// while the child runs after all: the second look follows it, and the update
// commits instead of being rolled back.
func TestCoreContinuationLooksAgainBeforeGivingAnUpdateUp(t *testing.T) {
	lines := captureCoreNotices(t)
	m, base, j := continuationFixture(t, false)
	e := &onceLostExecutor{recoveringExecutor: recoveringExecutor{continuationExecutor: base, fail: map[string]bool{}, lose: map[string]bool{"apply-cp": true}}}
	m.Executor = e
	got, err, finished := runToAnEnd(m, j.RequestID, false)
	if err != nil || got.Phase != "committed" || fmt.Sprint(finished) != "[committed]" || e.started("recovery-fence") != 0 || e.started("apply-cp") != 1 || len(*lines) != 0 {
		t.Fatalf("phase=%s finished=%v err=%v starts=%v notices=%v", got.Phase, finished, err, e.starts, *lines)
	}
}

// onceLostExecutor: the lost step has no word for the first two observations
// (the pass that started it), then its child's success.
type onceLostExecutor struct {
	recoveringExecutor
	observed int
}

func (e *onceLostExecutor) Observe(ctx context.Context, j systemupdate.CoreJournal, s systemupdate.CoreStep) (systemupdate.CoreActionObservation, error) {
	if e.lose[s.Name] {
		e.observed++
		if e.observed > 1 {
			return systemupdate.CoreActionObservation{State: "succeeded", Evidence: "fixture: the child finished"}, nil
		}
	}
	return e.recoveringExecutor.Observe(ctx, j, s)
}

// flakyExecutor fails the first `looks` observations of a started step with
// err, as a look that failed does: the step itself is as healthy as before.
type flakyExecutor struct {
	recoveringExecutor
	step  string
	err   error
	looks int
	seen  int
}

func (e *flakyExecutor) Observe(ctx context.Context, j systemupdate.CoreJournal, s systemupdate.CoreStep) (systemupdate.CoreActionObservation, error) {
	if s.Name == e.step {
		e.mu.Lock()
		e.seen++
		fail := e.seen <= e.looks
		e.mu.Unlock()
		if fail {
			return systemupdate.CoreActionObservation{}, e.err
		}
	}
	return e.recoveringExecutor.Observe(ctx, j, s)
}

func runToAnEndWith(c coreContinuation, request string) (systemupdate.CoreJournal, error, []string) {
	oldGrace, oldPause := coreRecoveryGrace, coreUncertainPause
	coreRecoveryGrace, coreUncertainPause = time.Millisecond, time.Millisecond
	defer func() { coreRecoveryGrace, coreUncertainPause = oldGrace, oldPause }()
	finished := []string{}
	c.finished = func(_ context.Context, j systemupdate.CoreJournal) error {
		finished = append(finished, j.Phase)
		return nil
	}
	j, err := runCoreContinuationToAnEnd(context.Background(), c, request, false, false, false)
	return j, err, finished
}

// A look that failed says nothing about the step. The action lock held for a
// moment by a second coordinator, and `systemctl show` failing while the child
// runs, each made the coordinator mark the request needs-recovery; a second
// such look 15 seconds later made it fence the live child and restore the
// previous release over a healthy update. Now it looks again, and the update
// commits. Only a step whose child is positively gone is given up.
func TestCoreContinuationDoesNotGiveUpAStepOverAFailedLook(t *testing.T) {
	busy := fmt.Errorf("%w: resource temporarily unavailable", systemupdate.ErrCoreActionOwned)
	unobservable := fmt.Errorf("native unit observation unavailable")
	notKnown := func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) string {
		return systemupdate.CoreChildNotKnown
	}
	gone := func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) string {
		return systemupdate.CoreChildGone
	}
	for _, tc := range []struct {
		name       string
		err        error
		childState func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) string
		looks      int
		want       string
		succeeded  bool // the child ended with "succeeded" before the looks failed
	}{
		// "Gone" is also a child that succeeded: until 0.6.15 the failed look rolled the update back.
		{"the look fails after the child succeeded", unobservable, gone, 4, "committed", true},
		{"the action lock is held by a second coordinator", busy, nil, 4, "committed", false},
		{"the lock is held and the child is gone", busy, gone, 4, "committed", false},
		{"systemd does not answer while the child may run", unobservable, notKnown, 4, "committed", false},
		// One look by the first pass, one by the second after the grace.
		{"the look fails and the child is positively gone", unobservable, gone, 2, "rolled-back", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lines := captureCoreNotices(t)
			m, base, j := continuationFixture(t, false)
			base.running = "apply-cp"
			e := &flakyExecutor{recoveringExecutor: recoveringExecutor{continuationExecutor: base, fail: map[string]bool{}, lose: map[string]bool{}}, step: "apply-cp", err: tc.err, looks: tc.looks}
			if tc.want == "rolled-back" {
				// The child died without a word.
				base.running, e.lose["apply-cp"] = "", true
			}
			m.Executor = e
			go func() {
				// A child that runs ends by itself after the failed looks.
				if tc.want == "rolled-back" {
					return
				}
				for {
					e.mu.Lock()
					seen := e.seen
					e.mu.Unlock()
					if seen > e.looks {
						base.finish(j.RequestID, "apply-cp")
						return
					}
					time.Sleep(time.Millisecond)
				}
			}()
			c := coreContinuation{manager: m, childState: tc.childState}
			if tc.succeeded {
				c.childSucceeded = func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) bool { return true }
			}
			got, err, finished := runToAnEndWith(c, j.RequestID)
			if err != nil || got.Phase != tc.want || fmt.Sprint(finished) != "["+tc.want+"]" {
				t.Fatalf("phase=%s finished=%v err=%v steps=%v", got.Phase, finished, err, stepStates(got))
			}
			if recovered := e.started("recovery-fence") == 1; recovered != (tc.want == "rolled-back") || (len(*lines) != 0) != recovered {
				t.Fatalf("recovery starts=%v notices=%v", e.starts, *lines)
			}
			if e.started("apply-cp") != 1 {
				t.Fatalf("apply-cp was started %d times", e.started("apply-cp"))
			}
		})
	}
}

// untilRecoveryExecutor fails the looks at its step only while the update is applied: the recovery can look.
type untilRecoveryExecutor struct{ *flakyExecutor }

func (e untilRecoveryExecutor) Observe(ctx context.Context, j systemupdate.CoreJournal, s systemupdate.CoreStep) (systemupdate.CoreActionObservation, error) {
	if j.Phase != "applying" {
		return e.recoveringExecutor.Observe(ctx, j, s)
	}
	return e.flakyExecutor.Observe(ctx, j, s)
}

// A step whose child succeeded and whose success no look can record is not looked at for ever: after
// coreSucceededPatience it is given up, and the previous release is restored, so the box does not stay held.
func TestCoreContinuationGivesUpASucceededStepNoLookCanRecord(t *testing.T) {
	old, pause := coreSucceededPatience, coreUncertainPause
	coreSucceededPatience, coreUncertainPause = 40*time.Millisecond, 5*time.Millisecond
	defer func() { coreSucceededPatience, coreUncertainPause = old, pause }()
	captureCoreNotices(t)
	m, base, j := continuationFixture(t, false)
	e := &flakyExecutor{recoveringExecutor: recoveringExecutor{continuationExecutor: base, fail: map[string]bool{}, lose: map[string]bool{"apply-cp": true}}, step: "apply-cp", err: fmt.Errorf("native unit observation unavailable"), looks: 1 << 30}
	m.Executor = untilRecoveryExecutor{e}
	began := time.Now()
	got, err, finished := runToAnEndWith(coreContinuation{manager: m,
		childState: func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) string {
			return systemupdate.CoreChildGone
		},
		childSucceeded: func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) bool { return true }}, j.RequestID)
	if err != nil || got.Phase != "rolled-back" || fmt.Sprint(finished) != "[rolled-back]" {
		t.Fatalf("phase=%s finished=%v err=%v", got.Phase, finished, err)
	}
	if time.Since(began) < coreSucceededPatience {
		t.Fatalf("given up after %s", time.Since(began))
	}
}

// untilExecutor fails every look at its step until a moment.
type untilExecutor struct {
	recoveringExecutor
	step  string
	until time.Time
}

func (e untilExecutor) Observe(ctx context.Context, j systemupdate.CoreJournal, s systemupdate.CoreStep) (systemupdate.CoreActionObservation, error) {
	if s.Name == e.step && time.Now().Before(e.until) {
		return systemupdate.CoreActionObservation{}, fmt.Errorf("native unit observation unavailable")
	}
	return e.recoveringExecutor.Observe(ctx, j, s)
}

// The bounded waits count from when their own reason began. Looks that fail while the child runs are waited for
// without a limit; until 0.6.15 they used up the patience for what follows, so a child that then succeeded (or
// left processes that ended a moment later) was given up at the first look and a good update was rolled back.
func TestCoreContinuationCountsEachPatienceFromItsOwnBeginning(t *testing.T) {
	for _, after := range []string{systemupdate.CoreChildGone, systemupdate.CoreChildLingering} {
		t.Run(after, func(t *testing.T) {
			oldSucceeded, oldLingering := coreSucceededPatience, coreLingeringPatience
			coreSucceededPatience, coreLingeringPatience = 400*time.Millisecond, 400*time.Millisecond
			defer func() { coreSucceededPatience, coreLingeringPatience = oldSucceeded, oldLingering }()
			lines := captureCoreNotices(t)
			m, base, j := continuationFixture(t, false)
			base.running = "apply-cp"
			began := time.Now()
			// The child runs, unobservable, for longer than either patience; then it ends with success and the
			// looks keep failing for a moment more.
			ends := began.Add(2 * coreSucceededPatience)
			e := untilExecutor{recoveringExecutor: recoveringExecutor{continuationExecutor: base, fail: map[string]bool{}, lose: map[string]bool{}}, step: "apply-cp", until: ends.Add(50 * time.Millisecond)}
			m.Executor = e
			var once sync.Once
			c := coreContinuation{manager: m,
				childState: func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) string {
					if time.Now().Before(ends) {
						return systemupdate.CoreChildNotKnown
					}
					once.Do(func() { base.finish(j.RequestID, "apply-cp") })
					return after
				},
				childSucceeded: func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) bool { return true }}
			got, err, finished := runToAnEndWith(c, j.RequestID)
			if err != nil || got.Phase != "committed" || fmt.Sprint(finished) != "[committed]" || len(*lines) != 0 {
				t.Fatalf("phase=%s finished=%v err=%v notices=%v steps=%v", got.Phase, finished, err, *lines, stepStates(got))
			}
			if e.started("recovery-fence") != 0 || e.started("apply-cp") != 1 {
				t.Fatalf("starts=%v", e.starts)
			}
		})
	}
}

// A step's patience is its own: failing passes can go from one step to the next without a look that succeeds in
// between, and the next step then began with what was left of the previous one's wait (or none).
func TestCoreUncertainStepBeginsTheWaitsAnewForAnotherStep(t *testing.T) {
	for _, state := range []string{systemupdate.CoreChildGone, systemupdate.CoreChildLingering} {
		t.Run(state, func(t *testing.T) {
			oldSucceeded, oldLingering := coreSucceededPatience, coreLingeringPatience
			coreSucceededPatience, coreLingeringPatience = 30*time.Millisecond, 30*time.Millisecond
			defer func() { coreSucceededPatience, coreLingeringPatience = oldSucceeded, oldLingering }()
			c := coreContinuation{
				childState: func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) string { return state },
				childSucceeded: func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) bool {
					return true
				}}
			var waits coreUncertainWaits
			look := func(step string) bool {
				return c.coreUncertainStep(context.Background(), systemupdate.CoreJournal{}, systemupdate.CoreStep{Name: step}, fmt.Errorf("native unit observation unavailable"), &waits)
			}
			if !look("apply-cp") {
				t.Fatal("the first step was given up at its first look")
			}
			time.Sleep(2 * coreLingeringPatience)
			if !look("apply-ui") {
				t.Fatal("the next step was given up at its first look: it had the previous step's wait")
			}
			if !look("apply-ui") {
				t.Fatal("the next step's wait did not begin at its first look")
			}
			time.Sleep(2 * coreLingeringPatience)
			if look("apply-ui") {
				t.Fatal("the same step's wait began anew")
			}
		})
	}
}

// A single pass (--once) reports a failed look and gives nothing up either.
func TestCoreContinuationSinglePassLeavesAFailedLookAlone(t *testing.T) {
	m, base, j := continuationFixture(t, false)
	base.running = "apply-cp"
	e := &flakyExecutor{recoveringExecutor: recoveringExecutor{continuationExecutor: base, fail: map[string]bool{}, lose: map[string]bool{}}, step: "apply-cp", err: fmt.Errorf("%w: busy", systemupdate.ErrCoreActionOwned), looks: 1000}
	m.Executor = e
	c := coreContinuation{manager: m, finished: func(context.Context, systemupdate.CoreJournal) error { return nil }}
	// Passes until apply-cp is started, then one more that meets the held lock.
	var err error
	for pass := 0; pass < 10 && err == nil; pass++ {
		_, err = runCoreContinuation(context.Background(), c, j.RequestID, false, false, true)
	}
	got, readErr := m.Read()
	if err == nil || readErr != nil || got.Phase != "applying" || stepStates(got)["apply-cp"] != "started" {
		t.Fatalf("phase=%s err=%v steps=%v", got.Phase, err, stepStates(got))
	}
}

// Processes that outlive their action's main process are waited for, for a
// bounded time; then the step is given up and the recovery (whose fence stops
// them) restores the previous release.
func TestCoreContinuationWaitsForLingeringProcessesOnlySoLong(t *testing.T) {
	old := coreLingeringPatience
	coreLingeringPatience = 30 * time.Millisecond
	defer func() { coreLingeringPatience = old }()
	captureCoreNotices(t)
	m, base, j := continuationFixture(t, false)
	e := recoveringExecutor{continuationExecutor: base, fail: map[string]bool{}, lose: map[string]bool{"apply-cp": true}}
	m.Executor = e
	looks := 0
	began := time.Now()
	got, err, finished := runToAnEndWith(coreContinuation{manager: m, childState: func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) string {
		looks++
		return systemupdate.CoreChildLingering
	}}, j.RequestID)
	if err != nil || got.Phase != "rolled-back" || fmt.Sprint(finished) != "[rolled-back]" {
		t.Fatalf("phase=%s finished=%v err=%v", got.Phase, finished, err)
	}
	if looks < 3 || time.Since(began) < coreLingeringPatience {
		t.Fatalf("the step was given up after %d looks in %s", looks, time.Since(began))
	}
}

// A started activate-host whose outcome is unknown is left to the next boot,
// unless the restart did not happen: then it is asked for again, and when that
// cannot help the previous release is restored. Before 0.6.15 the continuation
// ended without an error and the box stayed held with the Control Panel closed.
func TestCoreContinuationJudgesAHostStepWhoseRestartDidNotHappen(t *testing.T) {
	prepare := func(t *testing.T) (systemupdate.CoreManager, recoveringExecutor, systemupdate.CoreJournal) {
		m, base, j := continuationFixtureChanging(t, "cp", "system-root")
		if !j.RestartRequired {
			t.Fatal("fixture is not an image update")
		}
		e := recoveringExecutor{continuationExecutor: base, fail: map[string]bool{}, lose: map[string]bool{"activate-host": true}}
		m.Executor = e
		// Staged, waiting for the owner's restart; then the owner asks for it.
		c := coreContinuation{manager: m, finished: func(context.Context, systemupdate.CoreJournal) error { return nil }}
		if staged, err := runCoreContinuation(context.Background(), c, j.RequestID, false, false, false); err != nil || staged.Phase != "awaiting-restart" {
			t.Fatal(staged.Phase, err)
		}
		if _, err := m.RequestActivation(context.Background(), j.RequestID, j.ManifestSHA256); err != nil {
			t.Fatal(err)
		}
		return m, e, j
	}
	t.Run("left to the next boot", func(t *testing.T) {
		m, e, j := prepare(t)
		asked := 0
		got, err, finished := runToAnEndWith(coreContinuation{manager: m, rebootAgain: func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) (bool, error) {
			asked++
			return false, nil
		}}, j.RequestID)
		if err != nil || got.Phase != "applying" || stepStates(got)["activate-host"] != "started" || len(finished) != 0 || asked != 1 || e.started("recovery-fence") != 0 {
			t.Fatalf("phase=%s err=%v steps=%v asked=%d", got.Phase, err, stepStates(got), asked)
		}
	})
	t.Run("asked for again", func(t *testing.T) {
		lines := captureCoreNotices(t)
		m, e, j := prepare(t)
		got, err, _ := runToAnEndWith(coreContinuation{manager: m, rebootAgain: func(_ context.Context, _ systemupdate.CoreJournal, s systemupdate.CoreStep) (bool, error) {
			return s.Name == "activate-host", nil
		}}, j.RequestID)
		if err != nil || got.Phase != "applying" || e.started("recovery-fence") != 0 || len(*lines) != 1 || !strings.Contains((*lines)[0], "asked for it again") {
			t.Fatalf("phase=%s err=%v notices=%v", got.Phase, err, *lines)
		}
	})
	t.Run("given up", func(t *testing.T) {
		lines := captureCoreNotices(t)
		m, e, j := prepare(t)
		got, err, finished := runToAnEndWith(coreContinuation{manager: m, rebootAgain: func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) (bool, error) {
			return false, fmt.Errorf("the restart into the new system image was asked for 3 times and did not happen")
		}}, j.RequestID)
		if err != nil || got.Phase != "rolled-back" || fmt.Sprint(finished) != "[rolled-back]" || e.started("recovery-host") != 1 {
			t.Fatalf("phase=%s finished=%v err=%v starts=%v", got.Phase, finished, err, e.starts)
		}
		if len(*lines) != 1 || !strings.Contains((*lines)[0], "did not happen") {
			t.Fatalf("notices: %v", *lines)
		}
	})
}

// The whole chain for a box whose restart into the new image never comes, with nobody at it: the watchdog finds the
// host step lost and starts a continuation; that is the real `resume` loop, which ends at coreHostStepUnknown and
// asks RebootAgain; the journal does not change, so the watchdog goes on (three attempts of its own, then the slow
// ones, each after Forget); when RebootAgain gives the update up, the same continuation records it
// (RecordAttention) and restores the previous release, and the watchdog has nothing left to do. The parts are
// tested where they live (RebootAgain with the watchdog in systemupdate, the loop above); this is what joins them.
// RebootAgain is modelled by its contract here: it asks coreOwedRebootRequests times, then returns an error.
func TestCoreWatchdogResumeAndRecoveryEndAnOwedRestart(t *testing.T) {
	lines := captureCoreNotices(t)
	m, base, j := continuationFixtureChanging(t, "cp", "system-root")
	if !j.RestartRequired {
		t.Fatal("fixture is not an image update")
	}
	e := recoveringExecutor{continuationExecutor: base, fail: map[string]bool{}, lose: map[string]bool{"activate-host": true}}
	m.Executor = e
	staging := coreContinuation{manager: m, finished: func(context.Context, systemupdate.CoreJournal) error { return nil }}
	if staged, err := runCoreContinuation(context.Background(), staging, j.RequestID, false, false, false); err != nil || staged.Phase != "awaiting-restart" {
		t.Fatal(staged.Phase, err)
	}
	if _, err := m.RequestActivation(context.Background(), j.RequestID, j.ManifestSHA256); err != nil {
		t.Fatal(err)
	}
	// The coordinator that started activate-host; its child asked for a restart that never came, and it is gone.
	const requests = 2 // coreOwedRebootRequests
	asked, looks := 0, 0
	c := coreContinuation{manager: m, rebootAgain: func(_ context.Context, _ systemupdate.CoreJournal, s systemupdate.CoreStep) (bool, error) {
		looks++
		if s.Name != "activate-host" {
			return false, nil
		}
		if asked >= requests {
			return false, fmt.Errorf("the restart into the new system image was asked for %d times and did not happen", asked+1)
		}
		asked++
		return true, nil
	}}
	if got, err, _ := runToAnEndWith(c, j.RequestID); err != nil || got.Phase != "applying" || stepStates(got)["activate-host"] != "started" || asked != 1 {
		t.Fatalf("the first coordinator: phase=%s err=%v asked=%d", got.Phase, err, asked)
	}

	at := time.Unix(1_800_000_000, 0)
	delivered := map[string]bool{}
	var commands []string
	var last systemupdate.CoreJournal
	var lastErr error
	var finished []string
	w := &systemupdate.CoreContinuationWatchdog{Root: m.Root, Lifecycle: filepath.Join(t.TempDir(), "app-updates"), Idle: coreWatchdogIdle,
		Now:          func() time.Time { return at },
		Coordinating: func() (bool, error) { return false, nil },
		ChildGone:    func(context.Context, systemupdate.CoreJournal, systemupdate.CoreStep) bool { return true },
		Delivered:    func(_, command string) bool { return delivered[command] },
		Forget:       func(_ context.Context, _, command string) error { delete(delivered, command); return nil },
	}
	// What the continuation unit runs: `update core resume --request …`, to its end.
	w.Start = func(_ context.Context, request, command string) (systemupdate.CoreControlObservation, error) {
		if delivered[command] {
			t.Fatalf("command %s was delivered twice", command)
		}
		delivered[command] = true
		commands = append(commands, command)
		last, lastErr, finished = runToAnEndWith(c, request)
		return systemupdate.CoreControlObservation{RequestID: request, CommandID: command, State: "running"}, nil
	}
	if command, err := w.Check(context.Background()); command != "" || err != nil {
		t.Fatalf("the first look: %q %v", command, err)
	}
	// Within the idle time nothing is started.
	at = at.Add(coreWatchdogIdle - time.Second)
	if command, err := w.Check(context.Background()); command != "" || err != nil {
		t.Fatalf("started within the idle time: %q %v", command, err)
	}
	quiet := 0
	for look := 0; look < 20; look++ {
		at = at.Add(31 * time.Minute) // longer than the idle time and than the slow wait
		command, err := w.Check(context.Background())
		if err != nil {
			t.Fatalf("look %d: %v", look, err)
		}
		if got, readErr := m.Read(); readErr != nil || got.Phase == "rolled-back" {
			break
		}
		// A continuation that wrote the journal is a new state for the watchdog: one look to see it, the next to act.
		if command == "" {
			quiet++
		} else {
			quiet = 0
		}
		if quiet > 1 {
			t.Fatalf("look %d: two looks started nothing and the box is still held (asked=%d)", look, asked)
		}
	}
	got, err := m.Read()
	if err != nil || got.Phase != "rolled-back" {
		t.Fatalf("the box stayed held: phase=%s err=%v asked=%d continuations=%d", got.Phase, err, asked, len(commands))
	}
	// One more request by the first continuation, the next one gave the update up and restored the previous release.
	if asked != requests || len(commands) != 2 || lastErr != nil || last.Phase != "rolled-back" || fmt.Sprint(finished) != "[rolled-back]" {
		t.Fatalf("asked=%d continuations=%d err=%v phase=%s finished=%v", asked, len(commands), lastErr, last.Phase, finished)
	}
	if states := stepStates(got); states["activate-host"] == "succeeded" || e.started("activate-host") != 1 || e.started("recovery-host") != 1 || e.started("recovery-fence") != 1 {
		t.Fatalf("steps=%v starts=%v", states, e.starts)
	}
	notices := strings.Join(*lines, "\n")
	if strings.Count(notices, "asked for it again") != requests || !strings.Contains(notices, "did not happen") || !strings.Contains(notices, "restoring the previous release") {
		t.Fatalf("notices: %v", *lines)
	}
	// Nothing is lost any more: the watchdog starts nothing, however long it looks.
	for look := 0; look < 3; look++ {
		at = at.Add(31 * time.Minute)
		if command, err := w.Check(context.Background()); command != "" || err != nil {
			t.Fatalf("after the recovery: %q %v", command, err)
		}
	}
}
