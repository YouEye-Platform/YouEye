package cmd

import (
	"github.com/spf13/cobra"
)

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update components",
}

// The host system is the appliance image: it changes only through a System release (`youeye update core`), and
// this command group reports and drives that slot transaction. There is no package-manager path.
var updateSystemCmd = &cobra.Command{
	Use:   "system",
	Short: "Show the appliance system update state",
	RunE: func(cmd *cobra.Command, args []string) error {
		return runSystemUpdateStatus(false)
	},
}

func init() {
	updateCmd.AddCommand(updateSystemCmd)
}
