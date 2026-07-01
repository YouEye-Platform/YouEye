package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

var networkCmd = &cobra.Command{
	Use:   "network",
	Short: "Manage host-network dependent platform configuration",
}

var networkRefreshCmd = &cobra.Command{
	Use:   "refresh",
	Short: "Refresh host-IP dependent DNS, Caddy, and Pi-Hole configuration",
	Long: `Refresh YouEye's host-IP dependent network configuration without rebooting.

Use this after the machine's LAN IP changes while it is still running. The
command updates Pi-Hole's port-53 host binding, restarts Pi-Hole if needed,
updates the Control Panel HOST_IP environment, refreshes local DNS rewrites,
syncs required external DNS providers or YouEye Names leases, and only records
the new host IP after all required steps succeed.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Header("YouEye Network Refresh")
		result, err := runHostIPMigration(hostIPMigrationOptions{Force: true, Reason: "manual refresh"})
		if err != nil {
			output.Error(err.Error())
			return err
		}

		switch {
		case result.Migrated:
			output.Success(fmt.Sprintf("Host IP migration complete: %s -> %s", result.Stored, result.Current))
		case result.Seeded:
			output.Success(fmt.Sprintf("Recorded current host IP %s", result.Current))
		case result.Refreshed:
			output.Success(fmt.Sprintf("Host-IP network state refreshed for %s", result.Current))
		default:
			output.Success(fmt.Sprintf("Host IP unchanged (%s)", result.Current))
		}
		return nil
	},
}

func init() {
	networkCmd.AddCommand(networkRefreshCmd)
}
