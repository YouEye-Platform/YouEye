package backup

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	backupDataRoot    = "/var/lib/youeye"
	backupStagingRoot = "/var/lib/youeye/backups/.staging"
)

type VolumeMapping struct {
	Source      string `json:"source"`
	ArchivePath string `json:"archive_path"`
}

type volumeMapDocument struct {
	Schema  string          `json:"schema"`
	Volumes []VolumeMapping `json:"volumes"`
}

func pathWithin(root, candidate string) bool {
	root = filepath.Clean(root)
	candidate = filepath.Clean(candidate)
	return candidate == root || strings.HasPrefix(candidate, root+string(filepath.Separator))
}

func validateVolumeMapping(mapping VolumeMapping) (VolumeMapping, error) {
	mapping.Source = filepath.Clean(mapping.Source)
	if !filepath.IsAbs(mapping.Source) || !pathWithin(backupDataRoot, mapping.Source) || pathWithin(filepath.Join(backupDataRoot, "backups"), mapping.Source) {
		return VolumeMapping{}, fmt.Errorf("source must be persistent YouEye data outside the backup directory")
	}
	archive := filepath.ToSlash(filepath.Clean(filepath.FromSlash(mapping.ArchivePath)))
	if archive == "." || filepath.IsAbs(filepath.FromSlash(archive)) || strings.HasPrefix(archive, "../") || !strings.HasPrefix(archive, "volumes/") {
		return VolumeMapping{}, fmt.Errorf("archive path must be relative beneath volumes")
	}
	mapping.ArchivePath = archive
	return mapping, nil
}

func prepareVolumeMappings(stagingDir string, explicit []VolumeMapping) ([]VolumeMapping, error) {
	if !pathWithin(backupStagingRoot, stagingDir) {
		return nil, fmt.Errorf("staging directory is outside the protected backup workspace")
	}
	mappings := append([]VolumeMapping(nil), explicit...)
	seenSources := make(map[string]bool)
	seenArchives := make(map[string]bool)
	for index := range mappings {
		validated, err := validateVolumeMapping(mappings[index])
		if err != nil {
			return nil, fmt.Errorf("volume %d: %w", index, err)
		}
		if seenSources[validated.Source] || seenArchives[validated.ArchivePath] {
			return nil, fmt.Errorf("duplicate volume source or archive path")
		}
		seenSources[validated.Source] = true
		seenArchives[validated.ArchivePath] = true
		mappings[index] = validated
	}
	document, err := json.MarshalIndent(volumeMapDocument{Schema: "youeye.backup.volume-map.v1", Volumes: mappings}, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "volume-map.json"), append(document, '\n'), 0600); err != nil {
		return nil, fmt.Errorf("write volume map: %w", err)
	}
	return mappings, nil
}

func validateVolumeTree(source string) error {
	return filepath.WalkDir(source, func(current string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() || info.IsDir() {
			return nil
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(current)
			if err != nil {
				return fmt.Errorf("read persistent symlink: %w", err)
			}
			if target == "" || filepath.IsAbs(target) {
				return fmt.Errorf("persistent path contains an unsafe symlink: %s", current)
			}
			resolved := filepath.Clean(filepath.Join(filepath.Dir(current), filepath.FromSlash(target)))
			if !pathWithin(source, resolved) {
				return fmt.Errorf("persistent path contains an escaping symlink: %s", current)
			}
			return nil
		}
		return fmt.Errorf("persistent path contains a link or special file: %s", current)
	})
}

