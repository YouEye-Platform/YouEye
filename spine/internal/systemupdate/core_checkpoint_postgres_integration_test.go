package systemupdate

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Explicitly admitted local SQL integration: real PostgreSQL, dump and restore;
// appliance/container/snapshot observations remain fixtures. No TCP listener,
// existing database, installed appliance or owner credential is involved.
func TestCoreCheckpointPostgresRoundTrip(t *testing.T) {
	if os.Getenv("YOUEYE_CORE_POSTGRES_TEST") != "1" {
		t.Skip("set YOUEYE_CORE_POSTGRES_TEST=1 for admitted PostgreSQL integration")
	}
	bin := os.Getenv("YOUEYE_TEST_POSTGRES_BIN")
	if bin == "" {
		bin = "/usr/lib/postgresql/17/bin"
	}
	if !filepath.IsAbs(bin) {
		t.Fatal("absolute PostgreSQL tool directory required")
	}
	for _, name := range []string{"initdb", "pg_ctl", "psql", "pg_dump", "pg_restore"} {
		if _, err := os.Stat(filepath.Join(bin, name)); err != nil {
			t.Fatal("required PostgreSQL test tools unavailable")
		}
	}
	root, err := os.MkdirTemp("", "youeye-core-postgres-test-")
	if err != nil {
		t.Fatal(err)
	}
	started := false
	t.Cleanup(func() {
		if started {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, filepath.Join(bin, "pg_ctl"), "-D", filepath.Join(root, "data"), "-m", "fast", "-w", "stop")
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			if err := cmd.Run(); err != nil {
				t.Errorf("owned PostgreSQL fixture did not stop; retained %s", root)
				return
			}
		}
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("fixture cleanup failed: %v", err)
		}
	})
	env := []string{"PATH=" + bin + ":/usr/bin:/bin", "LC_ALL=C", "PGHOST=" + root, "PGUSER=youeye", "PGCONNECT_TIMEOUT=5"}
	run := func(name string, args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, filepath.Join(bin, name), args...)
		cmd.Env = env
		cmd.Stderr = io.Discard
		return cmd.Output()
	}
	if _, err := run("initdb", "-D", filepath.Join(root, "data"), "--username=youeye", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"); err != nil {
		t.Fatal("fixture init failed", err)
	}
	started = true // a lost startup acknowledgement still requires owned-process cleanup
	if _, err := run("pg_ctl", "-D", filepath.Join(root, "data"), "-l", filepath.Join(root, "server.log"), "-o", "-c listen_addresses='' -c unix_socket_directories="+root+" -c shared_buffers=32MB -c max_connections=10", "-w", "start"); err != nil {
		t.Fatal("fixture start failed", err)
	}
	started = true
	sql := func(database, query string) string {
		t.Helper()
		raw, err := run("psql", "--no-psqlrc", "--dbname="+database, "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--command", query)
		if err != nil {
			t.Fatal("fixture SQL failed", err)
		}
		return strings.TrimSpace(string(raw))
	}
	sql("postgres", "CREATE DATABASE youeye")
	sql("postgres", "CREATE DATABASE youeye_ui")
	sql("postgres", "CREATE ROLE fixture_reader")
	for _, database := range []string{"youeye", "youeye_ui"} {
		sql(database, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO fixture_reader;
   CREATE TABLE identity_fixture(id integer PRIMARY KEY, decision text NOT NULL);
   INSERT INTO identity_fixture VALUES(1,'retained-authority');
   CREATE TABLE core_fixture(id integer PRIMARY KEY,value text NOT NULL);
   INSERT INTO core_fixture VALUES(1,'checkpoint-value');
   GRANT UPDATE(value) ON core_fixture TO fixture_reader;
   ALTER TABLE core_fixture ENABLE ROW LEVEL SECURITY;
   CREATE POLICY fixture_read ON core_fixture FOR SELECT TO fixture_reader USING (true);
   CREATE FUNCTION public.fixture_allowed(i integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT i > 0';`)
	}
	p, j, _, _ := databaseCheckpointFixture(t)
	native := p.Capture
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "incus" && args[0] == "exec" && args[1] == "youeye-postgres" {
			offset := -1
			for i, arg := range args {
				if arg == "psql" {
					offset = i
					break
				}
			}
			if offset < 0 {
				return nil, fmt.Errorf("unexpected database fixture command")
			}
			return run("psql", args[offset+1:]...)
		}
		return native(ctx, program, args...)
	}
	p.Stream = func(ctx context.Context, out io.Writer, program string, args ...string) error {
		offset := -1
		for i, arg := range args {
			if arg == "pg_dump" {
				offset = i
				break
			}
		}
		if offset < 0 {
			return fmt.Errorf("unexpected dump command")
		}
		cmd := exec.CommandContext(ctx, filepath.Join(bin, "pg_dump"), args[offset+1:]...)
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = out, io.Discard
		return cmd.Run()
	}
	p.RestoreStream = func(ctx context.Context, in io.Reader, program string, args ...string) error {
		offset := -1
		for i, arg := range args {
			if arg == "pg_restore" {
				offset = i
				break
			}
		}
		if offset < 0 {
			return fmt.Errorf("unexpected restore command")
		}
		cmd := exec.CommandContext(ctx, filepath.Join(bin, "pg_restore"), args[offset+1:]...)
		cmd.Env = env
		cmd.Stdin, cmd.Stdout, cmd.Stderr = in, io.Discard, io.Discard
		return cmd.Run()
	}
	record, err := p.Read(j)
	if err != nil {
		t.Fatal(err)
	}
	record.Databases, err = p.InspectDatabases(context.Background())
	if err != nil {
		t.Fatal("real catalog inspection failed", err)
	}
	if err := p.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CaptureDatabases(context.Background(), j); err != nil {
		t.Fatal("real dump capture failed", err)
	}
	for _, database := range []string{"youeye", "youeye_ui"} {
		sql(database, "UPDATE core_fixture SET value='after-update'")
	}
	j = activatePairedRecoveryFixture(t, p, j)
	restored, err := p.RestoreDatabases(context.Background(), j)
	if err != nil {
		t.Fatal("real transactional restore failed", err)
	}
	if restored.Phase != "databases-restored" {
		t.Fatal("incomplete restore")
	}
	for _, database := range []string{"youeye", "youeye_ui"} {
		if sql(database, "SELECT value FROM core_fixture WHERE id=1") != "checkpoint-value" {
			t.Fatal("ordinary data was not restored")
		}
		if sql(database, "SELECT decision FROM identity_fixture WHERE id=1") != "retained-authority" {
			t.Fatal("authority changed")
		}
	}
	if err := p.VerifyDatabaseSecurity(context.Background(), restored.Databases); err != nil {
		t.Fatal("permission fingerprint changed across restore", err)
	}
	// A later grant change must be visible before any further recovery effects.
	sql("youeye", "REVOKE UPDATE(value) ON core_fixture FROM fixture_reader")
	if err := p.VerifyDatabaseSecurity(context.Background(), restored.Databases); err == nil {
		t.Fatal("column revocation was not detected")
	}
	// The dump is actual custom-format data, not a mocked header.
	path, _ := p.databaseArchivePath(j, "youeye")
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) < 1024 || !bytes.HasPrefix(raw, []byte("PGDMP")) {
		t.Fatal("missing actual PostgreSQL archive", err)
	}
}
