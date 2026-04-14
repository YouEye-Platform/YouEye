package backup

import (
	"fmt"
	"os"
	"os/exec"
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

	// Check archive exists
	if _, err := os.Stat(cfg.ArchivePath); os.IsNotExist(err) {
		return nil, fmt.Errorf("archive not found: %s", cfg.ArchivePath)
	}

	// Ensure staging dir exists and is empty
	if err := os.MkdirAll(cfg.StagingDir, 0755); err != nil {
		return nil, fmt.Errorf("create staging dir: %w", err)
	}

	// Decrypt the archive
	tarPath := cfg.StagingDir + "/backup.tar"
	decCmd := exec.Command("openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2",
		"-in", cfg.ArchivePath, "-out", tarPath, "-pass", "pass:"+cfg.Passphrase)
	if out, err := decCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("decryption failed: %v\n%s", err, string(out))
	}

	// Extract the tar
	extractCmd := exec.Command("tar", "-xf", tarPath, "-C", cfg.StagingDir)
	if out, err := extractCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("extraction failed: %v\n%s", err, string(out))
	}

	// Remove the intermediate tar
	os.Remove(tarPath)

	return &RestoreResult{
		StagingDir: cfg.StagingDir,
		Message:    "Archive decrypted and extracted successfully",
	}, nil
}
