package backup

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var incusNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
var imageFingerprintPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

const incusStoragePoolsRoot = "/var/lib/incus/storage-pools"

type IncusRuntimeRef struct {
	Name string `json:"name"`
	Type string `json:"type"` // oci or lxd
}

type IncusVolumeRef struct {
	Pool    string `json:"pool"`
	Name    string `json:"name"`
	Created bool   `json:"created,omitempty"`
}

type incusRuntimeArchive struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Fingerprint string   `json:"fingerprint,omitempty"`
	Files       []string `json:"files"`
}

type incusVolumeArchive struct {
	Pool string `json:"pool"`
	Name string `json:"name"`
	File string `json:"file"`
}

type incusRecoveryDocument struct {
	Schema   string                `json:"schema"`
	Runtimes []incusRuntimeArchive `json:"runtimes"`
	Volumes  []incusVolumeArchive  `json:"volumes"`
}

type IncusPrepareRequest struct {
	StagingDir string            `json:"staging_dir"`
	PoolMap    map[string]string `json:"pool_map"`
}

type IncusPreparedRuntime struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint,omitempty"`
	ArchivePath string `json:"archive_path,omitempty"`
}

type IncusPrepareResult struct {
	Status   string                 `json:"status"`
	Runtimes []IncusPreparedRuntime `json:"runtimes"`
	Volumes  []IncusVolumeRef       `json:"volumes"`
}

type IncusInstanceImportRequest struct {
	ArchivePath string `json:"archive_path"`
	Name        string `json:"name"`
	Pool        string `json:"pool"`
	Network     string `json:"network"`
}

func incusInstanceImportArgs(request IncusInstanceImportRequest) ([]string, error) {
	if !incusNamePattern.MatchString(request.Name) || !incusNamePattern.MatchString(request.Pool) || !incusNamePattern.MatchString(request.Network) {
		return nil, fmt.Errorf("invalid Incus instance import target")
	}
	return []string{
		"import", request.ArchivePath, request.Name,
		"--storage", request.Pool,
		"--device", "eth0,network=" + request.Network,
	}, nil
}

func validateIncusPlan(runtimes []IncusRuntimeRef, volumes []IncusVolumeRef) error {
	seenRuntime := map[string]bool{}
	for _, runtime := range runtimes {
		if !incusNamePattern.MatchString(runtime.Name) || (runtime.Type != "oci" && runtime.Type != "lxd") {
			return fmt.Errorf("invalid Incus runtime reference")
		}
		if seenRuntime[runtime.Name] {
			return fmt.Errorf("duplicate Incus runtime reference")
		}
		seenRuntime[runtime.Name] = true
	}
	seenVolume := map[string]bool{}
	for _, volume := range volumes {
		if !incusNamePattern.MatchString(volume.Pool) || !incusNamePattern.MatchString(volume.Name) {
			return fmt.Errorf("invalid Incus volume reference")
		}
		key := volume.Pool + "/" + volume.Name
		if seenVolume[key] {
			return fmt.Errorf("duplicate Incus volume reference")
		}
		seenVolume[key] = true
	}
	return nil
}

func createIncusVolumeSnapshots(volumes []IncusVolumeRef, snapshot string) ([]IncusVolumeRef, error) {
	created := make([]IncusVolumeRef, 0, len(volumes))
	for _, volume := range volumes {
		output, err := exec.Command("incus", "storage", "volume", "snapshot", "create", volume.Pool, volume.Name, snapshot).CombinedOutput()
		if err != nil {
			for _, existing := range created {
				deleteIncusVolumeSnapshot(existing, snapshot)
			}
			return nil, fmt.Errorf("snapshot custom volume %s/%s: %w: %s", volume.Pool, volume.Name, err, strings.TrimSpace(string(output)))
		}
		created = append(created, volume)
	}
	return created, nil
}

func deleteIncusVolumeSnapshot(volume IncusVolumeRef, snapshot string) {
	_ = exec.Command("incus", "storage", "volume", "snapshot", "delete", volume.Pool, volume.Name, snapshot).Run()
}

