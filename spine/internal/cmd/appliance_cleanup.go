package cmd

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	hoststorage "github.com/youeye-platform/YouEye/spine/internal/storage"
)

type applianceCleanupOps interface {
	Containers() []containerInfo
	Images() []string
	Networks() []string
	StoragePools() []string
	Run(string, ...string) error
	ResetData(bool) error
	ResetState() error
}

type systemApplianceCleanupOps struct{}

var applianceConfigSeedRoot = "/usr/lib/youeye/config-seeds"
var applianceDataRoot = "/var/lib/youeye"

func seedFactoryApplianceConfig(sourceRoot, dataRoot string) error {
	for _, name := range []string{"config.yaml", "youeye.yaml"} {
		source := filepath.Join(sourceRoot, name)
		info, err := os.Lstat(source)
		if err != nil {
			return fmt.Errorf("read sealed appliance config seed %s: %w", name, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("sealed appliance config seed %s is not a regular file", name)
		}
		contents, err := os.ReadFile(source)
		if err != nil {
			return fmt.Errorf("read sealed appliance config seed %s: %w", name, err)
		}
		directory := filepath.Join(dataRoot, "config")
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
		destination := filepath.Join(directory, name)
		temporary, err := os.CreateTemp(directory, ".youeye-factory-seed-*")
		if err != nil {
			return err
		}
		temporaryPath := temporary.Name()
		removeTemporary := true
		defer func() {
			if removeTemporary {
				_ = os.Remove(temporaryPath)
			}
		}()
		if err := temporary.Chmod(0o600); err != nil {
			temporary.Close()
			return err
		}
		if _, err := temporary.Write(contents); err != nil {
			temporary.Close()
			return err
		}
		if err := temporary.Sync(); err != nil {
			temporary.Close()
			return err
		}
		if err := temporary.Close(); err != nil {
			return err
		}
		if err := os.Rename(temporaryPath, destination); err != nil {
			return err
		}
		removeTemporary = false
		if directoryHandle, err := os.Open(directory); err != nil {
			return err
		} else if err := directoryHandle.Sync(); err != nil {
			directoryHandle.Close()
			return err
		} else if err := directoryHandle.Close(); err != nil {
			return err
		}
	}
	return nil
}

func (systemApplianceCleanupOps) Containers() []containerInfo { return getContainerList() }
func (systemApplianceCleanupOps) Images() []string {
	out, err := exec.Command("incus", "image", "list", "-c", "F", "--format", "csv").Output()
	if err != nil {
		return nil
	}
	return strings.Fields(string(out))
}
func (systemApplianceCleanupOps) Networks() []string     { return getNetworks() }
func (systemApplianceCleanupOps) StoragePools() []string { return getStoragePools() }
func (systemApplianceCleanupOps) Run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
func (systemApplianceCleanupOps) ResetData(keep bool) error {
	if keep {
		return nil
	}
	if hoststorage.DatasetExists(hoststorage.DataDataset) {
		out, err := exec.Command("zfs", "destroy", "-r", "-f", hoststorage.DataDataset).CombinedOutput()
		if err != nil {
			return fmt.Errorf("reset appliance data dataset: %w: %s", err, strings.TrimSpace(string(out)))
		}
	}
	if err := hoststorage.EnsureAppliancePoolLayout(); err != nil {
		return err
	}
	status, manifest, err := appliance.Detect()
	if err != nil {
		return fmt.Errorf("reload appliance manifest after data reset: %w", err)
	}
	if status.Kind != appliance.RuntimeApplianceImage || manifest == nil {
		return fmt.Errorf("reload appliance manifest after data reset: runtime is %s", status.Kind)
	}
	state, err := appliance.LoadState(appliance.StatePath)
	if err != nil {
		return err
	}
	if _, err = appliance.EnsureDataSchema(state, *manifest); err != nil {
		return err
	}
	return seedFactoryApplianceConfig(applianceConfigSeedRoot, applianceDataRoot)
}
func (systemApplianceCleanupOps) ResetState() error {
	state, err := appliance.LoadState(appliance.StatePath)
	if err != nil {
		return err
	}
	state.Lifecycle = appliance.LifecycleUnconfigured
	state.Transaction = appliance.TransactionState{}
	return appliance.WriteStateAtomic(appliance.StatePath, state)
}

func runApplianceCleanup() error {
	fmt.Println("Sealed appliance mode: baked packages, vendor units, image partitions, GPT, and the parent disk will be preserved.")
	if cleanupKeepData {
		fmt.Println("Application data will be preserved exactly (--keep-data).")
	} else {
		fmt.Println("Application data in the YE-DATA dataset will be reset.")
	}
	if !cleanupYes {
		fmt.Print("Continue with appliance-safe cleanup? [y/N]: ")
		response, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		response = strings.ToLower(strings.TrimSpace(response))
		if response != "y" && response != "yes" {
			fmt.Println("Cleanup cancelled.")
			return nil
		}
	}
	if err := runApplianceCleanupWithOps(systemApplianceCleanupOps{}, cleanupKeepData); err != nil {
		return err
	}
	fmt.Println("✓ Appliance-safe cleanup complete. The sealed image and persistent disk layout were preserved.")
	return nil
}

func runApplianceCleanupWithOps(ops applianceCleanupOps, keepData bool) error {
	for _, container := range ops.Containers() {
		if container.running {
			if err := ops.Run("incus", "stop", container.name, "--force"); err != nil {
				return err
			}
		}
		if err := ops.Run("incus", "delete", container.name, "--force"); err != nil {
			return err
		}
	}
	// Image metadata survives logical pool deletion in Incus. Remove each
	// now-unused record before resetting the backing dataset so first deploy
	// imports the sealed images instead of trusting stale database entries whose
	// files no longer exist.
	for _, image := range ops.Images() {
		if err := ops.Run("incus", "image", "delete", image); err != nil {
			return err
		}
	}
	for _, network := range ops.Networks() {
		if network == "incusbr0" {
			// Incus does not provide --force for managed-network deletion. The
			// default profile is the final reference after all instances are gone,
			// so remove that NIC before deleting the bridge.
			_ = ops.Run("incus", "profile", "device", "remove", "default", "eth0")
			if err := ops.Run("incus", "network", "delete", network); err != nil {
				return err
			}
		}
	}
	// Removing Incus's logical pool record may destroy default/incus, but it
	// cannot destroy the parent zpool. The ownership/topology pool itself,
	// YE-STATE, YE-DATA partition, and GPT are deliberately never targets.
	for _, pool := range ops.StoragePools() {
		if pool != "default" {
			continue
		}
		_ = ops.Run("incus", "profile", "device", "remove", "default", "root")
		if err := ops.Run("incus", "storage", "delete", "default"); err != nil {
			return err
		}
	}
	if err := ops.ResetData(keepData); err != nil {
		return err
	}
	if err := ops.ResetState(); err != nil {
		return err
	}
	return nil
}
