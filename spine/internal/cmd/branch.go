package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"gopkg.in/yaml.v3"
)

const youeyeConfigPath = "/var/lib/youeye/config/youeye.yaml"

// branchConfig is a minimal youeye.yaml view retained for the cleanup and
// language read paths that only need site metadata + release_branch.
type branchConfig struct {
	SiteName       string            `yaml:"site_name,omitempty"`
	Domain         string            `yaml:"domain,omitempty"`
	Subdomains     map[string]string `yaml:"subdomains,omitempty"`
	SetupCompleted bool              `yaml:"setup_completed,omitempty"`
	ReleaseBranch  string            `yaml:"release_branch,omitempty"`
}

// loadBranchConfig reads the minimal youeye.yaml view. Retained for the cleanup
// and language paths; the branch command itself uses the channels package.
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

var branchCmd = &cobra.Command{
	Use:   "branch",
	Short: "Show or set the default release branch (deprecated — use 'youeye channel')",
	Long: `Manage the default release branch used for fetching updates.

DEPRECATED: 'youeye branch' now maps onto the default release channel. Prefer
'youeye channel set default --branch <branch>' and the per-component channel
commands, which also support per-component sources and configurable fallback
chains.

Examples:
  youeye branch              Show current default branch
  youeye branch set alpha    Set default branch to "alpha"
  youeye branch reset        Reset to main (default) branch`,
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

// deprecationNote nudges callers toward the channel command.
func deprecationNote() {
	fmt.Println("Note: 'youeye branch' is deprecated. Use 'youeye channel set default --branch <branch>'.")
}

func showBranch() error {
	cfgCh, err := channels.Load()
	if err != nil {
		return err
	}

	branch := cfgCh.DefaultBranch()
	fmt.Printf("Default release branch: %s\n", branch)

	if branch != "main" {
		fmt.Println()
		fmt.Println("Release tag convention:")
		fmt.Printf("  Spine:  %s-v<version>  (e.g., %s-v0.1.50)\n", branch, branch)
		fmt.Printf("  CP:     %s-v<version>  (e.g., %s-v0.1.100)\n", branch, branch)
		fmt.Printf("  UI:     %s-v<version>  (e.g., %s-v0.5.0)\n", branch, branch)
		fmt.Println()
		fmt.Println("If a repo has no branch-specific release, the fallback chain is used.")
	}
	fmt.Println()
	deprecationNote()
	return nil
}

// setBranch maps the deprecated branch command onto the default channel branch,
// preserving the default channel's fallback chain.
func setBranch(branch string) error {
	newBranch := "main"
	if branch != "" {
		normalized, err := channels.NormalizeBranch(branch)
		if err != nil {
			return err
		}
		newBranch = normalized
	}

	cfgCh, err := channels.Load()
	if err != nil {
		return err
	}

	oldBranch := cfgCh.DefaultBranch()

	def := cfgCh.Default
	def.Branch = newBranch
	if def.Fallback == nil {
		def.Fallback = []string{"main"}
	}
	if err := cfgCh.SetChannel(channels.ComponentDefault, def); err != nil {
		return err
	}
	if err := cfgCh.Save(); err != nil {
		return err
	}

	if oldBranch == newBranch {
		fmt.Printf("Default release branch is already set to: %s\n", newBranch)
	} else {
		fmt.Printf("Default release branch changed: %s → %s\n", oldBranch, newBranch)
	}
	fmt.Println()
	deprecationNote()
	return nil
}
