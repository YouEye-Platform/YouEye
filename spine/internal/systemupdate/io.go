package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func (m *Manager) callWriteRoot(ctx context.Context, source string, artifact Artifact, target string) error {
	if m.config.WriteRoot != nil {
		return m.config.WriteRoot(ctx, source, artifact, target)
	}
	return m.writeRoot(ctx, source, artifact, target)
}

func (m *Manager) callVerifyTarget(ctx context.Context, device string, manifest Manifest) error {
	if m.config.VerifyTarget != nil {
		return m.config.VerifyTarget(ctx, device, manifest)
	}
	return m.verifyTargetMarker(ctx, device, manifest)
}

func (m *Manager) callVerifyStagedRoot(ctx context.Context, device string, artifact Artifact) error {
	if m.config.VerifyStagedRoot != nil {
		return m.config.VerifyStagedRoot(ctx, device, artifact)
	}
	return m.verifyRootReadback(ctx, device, artifact)
}

func (m *Manager) callVerifyBootAssets(ctx context.Context, layout Layout, manifest Manifest) error {
	if m.config.VerifyBootAssets != nil {
		return m.config.VerifyBootAssets(ctx, layout, manifest)
	}
	return m.verifyBootAssets(ctx, layout, manifest)
}

func (m *Manager) callInstallBootAssets(ctx context.Context, layout Layout, manifest Manifest, ukiPath, manifestPath, signaturePath string) error {
	if m.config.InstallBootAssets != nil {
		return m.config.InstallBootAssets(ctx, layout, manifest, ukiPath, manifestPath, signaturePath)
	}
	return m.installBootAssets(ctx, layout, manifest, ukiPath, manifestPath, signaturePath)
}

func (m *Manager) callCreateBootEntry(layout Layout, manifest Manifest) error {
	if m.config.CreateBootEntry != nil {
		return m.config.CreateBootEntry(layout, manifest)
	}
	return m.createBootEntry(layout, manifest)
}

func (m *Manager) callRemoveBootEntries(layout Layout) error {
	if m.config.RemoveBootEntries != nil {
		return m.config.RemoveBootEntries(layout)
	}
	return m.removeInactiveEntries(layout)
}

