package appliance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validStateRecord() StateRecord {
	return StateRecord{
		SchemaVersion:     CurrentStateSchema,
		Lifecycle:         LifecycleConfigured,
		InstallIDRef:      "install:opaque",
		DeviceIDRef:       "device:opaque",
		DiskLayoutVersion: CurrentDiskLayout,
		StatePartUUID:     "state-partuuid",
		DataPartUUID:      "data-partuuid",
		ParentDiskID:      "disk:opaque",
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

// The seed Spine reads appliance-state.json on every boot: a field or
// lifecycle value a newer Spine wrote must neither stop the boot nor be lost
// when this Spine rewrites the file.
func TestStateToleratesAndKeepsNewerFields(t *testing.T) {
	data, err := json.Marshal(validStateRecord())
	if err != nil {
		t.Fatal(err)
	}
	newer := strings.TrimSuffix(string(data), "}") + `,"console_accounts_ref":"x","slots_note":{"a":1}}`
	newer = strings.Replace(newer, `"lifecycle":"configured"`, `"lifecycle":"migrating"`, 1)
	state, err := ParseState([]byte(newer))
	if err != nil {
		t.Fatal(err)
	}
	if state.Lifecycle.Known() || state.Lifecycle == LifecycleConfigured {
		t.Fatalf("unknown lifecycle must count as not configured: %q", state.Lifecycle)
	}
	path := filepath.Join(t.TempDir(), "appliance-state.json")
	if err := os.WriteFile(path, []byte(newer), 0o600); err != nil {
		t.Fatal(err)
	}
	state.RecoveryVersion = "rewritten"
	if err := WriteStateAtomic(path, state); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	for _, want := range []string{`"console_accounts_ref": "x"`, `"slots_note"`, `"lifecycle": "migrating"`, `"recovery_version": "rewritten"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("rewrite lost %s:\n%s", want, raw)
		}
	}
	if _, err := ParseState([]byte(strings.Replace(newer, `"lifecycle":"migrating"`, `"lifecycle":"Bad Value"`, 1))); err == nil {
		t.Fatal("malformed lifecycle accepted")
	}
	incomplete := validStateRecord()
	incomplete.Slots.CurrentImageVersion = ""
	if err := incomplete.Validate(); err == nil {
		t.Fatal("expected current slot image version to be required")
	}
}

func TestTransactionRequiresManifestAndActiveSlot(t *testing.T) {
	state := validStateRecord()
	state.Slots.Candidate = "B"
	state.Slots.CandidateImageVersion = "0.2.0"
	state.Transaction = TransactionState{
		ID: "update-test", Stage: "staged", TargetImageVersion: "0.2.0",
	}
	if err := state.Validate(); err == nil {
		t.Fatal("transaction without manifest and active slot was accepted")
	}
	state.Transaction.ManifestSHA256 = strings.Repeat("a", 64)
	if err := state.Validate(); err == nil {
		t.Fatal("partially expanded transaction was accepted")
	}
	state.Transaction.ActiveSlot = "A"
	if err := state.Validate(); err != nil {
		t.Fatalf("complete transaction rejected: %v", err)
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
	if one != two || !strings.HasPrefix(one, "disk:") {
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
	state.ParentDiskID = DiskReference(contract)
	if err := ValidateStateContract(manifest, state, contract); err == nil {
		t.Fatal("expected layout 2 state to require recovery")
	}
}
