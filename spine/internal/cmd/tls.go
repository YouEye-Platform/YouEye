package cmd

import (
	"fmt"

	"github.com/YouEye-Platform/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var tlsCmd = &cobra.Command{
	Use:   "tls",
	Short: "Manage TLS certificates",
}

var tlsStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show current TLS mode and certificate info",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Get("/api/tls/status")
		if err != nil {
			return err
		}

		output.Section("TLS Status")
		output.StatusLine("Mode", firstOf(data, "mode"), "")

		hasExternal := firstOf(data, "hasExternalCert")
		output.StatusLine("External Cert", hasExternal, "")

		if subjects, ok := data["subjects"].([]interface{}); ok && len(subjects) > 0 {
			for _, s := range subjects {
				output.StatusLine("Subject", fmt.Sprintf("%v", s), "")
			}
		}

		if warning := firstOf(data, "expiryWarning"); warning == "true" {
			output.Warn("Certificate is nearing expiry!")
		}

		if cert, ok := data["cert"].(map[string]interface{}); ok && cert != nil {
			output.StatusLine("Issuer", firstOf(cert, "issuer"), "")
			output.StatusLine("Expires", firstOf(cert, "notAfter", "expires"), "")
		}

		return nil
	},
}

func init() {
	tlsCmd.AddCommand(tlsStatusCmd)
}
