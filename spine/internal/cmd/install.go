package cmd

import (
	"github.com/spf13/cobra"

	"git.byka.wtf/potemsla/YouEye/spine/internal/container"
	"git.byka.wtf/potemsla/YouEye/spine/internal/incus"
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
	return incus.Install()
}

func installControl() error {
	cfg := GetConfig()
	return container.DeployControlPanel(cfg)
}