func runIncus(args ...string) error {
	output, err := exec.Command("incus", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("incus %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

func exportIncusAssets(
	stagingDir string,
	backupID string,
	snapshot string,
	runtimes []IncusRuntimeRef,
	volumes []IncusVolumeRef,
) error {
	if err := validateIncusPlan(runtimes, volumes); err != nil {
		return err
	}
	root := filepath.Join(stagingDir, "incus")
	if err := os.MkdirAll(root, 0700); err != nil {
		return fmt.Errorf("create Incus recovery directory: %w", err)
	}
	document := incusRecoveryDocument{
		Schema:   "youeye.backup.incus.v1",
		Runtimes: []incusRuntimeArchive{},
		Volumes:  []incusVolumeArchive{},
	}
	exportedImages := map[string][]string{}

	for index, runtime := range runtimes {
		runtimeDir := filepath.Join(root, "runtimes", runtime.Name)
		if err := os.MkdirAll(runtimeDir, 0700); err != nil {
			return err
		}
		entry := incusRuntimeArchive{Name: runtime.Name, Type: runtime.Type}
		if runtime.Type == "oci" {
			output, err := exec.Command("incus", "config", "get", runtime.Name, "volatile.base_image").CombinedOutput()
			if err != nil {
				return fmt.Errorf("read OCI image identity for %s: %w", runtime.Name, err)
			}
			fingerprint := strings.TrimSpace(string(output))
			if !imageFingerprintPattern.MatchString(fingerprint) {
				return fmt.Errorf("OCI runtime %s has no exact local image identity", runtime.Name)
			}
			entry.Fingerprint = fingerprint
			if files, ok := exportedImages[fingerprint]; ok {
				entry.Files = files
			} else {
				imageDir := filepath.Join(root, "images", fingerprint)
				if err := os.MkdirAll(imageDir, 0700); err != nil {
					return err
				}
				prefix := filepath.Join(imageDir, "image")
				if err := runIncus("image", "export", fingerprint, prefix); err != nil {
					return err
				}
				matches, err := filepath.Glob(prefix + "*")
				if err != nil || len(matches) == 0 {
					return fmt.Errorf("OCI image export for %s produced no files", runtime.Name)
				}
				// `incus image import` requires metadata before a separate rootfs.
				// Lexical order puts `.rootfs` before `.tar`, so make the contract
				// explicit rather than depending on filenames produced by Incus.
				sort.Slice(matches, func(i, j int) bool {
					iRoot := strings.Contains(filepath.Base(matches[i]), "rootfs")
					jRoot := strings.Contains(filepath.Base(matches[j]), "rootfs")
					if iRoot != jRoot {
						return !iRoot
					}
					return matches[i] < matches[j]
				})
				files := make([]string, 0, len(matches))
				for _, match := range matches {
					relative, err := filepath.Rel(stagingDir, match)
					if err != nil || strings.HasPrefix(relative, "..") {
						return fmt.Errorf("OCI image export escaped staging")
					}
					files = append(files, filepath.ToSlash(relative))
				}
				exportedImages[fingerprint] = files
				entry.Files = files
			}
		} else {
			clone := fmt.Sprintf("ye-backup-%s-%d", backupID[:min(12, len(backupID))], index)
			_ = exec.Command("incus", "delete", "-f", clone).Run()
			if err := runIncus("copy", runtime.Name+"/"+snapshot, clone); err != nil {
				return err
			}
			archive := filepath.Join(runtimeDir, "instance.tar.gz")
			exportErr := runIncus("export", clone, archive, "--instance-only")
			_ = exec.Command("incus", "delete", "-f", clone).Run()
			if exportErr != nil {
				return exportErr
			}
			entry.Files = []string{filepath.ToSlash(filepath.Join("incus", "runtimes", runtime.Name, "instance.tar.gz"))}
		}
		document.Runtimes = append(document.Runtimes, entry)
	}

	for index, volume := range volumes {
		clone := fmt.Sprintf("ye-backup-%s-v%d", backupID[:min(10, len(backupID))], index)
		_ = exec.Command("incus", "storage", "volume", "delete", volume.Pool, clone).Run()
		if err := runIncus("storage", "volume", "copy", volume.Pool+"/"+volume.Name+"/"+snapshot, volume.Pool+"/"+clone); err != nil {
			return err
		}
		volumeDir := filepath.Join(root, "volumes", volume.Pool)
		if err := os.MkdirAll(volumeDir, 0700); err != nil {
			return err
		}
		archive := filepath.Join(volumeDir, volume.Name+".tar.gz")
		exportErr := runIncus("storage", "volume", "export", volume.Pool, clone, archive)
		_ = exec.Command("incus", "storage", "volume", "delete", volume.Pool, clone).Run()
		if exportErr != nil {
			return exportErr
		}
		relative, _ := filepath.Rel(stagingDir, archive)
		document.Volumes = append(document.Volumes, incusVolumeArchive{
			Pool: volume.Pool,
			Name: volume.Name,
			File: filepath.ToSlash(relative),
		})
	}

	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(root, "recovery.json"), append(encoded, '\n'), 0600); err != nil {
		return fmt.Errorf("write Incus recovery document: %w", err)
	}
	return nil
}

func recoveryFile(stagingDir, relative string) (string, error) {
	if filepath.IsAbs(relative) {
		return "", fmt.Errorf("Incus recovery path must be relative")
	}
	root := filepath.Clean(stagingDir)
	resolved := filepath.Join(root, filepath.FromSlash(relative))
	if !pathWithin(root, resolved) {
		return "", fmt.Errorf("Incus recovery path escaped staging")
	}
	info, err := os.Lstat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("Incus recovery artifact is missing or unsafe")
	}
	return resolved, nil
}

func removeStaleCustomVolumeMountpoint(root, pool, name string) error {
	if !incusNamePattern.MatchString(pool) || !incusNamePattern.MatchString(name) {
		return fmt.Errorf("invalid Incus volume mountpoint identity")
	}
	mountpoint := filepath.Join(root, pool, "custom", "default_"+name)
	info, err := os.Lstat(mountpoint)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect stale Incus volume mountpoint: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("stale Incus volume mountpoint is not a plain directory")
	}
	// os.Remove succeeds only for an empty, unmounted directory. This repairs
	// the exact harmless mountpoint Incus can leave after deleting a shifted
	// custom volume, while a mount, restored data, or any unfamiliar content
	// remains a hard refusal.
	if err := os.Remove(mountpoint); err != nil {
		return fmt.Errorf("stale Incus volume mountpoint is not empty or is still in use: %w", err)
	}
	return nil
}

