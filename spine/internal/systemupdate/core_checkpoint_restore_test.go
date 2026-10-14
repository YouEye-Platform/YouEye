package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func activatePairedRecoveryFixture(t *testing.T, p NativeCoreCheckpoint, j CoreJournal) CoreJournal {
	t.Helper()
	m := CoreManager{Root: p.Root}
	j.Phase = "recovering"
	// These fixtures exercise restoration after an actual payload action, not
	// checkpoint preparation failure (which must preserve current live data).
	for i := range j.Steps {
		if j.Steps[i].Name == "apply-cp" {
			j.Steps[i].State = "started"
			break
		}
		j.Steps[i].State, j.Steps[i].Evidence = "succeeded", "fixture completed before apply"
	}
	for _, name := range coreRecoveryNames(j) {
		step := CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"}
		if name == "recovery-fence" {
			step.State = "succeeded"
			step.Evidence = "fixture fenced writers"
		}
		if name == "recovery-paired-restore" {
			step.State = "started"
		}
		j.RecoverySteps = append(j.RecoverySteps, step)
	}
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	return j
}

func TestCoreDatabaseRestoreRequiresRecoveryAndPreservesSingleTransactionScope(t *testing.T) {
	p, j, _, _ := databaseCheckpointFixture(t)
	if _, err := p.CaptureDatabases(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	restores := 0
	p.RestoreStream = func(_ context.Context, input io.Reader, program string, args ...string) error {
		restores++
		command := strings.Join(args, " ")
		if program != "incus" || !strings.Contains(command, "--single-transaction --exit-on-error --no-owner") || strings.Contains(command, "--create") || strings.Contains(command, "--no-acl") {
			t.Fatal("unsafe restore scope")
		}
		raw, err := io.ReadAll(input)
		if err != nil || string(raw) != "PGDMP-private-fixture" {
			t.Fatal("restore received changed archive", err)
		}
		return nil
	}
	if _, err := p.RestoreDatabases(context.Background(), j); err == nil || restores != 0 {
		t.Fatal("restored outside recovery")
	}
	j = activatePairedRecoveryFixture(t, p, j)
	record, err := p.RestoreDatabases(context.Background(), j)
	if err != nil || record.Phase != "databases-restored" || restores != 2 {
		t.Fatal(record.Phase, restores, err)
	}
	if _, err := p.RestoreDatabases(context.Background(), j); err != nil || restores != 2 {
		t.Fatal("restored twice", restores, err)
	}
}

func TestCoreDatabaseRestoreUnknownOutcomeCannotReplay(t *testing.T) {
	p, j, _, _ := databaseCheckpointFixture(t)
	if _, err := p.CaptureDatabases(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	j = activatePairedRecoveryFixture(t, p, j)
	restores := 0
	p.RestoreStream = func(context.Context, io.Reader, string, ...string) error {
		restores++
		return fmt.Errorf("lost native restore acknowledgement")
	}
	if _, err := p.RestoreDatabases(context.Background(), j); err == nil || restores != 1 {
		t.Fatal("unknown restore accepted", err)
	}
	p.RestoreStream = func(context.Context, io.Reader, string, ...string) error { restores++; return nil }
	if _, err := p.RestoreDatabases(context.Background(), j); err == nil || restores != 1 {
		t.Fatal("unknown restore replayed", restores, err)
	}
}

func TestCoreDatabaseRestoreRejectsNewAuthorityOrDurableCommit(t *testing.T) {
	p, j, _, authority := databaseCheckpointFixture(t)
	if _, err := p.CaptureDatabases(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	j = activatePairedRecoveryFixture(t, p, j)
	p.RestoreStream = func(context.Context, io.Reader, string, ...string) error {
		t.Fatal("effect after authority or receipt changed")
		return nil
	}
	original := *authority
	*authority = "newer-revocation"
	if _, err := p.RestoreDatabases(context.Background(), j); err == nil {
		t.Fatal("rewound newer authority")
	}
	*authority = original
	m := CoreManager{Root: p.Root}
	receipt, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	receipt.AcceptedAt = "2026-02-01T00:00:00Z"
	raw, _ := json.Marshal(receipt)
	if err := atomicWrite(filepath.Join(m.Root, "committed.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.RestoreDatabases(context.Background(), j); err == nil {
		t.Fatal("restored after commitment changed")
	}
}

func TestCoreRecoveryPreservesIndependentPointerDatabase(t *testing.T) {
	p, j, _, _ := databaseCheckpointFixture(t)
	native := p.Capture
	pointerData := "old-independent-data"
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "incus" && args[0] == "exec" && args[1] == "youeye-postgres" {
			query := args[len(args)-1]
			if strings.Contains(query, "pg_database_size") {
				return []byte(`[{"name":"pointer","owner":"youeye","size_bytes":1024},{"name":"youeye","owner":"youeye","size_bytes":1024},{"name":"youeye_ui","owner":"youeye","size_bytes":1024}]`), nil
			}
			if strings.Contains(strings.Join(args, " "), "--dbname=pointer") {
				if strings.Contains(query, "FROM pg_tables") {
					return []byte(`["pointer_records"]`), nil
				}
				if strings.Contains(query, `public."pointer_records"`) {
					return []byte(pointerData), nil
				}
			}
		}
		return native(ctx, program, args...)
	}
	p.Stream = func(_ context.Context, out io.Writer, _ string, _ ...string) error {
		_, err := out.Write([]byte("PGDMP-pointer-fixture"))
		return err
	}
	record, err := p.Read(j)
	if err != nil {
		t.Fatal(err)
	}
	record.Databases, err = p.InspectDatabases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := p.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CaptureDatabases(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	j = activatePairedRecoveryFixture(t, p, j)
	pointerData = "newer-independent-data"
	restored := 0
	p.RestoreStream = func(_ context.Context, _ io.Reader, _ string, args ...string) error {
		if strings.Contains(strings.Join(args, " "), "--dbname=pointer") {
			t.Fatal("core rewound independent Pointer data")
		}
		restored++
		return nil
	}
	record, err = p.RestoreDatabases(context.Background(), j)
	if err != nil || restored != 2 {
		t.Fatal(restored, err)
	}
	if record.Databases[0].Name != "pointer" || record.Databases[0].RestoreState != "preserved" {
		t.Fatal("Pointer preservation not recorded")
	}
}
