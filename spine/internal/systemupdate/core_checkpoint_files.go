package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type CoreFilesCheckpoint struct {
	Dataset  string `json:"dataset"`
	Snapshot string `json:"snapshot"`
	State    string `json:"state"`
	GUID     string `json:"guid,omitempty"`
	Held     bool   `json:"held"`
}

func validCoreDataset(dataset string) bool {
	if len(dataset) > 1024 {
		return false
	}
	for _, part := range strings.Split(dataset, "/") {
		if !coreContainerName.MatchString(part) {
			return false
		}
	}
	return true
}

func coreSnapshotOwner(inventory CoreCheckpointInventory) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(inventory.RequestID+"\x00"+inventory.ManifestSHA256)))
}

func (p NativeCoreCheckpoint) observeFilesSnapshot(ctx context.Context, inventory CoreCheckpointInventory, dataset, snapshot string) (string, bool, error) {
	if !validCoreDataset(dataset) || snapshot != coreCheckpointSnapshot(inventory.RequestID) {
		return "", false, fmt.Errorf("exact persistent checkpoint identity required")
	}
	raw, err := p.capture(ctx, "zfs", "list", "-H", "-p", "-r", "-t", "snapshot", "-o", "name,guid,org.youeye:core-request", dataset)
	if err != nil {
		return "", false, err
	}
	guid := ""
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) != 3 {
			return "", false, fmt.Errorf("persistent snapshot inventory is invalid")
		}
		if fields[0] != dataset+"@"+snapshot {
			continue
		}
		number, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || number == 0 || guid != "" || fields[2] != coreSnapshotOwner(inventory) {
			return "", false, fmt.Errorf("persistent snapshot is foreign or ambiguous")
		}
		guid = fields[1]
	}
	return guid, guid != "", nil
}

func (p NativeCoreCheckpoint) holdFilesSnapshot(ctx context.Context, inventory CoreCheckpointInventory, dataset, snapshot string) error {
	name := dataset + "@" + snapshot
	held := func() (bool, error) {
		raw, err := p.capture(ctx, "zfs", "holds", "-H", name)
		if err != nil {
			return false, err
		}
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			if line == "" {
				continue
			}
			fields := strings.Split(line, "\t")
			if len(fields) != 3 || fields[0] != name {
				return false, fmt.Errorf("persistent snapshot hold is unreadable")
			}
			if fields[1] == snapshot {
				return true, nil
			}
		}
		return false, nil
	}
	present, err := held()
	if err != nil || present {
		return err
	}
	if _, err = p.capture(ctx, "zfs", "hold", snapshot, name); err != nil {
		return err
	}
	present, err = held()
	if err != nil {
		return err
	}
	if !present {
		return fmt.Errorf("persistent checkpoint hold was not observed")
	}
	return nil
}

