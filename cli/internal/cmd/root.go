package cmd

import (
	"git.byka.wtf/potemsla/YouEye/cli/internal/client"
	"github.com/spf13/cobra"
)

var (
	Version   = "dev"
	BuildDate = "unknown"
)

var (
	spine *client.SpineClient
	cp    *client.CPClient
)

var rootCmd = &cobra.Command{
	Use:   "youeye",
	Short: "YouEye — unified platform management CLI",
	Long: `YouEye CLI provides a single command to manage the entire YouEye platform.
It controls both Spine (infrastructure) and Control Panel (apps, users, services).`,
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		spine = client.NewSpineClient()
		cp = client.NewCPClient()
	},
	SilenceUsage: true,
}

func Execute() error {
	return rootCmd.Execute()
}

func init() {
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(deployCmd)
	rootCmd.AddCommand(logsCmd)
	rootCmd.AddCommand(appCmd)
	rootCmd.AddCommand(marketCmd)
	rootCmd.AddCommand(updateCmd)
	rootCmd.AddCommand(userCmd)
	rootCmd.AddCommand(proxyCmd)
	rootCmd.AddCommand(domainCmd)
	rootCmd.AddCommand(configCmd)
	rootCmd.AddCommand(languageCmd)
	rootCmd.AddCommand(branchCmd)
	rootCmd.AddCommand(servicesCmd)
	rootCmd.AddCommand(containerCmd)
	rootCmd.AddCommand(setupCmd)
	rootCmd.AddCommand(cleanupCmd)
	rootCmd.AddCommand(uninstallCmd)
}

// requireCP prints an error and returns false if CP is unreachable.
func requireCP() bool {
	if !cp.Available() {
		println("\033[31m✗\033[0m Control Panel is unreachable.")
		println("  Check that YouEye is deployed and running: youeye status")
		return false
	}
	if !cp.HasToken() {
		println("\033[33m!\033[0m CLI token not found at " + client.CLITokenPath)
		println("  Run: sudo youeye setup or provision the CLI token via Spine deploy.")
		return false
	}
	return true
}
