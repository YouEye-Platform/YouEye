package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// Serialize native phases through a separate executor lock. Do not hold an
// exclusive lifecycle lock over a CP call: CP must acquire its own admission
// lease for this exact request. The durable copy hold survives process exit.
func withNativeCopyCommand(run func(*cobra.Command, []string) error) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("native copy requires root")
		}
		path := filepath.Join(systemupdate.CoreStatePath, "copy-executor.lock")
		fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
		if err != nil {
			return fmt.Errorf("native copy executor unavailable")
		}
		defer syscall.Close(fd)
		if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			return fmt.Errorf("another native copy phase is running")
		}
		defer syscall.Flock(fd, syscall.LOCK_UN)
		return run(cmd, args)
	}
}
