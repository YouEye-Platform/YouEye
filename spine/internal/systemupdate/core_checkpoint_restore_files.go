package systemupdate

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// These are current configuration/credential/runtime authorities or independent
// Pointer state. A core rollback retains them instead of restoring old secrets,
// source choices, lifecycle journals or independently versioned engine state.
var corePreservedRecoveryPaths = map[string]bool{"config": true, "control": true, "ui": true, "pointer": true}

type CoreFileRestore struct {
	Path       string `json:"path"`
	State      string `json:"state"`
	TreeSHA256 string `json:"tree_sha256,omitempty"`
}

// Hash the portable UI data tree privately. Unsupported links/devices/mounts are
// explicit recovery gaps; never silently skip them or read outside the snapshot.
func coreDataTreeDigest(root string) (string, error) {
	hash := sha256.New()
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() {
		return "", fmt.Errorf("core data root is not a plain directory")
	}
	rootStat, ok := rootInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("core data identity unavailable")
	}
	entries := 0
	var bytes int64
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > 500000 {
			return fmt.Errorf("core data tree exceeds supported entry bound")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || st.Dev != rootStat.Dev || (!info.IsDir() && !info.Mode().IsRegular()) || info.Mode()&(os.ModeSetuid|os.ModeSetgid) != 0 {
			return fmt.Errorf("unsupported core data entry or nested mount")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%d\x00%d\x00%t\x00", relative, info.Mode().Perm(), st.Uid, st.Gid, info.IsDir())
		if info.IsDir() {
			return nil
		}
		if info.Size() < 0 || info.Size() > 64<<30 || bytes > (64<<30)-info.Size() {
			return fmt.Errorf("core data tree exceeds supported byte bound")
		}
		bytes += info.Size()
		file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		actual, err := file.Stat()
		if err != nil || !os.SameFile(info, actual) {
			file.Close()
			return fmt.Errorf("core data entry changed during observation")
		}
		fileHash := sha256.New()
		count, err := io.Copy(fileHash, io.LimitReader(file, info.Size()+1))
		file.Close()
		if err != nil || count != info.Size() {
			return fmt.Errorf("core data bytes changed during observation")
		}
		_, _ = fmt.Fprintf(hash, "%d\x00%x\x00", count, fileHash.Sum(nil))
		return nil
	})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func (p NativeCoreCheckpoint) fileSnapshotSource(file CoreCheckpointFiles) (string, error) {
	if file.Path != "ui-data" || !file.Present || !validCoreDataset(file.Dataset) || !filepath.IsAbs(file.Mountpoint) || !coreContainerName.MatchString(file.Snapshot) {
		return "", fmt.Errorf("exact portable core data snapshot required")
	}
	destination := filepath.Join(p.DataRoot, file.Path)
	relative, err := filepath.Rel(file.Mountpoint, destination)
	if err != nil || relative == ".." || strings.HasPrefix(relative, "../") || filepath.IsAbs(relative) {
		return "", fmt.Errorf("core data snapshot escaped its mount")
	}
	return filepath.Join(file.Mountpoint, ".zfs", "snapshot", file.Snapshot, relative), nil
}

