package appliance

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	StateMountpoint    = "/var/lib/youeye-state"
	StatePath          = StateMountpoint + "/appliance-state.json"
	DataMountpoint     = "/var/lib/youeye"
	DataSchemaPath     = DataMountpoint + "/.youeye-data-schema.json"
	CurrentStateSchema = 2
	CurrentDataSchema  = 1
)

type Lifecycle string

const (
	LifecycleUnconfigured   Lifecycle = "unconfigured"
	LifecycleConfigured     Lifecycle = "configured"
	LifecycleRepairRequired Lifecycle = "repair-required"
	LifecycleFactory        Lifecycle = "factory"
)

type SlotState struct {
	Current               string `json:"current"`
	CurrentImageVersion   string `json:"current_image_version"`
	Previous              string `json:"previous,omitempty"`
	PreviousImageVersion  string `json:"previous_image_version,omitempty"`
	Candidate             string `json:"candidate,omitempty"`
	CandidateImageVersion string `json:"candidate_image_version,omitempty"`
}

type TransactionState struct {
	ID                 string `json:"id,omitempty"`
	ManifestSHA256     string `json:"manifest_sha256,omitempty"`
	Stage              string `json:"stage,omitempty"`
	ActiveSlot         string `json:"active_slot,omitempty"`
	TargetImageVersion string `json:"target_image_version,omitempty"`
}

// Plan1Compatible reports whether the transaction uses only the fields that
// the accepted Plan 1 image can decode. The full signed version remains in
// the system-update journal until the first native image is blessed.
func (t TransactionState) Plan1Compatible() bool {
	return t.ID != "" && t.ManifestSHA256 == "" && t.ActiveSlot == ""
}

// StateRecord lives on YE-STATE. Identity references are opaque, non-secret
// handles; status surfaces must never expose their raw values.
type StateRecord struct {
	SchemaVersion     int       `json:"schema_version"`
	Lifecycle         Lifecycle `json:"lifecycle"`
	InstallIDRef      string    `json:"install_id_ref"`
	DeviceIDRef       string    `json:"device_id_ref"`
	DiskLayoutVersion int       `json:"disk_layout_version"`
	StatePartUUID     string    `json:"state_partuuid"`
	DataPartUUID      string    `json:"data_partuuid"`
	// ParentDiskID is an opaque hash of the persistent layout identity. It
	// covers the one stable parent plus the distinct YE-STATE and YE-DATA
	// partition identities.
	ParentDiskID      string           `json:"parent_disk_id"`
	DataSchemaVersion int              `json:"data_schema_version"`
	Slots             SlotState        `json:"slots"`
	Transaction       TransactionState `json:"transaction,omitempty"`
	RecoveryVersion   string           `json:"recovery_version"`
}

type DataSchemaRecord struct {
	SchemaVersion int    `json:"schema_version"`
	InstallIDRef  string `json:"install_id_ref"`
}

type Compatibility struct {
	State          string `json:"state"`
	Data           string `json:"data"`
	Compatible     bool   `json:"compatible"`
	RepairRequired bool   `json:"repair_required"`
}

type PersistentStatus struct {
	Available          bool          `json:"available"`
	Lifecycle          Lifecycle     `json:"lifecycle,omitempty"`
	StateSchemaVersion int           `json:"state_schema_version,omitempty"`
	DataSchemaVersion  int           `json:"data_schema_version,omitempty"`
	DiskLayoutVersion  int           `json:"disk_layout_version,omitempty"`
	Compatibility      Compatibility `json:"compatibility"`
	Slots              SlotState     `json:"slots"`
	TransactionStage   string        `json:"transaction_stage,omitempty"`
	TargetImageVersion string        `json:"target_image_version,omitempty"`
	RecoveryVersion    string        `json:"recovery_version,omitempty"`
	ErrorCode          string        `json:"error_code,omitempty"`
}

