package systemupdate

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

type coreCancelFixtureExecutor struct {
	*coreTestExecutor
	cancel func(context.Context, CoreJournal) error
}

func (e coreCancelFixtureExecutor) CancelPreparation(ctx context.Context, j CoreJournal) error {
	return e.cancel(ctx, j)
}

func TestCoreUnknownPreparationCancellationCannotResumeAfterLostCleanup(t *testing.T) {
	m, e, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	j.Steps[0].State, j.Phase = "started", "needs-recovery"
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	settled := false
	m.Executor = coreCancelFixtureExecutor{coreTestExecutor: e, cancel: func(_ context.Context, current CoreJournal) error {
		if current.Phase != "cancelling" || current.Steps[0].State != "started" {
			t.Fatal("lost retained intent")
		}
		if !settled {
			return fmt.Errorf("owned descendants still live")
		}
		return nil
	}}
	if _, err := m.Cancel(context.Background(), j.RequestID); err == nil {
		t.Fatal("unsettled work cancelled")
	}
	if _, err := m.Advance(context.Background(), j.RequestID, false); err == nil {
		t.Fatal("cancelled preparation relaunched")
	}
	if _, err := m.RecordAttention(j.RequestID, j.ManifestSHA256, "verify-members"); err != nil {
		t.Fatal(err)
	}
	current, err := m.Read()
	if err != nil || current.Phase != "cancelling" {
		t.Fatal(current.Phase, err)
	}
	settled = true
	current, err = m.Cancel(context.Background(), j.RequestID)
	if err != nil || current.Phase != "cancelled" {
		t.Fatal(current.Phase, err)
	}
}

func TestCoreCancelRequiresSettledStagingAndPreservesCommittedReceipt(t *testing.T) {
	ctx := context.Background()
	m, e, target := coreJournalFixture(t)
	target.Members[2].Artifact.SHA256 = strings.Repeat("e", 64)
	j := prepareCoreFixture(t, m, target)
	before, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	j.Steps[0].State = "started"
	j.Phase = "applying"
	if err = m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Cancel(ctx, j.RequestID); err == nil {
		t.Fatal("cancelled live native verification")
	}
	j.Steps[0].State = "succeeded"
	j.Steps[0].Evidence = "fixture"
	j.Steps[1].State = "succeeded"
	j.Steps[1].Evidence = "fixture"
	j.Phase = "cancelling"
	if err = m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Cancel(ctx, j.RequestID); err == nil {
		t.Fatal("ignored owned host stage")
	}
	calls := 0
	fail := true
	m.Executor = coreCancelFixtureExecutor{coreTestExecutor: e, cancel: func(context.Context, CoreJournal) error {
		calls++
		if fail {
			return fmt.Errorf("native stage cleanup pending")
		}
		return nil
	}}
	if _, err = m.Cancel(ctx, j.RequestID); err == nil {
		t.Fatal("native failure marked cancelled")
	}
	current, _ := m.Read()
	if current.Phase != "cancelling" {
		t.Fatal(current.Phase)
	}
	fail = false
	if current, err = m.Cancel(ctx, j.RequestID); err != nil || current.Phase != "cancelled" {
		t.Fatal(current.Phase, err)
	}
	if _, err = m.Cancel(ctx, j.RequestID); err != nil || calls != 2 {
		t.Fatal("cancel effect repeated", err, calls)
	}
	after, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatal("cancellation changed installed release", err)
	}
}

