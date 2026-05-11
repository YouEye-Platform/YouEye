package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var uninstallYes bool

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Completely remove YouEye from this server",
	Long:  `Delegates to 'spine uninstall self' which removes everything.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if !uninstallYes {
			fmt.Print("This will COMPLETELY remove YouEye and all data. Type UNINSTALL to confirm: ")
			var confirm string
			fmt.Scanln(&confirm)
			if confirm != "UNINSTALL" {
				output.Info("Cancelled")
				return nil
			}
		}

		c := exec.Command("spine", "uninstall", "self", "--yes")
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		c.Stdin = os.Stdin
		return c.Run()
	},
}

func init() {
	uninstallCmd.Flags().BoolVarP(&uninstallYes, "yes", "y", false, "Skip confirmation")
}
