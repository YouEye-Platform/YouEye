package cmd

import (
	"fmt"
	"strings"

	"github.com/YouEye-Platform/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var marketCmd = &cobra.Command{
	Use:   "market",
	Short: "Browse the app marketplace",
}

var marketSearchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Search the marketplace catalog",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
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
	Short: "Show detailed marketplace entry",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Get("/api/market/app/" + args[0])
		if err != nil {
			return err
		}

		output.Section("Marketplace: " + args[0])
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

func init() {
	marketCmd.AddCommand(marketSearchCmd)
	marketCmd.AddCommand(marketInfoCmd)
}