func temporaryIncusVolumeName() (string, error) {
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate temporary Incus volume name: %w", err)
	}
	return fmt.Sprintf("ye-restore-%x", random), nil
}

func exportedIncusImageFingerprint(files []string) (string, error) {
	hash := sha256.New()
	for _, file := range files {
		handle, err := os.Open(file)
		if err != nil {
			return "", fmt.Errorf("open exported Incus image: %w", err)
		}
		_, copyErr := io.Copy(hash, handle)
		closeErr := handle.Close()
		if copyErr != nil {
			return "", fmt.Errorf("hash exported Incus image: %w", copyErr)
		}
		if closeErr != nil {
			return "", fmt.Errorf("close exported Incus image: %w", closeErr)
		}
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func PrepareIncusRecovery(request IncusPrepareRequest) (result *IncusPrepareResult, returnErr error) {
	stagingDir := filepath.Clean(request.StagingDir)
	if !pathWithin(backupStagingRoot, stagingDir) {
		return nil, fmt.Errorf("staging directory is outside the protected backup workspace")
	}
	documentPath := filepath.Join(stagingDir, "incus", "recovery.json")
	encoded, err := os.ReadFile(documentPath)
	if os.IsNotExist(err) {
		return &IncusPrepareResult{
			Status:   "not-present",
			Runtimes: []IncusPreparedRuntime{},
			Volumes:  []IncusVolumeRef{},
		}, nil
	}
	if err != nil || len(encoded) > 1024*1024 {
		return nil, fmt.Errorf("read Incus recovery document")
	}
	var document incusRecoveryDocument
	if json.Unmarshal(encoded, &document) != nil || document.Schema != "youeye.backup.incus.v1" {
		return nil, fmt.Errorf("invalid Incus recovery document")
	}
	result = &IncusPrepareResult{
		Status:   "prepared",
		Runtimes: []IncusPreparedRuntime{},
		Volumes:  []IncusVolumeRef{},
	}
	createdVolumes := []IncusVolumeRef{}
	defer func() {
		if returnErr == nil {
			return
		}
		for _, volume := range createdVolumes {
			_ = exec.Command("incus", "storage", "volume", "delete", volume.Pool, volume.Name).Run()
		}
	}()

	for _, runtime := range document.Runtimes {
		if !incusNamePattern.MatchString(runtime.Name) || (runtime.Type != "oci" && runtime.Type != "lxd") {
			return nil, fmt.Errorf("invalid Incus runtime archive")
		}
		prepared := IncusPreparedRuntime{Name: runtime.Name, Type: runtime.Type, Fingerprint: runtime.Fingerprint}
		if runtime.Type == "oci" {
			if !imageFingerprintPattern.MatchString(runtime.Fingerprint) || len(runtime.Files) == 0 || len(runtime.Files) > 2 {
				return nil, fmt.Errorf("invalid OCI image recovery record")
			}
			if exec.Command("incus", "image", "show", runtime.Fingerprint).Run() != nil {
				args := []string{"image", "import"}
				imageFiles := make([]string, 0, len(runtime.Files))
				for _, relative := range runtime.Files {
					file, err := recoveryFile(stagingDir, relative)
					if err != nil {
						return nil, err
					}
					args = append(args, file)
					imageFiles = append(imageFiles, file)
				}
				// Incus identifies a split exported image by the SHA-256 of its
				// metadata and rootfs files concatenated in import order. OCI source
				// fingerprints can therefore differ from the self-contained export.
				// Return the imported identity to the installer, while retaining the
				// source fingerprint in the authenticated recovery document.
				importedFingerprint, err := exportedIncusImageFingerprint(imageFiles)
				if err != nil {
					return nil, err
				}
				if exec.Command("incus", "image", "show", importedFingerprint).Run() != nil {
					if err := runIncus(args...); err != nil {
						return nil, err
					}
				}
				if exec.Command("incus", "image", "show", importedFingerprint).Run() != nil {
					return nil, fmt.Errorf("imported OCI image identity did not read back")
				}
				// `incus image export` preserves the OCI rootfs but its generated
				// metadata tar does not retain the `type=oci` image property. Without
				// restoring it, Incus rejects OCI-only instance configuration such as
				// `oci.entrypoint` when the app is recreated from the local export.
				if err := runIncus("image", "set-property", importedFingerprint, "type=oci"); err != nil {
					return nil, err
				}
				property, err := exec.Command("incus", "image", "get-property", importedFingerprint, "type").CombinedOutput()
				if err != nil || strings.TrimSpace(string(property)) != "oci" {
					return nil, fmt.Errorf("imported OCI image type did not read back")
				}
				prepared.Fingerprint = importedFingerprint
			}
		} else {
			if len(runtime.Files) != 1 {
				return nil, fmt.Errorf("invalid LXD runtime recovery record")
			}
			prepared.ArchivePath, err = recoveryFile(stagingDir, runtime.Files[0])
			if err != nil {
				return nil, err
			}
		}
		result.Runtimes = append(result.Runtimes, prepared)
	}

	for _, volume := range document.Volumes {
		if !incusNamePattern.MatchString(volume.Pool) || !incusNamePattern.MatchString(volume.Name) {
			return nil, fmt.Errorf("invalid Incus volume archive")
		}
		targetPool := volume.Pool
		if mapped := request.PoolMap[volume.Pool]; mapped != "" {
			targetPool = mapped
		}
		if !incusNamePattern.MatchString(targetPool) {
			return nil, fmt.Errorf("invalid target storage pool")
		}
		if exec.Command("incus", "storage", "show", targetPool).Run() != nil {
			return nil, fmt.Errorf("target storage pool %s is unavailable", targetPool)
		}
		created := false
		if exec.Command("incus", "storage", "volume", "show", targetPool, volume.Name).Run() != nil {
			if err := removeStaleCustomVolumeMountpoint(incusStoragePoolsRoot, targetPool, volume.Name); err != nil {
				return nil, err
			}
			archive, err := recoveryFile(stagingDir, volume.File)
			if err != nil {
				return nil, err
			}
			// Import under a one-use name, then atomically rename to the logical
			// target. Incus can reject a direct re-import under a recently deleted
			// shifted volume name with "In use", despite the volume being absent.
			// The supported rename path avoids reusing that name during import.
			temporaryName, err := temporaryIncusVolumeName()
			if err != nil {
				return nil, err
			}
			if err := runIncus("storage", "volume", "import", targetPool, archive, temporaryName); err != nil {
				return nil, err
			}
			if err := removeStaleCustomVolumeMountpoint(incusStoragePoolsRoot, targetPool, volume.Name); err != nil {
				_ = exec.Command("incus", "storage", "volume", "delete", targetPool, temporaryName).Run()
				return nil, err
			}
			if err := runIncus("storage", "volume", "rename", targetPool, temporaryName, volume.Name); err != nil {
				_ = exec.Command("incus", "storage", "volume", "delete", targetPool, temporaryName).Run()
				return nil, err
			}
			created = true
			createdVolumes = append(createdVolumes, IncusVolumeRef{Pool: targetPool, Name: volume.Name, Created: true})
			if exec.Command("incus", "storage", "volume", "show", targetPool, volume.Name).Run() != nil {
				return nil, fmt.Errorf("imported app storage did not read back")
			}
		}
		result.Volumes = append(result.Volumes, IncusVolumeRef{Pool: targetPool, Name: volume.Name, Created: created})
	}
	return result, nil
}

func ImportIncusInstance(request IncusInstanceImportRequest) error {
	archive := filepath.Clean(request.ArchivePath)
	request.ArchivePath = archive
	args, err := incusInstanceImportArgs(request)
	if err != nil {
		return err
	}
	if !pathWithin(backupStagingRoot, archive) {
		return fmt.Errorf("instance archive is outside the protected restore workspace")
	}
	info, err := os.Lstat(archive)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("instance archive is missing or unsafe")
	}
	if exec.Command("incus", "info", request.Name).Run() == nil {
		return fmt.Errorf("target instance already exists")
	}
	if exec.Command("incus", "network", "show", request.Network).Run() != nil {
		return fmt.Errorf("target instance network is unavailable")
	}
	if err := runIncus(args...); err != nil {
		return err
	}
	return nil
}
