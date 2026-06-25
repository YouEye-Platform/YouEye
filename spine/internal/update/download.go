package update

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
)

// DownloadBinary downloads a binary from url to destPath using the provided HTTP client.
// The destination file is created and made executable (0755).
func DownloadBinary(client *http.Client, url, destPath string) error {
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	f, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("failed to create dest file: %w", err)
	}

	_, writeErr := io.Copy(f, resp.Body)
	f.Close()
	if writeErr != nil {
		os.Remove(destPath)
		return fmt.Errorf("failed to write binary: %w", writeErr)
	}

	if err := os.Chmod(destPath, 0755); err != nil {
		os.Remove(destPath)
		return fmt.Errorf("failed to set permissions: %w", err)
	}

	return nil
}

// VerifyChecksum verifies that the file at path matches the expected SHA-256 hex checksum.
func VerifyChecksum(path, expectedSHA256 string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("failed to open file: %w", err)
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("failed to hash file: %w", err)
	}

	actual := hex.EncodeToString(h.Sum(nil))
	if actual != expectedSHA256 {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedSHA256, actual)
	}
	return nil
}

// AtomicInstall replaces dest with src atomically.
// Uses os.Rename for same-filesystem moves; falls back to copy for cross-device.
// Creates a .backup of dest before replacing.
// Returns the path to the backup (empty string if no existing dest was found).
func AtomicInstall(src, dest string) (backupPath string, err error) {
	backupPath = dest + ".backup"
	if copyErr := copyBinary(dest, backupPath); copyErr != nil {
		backupPath = "" // no existing file to back up
	}

	// Unlink current binary so running processes keep their inode alive
	os.Remove(dest)

	if renameErr := os.Rename(src, dest); renameErr != nil {
		// Cross-device: fall back to copy
		if copyErr := copyBinary(src, dest); copyErr != nil {
			// Restore from backup
			if backupPath != "" {
				if restoreErr := copyBinary(backupPath, dest); restoreErr != nil {
					return backupPath, fmt.Errorf("install failed (%w) and restore failed (%v)", copyErr, restoreErr)
				}
			}
			os.Remove(src)
			return backupPath, fmt.Errorf("failed to install binary: %w", copyErr)
		}
		os.Remove(src)
	}

	return backupPath, nil
}

// RollbackInstall restores dest from backupPath.
func RollbackInstall(dest, backupPath string) error {
	if backupPath == "" {
		return fmt.Errorf("no backup available for rollback")
	}
	if err := copyBinary(backupPath, dest); err != nil {
		return fmt.Errorf("rollback failed: %w", err)
	}
	return nil
}

// copyBinary copies src to dst preserving content.
func copyBinary(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}

	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}
