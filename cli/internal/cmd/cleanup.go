package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var cleanupYes bool
var cleanupKeepData bool

var cleanupCmd = &cobra.Command{
	Use:   "cleanup",
	Short: "Remove all containers and infrastructure",
	Long:  `Delegates to 'spine cleanup' which removes Incus and all containers.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if !cleanupYes {
			fmt.Print("This will remove all YouEye containers and infrastructure. Continue? [y/N] ")
			var confirm string
			fmt.Scanln(&confirm)
			if confirm != "y" && confirm != "Y" {
				output.Info("Cancelled")
				return nil
			}
		}

		cmdArgs := []string{"cleanup", "--yes"}
		if cleanupKeepData {
			cmdArgs = append(cmdArgs, "--keep-data")
		}

		c := exec.Command("spine", cmdArgs...)
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		c.Stdin = os.Stdin
		return c.Run()
	},
}

func init() {
	cleanupCmd.Flags().BoolVarP(&cleanupYes, "yes", "y", false, "Skip confirmation")
	cleanupCmd.Flags().BoolVar(&cleanupKeepData, "keep-data", false, "Preserve app data")
}
