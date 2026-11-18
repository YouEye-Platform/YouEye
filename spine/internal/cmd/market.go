package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

var marketCmd = &cobra.Command{
	Use:   "market",
	Short: "Browse Market",
}

var marketSearchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Search the Market catalog",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		query := strings.ToLower(args[0])

		catalog, err := controlClient.GetArray("/api/market/catalog")
		if err != nil {
			return err
		}

		rows := [][]string{}
		for _, item := range catalog {
			app, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			name := firstOf(app, "name", "appId", "id")
			desc := firstOf(app, "description", "tagline")
			category := firstOf(app, "category")
			id := firstOf(app, "appId", "id")

			searchable := strings.ToLower(name + " " + desc + " " + category + " " + id)
			if strings.Contains(searchable, query) {
				rows = append(rows, []string{id, name, category, truncate(desc, 50)})
			}
		}

		if len(rows) == 0 {
			fmt.Printf("No apps matching '%s'\n", args[0])
			return nil
		}

		output.Table([]string{"ID", "NAME", "CATEGORY", "DESCRIPTION"}, rows)
		return nil
	},
}

var marketInfoCmd = &cobra.Command{
	Use:   "info <app-id>",
	Short: "Show detailed Market entry",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		data, err := controlClient.Get("/api/market/app/" + args[0])
		if err != nil {
			return err
		}

		output.Section("Market: " + args[0])
		output.StatusLine("Name", firstOf(data, "name"), "")
		output.StatusLine("Description", firstOf(data, "description", "tagline"), "")
		output.StatusLine("Category", firstOf(data, "category"), "")
		output.StatusLine("Version", firstOf(data, "version", "latestVersion"), "")
		output.StatusLine("Installed", firstOf(data, "installed"), "")

		if containers, ok := data["containers"].([]interface{}); ok {
			output.StatusLine("Containers", fmt.Sprintf("%d", len(containers)), "")
		}
		if sso, ok := data["sso"].(map[string]interface{}); ok {
			output.StatusLine("SSO", firstOf(sso, "enabled", "type"), "")
		}

		return nil
	},
}

var marketSourceCmd = &cobra.Command{
	Use:   "source",
	Short: "List Market sources and accept a custom one",
	Long: `The official Market is always a source. A custom source (a Git repository added under Market -> Manage
sources) is accepted by the owner when it is added; until then its apps are listed but never installed, updated
or switched to. Apps from a custom source are not checked by YouEye and run their own setup steps on the box.`,
}

var marketSourceListCmd = &cobra.Command{
	Use:   "list",
	Short: "List Market sources",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		data, err := controlClient.Get("/api/market/source")
		if err != nil {
			return err
		}
		output.Table([]string{"ID", "NAME", "ADDRESS", "BRANCH", "ENABLED", "ACCEPTED"}, marketSourceRows(data))
		return nil
	},
}

// marketSourceRows renders GET /api/market/source: the official source is always accepted; a custom one shows
// when it was accepted, or "no".
func marketSourceRows(data map[string]interface{}) [][]string {
	sources, _ := data["sources"].([]interface{})
	rows := [][]string{}
	for _, item := range sources {
		source, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		accepted := firstOf(source, "accepted_at")
		address := firstOf(source, "repo_url")
		if firstOf(source, "kind") == "channel" {
			accepted = "official"
			address = "(this channel's Market release)"
		} else if accepted == "" {
			accepted = "no"
		}
		enabled := "yes"
		if on, ok := source["enabled"].(bool); ok && !on {
			enabled = "no"
		}
		rows = append(rows, []string{firstOf(source, "id"), firstOf(source, "name"), address, firstOf(source, "branch"), enabled, accepted})
	}
	return rows
}

var marketSourceAcceptCmd = &cobra.Command{
	Use:   "accept <id>",
	Short: "Accept a custom Market source, so its apps may be installed and updated",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		output.Warn("Apps from this source are not checked by YouEye. They run their own setup steps on your box.")
		data, err := controlClient.Post("/api/market/source/accept", map[string]interface{}{"id": args[0]})
		if err != nil {
			return err
		}
		source, _ := data["source"].(map[string]interface{})
		output.Success(fmt.Sprintf("Market source %s (%s, branch %s) accepted", args[0], firstOf(source, "repo_url"), firstOf(source, "branch")))
		return nil
	},
}

func init() {
	marketSourceCmd.AddCommand(marketSourceListCmd)
	marketSourceCmd.AddCommand(marketSourceAcceptCmd)
	marketCmd.AddCommand(marketSourceCmd)
	marketCmd.AddCommand(marketSearchCmd)
	marketCmd.AddCommand(marketInfoCmd)
}
