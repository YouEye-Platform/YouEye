package cmd

import (
	"errors"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/boot"
)

var bootCmd = &cobra.Command{
	Use:                "boot <step> [args…]",
	Short:              "Run an appliance boot step (" + strings.Join(boot.Names(), ", ") + ")",
	Args:               cobra.MinimumNArgs(1),
	DisableFlagParsing: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		run, err := boot.Command(args[0], args[1:])
		if err != nil {
			return err
		}
		if err := run.Run(); err != nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				return &ExitError{Code: exit.ExitCode(), Message: ""}
			}
			return err
		}
		return nil
	},
}
