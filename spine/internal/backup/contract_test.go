package backup

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The CP writes this body (control-panel/tests/spine-contract.spec.ts); Spine
// decodes it as handleBackupRepositoryStore does, rejecting unknown fields.
func TestStoreRequestContractFromControlPanel(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "spine-cp", "backup-store-request.json"))
	if err != nil {
		t.Fatal(err)
	}
	var request RepositoryStoreRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		t.Fatalf("Spine rejects the CP's store request: %v", err)
	}
	if err := validateBackupSource(request.Source); err != nil {
		t.Fatalf("Spine rejects the CP's source identity: %v", err)
	}
	if request.Source.SourceTree == "" || !request.UseStoredPassphrase || len(request.Apps) == 0 {
		t.Fatalf("store request lost fields: %+v", request)
	}
	// From 0.6.12 the CP sends the releases' keys, which Spine keeps with the
	// recovery point.
	source := request.Source
	for name, release := range map[string]*BackupRelease{"release": source.Release, "control_panel": source.ControlPanel, "ui": source.UI, "pointer": source.Pointer} {
		if release == nil || release.Line == "" || release.Sequence <= 0 {
			t.Fatalf("store request has no %s release key: %+v", name, release)
		}
	}
}
