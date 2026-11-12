package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreInitializeRequiresFreshNativeEvidenceAndPreservesMachineBinding(t *testing.T) {
	selection, root := copyFixture(t)
	raw := selection.Raw
	m := CoreManager{Root: filepath.Join(root, "state"), Executor: &coreTestExecutor{}}
	machine := CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state", DataPartUUID: "data"}
	fail := true
	verify := func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		if fail {
			return machine, "", fmt.Errorf("fixture service health failed")
		}
		return machine, "fixture installed membership and health", nil
	}
	ctx := context.Background()
	if _, err := m.Initialize(ctx, selection, checksum(raw), verify); err == nil {
		t.Fatal("failed health initialized receipt")
	}
	if _, err := os.Stat(filepath.Join(m.Root, "committed.json")); !os.IsNotExist(err) {
		t.Fatal("failed initialization wrote receipt", err)
	}
	fail = false
	accepted, err := m.Initialize(ctx, selection, checksum(raw), verify)
	if err != nil || accepted.Machine != machine || accepted.ManifestSHA256 != checksum(raw) {
		t.Fatal(accepted, err)
	}
	if receipt, err := m.ReadReceipt(); err != nil || receipt.Machine != machine {
		t.Fatal(receipt, err)
	}
	if again, err := m.Initialize(ctx, selection, checksum(raw), verify); err != nil || again.AcceptedAt != accepted.AcceptedAt {
		t.Fatal(again, err)
	}
	machine.DeviceIDRef = "device:another"
	if _, err := m.Initialize(ctx, selection, checksum(raw), verify); err == nil {
		t.Fatal("fresh receipt rebound to another machine")
	}
	if receipt, err := m.ReadReceipt(); err != nil || receipt.Machine != accepted.Machine {
		t.Fatal(receipt, err)
	}
	// Losing an accepted target file is recovery work, not an absent receipt
	// permitting a fresh initializer to overwrite the installation record.
	machine = accepted.Machine
	if err := os.Remove(filepath.Join(m.Root, "targets", accepted.ManifestSHA256+".json")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Initialize(ctx, selection, checksum(raw), verify); err == nil {
		t.Fatal("missing retained input was treated as an uninitialized install")
	}

}

func copyFixture(t *testing.T) (CoreHostSelection, string) {
	t.Helper()
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(r)
	return CoreHostSelection{Raw: raw}, t.TempDir()
}
