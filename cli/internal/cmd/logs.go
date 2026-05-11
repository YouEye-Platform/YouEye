package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

var logsCmd = &cobra.Command{
	Use:   "logs [component]",
	Short: "View logs (spine, control, ui, or app name)",
	Long: `View logs for a component. Without arguments, shows Spine logs.
  youeye logs           — Spine service logs
  youeye logs control   — Control Panel logs
  youeye logs ui        — UI logs
  youeye logs <app>     — App container logs`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		component := "spine"
		if len(args) > 0 {
			component = args[0]
		}

		switch component {
		case "spine":
			// Spine logs via journalctl [S]
			c := exec.Command("journalctl", "-u", "spine", "-n", "100", "--no-pager")
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			return c.Run()

		case "control", "control-panel", "cp":
			// CP logs via incus exec [S]
			c := exec.Command("incus", "exec", "youeye-control", "--", "journalctl", "-u", "youeye-control", "-n", "100", "--no-pager")
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			return c.Run()

		case "ui":
			c := exec.Command("incus", "exec", "youeye-ui", "--", "journalctl", "-u", "youeye-ui", "-n", "100", "--no-pager")
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			return c.Run()

		default:
			// Try as container name
			containerName := component
			// If it doesn't start with "app-" or "youeye-", try prefixes
			c := exec.Command("incus", "exec", containerName, "--", "journalctl", "-n", "100", "--no-pager")
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			if err := c.Run(); err != nil {
				// Try with app- prefix
				c2 := exec.Command("incus", "exec", "app-"+containerName, "--", "journalctl", "-n", "100", "--no-pager")
				c2.Stdout = os.Stdout
				c2.Stderr = os.Stderr
				if err2 := c2.Run(); err2 != nil {
					return fmt.Errorf("could not find container '%s' or 'app-%s'", containerName, containerName)
				}
			}
			return nil
		}
	},
}
