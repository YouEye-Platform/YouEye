package cmd

import (
	"fmt"

	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var appCmd = &cobra.Command{
	Use:   "app",
	Short: "Manage installed apps",
}

var appListCmd = &cobra.Command{
	Use:   "list",
	Short: "List installed apps with health status",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		apps, err := cp.GetArray("/api/apps")
		if err != nil {
			return err
		}

		rows := [][]string{}
		for _, a := range apps {
			app, ok := a.(map[string]interface{})
			if !ok {
				continue
			}
			name := firstOf(app, "name", "appId")
			ver := firstOf(app, "version", "installedVersion")
			health := firstOf(app, "healthStatus", "health", "status")
			subdomain := firstOf(app, "subdomain")
			appType := firstOf(app, "type")
			rows = append(rows, []string{name, ver, health, subdomain, appType})
		}
		output.Table([]string{"NAME", "VERSION", "HEALTH", "SUBDOMAIN", "TYPE"}, rows)
		return nil
	},
}

var appInfoCmd = &cobra.Command{
	Use:   "info <name>",
	Short: "Show detailed app information",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := cp.Get("/api/apps/" + args[0] + "/status")
		if err != nil {
			return err
		}
		output.Section("App: " + args[0])
		for k, v := range data {
			output.StatusLine(k, fmt.Sprintf("%v", v), "")
		}
		return nil
	},
}

var appInstallURL string

var appInstallCmd = &cobra.Command{
	Use:   "install <name>",
	Short: "Install an app from the marketplace",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}

		if appInstallURL != "" {
			output.Info("Installing from URL: " + appInstallURL)
			return cp.PostSSE("/api/market/install-url", map[string]interface{}{
				"url": appInstallURL,
			}, sseHandler)
		}

		if len(args) == 0 {
			return fmt.Errorf("specify an app name or use --url")
		}

		output.Info("Installing " + args[0] + "...")
		return cp.PostSSE("/api/market/install", map[string]interface{}{
			"appId": args[0],
		}, sseHandler)
	},
}

var appUpdateAll bool

var appUpdateCmd = &cobra.Command{
	Use:   "update <name>",
	Short: "Update an installed app",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}

		if appUpdateAll {
			output.Info("Checking for app updates...")
			updates, err := cp.Get("/api/market/updates")
			if err != nil {
				return err
			}
			if apps, ok := updates["apps"].([]interface{}); ok {
				count := 0
				for _, a := range apps {
					if app, ok := a.(map[string]interface{}); ok {
						if updateAvail, _ := app["updateAvailable"].(bool); updateAvail {
							name := firstOf(app, "appId", "name")
							output.Info("Updating " + name + "...")
							if err := cp.PostSSE("/api/market/update", map[string]interface{}{
								"appId": name,
							}, sseHandler); err != nil {
								output.Error("Failed to update " + name + ": " + err.Error())
							}
							count++
						}
					}
				}
				if count == 0 {
					output.Success("All apps are up to date")
				}
			}
			return nil
		}

		if len(args) == 0 {
			return fmt.Errorf("specify an app name or use --all")
		}

		output.Info("Updating " + args[0] + "...")
		return cp.PostSSE("/api/market/update", map[string]interface{}{
			"appId": args[0],
		}, sseHandler)
	},
}

var appRemoveKeepData bool

var appRemoveCmd = &cobra.Command{
	Use:   "remove <name>",
	Short: "Uninstall an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		output.Info("Removing " + args[0] + "...")
		result, err := cp.Post("/api/market/uninstall", map[string]interface{}{
			"appId":    args[0],
			"keepData": appRemoveKeepData,
		})
		if err != nil {
			return err
		}
		if msg := str(result, "message"); msg != "" {
			output.Success(msg)
		} else {
			output.Success(args[0] + " removed")
		}
		return nil
	},
}

func newAppControlCmd(action string) *cobra.Command {
	return &cobra.Command{
		Use:   action + " <name>",
		Short: capitalize(action) + " an app's container",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !requireCP() {
				return nil
			}
			result, err := cp.Post("/api/apps/"+args[0]+"/control", map[string]interface{}{
				"action": action,
			})
			if err != nil {
				return err
			}
			if msg := str(result, "message"); msg != "" {
				output.Success(msg)
			} else {
				output.Success(args[0] + " " + action + "ed")
			}
			return nil
		},
	}
}

var appCredentialsCmd = &cobra.Command{
	Use:   "credentials <name>",
	Short: "Show admin credentials for an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := cp.Get("/api/market/credentials?appId=" + args[0])
		if err != nil {
			return err
		}
		output.Section("Credentials for " + args[0])
		if creds, ok := data["credentials"].(map[string]interface{}); ok {
			for k, v := range creds {
				output.StatusLine(k, fmt.Sprintf("%v", v), "")
			}
		} else {
			for k, v := range data {
				output.StatusLine(k, fmt.Sprintf("%v", v), "")
			}
		}
		return nil
	},
}

var appCheckUpdatesCmd = &cobra.Command{
	Use:   "check-updates",
	Short: "Check all apps for available updates",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		output.Info("Checking for updates...")
		data, err := cp.Post("/api/apps/check-updates", nil)
		if err != nil {
			return err
		}
		if apps, ok := data["apps"].([]interface{}); ok {
			rows := [][]string{}
			for _, a := range apps {
				if app, ok := a.(map[string]interface{}); ok {
					if updateAvail, _ := app["updateAvailable"].(bool); updateAvail {
						name := firstOf(app, "appId", "name")
						current := firstOf(app, "installedVersion")
						available := firstOf(app, "catalogVersion", "latestVersion")
						rows = append(rows, []string{name, current, available})
					}
				}
			}
			if len(rows) > 0 {
				output.Table([]string{"APP", "CURRENT", "AVAILABLE"}, rows)
			} else {
				output.Success("All apps are up to date")
			}
		} else {
			output.Success("Update check complete")
		}
		return nil
	},
}

func init() {
	appInstallCmd.Flags().StringVar(&appInstallURL, "url", "", "Install from a custom repository URL")
	appUpdateCmd.Flags().BoolVar(&appUpdateAll, "all", false, "Update all apps with available updates")
	appRemoveCmd.Flags().BoolVar(&appRemoveKeepData, "keep-data", false, "Preserve app data volumes")

	appCmd.AddCommand(appListCmd)
	appCmd.AddCommand(appInfoCmd)
	appCmd.AddCommand(appInstallCmd)
	appCmd.AddCommand(appUpdateCmd)
	appCmd.AddCommand(appRemoveCmd)
	appCmd.AddCommand(newAppControlCmd("start"))
	appCmd.AddCommand(newAppControlCmd("stop"))
	appCmd.AddCommand(newAppControlCmd("restart"))
	appCmd.AddCommand(appCredentialsCmd)
	appCmd.AddCommand(appCheckUpdatesCmd)
}
