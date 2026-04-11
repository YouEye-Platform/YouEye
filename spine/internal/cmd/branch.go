package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

const youeyeConfigPath = "/var/lib/youeye/config/youeye.yaml"

// branchConfig represents the youeye.yaml structure (subset for branch management)
type branchConfig struct {
	SiteName       string            `yaml:"site_name,omitempty"`
	Domain         string            `yaml:"domain,omitempty"`
	Subdomains     map[string]string `yaml:"subdomains,omitempty"`
	SetupCompleted bool              `yaml:"setup_completed,omitempty"`
	ReleaseBranch  string            `yaml:"release_branch,omitempty"`
}

var branchCmd = &cobra.Command{
	Use:   "branch",
	Short: "Show or set the release branch for updates",
	Long: `Manage the release branch used for fetching updates.

When a branch is set, spine update commands will look for releases tagged with
the branch prefix (e.g., "alpha-v0.1.50" for branch "alpha").
If no branch-specific release exists for a repo, it falls back to main releases.

This is used for multi-agent development where each agent works on a separate
branch across YouEye repos and needs isolated update paths.

Examples:
  spine branch              Show current branch
  spine branch set alpha    Set branch to "alpha"
  spine branch reset        Reset to main (default) branch`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return showBranch()
	},
}

var branchSetCmd = &cobra.Command{
	Use:   "set [branch-name]",
	Short: "Set the release branch",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return setBranch(args[0])
	},
}

var branchResetCmd = &cobra.Command{
	Use:   "reset",
	Short: "Reset to main (default) branch",
	RunE: func(cmd *cobra.Command, args []string) error {
		return setBranch("")
	},
}

func init() {
	branchCmd.AddCommand(branchSetCmd)
	branchCmd.AddCommand(branchResetCmd)
}

func loadBranchConfig() (*branchConfig, error) {
	cfg := &branchConfig{
		SiteName: "YouEye",
		Subdomains: map[string]string{
			"control": "control",
			"auth":    "auth",
			"dns":     "dns",
		},
	}

	data, err := os.ReadFile(youeyeConfigPath)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	return cfg, nil
}

func saveBranchConfig(cfg *branchConfig) error {
	if err := os.MkdirAll("/var/lib/youeye/config", 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	header := "# YouEye Configuration\n# Managed by Spine - do not edit manually unless you know what you're doing\n\n"
	if err := os.WriteFile(youeyeConfigPath, []byte(header+string(data)), 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

func showBranch() error {
	cfg, err := loadBranchConfig()
	if err != nil {
		return err
	}

	branch := cfg.ReleaseBranch
	if branch == "" {
		branch = "main"
	}

	fmt.Printf("Release branch: %s\n", branch)

	if branch != "main" {
		fmt.Println()
		fmt.Println("Release tag convention:")
		fmt.Printf("  Spine:    %s-v<version>  (e.g., %s-v0.1.50)\n", branch, branch)
		fmt.Printf("  CP:       %s-v<version>  (e.g., %s-v0.1.100)\n", branch, branch)
		fmt.Printf("  UI:       %s-v<version>  (e.g., %s-v0.5.0)\n", branch, branch)
		fmt.Printf("  AppMarket: git branch '%s'\n", branch)
		fmt.Println()
		fmt.Println("If a repo has no branch-specific release, main releases are used as fallback.")
	}

	return nil
}

func setBranch(branch string) error {
	// Validate branch name: only alphanumeric, hyphens, underscores
	if branch != "" {
		for _, c := range branch {
			if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
				return fmt.Errorf("invalid branch name: only alphanumeric characters, hyphens, and underscores are allowed")
			}
		}
		// Normalize to lowercase
		branch = strings.ToLower(branch)
	}

	cfg, err := loadBranchConfig()
	if err != nil {
		return err
	}

	oldBranch := cfg.ReleaseBranch
	if oldBranch == "" {
		oldBranch = "main"
	}

	cfg.ReleaseBranch = branch

	if err := saveBranchConfig(cfg); err != nil {
		return err
	}

	newBranch := branch
	if newBranch == "" {
		newBranch = "main"
	}

	if oldBranch == newBranch {
		fmt.Printf("Release branch is already set to: %s\n", newBranch)
		return nil
	}

	fmt.Printf("Release branch changed: %s → %s\n", oldBranch, newBranch)

	if newBranch != "main" {
		fmt.Println()
		fmt.Println("Updates will now look for releases tagged with prefix:")
		fmt.Printf("  %s-v<version>\n", newBranch)
		fmt.Println()
		fmt.Println("Run 'spine update self' to update to the latest branch release.")
	} else {
		fmt.Println("Updates will now use main (default) releases.")
	}

	return nil
}