// RestoreFiles retains live credentials/configuration and independent Pointer
// state. Only portable UI data is copied back from its exact held snapshot. The
// copy is idempotent under the independently verified recovery fence; a repeated
// request reconciles its frozen tree digest before resuming an interrupted copy.
func (p NativeCoreCheckpoint) RestoreFiles(ctx context.Context, j CoreJournal) (NativeCoreCheckpointRecord, error) {
	record, err := p.Read(j)
	if err != nil {
		return record, err
	}
	if record.Phase != "databases-restored" && record.Phase != "restoring-files" && record.Phase != "files-restored" {
		return record, fmt.Errorf("verified database restoration required before files")
	}
	if err := p.requirePairedRecovery(ctx, j, record); err != nil {
		return record, err
	}
	for _, db := range record.Databases {
		if (db.Name == "pointer" && db.RestoreState != "preserved") || (db.Name != "pointer" && db.RestoreState != "restored") {
			return record, fmt.Errorf("paired database recovery is incomplete")
		}
	}
	record.Phase = "restoring-files"
	if err := p.saveRecord(record); err != nil {
		return record, err
	}
	for _, file := range record.Inventory.Files {
		if file.Path != "ui-data" && !corePreservedRecoveryPaths[file.Path] {
			return record, fmt.Errorf("persistent recovery scope is unsupported")
		}
		index := -1
		for n, r := range record.FileRestores {
			if r.Path == file.Path {
				if index >= 0 {
					return record, fmt.Errorf("duplicate file recovery receipt")
				}
				index = n
			}
		}
		if index < 0 {
			record.FileRestores = append(record.FileRestores, CoreFileRestore{Path: file.Path})
			index = len(record.FileRestores) - 1
		}
		receipt := &record.FileRestores[index]
		if corePreservedRecoveryPaths[file.Path] {
			// Preserve both bytes and absence of current authoritative paths. Old
			// service compatibility is established later by authenticated health.
			if receipt.State != "" && receipt.State != "preserved" {
				return record, fmt.Errorf("authority path has invalid restore intent")
			}
			receipt.State = "preserved"
			if err := p.saveRecord(record); err != nil {
				return record, err
			}
			continue
		}
		destination := filepath.Join(p.DataRoot, file.Path)
		if !file.Present {
			if _, err := os.Lstat(destination); !os.IsNotExist(err) {
				return record, fmt.Errorf("new portable data exists; preserve it for recovery")
			}
			receipt.State = "absent"
			if err := p.saveRecord(record); err != nil {
				return record, err
			}
			continue
		}
		source, err := p.fileSnapshotSource(file)
		if err != nil {
			return record, err
		}
		digest, err := coreDataTreeDigest(source)
		if err != nil {
			return record, err
		}
		if receipt.TreeSHA256 != "" && receipt.TreeSHA256 != digest {
			return record, fmt.Errorf("portable snapshot tree changed")
		}
		if receipt.State != "" && receipt.State != "copying" && receipt.State != "restored" {
			return record, fmt.Errorf("portable data restore state is invalid")
		}
		actual, err := coreDataTreeDigest(destination)
		if err != nil {
			return record, err
		}
		if receipt.State == "restored" && actual != digest {
			return record, fmt.Errorf("restored portable data changed; preserve it for recovery")
		}
		receipt.TreeSHA256 = digest
		if actual != digest {
			var restoreBytes uint64
			if err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if entry.IsDir() {
					return nil
				}
				info, err := entry.Info()
				if err != nil {
					return err
				}
				restoreBytes += uint64(info.Size())
				return nil
			}); err != nil {
				return record, err
			}
			var capacity syscall.Statfs_t
			if err := syscall.Statfs(destination, &capacity); err != nil {
				return record, err
			}
			if capacity.Bsize <= 0 || capacity.Bavail < (restoreBytes*2+(512<<20))/uint64(capacity.Bsize)+1 {
				return record, fmt.Errorf("insufficient portable data restore capacity")
			}
			// All current paths must be plain data before rsync can replace them.
			// No --delete-excluded or broad Data rollback is used.
			receipt.State = "copying"
			if err := p.saveRecord(record); err != nil {
				return record, err
			}
			if err := p.requirePairedRecovery(ctx, j, record); err != nil {
				return record, err
			}
			if _, err := p.capture(ctx, "rsync", "--archive", "--numeric-ids", "--delete", "--", source+"/", destination+"/"); err != nil {
				return record, err
			}
			actual, err = coreDataTreeDigest(destination)
			if err != nil || actual != digest {
				return record, fmt.Errorf("portable data restore did not converge")
			}
		}
		receipt.State = "restored"
		if err := p.saveRecord(record); err != nil {
			return record, err
		}
	}
	if len(record.FileRestores) != len(record.Inventory.Files) {
		return record, fmt.Errorf("unexpected persistent recovery receipt")
	}
	record.Phase = "files-restored"
	return record, p.saveRecord(record)
}
