package cmd

import (
	"fmt"

	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var backupCmd = &cobra.Command{
	Use:   "backup",
	Short: "Manage platform backups",
}

var backupCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a platform backup",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		output.Info("Creating backup...")
		return cp.PostSSE("/api/backup/core", nil, sseHandler)
	},
}

var backupStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check backup task status",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := cp.Get("/api/backup/status")
		if err != nil {
			return err
		}
		status := firstOf(data, "status")
		if status == "" {
			output.Info("No backup in progress")
			return nil
		}
		output.StatusLine("Status", status, statusColor(status))
		if progress := firstOf(data, "progress"); progress != "" {
			output.StatusLine("Progress", progress+"%", "")
		}
		if errMsg := firstOf(data, "error"); errMsg != "" {
			output.Error(errMsg)
		}
		return nil
	},
}

var backupListCmd = &cobra.Command{
	Use:   "list",
	Short: "List available backups",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := cp.Get("/api/backup/list?target_path=/var/lib/youeye/backups")
		if err != nil {
			return err
		}
		backupsRaw, ok := data["backups"].([]interface{})
		if !ok || len(backupsRaw) == 0 {
			output.Info("No backups found")
			return nil
		}

		rows := [][]string{}
		for _, b := range backupsRaw {
			backup, ok := b.(map[string]interface{})
			if !ok {
				continue
			}
			name := firstOf(backup, "name", "filename")
			size := firstOf(backup, "size", "sizeFormatted")
			created := firstOf(backup, "created", "createdAt", "date")
			rows = append(rows, []string{name, size, created})
		}
		output.Table([]string{"NAME", "SIZE", "CREATED"}, rows)
		return nil
	},
}

var restoreCmd = &cobra.Command{
	Use:   "restore <backup-name>",
	Short: "Restore the platform from a backup",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		output.Info("Restoring from " + args[0] + "...")
		return cp.PostSSE("/api/restore/full", map[string]interface{}{
			"backup": args[0],
		}, sseHandler)
	},
}

func init() {
	backupCmd.AddCommand(backupCreateCmd)
	backupCmd.AddCommand(backupStatusCmd)
	backupCmd.AddCommand(backupListCmd)
}

// settingsCmd shows platform settings
var settingsCmd = &cobra.Command{
	Use:   "settings",
	Short: "Show platform settings",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := cp.Get("/api/settings")
		if err != nil {
			return err
		}

		output.Section("Platform Settings")
		output.StatusLine("Site Name", firstOf(data, "siteName"), "")
		output.StatusLine("Domain", firstOf(data, "domain"), "")
		output.StatusLine("Setup Completed", firstOf(data, "setupCompleted"), "")
		output.StatusLine("Release Branch", firstOf(data, "releaseBranch"), "")
		output.StatusLine("Language", firstOf(data, "language"), "")

		if subs, ok := data["subdomains"].(map[string]interface{}); ok {
			fmt.Println()
			output.StatusLine("Subdomains", "", "")
			for k, v := range subs {
				output.StatusLine(fmt.Sprintf("  %s", k), fmt.Sprintf("%v", v), "")
			}
		}
		return nil
	},
}
