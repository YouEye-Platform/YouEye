package cmd

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/output"
	"golang.org/x/term"
)

var (
	backupPassphraseFile  string
	backupMediaID         string
	backupAppIDs          []string
	restorePassphraseFile string
	restoreMediaID        string
	restoreAppIDs         []string
)

func newRestoreOperationID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(value[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexValue[0:8], hexValue[8:12], hexValue[12:16], hexValue[16:20], hexValue[20:32]), nil
}

func waitForRestoreCompletion(operationID string, streamErr error) error {
	started := time.Now()
	deadline := started.Add(5 * time.Minute)
	discoveryDeadline := started.Add(15 * time.Second)
	observed := false
	lastMessage := ""
	for time.Now().Before(deadline) {
		status, err := controlClient.Get("/api/backup/restore?operationId=" + operationID)
		if err == nil {
			observed = true
			message := firstOf(status, "message")
			if message != "" && message != lastMessage {
				output.Info(message)
				lastMessage = message
			}
			switch firstOf(status, "status") {
			case "completed":
				output.Success("Encrypted backup restored and server interface restarted")
				return nil
			case "failed":
				if message == "" {
					message = "restore failed"
				}
				return fmt.Errorf("restore failed: %s", message)
			}
		}
		if !observed && time.Now().After(discoveryDeadline) {
			if streamErr != nil {
				return streamErr
			}
			return fmt.Errorf("server did not record the restore operation")
		}
		time.Sleep(1500 * time.Millisecond)
	}
	return fmt.Errorf("server did not finish restoring within five minutes")
}

func validateBackupPassphrase(passphrase string) error {
	if len(passphrase) < 12 || len(passphrase) > 256 {
		return fmt.Errorf("backup passphrase must contain 12 to 256 characters")
	}
	return nil
}

func readPassphraseFile(filename string) (string, error) {
	var reader io.Reader
	if filename == "-" {
		reader = os.Stdin
	} else {
		info, err := os.Stat(filename)
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return "", fmt.Errorf("passphrase file must be regular and accessible only by its owner")
		}
		file, err := os.Open(filename)
		if err != nil {
			return "", err
		}
		defer file.Close()
		reader = file
	}
	data, err := io.ReadAll(io.LimitReader(reader, 258))
	if err != nil {
		return "", err
	}
	passphrase := strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
	if err := validateBackupPassphrase(passphrase); err != nil {
		return "", err
	}
	return passphrase, nil
}

func readBackupPassphrase(filename string, confirm bool) (string, error) {
	if filename != "" {
		return readPassphraseFile(filename)
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", fmt.Errorf("use --passphrase-file - to read the passphrase from stdin")
	}
	fmt.Fprint(os.Stderr, "Backup passphrase: ")
	first, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	passphrase := string(first)
	if err := validateBackupPassphrase(passphrase); err != nil {
		return "", err
	}
	if confirm {
		fmt.Fprint(os.Stderr, "Confirm passphrase: ")
		second, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		if passphrase != string(second) {
			return "", fmt.Errorf("passphrases do not match")
		}
	}
	return passphrase, nil
}

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
		if backupMediaID == "" {
			return fmt.Errorf("select a detected backup drive with --media")
		}
		passphrase, err := readBackupPassphrase(backupPassphraseFile, true)
		if err != nil {
			return err
		}
		output.Info("Creating encrypted platform backup...")
		return controlClient.PostSSE("/api/backup/core", map[string]interface{}{
			"passphrase": passphrase,
			"mediaId":    backupMediaID,
			"appIds":     backupAppIDs,
		}, sseHandler)
	},
}

var backupStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check backup task status",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Get("/api/backup/status")
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
		data, err := controlClient.Get("/api/backup/core")
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
			name := firstOf(backup, "id")
			size := firstOf(backup, "sizeBytes")
			created := firstOf(backup, "createdAt")
			status := firstOf(backup, "status")
			media := firstOf(backup, "mediaId")
			rows = append(rows, []string{name, media, size, created, status})
		}
		output.Table([]string{"BACKUP", "MEDIA", "BYTES", "CREATED", "STATUS"}, rows)
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
		if restoreMediaID == "" {
			return fmt.Errorf("select the attached backup drive with --media")
		}
		passphrase, err := readBackupPassphrase(restorePassphraseFile, false)
		if err != nil {
			return err
		}
		confirmed, err := cmd.Flags().GetBool("yes")
		if err != nil || !confirmed {
			return fmt.Errorf("restore replaces current accounts, configuration, applications, and backed-up data; rerun with --yes")
		}
		output.Info("Restoring encrypted backup " + args[0] + "...")
		operationID, err := newRestoreOperationID()
		if err != nil {
			return fmt.Errorf("create restore operation identifier: %w", err)
		}
		streamErr := controlClient.PostSSE("/api/backup/restore", map[string]interface{}{
			"backupId":    args[0],
			"mediaId":     restoreMediaID,
			"passphrase":  passphrase,
			"restoreCore": true,
			"appIds":      restoreAppIDs,
			"operationId": operationID,
			"confirm":     true,
		}, sseHandler)
		return waitForRestoreCompletion(operationID, streamErr)
	},
}

func init() {
	backupCreateCmd.Flags().StringVar(&backupPassphraseFile, "passphrase-file", "", "read the passphrase from an owner-only file, or - for stdin")
	backupCreateCmd.Flags().StringVar(&backupMediaID, "media", "", "stable ID of a detected backup drive")
	backupCreateCmd.Flags().StringSliceVar(&backupAppIDs, "app", nil, "installed app to include (repeatable)")
	restoreCmd.Flags().StringVar(&restorePassphraseFile, "passphrase-file", "", "read the passphrase from an owner-only file, or - for stdin")
	restoreCmd.Flags().StringVar(&restoreMediaID, "media", "", "stable ID of the attached backup drive")
	restoreCmd.Flags().StringSliceVar(&restoreAppIDs, "app", nil, "app to restore with mandatory server configuration (repeatable)")
	restoreCmd.Flags().Bool("yes", false, "confirm replacement of current backed-up platform data")
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
		data, err := controlClient.Get("/api/settings")
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
