package systemupdate

import (
	"context"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func TestCoreRuntimeCannotAdmitWorkWithoutPolicyHealthAndRecovery(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	r := NativeCoreRuntime{Root: m.Root}
	e := r.Executor()
	if err := e.Authorize(context.Background(), j, false); err == nil {
		t.Fatal("unconfigured lifecycle admitted target")
	}
	if err := e.AuthorizeRecovery(context.Background(), j); err == nil {
		t.Fatal("unconfigured recovery admitted restore")
	}
	if _, err := r.RunAction(context.Background(), j.RequestID, "verify-members", j.ManifestSHA256); err == nil {
		t.Fatal("unconfigured hidden command executed")
	}
}

func TestCoreRuntimeRecoversUnappliedCheckpointWithoutRestoringDatabases(t *testing.T) {
	p, j := abortedCheckpointFixture(t)
	r := NativeCoreRuntime{Root: p.Root, Checkpoint: p}
	got, err := r.execute(context.Background(), j, j.RecoverySteps[1])
	if err != nil || got.State != "succeeded" || !strings.Contains(got.Evidence, "current data preserved") {
		t.Fatal(got, err)
	}
	record, err := p.Read(j)
	if err != nil || record.Phase != "aborted-unapplied" {
		t.Fatal(record.Phase, err)
	}
}

func TestCoreNativeRecoverySeesHostCommitDespiteLostCoordinatorAcknowledgement(t *testing.T) {
	f := newManagerFixture(t)
	if _, err := f.manager.Stage(context.Background(), SourceOptions{ManifestSource: f.manifestPath, SignatureSource: f.signaturePath}); err != nil {
		t.Fatal(err)
	}
	host, err := loadJournal(f.manager.config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("a", 64)
	host.CoreManifestSHA256, host.Phase = digest, PhaseHealthy
	if err = writeJournal(f.manager.config.JournalPath, host); err != nil {
		t.Fatal(err)
	}
	r := NativeCoreRuntime{Host: f.manager, AuthorizePrevious: func(context.Context, CoreJournal) error { return nil }}
	if err = r.authorizeRecovery(context.Background(), CoreJournal{ManifestSHA256: digest, RestartRequired: true}); err == nil {
		t.Fatal("ignored actual durable host commitment")
	}
	if err = r.authorizeRecovery(context.Background(), CoreJournal{ManifestSHA256: strings.Repeat("b", 64), RestartRequired: true}); err != nil {
		t.Fatal("prior unrelated healthy host blocked recovery", err)
	}
	host.Phase = PhasePending
	if err = writeJournal(f.manager.config.JournalPath, host); err != nil {
		t.Fatal(err)
	}
	f.bootTarget(t)
	if _, err = appliance.CommitHealthySlot(f.manager.config.StatePath, testApplianceManifest("0.6.0-dev.27", targetCommit), "root=PARTLABEL=YE-SYSTEM-B ro"); err != nil {
		t.Fatal(err)
	}
	if err = r.authorizeRecovery(context.Background(), CoreJournal{ManifestSHA256: digest, RestartRequired: true}); err == nil {
		t.Fatal("lost host journal acknowledgement allowed data rewind after durable promotion")
	}
}
