package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"reflect"
	"syscall"
	"time"
)

// requirePairedRecovery independently verifies native restore authority. A
// provider callback cannot restore just because a caller supplied a journal.
func (p NativeCoreCheckpoint) requirePairedRecovery(ctx context.Context, j CoreJournal, record NativeCoreCheckpointRecord) error {
	m := CoreManager{Root: p.Root}
	current, err := m.Read()
	if err != nil || current.RequestID != j.RequestID || current.ManifestSHA256 != j.ManifestSHA256 || current.Phase != "recovering" {
		return fmt.Errorf("active native paired recovery required")
	}
	if coreCheckpointUnapplied(current) {
		return fmt.Errorf("activation never started; preserve live data with checkpoint abort")
	}
	fence, restore := false, false
	for _, step := range current.RecoverySteps {
		if step.Name == "recovery-fence" && step.State == "succeeded" && step.Evidence != "" {
			fence = true
		}
		if step.Name == "recovery-paired-restore" && step.State == "started" {
			restore = true
		}
	}
	if !fence || !restore {
		return fmt.Errorf("verified recovery fence and active restore required")
	}
	installed, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(installed, current.Previous) {
		return fmt.Errorf("installed commitment changed; historical restore refused")
	}
	if !reflect.DeepEqual(current.Previous, j.Previous) || record.Inventory.Machine != current.Previous.Machine {
		return fmt.Errorf("retained restore baseline differs")
	}
	if err := p.verifyReservation(j); err != nil {
		return err
	}
	machine, err := p.observeMachine()
	if err != nil || machine != record.Inventory.Machine {
		return fmt.Errorf("recovery machine changed")
	}
	if err := p.verifyContainerIdentities(ctx, record.Inventory, true); err != nil {
		return err
	}
	if err := p.verifyCapturedSnapshots(ctx, record); err != nil {
		return err
	}
	raw, err := p.capture(ctx, "zfs", "list", "-H", "-o", "name,mountpoint", "-t", "filesystem")
	if err != nil {
		return err
	}
	files, err := p.checkpointFileInventory(string(raw), coreCheckpointSnapshot(j.RequestID))
	if err != nil {
		return err
	}
	actualFiles, _ := json.Marshal(files)
	expectedFiles, _ := json.Marshal(record.Inventory.Files)
	if string(actualFiles) != string(expectedFiles) {
		return fmt.Errorf("persistent recovery mount coverage changed")
	}
	currentDBs, err := p.InspectDatabases(ctx)
	if err != nil {
		return err
	}
	if len(currentDBs) != len(record.Databases) {
		return fmt.Errorf("recovery database scope changed")
	}
	prior := map[string]CoreCheckpointDatabase{}
	for _, db := range record.Databases {
		if _, exists := prior[db.Name]; exists {
			return fmt.Errorf("ambiguous recovery database")
		}
		prior[db.Name] = db
	}
	for _, db := range currentDBs {
		old, exists := prior[db.Name]
		if !exists || old.Owner != db.Owner || (db.Name != "pointer" && old.SecuritySHA256 != db.SecuritySHA256) {
			return fmt.Errorf("current database authority differs; preserve it for recovery")
		}
	}
	return nil
}

func (p NativeCoreCheckpoint) restoreDatabase(ctx context.Context, database string, input io.Reader) error {
	if !corePlatformDatabase(database) {
		return fmt.Errorf("database is outside core recovery scope")
	}
	// No --create or cluster-role restore: existing database owners, role identity
	// and cluster authority stay in place. Stored ACLs are used only after exact
	// current authority equality; changed grants/revocations block this method.
	args := []string{"exec", "youeye-postgres", "--mode=non-interactive", "--", "pg_restore", "--no-password", "--username=youeye", "--dbname=" + database, "--clean", "--if-exists", "--single-transaction", "--exit-on-error", "--no-owner"}
	if p.RestoreStream != nil {
		return p.RestoreStream(ctx, input, "incus", args...)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	args = append([]string{"--force-local", "--project", "default"}, args...)
	cmd := exec.CommandContext(ctx, "incus", args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, io.Discard, io.Discard
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("native database restore outcome requires reconciliation")
	}
	return nil
}

// RestoreDatabases never retries an uncertain restore. PostgreSQL applies each
// custom archive in a single transaction; the durable native receipt records a
// successful outcome only after current authority is checked again. Pairing with
// root/files and operational health is still required before opening ingress.
func (p NativeCoreCheckpoint) RestoreDatabases(ctx context.Context, j CoreJournal) (NativeCoreCheckpointRecord, error) {
	record, err := p.Read(j)
	if err != nil {
		return record, err
	}
	if record.Phase != "captured" && record.Phase != "restoring-databases" && record.Phase != "databases-restored" {
		return record, fmt.Errorf("complete checkpoint required for database recovery")
	}
	if err := p.requirePairedRecovery(ctx, j, record); err != nil {
		return record, err
	}
	// Validate every archive before the first restore, so a later missing member
	// cannot be discovered only after another database has been rewound.
	for _, db := range record.Databases {
		path, err := p.databaseArchivePath(j, db.Name)
		if err != nil {
			return record, err
		}
		if err := verifyCoreDatabaseArchive(path, db); err != nil {
			return record, err
		}
	}
	record.Phase = "restoring-databases"
	if err := p.saveRecord(record); err != nil {
		return record, err
	}
	for i := range record.Databases {
		db := &record.Databases[i]
		if db.Name == "pointer" {
			if db.RestoreState != "" && db.RestoreState != "preserved" {
				return record, fmt.Errorf("independent Pointer database has invalid restore intent")
			}
			db.RestoreState = "preserved"
			if err := p.saveRecord(record); err != nil {
				return record, err
			}
			continue
		}
		if db.RestoreState == "restored" {
			continue
		}
		if db.RestoreState != "" {
			return record, fmt.Errorf("database restore remains uncertain; replay refused")
		}
		if err := p.requirePairedRecovery(ctx, j, record); err != nil {
			return record, err
		}
		path, err := p.databaseArchivePath(j, db.Name)
		if err != nil {
			return record, err
		}
		file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return record, err
		}
		hash := sha256.New()
		n, err := io.Copy(hash, io.LimitReader(file, db.DumpBytes+1))
		if err != nil || n != db.DumpBytes || fmt.Sprintf("%x", hash.Sum(nil)) != db.DumpSHA256 {
			file.Close()
			return record, fmt.Errorf("database restore input changed")
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			file.Close()
			return record, err
		}
		db.RestoreState = "requested"
		if err := p.saveRecord(record); err != nil {
			file.Close()
			return record, err
		}
		restoreErr := p.restoreDatabase(ctx, db.Name, file)
		file.Close()
		if restoreErr != nil {
			return record, restoreErr
		}
		if err := p.requirePairedRecovery(ctx, j, record); err != nil {
			return record, err
		}
		db.RestoreState = "restored"
		if err := p.saveRecord(record); err != nil {
			return record, err
		}
	}
	record.Phase = "databases-restored"
	return record, p.saveRecord(record)
}
