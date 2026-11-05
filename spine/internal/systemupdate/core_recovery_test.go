package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type recoveryTestExecutor struct {
	*coreTestExecutor
	denyRecovery bool
}

type ownedLiveRecoveryTestExecutor struct {
	*recoveryTestExecutor
	owned bool
}

type recoveryIntentTestExecutor struct {
	*recoveryTestExecutor
	root         string
	observations int
}

func (e *recoveryIntentTestExecutor) Observe(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	e.observations++
	if j.Phase == "applying" {
		return CoreActionObservation{}, fmt.Errorf("forward schema probe cannot reconcile an interrupted service stage")
	}
	stored, err := (CoreManager{Root: e.root}).Read()
	if err != nil || stored.Phase != j.Phase {
		return CoreActionObservation{}, fmt.Errorf("recovery intent was not durable before observation")
	}
	return e.recoveryTestExecutor.Observe(ctx, j, s)
}

func TestCoreRecoveryRecordsIntentBeforeObservingInterruptedApply(t *testing.T) {
	m, e, j := failedCoreFixture(t)
	before, err := m.Read()
	if err != nil || before.Phase != "applying" {
		t.Fatal("fixture must retain the interrupted apply phase", before.Phase, err)
	}
	observer := &recoveryIntentTestExecutor{recoveryTestExecutor: e, root: m.Root}
	m.Executor = observer
	got, err := m.Recover(context.Background(), j.RequestID)
	if err != nil || got.Phase != "rolled-back" || observer.observations == 0 {
		t.Fatal(got.Phase, err, observer.observations)
	}
	if e.starts["apply-cp"] != 1 || e.starts["recovery-fence"] != 1 || e.starts["recovery-paired-restore"] != 1 {
		t.Fatal("replayed apply or recovery", e.starts)
	}
}

func TestCoreRecoveryIntentPreservesAdmissionGuards(t *testing.T) {
	for _, blocked := range []string{"previous-authority", "no-checkpoint"} {
		t.Run(blocked, func(t *testing.T) {
			m, e, j := failedCoreFixture(t)
			if blocked == "previous-authority" {
				e.denyRecovery = true
			} else {
				j.Phase = "prepared"
				for i := range j.Steps {
					j.Steps[i].State, j.Steps[i].Evidence = "pending", ""
				}
				if err := m.saveCore(&j); err != nil {
					t.Fatal(err)
				}
			}
			before, err := m.Read()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := m.Recover(context.Background(), j.RequestID); err == nil {
				t.Fatal("admitted blocked recovery")
			}
			after, err := m.Read()
			if err != nil || !reflect.DeepEqual(before, after) || e.starts["recovery-fence"] != 0 {
				t.Fatal("blocked recovery changed durable state or started effects", err)
			}
		})
	}
}

func (e *ownedLiveRecoveryTestExecutor) AuthorizeLiveFence(context.Context, CoreJournal, CoreStep) error {
	if !e.owned {
		return fmt.Errorf("live action ownership unverified")
	}
	return nil
}

func TestCoreRecoveryLiveActionRequiresExplicitNativeOwnershipBeforeFence(t *testing.T) {
	m, e, j := failedCoreFixture(t)
	e.results[j.RequestID+"/apply-cp"] = CoreActionObservation{State: "running"}
	owned := &ownedLiveRecoveryTestExecutor{recoveryTestExecutor: e}
	m.Executor = owned
	if _, err := m.Recover(context.Background(), j.RequestID); err == nil || e.starts["recovery-fence"] != 0 {
		t.Fatal("admitted unowned live action")
	}
	owned.owned = true
	got, err := m.Recover(context.Background(), j.RequestID)
	if err != nil || got.Phase != "rolled-back" || e.starts["recovery-fence"] != 1 || e.starts["recovery-paired-restore"] != 1 {
		t.Fatal(got.Phase, err, e.starts)
	}
}

func TestCoreRecoveryDoesNotRewindAfterHostCommitBeforeSharedReceipt(t *testing.T) {
	m, e, j := failedCoreFixture(t)
	j.RestartRequired, j.ActivationRequested = true, true
	j.Steps = nil
	for _, name := range coreStepNames(true) {
		j.Steps = append(j.Steps, CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "succeeded", Evidence: "durable native completion"})
	}
	j.Phase = "applying"
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Recover(context.Background(), j.RequestID); err == nil || e.starts["recovery-fence"] != 0 {
		t.Fatal("rewound already committed host")
	}
}

func (e *recoveryTestExecutor) AuthorizeRecovery(context.Context, CoreJournal) error {
	if e.denyRecovery {
		return fmt.Errorf("previous release no longer permitted")
	}
	return nil
}