// InspectPersistentStatus returns only non-sensitive appliance state. Raw
// installation, device, disk, and partition identity references are omitted.
func InspectPersistentStatus(m Manifest) (PersistentStatus, error) {
	state, err := LoadState(StatePath)
	if err != nil {
		return PersistentStatus{ErrorCode: "state_unavailable", Compatibility: Compatibility{RepairRequired: true}}, err
	}
	data, err := LoadDataSchema(DataSchemaPath)
	if err != nil {
		return PersistentStatus{Lifecycle: state.Lifecycle, StateSchemaVersion: state.SchemaVersion, ErrorCode: "data_schema_unavailable", Compatibility: Compatibility{RepairRequired: true}}, err
	}
	compat := CheckCompatibility(m, state.SchemaVersion, data.SchemaVersion)
	status := PersistentStatus{
		Available: true, Lifecycle: state.Lifecycle,
		StateSchemaVersion: state.SchemaVersion, DataSchemaVersion: data.SchemaVersion,
		DiskLayoutVersion: state.DiskLayoutVersion, Compatibility: compat,
		Slots: state.Slots, TransactionStage: state.Transaction.Stage,
		TargetImageVersion: state.Transaction.TargetImageVersion,
		RecoveryVersion:    state.RecoveryVersion,
	}
	if !compat.Compatible || state.Lifecycle == LifecycleRepairRequired {
		status.ErrorCode = "recovery_required"
		return status, errors.New("persistent appliance state requires recovery")
	}
	return status, nil
}

func CheckCompatibility(m Manifest, stateVersion, dataVersion int) Compatibility {
	state := compatibilityLabel(stateVersion, m.StateSchemaMin, m.StateSchemaMax)
	data := compatibilityLabel(dataVersion, m.DataSchemaMin, m.DataSchemaMax)
	ok := state == "compatible" && data == "compatible"
	return Compatibility{State: state, Data: data, Compatible: ok, RepairRequired: !ok}
}

func compatibilityLabel(current, min, max int) string {
	switch {
	case current < min:
		return "upgrade-required"
	case current > max:
		return "image-too-old"
	default:
		return "compatible"
	}
}

func ParseState(data []byte) (StateRecord, error) {
	var state StateRecord
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&state); err != nil {
		return state, fmt.Errorf("decode state: %w", err)
	}
	if err := requireJSONEOF(dec); err != nil {
		return state, err
	}
	if err := state.Validate(); err != nil {
		return state, err
	}
	return state, nil
}

func (s StateRecord) Validate() error {
	if s.SchemaVersion < 1 {
		return fmt.Errorf("state schema_version must be positive")
	}
	if s.DiskLayoutVersion < 1 {
		return fmt.Errorf("state disk_layout_version must be positive")
	}
	if s.DataSchemaVersion < 1 {
		return fmt.Errorf("state data_schema_version must be positive")
	}
	for name, value := range map[string]string{
		"install_id_ref": s.InstallIDRef, "device_id_ref": s.DeviceIDRef,
		"state_partuuid": s.StatePartUUID, "data_partuuid": s.DataPartUUID,
		"parent_disk_id": s.ParentDiskID, "recovery_version": s.RecoveryVersion,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("state %s is required", name)
		}
	}
	switch s.Lifecycle {
	case LifecycleUnconfigured, LifecycleConfigured, LifecycleRepairRequired, LifecycleFactory:
	default:
		return fmt.Errorf("invalid lifecycle %q", s.Lifecycle)
	}
	if !validSystemSlot(s.Slots.Current) {
		return fmt.Errorf("current slot must be A or B")
	}
	if strings.TrimSpace(s.Slots.CurrentImageVersion) == "" {
		return fmt.Errorf("current slot image version is required")
	}
	if (s.Slots.Previous == "") != (s.Slots.PreviousImageVersion == "") {
		return fmt.Errorf("previous slot and image version must be recorded together")
	}
	if s.Slots.Previous != "" && !validSystemSlot(s.Slots.Previous) {
		return fmt.Errorf("previous slot must be A or B")
	}
	if (s.Slots.Candidate == "") != (s.Slots.CandidateImageVersion == "") {
		return fmt.Errorf("candidate slot and image version must be recorded together")
	}
	if s.Slots.Candidate != "" && !validSystemSlot(s.Slots.Candidate) {
		return fmt.Errorf("candidate slot must be A or B")
	}
	transactionEmpty := s.Transaction == (TransactionState{})
	if !transactionEmpty {
		for name, value := range map[string]string{
			"id": s.Transaction.ID, "stage": s.Transaction.Stage,
			"target_image_version": s.Transaction.TargetImageVersion,
		} {
			if strings.TrimSpace(value) == "" {
				return fmt.Errorf("transaction %s is required", name)
			}
		}
		if s.Slots.Candidate == "" || s.Slots.CandidateImageVersion != s.Transaction.TargetImageVersion {
			return fmt.Errorf("transaction target must match the candidate slot identity")
		}
		if s.Transaction.Plan1Compatible() {
			return nil
		}
		if strings.TrimSpace(s.Transaction.ManifestSHA256) == "" || strings.TrimSpace(s.Transaction.ActiveSlot) == "" {
			return fmt.Errorf("transaction manifest_sha256 and active_slot must be recorded together")
		}
		if len(s.Transaction.ManifestSHA256) != 64 {
			return fmt.Errorf("transaction manifest_sha256 must be a SHA-256 value")
		}
		for _, r := range s.Transaction.ManifestSHA256 {
			if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
				return fmt.Errorf("transaction manifest_sha256 must be lowercase hexadecimal")
			}
		}
		if !validSystemSlot(s.Transaction.ActiveSlot) {
			return fmt.Errorf("transaction active slot is required")
		}
		if s.Slots.Candidate == s.Transaction.ActiveSlot {
			return fmt.Errorf("transaction candidate must be inactive")
		}
	}
	return nil
}

