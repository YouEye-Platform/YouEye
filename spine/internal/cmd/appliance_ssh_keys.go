package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/remoteaccess"
)

var (
	sshKeyJSON        bool
	sshKeyFile        string
	sshKeyConfirmLast bool
)

var applianceSSHKeyCommand = &cobra.Command{
	Use:   "ssh-key",
	Short: "Manage key-only root SSH access",
}

var applianceSSHKeyListCommand = &cobra.Command{
	Use:   "list",
	Short: "List managed root SSH keys",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireSealedAppliance(); err != nil {
			return err
		}
		keys, err := remoteaccess.NewDefault().List()
		if err != nil {
			return err
		}
		if sshKeyJSON {
			return json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": remoteaccess.Schema, "keys": remoteaccess.Metadata(keys)})
		}
		if len(keys) == 0 {
			fmt.Println("No root SSH keys are configured")
			return nil
		}
		for _, key := range keys {
			fmt.Printf("%s  %s  %s", key.ID, key.Type, key.Fingerprint)
			if key.Comment != "" {
				fmt.Printf("  %s", key.Comment)
			}
			fmt.Println()
		}
		return nil
	},
}

var applianceSSHKeyAddCommand = &cobra.Command{
	Use:   "add",
	Short: "Add one root SSH public key from a file or standard input",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireSealedAppliance(); err != nil {
			return err
		}
		data, err := readSSHKeyInput(sshKeyFile, cmd.InOrStdin())
		if err != nil {
			return err
		}
		key, err := remoteaccess.NewDefault().Add(string(data), "cli")
		if err != nil {
			return err
		}
		if sshKeyJSON {
			return json.NewEncoder(os.Stdout).Encode(key.Metadata())
		}
		fmt.Printf("Added %s (%s)\n", key.Fingerprint, key.ID)
		return nil
	},
}

var applianceSSHKeyDeleteCommand = &cobra.Command{
	Use:   "delete <key-id>",
	Short: "Delete a managed root SSH key",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireSealedAppliance(); err != nil {
			return err
		}
		key, err := remoteaccess.NewDefault().Delete(strings.TrimSpace(args[0]), sshKeyConfirmLast)
		if err != nil {
			return err
		}
		if sshKeyJSON {
			return json.NewEncoder(os.Stdout).Encode(key.Metadata())
		}
		fmt.Printf("Deleted %s (%s)\n", key.Fingerprint, key.ID)
		return nil
	},
}

var applianceSSHKeyReconcileCommand = &cobra.Command{
	Use: "reconcile", Short: "Reconcile managed root SSH keys during boot", Hidden: true,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireSealedAppliance(); err != nil {
			return err
		}
		return remoteaccess.NewDefault().Reconcile()
	},
}

func init() {
	for _, command := range []*cobra.Command{applianceSSHKeyListCommand, applianceSSHKeyAddCommand, applianceSSHKeyDeleteCommand} {
		command.Flags().BoolVar(&sshKeyJSON, "json", false, "emit machine-readable JSON")
		applianceSSHKeyCommand.AddCommand(command)
	}
	applianceSSHKeyAddCommand.Flags().StringVar(&sshKeyFile, "key-file", "-", "public key file, or - for standard input")
	applianceSSHKeyDeleteCommand.Flags().BoolVar(&sshKeyConfirmLast, "confirm-last-key", false, "confirm that deleting the final key disables new SSH access")
	applianceSSHKeyCommand.AddCommand(applianceSSHKeyReconcileCommand)
	applianceCommand.AddCommand(applianceSSHKeyCommand)
}

func readSSHKeyInput(path string, stdin io.Reader) ([]byte, error) {
	if path == "-" {
		data, err := io.ReadAll(io.LimitReader(stdin, 16*1024+1))
		if err != nil {
			return nil, fmt.Errorf("read SSH public key from standard input: %w", err)
		}
		if len(data) > 16*1024 {
			return nil, errors.New("SSH public key is too large")
		}
		return data, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read SSH public key file: %w", err)
	}
	if len(data) > 16*1024 {
		return nil, errors.New("SSH public key is too large")
	}
	return data, nil
}

func requireSealedAppliance() error {
	status, _, err := applianceRuntime()
	if err != nil {
		return err
	}
	if status.Kind != appliance.RuntimeApplianceImage {
		return errors.New("managed root SSH access is available only on a sealed appliance")
	}
	return nil
}
