package systemupdate

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

// Only the platform service role changes. Local product users, app owners,
// databases, schema and grants are preserved. App database roles have their own
// native app preparation, after the CP can use the new platform credential.
func (m CoreManager) PrepareIndependentCopyPostgres(ctx context.Context, request CoreCopyRequest, b CoreLifecycleBarrier, p NativeCoreCheckpoint, observeHardware func() (string, error)) error {
	if err := m.CheckIndependentCopyRuntime(ctx, request, b, p, observeHardware); err != nil {
		return err
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return err
	}
	defer unlock()
	raw, err := ReadCoreState(filepath.Join(m.Root, "copy-runtime-authority.json"), 4<<20)
	var journal copyAuthorityJournal
	if err != nil || json.Unmarshal(raw, &journal) != nil || journal.Request != request || !journal.Prepared || validateCopyAuthorityFiles(journal.Files, p.DataRoot) != nil {
		return fmt.Errorf("prepared database authority required")
	}
	var secret copyAuthorityFile
	for _, f := range journal.Files {
		if f.Container == "" && f.Path == filepath.Join(p.DataRoot, "postgres/.pg_password") {
			secret = f
		}
	}
	if secret.Content == "" {
		return fmt.Errorf("prepared database credential absent")
	}
	actual, err := readCopyAuthorityFile(ctx, p, secret)
	if err != nil || string(actual) != secret.Content {
		return fmt.Errorf("prepared database credential changed")
	}
	config, err := p.capture(ctx, "incus", "config", "get", "youeye-postgres", "environment.POSTGRES_PASSWORD")
	if err != nil {
		return fmt.Errorf("database container credential unavailable")
	}
	before := strings.TrimSpace(string(config))
	if before != secret.Content {
		if copyAuthorityDigest([]byte(before)) != secret.SourceSHA256 && copyAuthorityDigest([]byte(before+"\n")) != secret.SourceSHA256 {
			return fmt.Errorf("database container credential differs from copied source")
		}
		if _, err = p.capture(ctx, "incus", "config", "set", "youeye-postgres", "environment.POSTGRES_PASSWORD", secret.Content); err != nil {
			return fmt.Errorf("database container credential requires reconciliation")
		}
	}
	// Incus environment carries the secret; SQL/diagnostics never include it.
	encoded := base64.StdEncoding.EncodeToString([]byte(secret.Content))
	query := `DO $copy$ BEGIN EXECUTE format('ALTER ROLE youeye PASSWORD %L',convert_from(decode(current_setting('youeye.copy_password'),'base64'),'UTF8')); END $copy$;`
	if _, err = p.capture(ctx, "incus", "exec", "youeye-postgres", "--env", "PGOPTIONS=-c youeye.copy_password="+encoded, "--", "psql", "--no-psqlrc", "-U", "youeye", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tAc", query); err != nil {
		return fmt.Errorf("database role credential requires reconciliation")
	}
	proof, err := p.capture(ctx, "incus", "exec", "youeye-postgres", "--env", "PGPASSWORD="+secret.Content, "--", "psql", "--no-psqlrc", "-h", "127.0.0.1", "-U", "youeye", "-d", "youeye", "-v", "ON_ERROR_STOP=1", "-tAc", "SELECT 1")
	if err != nil || strings.TrimSpace(string(proof)) != "1" {
		return fmt.Errorf("new platform database password failed authenticated verification")
	}
	return nil
}
