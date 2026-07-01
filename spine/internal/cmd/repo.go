package cmd

import (
	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

var repoCmd = &cobra.Command{
	Use:   "repo",
	Short: "Manage the core platform release repository",
}

var repoGetCmd = &cobra.Command{
	Use:   "get",
	Short: "Show the core platform release repository",
	RunE: func(cmd *cobra.Command, args []string) error {
		repo := GetConfig().CoreReleaseRepo()
		output.StatusLine("Core repository", repo.RepoURL, "")
		output.StatusLine("Provider", repo.Provider, "")
		return nil
	},
}

var repoSetCmd = &cobra.Command{
	Use:   "set <url>",
	Short: "Set the core platform release repository",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		repo, err := config.ParseReleaseRepoURL(args[0])
		if err != nil {
			return err
		}
		if err := config.WriteCoreRepoURL(cfgFile, repo.RepoURL); err != nil {
			return err
		}
		output.Success("Core repository set to " + repo.RepoURL)
		return nil
	},
}

func init() {
	repoCmd.AddCommand(repoGetCmd)
	repoCmd.AddCommand(repoSetCmd)
}
