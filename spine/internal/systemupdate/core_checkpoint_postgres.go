package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strings"
	"time"
)

type CoreCheckpointDatabase struct {
	Name           string `json:"name"`
	Owner          string `json:"owner"`
	SizeBytes      int64  `json:"size_bytes"`
	SecuritySHA256 string `json:"security_sha256"`
	RestoreState   string `json:"restore_state,omitempty"`
	DumpState      string `json:"dump_state,omitempty"`
	DumpSHA256     string `json:"dump_sha256,omitempty"`
	DumpBytes      int64  `json:"dump_bytes,omitempty"`
}

func corePlatformDatabase(name string) bool {
	return name == "youeye" || name == "youeye_ui" || name == "pointer"
}

func (p NativeCoreCheckpoint) postgres(ctx context.Context, database, query string) ([]byte, error) {
	if database != "postgres" && !corePlatformDatabase(database) {
		return nil, fmt.Errorf("database is outside the core checkpoint scope")
	}
	return p.capture(ctx, "incus", "exec", "youeye-postgres", "--mode=non-interactive", "--", "psql", "--no-psqlrc", "--username=youeye", "--dbname="+database, "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--command", query)
}

// InspectDatabases requires writer closure. Stopped clients are not proof of
// revocation, so rollback also compares current role, ACL and security-row
// fingerprints. A changed authority is preserved by refusing historical restore.
// Only digests leave this private observation; no credentials/SQL rows are saved.
func (p NativeCoreCheckpoint) InspectDatabases(ctx context.Context) ([]CoreCheckpointDatabase, error) {
	if err := p.requireClosedDatabaseWriters(ctx); err != nil {
		return nil, err
	}
	databases, err := p.inspectDatabaseSizes(ctx)
	if err != nil {
		return nil, err
	}
	for i := range databases {
		digest, err := p.databaseSecurity(ctx, databases[i].Name)
		if err != nil {
			return nil, err
		}
		databases[i].SecuritySHA256 = digest
	}
	return databases, nil
}

// Writer settlement is independent of capture size/schema support. A failed
// preflight must remain recoverable without requiring the archive that failed
// preflight. Actual capture and restoration additionally inspect full authority.
func (p NativeCoreCheckpoint) requireClosedDatabaseWriters(ctx context.Context) error {
	writers, err := p.postgres(ctx, "postgres", `SELECT count(*) FROM pg_stat_activity WHERE datname IN ('youeye','youeye_ui','pointer') AND pid <> pg_backend_pid()`)
	if err != nil || strings.TrimSpace(string(writers)) != "0" {
		return fmt.Errorf("platform database writers are not closed")
	}
	return nil
}

// Size/owner observation is safe while writers are live. It authorizes neither
// snapshot nor restore; actual capture still requires complete writer closure.
func (p NativeCoreCheckpoint) inspectDatabaseSizes(ctx context.Context) ([]CoreCheckpointDatabase, error) {
	raw, err := p.postgres(ctx, "postgres", `SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (SELECT datname AS name, pg_get_userbyid(datdba) AS owner, pg_database_size(oid) AS size_bytes FROM pg_database WHERE datname IN ('youeye','youeye_ui','pointer') ORDER BY datname) x`)
	if err != nil {
		return nil, err
	}
	var databases []CoreCheckpointDatabase
	if json.Unmarshal(raw, &databases) != nil {
		return nil, fmt.Errorf("platform database observation is invalid")
	}
	seen := map[string]bool{}
	for i := range databases {
		db := &databases[i]
		if !corePlatformDatabase(db.Name) || db.Owner != "youeye" || db.SizeBytes <= 0 || db.SizeBytes > 8<<30 || seen[db.Name] {
			return nil, fmt.Errorf("platform database ownership is unsupported")
		}
		seen[db.Name] = true
	}
	if !seen["youeye"] || !seen["youeye_ui"] {
		return nil, fmt.Errorf("required platform database is absent")
	}
	return databases, nil
}

