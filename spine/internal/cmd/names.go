package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

// Where the Control Panel setup wizard looks for a staged reuse bundle.
const namesImportPath = "/opt/youeye-control-data/youeye-names/import-bundle.json"
const namesImportDir = "/opt/youeye-control-data/youeye-names"

var namesCmd = &cobra.Command{
	Use:   "names",
	Short: "Manage this server's YouEye Names address (export/import its reuse bundle)",
}

var namesExportOutput string

var namesExportCmd = &cobra.Command{
	Use:   "export",
	Short: "Export the YouEye Names reuse bundle (install identity + cert + name)",
	Long: "Writes a reuse bundle — the install identity, TLS key, certificate, and\n" +
		"leased name — that 'youeye names import' can restore on a (re)install so the\n" +
		"server reuses the same address + certificate with no new Let's Encrypt issuance.\n\n" +
		"The bundle contains PRIVATE KEYS — it is a credential. Keep it secret\n" +
		"(written 0600 when --output is used).",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Get("/api/tls/youeye-names/export")
		if err != nil {
			return fmt.Errorf("export failed: %w", err)
		}
		pretty, err := json.MarshalIndent(data, "", "  ")
		if err != nil {
			return err
		}
		if namesExportOutput == "" || namesExportOutput == "-" {
			fmt.Println(string(pretty))
			return nil
		}
		if err := os.WriteFile(namesExportOutput, append(pretty, '\n'), 0o600); err != nil {
			return fmt.Errorf("writing %s: %w", namesExportOutput, err)
		}
		name, _ := data["name"].(string)
		output.Success(fmt.Sprintf("Exported YouEye Names bundle for %q to %s (0600 — keep it secret)", name, namesExportOutput))
		return nil
	},
}

var namesImportCmd = &cobra.Command{
	Use:   "import <bundle.json>",
	Short: "Stage a YouEye Names bundle so the next setup reuses its address + cert",
	Long: "Stages a bundle from 'youeye names export' into the Control Panel so the setup\n" +
		"wizard reuses that address + certificate instead of provisioning a new one\n" +
		"(no Let's Encrypt round-trip). Run after 'youeye deploy', before opening setup.",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		raw, err := os.ReadFile(args[0])
		if err != nil {
			return fmt.Errorf("reading bundle %s: %w", args[0], err)
		}
		var b struct {
			Name     string `json:"name"`
			Identity struct {
				PrivateKeyPem string `json:"privateKeyPem"`
			} `json:"identity"`
			TLS struct {
				CertPem string `json:"certPem"`
			} `json:"tls"`
		}
		if err := json.Unmarshal(raw, &b); err != nil || b.Name == "" || b.Identity.PrivateKeyPem == "" || b.TLS.CertPem == "" {
			return fmt.Errorf("%s is not a valid YouEye Names bundle", args[0])
		}

		// Stage into the Control Panel container at the path setup watches.
		if out, err := exec.Command("incus", "exec", "youeye-control", "--", "mkdir", "-p", namesImportDir).CombinedOutput(); err != nil {
			return fmt.Errorf("preparing container dir: %v (%s)", err, string(out))
		}
		write := exec.Command("incus", "exec", "youeye-control", "--", "tee", namesImportPath)
		write.Stdin = bytes.NewReader(raw)
		if out, err := write.CombinedOutput(); err != nil {
			return fmt.Errorf("staging bundle: %v (%s)", err, string(out))
		}
		_ = exec.Command("incus", "exec", "youeye-control", "--", "chmod", "600", namesImportPath).Run()

		output.Success(fmt.Sprintf("Staged YouEye Names bundle for %q — the next setup will reuse it (no Let's Encrypt)", b.Name))
		return nil
	},
}

func init() {
	namesExportCmd.Flags().StringVarP(&namesExportOutput, "output", "o", "", "write the bundle to a file (default: stdout)")
	namesCmd.AddCommand(namesExportCmd)
	namesCmd.AddCommand(namesImportCmd)
}
