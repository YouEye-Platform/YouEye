package systemupdate

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestCoreDatabasePreflightRequiresWriterClosureAndPreservesChangedAuthority(t *testing.T) {
	writers, owner, authority := "0", "youeye", "original-grant"
	calls := 0
	p := NativeCoreCheckpoint{Capture: func(_ context.Context, program string, args ...string) ([]byte, error) {
		calls++
		if program != "incus" || len(args) < 5 || args[0] != "exec" || args[1] != "youeye-postgres" {
			t.Fatal("not a scoped private PostgreSQL observation")
		}
		query := args[len(args)-1]
		switch {
		case strings.Contains(query, "pg_stat_activity"):
			return []byte(writers), nil
		case strings.Contains(query, "pg_database_size"):
			return []byte(fmt.Sprintf(`[{"name":"youeye","owner":%q,"size_bytes":1024},{"name":"youeye_ui","owner":"youeye","size_bytes":2048},{"name":"pointer","owner":"youeye","size_bytes":4096}]`, owner)), nil
		case strings.Contains(query, "FROM pg_tables"):
			if strings.Contains(strings.Join(args, " "), "--dbname=pointer") {
				if !strings.Contains(query, "(TRUE)") {
					t.Fatal("guessed Pointer security by table name")
				}
				return []byte(`["platform_integrations"]`), nil
			}
			return []byte(`["identity_users"]`), nil
		default:
			return []byte(authority), nil
		}
	}}
	databases, err := p.InspectDatabases(context.Background())
	if err != nil || len(databases) != 3 {
		t.Fatal(databases, err)
	}
	for _, db := range databases {
		if !validSHA256(db.SecuritySHA256) {
			t.Fatal("security rows were not reduced to a digest")
		}
	}
	if err := p.VerifyDatabaseSecurity(context.Background(), databases); err != nil {
		t.Fatal(err)
	}
	authority = "newer-revocation"
	if err := p.VerifyDatabaseSecurity(context.Background(), databases); err == nil {
		t.Fatal("would overwrite newer authority during rollback")
	}
	writers = "1"
	calls = 0
	if _, err := p.InspectDatabases(context.Background()); err == nil || calls != 1 {
		t.Fatal("captured checkpoint with a live database writer", calls, err)
	}
	writers = "0"
	owner = "foreign"
	if _, err := p.InspectDatabases(context.Background()); err == nil {
		t.Fatal("checkpointed a database with unsupported ownership")
	}
}

func TestCoreDatabaseCommandsRejectUnrelatedTargetsBeforeExecution(t *testing.T) {
	p := NativeCoreCheckpoint{Capture: func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("executed unrelated query")
		return nil, nil
	}}
	if _, err := p.postgres(context.Background(), "owner-project", "SELECT 1"); err == nil {
		t.Fatal("accepted unrelated DB")
	}
	if _, err := p.databaseSecurity(context.Background(), "owner-project"); err == nil {
		t.Fatal("observed unrelated security")
	}
}
