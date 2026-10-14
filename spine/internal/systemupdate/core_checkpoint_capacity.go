package systemupdate

import (
	"context"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
)

// CheckCompleteCapacity observes one combined staging/checkpoint/recovery budget
// before maintenance. All pools and Data must each cover it: their advertised
// free bytes may share backing storage and cannot be added together. Capture
// methods still recheck after writer closure; this is not a space reservation.
func (p NativeCoreCheckpoint) CheckCompleteCapacity(ctx context.Context, inventory CoreCheckpointInventory, indexes []CorePayloadIndex) (int64, error) {
	if len(indexes) != 2 {
		return 0, fmt.Errorf("both complete core service indexes required")
	}
	var extra int64 = 1
	for _, index := range indexes {
		if err := index.Validate(); err != nil {
			return 0, err
		}
		for _, entry := range index.Entries {
			size := int64(4096)
			if entry.Size > size {
				size = entry.Size
			}
			if size > (math.MaxInt64-extra)/2 {
				return 0, fmt.Errorf("expanded core budget overflow")
			}
			extra += size * 2
		}
	}
	databases, err := p.inspectDatabaseSizes(ctx)
	if err != nil {
		return 0, err
	}
	for _, db := range databases {
		extra += db.SizeBytes*4 + (128 << 20)
	}
	// Current UI files, including schema receipts, must fit a portable paired
	// restore without deleting the live tree first. Other authority files are
	// preserved in place and roots have their own full-copy allowance below.
	portable, err := coreDataTreeBytes(filepath.Join(p.DataRoot, "ui-data"))
	if err != nil {
		return 0, err
	}
	if portable > (math.MaxInt64-extra)/2 {
		return 0, fmt.Errorf("core data budget overflow")
	}
	extra += portable * 2
	required, pools, err := p.rootCapacityBudget(ctx, inventory, extra)
	if err != nil {
		return 0, err
	}
	if err = p.checkCapacityPools(ctx, pools, required); err != nil {
		return 0, err
	}
	available := p.AvailableDataBytes
	if available == nil {
		available = filesystemAvailableBytes
	}
	free, err := available(p.DataRoot)
	if err != nil {
		return 0, err
	}
	if free < uint64(required) {
		return 0, fmt.Errorf("insufficient combined Data checkpoint/staging/recovery capacity")
	}
	return required, nil
}

func coreDataTreeBytes(root string) (int64, error) {
	info, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil || !info.IsDir() {
		return 0, fmt.Errorf("portable core data root is not a plain directory")
	}
	original, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("portable core data identity unavailable")
	}
	var total int64
	count := 0
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		count++
		if count > 500000 {
			return fmt.Errorf("portable core data exceeds entry bound")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Dev != original.Dev || (!info.IsDir() && !info.Mode().IsRegular()) || info.Mode()&(os.ModeSetuid|os.ModeSetgid) != 0 {
			return fmt.Errorf("unsupported portable core data or nested mount")
		}
		size := int64(4096)
		if info.Size() > size {
			size = info.Size()
		}
		if size > 64<<30 || total > (64<<30)-size {
			return fmt.Errorf("portable core data exceeds byte bound")
		}
		total += size
		return nil
	})
	return total, err
}

// PreflightCheckpoint runs after lifecycle admission but before closing ingress
// or stopping writers. Actual target cache/member authority and old installed
// files are checked here so an owner overlay is rejected without downtime.
func (s NativeCoreServices) PreflightCheckpoint(ctx context.Context, request string) (CoreCheckpointInventory, int64, error) {
	var empty CoreCheckpointInventory
	m := CoreManager{Root: s.Checkpoint.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.Phase != "applying" {
		return empty, 0, fmt.Errorf("active native checkpoint required")
	}
	active := false
	for _, step := range j.Steps {
		if step.Name == "checkpoint" && step.State == "started" {
			active = true
		}
	}
	if !active {
		return empty, 0, fmt.Errorf("coordinator has not requested checkpoint")
	}
	receipt, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(receipt, j.Previous) {
		return empty, 0, fmt.Errorf("checkpoint baseline changed")
	}
	if _, _, err = m.Selection(j.ManifestSHA256, s.Cache.TrustKeyPath); err != nil {
		return empty, 0, err
	}
	inventory, err := s.Checkpoint.Inspect(ctx, j)
	if err != nil {
		return empty, 0, err
	}
	indexes := []CorePayloadIndex{}
	for _, role := range []string{"cp", "ui"} {
		index, err := s.Cache.IndexSelected(m, j, role)
		if err != nil {
			return empty, 0, err
		}
		indexes = append(indexes, index)
		previous, err := coreServiceMember(j.Previous.Release, role)
		if err != nil {
			return empty, 0, err
		}
		baseline, err := m.LoadPayloadIndex(previous.Artifact.SHA256)
		if err != nil {
			return empty, 0, err
		}
		name, appDir := "youeye-control", s.CPAppDir
		if role == "ui" {
			name, appDir = "youeye-ui", s.UIAppDir
		}
		if err = VerifyCoreContainerPayload(ctx, name, appDir, baseline); err != nil {
			return empty, 0, err
		}
	}
	required, err := s.Checkpoint.CheckCompleteCapacity(ctx, inventory, indexes)
	return inventory, required, err
}
