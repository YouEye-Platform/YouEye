package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"git.potemk.in/potemsla/YouEye/spine/internal/config"
	"git.potemk.in/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

const defaultSpineConfigPath = "/etc/youeye/config.yaml"

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
		if err := writeCoreRepoURL(repo.RepoURL); err != nil {
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

func writeCoreRepoURL(repoURL string) error {
	path := cfgFile
	if path == "" {
		path = config.GetConfigFile()
	}
	if path == "" {
		path = defaultSpineConfigPath
	}

	raw := map[string]interface{}{}
	if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
		if err := yaml.Unmarshal(data, &raw); err != nil {
			return fmt.Errorf("failed to parse %s: %w", path, err)
		}
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read %s: %w", path, err)
	}

	releases, _ := raw["releases"].(map[string]interface{})
	if releases == nil {
		releases = map[string]interface{}{}
	}
	releases["repo_url"] = repoURL
	delete(releases, "provider")
	delete(releases, "base_url")
	delete(releases, "api_path")
	delete(releases, "organization")
	delete(releases, "repositories")
	raw["releases"] = releases

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}
	data, err := yaml.Marshal(raw)
	if err != nil {
		return fmt.Errorf("failed to encode config: %w", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("failed to write %s: %w", path, err)
	}
	return nil
}