func readVolumeMap(stagingDir string) ([]VolumeMapping, error) {
	if !pathWithin(backupStagingRoot, stagingDir) {
		return nil, fmt.Errorf("staging directory is outside the protected backup workspace")
	}
	data, err := os.ReadFile(filepath.Join(stagingDir, "volume-map.json"))
	if err != nil {
		return nil, fmt.Errorf("read volume map: %w", err)
	}
	var document volumeMapDocument
	if err := json.Unmarshal(data, &document); err != nil || document.Schema != "youeye.backup.volume-map.v1" {
		return nil, fmt.Errorf("invalid volume map")
	}
	for index := range document.Volumes {
		validated, err := validateVolumeMapping(document.Volumes[index])
		if err != nil {
			return nil, fmt.Errorf("volume %d: %w", index, err)
		}
		document.Volumes[index] = validated
	}
	return document.Volumes, nil
}

// ApplyVolumes restores only paths declared by the encrypted archive's volume
// map. Each replacement is staged beside its destination and rolled back if the
// atomic rename cannot complete.
func ApplyVolumes(stagingDir string) (int, error) {
	mappings, err := readVolumeMap(stagingDir)
	if err != nil {
		return 0, err
	}
	type replacement struct {
		mapping     VolumeMapping
		staged      string
		previous    string
		hadPrevious bool
		activated   bool
	}
	replacements := make([]replacement, 0, len(mappings))
	cleanup := func() {
		for _, item := range replacements {
			_ = os.RemoveAll(item.staged)
		}
	}
	defer cleanup()

	// Stage and validate every destination before mutating any live path.
	for _, mapping := range mappings {
		source := filepath.Join(stagingDir, filepath.FromSlash(mapping.ArchivePath))
		if !pathWithin(stagingDir, source) {
			return 0, fmt.Errorf("archive volume escaped staging directory")
		}
		if _, err := os.Lstat(source); err != nil {
			return 0, fmt.Errorf("archive volume missing: %w", err)
		}
		if err := validateVolumeTree(source); err != nil {
			return 0, fmt.Errorf("archive volume validation failed: %w", err)
		}
		if err := os.MkdirAll(filepath.Dir(mapping.Source), 0755); err != nil {
			return 0, err
		}
		random := make([]byte, 6)
		if _, err := rand.Read(random); err != nil {
			return 0, err
		}
		suffix := hex.EncodeToString(random)
		staged := mapping.Source + ".youeye-restore-new-" + suffix
		previous := mapping.Source + ".youeye-restore-old-" + suffix
		cmd := exec.Command("cp", "-a", "--", source, staged)
		if output, err := cmd.CombinedOutput(); err != nil {
			return 0, fmt.Errorf("stage volume restore: %w: %s", err, strings.TrimSpace(string(output)))
		}
		replacements = append(replacements, replacement{mapping: mapping, staged: staged, previous: previous})
	}

	rollback := func() {
		for index := len(replacements) - 1; index >= 0; index-- {
			item := &replacements[index]
			if !item.activated {
				continue
			}
			_ = os.RemoveAll(item.mapping.Source)
			if item.hadPrevious {
				_ = os.Rename(item.previous, item.mapping.Source)
			}
		}
	}

	// Activate as one logical transaction, retaining every old path until all
	// replacements are live. Any error rolls the already-activated paths back.
	for index := range replacements {
		item := &replacements[index]
		if _, err := os.Lstat(item.mapping.Source); err == nil {
			if err := os.Rename(item.mapping.Source, item.previous); err != nil {
				rollback()
				return 0, fmt.Errorf("retain previous volume: %w", err)
			}
			item.hadPrevious = true
		}
		if err := os.Rename(item.staged, item.mapping.Source); err != nil {
			if item.hadPrevious {
				_ = os.Rename(item.previous, item.mapping.Source)
			}
			rollback()
			return 0, fmt.Errorf("activate restored volume: %w", err)
		}
		item.activated = true
	}

	// Commit: previous paths are no longer rollback inputs after all new paths
	// are active. Cleanup is best-effort and cannot turn a committed restore
	// into a misleading failure.
	for _, item := range replacements {
		if item.hadPrevious {
			_ = os.RemoveAll(item.previous)
		}
	}
	return len(mappings), nil
}
