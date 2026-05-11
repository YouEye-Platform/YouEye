package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var deployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Full deployment (delegates to spine deploy)",
	Long:  `Runs the full YouEye deployment including Incus, Control Panel, and infrastructure apps.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Info("Starting full deployment via Spine...")
		// Delegate to spine deploy — it handles everything
		spineCmd := exec.Command("spine", "deploy")
		spineCmd.Stdout = os.Stdout
		spineCmd.Stderr = os.Stderr
		spineCmd.Stdin = os.Stdin
		if err := spineCmd.Run(); err != nil {
			return fmt.Errorf("deployment failed: %w", err)
		}
		return nil
	},
}
