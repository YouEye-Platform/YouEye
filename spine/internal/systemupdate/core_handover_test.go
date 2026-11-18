package systemupdate

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func spineChangingTarget(target releasecache.CoreRelease) releasecache.CoreRelease {
	for i := range target.Members {
		if target.Members[i].Role == "spine" {
			target.Members[i].Artifact.SHA256 = strings.Repeat("f", 64)
		}
	}
	return target
}

func journalStepStates(j CoreJournal) []string {
	var states []string
	for _, s := range j.Steps {
		states = append(states, s.Name+"="+s.State)
	}
	return states
}

// With YieldAfterSpine, Advance stops once, right after the Spine step, with nothing after it started. The step
// list and the journal are the ordinary ones: any coordinator continues from there.
func TestCoreAdvanceYieldsOnceAfterTheSpineStep(t *testing.T) {
	m, e, target := coreJournalFixture(t)
	before := prepareCoreFixture(t, m, spineChangingTarget(target))
	m.YieldAfterSpine = true
	after, err := m.Advance(context.Background(), before.RequestID, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"verify-members=succeeded", "checkpoint=succeeded", "apply-spine=succeeded", "apply-cp=pending", "apply-ui=pending", "authenticated-health=pending"}
	if after.Phase != "applying" || after.Error != "" || !reflect.DeepEqual(journalStepStates(after), want) || e.starts["apply-cp"] != 0 {
		t.Fatalf("yield after the Spine step: %s %q %v %v", after.Phase, after.Error, journalStepStates(after), e.starts)
	}
	if err := validateCoreSteps(after); err != nil {
		t.Fatalf("the journal at the yield is not an ordinary journal: %v", err)
	}
	stored, err := m.Read()
	if err != nil || !reflect.DeepEqual(journalStepStates(stored), want) {
		t.Fatalf("the yield is not durable: %v %v", journalStepStates(stored), err)
	}
	if !CoreSpineJustApplied(before, after) {
		t.Fatal("the pass that applied the Spine is not recognised")
	}
	// A coordinator that finds the step already done (a resumed request, or the new Spine after the hand-over)
	// does not stop there again, with or without the option.
	for _, yield := range []bool{true, false} {
		t.Run(map[bool]string{true: "new coordinator", false: "coordinator without the option"}[yield], func(t *testing.T) {
			m, e, target := coreJournalFixture(t)
			j := prepareCoreFixture(t, m, spineChangingTarget(target))
			m.YieldAfterSpine = true
			paused, err := m.Advance(context.Background(), j.RequestID, false)
			if err != nil || paused.Phase != "applying" {
				t.Fatal(paused.Phase, err)
			}
			// Another process: it knows only what is durable (the journal and the actions' receipts).
			next := CoreManager{Root: m.Root, Executor: e, YieldAfterSpine: yield}
			read, err := next.Read()
			if err != nil {
				t.Fatal(err)
			}
			done, err := next.Advance(context.Background(), j.RequestID, false)
			if err != nil || done.Phase != "committed" {
				t.Fatalf("continuation after the yield: %s %v", done.Phase, err)
			}
			if CoreSpineJustApplied(read, done) {
				t.Fatal("a coordinator that did not apply the Spine would hand over again")
			}
			for _, name := range []string{"verify-members", "checkpoint", "apply-spine", "apply-cp", "apply-ui", "authenticated-health"} {
				if e.starts[name] != 1 {
					t.Fatalf("%s started %d times", name, e.starts[name])
				}
			}
		})
	}
}

// Without the option (every caller but the continuation command) and for a request without a Spine step,
// nothing changes.
func TestCoreAdvanceDoesNotYieldOtherwise(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, spineChangingTarget(target))
	done, err := m.Advance(context.Background(), j.RequestID, false)
	if err != nil || done.Phase != "committed" {
		t.Fatalf("Spine change without the option: %s %v", done.Phase, err)
	}
	if CoreSpineJustApplied(j, done) {
		t.Fatal("a committed request is not a hand-over point")
	}

	m, _, target = coreJournalFixture(t)
	j = prepareCoreFixture(t, m, target) // Control Panel only
	m.YieldAfterSpine = true
	done, err = m.Advance(context.Background(), j.RequestID, false)
	if err != nil || done.Phase != "committed" || CoreSpineJustApplied(j, done) {
		t.Fatalf("request without a Spine step: %s %v", done.Phase, err)
	}
}

func TestCoreSpineJustAppliedNeedsTheExactPoint(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	before := prepareCoreFixture(t, m, spineChangingTarget(target))
	m.YieldAfterSpine = true
	after, err := m.Advance(context.Background(), before.RequestID, false)
	if err != nil {
		t.Fatal(err)
	}
	change := func(edit func(*CoreJournal)) CoreJournal {
		j := after
		j.Steps = append([]CoreStep(nil), after.Steps...)
		edit(&j)
		return j
	}
	for name, j := range map[string]CoreJournal{
		"a later step started": change(func(j *CoreJournal) { j.Steps[3].State = "started" }),
		"needs recovery":       change(func(j *CoreJournal) { j.Phase = "needs-recovery" }),
		"another request":      change(func(j *CoreJournal) { j.RequestID = "another-request" }),
		"recovery owns it": change(func(j *CoreJournal) {
			j.RecoverySteps = []CoreStep{{Name: "recovery-fence", RequestID: j.RequestID + "/recovery-fence", State: "pending"}}
		}),
		"the Spine step is not done": change(func(j *CoreJournal) { j.Steps[2].State = "started" }),
	} {
		if CoreSpineJustApplied(before, j) {
			t.Fatalf("%s counted as the hand-over point", name)
		}
	}
	if CoreSpineJustApplied(after, after) {
		t.Fatal("a journal that already had the Spine step done counted as the hand-over point")
	}
}