func validSystemSlot(slot string) bool {
	return slot == "A" || slot == "B"
}

// SystemSlotFromKernelCommandLine derives the running immutable root from the
// exact UKI contract. Ambiguous or non-appliance roots fail closed.
func SystemSlotFromKernelCommandLine(cmdline string) (string, error) {
	var slots []string
	for _, field := range strings.Fields(cmdline) {
		switch field {
		case "root=PARTLABEL=YE-SYSTEM-A":
			slots = append(slots, "A")
		case "root=PARTLABEL=YE-SYSTEM-B":
			slots = append(slots, "B")
		}
	}
	if len(slots) != 1 {
		return "", fmt.Errorf("expected exactly one appliance System root in kernel command line, found %d", len(slots))
	}
	return slots[0], nil
}

// CommitHealthySlot atomically promotes the actual health-checked boot to the
// durable current slot. It is called only after systemd has accepted the
// counted boot, and is idempotent so a post-blessing interruption can retry.
func CommitHealthySlot(path string, m Manifest, cmdline string) (StateRecord, error) {
	slot, err := SystemSlotFromKernelCommandLine(cmdline)
	if err != nil {
		return StateRecord{}, err
	}
	state, err := LoadState(path)
	if err != nil {
		return StateRecord{}, fmt.Errorf("load persistent appliance state: %w", err)
	}
	if state.Slots.Current == slot {
		if state.Slots.CurrentImageVersion != m.ImageVersion {
			return StateRecord{}, fmt.Errorf("running slot %s image %s conflicts with recorded current image %s", slot, m.ImageVersion, state.Slots.CurrentImageVersion)
		}
	} else {
		state.Slots.Previous = state.Slots.Current
		state.Slots.PreviousImageVersion = state.Slots.CurrentImageVersion
		state.Slots.Current = slot
		state.Slots.CurrentImageVersion = m.ImageVersion
	}
	if state.Slots.Candidate == slot {
		state.Slots.Candidate = ""
		state.Slots.CandidateImageVersion = ""
		state.Transaction = TransactionState{}
	}
	if err := WriteStateAtomic(path, state); err != nil {
		return StateRecord{}, fmt.Errorf("commit healthy appliance slot: %w", err)
	}
	return state, nil
}

func LoadState(path string) (StateRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return StateRecord{}, err
	}
	return ParseState(data)
}

