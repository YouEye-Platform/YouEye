package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

// The CP builds its backup source identity from the status document Spine
// serves (statusDocument; control-panel/tests/spine-contract.spec.ts reads
// the same fixture).
func TestStatusContractForBackupIdentity(t *testing.T) {
	persistent := appliance.PersistentStatus{
		Available: true, Lifecycle: appliance.LifecycleConfigured,
		StateSchemaVersion: appliance.CurrentStateSchema, DataSchemaVersion: appliance.CurrentDataSchema,
		DiskLayoutVersion: 1, Compatibility: appliance.Compatibility{State: "compatible", Data: "compatible", Compatible: true},
	}
	status := statusDocument("0.6.5-dev.1", "7.0.1", "Debian GNU/Linux 13 (trixie)",
		map[string]interface{}{"status": "running", "version": "0.6.5-dev.1"},
		map[string]interface{}{"status": "running", "installed": true, "enabled": true, "version": "0.6.5-dev.1"},
		appliance.RuntimeStatus{
			Kind: appliance.RuntimeApplianceImage, ManifestValid: true, ImageVersion: "0.6.5-dev.1",
			BuildID: "youeye-0.6.5-dev.1", SourceTree: "1844da69b0c3e0b0b8a7c1a2d3e4f5a6b7c8d9e0",
			Architecture: "amd64", FirmwareMode: "uefi", DiskLayoutVersion: 1, ArtifactKind: "development",
		}, &persistent, "")
	got, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	checkContractFixture(t, "status-appliance.json", append(got, '\n'))
}

func checkContractFixture(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("..", "..", "..", "contracts", "spine-cp", name)
	if os.Getenv("YOUEYE_UPDATE_CONTRACTS") == "1" {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != string(got) {
		t.Fatalf("%s changed; regenerate with YOUEYE_UPDATE_CONTRACTS=1 and run the CP contract test\nwant:\n%s\ngot:\n%s", name, want, got)
	}
}
