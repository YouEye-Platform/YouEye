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
		data, err := controlClient.Get("/api/apps/unified")
		if err != nil {
			return err
		}
		appsRaw, ok := data["apps"].([]interface{})
		if !ok {
			return fmt.Errorf("unexpected response format from /api/apps/unified")
		}

		rows := [][]string{}
		for _, a := range appsRaw {
			app, ok := a.(map[string]interface{})
			if !ok {
				continue
			}
			id := firstOf(app, "id", "name", "appId")
			displayName := firstOf(app, "displayName", "name")
			ver := firstOf(app, "version", "installedVersion")
			health := firstOf(app, "status", "healthStatus", "health")
			category := firstOf(app, "category")
			rows = append(rows, []string{id, displayName, ver, health, category})
		}
		// Cross-reference with Incus to find untracked containers and group as apps
		tracked := trackedContainerNames(appsRaw)
		untracked := untrackedContainers(tracked)
		untrackedApps := groupUntrackedAsApps(untracked)
		for _, app := range untrackedApps {
			// Aggregate status from containers
			status := "running"
			for _, c := range app.Containers {
				if c.Status != "running" {
					status = c.Status
					break
				}
			}
			rows = append(rows, []string{app.Name, app.Name, "", status, "untracked"})
		}

		output.Table([]string{"ID", "NAME", "VERSION", "STATUS", "CATEGORY"}, rows)

		if len(untrackedApps) > 0 {
			output.Warn(fmt.Sprintf("%d app(s) running but not tracked by Control Panel", len(untrackedApps)))
		}
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
		app := findUnifiedApp(args[0])
		if app == nil {
			return fmt.Errorf("app '%s' not found", args[0])
		}

		displayName := firstOf(app, "displayName", "name", "id")
		output.Section("App: " + displayName)
		output.StatusLine("ID", firstOf(app, "id"), "")
		output.StatusLine("Category", firstOf(app, "category"), "")
		output.StatusLine("Type", firstOf(app, "type"), "")
		output.StatusLine("Version", firstOf(app, "version"), "")
		output.StatusLine("Status", firstOf(app, "status"), statusColor(firstOf(app, "status")))
		output.StatusLine("Updated By", firstOf(app, "updatedBy"), "")

		if updateAvail, ok := app["updateAvailable"].(bool); ok && updateAvail {
			output.StatusLine("Update", "available", output.Yellow)
		}

		if containers, ok := app["containers"].([]interface{}); ok && len(containers) > 0 {
			fmt.Println()
			output.StatusLine("Containers", fmt.Sprintf("%d", len(containers)), "")
			for _, c := range containers {
				if ctr, ok := c.(map[string]interface{}); ok {
					name := firstOf(ctr, "name")
					status := firstOf(ctr, "status")
					ip := firstOf(ctr, "ip")
					fmt.Printf("  %-25s %-10s %s\n", name, status, ip)
				}
			}
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
			return controlClient.PostSSE("/api/market/install-url", map[string]interface{}{
				"url": appInstallURL,
			}, sseHandler)
		}

		if len(args) == 0 {
			return fmt.Errorf("specify an app name or use --url")
		}

		output.Info("Installing " + args[0] + "...")
		return controlClient.PostSSE("/api/market/install", map[string]interface{}{
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
			updates, err := controlClient.Get("/api/market/updates")
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
							if err := controlClient.PostSSE("/api/market/update", map[string]interface{}{
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
		return controlClient.PostSSE("/api/market/update", map[string]interface{}{
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
		result, err := controlClient.Post("/api/market/uninstall", map[string]interface{}{
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
			result, err := controlClient.Post("/api/apps/"+args[0]+"/control", map[string]interface{}{
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
		data, err := controlClient.Get("/api/market/credentials?appId=" + args[0])
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
		data, err := controlClient.Post("/api/apps/check-updates", nil)
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
