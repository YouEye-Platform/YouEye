package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/youeye-platform/YouEye/spine/internal/consoleaccess"
)

// youeye console: admins' host accounts (console access).
var consoleCmd = &cobra.Command{
	Use:   "console",
	Short: "Console access: admins' host accounts, root password and password SSH",
}

func init() {
	consoleCmd.AddCommand(&cobra.Command{
		Use:   "apply",
		Short: "Build the host's account files from the image's and the console access record (boot and after changes)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("console apply requires root")
			}
			return consoleaccess.Default().Apply()
		},
	})
	consoleCmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show admins' console accounts and settings",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			status, err := consoleaccess.Default().Status()
			if err != nil {
				return err
			}
			encoder := json.NewEncoder(cmd.OutOrStdout())
			encoder.SetIndent("", "  ")
			return encoder.Encode(status)
		},
	})
	consoleCmd.AddCommand(&cobra.Command{
		Use:   "owner-reset",
		Short: "Issue a one-time owner password reset code (shown on the console; Recovery queues this)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("owner-reset requires root")
			}
			if _, err := consoleaccess.Default().IssueResetCode(); err != nil {
				return err
			}
			// Never print the code: this runs at boot and stdout is the journal.
			fmt.Fprintln(cmd.OutOrStdout(), "Owner reset code issued; the console screen shows it (valid 24 hours, once).")
			return nil
		},
	})
	rootCmd.AddCommand(consoleCmd)
}
