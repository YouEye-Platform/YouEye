package systemupdate

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
)

func databaseCheckpointFixture(t *testing.T) (NativeCoreCheckpoint, CoreJournal, *int, *string) {
	t.Helper()
	p, j, _, _, _ := filesCheckpointFixture(t)
	record, err := p.CaptureFiles(context.Background(), j)
	if err != nil {
		t.Fatal(err)
	}
	native := p.Capture
	authority := "unchanged-private-fixture"
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "incus" && args[0] == "exec" && args[1] == "youeye-postgres" {
			query := args[len(args)-1]
			if strings.Contains(query, "pg_stat_activity") {
				return []byte("0"), nil
			}
			if strings.Contains(query, "pg_database_size") {
				return []byte(`[{"name":"youeye","owner":"youeye","size_bytes":1024},{"name":"youeye_ui","owner":"youeye","size_bytes":1024}]`), nil
			}
			if strings.Contains(query, "FROM pg_tables") {
				return []byte(`[]`), nil
			}
			return []byte(authority), nil
		}
		return native(ctx, program, args...)
	}
	record.Databases, err = p.InspectDatabases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := p.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	dumps := 0
	p.Stream = func(_ context.Context, out io.Writer, program string, args ...string) error {
		if program != "incus" || args[1] != "youeye-postgres" || !strings.Contains(strings.Join(args, " "), "pg_dump --no-password --username=youeye --format=custom --dbname=youeye") {
			t.Fatal("unscoped native dump")
		}
		dumps++
		_, err := out.Write([]byte("PGDMP-private-fixture"))
		return err
	}
	return p, j, &dumps, &authority
}

func TestCoreDatabaseCaptureStreamsProtectedArchivesAndReusesExactReceipts(t *testing.T) {
	p, j, dumps, _ := databaseCheckpointFixture(t)
	record, err := p.CaptureDatabases(context.Background(), j)
	if err != nil || record.Phase != "captured" || *dumps != 2 {
		t.Fatal(record.Phase, *dumps, err)
	}
	for _, db := range record.Databases {
		path, err := p.databaseArchivePath(j, db.Name)
		if err != nil {
			t.Fatal(err)
		}
		if err := verifyCoreDatabaseArchive(path, db); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Lstat(path + ".partial"); !os.IsNotExist(err) {
			t.Fatal("successful archive left partial", err)
		}
	}
	if _, err := p.CaptureDatabases(context.Background(), j); err != nil || *dumps != 2 {
		t.Fatal("repeated archive capture", *dumps, err)
	}
	path, _ := p.databaseArchivePath(j, "youeye")
	if err := os.WriteFile(path, []byte("PGDMP-corrupt-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CaptureDatabases(context.Background(), j); err == nil || *dumps != 2 {
		t.Fatal("corrupt archive adopted or silently regenerated", err)
	}
}

func TestCoreDatabaseCaptureUnknownDumpAndNewAuthorityPreventCompletion(t *testing.T) {
	p, j, dumps, _ := databaseCheckpointFixture(t)
	original := p.Stream
	p.Stream = func(ctx context.Context, out io.Writer, program string, args ...string) error {
		_ = original(ctx, out, program, args...)
		return fmt.Errorf("interrupted private capture")
	}
	if _, err := p.CaptureDatabases(context.Background(), j); err == nil {
		t.Fatal("interrupted dump completed")
	}
	p.Stream = original
	if _, err := p.CaptureDatabases(context.Background(), j); err == nil || *dumps != 1 {
		t.Fatal("unknown dump replayed", *dumps, err)
	}
	p, j, dumps, authority := databaseCheckpointFixture(t)
	original = p.Stream
	p.Stream = func(ctx context.Context, out io.Writer, program string, args ...string) error {
		err := original(ctx, out, program, args...)
		*authority = "newer-revocation"
		return err
	}
	if record, err := p.CaptureDatabases(context.Background(), j); err == nil || record.Phase == "captured" {
		t.Fatal("new authority certified against historical checkpoint", err)
	}
}

func TestCoreDatabaseArchiveRejectsLinksAndExcessOutput(t *testing.T) {
	p, j, _, _ := databaseCheckpointFixture(t)
	record, err := p.CaptureDatabases(context.Background(), j)
	if err != nil {
		t.Fatal(err)
	}
	path, _ := p.databaseArchivePath(j, "youeye")
	if err := os.Rename(path, path+".retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path+".retained", path); err != nil {
		t.Fatal(err)
	}
	if err := verifyCoreDatabaseArchive(path, record.Databases[0]); err == nil {
		t.Fatal("symlink archive accepted")
	}
	writer := boundedCoreArchive{writer: io.Discard, remaining: 3}
	if _, err := writer.Write([]byte("four")); err == nil {
		t.Fatal("archive bound exceeded")
	}
}
