package cmd

import (
	"fmt"
	"net/url"
	"strconv"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
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
			id := textOf(app, "id", "name", "appId")
			displayName := textOf(app, "displayName", "name")
			ver := textOf(app, "version", "installedVersion")
			health := textOf(app, "status", "healthStatus", "health")
			category := textOf(app, "category")
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

		displayName := textOf(app, "displayName", "name", "id")
		output.Section("App: " + displayName)
		output.StatusLine("ID", textOf(app, "id"), "")
		output.StatusLine("Category", textOf(app, "category"), "")
		output.StatusLine("Type", textOf(app, "type"), "")
		output.StatusLine("Version", textOf(app, "version"), "")
		output.StatusLine("Status", textOf(app, "status"), statusColor(firstOf(app, "status")))
		output.StatusLine("Updated By", textOf(app, "updatedBy"), "")

		if updateAvail, ok := app["updateAvailable"].(bool); ok && updateAvail {
			output.StatusLine("Update", "available", output.Yellow)
		}

		if containers, ok := app["containers"].([]interface{}); ok && len(containers) > 0 {
			fmt.Println()
			output.StatusLine("Containers", fmt.Sprintf("%d", len(containers)), "")
			for _, c := range containers {
				if ctr, ok := c.(map[string]interface{}); ok {
					name := textOf(ctr, "name")
					status := textOf(ctr, "status")
					ip := textOf(ctr, "ip")
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
	appInstallSource   string
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
	Short: "Install an app from a market",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := validateAppInstallArgs(args, appInstallURL, appInstallTrusted, appInstallAllowSet, appInstallSource); err != nil {
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
			// Not followed when the stream drops: the app's id is in the manifest the Control Panel reads, so the
			// CLI can't name the install to poll for.
			return cleanServerError(controlClient.PostSSE("/api/market/install-url", installAccessFields(cmd, map[string]interface{}{
				"url":                       appInstallURL,
				"acceptUnverifiedPublisher": true,
				"allowSetup":                appInstallAllowSet,
			}), terminalSSE))
		}

		output.Info("Installing " + args[0] + "...")
		return runAppInstall(args[0], installRequest(cmd, args[0], appInstallSource))
	},
}

// installRequest is the body of a Market install. Without --source the Control Panel installs from the official
// Market; a market named by --source must have been accepted by the owner (youeye market accept <id>).
func installRequest(cmd *cobra.Command, appID, source string) map[string]interface{} {
	body := map[string]interface{}{"appId": appID}
	if source != "" {
		body["sourceId"] = source
	}
	return installAccessFields(cmd, body)
}

// validateAppInstallArgs refuses combinations that would otherwise be silently ignored: a Market name together
// with --url (the URL wins), the URL-only flags without --url, and --source with --url.
func validateAppInstallArgs(args []string, url string, trusted, allowSetup bool, source string) error {
	if url == "" {
		if allowSetup || trusted {
			return fmt.Errorf("--allow-setup and --i-trust-this-publisher apply only to --url installs")
		}
		if len(args) == 0 {
			return fmt.Errorf("specify an app name or use --url")
		}
		return nil
	}
	if source != "" {
		return fmt.Errorf("--source names a market; a --url app comes from its own address")
	}
	if len(args) > 0 {
		return fmt.Errorf("give either an app name or --url, not both")
	}
	return nil
}

var appUpdateAll bool
var appUpdateAssumeYes bool
var appUpdateAllowSetup bool

// appUpdatePayload is the body of a single app update: -y confirms a channel switch or downgrade, --allow-setup
// allows the changed setup files of an app added by URL (the Control Panel refuses such an update without it).
func appUpdatePayload(assumeYes, allowSetup bool) interface{} {
	if !assumeYes && !allowSetup {
		return nil
	}
	payload := map[string]bool{}
	if assumeYes {
		payload["confirm_switch"] = true
	}
	if allowSetup {
		payload["allowSetup"] = true
	}
	return payload
}

// validateAppUpdateArgs refuses --allow-setup for --all: changed setup steps are allowed per app, after reading them.
func validateAppUpdateArgs(args []string, all, allowSetup bool) error {
	if all && allowSetup {
		return fmt.Errorf("--allow-setup applies to one named app, not --all")
	}
	if !all && len(args) == 0 {
		return fmt.Errorf("specify an app name or use --all")
	}
	return nil
}

var appUpdateCmd = &cobra.Command{
	Use:   "update <name>",
	Short: "Update an installed app",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := validateAppUpdateArgs(args, appUpdateAll, appUpdateAllowSetup); err != nil {
			return err
		}
		if err := requireCP(); err != nil {
			return err
		}

		if appUpdateAll {
			return updateAllApps()
		}

		output.Info("Updating " + args[0] + "...")
		// Canonical CP route; /api/market/update remains as a CP-side alias for
		// older CLIs.
		return runAppUpdate(args[0], appUpdatePayload(appUpdateAssumeYes, appUpdateAllowSetup))
	},
}

// updateAllApps updates every app with an update available, one after the other; exit 1 when any did not succeed.
func updateAllApps() error {
	output.Info("Checking for app updates...")
	updates, err := controlClient.Get("/api/market/updates")
	if err != nil {
		return err
	}
	failed := 0
	if apps, ok := updates["apps"].([]interface{}); ok {
		count := 0
		for _, a := range apps {
			if app, ok := a.(map[string]interface{}); ok {
				if updateAvail, _ := app["updateAvailable"].(bool); updateAvail {
					name := firstOf(app, "appId", "name")
					shown := terminalText(name, false)
					output.Info("Updating " + shown + "...")
					if err := runAppUpdate(name, nil); err != nil {
						failed++
						if message := err.Error(); message != "" {
							output.Error("Failed to update " + shown + ": " + message)
						}
					}
					count++
				}
			}
		}
		if count == 0 {
			output.Success("All apps are up to date")
		}
	}
	if failed > 0 {
		return &ExitError{Code: 1}
	}
	return nil
}

var appRemoveKeepData bool
var appRemoveForce bool

var appRemoveCmd = &cobra.Command{
	Use:   "remove <name>",
	Short: "Uninstall an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		output.Info("Removing " + args[0] + "...")
		payload := map[string]interface{}{"appId": args[0], "keepData": appRemoveKeepData}
		if appRemoveForce {
			payload["force"] = true
		}
		result, err := controlClient.PostLong("/api/market/uninstall", payload)
		if err != nil {
			err = cleanServerError(err)
			if !appRemoveForce {
				return fmt.Errorf("%w\nIf the app's install is broken (a container or record missing), 'youeye app remove %s --force' removes what carries its id", err, args[0])
			}
			return err
		}
		if removed, ok := result["removed"].([]interface{}); ok {
			for _, item := range removed {
				output.Info("removed " + terminalText(fmt.Sprint(item), false))
			}
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
	if msg := terminalText(str(result, "message"), true); msg != "" {
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
			result, err := controlClient.PostLong("/api/apps/"+args[0]+"/control", map[string]interface{}{
				"action": action,
			})
			if err != nil {
				return cleanServerError(err)
			}
			if msg := terminalText(str(result, "message"), true); msg != "" {
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
			output.StatusLine(terminalText(entry.Label, false), printableSecret(entry.Username)+"  "+printableSecret(entry.Password), "")
		}
		return nil
	},
}

var appRecoverCmd = &cobra.Command{
	Use:   "recover <name>",
	Short: "Finish or roll back an app update that did not complete",
	Long: `Retry recovery of the app's latest update: a committed update is reopened and its recovery points
removed; an uncommitted one is rolled back to the previous version. Prints the cause when recovery cannot finish.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		appID := args[0]
		status, err := controlClient.Get("/api/market/update/status?appId=" + url.QueryEscape(appID))
		if err != nil {
			return err
		}
		operation, _ := status["operation"].(map[string]interface{})
		if operation == nil {
			output.Info(appID + " has no app update to recover")
			return nil
		}
		if pending, _ := operation["pending"].(bool); !pending {
			output.Success(appID + "'s latest update is already complete")
			return nil
		}
		if _, err := controlClient.PostLong("/api/market/update/recovery", map[string]interface{}{
			"appId": appID, "id": operation["id"],
		}); err != nil {
			return fmt.Errorf("recovery of %s did not finish: %w", appID, err)
		}
		after, err := controlClient.Get("/api/market/update/status?appId=" + url.QueryEscape(appID))
		if err != nil {
			return err
		}
		final, _ := after["operation"].(map[string]interface{})
		switch {
		case final == nil:
			output.Success(appID + " recovered")
		case final["committed"] == true:
			output.Success(appID + " recovered: the new version is open and its recovery points are removed")
		default:
			output.Success(appID + " recovered: the update was rolled back to the previous version")
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

// printableSecret is a user name or password as it must be typed. It is printed exactly; one that holds control
// characters or escape sequences (the app's manifest names it, so a market does) is printed quoted instead, with
// those characters visible and inert.
func printableSecret(value string) string {
	if terminalText(value, false) == value {
		return value
	}
	return strconv.Quote(value)
}

// blockedUpdateLines is one line per installed app whose update check is blocked (its record's `updateBlocked`:
// the market is gone or not accepted, the app needs a newer YouEye, ...): "<app>: <reason>".
func blockedUpdateLines(apps []interface{}) []string {
	lines := []string{}
	for _, a := range apps {
		app, ok := a.(map[string]interface{})
		if !ok {
			continue
		}
		blocked, ok := app["updateBlocked"].(map[string]interface{})
		if !ok {
			continue
		}
		reason := textOf(blocked, "message", "code")
		if reason == "" {
			reason = "no reason given"
		}
		lines = append(lines, textOf(app, "appId", "name")+": "+reason)
	}
	return lines
}

var appSourceCmd = &cobra.Command{
	Use:   "source <name> <market id>",
	Short: "Choose the market an installed app gets its updates from",
	Long: `Point an installed app at a market that has the same app (see youeye market list). Its next update comes
from there, so the market must be one you have accepted. Nothing is installed or changed until that update.
This is also how an app whose market was removed gets an update source again.`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		answer, err := controlClient.Patch("/api/market/app/"+url.PathEscape(args[0])+"/source",
			map[string]interface{}{"sourceId": args[1]})
		if err != nil {
			return cpPlainError(err)
		}
		output.Success(fmt.Sprintf("%s now gets its updates from %s (%s)", terminalText(args[0], false),
			textOf(answer, "sourceName", "sourceId"), textOf(answer, "sourceId")))
		return nil
	},
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
						name := textOf(app, "appId", "name")
						current := textOf(app, "installedVersion")
						available := textOf(app, "catalogVersion", "latestVersion")
						rows = append(rows, []string{name, current, available})
					}
				}
			}
			blocked := blockedUpdateLines(apps)
			switch {
			case len(rows) > 0:
				output.Table([]string{"APP", "CURRENT", "AVAILABLE"}, rows)
			case len(blocked) == 0:
				output.Success("All apps are up to date")
			default:
				output.Success("No updates for the apps that could be checked")
			}
			if len(blocked) > 0 {
				fmt.Println()
				output.Warn(fmt.Sprintf("%d of the installed apps could not be checked for updates:", len(blocked)))
				for _, line := range blocked {
					fmt.Println("  " + line)
				}
				fmt.Println("  An app whose market is gone gets a source again with: youeye app source <app> <market id>")
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
	appInstallCmd.Flags().StringVar(&appInstallSource, "source", "", "Install from this market (an id from 'youeye market list'); default: the official Market")
	appInstallCmd.Flags().BoolVar(&appInstallPublic, "public-access", false, "Open the app to anyone who can reach its address (--public-access=false keeps it household-only); default: the app's Market listing decides, off for --url apps")
	appUpdateCmd.Flags().BoolVar(&appUpdateAll, "all", false, "Update all apps with available updates")
	appUpdateCmd.Flags().BoolVarP(&appUpdateAssumeYes, "yes", "y", false, "confirm channel switch / downgrade without prompting")
	appUpdateCmd.Flags().BoolVar(&appUpdateAllowSetup, "allow-setup", false, "Allow the changed setup files of an app added by URL (the update is refused without it when they changed)")
	appRemoveCmd.Flags().BoolVar(&appRemoveKeepData, "keep-data", false, "Preserve app data volumes")
	appRemoveCmd.Flags().BoolVar(&appRemoveForce, "force", false, "remove what the normal removal refuses (a broken install record): everything that carries this app's id and installation id")

	appCmd.AddCommand(appListCmd)
	appCmd.AddCommand(appInfoCmd)
	appCmd.AddCommand(appInstallCmd)
	appCmd.AddCommand(appUpdateCmd)
	appCmd.AddCommand(appRemoveCmd)
	appCmd.AddCommand(newAppControlCmd("start"))
	appCmd.AddCommand(newAppControlCmd("stop"))
	appCmd.AddCommand(newAppControlCmd("restart"))
	appCmd.AddCommand(appCredentialsCmd)
	appCmd.AddCommand(appRecoverCmd)
	appCmd.AddCommand(appCheckUpdatesCmd)
	appCmd.AddCommand(appSourceCmd)
}

// terminalSSE prints a Control Panel progress event (sseHandler) with its text cleaned for the terminal.
func terminalSSE(event controlapi.SSEEvent) {
	event.Status = terminalText(event.Status, false)
	event.Stage = terminalText(event.Stage, false)
	event.Message = terminalText(event.Message, false)
	event.Detail = terminalText(event.Detail, true)
	sseHandler(event)
}
