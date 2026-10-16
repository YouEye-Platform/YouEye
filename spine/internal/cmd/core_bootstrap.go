package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

const coreBootstrapDropIn = "/run/systemd/system/youeye-core-update.service.d/90-signed-bootstrap.conf"

func coreBootstrapOverride(executable string) []byte {
	return []byte("[Service]\nExecStart=\nExecStart=" + executable + " update core resume --boot\n")
}

// Only this owned file is changed; the ordinary unit retains its storage,
// first-deployment, service, timeout and boot-blessing dependencies.
func writeCoreBootstrapOverride(executable string) error {
	if err := writeCoreBootstrapOverrideFile(coreBootstrapDropIn, executable); err != nil {
		return err
	}
	if err := exec.Command("systemctl", "daemon-reload").Run(); err != nil {
		return fmt.Errorf("bootstrap boot continuation was not loaded")
	}
	return nil
}

func writeCoreBootstrapOverrideFile(path, executable string) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	s, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	st, ok := s.Sys().(*syscall.Stat_t)
	if !ok || !s.IsDir() || int(st.Uid) != os.Geteuid() || s.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("unsafe bootstrap unit directory")
	}
	want := coreBootstrapOverride(executable)
	old, err := systemupdate.ReadCoreState(path, 4096)
	if err == nil {
		if !bytes.Equal(old, want) {
			return fmt.Errorf("bootstrap boot override differs")
		}
	} else {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		f, err := os.CreateTemp(directory, ".signed-bootstrap-")
		if err != nil {
			return err
		}
		defer os.Remove(f.Name())
		if err := f.Chmod(0644); err != nil {
			f.Close()
			return err
		}
		_, writeErr := f.Write(want)
		if writeErr == nil {
			writeErr = f.Sync()
		}
		closeErr := f.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
		if err := os.Link(f.Name(), path); err != nil {
			return err
		}
		dir, err := os.Open(directory)
		if err != nil {
			return err
		}
		syncErr := dir.Sync()
		dir.Close()
		if syncErr != nil {
			return syncErr
		}
	}
	return nil
}

func finishCoreBootstrap(ctx context.Context, request string) error {
	m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	executable, err := m.BootstrapExecutable(systemupdate.CoreDevelopmentTrustPath)
	if err != nil || executable == "" {
		return err
	}
	j, err := m.Read()
	if err != nil || j.RequestID != request || !m.TransactionComplete(j) {
		return fmt.Errorf("bootstrap completion remains unverified")
	}
	if err := removeCoreBootstrapOverrideFile(coreBootstrapDropIn, executable); err != nil {
		return err
	}
	if err := exec.CommandContext(ctx, "systemctl", "daemon-reload").Run(); err != nil {
		return err
	}
	return m.ForgetBootstrap(request)
}

// /run is cleared at reboot. A compatible new host can finish the retained
// request without an override; an old host needs explicit signed re-entry.
func removeCoreBootstrapOverrideFile(path, executable string) error {
	raw, err := systemupdate.ReadCoreState(path, 4096)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(raw, coreBootstrapOverride(executable)) {
		return fmt.Errorf("bootstrap boot override changed")
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func init() {
	var request, digest string
	var activate bool
	command := &cobra.Command{Use: "bootstrap", Args: cobra.NoArgs, Short: "Use the signed target coordinator for an older installed System reader", RunE: func(cmd *cobra.Command, _ []string) error {
		if request == "" || digest == "" {
			return fmt.Errorf("exact --request and --manifest-sha256 required")
		}
		runtime, err := installedCoreRuntime()
		if err != nil {
			return err
		}
		m := systemupdate.CoreManager{Root: runtime.Root, Executor: runtime.Executor()}
		prepared, err := prepareCoreRequest(cmd.Context(), m, request, digest)
		if err != nil {
			return err
		}
		if m.TransactionComplete(prepared) {
			if err := finishCoreBootstrap(cmd.Context(), request); err != nil {
				return err
			}
			return json.NewEncoder(cmd.OutOrStdout()).Encode(prepared)
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		executable, err = m.RegisterBootstrap(request, digest, executable, systemupdate.CoreDevelopmentTrustPath)
		if err != nil {
			return err
		}
		if err := writeCoreBootstrapOverride(executable); err != nil {
			return err
		}
		runtime, err = installedCoreRuntime()
		if err != nil {
			return err
		}
		journal, err := continueCoreRequest(cmd.Context(), runtime, request, activate, false, false)
		if journal.RequestID != "" {
			if outErr := json.NewEncoder(cmd.OutOrStdout()).Encode(journal); outErr != nil {
				return outErr
			}
		}
		return err
	}}
	command.Flags().StringVar(&request, "request", "", "stable idempotency identity")
	command.Flags().StringVar(&digest, "manifest-sha256", "", "reviewed complete release digest")
	command.Flags().BoolVar(&activate, "activate", false, "activate the verified staged host transition")
	coreUpdateCmd.AddCommand(command)
}

// The temporary reader is not the installed service. During a retained
// bootstrap, observe the canonical baked executable against the running image.
func coreInstalledExecutable() (string, bool, error) {
	p, err := (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).BootstrapExecutable(systemupdate.CoreDevelopmentTrustPath)
	if err != nil {
		return "", false, err
	}
	if p != "" {
		return "/usr/local/bin/youeye", true, nil
	}
	p, err = os.Executable()
	return p, false, err
}