// EnsureStateMounted mounts the exact installer-recorded YE-STATE partition.
// A different existing mount is rejected instead of silently reused.
func EnsureStateMounted(contract PartitionContract) error {
	if strings.TrimSpace(contract.StatePartUUID) == "" {
		return errors.New("YE-STATE PARTUUID is required")
	}
	device := "/dev/disk/by-partuuid/" + contract.StatePartUUID
	if out, err := exec.Command("findmnt", "-n", "-o", "SOURCE", "--mountpoint", StateMountpoint).CombinedOutput(); err == nil {
		mounted := strings.TrimSpace(string(out))
		want, wantErr := filepath.EvalSymlinks(device)
		got, gotErr := filepath.EvalSymlinks(mounted)
		if wantErr != nil || gotErr != nil || want != got {
			return fmt.Errorf("%s is mounted from %q, want YE-STATE PARTUUID %s", StateMountpoint, mounted, contract.StatePartUUID)
		}
		return nil
	}
	if err := os.MkdirAll(StateMountpoint, 0700); err != nil {
		return fmt.Errorf("create YE-STATE mountpoint: %w", err)
	}
	if out, err := exec.Command("mount", "--source", device, "--target", StateMountpoint).CombinedOutput(); err != nil {
		return fmt.Errorf("mount YE-STATE PARTUUID %s: %w: %s", contract.StatePartUUID, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func LoadOrInitializeState(m Manifest, contract PartitionContract) (StateRecord, error) {
	if err := EnsureStateMounted(contract); err != nil {
		return StateRecord{}, err
	}
	state, err := LoadState(StatePath)
	if errors.Is(err, os.ErrNotExist) {
		if signature, _ := exec.Command("blkid", "-o", "value", "-s", "TYPE", contract.DataDevice).CombinedOutput(); strings.TrimSpace(string(signature)) != "" {
			return StateRecord{}, errors.New("YE-STATE record is missing while YE-DATA contains persistent storage; boot recovery")
		}
		state, err = initialState(m, contract)
		if err != nil {
			return StateRecord{}, err
		}
		if err := WriteStateAtomic(StatePath, state); err != nil {
			return StateRecord{}, err
		}
	} else if err != nil {
		return StateRecord{}, fmt.Errorf("read YE-STATE contract: %w", err)
	}
	state, err = migrateLegacyDiskReference(StatePath, m, state, contract)
	if err != nil {
		return StateRecord{}, err
	}
	if err := ValidateStateContract(m, state, contract); err != nil {
		return StateRecord{}, err
	}
	return state, nil
}

func ValidateStateContract(m Manifest, state StateRecord, contract PartitionContract) error {
	compat := CheckCompatibility(m, state.SchemaVersion, state.DataSchemaVersion)
	if !compat.Compatible {
		return fmt.Errorf("persistent schema is incompatible with image: state=%s data=%s; boot recovery", compat.State, compat.Data)
	}
	if state.DiskLayoutVersion != m.DiskLayoutVersion {
		return fmt.Errorf("state disk layout %d does not match image layout %d; boot recovery", state.DiskLayoutVersion, m.DiskLayoutVersion)
	}
	if !strings.EqualFold(state.StatePartUUID, contract.StatePartUUID) || !strings.EqualFold(state.DataPartUUID, contract.DataPartUUID) {
		return fmt.Errorf("recorded persistent partition identity does not match discovered YE-STATE/YE-DATA; boot recovery")
	}
	if state.ParentDiskID != DiskReference(contract) {
		return fmt.Errorf("recorded parent disk identity does not match discovered appliance disk; boot recovery")
	}
	return nil
}

func initialState(m Manifest, contract PartitionContract) (StateRecord, error) {
	installRef, err := randomReference("install")
	if err != nil {
		return StateRecord{}, err
	}
	deviceRef, err := randomReference("device")
	if err != nil {
		return StateRecord{}, err
	}
	return StateRecord{
		SchemaVersion: CurrentStateSchema, Lifecycle: LifecycleUnconfigured,
		InstallIDRef: installRef, DeviceIDRef: deviceRef,
		DiskLayoutVersion: m.DiskLayoutVersion,
		StatePartUUID:     contract.StatePartUUID, DataPartUUID: contract.DataPartUUID,
		ParentDiskID: DiskReference(contract), DataSchemaVersion: CurrentDataSchema,
		Slots: SlotState{Current: "A", CurrentImageVersion: m.ImageVersion}, RecoveryVersion: m.RecoveryVersion,
	}, nil
}

func randomReference(kind string) (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate %s reference: %w", kind, err)
	}
	return fmt.Sprintf("%s:%x", kind, b), nil
}

func DiskReference(contract PartitionContract) string {
	parts := []string{
		contractParentIdentity(contract.StateParentID, contract.StatePartUUID),
		contract.StatePartUUID,
		contract.DataPartUUID,
	}
	sum := sha256.Sum256([]byte(strings.ToLower(strings.Join(parts, ":"))))
	return fmt.Sprintf("disk-v3:%x", sum[:16])
}

func contractParentIdentity(identity, partUUID string) string {
	if identity = strings.TrimSpace(identity); identity != "" {
		return identity
	}
	return "partuuid-fallback:" + strings.ToLower(strings.TrimSpace(partUUID))
}

func migrateLegacyDiskReference(path string, m Manifest, state StateRecord, contract PartitionContract) (StateRecord, error) {
	if !strings.HasPrefix(state.ParentDiskID, "disk:") {
		return state, nil
	}
	compat := CheckCompatibility(m, state.SchemaVersion, state.DataSchemaVersion)
	if !compat.Compatible || state.DiskLayoutVersion != m.DiskLayoutVersion ||
		!strings.EqualFold(state.StatePartUUID, contract.StatePartUUID) ||
		!strings.EqualFold(state.DataPartUUID, contract.DataPartUUID) {
		return state, errors.New("legacy parent disk identity cannot migrate because the persistent partition contract changed; boot recovery")
	}
	state.ParentDiskID = DiskReference(contract)
	if err := WriteStateAtomic(path, state); err != nil {
		return state, fmt.Errorf("migrate legacy parent disk identity: %w", err)
	}
	return state, nil
}

func EnsureDataSchema(state StateRecord, m Manifest) (DataSchemaRecord, error) {
	rec, err := LoadDataSchema(DataSchemaPath)
	if errors.Is(err, os.ErrNotExist) {
		rec = DataSchemaRecord{SchemaVersion: state.DataSchemaVersion, InstallIDRef: state.InstallIDRef}
		if err := writeJSONAtomic(DataSchemaPath, rec, 0600); err != nil {
			return rec, err
		}
	} else if err != nil {
		return rec, err
	}
	if rec.InstallIDRef != state.InstallIDRef {
		return rec, errors.New("YE-DATA belongs to a different appliance installation; boot recovery")
	}
	compat := CheckCompatibility(m, state.SchemaVersion, rec.SchemaVersion)
	if !compat.Compatible {
		return rec, fmt.Errorf("YE-DATA schema is %s for this image; boot recovery", compat.Data)
	}
	return rec, nil
}

func WriteStateAtomic(path string, state StateRecord) error {
	if err := state.Validate(); err != nil {
		return err
	}
	return writeJSONAtomic(path, state, 0600)
}

func writeJSONAtomic(path string, value any, mode os.FileMode) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".appliance-state-*")
	if err != nil {
		return fmt.Errorf("create state temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("install state file: %w", err)
	}
	d, err := os.Open(dir)
	if err == nil {
		defer d.Close()
		err = d.Sync()
	}
	return err
}

func LoadDataSchema(path string) (DataSchemaRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return DataSchemaRecord{}, err
	}
	var rec DataSchemaRecord
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&rec); err != nil {
		return rec, fmt.Errorf("decode data schema: %w", err)
	}
	if err := requireJSONEOF(dec); err != nil {
		return rec, err
	}
	if rec.SchemaVersion < 1 || strings.TrimSpace(rec.InstallIDRef) == "" {
		return rec, errors.New("data schema version and install reference are required")
	}
	return rec, nil
}
