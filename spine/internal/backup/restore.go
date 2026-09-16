package backup

import (
	"archive/tar"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// RestoreConfig is the request body for POST /api/backup/restore.
type RestoreConfig struct {
	ArchivePath string `json:"archive_path"`
	Passphrase  string `json:"passphrase"`
	StagingDir  string `json:"staging_dir"`
}

// RestoreResult is returned upon completion.
type RestoreResult struct {
	StagingDir string `json:"staging_dir"`
	Message    string `json:"message"`
}

// RestoreArchive decrypts and extracts a backup archive to the staging directory.
// The actual app/platform restore logic lives in CP.
func RestoreArchive(cfg RestoreConfig) (*RestoreResult, error) {
	// Validate inputs
	if cfg.ArchivePath == "" {
		return nil, fmt.Errorf("archive_path is required")
	}
	if cfg.Passphrase == "" {
		return nil, fmt.Errorf("passphrase is required")
	}
	if cfg.StagingDir == "" {
		return nil, fmt.Errorf("staging_dir is required")
	}

	cfg.ArchivePath = filepath.Clean(cfg.ArchivePath)
	cfg.StagingDir = filepath.Clean(cfg.StagingDir)
	if !pathWithin(filepath.Join(backupDataRoot, "backups"), cfg.ArchivePath) {
		return nil, fmt.Errorf("archive path is outside the protected backup directory")
	}
	if !pathWithin(backupStagingRoot, cfg.StagingDir) {
		return nil, fmt.Errorf("staging directory is outside the protected backup workspace")
	}

	// Check archive exists and is not a link or special file.
	archiveInfo, err := os.Lstat(cfg.ArchivePath)
	if err != nil {
		return nil, fmt.Errorf("archive not found: %s", cfg.ArchivePath)
	}
	if !archiveInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("archive must be a regular file")
	}
	if err := verifyArchiveMAC(cfg.ArchivePath, cfg.Passphrase); err != nil {
		return nil, err
	}

	// Ensure staging dir is private and empty.
	if err := os.RemoveAll(cfg.StagingDir); err != nil {
		return nil, fmt.Errorf("clear staging dir: %w", err)
	}
	if err := os.MkdirAll(cfg.StagingDir, 0700); err != nil {
		return nil, fmt.Errorf("create staging dir: %w", err)
	}

	// Decrypt the archive
	tarPath := cfg.StagingDir + "/backup.tar"
	decCmd := opensslWithPassphrase(cfg.Passphrase, "enc", "-d", "-aes-256-cbc", "-pbkdf2",
		"-in", cfg.ArchivePath, "-out", tarPath)
	if out, err := decCmd.CombinedOutput(); err != nil {
		os.Remove(tarPath)
		return nil, fmt.Errorf("decryption failed: %v\n%s", err, string(out))
	}
	defer os.Remove(tarPath)
	if err := validateRestoreTar(tarPath, cfg.StagingDir); err != nil {
		return nil, err
	}

	// Extract the tar
	extractCmd := exec.Command("tar", "--numeric-owner", "--same-permissions", "-xf", tarPath, "-C", cfg.StagingDir)
	if out, err := extractCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("extraction failed: %v\n%s", err, string(out))
	}

	// Remove the intermediate tar
	return &RestoreResult{
		StagingDir: cfg.StagingDir,
		Message:    "Archive decrypted and extracted successfully",
	}, nil
}

func validateRestoreTar(tarPath, stagingDir string) error {
	file, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer file.Close()
	var filesystem syscall.Statfs_t
	if err := syscall.Statfs(stagingDir, &filesystem); err != nil {
		return fmt.Errorf("inspect restore capacity: %w", err)
	}
	available := int64(filesystem.Bavail) * int64(filesystem.Bsize)
	const headroom = int64(512 * 1024 * 1024)
	var expanded int64
	type archiveLink struct {
		name     string
		target   string
		typeflag byte
	}
	var links []archiveLink
	var volumeMap []byte
	reader := tar.NewReader(file)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read decrypted archive: %w", err)
		}
		name := filepath.Clean(filepath.FromSlash(header.Name))
		if name == "." {
			continue
		}
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return fmt.Errorf("archive contains an unsafe path")
		}
		switch header.Typeflag {
		case tar.TypeReg, tar.TypeRegA, tar.TypeDir:
		case tar.TypeSymlink, tar.TypeLink:
			links = append(links, archiveLink{name: name, target: header.Linkname, typeflag: header.Typeflag})
		default:
			return fmt.Errorf("archive contains a link or special file")
		}
		if header.Size < 0 || expanded > available-headroom-header.Size {
			return fmt.Errorf("archive does not fit in the protected restore workspace")
		}
		expanded += header.Size
		if name == "volume-map.json" {
			const maximumVolumeMapBytes = int64(1024 * 1024)
			if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
				return fmt.Errorf("archive volume map must be a regular file")
			}
			if header.Size > maximumVolumeMapBytes {
				return fmt.Errorf("archive volume map is too large")
			}
			volumeMap, err = io.ReadAll(io.LimitReader(reader, maximumVolumeMapBytes+1))
			if err != nil {
				return fmt.Errorf("read archive volume map: %w", err)
			}
		}
	}
	if len(links) == 0 {
		return nil
	}
	var document volumeMapDocument
	if len(volumeMap) == 0 || json.Unmarshal(volumeMap, &document) != nil || document.Schema != "youeye.backup.volume-map.v1" {
		return fmt.Errorf("archive links require a valid volume map")
	}
	archiveRoots := make([]string, 0, len(document.Volumes))
	for index := range document.Volumes {
		validated, err := validateVolumeMapping(document.Volumes[index])
		if err != nil {
			return fmt.Errorf("archive volume %d: %w", index, err)
		}
		archiveRoots = append(archiveRoots, filepath.Clean(filepath.FromSlash(validated.ArchivePath)))
	}
	for _, link := range links {
		root := ""
		for _, candidate := range archiveRoots {
			if pathWithin(candidate, link.name) && len(candidate) > len(root) {
				root = candidate
			}
		}
		if root == "" || link.target == "" || filepath.IsAbs(filepath.FromSlash(link.target)) {
			return fmt.Errorf("archive contains an unsafe link")
		}
		target := filepath.Clean(filepath.FromSlash(link.target))
		if link.typeflag == tar.TypeSymlink {
			target = filepath.Clean(filepath.Join(filepath.Dir(link.name), target))
		}
		if !pathWithin(root, target) {
			return fmt.Errorf("archive contains a link that escapes its volume")
		}
	}
	return nil
}
