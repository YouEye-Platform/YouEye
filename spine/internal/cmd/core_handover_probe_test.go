package cmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/spineselect"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// treeSnapshot records every entry under root: its type, mode, size, change
// time and content. Two equal snapshots mean nothing was created, written,
// touched or removed.
func treeSnapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		line := fmt.Sprintf("%s %d %s", info.Mode(), info.Size(), info.ModTime().Format(time.RFC3339Nano))
		if info.Mode().IsRegular() {
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			line += fmt.Sprintf(" %x", sha256.Sum256(raw))
		}
		out[path] = line
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func stubSpine(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "youeye")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func processGone(pid int) bool {
	for i := 0; i < 100; i++ {
		// A killed process whose parent has not collected it yet is a zombie:
		// it still answers signal 0, so read its state.
		raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			return true
		}
		if end := strings.LastIndexByte(string(raw), ')'); end >= 0 && strings.HasPrefix(strings.TrimSpace(string(raw[end+1:])), "Z") {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// The question the coordinator asks, and how: through the given launcher, with
// the request, without the launcher's marker.
func TestCoreHandOverProbeAsksWhetherTheRequestCanBeResumed(t *testing.T) {
	dir := t.TempDir()
	stub := stubSpine(t, `printf '%s\n' "$@" > "`+dir+`/args"; env > "`+dir+`/env"; printf '{"can_resume":true}'`)
	t.Setenv(spineselect.DelegatedEnv, "1")
	raw, err := coreHandOverProbe(context.Background(), stub, "update-1", coreHandOverEnvironment(os.Environ()))
	if err != nil || string(raw) != `{"can_resume":true}` {
		t.Fatalf("answer %q %v", raw, err)
	}
	args, err := os.ReadFile(filepath.Join(dir, "args"))
	if err != nil || string(args) != "update\ncore\nstatus\n--can-resume\n--request\nupdate-1\n" {
		t.Fatalf("the new Spine was asked %q %v", args, err)
	}
	env, err := os.ReadFile(filepath.Join(dir, "env"))
	if err != nil || strings.Contains(string(env), spineselect.DelegatedEnv+"=") {
		t.Fatalf("the launcher marker reached the probe: %v", err)
	}
}

// An answer counts only from a child that exited with status 0 in time.
func TestCoreHandOverProbeIsBoundedAndNeedsACleanExit(t *testing.T) {
	ask := func(script string, timeout time.Duration) ([]byte, error) {
		return runCoreHandOverProbe(context.Background(), timeout, stubSpine(t, script), []string{"update", "core", "status", "--can-resume", "--request", "update-1"}, os.Environ())
	}
	if raw, err := ask(`printf '{"can_resume":true}'`, 10*time.Second); err != nil || string(raw) != `{"can_resume":true}` {
		t.Fatalf("clean answer: %q %v", raw, err)
	}
	// A Spine from before the question: its flag parser fails.
	if raw, err := ask(`echo 'Error: unknown flag: --can-resume' >&2; exit 2`, 10*time.Second); err == nil || raw != nil {
		t.Fatalf("an unknown flag counted as an answer: %q %v", raw, err)
	}
	// "Yes" on standard output does not count when the command failed.
	if raw, err := ask(`printf '{"can_resume":true}'; exit 1`, 10*time.Second); err == nil || raw != nil {
		t.Fatalf("a failed command's output counted as an answer: %q %v", raw, err)
	}
	if _, err := ask(`kill -9 $$`, 10*time.Second); err == nil {
		t.Fatal("a killed probe counted as an answer")
	}
	if _, err := ask(`head -c 9000000 /dev/zero`, 10*time.Second); err == nil {
		t.Fatal("an answer larger than any valid one was read")
	}
	missing := filepath.Join(t.TempDir(), "absent")
	if _, err := runCoreHandOverProbe(context.Background(), time.Second, missing, nil, nil); err == nil {
		t.Fatal("a launcher that is not there answered")
	}

	// A Spine that hangs, with a child of its own that holds the answer pipe: both are killed when the time is up.
	pidFile := filepath.Join(t.TempDir(), "pids")
	begun := time.Now()
	raw, err := ask(`sleep 300 & echo "$$ $!" > "`+pidFile+`"; printf '{"can_resume":true}'; wait`, 400*time.Millisecond)
	took := time.Since(begun)
	if err == nil || raw != nil || !strings.Contains(err.Error(), "no answer within") {
		t.Fatalf("a hung probe: %q %v", raw, err)
	}
	if took > 400*time.Millisecond+coreHandOverProbeWaitDelay+2*time.Second {
		t.Fatalf("a hung probe held the coordinator for %s", took)
	}
	pids, readErr := os.ReadFile(pidFile)
	if readErr != nil {
		t.Fatal(readErr)
	}
	for _, field := range strings.Fields(string(pids)) {
		pid, err := strconv.Atoi(field)
		if err != nil {
			t.Fatal(err)
		}
		if !processGone(pid) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("process %d of the hung probe survived", pid)
		}
	}
	// The coordinator's own cancellation ends the question too.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runCoreHandOverProbe(ctx, time.Minute, stubSpine(t, `sleep 300`), nil, nil); err == nil {
		t.Fatal("a cancelled probe answered")
	}
	if coreHandOverProbeTimeout != 20*time.Second {
		t.Fatalf("the bound of the question changed to %s: the docs name 20 seconds", coreHandOverProbeTimeout)
	}
}

