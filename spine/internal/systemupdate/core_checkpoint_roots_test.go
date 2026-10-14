package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func rootCheckpointFixture(t *testing.T) (NativeCoreCheckpoint, CoreJournal, *map[string]coreSnapshotObservation, *int) {
	t.Helper()
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	j.Phase = "applying"
	j.Steps[0].State = "succeeded"
	j.Steps[0].Evidence = "verified members"
	for i := range j.Steps {
		if j.Steps[i].Name == "checkpoint" {
			j.Steps[i].State = "started"
		}
	}
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	if err := (CoreLifecycleBarrier{Root: filepath.Join(data, "state", "app-updates")}).Begin(j); err != nil {
		t.Fatal(err)
	}
	p := NativeCoreCheckpoint{Root: m.Root, DataRoot: data, MachineObservation: func() (CoreMachineIdentity, error) { return j.Previous.Machine, nil }}
	inventory := CoreCheckpointInventory{RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Machine: j.Previous.Machine, Bridge: "incusbr0", IngressPorts: []uint16{443}}
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-postgres"} {
		c := CoreCheckpointContainer{Name: name, UUID: "fixture-" + name}
		if name != "youeye-postgres" {
			c.RootPool = "default"
			c.Snapshot = coreCheckpointSnapshot(j.RequestID)
		}
		inventory.Containers = append(inventory.Containers, c)
	}
	if err := p.saveRecord(NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Inventory: inventory, Phase: "quiesced"}); err != nil {
		t.Fatal(err)
	}
	snapshots := map[string]coreSnapshotObservation{}
	creates := 0
	p.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
		if program != "incus" {
			return nil, fmt.Errorf("unexpected program")
		}
		if args[0] == "list" {
			rows := []map[string]any{}
			for _, c := range inventory.Containers {
				status := "Stopped"
				if c.Name == "youeye-postgres" {
					status = "Running"
				}
				rows = append(rows, map[string]any{"name": c.Name, "status": status, "config": map[string]string{"volatile.uuid": c.UUID, "boot.autostart": "false", "user.youeye.core-request": j.RequestID}, "expanded_devices": map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": "default"}}})
			}
			return json.Marshal(rows)
		}
		if args[0] == "query" {
			if strings.HasSuffix(args[1], "/resources") {
				return []byte(`{"space":{"total":10737418240,"used":0}}`), nil
			}
			if strings.HasSuffix(args[1], "/state") {
				return []byte(`{"usage":{"used":1048576}}`), nil
			}
			for _, c := range inventory.Containers {
				if args[1] == "/1.0/instances/"+c.Name+"/snapshots?recursion=1" {
					rows := []coreSnapshotObservation{}
					if snapshot, ok := snapshots[c.Name]; ok {
						rows = append(rows, snapshot)
					}
					return json.Marshal(rows)
				}
			}
		}
		if len(args) == 5 && args[0] == "snapshot" && args[1] == "create" && args[4] == "--no-expiry" {
			creates++
			snapshots[args[2]] = coreSnapshotObservation{Name: args[3], CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Config: map[string]string{"volatile.uuid": "fixture-" + args[2], "boot.autostart": "false", "user.youeye.core-request": j.RequestID}, ExpandedDevices: map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": "default"}}}
			return nil, nil
		}
		return nil, fmt.Errorf("unexpected fixture operation")
	}
	return p, j, &snapshots, &creates
}

func TestCoreRootCaptureReconcilesLostAcknowledgementWithoutDuplicate(t *testing.T) {
	p, j, snapshots, creates := rootCheckpointFixture(t)
	capture := p.Capture
	lose := true
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		raw, err := capture(ctx, program, args...)
		if args[0] == "snapshot" && lose {
			lose = false
			return nil, fmt.Errorf("lost acknowledgement")
		}
		return raw, err
	}
	if _, err := p.CaptureRoots(context.Background(), j, 1<<20); err == nil {
		t.Fatal("lost acknowledgement treated as success")
	}
	record, err := p.CaptureRoots(context.Background(), j, 1<<20)
	if err != nil || record.Phase != "roots-captured" || *creates != 2 {
		t.Fatal(record.Phase, *creates, err)
	}
	if _, err := p.CaptureRoots(context.Background(), j, 1<<20); err != nil || *creates != 2 {
		t.Fatal("capture replayed", *creates, err)
	}
	changed := (*snapshots)["youeye-ui"]
	changed.CreatedAt = changed.CreatedAt.Add(time.Second)
	(*snapshots)["youeye-ui"] = changed
	if _, err := p.CaptureRoots(context.Background(), j, 1<<20); err == nil {
		t.Fatal("replaced snapshot accepted")
	}
}

func TestCoreRootCaptureAbsentAfterIntentIsUnknown(t *testing.T) {
	p, j, _, creates := rootCheckpointFixture(t)
	capture := p.Capture
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if args[0] == "snapshot" {
			return nil, fmt.Errorf("transport failed before outcome")
		}
		return capture(ctx, program, args...)
	}
	if _, err := p.CaptureRoots(context.Background(), j, 1<<20); err == nil {
		t.Fatal("unknown operation accepted")
	}
	p.Capture = capture
	if _, err := p.CaptureRoots(context.Background(), j, 1<<20); err == nil || *creates != 0 {
		t.Fatal("unknown create replayed", *creates, err)
	}
}

func TestCoreRootCaptureRejectsForeignSnapshotAndInsufficientCapacity(t *testing.T) {
	p, j, snapshots, creates := rootCheckpointFixture(t)
	record, _ := p.Read(j)
	(*snapshots)["youeye-control"] = coreSnapshotObservation{Name: record.Inventory.Containers[0].Snapshot, CreatedAt: time.Now(), Config: map[string]string{"user.youeye.core-request": "foreign"}}
	if _, err := p.CaptureRoots(context.Background(), j, 1<<20); err == nil || *creates != 0 {
		t.Fatal("adopted foreign checkpoint", err)
	}
	delete(*snapshots, "youeye-control")
	capture := p.Capture
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if args[0] == "query" && strings.HasSuffix(args[1], "/resources") {
			return []byte(`{"space":{"total":1024,"used":1024}}`), nil
		}
		return capture(ctx, program, args...)
	}
	if _, err := p.CaptureRoots(context.Background(), j, 1<<20); err == nil || *creates != 0 {
		t.Fatal("insufficient capacity admitted", err)
	}
}
