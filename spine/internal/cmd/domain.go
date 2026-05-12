package cmd

import (
	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var domainCmd = &cobra.Command{
	Use:   "domain",
	Short: "Manage platform domain",
}

var domainShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show the current base domain",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := cp.Get("/api/domain")
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
		_, err := cp.Post("/api/domain", map[string]interface{}{
			"domain": args[0],
		})
		if err != nil {
			return err
		}
		output.Success("Domain set to " + args[0])
		return nil
	},
}

func init() {
	domainCmd.AddCommand(domainShowCmd)
	domainCmd.AddCommand(domainSetCmd)
}