// Every way the new Spine can fail to say "yes, this request", as a real child
// process: the hand-over is not made and the installed Spine's coordinator
// finishes the request, each step once.
func TestCoreContinuationFinishesInTheInstalledSpineUnlessTheNewSpineCanResume(t *testing.T) {
	type answer func(j systemupdate.CoreJournal) []byte
	yes := func(edit func(*systemupdate.CoreJournal)) answer {
		return func(j systemupdate.CoreJournal) []byte {
			request := j.RequestID
			j.Steps = append([]systemupdate.CoreStep(nil), j.Steps...)
			if edit != nil {
				edit(&j)
			}
			return canResumeAnswer(t, j, request, true)
		}
	}
	cases := map[string]struct {
		script  string // the answer file is $ANSWER
		answer  answer
		timeout time.Duration
		handed  bool
	}{
		"it can resume this request": {script: `cat "$ANSWER"`, answer: yes(nil), handed: true},
		"a Spine before the question (unknown flag)": {script: `for a in "$@"; do if [ "$a" = --can-resume ]; then echo 'Error: unknown flag: --can-resume' >&2; exit 2; fi; done; cat "$ANSWER"`,
			answer: yes(nil)},
		"it cannot resume": {script: `cat "$ANSWER"; echo 'Error: this Spine cannot continue request update-1 now' >&2; exit 1`,
			answer: func(j systemupdate.CoreJournal) []byte { return canResumeAnswer(t, j, j.RequestID, false) }},
		"it cannot resume but exits 0": {script: `cat "$ANSWER"`,
			answer: func(j systemupdate.CoreJournal) []byte { return canResumeAnswer(t, j, j.RequestID, false) }},
		"it says yes and fails": {script: `cat "$ANSWER"; exit 1`, answer: yes(nil)},
		"it answers a plain status": {script: `cat "$ANSWER"`,
			answer: func(j systemupdate.CoreJournal) []byte { return statusAnswer(t, j) }},
		"yes for another request": {script: `cat "$ANSWER"`,
			answer: func(j systemupdate.CoreJournal) []byte { return canResumeAnswer(t, j, "another-request", true) }},
		"it reads another request": {script: `cat "$ANSWER"`, answer: yes(func(j *systemupdate.CoreJournal) { j.RequestID = "another-request" })},
		"it reads another release": {script: `cat "$ANSWER"`, answer: yes(func(j *systemupdate.CoreJournal) { j.ManifestSHA256 = strings.Repeat("9", 64) })},
		"it reads another phase":   {script: `cat "$ANSWER"`, answer: yes(func(j *systemupdate.CoreJournal) { j.Phase = "needs-recovery" })},
		"it reads other step states": {script: `cat "$ANSWER"`, answer: yes(func(j *systemupdate.CoreJournal) {
			for i := range j.Steps {
				if j.Steps[i].Name == "apply-cp" {
					j.Steps[i].State = "started"
				}
			}
		})},
		"it reads other steps": {script: `cat "$ANSWER"`, answer: yes(func(j *systemupdate.CoreJournal) { j.Steps = j.Steps[:len(j.Steps)-1] })},
		"not JSON":             {script: `echo yes`, answer: yes(nil)},
		"JSON and more":        {script: `cat "$ANSWER"; echo trailing`, answer: yes(nil)},
		"no output":            {script: `exit 0`, answer: yes(nil)},
		"it hangs":             {script: `cat "$ANSWER"; sleep 300`, answer: yes(nil), timeout: 300 * time.Millisecond},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			m, executor, j := continuationFixture(t, true)
			target, _ := j.Target.Member("spine")
			answerFile := filepath.Join(t.TempDir(), "answer.json")
			stub := stubSpine(t, test.script)
			timeout := test.timeout
			if timeout == 0 {
				timeout = 10 * time.Second
			}
			var execs [][]string
			oldExec, oldCurrent, oldProbe := coreHandOverExec, coreHandOverCurrent, coreHandOverProbe
			t.Cleanup(func() { coreHandOverExec, coreHandOverCurrent, coreHandOverProbe = oldExec, oldCurrent, oldProbe })
			coreHandOverCurrent = func() (string, error) { return target.Artifact.SHA256, nil }
			coreHandOverExec = func(path string, argv, _ []string) error {
				execs = append(execs, argv)
				// The stub returns, as a failed exec does: the coordinator carries on, which lets the test see the
				// request finish either way.
				return fmt.Errorf("fixture: no exec in a test")
			}
			probes := 0
			coreHandOverProbe = func(ctx context.Context, executable, request string, env []string) ([]byte, error) {
				probes++
				// The stub answers from the journal as it is on disk at the hand-over.
				current, err := m.Read()
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(answerFile, test.answer(current), 0o600); err != nil {
					t.Fatal(err)
				}
				return runCoreHandOverProbe(ctx, timeout, stub, []string{"update", "core", "status", "--can-resume", "--request", request}, append(env, "ANSWER="+answerFile))
			}
			finished := 0
			done, err := runCoreContinuation(context.Background(), coreContinuation{
				manager:  m,
				finished: func(context.Context, systemupdate.CoreJournal) error { finished++; return nil },
				handOver: coreHandOverToSelectedSpine,
			}, j.RequestID, true, false, false)
			if err != nil || done.Phase != "committed" || finished != 1 || probes != 1 {
				t.Fatalf("phase=%s finished=%d probes=%d err=%v", done.Phase, finished, probes, err)
			}
			for _, step := range []string{"verify-members", "checkpoint", "apply-spine", "apply-cp", "apply-ui", "authenticated-health"} {
				if executor.started(step) != 1 {
					t.Fatalf("%s started %d times", step, executor.started(step))
				}
			}
			want := [][]string(nil)
			if test.handed {
				want = [][]string{{coreBakedExecutable, "update", "core", "resume", "--request", j.RequestID}}
			}
			if !reflect.DeepEqual(execs, want) {
				t.Fatalf("exec calls %v, want %v", execs, want)
			}
		})
	}
}

