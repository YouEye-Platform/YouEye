package cmd

import (
	"fmt"

	"git.byka.wtf/potemsla/YouEye/spine/internal/cpapi"
	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var updateUICmd = &cobra.Command{
	Use:   "ui",
	Short: "Update YouEye UI to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		output.Info("Updating UI...")
		return cp.PostSSE("/api/updates/ui", nil, func(event cpapi.SSEEvent) {
			output.SSEProgress(event.Step, event.TotalSteps, event.Status, event.Message)
		})
	},
}

var updateCheckCmd = &cobra.Command{
	Use:   "check",
	Short: "Check all components for available updates",
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Info("Checking for updates...")

		// Spine/system updates (local check)
		output.Section("Infrastructure")
		if update, newVer := checkSpineUpdate(GetConfig()); update {
			output.StatusLine("Spine", Version+" -> "+newVer+" available", output.Yellow)
		} else {
			output.StatusLine("Spine", "up to date", output.Green)
		}
		upgrades := countUpgradablePackages()
		if upgrades > 0 {
			output.StatusLine("System", formatInt(upgrades)+" packages", output.Yellow)
		} else {
			output.StatusLine("System", "up to date", output.Green)
		}

		// CP + app updates
		if cp != nil && cp.Available() {
			output.Section("Apps")
			if data, err := cp.Get("/api/updates/status"); err == nil {
				if updates, ok := data["updates"].([]interface{}); ok {
					hasUpdates := false
					for _, u := range updates {
						if upd, ok := u.(map[string]interface{}); ok {
							name := firstOf(upd, "name", "component")
							current := firstOf(upd, "currentVersion")
							available := firstOf(upd, "availableVersion", "latestVersion")
							if available != "" && available != current {
								output.StatusLine(name, current+" -> "+available, output.Yellow)
								hasUpdates = true
							}
						}
					}
					if !hasUpdates {
						output.Success("All components up to date")
					}
				}
			}
		} else {
			output.Warn("Control Panel unreachable -- cannot check app updates")
		}

		return nil
	},
}

func init() {
	updateCmd.AddCommand(updateUICmd)
	updateCmd.AddCommand(updateCheckCmd)
}

func formatInt(n int) string {
	return fmt.Sprintf("%d", n)
}
