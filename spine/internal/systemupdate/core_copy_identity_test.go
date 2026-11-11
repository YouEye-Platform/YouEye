package systemupdate

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func TestIndependentCopyIdentityPairRecoversAnInterruptedWrite(t *testing.T) {
	selection, root := copyFixture(t)
	m := CoreManager{Root: filepath.Join(root, "core")}
	source := appliance.StateRecord{SchemaVersion: 2, Lifecycle: appliance.LifecycleConfigured, InstallIDRef: "install:source", DeviceIDRef: "device:source", DiskLayoutVersion: 3, StatePartUUID: "state", DataPartUUID: "data", ParentDiskID: "disk:source", DataSchemaVersion: 1, Slots: appliance.SlotState{Current: "A", CurrentImageVersion: "1.0.0"}, RecoveryVersion: "1"}
	statePath, dataPath := filepath.Join(root, "state", "appliance-state.json"), filepath.Join(root, "data", ".youeye-data-schema.json")
	if err := appliance.WriteStateAtomic(statePath, source); err != nil {
		t.Fatal(err)
	}
	data := appliance.DataSchemaRecord{SchemaVersion: 1, InstallIDRef: source.InstallIDRef}
	if err := appliance.WriteDataSchemaAtomic(dataPath, data); err != nil {
		t.Fatal(err)
	}
	sample := filepath.Join(root, "data", "sample.txt")
	if err := os.WriteFile(sample, []byte("ordinary test data"), 0600); err != nil {
		t.Fatal(err)
	}
	receipt, err := m.Initialize(context.Background(), selection, checksum(selection.Raw), func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		return copyMachine(source), "fixture native source", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	req := CoreCopyRequest{RequestID: "copy-pair", SourceHardware: "smbios:11111111-1111-1111-1111-111111111111", DestinationHardware: "smbios:22222222-2222-2222-2222-222222222222", SourceReceiptSHA256: CoreReceiptDigest(receipt), ManifestSHA256: receipt.ManifestSHA256}
	obs := CopyDiskObservation{Hardware: req.DestinationHardware, Manifest: appliance.Manifest{DiskLayoutVersion: 3, StateSchemaMin: 2, StateSchemaMax: 2, DataSchemaMin: 1, DataSchemaMax: 1}, Partitions: appliance.PartitionContract{StatePartUUID: "state", DataPartUUID: "data", StateParentID: "destination-disk"}}
	observe := func() (CopyDiskObservation, error) { return obs, nil }
	if _, err = m.PrepareIndependentCopyIdentity(req, statePath, dataPath, observe); err == nil {
		t.Fatal("unadmitted copy changed identity")
	}
	if err = m.BeginIndependentCopy(req, func() (string, error) { return req.SourceHardware, nil }); err == nil {
		t.Fatal("copy admitted on source hardware")
	}
	if err = m.BeginIndependentCopy(req, func() (string, error) { return obs.Hardware, nil }); err != nil {
		t.Fatal(err)
	}
	machine, err := m.PrepareIndependentCopyIdentity(req, statePath, dataPath, observe)
	if err != nil {
		t.Fatal(err)
	}
	if machine.InstallIDRef == source.InstallIDRef || machine.DeviceIDRef == source.DeviceIDRef {
		t.Fatal("source machine authority retained")
	}
	// A crash after the state rename but before the data rename has this pair.
	if err = appliance.WriteDataSchemaAtomic(dataPath, data); err != nil {
		t.Fatal(err)
	}
	again, err := m.PrepareIndependentCopyIdentity(req, statePath, dataPath, observe)
	if err != nil || again != machine {
		t.Fatal("retry changed identity or failed to recover pair", err)
	}
	owned, err := appliance.LoadDataSchema(dataPath)
	if err != nil || owned.InstallIDRef != machine.InstallIDRef {
		t.Fatal("paired data ownership not recovered", err)
	}
	current, err := appliance.LoadState(statePath)
	if err != nil || current.Slots != source.Slots || current.DataSchemaVersion != source.DataSchemaVersion {
		t.Fatal("copy changed slots or schema", err)
	}
	if got, _ := os.ReadFile(sample); string(got) != "ordinary test data" {
		t.Fatal("copy changed ordinary data")
	}
	if got, err := m.ReadReceipt(); err != nil || CoreReceiptDigest(got) != CoreReceiptDigest(receipt) {
		t.Fatal("identity preparation forged installed acceptance", err)
	}
	obs.Hardware = req.SourceHardware
	if _, err = m.PrepareIndependentCopyIdentity(req, statePath, dataPath, observe); err == nil {
		t.Fatal("retry admitted different hardware")
	}
	obs.Hardware = req.DestinationHardware
	current.Lifecycle = appliance.LifecycleRepairRequired
	if err = appliance.WriteStateAtomic(statePath, current); err != nil {
		t.Fatal(err)
	}
	if _, err = m.PrepareIndependentCopyIdentity(req, statePath, dataPath, observe); err == nil {
		t.Fatal("retry overwrote unrelated state mutation")
	}
}
