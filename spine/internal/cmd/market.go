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
	Short: "Show detailed Market entry",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
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

var marketRepoCmd = &cobra.Command{
	Use:   "repo",
	Short: "Manage the Control Panel-owned Market repository",
}

var marketRepoGetCmd = &cobra.Command{
	Use:   "get",
	Short: "Show the Market repository",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Get("/api/market/source")
		if err != nil {
			return err
		}
		source, _ := data["source"].(map[string]interface{})
		output.StatusLine("Market repository", firstOf(source, "repo_url"), "")
		output.StatusLine("Provider", firstOf(source, "provider"), "")
		output.StatusLine("Channel", firstOf(source, "branch"), "")
		output.StatusLine("Resolved commit", firstOf(source, "resolved_commit"), "")
		if refreshError := firstOf(source, "refresh_error"); refreshError != "" {
			output.StatusLine("Last refresh", "failed: "+refreshError, "")
		} else {
			output.StatusLine("Last refresh", firstOf(source, "resolved_at"), "")
		}
		return nil
	},
}

var marketRepoSetCmd = &cobra.Command{
	Use:   "set <url>",
	Short: "Set the Market repository",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Patch("/api/market/source", map[string]interface{}{
			"repo_url": args[0],
		})
		if err != nil {
			return err
		}
		source, _ := data["source"].(map[string]interface{})
		output.Success("Market repository set to " + firstOf(source, "repo_url"))
		return nil
	},
}

func init() {
	marketRepoCmd.AddCommand(marketRepoGetCmd)
	marketRepoCmd.AddCommand(marketRepoSetCmd)
	marketCmd.AddCommand(marketRepoCmd)
	marketCmd.AddCommand(marketSearchCmd)
	marketCmd.AddCommand(marketInfoCmd)
}
