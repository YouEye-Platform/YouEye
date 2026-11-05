package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func (p NativeCoreCheckpoint) databaseArchivePath(j CoreJournal, name string) (string, error) {
	if !filepath.IsAbs(p.DataRoot) || !coreRequestPattern.MatchString(j.RequestID) || !corePlatformDatabase(name) {
		return "", fmt.Errorf("exact database checkpoint scope required")
	}
	return filepath.Join(p.DataRoot, "state", "core-checkpoints", fmt.Sprintf("%x", sha256.Sum256([]byte(j.RequestID))), name+".dump"), nil
}

func protectedCoreDirectory(root, path string) error {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, "../") || filepath.IsAbs(relative) || filepath.Clean(root) != root || filepath.Clean(path) != path {
		return fmt.Errorf("checkpoint directory is outside protected storage")
	}
	check := func(at string) error {
		info, err := os.Lstat(at)
		if err != nil {
			return err
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode().Perm()&0022 != 0 || int(st.Uid) != os.Geteuid() {
			return fmt.Errorf("unsafe database checkpoint directory")
		}
		return nil
	}
	if err := check(root); err != nil {
		return err
	}
	if relative == "." {
		return nil
	}
	at := root
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		at = filepath.Join(at, part)
		if err := os.Mkdir(at, 0700); err != nil && !os.IsExist(err) {
			return err
		}
		if err := check(at); err != nil {
			return err
		}
	}
	return nil
}

type boundedCoreArchive struct {
	writer    io.Writer
	remaining int64
}

func (w *boundedCoreArchive) Write(data []byte) (int, error) {
	if int64(len(data)) > w.remaining {
		return 0, fmt.Errorf("database archive exceeds reserved bound")
	}
	n, err := w.writer.Write(data)
	w.remaining -= int64(n)
	return n, err
}

func (p NativeCoreCheckpoint) dumpDatabase(ctx context.Context, database string, out io.Writer) error {
	if !corePlatformDatabase(database) {
		return fmt.Errorf("database is outside core capture scope")
	}
	args := []string{"exec", "youeye-postgres", "--mode=non-interactive", "--", "pg_dump", "--no-password", "--username=youeye", "--format=custom", "--dbname=" + database}
	if p.Stream != nil {
		return p.Stream(ctx, out, "incus", args...)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	args = append([]string{"--force-local", "--project", "default"}, args...)
	cmd := exec.CommandContext(ctx, "incus", args...)
	cmd.Stdout, cmd.Stderr = out, io.Discard
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("native database archive did not complete")
	}
	return nil
}

func verifyCoreDatabaseArchive(path string, db CoreCheckpointDatabase) error {
	if db.DumpState != "captured" || !validSHA256(db.DumpSHA256) || db.DumpBytes < 5 {
		return fmt.Errorf("database archive receipt is incomplete")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || int(st.Uid) != os.Geteuid() || info.Size() != db.DumpBytes {
		return fmt.Errorf("unsafe database archive")
	}
	header := make([]byte, 5)
	if _, err := io.ReadFull(file, header); err != nil || string(header) != "PGDMP" {
		return fmt.Errorf("database archive format is invalid")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, db.DumpBytes+1))
	if err != nil || n != db.DumpBytes || fmt.Sprintf("%x", hash.Sum(nil)) != db.DumpSHA256 {
		return fmt.Errorf("database archive changed")
	}
	return nil
}

