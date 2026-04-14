package backup

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// BackupIndex is the top-level structure stored in backup.json at the target root.
type BackupIndex struct {
	LastUpdated string                      `json:"last_updated"`
	Core        []BackupEntry               `json:"core"`
	Apps        map[string][]BackupEntry    `json:"apps"`
}

// BackupEntry represents a single backup archive in the index.
type BackupEntry struct {
	Timestamp   string `json:"timestamp"`
	ArchivePath string `json:"archive_path"`
	ArchiveSize int64  `json:"archive_size"`
	Version     string `json:"version"`
}

var indexMu sync.Mutex

func indexPath(targetPath string) string {
	return filepath.Join(targetPath, "youeye", "backup.json")
}

// ReadIndex reads the backup index from disk. Returns an empty index if none exists.
func ReadIndex(targetPath string) (*BackupIndex, error) {
	indexMu.Lock()
	defer indexMu.Unlock()

	return readIndexLocked(targetPath)
}

func readIndexLocked(targetPath string) (*BackupIndex, error) {
	idx := &BackupIndex{
		Core: []BackupEntry{},
		Apps: make(map[string][]BackupEntry),
	}

	data, err := os.ReadFile(indexPath(targetPath))
	if err != nil {
		if os.IsNotExist(err) {
			return idx, nil
		}
		return nil, fmt.Errorf("read backup index: %w", err)
	}

	if err := json.Unmarshal(data, idx); err != nil {
		return nil, fmt.Errorf("parse backup index: %w", err)
	}

	if idx.Apps == nil {
		idx.Apps = make(map[string][]BackupEntry)
	}
	if idx.Core == nil {
		idx.Core = []BackupEntry{}
	}

	return idx, nil
}

// WriteIndex writes the backup index to disk atomically.
func WriteIndex(targetPath string, idx *BackupIndex) error {
	indexMu.Lock()
	defer indexMu.Unlock()

	return writeIndexLocked(targetPath, idx)
}

func writeIndexLocked(targetPath string, idx *BackupIndex) error {
	idx.LastUpdated = time.Now().UTC().Format(time.RFC3339)

	dir := filepath.Dir(indexPath(targetPath))
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create index dir: %w", err)
	}

	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal backup index: %w", err)
	}

	tmpPath := indexPath(targetPath) + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("write backup index: %w", err)
	}

	return os.Rename(tmpPath, indexPath(targetPath))
}

// AddEntry adds a backup entry to the index for the given type and optional appId.
func AddEntry(targetPath string, backupType string, appId string, entry BackupEntry) error {
	indexMu.Lock()
	defer indexMu.Unlock()

	idx, err := readIndexLocked(targetPath)
	if err != nil {
		return err
	}

	switch backupType {
	case "core", "full":
		idx.Core = append(idx.Core, entry)
	case "app":
		if appId == "" {
			return fmt.Errorf("app_id required for app backups")
		}
		idx.Apps[appId] = append(idx.Apps[appId], entry)
	default:
		idx.Core = append(idx.Core, entry)
	}

	return writeIndexLocked(targetPath, idx)
}

// ListEntries returns backup entries for the given type and optional appId.
func ListEntries(targetPath string, backupType string, appId string) ([]BackupEntry, error) {
	idx, err := ReadIndex(targetPath)
	if err != nil {
		return nil, err
	}

	switch backupType {
	case "core", "full":
		return idx.Core, nil
	case "app":
		if appId == "" {
			// Return all app entries flattened
			var all []BackupEntry
			for _, entries := range idx.Apps {
				all = append(all, entries...)
			}
			return all, nil
		}
		return idx.Apps[appId], nil
	default:
		return idx.Core, nil
	}
}

// PruneEntries removes old backup entries beyond the retention count.
// It deletes the archive files from disk and removes entries from the index.
func PruneEntries(targetPath string, backupType string, appId string, retention int) error {
	if retention <= 0 {
		return nil
	}

	indexMu.Lock()
	defer indexMu.Unlock()

	idx, err := readIndexLocked(targetPath)
	if err != nil {
		return err
	}

	switch backupType {
	case "core", "full":
		idx.Core = pruneSlice(idx.Core, retention)
	case "app":
		if appId == "" {
			// Prune all apps
			for id, entries := range idx.Apps {
				idx.Apps[id] = pruneSlice(entries, retention)
			}
		} else {
			if entries, ok := idx.Apps[appId]; ok {
				idx.Apps[appId] = pruneSlice(entries, retention)
			}
		}
	}

	return writeIndexLocked(targetPath, idx)
}

// pruneSlice keeps only the most recent `retention` entries, deleting archive files
// for entries that are removed.
func pruneSlice(entries []BackupEntry, retention int) []BackupEntry {
	if len(entries) <= retention {
		return entries
	}

	// Sort by timestamp descending (newest first)
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Timestamp > entries[j].Timestamp
	})

	// Delete archive files for pruned entries
	for _, entry := range entries[retention:] {
		if entry.ArchivePath != "" {
			os.Remove(entry.ArchivePath)
		}
	}

	return entries[:retention]
}
