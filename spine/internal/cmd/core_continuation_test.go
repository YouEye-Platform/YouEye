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
		if release.Members[i].Role == "cp" || (spine && release.Members[i].Role == "spine") {
			release.Members[i].Artifact.SHA256 = strings.Repeat("e", 64)
		}
	}
	raw, digest = digestOf(release)
	j, err := m.Prepare(context.Background(), "update-1", raw, digest)
	if err != nil {
		t.Fatal(err)
	}
	if j.SpineChanged != spine || j.RestartRequired {
		t.Fatalf("fixture graph: spine=%v restart=%v", j.SpineChanged, j.RestartRequired)
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
