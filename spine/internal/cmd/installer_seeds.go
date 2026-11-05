package cmd

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// installerSeedPaths is deliberately narrow. These files are written by the
// installer before Spine prepares dedicated data storage, and Spine needs them
// after default/data is mounted over /var/lib/youeye. Other pre-mount files are
// not installer inputs and must not be copied into a fresh data dataset.
var installerSeedPaths = []string{
	filepath.Join("config", "config.yaml"),
	filepath.Join("config", "youeye.yaml"),
	"market-source.json",
	"market-sources.json",
}

type installerSeed struct {
	relativePath string
	contents     []byte
	mode         fs.FileMode
	uid          int
	gid          int
}

// preserveInstallerSeedsAcrossDataMount snapshots installer-owned inputs in
// memory, invokes the operation which may mount a dataset over root, then
// atomically seeds missing inputs into the now-visible filesystem. Existing
// persistent files always win: the sealed image defaults are first-install
// material and must never replace owner configuration on a later boot.
// Seeding is attempted even when the mount operation reports an error because
// that operation may have mounted an empty dataset before verification failed.
func preserveInstallerSeedsAcrossDataMount(root string, mount func() error) error {
	seeds, err := captureInstallerSeeds(root)
	if err != nil {
		return err
	}

	mountErr := mount()
	restoreErr := restoreInstallerSeeds(root, seeds)
	return errors.Join(mountErr, restoreErr)
}

func captureInstallerSeeds(root string) ([]installerSeed, error) {
	seeds := make([]installerSeed, 0, len(installerSeedPaths))
	for _, relativePath := range installerSeedPaths {
		path := filepath.Join(root, relativePath)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("reading installer seed metadata %s: %w", path, err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("installer seed %s is not a regular file", path)
		}

		contents, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("reading installer seed %s: %w", path, err)
		}

		seed := installerSeed{
			relativePath: relativePath,
			contents:     contents,
			mode:         info.Mode().Perm(),
			uid:          -1,
			gid:          -1,
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			seed.uid = int(stat.Uid)
			seed.gid = int(stat.Gid)
		}
		seeds = append(seeds, seed)
	}
	return seeds, nil
}

func restoreInstallerSeeds(root string, seeds []installerSeed) error {
	var restoreErr error
	for _, seed := range seeds {
		if err := restoreInstallerSeed(root, seed); err != nil {
			restoreErr = errors.Join(restoreErr, err)
		}
	}
	return restoreErr
}

func restoreInstallerSeed(root string, seed installerSeed) (returnErr error) {
	destination := filepath.Join(root, seed.relativePath)
	directory := filepath.Dir(destination)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("creating installer seed directory %s: %w", directory, err)
	}
	if info, err := os.Lstat(destination); err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("persistent installer seed %s is not a regular file", destination)
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("reading persistent installer seed %s: %w", destination, err)
	}

	temporary, err := os.CreateTemp(directory, ".youeye-installer-seed-*")
	if err != nil {
		return fmt.Errorf("creating temporary installer seed for %s: %w", destination, err)
	}
	temporaryPath := temporary.Name()
	temporaryClosed := false
	defer func() {
		if !temporaryClosed {
			if err := temporary.Close(); err != nil && returnErr == nil {
				returnErr = fmt.Errorf("closing temporary installer seed for %s: %w", destination, err)
			}
		}
		if err := os.Remove(temporaryPath); err != nil && !errors.Is(err, os.ErrNotExist) && returnErr == nil {
			returnErr = fmt.Errorf("removing temporary installer seed for %s: %w", destination, err)
		}
	}()

	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("protecting temporary installer seed for %s: %w", destination, err)
	}
	if _, err := temporary.Write(seed.contents); err != nil {
		return fmt.Errorf("writing installer seed %s: %w", destination, err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("syncing installer seed %s: %w", destination, err)
	}
	if seed.uid >= 0 && seed.gid >= 0 {
		if err := temporary.Chown(seed.uid, seed.gid); err != nil {
			return fmt.Errorf("restoring installer seed ownership for %s: %w", destination, err)
		}
	}
	if err := temporary.Chmod(seed.mode); err != nil {
		return fmt.Errorf("restoring installer seed permissions for %s: %w", destination, err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("closing installer seed %s: %w", destination, err)
	}
	temporaryClosed = true
	if err := os.Link(temporaryPath, destination); err != nil {
		if errors.Is(err, os.ErrExist) {
			return nil
		}
		return fmt.Errorf("publishing missing installer seed %s: %w", destination, err)
	}
	if err := os.Remove(temporaryPath); err != nil {
		return fmt.Errorf("removing published installer seed temporary %s: %w", destination, err)
	}

	dirHandle, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("opening installer seed directory %s: %w", directory, err)
	}
	defer dirHandle.Close()
	if err := dirHandle.Sync(); err != nil {
		return fmt.Errorf("syncing installer seed directory %s: %w", directory, err)
	}
	return nil
}