func TestNativeCoreHostCancellationReconcilesLostJournalWrite(t *testing.T) {
	ctx := context.Background()
	f := newManagerFixture(t)
	if _, err := f.manager.Stage(ctx, f.sourceOptions()); err != nil {
		t.Fatal(err)
	}
	m, _, target := coreJournalFixture(t)
	target.Members[2].Artifact.SHA256 = strings.Repeat("e", 64)
	j := prepareCoreFixture(t, m, target)
	j.Phase = "cancelling"
	for i := range j.Steps {
		if j.Steps[i].Name == "verify-members" || j.Steps[i].Name == "stage-host" {
			j.Steps[i].State = "succeeded"
			j.Steps[i].Evidence = "fixture"
		}
	}
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	f.manager.config.CoreStatePath = m.Root
	host, err := loadJournal(f.manager.config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	host.CoreManifestSHA256 = j.ManifestSHA256
	if err = writeJournal(f.manager.config.JournalPath, host); err != nil {
		t.Fatal(err)
	}
	imageBefore, err := os.ReadFile(f.manager.config.CurrentManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.manager.CancelCoreHost(ctx, j.RequestID); err != nil {
		t.Fatal(err)
	}
	state, err := appliance.LoadState(f.manager.config.StatePath)
	if err != nil || state.Slots.Current != "A" || state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
		t.Fatal(state, err)
	}
	// Restore only the old journal to model a lost final metadata write.
	if err = writeJournal(f.manager.config.JournalPath, host); err != nil {
		t.Fatal(err)
	}
	if err = f.manager.CancelCoreHost(ctx, j.RequestID); err != nil {
		t.Fatal("lost acknowledgement not reconciled", err)
	}
	observed, err := loadJournal(f.manager.config.JournalPath)
	if err != nil || observed.Phase != PhaseRollback || observed.ErrorCode != "core_stage_cancelled" {
		t.Fatal(observed.Phase, err)
	}
	imageAfter, _ := os.ReadFile(f.manager.config.CurrentManifestPath)
	if string(imageAfter) != string(imageBefore) {
		t.Fatal("running image changed")
	}
	j.ActivationRequested = true
	for i := range j.Steps {
		if j.Steps[i].Name == "checkpoint" {
			j.Steps[i].State = "started"
		}
	}
	if err = m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	if err = f.manager.CancelCoreHost(ctx, j.RequestID); err == nil {
		t.Fatal("activated transaction cancelled")
	}
}

func TestNativeCorePartialHostCancellationReconcilesLostJournalWrite(t *testing.T) {
	ctx := context.Background()
	f := newManagerFixture(t)
	if _, err := f.manager.Stage(ctx, f.sourceOptions()); err != nil {
		t.Fatal(err)
	}
	m, _, target := coreJournalFixture(t)
	target.Members[2].Artifact.SHA256 = strings.Repeat("e", 64)
	j := prepareCoreFixture(t, m, target)
	j.Phase = "cancelling"
	for i := range j.Steps {
		if j.Steps[i].Name == "verify-members" || j.Steps[i].Name == "stage-host" {
			j.Steps[i].State = "succeeded"
			j.Steps[i].Evidence = "fixture"
			if j.Steps[i].Name == "stage-host" {
				j.Steps[i].State = "started"
				j.Steps[i].Evidence = ""
			}
		}
	}
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	f.manager.config.CoreStatePath = m.Root
	host, err := loadJournal(f.manager.config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	host.CoreManifestSHA256 = j.ManifestSHA256
	host.Phase = PhaseWriting
	partialState, err := appliance.LoadState(f.manager.config.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	partialState.Transaction.Stage = PhaseWriting
	if err = appliance.WriteStateAtomic(f.manager.config.StatePath, partialState); err != nil {
		t.Fatal(err)
	}
	if err = writeJournal(f.manager.config.JournalPath, host); err != nil {
		t.Fatal(err)
	}
	imageBefore, err := os.ReadFile(f.manager.config.CurrentManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.manager.CancelCoreHost(ctx, j.RequestID); err != nil {
		t.Fatal(err)
	}
	state, err := appliance.LoadState(f.manager.config.StatePath)
	if err != nil || state.Slots.Current != "A" || state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
		t.Fatal(state, err)
	}
	// Restore only the old journal to model a lost final metadata write.
	if err = writeJournal(f.manager.config.JournalPath, host); err != nil {
		t.Fatal(err)
	}
	if err = f.manager.CancelCoreHost(ctx, j.RequestID); err != nil {
		t.Fatal("lost acknowledgement not reconciled", err)
	}
	observed, err := loadJournal(f.manager.config.JournalPath)
	if err != nil || observed.Phase != PhaseRollback || observed.ErrorCode != "core_stage_cancelled" {
		t.Fatal(observed.Phase, err)
	}
	imageAfter, _ := os.ReadFile(f.manager.config.CurrentManifestPath)
	if string(imageAfter) != string(imageBefore) {
		t.Fatal("running image changed")
	}
	j.ActivationRequested = true
	for i := range j.Steps {
		if j.Steps[i].Name == "checkpoint" {
			j.Steps[i].State = "started"
		}
	}
	if err = m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	if err = f.manager.CancelCoreHost(ctx, j.RequestID); err == nil {
		t.Fatal("activated transaction cancelled")
	}
}

func TestCoreCancelActivationIntentBeforeCheckpoint(t *testing.T) {
	for _, checkpoint := range []bool{false, true} {
		t.Run(fmt.Sprint(checkpoint), func(t *testing.T) {
			m, e, target := coreJournalFixture(t)
			target.Members[2].Artifact.SHA256 = strings.Repeat("e", 64)
			j := prepareCoreFixture(t, m, target)
			j.ActivationRequested = true
			j.Phase = "needs-recovery"
			j.Steps[0].State = "succeeded"
			j.Steps[0].Evidence = "verified"
			j.Steps[1].State = "started"
			if checkpoint {
				j.Steps[1].State = "succeeded"
				j.Steps[1].Evidence = "staged"
				j.Steps[2].State = "started"
			}
			if err := m.saveCore(&j); err != nil {
				t.Fatal(err)
			}
			calls := 0
			m.Executor = coreCancelFixtureExecutor{coreTestExecutor: e, cancel: func(_ context.Context, current CoreJournal) error {
				calls++
				if !current.ActivationRequested || current.Phase != "cancelling" {
					t.Fatal("original intent lost")
				}
				return nil
			}}
			got, err := m.Cancel(context.Background(), j.RequestID)
			if checkpoint {
				if err == nil || calls != 0 {
					t.Fatal("checkpoint effects cancelled")
				}
			} else if err != nil || got.Phase != "cancelled" || calls != 1 {
				t.Fatal(got.Phase, err, calls)
			}
		})
	}
}