func (m *Manager) writeRoot(ctx context.Context, source string, artifact Artifact, target string) error {
	script := `set -o pipefail; zstd -dc -- "$1" | dd of="$2" bs=16M conv=fsync status=none`
	if output, err := m.config.Run(ctx, "bash", "-c", script, "youeye-system-update", source, target); err != nil {
		return fmt.Errorf("write inactive System root: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return m.verifyRootReadback(ctx, target, artifact)
}

func (m *Manager) verifyRootReadback(ctx context.Context, target string, artifact Artifact) error {
	file, err := os.Open(target)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, copyErr := io.CopyN(hash, file, artifact.UncompressedSizeBytes)
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("read back inactive System root: %w", copyErr)
	}
	if closeErr != nil {
		return closeErr
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != artifact.UncompressedSHA256 {
		return fmt.Errorf("inactive System readback SHA-256 mismatch: got %s", got)
	}
	if output, err := m.config.Run(ctx, "e2fsck", "-f", "-n", target); err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() > 1 {
			return fmt.Errorf("validate inactive System filesystem: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	return nil
}

func (m *Manager) verifyBootAssets(ctx context.Context, layout Layout, manifest Manifest) error {
	entriesDir := filepath.Join(m.config.ESPMountpoint, "loader", "entries")
	if err := m.verifyESPMount(ctx, layout.ESP.Path, entriesDir); err != nil {
		return err
	}
	slotLower := strings.ToLower(layout.InactiveSlot)
	role := "system-" + slotLower + "-uki"
	artifact, ok := manifest.Artifact(role)
	if !ok {
		return fmt.Errorf("signed manifest has no %s", role)
	}
	espAsset := filepath.Join(m.config.ESPMountpoint, "EFI", "YouEye", "youeye-system-"+slotLower+".efi")
	backupAsset := filepath.Join(appliance.StateMountpoint, "system-update", "boot", slotLower, manifest.TargetImageVersion, "system.efi")
	for _, candidate := range []string{espAsset, backupAsset} {
		if err := verifyFile(candidate, artifact.SizeBytes, artifact.SHA256); err != nil {
			return fmt.Errorf("verify staged System %s boot asset %s: %w", layout.InactiveSlot, candidate, err)
		}
	}
	return nil
}

func (m *Manager) verifyTargetMarker(ctx context.Context, device string, update Manifest) error {
	mountpoint := filepath.Join(filepath.Dir(m.config.JournalPath), "verify-root")
	if err := os.MkdirAll(mountpoint, 0700); err != nil {
		return err
	}
	if output, err := m.config.Run(ctx, "mount", "-t", "ext4", "-o", "ro,noload,nodev,nosuid,noexec", device, mountpoint); err != nil {
		return fmt.Errorf("mount inactive System for verification: %w: %s", err, strings.TrimSpace(string(output)))
	}
	defer m.config.Run(context.Background(), "umount", mountpoint)
	raw, err := os.ReadFile(filepath.Join(mountpoint, strings.TrimPrefix(appliance.ManifestPath, "/")))
	if err != nil {
		return fmt.Errorf("read target sealed marker: %w", err)
	}
	target, err := appliance.ParseManifest(raw)
	if err != nil {
		return fmt.Errorf("parse target sealed marker: %w", err)
	}
	if target.ReleaseSet == nil || target.ImageVersion != update.TargetImageVersion ||
		target.BuildID != update.BuildID || target.SourceCommit != update.SourceCommit || target.Architecture != update.Architecture ||
		target.FirmwareMode != update.FirmwareMode || target.DiskLayoutVersion != update.DiskLayoutVersion ||
		target.RecoveryVersion != update.RecoveryVersion || target.ArtifactKind != update.ArtifactKind ||
		!reflect.DeepEqual(*target.ReleaseSet, update.ReleaseSet) {
		return errors.New("target sealed marker does not match the signed system update manifest")
	}
	found := false
	for _, action := range target.SupportedActions {
		if action == "image-update" {
			found = true
		}
	}
	if !found {
		return errors.New("target sealed marker does not support transactional system updates")
	}
	return nil
}

func (m *Manager) installBootAssets(ctx context.Context, layout Layout, manifest Manifest, ukiPath, manifestPath, signaturePath string) error {
	entriesDir := filepath.Join(m.config.ESPMountpoint, "loader", "entries")
	vendorDir := filepath.Join(m.config.ESPMountpoint, "EFI", "YouEye")
	if err := os.MkdirAll(entriesDir, 0755); err != nil {
		return err
	}
	if err := os.MkdirAll(vendorDir, 0755); err != nil {
		return err
	}
	if err := m.verifyESPMount(ctx, layout.ESP.Path, entriesDir); err != nil {
		return err
	}
	if err := m.removeInactiveEntries(layout); err != nil {
		return err
	}
	slotLower := strings.ToLower(layout.InactiveSlot)
	ukiDestination := filepath.Join(vendorDir, "youeye-system-"+slotLower+".efi")
	if err := atomicCopy(ukiPath, ukiDestination, 0644); err != nil {
		return err
	}

	backupDir := filepath.Join(appliance.StateMountpoint, "system-update", "boot", slotLower, manifest.TargetImageVersion)
	if err := os.MkdirAll(backupDir, 0700); err != nil {
		return err
	}
	if err := atomicCopy(ukiPath, filepath.Join(backupDir, "system.efi"), 0600); err != nil {
		return err
	}
	if err := atomicCopy(manifestPath, filepath.Join(backupDir, "manifest.json"), 0600); err != nil {
		return err
	}
	if err := atomicCopy(signaturePath, filepath.Join(backupDir, "manifest.json.sig"), 0600); err != nil {
		return err
	}
	if err := syncDirectory(entriesDir); err != nil {
		return err
	}
	return syncDirectory(vendorDir)
}

func (m *Manager) createBootEntry(layout Layout, manifest Manifest) error {
	if err := m.removeInactiveEntries(layout); err != nil {
		return err
	}
	slotLower := strings.ToLower(layout.InactiveSlot)
	entry := fmt.Sprintf("title YouEye System %s\nsort-key youeye-system\nversion %s-%s\nefi /EFI/YouEye/youeye-system-%s.efi\n", layout.InactiveSlot, manifest.TargetImageVersion, slotLower, slotLower)
	entryPath := filepath.Join(m.config.ESPMountpoint, "loader", "entries", fmt.Sprintf("youeye-system-%s+%d-0.conf", slotLower, manifest.BootAttempts))
	if err := atomicWrite(entryPath, []byte(entry), 0644); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(entryPath))
}

func (m *Manager) removeInactiveEntries(layout Layout) error {
	entriesDir := filepath.Join(m.config.ESPMountpoint, "loader", "entries")
	slotLower := strings.ToLower(layout.InactiveSlot)
	patterns := []string{"youeye-system-" + slotLower + ".conf", "youeye-system-" + slotLower + "+*.conf"}
	for _, pattern := range patterns {
		matches, err := filepath.Glob(filepath.Join(entriesDir, pattern))
		if err != nil {
			return err
		}
		for _, match := range matches {
			if err := os.Remove(match); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	return syncDirectory(entriesDir)
}

func (m *Manager) verifyESPMount(ctx context.Context, expectedDevice, target string) error {
	// Looking up a child path activates systemd's /efi automount before findmnt
	// verifies the effective backing device.
	if _, err := os.Stat(target); err != nil {
		return fmt.Errorf("access ESP mount at %s: %w", target, err)
	}
	output, err := m.config.Run(ctx, "findmnt", "-n", "-o", "SOURCE", "--target", target)
	if err != nil {
		return fmt.Errorf("verify ESP mount: %w: %s", err, strings.TrimSpace(string(output)))
	}
	gotSource := deepestMountSource(output)
	got, gotErr := filepath.EvalSymlinks(gotSource)
	want, wantErr := filepath.EvalSymlinks(expectedDevice)
	if gotErr != nil || wantErr != nil || got != want {
		return errors.New("/efi is not mounted from the discovered YE-ESP partition")
	}
	return nil
}

func deepestMountSource(output []byte) string {
	lines := strings.Split(string(output), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		if source := strings.TrimSpace(lines[index]); source != "" {
			return source
		}
	}
	return ""
}

func (m *Manager) downloadSource(ctx context.Context, source, partial, destination string, expectedSize int64, expectedSHA string) error {
	if expectedSize > 0 {
		if err := verifyFile(destination, expectedSize, expectedSHA); err == nil {
			return nil
		}
	}
	parsed, err := url.Parse(source)
	if err != nil {
		return err
	}
	if parsed.Scheme == "http" || parsed.Scheme == "https" {
		if err := validateRemoteURL(parsed); err != nil {
			return err
		}
		if err := m.downloadHTTP(ctx, parsed.String(), partial, expectedSize); err != nil {
			return err
		}
	} else if parsed.Scheme == "" {
		if err := atomicCopy(source, partial, 0600); err != nil {
			return err
		}
	} else {
		return fmt.Errorf("unsupported system update source scheme %q", parsed.Scheme)
	}
	if expectedSize > 0 {
		if err := verifyFile(partial, expectedSize, expectedSHA); err != nil {
			return err
		}
	}
	if err := os.Rename(partial, destination); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(destination))
}

func (m *Manager) downloadSourceAtMost(ctx context.Context, source, partial, destination string, maximumSize int64) error {
	if maximumSize <= 0 {
		return errors.New("metadata download limit must be positive")
	}
	parsed, err := url.Parse(source)
	if err != nil {
		return err
	}
	if parsed.Scheme == "http" || parsed.Scheme == "https" {
		if err := validateRemoteURL(parsed); err != nil {
			return err
		}
		if err := m.downloadHTTP(ctx, parsed.String(), partial, maximumSize); err != nil {
			return err
		}
	} else if parsed.Scheme == "" {
		info, err := os.Stat(source)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maximumSize {
			return errors.New("system update metadata size is invalid")
		}
		if err := atomicCopy(source, partial, 0600); err != nil {
			return err
		}
	} else {
		return fmt.Errorf("unsupported system update source scheme %q", parsed.Scheme)
	}
	info, err := os.Stat(partial)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maximumSize {
		return errors.New("system update metadata size is invalid")
	}
	if err := os.Rename(partial, destination); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(destination))
}

func (m *Manager) downloadHTTP(ctx context.Context, source, partial string, expectedSize int64) error {
	if err := os.MkdirAll(filepath.Dir(partial), 0700); err != nil {
		return err
	}
	offset := int64(0)
	if info, err := os.Stat(partial); err == nil {
		offset = info.Size()
		if expectedSize > 0 && offset > expectedSize {
			offset = 0
		}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	if offset > 0 {
		request.Header.Set("Range", "bytes="+strconv.FormatInt(offset, 10)+"-")
	}
	response, err := m.config.HTTPClient.Do(request)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			return fmt.Errorf("system update HTTP request failed: %w", urlErr.Err)
		}
		return err
	}
	defer response.Body.Close()
	origin, err := url.Parse(source)
	if err != nil {
		return err
	}
	if err := validateSystemUpdateDownloadURL(response.Request.URL, origin); err != nil {
		return err
	}
	flags := os.O_CREATE | os.O_WRONLY
	if offset > 0 && response.StatusCode == http.StatusPartialContent && strings.HasPrefix(response.Header.Get("Content-Range"), "bytes "+strconv.FormatInt(offset, 10)+"-") {
		flags |= os.O_APPEND
	} else {
		offset = 0
		flags |= os.O_TRUNC
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("download returned HTTP %d", response.StatusCode)
	}
	file, err := os.OpenFile(partial, flags, 0600)
	if err != nil {
		return err
	}
	reader := io.Reader(response.Body)
	if expectedSize > 0 {
		reader = io.LimitReader(response.Body, expectedSize-offset+1)
	}
	written, copyErr := io.Copy(file, reader)
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if expectedSize > 0 && offset+written > expectedSize {
		return errors.New("download exceeds signed artifact size")
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func validateRemoteURL(remote *url.URL) error {
	if remote == nil || (remote.Scheme != "http" && remote.Scheme != "https") || remote.Host == "" {
		return errors.New("system update URL must be absolute HTTP or HTTPS")
	}
	if remote.User != nil || remote.RawQuery != "" || remote.Fragment != "" {
		return errors.New("credential-bearing, query, and fragment system update URLs are not allowed")
	}
	return nil
}

func resolveArtifactSource(manifestSource, artifactPath string) (string, error) {
	parsed, err := url.Parse(manifestSource)
	if err != nil {
		return "", err
	}
	if parsed.Scheme == "http" || parsed.Scheme == "https" {
		if err := validateRemoteURL(parsed); err != nil {
			return "", err
		}
		parsed.Path = path.Join(path.Dir(parsed.Path), artifactPath)
		return parsed.String(), nil
	}
	if parsed.Scheme != "" {
		return "", fmt.Errorf("unsupported manifest source scheme %q", parsed.Scheme)
	}
	return filepath.Join(filepath.Dir(manifestSource), artifactPath), nil
}

func verifyFile(filePath string, expectedSize int64, expectedSHA string) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != expectedSize {
		return errors.New("artifact size mismatch")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != expectedSHA {
		return errors.New("artifact SHA-256 mismatch")
	}
	return nil
}
