package cmd

import (
	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var branchCmd = &cobra.Command{
	Use:   "branch",
	Short: "Show or set the release branch",
	RunE: func(cmd *cobra.Command, args []string) error {
		// Show current branch
		data, err := spine.Get("/api/config")
		if err != nil {
			return err
		}
		branch := str(data, "release_branch")
		if branch == "" {
			branch = "main"
		}
		output.StatusLine("Release branch", branch, "")
		if branch != "main" {
			output.Info("Tags use prefix: " + branch + "-v*")
		}
		return nil
	},
}

var branchSetCmd = &cobra.Command{
	Use:   "set <name>",
	Short: "Set the release branch for updates",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		_, err := spine.Post("/api/config", map[string]interface{}{
			"release_branch": args[0],
		})
		if err != nil {
			return err
		}
		output.Success("Release branch set to " + args[0])
		return nil
	},
}

var branchResetCmd = &cobra.Command{
	Use:   "reset",
	Short: "Reset to the main (default) branch",
	RunE: func(cmd *cobra.Command, args []string) error {
		_, err := spine.Post("/api/config", map[string]interface{}{
			"release_branch": "main",
		})
		if err != nil {
			return err
		}
		output.Success("Release branch reset to main")
		return nil
	},
}

func init() {
	branchCmd.AddCommand(branchSetCmd)
	branchCmd.AddCommand(branchResetCmd)
}
