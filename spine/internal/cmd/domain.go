package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

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

var domainSetTLS string
var domainSetYes bool

var domainSetCmd = &cobra.Command{
	Use:   "set <domain>",
	Short: "Change the server URL (full platform reconfigure)",
	Long: "Changes the server URL on a running platform. This is a FULL reconfigure:\n" +
		"YouEye ID, the dashboard, the Control Panel, the reverse proxy, local DNS,\n" +
		"the TLS certificate, and every installed app (native and market) move to\n" +
		"the new name. Progress is streamed step by step.\n\n" +
		"Certificate handling (--tls):\n" +
		"  auto        provider re-issue when a DNS provider manages the platform\n" +
		"              domain, otherwise a fresh self-signed certificate (default)\n" +
		"  selfsigned  fresh self-signed certificate for the new name (any name)\n" +
		"  provider    re-issue via the connected DNS provider (Let's Encrypt)\n\n" +
		"To move to a saved YouEye Name or exported domain instead, use\n" +
		"'youeye names import <bundle>' or 'youeye domain import <bundle>'.",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		newDomain := strings.ToLower(strings.TrimSpace(args[0]))
		if newDomain == "" {
			return fmt.Errorf("domain is required")
		}
		switch domainSetTLS {
		case "", "auto", "selfsigned", "provider":
		default:
			return fmt.Errorf("--tls must be auto, selfsigned or provider (got %q)", domainSetTLS)
		}

		state := readPlatformYaml()
		if !state.SetupCompleted {
			// Pre-setup there is nothing to migrate — keep the lightweight path.
			_, err := controlClient.Post("/api/domain", map[string]interface{}{"domain": newDomain})
			if err != nil {
				return err
			}
			output.Success("Domain set to " + newDomain)
			return nil
		}
		if state.Domain == newDomain {
			output.Info("The server URL is already " + newDomain)
			return nil
		}

		selfsigned := domainSetTLS == "selfsigned" || domainSetTLS == "" || domainSetTLS == "auto"
		if !confirmURLChange(newDomain, state.Domain, selfsigned, domainSetYes) {
			return nil
		}

		payload := map[string]interface{}{"domain": newDomain}
		if domainSetTLS != "" {
			payload["tls"] = domainSetTLS
		}
		return streamURLChange("/api/setup/reconfigure", payload)
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

var domainImportYes bool

var domainImportCmd = &cobra.Command{
	Use:   "import <bundle.json>",
	Short: "Use a saved domain bundle — live URL switch when set up, staged for setup otherwise",
	Long: "With setup already completed, switches the RUNNING platform to the bundle's\n" +
		"domain: the DNS provider connection is restored, the bundled certificate is\n" +
		"reused (or re-issued when expired and the bundle carries the DNS token), and\n" +
		"the whole platform — YouEye ID, dashboard, every app — moves to that domain.\n\n" +
		"Before setup, stages the bundle so the setup wizard restores the domain\n" +
		"certificate and DNS provider automation (run after 'youeye deploy').",
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

		state := readPlatformYaml()
		if state.SetupCompleted {
			// Live switch: the platform is running — apply the bundle now.
			if !requireCP() {
				return nil
			}
			if state.Domain == strings.ToLower(b.Domain) {
				output.Info("The server URL is already " + b.Domain + " — nothing to do")
				return nil
			}
			if !confirmURLChange(strings.ToLower(b.Domain), state.Domain, false, domainImportYes) {
				return nil
			}
			var payload map[string]interface{}
			if err := json.Unmarshal(raw, &payload); err != nil {
				return fmt.Errorf("parsing bundle: %w", err)
			}
			return streamURLChange("/api/tls/domain/apply", payload)
		}

		// Pre-setup: stage for the wizard (original behavior).
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
	domainSetCmd.Flags().StringVar(&domainSetTLS, "tls", "auto", "certificate for the new name: auto, selfsigned or provider")
	domainSetCmd.Flags().BoolVarP(&domainSetYes, "yes", "y", false, "skip the confirmation prompt")
	domainImportCmd.Flags().BoolVarP(&domainImportYes, "yes", "y", false, "skip the confirmation prompt (live switch)")
	domainExportCmd.Flags().StringVarP(&domainExportOutput, "output", "o", "", "write the bundle to a file (default: stdout)")
	domainExportCmd.Flags().BoolVar(&domainExportIncludeToken, "include-token", false, "include the DNS provider token in the bundle")
	domainCmd.AddCommand(domainShowCmd)
	domainCmd.AddCommand(domainSetCmd)
	domainCmd.AddCommand(domainExportCmd)
	domainCmd.AddCommand(domainImportCmd)
}
