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
		// The installer needs a terminal
		if fi, _ := os.Stdin.Stat(); fi != nil && (fi.Mode()&os.ModeCharDevice) == 0 {
			fmt.Fprintln(os.Stderr, "The installer requires an interactive terminal.")
			fmt.Fprintln(os.Stderr, "Run 'youeye deploy' for non-interactive installation.")
			os.Exit(1)
		}

		return installer.Run()
	},
}

func init() {
	rootCmd.AddCommand(installerCmd)
}
