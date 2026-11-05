package appliance

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type plan1TransactionState struct {
	ID                 string `json:"id,omitempty"`
	Stage              string `json:"stage,omitempty"`
	TargetImageVersion string `json:"target_image_version,omitempty"`
}

type plan1StateRecord struct {
	SchemaVersion     int                   `json:"schema_version"`
	Lifecycle         Lifecycle             `json:"lifecycle"`
	InstallIDRef      string                `json:"install_id_ref"`
	DeviceIDRef       string                `json:"device_id_ref"`
	DiskLayoutVersion int                   `json:"disk_layout_version"`
	StatePartUUID     string                `json:"state_partuuid"`
	DataPartUUID      string                `json:"data_partuuid"`
	ParentDiskID      string                `json:"parent_disk_id"`
	DataSchemaVersion int                   `json:"data_schema_version"`
	Slots             SlotState             `json:"slots"`
	Transaction       plan1TransactionState `json:"transaction,omitempty"`
	RecoveryVersion   string                `json:"recovery_version"`
}

func validStateRecord() StateRecord {
	return StateRecord{
		SchemaVersion:     CurrentStateSchema,
		Lifecycle:         LifecycleConfigured,
		InstallIDRef:      "install:opaque",
		DeviceIDRef:       "device:opaque",
		DiskLayoutVersion: CurrentDiskLayout,
		StatePartUUID:     "state-partuuid",
		DataPartUUID:      "data-partuuid",
		ParentDiskID:      "disk-v3:opaque",
		DataSchemaVersion: CurrentDataSchema,
		Slots:             SlotState{Current: "A", CurrentImageVersion: "0.1.0"},
		RecoveryVersion:   "1",
	}
}

func TestStateRecordAtomicRoundTripUsesPrivateMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "appliance-state.json")
	want := validStateRecord()
	if err := WriteStateAtomic(path, want); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Fatalf("state mode=%04o want 0600", got)
	}
	got, err := LoadState(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.InstallIDRef != want.InstallIDRef || got.Slots != want.Slots || got.Lifecycle != want.Lifecycle {
		t.Fatalf("state round trip mismatch: %+v", got)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(path) {
		t.Fatalf("atomic write left temporary files: %v", entries)
	}
}

func TestParseStateRejectsUnknownFieldsAndIncompleteSlot(t *testing.T) {
	data, err := json.Marshal(validStateRecord())
	if err != nil {
		t.Fatal(err)
	}
	withUnknown := strings.TrimSuffix(string(data), "}") + `,"raw_device_id":"forbidden"}`
	if _, err := ParseState([]byte(withUnknown)); err == nil {
		t.Fatal("expected strict unknown-field rejection")
	}

	state := validStateRecord()
	state.Slots.CurrentImageVersion = ""
	if err := state.Validate(); err == nil {
		t.Fatal("expected current slot image version to be required")
	}
}

func TestPlan1CompatibleTransactionUsesOnlyLegacyStateFields(t *testing.T) {
	state := validStateRecord()
	state.Slots.Candidate = "B"
	state.Slots.CandidateImageVersion = "0.2.0"
	state.Transaction = TransactionState{
		ID: "update-test", Stage: "staged", TargetImageVersion: "0.2.0",
	}
	path := filepath.Join(t.TempDir(), "appliance-state.json")
	if err := WriteStateAtomic(path, state); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var old plan1StateRecord
	if err := decoder.Decode(&old); err != nil {
		t.Fatalf("Plan 1 parser rejected bootstrap State: %v\n%s", err, raw)
	}
	if old.Transaction.ID != state.Transaction.ID || !state.Transaction.Plan1Compatible() {
		t.Fatalf("legacy transaction mismatch: %+v", old.Transaction)
	}

	state.Transaction.ManifestSHA256 = strings.Repeat("a", 64)
	if err := state.Validate(); err == nil {
		t.Fatal("partially expanded transaction was accepted")
	}
}

func TestSystemSlotFromKernelCommandLine(t *testing.T) {
	for _, tc := range []struct {
		name, cmdline, want string
		wantErr             bool
	}{
		{name: "A", cmdline: "quiet root=PARTLABEL=YE-SYSTEM-A ro", want: "A"},
		{name: "B", cmdline: "root=PARTLABEL=YE-SYSTEM-B console=ttyS0", want: "B"},
		{name: "missing", cmdline: "root=/dev/sda3 ro", wantErr: true},
		{name: "ambiguous", cmdline: "root=PARTLABEL=YE-SYSTEM-A root=PARTLABEL=YE-SYSTEM-B", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := SystemSlotFromKernelCommandLine(tc.cmdline)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got slot %q", got)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("slot=%q err=%v want %q", got, err, tc.want)
			}
		})
	}
}

func TestCommitHealthySlotPromotesAndIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "appliance-state.json")
	state := validStateRecord()
	state.Slots.Candidate = "B"
	state.Slots.CandidateImageVersion = "0.2.0"
	if err := WriteStateAtomic(path, state); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{ImageVersion: "0.2.0"}
	got, err := CommitHealthySlot(path, manifest, "root=PARTLABEL=YE-SYSTEM-B ro")
	if err != nil {
		t.Fatal(err)
	}
	want := SlotState{
		Current: "B", CurrentImageVersion: "0.2.0",
		Previous: "A", PreviousImageVersion: "0.1.0",
	}
	if got.Slots != want {
		t.Fatalf("slots=%+v want %+v", got.Slots, want)
	}
	again, err := CommitHealthySlot(path, manifest, "root=PARTLABEL=YE-SYSTEM-B ro")
	if err != nil {
		t.Fatal(err)
	}
	if again.Slots != want {
		t.Fatalf("idempotent slots=%+v want %+v", again.Slots, want)
	}
}

func TestCommitHealthySlotRejectsSameSlotVersionDrift(t *testing.T) {
	path := filepath.Join(t.TempDir(), "appliance-state.json")
	if err := WriteStateAtomic(path, validStateRecord()); err != nil {
		t.Fatal(err)
	}
	if _, err := CommitHealthySlot(path, Manifest{ImageVersion: "0.2.0"}, "root=PARTLABEL=YE-SYSTEM-A"); err == nil {
		t.Fatal("expected same-slot version drift to fail closed")
	}
}

func TestPersistentStatusJSONOmitsRawIdentity(t *testing.T) {
	status := PersistentStatus{
		Available:          true,
		Lifecycle:          LifecycleConfigured,
		StateSchemaVersion: 1,
		DataSchemaVersion:  1,
		DiskLayoutVersion:  1,
		Slots:              SlotState{Current: "A", CurrentImageVersion: "0.1.0"},
	}
	data, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"install_id", "device_id", "partuuid", "parent_disk", "transaction_id"} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("public status exposed %q: %s", forbidden, data)
		}
	}
}

func TestDiskReferenceIsStableAndDoesNotEmbedPartitionIDs(t *testing.T) {
	contract := PartitionContract{
		StateParentDevice: "/dev/sda", StateParentID: "serial:appliance-secret", StatePartUUID: "STATE-SECRET",
		DataParentDevice: "/dev/sda", DataParentID: "serial:appliance-secret", DataPartUUID: "DATA-SECRET",
	}
	one := DiskReference(contract)
	contract.StateParentDevice = "/dev/vdz"
	contract.DataParentDevice = "/dev/vda"
	two := DiskReference(contract)
	if one != two || !strings.HasPrefix(one, "disk-v3:") {
		t.Fatalf("unstable disk reference: %q %q", one, two)
	}
	for _, raw := range []string{contract.StatePartUUID, contract.DataPartUUID, contract.StateParentID, contract.DataParentID} {
		if strings.Contains(one, raw) {
			t.Fatalf("disk reference embeds raw identity %q: %q", raw, one)
		}
	}
}

func TestLayoutTwoStateIsNotReinterpretedAsLayoutThree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "appliance-state.json")
	state := validStateRecord()
	state.DiskLayoutVersion = 2
	state.ParentDiskID = "disk:legacy-path-dependent"
	if err := WriteStateAtomic(path, state); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{
		DiskLayoutVersion: CurrentDiskLayout,
		StateSchemaMin:    CurrentStateSchema, StateSchemaMax: CurrentStateSchema,
		DataSchemaMin: 1, DataSchemaMax: 1,
	}
	contract := PartitionContract{
		StatePartUUID: state.StatePartUUID, StateParentID: "serial:appliance",
		DataPartUUID: state.DataPartUUID, DataParentID: "serial:appliance",
	}
	if _, err := migrateLegacyDiskReference(path, manifest, state, contract); err == nil {
		t.Fatal("expected layout 2 state to require recovery rather than migration")
	}
}
