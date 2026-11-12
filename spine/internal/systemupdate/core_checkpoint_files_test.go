package systemupdate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func filesCheckpointFixture(t *testing.T) (NativeCoreCheckpoint, CoreJournal, *int, *string, *bool) {
	t.Helper()
	p, j, _, _ := rootCheckpointFixture(t)
	record, err := p.CaptureRoots(context.Background(), j, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"control", "config", "ui", "ui-data"} {
		if err := os.Mkdir(filepath.Join(p.DataRoot, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	record.Inventory.Files, err = p.checkpointFileInventory("pool/data\t"+p.DataRoot, coreCheckpointSnapshot(j.RequestID))
	if err != nil {
		t.Fatal(err)
	}
	if err := p.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	native := p.Capture
	creates := 0
	guid := ""
	held := false
	snapshot := "pool/data@" + coreCheckpointSnapshot(j.RequestID)
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program != "zfs" {
			return native(ctx, program, args...)
		}
		switch args[0] {
		case "list":
			if args[len(args)-1] == "filesystem" {
				return []byte("pool/data\t" + p.DataRoot), nil
			}
			if guid == "" {
				return nil, nil
			}
			return []byte(snapshot + "\t" + guid + "\t" + coreSnapshotOwner(record.Inventory)), nil
		case "snapshot":
			if len(args) != 4 || args[1] != "-o" || args[2] != "org.youeye:core-request="+coreSnapshotOwner(record.Inventory) || args[3] != snapshot {
				return nil, fmt.Errorf("unexpected snapshot scope")
			}
			creates++
			guid = "123456"
			return nil, nil
		case "holds":
			if !held {
				return nil, nil
			}
			return []byte(snapshot + "\t" + coreCheckpointSnapshot(j.RequestID) + "\tfixture-time"), nil
		case "hold":
			if args[1] != coreCheckpointSnapshot(j.RequestID) || args[2] != snapshot {
				return nil, fmt.Errorf("unexpected hold scope")
			}
			held = true
			return nil, nil
		}
		return nil, fmt.Errorf("unexpected ZFS command")
	}
	return p, j, &creates, &guid, &held
}

func TestCoreFileCaptureRetainsHoldAndReconcilesLostAcknowledgement(t *testing.T) {
	p, j, creates, guid, held := filesCheckpointFixture(t)
	capture := p.Capture
	lose := true
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		raw, err := capture(ctx, program, args...)
		if program == "zfs" && args[0] == "snapshot" && lose {
			lose = false
			return nil, fmt.Errorf("lost acknowledgement")
		}
		return raw, err
	}
	if _, err := p.CaptureFiles(context.Background(), j); err == nil {
		t.Fatal("lost acknowledgement accepted")
	}
	record, err := p.CaptureFiles(context.Background(), j)
	if err != nil || record.Phase != "files-captured" || *creates != 1 || !*held {
		t.Fatal(record.Phase, *creates, *held, err)
	}
	if _, err := p.CaptureFiles(context.Background(), j); err != nil || *creates != 1 {
		t.Fatal("replayed capture", err)
	}
	*guid = "987654"
	if _, err := p.CaptureFiles(context.Background(), j); err == nil {
		t.Fatal("replacement GUID accepted")
	}
}

func TestCoreFileCaptureUnknownCreateAndChangedCoverageStayHeld(t *testing.T) {
	p, j, creates, _, _ := filesCheckpointFixture(t)
	capture := p.Capture
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "zfs" && args[0] == "snapshot" {
			return nil, fmt.Errorf("unknown operation")
		}
		return capture(ctx, program, args...)
	}
	if _, err := p.CaptureFiles(context.Background(), j); err == nil {
		t.Fatal("unknown outcome accepted")
	}
	p.Capture = capture
	if _, err := p.CaptureFiles(context.Background(), j); err == nil || *creates != 0 {
		t.Fatal("unknown create replayed", err)
	}
	p, j, creates, _, _ = filesCheckpointFixture(t)
	if err := os.Mkdir(filepath.Join(p.DataRoot, "pointer"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CaptureFiles(context.Background(), j); err == nil || *creates != 0 {
		t.Fatal("changed persistent scope accepted", err)
	}
}

func TestCoreFileCaptureRejectsForeignSnapshotAndDatasetArguments(t *testing.T) {
	p, j, creates, _, _ := filesCheckpointFixture(t)
	capture := p.Capture
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "zfs" && args[0] == "list" && args[len(args)-1] != "filesystem" {
			return []byte("pool/data@" + coreCheckpointSnapshot(j.RequestID) + "\t123\tforeign"), nil
		}
		return capture(ctx, program, args...)
	}
	if _, err := p.CaptureFiles(context.Background(), j); err == nil || *creates != 0 {
		t.Fatal("foreign snapshot adopted", err)
	}
	for _, dataset := range []string{"", "-r", "pool/../foreign", "pool//data", "pool/data@snapshot", strings.Repeat("a", 1025)} {
		if validCoreDataset(dataset) {
			t.Fatal("unsafe dataset accepted", dataset)
		}
	}
}
