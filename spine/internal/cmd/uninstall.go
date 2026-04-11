package cmd

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
)

var uninstallYes bool

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Completely remove YouEye from this server (including Spine itself)",
	Long: `Completely remove YouEye including Spine itself.

This runs 'spine cleanup' first (with --yes), then removes:
  - Spine binary and backup
  - Spine systemd service
  - Spine runtime files

After this command completes, no YouEye components remain.
The hostname is NOT changed — update it manually with hostnamectl if desired.

This action CANNOT be undone!

Use 'spine uninstall self' to invoke. Pass -y or --yes to skip confirmation.`,
}

var uninstallSelfCmd = &cobra.Command{
	Use:   "self",
	Short: "Completely remove YouEye and Spine from this server",
	RunE: func(cmd *cobra.Command, args []string) error {
		return runUninstallSelf()
	},
}

func init() {
	uninstallSelfCmd.Flags().BoolVarP(&uninstallYes, "yes", "y", false, "Skip the typed confirmation")
	uninstallCmd.AddCommand(uninstallSelfCmd)
}

func runUninstallSelf() error {
	fmt.Println("=== YouEye Complete Uninstall ===")
	fmt.Println()
	fmt.Println("This will remove ALL YouEye components including Spine itself.")
	fmt.Println("After completion, no YouEye components will remain on this server.")
	fmt.Println()

	if !uninstallYes {
		fmt.Print("Type UNINSTALL to confirm: ")
		reader := bufio.NewReader(os.Stdin)
		response, _ := reader.ReadString('\n')
		if strings.TrimSpace(response) != "UNINSTALL" {
			fmt.Println("Uninstall cancelled.")
			return nil
		}
		fmt.Println()
	}

	// Step 1: Run cleanup with yes-flag to wipe the platform.
	// We reuse runCleanup() rather than duplicating its logic.
	fmt.Println("[1/6] Running platform cleanup...")
	cleanupYes = true
	cleanupKeepData = false
	if err := runCleanup(); err != nil {
		fmt.Printf("Warning: cleanup had errors: %v\n", err)
		// Continue anyway — best effort.
	}
	fmt.Println()

	// Step 2: Stop the Spine service.
	fmt.Println("[2/6] Stopping Spine service...")
	exec.Command("systemctl", "stop", "spine").Run()

	// Step 3: Disable + remove the Spine systemd unit.
	fmt.Println("[3/6] Removing Spine systemd service...")
	exec.Command("systemctl", "disable", "spine").Run()
	os.Remove("/etc/systemd/system/spine.service")
	exec.Command("systemctl", "daemon-reload").Run()

	// Step 4: Remove runtime files.
	fmt.Println("[4/6] Removing Spine runtime files...")
	os.RemoveAll("/var/run/spine")
	os.RemoveAll("/run/spine")

	// Step 5: Remove the Spine backup binary.
	fmt.Println("[5/6] Removing Spine backup binary...")
	os.Remove("/usr/local/bin/spine.backup")

	// Step 6: Remove the Spine binary itself.
	// The running Go process keeps its file descriptor open, so it can
	// finish printing after the file is unlinked.
	fmt.Println("[6/6] Removing Spine binary...")
	if currentBinary, err := os.Executable(); err == nil {
		os.Remove(currentBinary)
	} else {
		os.Remove("/usr/local/bin/spine")
	}

	fmt.Println()
	fmt.Println("✓ YouEye has been completely removed.")
	fmt.Println()
	fmt.Println("Note: the hostname is unchanged. Change it with:")
	fmt.Println("  hostnamectl set-hostname <new-name>")
	fmt.Println()

	return nil
}
