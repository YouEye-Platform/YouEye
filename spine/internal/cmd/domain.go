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

const domainImportPath = "/opt/youeye-control-data/byo-domain/import-bundle.json"
const domainImportDir = "/opt/youeye-control-data/byo-domain"

var domainCmd = &cobra.Command{
	Use:   "domain",
	Short: "Manage platform domain",
}

var domainExportOutput string
var domainExportIncludeToken bool

var domainShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show the current base domain",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Get("/api/domain")
		if err != nil {
			return err
		}
		domain := firstOf(data, "domain", "baseDomain")
		output.StatusLine("Domain", domain, "")
		return nil
	},
}

var domainSetCmd = &cobra.Command{
	Use:   "set <domain>",
	Short: "Set the platform base domain",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		_, err := controlClient.Post("/api/domain", map[string]interface{}{
			"domain": args[0],
		})
		if err != nil {
			return err
		}
		output.Success("Domain set to " + args[0])
		return nil
	},
}

var domainExportCmd = &cobra.Command{
	Use:   "export",
	Short: "Export the BYO domain reuse bundle (provider config + TLS certificate)",
	Long: "Writes a BYO domain reuse bundle that 'youeye domain import' can restore on a\n" +
		"(re)install so the server reuses the same domain certificate and DNS provider\n" +
		"automation. By default the DNS provider token is NOT included.\n\n" +
		"The bundle contains the TLS private key. If --include-token is used, it also\n" +
		"contains a DNS token that can edit records for the domain zone. Keep it secret\n" +
		"(written 0600 when --output is used).",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		path := "/api/tls/domain/export"
		if domainExportIncludeToken {
			path += "?includeToken=true"
		}
		data, err := controlClient.Get(path)
		if err != nil {
			return fmt.Errorf("export failed: %w", err)
		}
		pretty, err := json.MarshalIndent(data, "", "  ")
		if err != nil {
			return err
		}
		if domainExportOutput == "" || domainExportOutput == "-" {
			fmt.Println(string(pretty))
			return nil
		}
		if err := os.WriteFile(domainExportOutput, append(pretty, '\n'), 0o600); err != nil {
			return fmt.Errorf("writing %s: %w", domainExportOutput, err)
		}
		domain, _ := data["domain"].(string)
		output.Success(fmt.Sprintf("Exported BYO domain bundle for %q to %s (0600 — keep it secret)", domain, domainExportOutput))
		return nil
	},
}

var domainImportCmd = &cobra.Command{
	Use:   "import <bundle.json>",
	Short: "Stage a BYO domain bundle so the next setup reuses its domain + cert",
	Long: "Stages a bundle from 'youeye domain export' into the Control Panel so the setup\n" +
		"wizard restores the domain certificate and DNS provider automation. Run after\n" +
		"'youeye deploy', before opening setup.",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		raw, err := os.ReadFile(args[0])
		if err != nil {
			return fmt.Errorf("reading bundle %s: %w", args[0], err)
		}
		var b struct {
			Type     string `json:"type"`
			Version  int    `json:"version"`
			Domain   string `json:"domain"`
			Provider struct {
				ID     string `json:"id"`
				ZoneID string `json:"zoneId"`
			} `json:"provider"`
			TLS struct {
				CertPem string `json:"certPem"`
				KeyPem  string `json:"keyPem"`
			} `json:"tls"`
		}
		if err := json.Unmarshal(raw, &b); err != nil ||
			b.Type != "youeye-byo-domain" ||
			b.Version != 1 ||
			b.Domain == "" ||
			b.Provider.ID == "" ||
			b.Provider.ZoneID == "" ||
			b.TLS.CertPem == "" ||
			b.TLS.KeyPem == "" {
			return fmt.Errorf("%s is not a valid YouEye BYO domain bundle", args[0])
		}

		if out, err := exec.Command("incus", "exec", "youeye-control", "--", "mkdir", "-p", domainImportDir).CombinedOutput(); err != nil {
			return fmt.Errorf("preparing container dir: %v (%s)", err, string(out))
		}
		write := exec.Command("incus", "exec", "youeye-control", "--", "tee", domainImportPath)
		write.Stdin = bytes.NewReader(raw)
		if out, err := write.CombinedOutput(); err != nil {
			return fmt.Errorf("staging bundle: %v (%s)", err, string(out))
		}
		_ = exec.Command("incus", "exec", "youeye-control", "--", "chmod", "600", domainImportPath).Run()

		output.Success(fmt.Sprintf("Staged BYO domain bundle for %q — the next setup will reuse it", b.Domain))
		return nil
	},
}

func init() {
	domainExportCmd.Flags().StringVarP(&domainExportOutput, "output", "o", "", "write the bundle to a file (default: stdout)")
	domainExportCmd.Flags().BoolVar(&domainExportIncludeToken, "include-token", false, "include the DNS provider token in the bundle")
	domainCmd.AddCommand(domainShowCmd)
	domainCmd.AddCommand(domainSetCmd)
	domainCmd.AddCommand(domainExportCmd)
	domainCmd.AddCommand(domainImportCmd)
}
