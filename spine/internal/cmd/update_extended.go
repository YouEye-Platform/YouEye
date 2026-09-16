package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

var updateUICmd = &cobra.Command{
	Use:   "ui",
	Short: "Update YouEye UI to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireRuntimeCapability(appliance.ActionUIUpdate); err != nil {
			return err
		}
		if !requireCP() {
			return nil
		}
		output.Info("Updating UI...")
		// -y forwards confirm_switch so a ui channel switch (not-newer candidate
		// on a different branch) can be confirmed from the CLI; CP returns 409
		// with instructions otherwise.
		var payload interface{}
		if updateAssumeYes {
			payload = map[string]bool{"confirm_switch": true}
		}
		return controlClient.PostSSE("/api/updates/ui", payload, func(event controlapi.SSEEvent) {
			output.SSEProgress(event.Step, event.TotalSteps, event.Status, event.Message)
		})
	},
}

var updateCheckCmd = &cobra.Command{
	Use:   "check",
	Short: "Check all components for available updates",
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Info("Checking for updates...")
		runtimeStatus, _, err := applianceRuntime()
		if err != nil {
			return err
		}

		// Spine/system updates (local check)
		output.Section("Infrastructure")
		if runtimeStatus.Kind == appliance.RuntimeApplianceImage {
			output.StatusLine("System image", runtimeStatus.ImageVersion+" (image-managed)", output.Green)
		} else {
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
		}

		// Control Panel + app updates
		if controlClient != nil && controlClient.Available() {
			output.Section("Apps")
			if data, err := controlClient.Get("/api/updates/status"); err == nil {
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
	updateUICmd.Flags().BoolVarP(&updateAssumeYes, "yes", "y", false, "confirm channel switch / downgrade without prompting")
	updateCmd.AddCommand(updateUICmd)
	updateCmd.AddCommand(updateCheckCmd)
}

func formatInt(n int) string {
	return fmt.Sprintf("%d", n)
}