func failedCoreFixture(t *testing.T) (CoreManager, *recoveryTestExecutor, CoreJournal) {
	t.Helper()
	m, apply, target := coreJournalFixture(t)
	e := &recoveryTestExecutor{coreTestExecutor: apply}
	m.Executor = e
	j := prepareCoreFixture(t, m, target)
	e.lose = "apply-cp"
	if _, err := m.Advance(context.Background(), j.RequestID, false); err == nil {
		t.Fatal("expected lost apply acknowledgement")
	}
	delete(e.results, j.RequestID+"/apply-cp")
	return m, e, j
}

func TestPairedCoreRecoveryReconcilesLostAcknowledgementWithoutReplay(t *testing.T) {
	m, e, j := failedCoreFixture(t)
	e.lose = "recovery-paired-restore"
	if _, err := m.Recover(context.Background(), j.RequestID); err == nil {
		t.Fatal("expected lost restore acknowledgement")
	}
	if _, err := m.Advance(context.Background(), j.RequestID, false); err == nil {
		t.Fatal("original migrations resumed during recovery")
	}
	got, err := m.Recover(context.Background(), j.RequestID)
	if err != nil || got.Phase != "rolled-back" {
		t.Fatal(got.Phase, err)
	}
	if e.starts["apply-cp"] != 1 || e.starts["recovery-paired-restore"] != 1 || e.starts["recovery-health"] != 1 {
		t.Fatal(e.starts)
	}
	receipt, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(receipt, j.Previous) {
		t.Fatal("rollback changed previous receipt", err)
	}
	if _, err := m.Recover(context.Background(), j.RequestID); err != nil {
		t.Fatal(err)
	}
	if e.starts["recovery-paired-restore"] != 1 {
		t.Fatal("replayed acknowledged rollback")
	}
}

func TestCoreRecoveryCannotRaceLiveApplyOrSkipUnknownRestore(t *testing.T) {
	m, e, j := failedCoreFixture(t)
	e.results[j.RequestID+"/apply-cp"] = CoreActionObservation{State: "running"}
	if _, err := m.Recover(context.Background(), j.RequestID); err == nil {
		t.Fatal("recovery raced live migration")
	}
	delete(e.results, j.RequestID+"/apply-cp")
	e.lose = "recovery-paired-restore"
	_, _ = m.Recover(context.Background(), j.RequestID)
	delete(e.results, j.RequestID+"/recovery-paired-restore")
	got, err := m.Recover(context.Background(), j.RequestID)
	if err != nil || got.Phase != "recovering" || e.starts["recovery-paired-restore"] != 1 || e.starts["recovery-health"] != 0 {
		t.Fatal(got.Phase, e.starts, err)
	}
}

func TestCoreRecoveryRequiresCurrentPreviousAuthorityAndExactUncommittedReceipt(t *testing.T) {
	m, e, j := failedCoreFixture(t)
	e.denyRecovery = true
	if _, err := m.Recover(context.Background(), j.RequestID); err == nil || e.starts["recovery-fence"] != 0 {
		t.Fatal("bypassed recovery authorization")
	}
	e.denyRecovery = false
	// A persisted commit with a lost journal acknowledgement cannot roll back.
	r := j.Previous
	r.ManifestSHA256, r.Release = j.ManifestSHA256, j.Target
	raw, _ := json.Marshal(r)
	if err := atomicWrite(filepath.Join(m.Root, "committed.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Recover(context.Background(), j.RequestID); err == nil || e.starts["recovery-fence"] != 0 {
		t.Fatal("rolled back a durable commit")
	}
}

func TestCoreRecoveryReleasesOnlyVerifiedExactLifecycleHold(t *testing.T) {
	m, _, j := failedCoreFixture(t)
	b := CoreLifecycleBarrier{Root: t.TempDir()}
	if err := os.Chmod(b.Root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := b.Begin(j); err != nil {
		t.Fatal(err)
	}
	if err := b.ReleaseRecovered(m, j.RequestID); err == nil {
		t.Fatal("released incomplete rollback")
	}
	if _, err := m.Recover(context.Background(), j.RequestID); err != nil {
		t.Fatal(err)
	}
	if err := b.ReleaseCommitted(m, j.RequestID); err == nil {
		t.Fatal("rollback was claimed as commitment")
	}
	if err := b.ReleaseRecovered(m, "wrong"); err == nil {
		t.Fatal("wrong request released hold")
	}
	if err := b.ReleaseRecovered(m, j.RequestID); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Read(); !os.IsNotExist(err) {
		t.Fatal("recovered hold remains", err)
	}
}
