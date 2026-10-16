package systemupdate

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func TestCoreRecoveryObservesMissingApplyEvidenceWithoutForwardPolicy(t *testing.T) {
	for _, phase := range []string{"needs-recovery", "recovering"} {
		for _, action := range []string{"apply-cp", "apply-ui", "authenticated-health"} {
			t.Run(phase+"/"+action, func(t *testing.T) {
				m, _, target := coreJournalFixture(t)
				j := prepareCoreFixture(t, m, target)
				j.Phase = phase
				var step CoreStep
				for _, candidate := range j.Steps {
					if candidate.Name == action {
						step = candidate
						step.State = "started"
					}
				}
				if step.Name == "" {
					t.Fatal("fixture lacks apply action")
				}
				data := t.TempDir()
				host := newManagerFixture(t).manager
				host.config.CoreStatePath = m.Root
				checkpoint := NativeCoreCheckpoint{Root: m.Root, DataRoot: data, StatePath: host.config.StatePath}
				cache := CoreArtifactCache{Root: filepath.Join(data, "cache")}
				previousChecks := 0
				denyPrevious := false
				r := NativeCoreRuntime{
					Root: m.Root, Host: host, Checkpoint: checkpoint, Cache: cache,
					Services: NativeCoreServices{Checkpoint: checkpoint, Cache: cache},
					Runner:   CoreSystemdRunner{Root: m.Root, Executable: "/usr/local/bin/youeye"},
					AuthorizeTarget: func(context.Context, CoreJournal, bool) error {
						t.Fatal("recovery depended on the current forward selection")
						return nil
					},
					AuthorizePrevious: func(context.Context, CoreJournal) error {
						previousChecks++
						if denyPrevious {
							return fmt.Errorf("previous authority revoked")
						}
						return nil
					},
					HostHealth:          func(context.Context, CoreJournal) (string, error) { return "unused", nil },
					AuthenticatedHealth: func(context.Context, CoreJournal, bool) (string, error) { return "unused", nil },
					RecoverHost: func(context.Context, CoreJournal, bool) (CoreActionObservation, error) {
						t.Fatal("observation executed recovery")
						return CoreActionObservation{}, nil
					},
				}
				got, err := r.Observe(context.Background(), j, step)
				if err != nil || got.State != "unknown" || previousChecks != 1 {
					t.Fatalf("missing evidence blocked fencing or implied success: %+v %v checks=%d", got, err, previousChecks)
				}
				denyPrevious = true
				if _, err := r.Observe(context.Background(), j, step); err == nil || !strings.Contains(err.Error(), "revoked") {
					t.Fatalf("previous authority was bypassed: %v", err)
				}
			})
		}
	}
}

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