// CaptureFiles checkpoints only the datasets covering the frozen platform paths.
// Recovery must copy those exact paths, never roll back the full Data dataset:
// unrelated app data, the live PostgreSQL cluster and newer policy stay outside
// this restore authority even when they share the physical snapshot.
func (p NativeCoreCheckpoint) CaptureFiles(ctx context.Context, j CoreJournal) (NativeCoreCheckpointRecord, error) {
	record, err := p.Read(j)
	if err != nil {
		return record, err
	}
	current, err := (CoreManager{Root: p.Root}).Read()
	if err != nil || current.RequestID != j.RequestID || current.ManifestSHA256 != j.ManifestSHA256 || current.Phase != "applying" {
		return record, fmt.Errorf("active coordinator checkpoint required")
	}
	active := false
	for _, s := range current.Steps {
		if s.Name == "checkpoint" && s.State == "started" {
			active = true
		}
	}
	if !active || (record.Phase != "roots-captured" && record.Phase != "capturing-files" && record.Phase != "files-captured") {
		return record, fmt.Errorf("checkpoint is not ready for file capture")
	}
	if err := p.verifyReservation(j); err != nil {
		return record, err
	}
	machine, err := p.observeMachine()
	if err != nil || machine != record.Inventory.Machine {
		return record, fmt.Errorf("checkpoint machine changed")
	}
	if err := p.verifyContainerIdentities(ctx, record.Inventory, true); err != nil {
		return record, err
	}
	raw, err := p.capture(ctx, "zfs", "list", "-H", "-o", "name,mountpoint", "-t", "filesystem")
	if err != nil {
		return record, err
	}
	files, err := p.checkpointFileInventory(string(raw), coreCheckpointSnapshot(j.RequestID))
	if err != nil {
		return record, err
	}
	actual, _ := json.Marshal(files)
	expected, _ := json.Marshal(record.Inventory.Files)
	if string(actual) != string(expected) {
		return record, fmt.Errorf("persistent file ownership or mount coverage changed")
	}
	datasets := map[string]string{}
	for _, f := range files {
		if f.Present {
			if !validCoreDataset(f.Dataset) {
				return record, fmt.Errorf("invalid core dataset")
			}
			datasets[f.Dataset] = f.Snapshot
		}
	}
	if len(datasets) == 0 {
		return record, fmt.Errorf("core persistent paths are missing")
	}
	names := make([]string, 0, len(datasets))
	for name := range datasets {
		names = append(names, name)
	}
	sort.Strings(names)
	record.Phase = "capturing-files"
	if err := p.saveRecord(record); err != nil {
		return record, err
	}
	for _, dataset := range names {
		snapshot := datasets[dataset]
		index := -1
		for n, r := range record.FileSnapshots {
			if r.Dataset == dataset {
				if index >= 0 || r.Snapshot != snapshot {
					return record, fmt.Errorf("ambiguous persistent checkpoint")
				}
				index = n
			}
		}
		guid, exists, err := p.observeFilesSnapshot(ctx, record.Inventory, dataset, snapshot)
		if err != nil {
			return record, err
		}
		if index < 0 {
			if exists {
				return record, fmt.Errorf("persistent snapshot predates checkpoint intent")
			}
			record.FileSnapshots = append(record.FileSnapshots, CoreFilesCheckpoint{Dataset: dataset, Snapshot: snapshot, State: "requested"})
			index = len(record.FileSnapshots) - 1
			if err := p.saveRecord(record); err != nil {
				return record, err
			}
			if _, err := p.capture(ctx, "zfs", "snapshot", "-o", "org.youeye:core-request="+coreSnapshotOwner(record.Inventory), dataset+"@"+snapshot); err != nil {
				return record, err
			}
			guid, exists, err = p.observeFilesSnapshot(ctx, record.Inventory, dataset, snapshot)
			if err != nil {
				return record, err
			}
		}
		prior := record.FileSnapshots[index]
		if !exists || (prior.State != "requested" && prior.State != "captured") || (prior.State == "captured" && prior.GUID != guid) {
			return record, fmt.Errorf("persistent snapshot outcome is uncertain or changed; replay refused")
		}
		if err := p.holdFilesSnapshot(ctx, record.Inventory, dataset, snapshot); err != nil {
			return record, err
		}
		record.FileSnapshots[index].State, record.FileSnapshots[index].GUID, record.FileSnapshots[index].Held = "captured", guid, true
		if err := p.saveRecord(record); err != nil {
			return record, err
		}
	}
	if len(record.FileSnapshots) != len(datasets) {
		return record, fmt.Errorf("unexpected persistent checkpoint")
	}
	record.Phase = "files-captured"
	return record, p.saveRecord(record)
}

func (p NativeCoreCheckpoint) verifyCapturedSnapshots(ctx context.Context, record NativeCoreCheckpointRecord) error {
	if len(record.Roots) != 2 || len(record.FileSnapshots) == 0 {
		return fmt.Errorf("paired snapshot set is incomplete")
	}
	roots := map[string]CoreRootCheckpoint{}
	for _, root := range record.Roots {
		if _, ok := roots[root.Container]; ok {
			return fmt.Errorf("duplicate root checkpoint")
		}
		roots[root.Container] = root
	}
	checked := 0
	for _, c := range record.Inventory.Containers {
		if c.Snapshot == "" {
			continue
		}
		root, ok := roots[c.Name]
		if !ok || root.Snapshot != c.Snapshot || root.State != "captured" {
			return fmt.Errorf("root checkpoint receipt is incomplete")
		}
		digest, exists, err := p.readRootSnapshot(ctx, record.Inventory, c)
		if err != nil || !exists || digest != root.ObservationSHA256 {
			return fmt.Errorf("root checkpoint is unavailable or changed")
		}
		checked++
	}
	if checked != 2 {
		return fmt.Errorf("paired core roots are incomplete")
	}
	expected := map[string]string{}
	for _, f := range record.Inventory.Files {
		if f.Present {
			expected[f.Dataset] = f.Snapshot
		}
	}
	if len(expected) != len(record.FileSnapshots) {
		return fmt.Errorf("persistent checkpoint scope is incomplete")
	}
	for _, f := range record.FileSnapshots {
		if expected[f.Dataset] != f.Snapshot || f.State != "captured" || !f.Held {
			return fmt.Errorf("persistent checkpoint receipt is incomplete")
		}
		delete(expected, f.Dataset)
		guid, exists, err := p.observeFilesSnapshot(ctx, record.Inventory, f.Dataset, f.Snapshot)
		if err != nil || !exists || guid != f.GUID {
			return fmt.Errorf("persistent checkpoint is unavailable or changed")
		}
		if err := p.holdFilesSnapshot(ctx, record.Inventory, f.Dataset, f.Snapshot); err != nil {
			return err
		}
	}
	return nil
}
