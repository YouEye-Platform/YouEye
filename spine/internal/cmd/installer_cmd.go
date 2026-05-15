package cmd

import (
	"fmt"
	"os"

	"git.byka.wtf/potemsla/YouEye/spine/internal/installer"
	"github.com/spf13/cobra"
)

var installerCmd = &cobra.Command{
	Use:   "installer",
	Short: "Launch the interactive TUI installer",
	Long: `Launches a full-screen interactive installer with environment detection,
guided configuration, and playable games while YouEye deploys.

On bare Linux: detects environment, then starts deployment with games.
On Proxmox: shows a message that the helper script is not yet ready.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		// Bubble Tea handles non-tty stdin gracefully by opening /dev/tty
		// as a fallback, so we only need to check that /dev/tty exists
		// (i.e. we're not in a container or CI without a terminal at all).
		if _, err := os.Open("/dev/tty"); err != nil {
			fmt.Fprintln(os.Stderr, "The installer requires an interactive terminal (/dev/tty not available).")
			fmt.Fprintln(os.Stderr, "Run 'youeye deploy' for non-interactive installation.")
			os.Exit(1)
		}

		return installer.Run()
	},
}

func init() {
	rootCmd.AddCommand(installerCmd)
}