// CaptureDatabases streams bounded custom archives into protected Data storage.
// It never archives cluster roles, logs SQL/private rows or restores authority.
// Only a durable successful archive receipt permits reuse after interruption.
func (p NativeCoreCheckpoint) CaptureDatabases(ctx context.Context, j CoreJournal) (NativeCoreCheckpointRecord, error) {
	record, err := p.Read(j)
	if err != nil {
		return record, err
	}
	current, err := (CoreManager{Root: p.Root}).Read()
	if err != nil || current.RequestID != j.RequestID || current.ManifestSHA256 != j.ManifestSHA256 || current.Phase != "applying" {
		return record, fmt.Errorf("active coordinator checkpoint required")
	}
	active := false
	for _, s := range current.Steps {
		if s.Name == "checkpoint" && s.State == "started" {
			active = true
		}
	}
	if !active || (record.Phase != "files-captured" && record.Phase != "capturing-databases" && record.Phase != "captured") {
		return record, fmt.Errorf("checkpoint is not ready for database capture")
	}
	if err := p.verifyReservation(j); err != nil {
		return record, err
	}
	machine, err := p.observeMachine()
	if err != nil || machine != record.Inventory.Machine {
		return record, fmt.Errorf("checkpoint machine changed")
	}
	if err := p.verifyContainerIdentities(ctx, record.Inventory, true); err != nil {
		return record, err
	}
	databases, err := p.InspectDatabases(ctx)
	if err != nil {
		return record, err
	}
	if len(databases) != len(record.Databases) {
		return record, fmt.Errorf("database checkpoint scope changed")
	}
	// Compare scope and authority, not physical size (autovacuum may change it).
	prior := map[string]CoreCheckpointDatabase{}
	for _, db := range record.Databases {
		if _, ok := prior[db.Name]; ok {
			return record, fmt.Errorf("duplicate database checkpoint")
		}
		prior[db.Name] = db
	}
	for _, db := range databases {
		old, ok := prior[db.Name]
		if !ok || old.Owner != db.Owner || old.SecuritySHA256 != db.SecuritySHA256 {
			return record, fmt.Errorf("database authority changed before capture")
		}
	}
	required := uint64(512 << 20)
	for _, db := range record.Databases {
		if db.SizeBytes <= 0 || db.SizeBytes > 8<<30 {
			return record, fmt.Errorf("database checkpoint exceeds supported capacity")
		}
		required += uint64(db.SizeBytes)*4 + (128 << 20)
	}
	first, err := p.databaseArchivePath(j, "youeye")
	if err != nil {
		return record, err
	}
	if err := protectedCoreDirectory(p.DataRoot, filepath.Dir(first)); err != nil {
		return record, err
	}
	var capacity syscall.Statfs_t
	if err := syscall.Statfs(filepath.Dir(first), &capacity); err != nil {
		return record, err
	}
	if capacity.Bsize <= 0 || capacity.Bavail < uint64(required)/uint64(capacity.Bsize)+1 {
		return record, fmt.Errorf("insufficient database checkpoint and restore capacity")
	}
	record.Phase = "capturing-databases"
	if err := p.saveRecord(record); err != nil {
		return record, err
	}
	for i := range record.Databases {
		db := &record.Databases[i]
		path, err := p.databaseArchivePath(j, db.Name)
		if err != nil {
			return record, err
		}
		if db.DumpState == "captured" {
			if err := verifyCoreDatabaseArchive(path, *db); err != nil {
				return record, err
			}
			continue
		}
		if db.DumpState != "" {
			return record, fmt.Errorf("database capture outcome is uncertain; replay refused")
		}
		// Neither an old final nor a partial is adopted or overwritten.
		for _, candidate := range []string{path, path + ".partial"} {
			if _, err := os.Lstat(candidate); !os.IsNotExist(err) {
				return record, fmt.Errorf("unowned database checkpoint path exists")
			}
		}
		db.DumpState = "requested"
		if err := p.saveRecord(record); err != nil {
			return record, err
		}
		f, err := os.OpenFile(path+".partial", os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0600)
		if err != nil {
			return record, err
		}
		bound := db.SizeBytes*2 + (64 << 20)
		hash := sha256.New()
		writer := &boundedCoreArchive{writer: io.MultiWriter(f, hash), remaining: bound}
		captureErr := p.dumpDatabase(ctx, db.Name, writer)
		if captureErr == nil {
			captureErr = f.Sync()
		}
		closeErr := f.Close()
		if captureErr != nil {
			return record, captureErr
		}
		if closeErr != nil {
			return record, closeErr
		}
		db.DumpState, db.DumpSHA256, db.DumpBytes = "captured", fmt.Sprintf("%x", hash.Sum(nil)), bound-writer.remaining
		if err := verifyCoreDatabaseArchive(path+".partial", *db); err != nil {
			return record, err
		}
		if err := os.Link(path+".partial", path); err != nil {
			return record, err
		}
		if err := syncDirectory(filepath.Dir(path)); err != nil {
			return record, err
		}
		if err := p.saveRecord(record); err != nil {
			return record, err
		}
		if err := os.Remove(path + ".partial"); err != nil {
			return record, err
		}
	}
	// Recheck the live authority after read-only dumps; never certify a checkpoint
	// taken while a new grant/revocation or unexpected client appeared.
	currentDatabases, err := p.InspectDatabases(ctx)
	if err != nil {
		return record, err
	}
	if len(currentDatabases) != len(record.Databases) {
		return record, fmt.Errorf("database scope changed during capture")
	}
	for _, db := range currentDatabases {
		old, ok := prior[db.Name]
		if !ok || db.Owner != old.Owner || db.SecuritySHA256 != old.SecuritySHA256 {
			return record, fmt.Errorf("database authority changed during capture")
		}
	}
	if err := p.verifyCapturedSnapshots(ctx, record); err != nil {
		return record, err
	}
	record.Phase = "captured"
	raw, err := json.Marshal(record)
	if err != nil {
		return record, err
	}
	return record, atomicWrite(p.recordPath(j.RequestID), raw, 0600)
}
