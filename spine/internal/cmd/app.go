package cmd

import (
	"fmt"
	"net/url"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

var appCmd = &cobra.Command{
	Use:   "app",
	Short: "Manage installed apps",
}

var appListCmd = &cobra.Command{
	Use:   "list",
	Short: "List installed apps with health status",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
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
		if err := requireCP(); err != nil {
			return err
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

var (
	appInstallURL      string
	appInstallTrusted  bool
	appInstallAllowSet bool
	appInstallPublic   bool
)

// installAccessFields adds the public-access choice to an install request only when --public-access was given, so
// the Control Panel applies the manifest's default otherwise (Market apps only; URL apps default to off).
func installAccessFields(cmd *cobra.Command, body map[string]interface{}) map[string]interface{} {
	if cmd.Flags().Changed("public-access") {
		body["publicAccess"] = appInstallPublic
	}
	return body
}

var appInstallCmd = &cobra.Command{
	Use:   "install <name>",
	Short: "Install an app from Market",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := validateAppInstallArgs(args, appInstallURL, appInstallTrusted, appInstallAllowSet); err != nil {
			return err
		}
		if err := requireCP(); err != nil {
			return err
		}

		if appInstallURL != "" {
			// An app from a URL is not reviewed by the YouEye Market: the owner
			// must say they trust its publisher, and separately allow its setup
			// files (steps that run inside the app) when it has any.
			if !appInstallTrusted {
				return fmt.Errorf("an app from a URL is not reviewed by YouEye; add --i-trust-this-publisher to install it")
			}
			output.Info("Installing from URL: " + appInstallURL)
			return controlClient.PostSSE("/api/market/install-url", installAccessFields(cmd, map[string]interface{}{
				"url":                       appInstallURL,
				"acceptUnverifiedPublisher": true,
				"allowSetup":                appInstallAllowSet,
			}), sseHandler)
		}

		output.Info("Installing " + args[0] + "...")
		return controlClient.PostSSE("/api/market/install", installAccessFields(cmd, map[string]interface{}{
			"appId": args[0],
		}), sseHandler)
	},
}

// validateAppInstallArgs refuses combinations that would otherwise be silently ignored: a Market name together
// with --url (the URL wins), and the URL-only flags without --url.
func validateAppInstallArgs(args []string, url string, trusted, allowSetup bool) error {
	if url == "" {
		if allowSetup || trusted {
			return fmt.Errorf("--allow-setup and --i-trust-this-publisher apply only to --url installs")
		}
		if len(args) == 0 {
			return fmt.Errorf("specify an app name or use --url")
		}
		return nil
	}
	if len(args) > 0 {
		return fmt.Errorf("give either an app name or --url, not both")
	}
	return nil
}

var appUpdateAll bool
var appUpdateAssumeYes bool

var appUpdateCmd = &cobra.Command{
	Use:   "update <name>",
	Short: "Update an installed app",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
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
							if err := controlClient.PostSSE("/api/apps/"+name+"/update", nil, sseHandler); err != nil {
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
		// Canonical CP route; /api/market/update remains as a CP-side alias for
		// older CLIs. -y confirms installing a not-newer candidate after a
		// channel change (downgrade/sidegrade).
		var payload interface{}
		if appUpdateAssumeYes {
			payload = map[string]bool{"confirm_switch": true}
		}
		return controlClient.PostSSE("/api/apps/"+args[0]+"/update", payload, sseHandler)
	},
}

var appRemoveKeepData bool

var appRemoveCmd = &cobra.Command{
	Use:   "remove <name>",
	Short: "Uninstall an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		output.Info("Removing " + args[0] + "...")
		result, err := controlClient.Post("/api/market/uninstall", map[string]interface{}{
			"appId":    args[0],
			"keepData": appRemoveKeepData,
		})
		if err != nil {
			return err
		}
		message, err := appRemoveMessage(args[0], result)
		if err != nil {
			return err
		}
		output.Success(message)
		return nil
	},
}

func appRemoveMessage(appName string, result map[string]interface{}) (string, error) {
	success, ok := result["success"].(bool)
	if !ok {
		return "", fmt.Errorf("control panel returned an invalid uninstall result")
	}
	if !success {
		return "", fmt.Errorf("removal of %s did not complete; some cleanup may have succeeded -- check 'youeye logs control' before retrying", appName)
	}
	if msg := str(result, "message"); msg != "" {
		return msg, nil
	}
	return appName + " removed", nil
}

func newAppControlCmd(action string) *cobra.Command {
	short := capitalize(action) + " an app"
	if action == "stop" {
		short = "Turn off an app"
	}
	return &cobra.Command{
		Use:   action + " <name>",
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := requireCP(); err != nil {
				return err
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
		if err := requireCP(); err != nil {
			return err
		}
		data, err := controlClient.Get(appCredentialsPath(args[0]))
		if err != nil {
			return err
		}
		output.Section("Credentials for " + args[0])
		entries := appCredentialEntries(data)
		if len(entries) == 0 {
			output.Info("This app has no default credentials.")
		}
		for _, entry := range entries {
			output.StatusLine(entry.Label, entry.Username+"  "+entry.Password, "")
		}
		return nil
	},
}

// appCredentialsPath is the Control Panel route for an app's default credentials (`?app=<id>`).
func appCredentialsPath(appID string) string {
	return "/api/market/credentials?app=" + url.QueryEscape(appID)
}

type appCredentialEntry struct{ Label, Username, Password string }

// appCredentialEntries reads the route's `{"credentials":[{label,username,password}]}` answer.
func appCredentialEntries(data map[string]interface{}) []appCredentialEntry {
	list, _ := data["credentials"].([]interface{})
	entries := make([]appCredentialEntry, 0, len(list))
	for _, item := range list {
		fields, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		entries = append(entries, appCredentialEntry{
			Label: fmt.Sprint(fields["label"]), Username: fmt.Sprint(fields["username"]), Password: fmt.Sprint(fields["password"]),
		})
	}
	return entries
}

var appCheckUpdatesCmd = &cobra.Command{
	Use:   "check-updates",
	Short: "Check all apps for available updates",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
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
	appInstallCmd.Flags().StringVar(&appInstallURL, "url", "", "Install the youeye-app.yaml at this HTTPS URL")
	appInstallCmd.Flags().BoolVar(&appInstallTrusted, "i-trust-this-publisher", false, "Confirm you trust the publisher of a --url app (required with --url)")
	appInstallCmd.Flags().BoolVar(&appInstallAllowSet, "allow-setup", false, "Allow the --url app's setup files to run (required when it has any)")
	appInstallCmd.Flags().BoolVar(&appInstallPublic, "public-access", false, "Open the app to anyone who can reach its address (--public-access=false keeps it household-only); default: the app's Market listing decides, off for --url apps")
	appUpdateCmd.Flags().BoolVar(&appUpdateAll, "all", false, "Update all apps with available updates")
	appUpdateCmd.Flags().BoolVarP(&appUpdateAssumeYes, "yes", "y", false, "confirm channel switch / downgrade without prompting")
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