func runCoreStatus(t *testing.T, args ...string) ([]byte, error) {
	t.Helper()
	command := coreStatusCommand()
	command.SilenceUsage, command.SilenceErrors = true, true
	var out bytes.Buffer
	command.SetOut(&out)
	command.SetErr(io.Discard)
	command.SetArgs(args)
	err := command.ExecuteContext(context.Background())
	return out.Bytes(), err
}

// statusFixture points `update core status` at a request that waits at the
// hand-over point and answers the question with the fixture's coordinator
// (the installed runtime needs an appliance).
func statusFixture(t *testing.T) (systemupdate.CoreManager, systemupdate.CoreJournal) {
	t.Helper()
	m, _, j := continuationFixture(t, true)
	j, err := m.Advance(context.Background(), j.RequestID, true)
	if err != nil || j.Phase != "applying" || stepStates(j)["apply-spine"] != "succeeded" || stepStates(j)["apply-cp"] != "pending" {
		t.Fatalf("fixture did not stop after the Spine step: %s %v %v", j.Phase, stepStates(j), err)
	}
	oldRoot, oldCheck := coreStatusRoot, coreResumeCheck
	t.Cleanup(func() { coreStatusRoot, coreResumeCheck = oldRoot, oldCheck })
	coreStatusRoot = m.Root
	coreResumeCheck = func(ctx context.Context, request string) (systemupdate.CoreJournal, error) {
		return m.CheckResume(ctx, request)
	}
	return m, j
}