func (p NativeCoreCheckpoint) databaseSecurity(ctx context.Context, database string) (string, error) {
	if !corePlatformDatabase(database) {
		return "", fmt.Errorf("core database required")
	}
	hash := sha256.New()
	// Role passwords and memberships remain on the live PostgreSQL cluster; a
	// logical core rollback never recreates roles from an archived catalog.
	queries := []string{
		`SELECT row_to_json(r)::text FROM pg_authid r ORDER BY rolname`,
		`SELECT row_to_json(r)::text FROM pg_auth_members r ORDER BY roleid,member,grantor`,
		`SELECT json_build_array(datname,datdba,datacl)::text FROM pg_database ORDER BY datname`,
		`SELECT json_build_array(nspname,nspowner,nspacl)::text FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' ORDER BY nspname`,
		`SELECT json_build_array(n.nspname,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname`,
		`SELECT json_build_array(d.defaclrole,COALESCE(n.nspname,''),d.defaclobjtype,d.defaclacl)::text FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace ORDER BY d.defaclrole,n.nspname,d.defaclobjtype`,
		`SELECT row_to_json(r)::text FROM pg_db_role_setting r ORDER BY setdatabase,setrole`,
		`SELECT json_build_array(n.nspname,c.relname,a.attname,a.attacl)::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE a.attacl IS NOT NULL AND NOT a.attisdropped AND n.nspname NOT LIKE 'pg_%' ORDER BY n.nspname,c.relname,a.attname`,
		`SELECT row_to_json(r)::text FROM pg_policies r ORDER BY schemaname,tablename,policyname`,
		`SELECT json_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.proowner,p.proacl,p.prosecdef,p.proconfig,CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) ELSE p.prosrc END)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`,
		`SELECT json_build_array(n.nspname,t.typname,t.typowner,t.typacl)::text FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typacl IS NOT NULL AND n.nspname NOT LIKE 'pg_%' ORDER BY n.nspname,t.typname`,
		`SELECT json_build_array(n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid))::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname NOT LIKE 'pg_%' ORDER BY n.nspname,c.relname,t.tgname`,
		`SELECT json_build_array(evtname,evtevent,evtowner,evtfoid::regprocedure::text,evtenabled,evttags)::text FROM pg_event_trigger ORDER BY evtname`,
		`SELECT json_build_array(oid,lomowner,lomacl)::text FROM pg_largeobject_metadata ORDER BY oid`,
	}
	for _, query := range queries {
		raw, err := p.hashPostgresQuery(ctx, database, query)
		if err != nil {
			return "", err
		}
		_, _ = hash.Write(raw)
		_, _ = hash.Write([]byte{0})
	}
	// Keep every identity security table; new compatible tables are included
	// automatically. Pointer is independently versioned and is never migrated
	// by the core transaction: preserve all of its rows rather than guessing
	// which future table names might carry security decisions.
	predicate := `tablename LIKE 'identity\_%' ESCAPE '\'`
	if database == "youeye_ui" {
		predicate = `tablename IN ('users','admission_projections','identity_deletions','app_service_credentials','user_encryption_keys','pin_sessions','app_permissions','permission_audit')`
	}
	if database == "pointer" {
		predicate = `TRUE`
	}
	raw, err := p.postgres(ctx, database, `SELECT COALESCE(json_agg(tablename ORDER BY tablename), '[]'::json) FROM pg_tables WHERE schemaname='public' AND (`+predicate+`)`)
	if err != nil {
		return "", err
	}
	var tables []string
	if json.Unmarshal(raw, &tables) != nil {
		return "", fmt.Errorf("core security table observation is invalid")
	}
	sort.Strings(tables)
	for _, table := range tables {
		if table == "" || len(table) > 63 || strings.Trim(table, "abcdefghijklmnopqrstuvwxyz0123456789_") != "" {
			return "", fmt.Errorf("unsupported core security table identifier")
		}
		rows, err := p.hashPostgresQuery(ctx, database, `SELECT row_to_json(r)::text FROM public."`+table+`" r ORDER BY row_to_json(r)::text`)
		if err != nil {
			return "", err
		}
		_, _ = hash.Write([]byte(table + "\x00"))
		_, _ = hash.Write(rows)
		_, _ = hash.Write([]byte{0})
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

// Stream private rows directly into a digest, avoiding an in-memory copy or a
// diagnostic log. The injected fixture transport is bounded by its test owner.
func (p NativeCoreCheckpoint) hashPostgresQuery(ctx context.Context, database, query string) ([]byte, error) {
	if !corePlatformDatabase(database) {
		return nil, fmt.Errorf("core database required")
	}
	hash := sha256.New()
	if p.Capture != nil {
		rows, err := p.postgres(ctx, database, query)
		if err != nil {
			return nil, err
		}
		_, _ = hash.Write(rows)
	} else {
		ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "incus", "--force-local", "--project", "default", "exec", "youeye-postgres", "--mode=non-interactive", "--", "psql", "--no-psqlrc", "--username=youeye", "--dbname="+database, "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--command", query)
		cmd.Stdout, cmd.Stderr = hash, io.Discard
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("core security observation failed")
		}
	}
	return hash.Sum(nil), nil
}

func (p NativeCoreCheckpoint) VerifyDatabaseSecurity(ctx context.Context, databases []CoreCheckpointDatabase) error {
	for _, db := range databases {
		if !validSHA256(db.SecuritySHA256) {
			return fmt.Errorf("retained security fingerprint required")
		}
		digest, err := p.databaseSecurity(ctx, db.Name)
		if err != nil {
			return err
		}
		if digest != db.SecuritySHA256 {
			return fmt.Errorf("core authority changed; retain current security and paired checkpoint for recovery")
		}
	}
	return nil
}
