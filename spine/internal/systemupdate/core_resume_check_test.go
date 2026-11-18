package systemupdate

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// coreTreeSnapshot records every entry under root: type, mode, size, change
// time and content. Equal snapshots: nothing was created, written, touched or
// removed.
func coreTreeSnapshot(t *testing.T, root string) map[string]string {
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

// countingExecutor counts what a check may and may not call.
type countingExecutor struct {
	*coreTestExecutor
	authorized []bool
	observed   int
	deny       error
}

func (e *countingExecutor) Authorize(_ context.Context, _ CoreJournal, activation bool) error {
	e.authorized = append(e.authorized, activation)
	return e.deny
}

func (e *countingExecutor) Observe(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	e.observed++
	return e.coreTestExecutor.Observe(ctx, j, s)
}

// resumeCheckFixture: a service update that changes the Spine, stopped where
// the coordinator hands over (apply-spine succeeded, nothing after it started).
func resumeCheckFixture(t *testing.T) (CoreManager, *countingExecutor, CoreJournal) {
	t.Helper()
	m, e, target := coreJournalFixture(t)
	before := prepareCoreFixture(t, m, spineChangingTarget(target))
	m.YieldAfterSpine = true
	j, err := m.Advance(context.Background(), before.RequestID, false)
	if err != nil || j.Phase != "applying" || !CoreSpineJustApplied(before, j) {
		t.Fatalf("fixture did not stop after the Spine step: %s %v %v", j.Phase, journalStepStates(j), err)
	}
	counting := &countingExecutor{coreTestExecutor: e}
	m.Executor = counting
	return m, counting, j
}

func startsOf(e *coreTestExecutor) map[string]int {
	out := map[string]int{}
	for name, count := range e.starts {
		out[name] = count
	}
	return out
}

// At the hand-over point the check says yes after authorising the request as
// Advance does, and it has no effect: nothing in the state directory changes
// (not even the lock file is created), no action is observed or started, and
// the core lock is not taken.
func TestCoreCheckResumeSaysYesBetweenStepsAndChangesNothing(t *testing.T) {
	m, e, j := resumeCheckFixture(t)
	if err := os.Remove(filepath.Join(m.Root, "lock")); err != nil {
		t.Fatal(err)
	}
	before, starts := coreTreeSnapshot(t, m.Root), startsOf(e.coreTestExecutor)
	judged, err := m.CheckResume(context.Background(), j.RequestID)
	if err != nil || !reflect.DeepEqual(judged, j) {
		t.Fatalf("check at the hand-over point: %v", err)
	}
	if !reflect.DeepEqual(e.authorized, []bool{false}) || e.observed != 0 || !reflect.DeepEqual(startsOf(e.coreTestExecutor), starts) {
		t.Fatalf("check called authorize=%v observe=%d starts=%v", e.authorized, e.observed, e.starts)
	}
	if after := coreTreeSnapshot(t, m.Root); !reflect.DeepEqual(before, after) {
		t.Fatalf("the check changed the state directory:\nbefore %v\nafter  %v", before, after)
	}
	// A coordinator that holds the core lock at that moment is not disturbed, and does not make the check fail.
	unlock, err := m.lockCoreRaw()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.CheckResume(context.Background(), j.RequestID); err != nil {
		t.Fatalf("the check needs the core lock: %v", err)
	}
	unlock()
	// What it promised happens: the continuation finishes the request, each step once.
	done, err := m.Advance(context.Background(), j.RequestID, false)
	if err != nil || done.Phase != "committed" {
		t.Fatalf("continuation after a yes: %s %v", done.Phase, err)
	}
	for _, name := range []string{"verify-members", "checkpoint", "apply-spine", "apply-cp", "apply-ui", "authenticated-health"} {
		if e.starts[name] != 1 {
			t.Fatalf("%s started %d times", name, e.starts[name])
		}
	}
}

// Every refusal, and none of them writes. Where Advance refuses for the same
// reason, the check does not answer yes.
func TestCoreCheckResumeRefusesAndChangesNothing(t *testing.T) {
	edit := func(change func(*CoreJournal)) func(*testing.T, *CoreManager, *countingExecutor, CoreJournal) {
		return func(t *testing.T, m *CoreManager, _ *countingExecutor, j CoreJournal) {
			j.Steps = append([]CoreStep(nil), j.Steps...)
			change(&j)
			if err := m.saveCore(&j); err != nil {
				t.Fatal(err)
			}
		}
	}
	cases := map[string]struct {
		request string
		arrange func(*testing.T, *CoreManager, *countingExecutor, CoreJournal)
		reason  string
		// advanceRefuses: Advance must refuse this state too.
		advanceRefuses bool
	}{
		"another request": {request: "another-request", reason: "exact core update request ID required", advanceRefuses: true},
		"the authorisation refuses": {reason: "current hardware differs", advanceRefuses: true,
			arrange: func(_ *testing.T, _ *CoreManager, e *countingExecutor, _ CoreJournal) {
				e.deny = fmt.Errorf("current hardware differs from the core transaction")
			}},
		"an independent copy owns the installation": {reason: "independent copy preparation owns this installation", advanceRefuses: true,
			arrange: func(t *testing.T, m *CoreManager, _ *countingExecutor, _ CoreJournal) {
				if err := os.WriteFile(filepath.Join(m.Root, "copy.json"), []byte("{}\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			}},
		"the journal is unreadable": {reason: "invalid", advanceRefuses: true,
			arrange: func(t *testing.T, m *CoreManager, _ *countingExecutor, _ CoreJournal) {
				if err := os.WriteFile(filepath.Join(m.Root, "journal.json"), []byte("{}\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			}},
		"the frozen release is gone": {reason: "unavailable frozen input", advanceRefuses: true,
			arrange: func(t *testing.T, m *CoreManager, _ *countingExecutor, j CoreJournal) {
				if err := os.Remove(filepath.Join(m.Root, "targets", j.ManifestSHA256+".json")); err != nil {
					t.Fatal(err)
				}
			}},
		"no request": {reason: "no such file", advanceRefuses: true,
			arrange: func(t *testing.T, m *CoreManager, _ *countingExecutor, _ CoreJournal) {
				if err := os.Remove(filepath.Join(m.Root, "journal.json")); err != nil {
					t.Fatal(err)
				}
			}},
		"a step is started": {reason: "apply-cp is started",
			arrange: edit(func(j *CoreJournal) { j.Steps[3].State = "started" })},
		"a step has failed": {reason: "apply-cp is failed",
			arrange: edit(func(j *CoreJournal) { j.Steps[3].State = "failed" })},
		"the request needs recovery": {reason: "needs-recovery",
			arrange: edit(func(j *CoreJournal) { j.Steps[3].State, j.Phase = "failed", "needs-recovery" })},
		"the request is being cancelled": {reason: "cancelling", advanceRefuses: true,
			arrange: edit(func(j *CoreJournal) { j.Phase = "cancelling" })},
		"the request has ended": {reason: "cancelled",
			arrange: edit(func(j *CoreJournal) { j.Phase = "cancelled" })},
		"the coordinator has no executor": {reason: "native lifecycle executor required", advanceRefuses: true,
			arrange: func(_ *testing.T, m *CoreManager, _ *countingExecutor, _ CoreJournal) { m.Executor = nil }},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			m, e, j := resumeCheckFixture(t)
			if test.arrange != nil {
				test.arrange(t, &m, e, j)
			}
			request := test.request
			if request == "" {
				request = j.RequestID
			}
			before, starts := coreTreeSnapshot(t, m.Root), startsOf(e.coreTestExecutor)
			_, err := m.CheckResume(context.Background(), request)
			if err == nil || !strings.Contains(err.Error(), test.reason) {
				t.Fatalf("check answered %v, want a refusal with %q", err, test.reason)
			}
			if e.observed != 0 || !reflect.DeepEqual(startsOf(e.coreTestExecutor), starts) {
				t.Fatalf("a refusing check observed %d and started %v", e.observed, e.starts)
			}
			if after := coreTreeSnapshot(t, m.Root); !reflect.DeepEqual(before, after) {
				t.Fatalf("a refusing check changed the state directory:\nbefore %v\nafter  %v", before, after)
			}
			if test.advanceRefuses {
				if done, err := m.Advance(context.Background(), request, false); err == nil {
					t.Fatalf("Advance accepts what the check refuses for the same reason: %s", done.Phase)
				}
			}
		})
	}
	// A request that was only prepared, and one that is finished.
	m, _, target := coreJournalFixture(t)
	prepared := prepareCoreFixture(t, m, spineChangingTarget(target))
	if _, err := m.CheckResume(context.Background(), prepared.RequestID); err == nil || !strings.Contains(err.Error(), "prepared") {
		t.Fatalf("a prepared request: %v", err)
	}
	done, err := m.Advance(context.Background(), prepared.RequestID, false)
	if err != nil || done.Phase != "committed" {
		t.Fatal(done.Phase, err)
	}
	if _, err := m.CheckResume(context.Background(), prepared.RequestID); err == nil || !strings.Contains(err.Error(), "committed") {
		t.Fatalf("a committed request: %v", err)
	}
	if _, err := (CoreManager{Root: "relative", Executor: m.Executor}).CheckResume(context.Background(), prepared.RequestID); err == nil {
		t.Fatal("a relative state directory was read")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	m, e, j := resumeCheckFixture(t)
	if _, err := m.CheckResume(cancelled, j.RequestID); err == nil || len(e.authorized) != 0 {
		t.Fatalf("a cancelled check went on to authorise: %v %v", err, e.authorized)
	}
}