// Without the new flag the answer is byte for byte what it was: coordinators of
// 0.6.10 and 0.6.11-dev.1 and the Control Panel read it.
func TestCoreStatusWithoutFlagsAnswersAsBefore(t *testing.T) {
	m, j := statusFixture(t)
	coreResumeCheck = func(context.Context, string) (systemupdate.CoreJournal, error) {
		t.Error("a plain status asked whether the request can be resumed")
		return systemupdate.CoreJournal{}, fmt.Errorf("unexpected")
	}
	receipt, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	var want bytes.Buffer
	if err := json.NewEncoder(&want).Encode(map[string]any{"installed": receipt, "transaction": j}); err != nil {
		t.Fatal(err)
	}
	before := treeSnapshot(t, m.Root)
	got, err := runCoreStatus(t)
	if err != nil || !bytes.Equal(got, want.Bytes()) {
		t.Fatalf("plain status changed: %v\n got %s\nwant %s", err, got, want.Bytes())
	}
	if after := treeSnapshot(t, m.Root); !reflect.DeepEqual(before, after) {
		t.Fatal("a plain status changed the core-update directory")
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(got, &keys); err != nil || len(keys) != 2 {
		t.Fatalf("plain status has other fields: %v %v", keys, err)
	}
	// No request retained: the installed release alone, as before.
	if err := os.Remove(filepath.Join(m.Root, "journal.json")); err != nil {
		t.Fatal(err)
	}
	want.Reset()
	if err := json.NewEncoder(&want).Encode(map[string]any{"installed": receipt}); err != nil {
		t.Fatal(err)
	}
	if got, err := runCoreStatus(t); err != nil || !bytes.Equal(got, want.Bytes()) {
		t.Fatalf("plain status without a request changed: %v %s", err, got)
	}
	if err := os.Remove(filepath.Join(m.Root, "committed.json")); err != nil {
		t.Fatal(err)
	}
	if got, err := runCoreStatus(t); err == nil || len(got) != 0 {
		t.Fatalf("status without an installed release: %v %s", err, got)
	}
}

type canResumeStatus struct {
	CanResume   *bool                     `json:"can_resume"`
	Request     string                    `json:"can_resume_request"`
	Reason      string                    `json:"can_resume_reason"`
	Installed   json.RawMessage           `json:"installed"`
	Transaction *systemupdate.CoreJournal `json:"transaction"`
}

func parseCanResume(t *testing.T, raw []byte) canResumeStatus {
	t.Helper()
	var status canResumeStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatalf("answer is not one JSON document: %v\n%s", err, raw)
	}
	if status.CanResume == nil || len(status.Installed) == 0 {
		t.Fatalf("answer lacks can_resume or installed: %s", raw)
	}
	return status
}

// The new Spine's side: yes for the request that waits between two steps, by
// exit status and in the answer; and that answer is the one the coordinator
// accepts.
func TestCoreStatusCanResumeAnswersYesForTheWaitingRequest(t *testing.T) {
	m, j := statusFixture(t)
	before := treeSnapshot(t, m.Root)
	raw, err := runCoreStatus(t, "--can-resume", "--request", j.RequestID)
	if err != nil {
		t.Fatalf("the waiting request cannot be resumed: %v\n%s", err, raw)
	}
	status := parseCanResume(t, raw)
	if !*status.CanResume || status.Request != j.RequestID || status.Reason != "" || status.Transaction == nil || !reflect.DeepEqual(*status.Transaction, j) {
		t.Fatalf("answer: %s", raw)
	}
	if after := treeSnapshot(t, m.Root); !reflect.DeepEqual(before, after) {
		t.Fatalf("the question changed the core-update directory:\nbefore %v\nafter  %v", before, after)
	}
	// The coordinator of the installed Spine reads exactly this answer.
	target, _ := j.Target.Member("spine")
	calls := stubHandOver(t, target.Artifact.SHA256, func() ([]byte, error) { return raw, nil }, nil)
	if err := coreHandOverToSelectedSpine(context.Background(), j); err == nil || len(calls.execs) != 1 {
		t.Fatalf("the coordinator did not accept the new Spine's own answer: %v %v", err, calls.execs)
	}
}

