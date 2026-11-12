package systemupdate

import (
	"context"
	"encoding/json"
	"io"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func abortedCheckpointFixture(t *testing.T) (NativeCoreCheckpoint, CoreJournal) {
	t.Helper()
	p, j, _, _ := databaseCheckpointFixture(t)
	record, err := p.Read(j)
	if err != nil {
		t.Fatal(err)
	}
	_, record.Inventory.AppInventorySHA256, err = p.installedOwners()
	if err != nil {
		t.Fatal(err)
	}
	if err = p.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	j.Phase = "recovering"
	for _, name := range coreRecoveryNames(j) {
		step := CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"}
		if name == "recovery-fence" {
			step.State, step.Evidence = "succeeded", "fixture owns settled provider and native fence"
		}
		if name == "recovery-paired-restore" {
			step.State = "started"
		}
		j.RecoverySteps = append(j.RecoverySteps, step)
	}
	if err := (CoreManager{Root: p.Root}).saveCore(&j); err != nil {
		t.Fatal(err)
	}
	p.RestoreStream = func(context.Context, io.Reader, string, ...string) error {
		t.Fatal("checkpoint abort must never restore a database")
		return nil
	}
	return p, j
}

func TestCoreCheckpointAbortPreservesIncompleteCaptureAndInstalledReceipt(t *testing.T) {
	p, j := abortedCheckpointFixture(t)
	native := p.Capture
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "incus" && args[0] == "exec" && args[1] == "youeye-postgres" && !strings.Contains(args[len(args)-1], "pg_stat_activity") {
			t.Fatal("unapplied abort must not depend on failed database size/schema capture")
		}
		return native(ctx, program, args...)
	}
	before, err := p.Read(j)
	if err != nil {
		t.Fatal(err)
	}
	if before.Phase != "files-captured" {
		t.Fatal("fixture must not have completed database capture")
	}
	if _, err = p.RestoreDatabases(context.Background(), j); err == nil {
		t.Fatal("rewound data without any activation")
	}
	got, err := p.AbortCheckpoint(context.Background(), j.RequestID)
	if err != nil || got.Phase != "aborted-unapplied" {
		t.Fatal(got.Phase, err)
	}
	before.Phase = got.Phase
	if !reflect.DeepEqual(before, got) {
		t.Fatal("abort changed retained resources")
	}
	if _, err = p.AbortCheckpoint(context.Background(), j.RequestID); err != nil {
		t.Fatal("exact abort observation failed", err)
	}
	installed, err := (CoreManager{Root: p.Root}).ReadReceipt()
	if err != nil || !reflect.DeepEqual(installed, j.Previous) {
		t.Fatal("abort changed installed commitment", err)
	}
}

func TestCoreCheckpointAbortRequiresFenceUnchangedBaselineAndPendingPayloadActions(t *testing.T) {
	for _, condition := range []string{"unfenced", "changed-commit", "payload-started", "restore-started"} {
		t.Run(condition, func(t *testing.T) {
			p, j := abortedCheckpointFixture(t)
			m := CoreManager{Root: p.Root}
			switch condition {
			case "unfenced":
				j.RecoverySteps[0].State, j.RecoverySteps[0].Evidence = "started", ""
				j.RecoverySteps[1].State = "pending"
			case "changed-commit":
				receipt := j.Previous
				receipt.AcceptedAt = "2026-10-14T00:00:00Z"
				raw, _ := json.Marshal(receipt)
				if err := atomicWrite(filepath.Join(p.Root, "committed.json"), raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "payload-started":
				for i := range j.Steps {
					if j.Steps[i].Name == "apply-cp" {
						j.Steps[i].State = "started"
						break
					}
					j.Steps[i].State, j.Steps[i].Evidence = "succeeded", "completed prerequisite"
				}
			case "restore-started":
				record, _ := p.Read(j)
				record.Phase = "restoring-databases"
				if err := p.saveRecord(record); err != nil {
					t.Fatal(err)
				}
			}
			if err := m.saveCore(&j); err != nil {
				t.Fatal(err)
			}
			if _, err := p.AbortCheckpoint(context.Background(), j.RequestID); err == nil {
				t.Fatal("abort ignored", condition)
			}
		})
	}
}
