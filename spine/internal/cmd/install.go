package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/youeye-platform/YouEye/spine/internal/container"
	"github.com/youeye-platform/YouEye/spine/internal/incus"
	hoststorage "github.com/youeye-platform/YouEye/spine/internal/storage"
)

var installCmd = &cobra.Command{
	Use:   "install",
	Short: "Install components",
	Long:  `Install Incus or Control Panel components.`,
}

var installIncusCmd = &cobra.Command{
	Use:   "incus",
	Short: "Install and initialize Incus",
	RunE: func(cmd *cobra.Command, args []string) error {
		return installIncus()
	},
}

var installControlCmd = &cobra.Command{
	Use:   "control",
	Short: "Deploy Control Panel container",
	RunE: func(cmd *cobra.Command, args []string) error {
		return installControl()
	},
}

func init() {
	installCmd.AddCommand(installIncusCmd)
	installCmd.AddCommand(installControlCmd)
}

func installIncus() error {
	cfg := GetConfig()
	policy := hoststorage.PolicyFromConfig(cfg.Deployment.Storage)
	result, err := hoststorage.EnsureApplianceStorage(policy)
	if err != nil {
		return fmt.Errorf("storage preparation failed: %w", err)
	}
	return incus.InstallWithOptions(incus.InstallOptions{
		DesiredZFSSize: result.FinalPlan.IncusTargetSize(),
		AutoGrowZFS:    policy.AutoGrowIncus,
	})
}

func installControl() error {
	cfg := GetConfig()
	return container.DeployControlPanel(cfg)
}