// Every "no": a non-zero exit, can_resume false with a reason, nothing written,
// and a coordinator that reads the answer anyway does not hand over.
func TestCoreStatusCanResumeAnswersNoAndChangesNothing(t *testing.T) {
	refuse := func(reason string) func(context.Context, string) (systemupdate.CoreJournal, error) {
		return func(context.Context, string) (systemupdate.CoreJournal, error) {
			return systemupdate.CoreJournal{}, fmt.Errorf("%s", reason)
		}
	}
	cases := map[string]struct {
		request string
		arrange func(t *testing.T, m systemupdate.CoreManager)
		reason  string
	}{
		"another request": {request: "another-request", reason: "exact core update request ID required"},
		"the runtime cannot be built": {request: "update-1", reason: "core runtime requires the installed appliance service contract",
			arrange: func(*testing.T, systemupdate.CoreManager) {
				coreResumeCheck = refuse("core runtime requires the installed appliance service contract")
			}},
		"a long refusal is cut": {request: "update-1", reason: strings.Repeat("x", 300),
			arrange: func(*testing.T, systemupdate.CoreManager) { coreResumeCheck = refuse(strings.Repeat("x", 5000)) }},
		"no request is retained": {request: "update-1", reason: "no such file",
			arrange: func(t *testing.T, m systemupdate.CoreManager) {
				if err := os.Remove(filepath.Join(m.Root, "journal.json")); err != nil {
					t.Fatal(err)
				}
			}},
		// The command as it runs on a machine that is not an installed appliance (this one), or not as root.
		"this machine's own runtime": {request: "update-1", arrange: func(*testing.T, systemupdate.CoreManager) {
			coreResumeCheck = func(ctx context.Context, request string) (systemupdate.CoreJournal, error) {
				runtime, err := installedCoreRuntime()
				if err != nil {
					return systemupdate.CoreJournal{}, err
				}
				return coreContinuationManager(runtime).CheckResume(ctx, request)
			}
		}},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			m, j := statusFixture(t)
			if test.arrange != nil {
				test.arrange(t, m)
			}
			before := treeSnapshot(t, m.Root)
			raw, err := runCoreStatus(t, "--can-resume", "--request", test.request)
			if err == nil {
				t.Fatalf("exit status 0 for a request that cannot be resumed: %s", raw)
			}
			status := parseCanResume(t, raw)
			if *status.CanResume || status.Request != test.request || status.Reason == "" || !strings.Contains(status.Reason, test.reason) || len(status.Reason) > 300 {
				t.Fatalf("answer: can_resume=%v request=%q reason=%q", *status.CanResume, status.Request, status.Reason)
			}
			if after := treeSnapshot(t, m.Root); !reflect.DeepEqual(before, after) {
				t.Fatalf("the question changed the core-update directory:\nbefore %v\nafter  %v", before, after)
			}
			target, _ := j.Target.Member("spine")
			calls := stubHandOver(t, target.Artifact.SHA256, func() ([]byte, error) { return raw, nil }, nil)
			if err := coreHandOverToSelectedSpine(context.Background(), j); err == nil || len(calls.execs) != 0 {
				t.Fatalf("a coordinator handed over on this answer: %v %v", err, calls.execs)
			}
		})
	}
}

func TestCoreStatusFlagsAreStrict(t *testing.T) {
	m, j := statusFixture(t)
	before := treeSnapshot(t, m.Root)
	for name, args := range map[string][]string{
		"the question without a request": {"--can-resume"},
		"a request without the question": {"--request", j.RequestID},
		"an unknown flag":                {"--can-resume", "--request", j.RequestID, "--force"},
		"an argument":                    {"--can-resume", "--request", j.RequestID, "now"},
	} {
		if raw, err := runCoreStatus(t, args...); err == nil || len(raw) != 0 {
			t.Fatalf("%s: %v %s", name, err, raw)
		}
	}
	if after := treeSnapshot(t, m.Root); !reflect.DeepEqual(before, after) {
		t.Fatal("a refused status command changed the core-update directory")
	}
	// A Spine from before the question has the command without the flag: asked the question, it fails to parse
	// it and prints no answer, which is what makes every earlier release refuse the hand-over.
	earlier := &cobra.Command{Use: "status", Args: cobra.NoArgs, SilenceUsage: true, SilenceErrors: true, RunE: func(cmd *cobra.Command, _ []string) error {
		return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"transaction": j})
	}}
	var out bytes.Buffer
	earlier.SetOut(&out)
	earlier.SetErr(io.Discard)
	earlier.SetArgs([]string{"--can-resume", "--request", j.RequestID})
	if err := earlier.Execute(); err == nil || !strings.Contains(err.Error(), "unknown flag") || out.Len() != 0 {
		t.Fatalf("a command without the flag answered the question: %v %s", err, out.Bytes())
	}
}
