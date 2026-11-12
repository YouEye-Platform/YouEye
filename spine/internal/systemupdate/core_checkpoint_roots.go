package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"time"
)

type CoreRootCheckpoint struct {
	RestoreState      string `json:"restore_state,omitempty"`
	Container         string `json:"container"`
	Snapshot          string `json:"snapshot"`
	State             string `json:"state"`
	ObservationSHA256 string `json:"observation_sha256,omitempty"`
}

type coreSnapshotObservation struct {
	Name            string                       `json:"name"`
	CreatedAt       time.Time                    `json:"created_at"`
	ExpiresAt       time.Time                    `json:"expires_at"`
	Stateful        bool                         `json:"stateful"`
	Config          map[string]string            `json:"config"`
	ExpandedDevices map[string]map[string]string `json:"expanded_devices"`
}

// CheckRootCapacity budgets full checkpoint and restore copies plus the expanded
// signed payloads. Comparing the aggregate budget against every participating
// pool deliberately avoids double-counting free space on shared backing storage.
// This is a current admission observation, never a claim of physical reservation.
func (p NativeCoreCheckpoint) CheckRootCapacity(ctx context.Context, inventory CoreCheckpointInventory, expandedPayloadBytes int64) error {
	required, pools, err := p.rootCapacityBudget(ctx, inventory, expandedPayloadBytes)
	if err != nil {
		return err
	}
	return p.checkCapacityPools(ctx, pools, required)
}

func (p NativeCoreCheckpoint) rootCapacityBudget(ctx context.Context, inventory CoreCheckpointInventory, expandedPayloadBytes int64) (int64, map[string]bool, error) {
	if expandedPayloadBytes <= 0 || expandedPayloadBytes > math.MaxInt64/4 {
		return 0, nil, fmt.Errorf("bounded expanded core payload size required")
	}
	required := expandedPayloadBytes + (512 << 20)
	pools := map[string]bool{}
	roots := 0
	for _, c := range inventory.Containers {
		if c.Snapshot == "" {
			continue
		}
		if !coreContainerName.MatchString(c.RootPool) || !coreContainerName.MatchString(c.Name) {
			return 0, nil, fmt.Errorf("exact root pool required")
		}
		roots++
		pools[c.RootPool] = true
		raw, err := p.capture(ctx, "incus", "query", "/1.0/storage-pools/"+c.RootPool+"/volumes/container/"+c.Name+"/state")
		if err != nil {
			return 0, nil, err
		}
		var volume struct {
			Usage struct {
				Used int64 `json:"used"`
			} `json:"usage"`
		}
		if json.Unmarshal(raw, &volume) != nil || volume.Usage.Used <= 0 || volume.Usage.Used > (math.MaxInt64-required)/2 {
			return 0, nil, fmt.Errorf("root checkpoint capacity is unknown")
		}
		required += volume.Usage.Used * 2
	}
	if roots != 2 {
		return 0, nil, fmt.Errorf("both core roots require capacity admission")
	}
	return required, pools, nil
}

func (p NativeCoreCheckpoint) checkCapacityPools(ctx context.Context, pools map[string]bool, required int64) error {
	for pool := range pools {
		raw, err := p.capture(ctx, "incus", "query", "/1.0/storage-pools/"+pool+"/resources")
		if err != nil {
			return err
		}
		var resources struct {
			Space struct{ Total, Used int64 } `json:"space"`
		}
		if json.Unmarshal(raw, &resources) != nil || resources.Space.Total <= 0 || resources.Space.Used < 0 || resources.Space.Used > resources.Space.Total || resources.Space.Total-resources.Space.Used < required {
			return fmt.Errorf("insufficient observed core checkpoint and restore capacity")
		}
	}
	return nil
}

func (p NativeCoreCheckpoint) readRootSnapshot(ctx context.Context, inventory CoreCheckpointInventory, c CoreCheckpointContainer) (string, bool, error) {
	raw, err := p.capture(ctx, "incus", "query", "/1.0/instances/"+c.Name+"/snapshots?recursion=1")
	if err != nil {
		return "", false, err
	}
	var snapshots []coreSnapshotObservation
	if json.Unmarshal(raw, &snapshots) != nil {
		return "", false, fmt.Errorf("root snapshot inventory is unreadable")
	}
	digest := ""
	for _, snap := range snapshots {
		if snap.Name != c.Snapshot {
			continue
		}
		pool, err := coreRootPool(snap.ExpandedDevices)
		if digest != "" || err != nil || pool != c.RootPool || snap.Config["user.youeye.core-request"] != inventory.RequestID || snap.Config["volatile.uuid"] != c.UUID || snap.Config["boot.autostart"] != "false" || snap.CreatedAt.IsZero() || !snap.ExpiresAt.IsZero() || snap.Stateful {
			return "", false, fmt.Errorf("root snapshot identity or retention differs")
		}
		// Hash provider configuration privately; never persist its credentials or
		// environment values in the checkpoint receipt or error output.
		encoded, err := json.Marshal(snap)
		if err != nil {
			return "", false, err
		}
		digest = fmt.Sprintf("%x", sha256.Sum256(encoded))
	}
	return digest, digest != "", nil
}

func (p NativeCoreCheckpoint) capturePayloadRoots(ctx context.Context, j CoreJournal, indexes []CorePayloadIndex) (NativeCoreCheckpointRecord, error) {
	expanded, err := corePayloadStagingBudget(indexes)
	if err != nil {
		return NativeCoreCheckpointRecord{}, err
	}
	return p.CaptureRoots(ctx, j, expanded)
}

// CaptureRoots runs only while the coordinator owns its checkpoint step and all
// writers are stopped. Each create is preceded by durable intent. An uncertain
// create is reconciled from the provider; absence after intent is unknown and
// must not trigger another remote operation.
func (p NativeCoreCheckpoint) CaptureRoots(ctx context.Context, j CoreJournal, expandedPayloadBytes int64) (NativeCoreCheckpointRecord, error) {
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
	if !active || (record.Phase != "quiesced" && record.Phase != "capturing-roots" && record.Phase != "roots-captured") {
		return record, fmt.Errorf("checkpoint is not ready for root capture")
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
	if err := p.CheckRootCapacity(ctx, record.Inventory, expandedPayloadBytes); err != nil {
		return record, err
	}
	record.Phase = "capturing-roots"
	if err := p.saveRecord(record); err != nil {
		return record, err
	}
	for _, c := range record.Inventory.Containers {
		if c.Snapshot == "" {
			continue
		}
		index := -1
		for n, r := range record.Roots {
			if r.Container == c.Name {
				if index >= 0 || r.Snapshot != c.Snapshot {
					return record, fmt.Errorf("ambiguous retained root checkpoint")
				}
				index = n
			}
		}
		observed, exists, err := p.readRootSnapshot(ctx, record.Inventory, c)
		if err != nil {
			return record, err
		}
		if index < 0 {
			if exists {
				return record, fmt.Errorf("root snapshot predates checkpoint intent")
			}
			record.Roots = append(record.Roots, CoreRootCheckpoint{Container: c.Name, Snapshot: c.Snapshot, State: "requested"})
			index = len(record.Roots) - 1
			if err := p.saveRecord(record); err != nil {
				return record, err
			}
			if _, err := p.capture(ctx, "incus", "snapshot", "create", c.Name, c.Snapshot, "--no-expiry"); err != nil {
				return record, err
			}
			observed, exists, err = p.readRootSnapshot(ctx, record.Inventory, c)
			if err != nil {
				return record, err
			}
		}
		prior := record.Roots[index]
		if !exists || (prior.State != "requested" && prior.State != "captured") || (prior.State == "captured" && prior.ObservationSHA256 != observed) {
			return record, fmt.Errorf("root snapshot capture is uncertain or changed; replay refused")
		}
		record.Roots[index].State, record.Roots[index].ObservationSHA256 = "captured", observed
		if err := p.saveRecord(record); err != nil {
			return record, err
		}
	}
	if len(record.Roots) != 2 {
		return record, fmt.Errorf("unexpected retained root checkpoint")
	}
	record.Phase = "roots-captured"
	return record, p.saveRecord(record)
}
