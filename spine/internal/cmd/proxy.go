package cmd

import (
	"fmt"

	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var proxyCmd = &cobra.Command{
	Use:   "proxy",
	Short: "Manage reverse proxy routes (Caddy)",
}

var proxyListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all proxy routes",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		routes, err := cp.GetArray("/api/caddy/routes")
		if err != nil {
			return err
		}

		rows := [][]string{}
		for _, r := range routes {
			route, ok := r.(map[string]interface{})
			if !ok {
				continue
			}
			host := firstOf(route, "hostname", "host", "match")
			target := firstOf(route, "upstream", "target", "handler")
			tls := firstOf(route, "tls", "https")
			rows = append(rows, []string{host, target, tls})
		}
		output.Table([]string{"HOSTNAME", "UPSTREAM", "TLS"}, rows)
		return nil
	},
}

var proxyAddCmd = &cobra.Command{
	Use:   "add <subdomain> <target>",
	Short: "Add a reverse proxy route",
	Long:  `Add a new Caddy reverse proxy route. Target should be host:port (e.g., 10.0.0.5:8080).`,
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		result, err := cp.Post("/api/caddy/routes", map[string]interface{}{
			"hostname": args[0],
			"upstream": args[1],
		})
		if err != nil {
			return err
		}
		output.Success("Route added: " + args[0] + " -> " + args[1])
		if id := str(result, "id"); id != "" {
			fmt.Printf("  Route ID: %s\n", id)
		}
		return nil
	},
}

var proxyRemoveCmd = &cobra.Command{
	Use:   "remove <subdomain>",
	Short: "Remove a proxy route",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		routes, err := cp.GetArray("/api/caddy/routes")
		if err != nil {
			return err
		}

		var routeID string
		for _, r := range routes {
			route, ok := r.(map[string]interface{})
			if !ok {
				continue
			}
			if firstOf(route, "hostname", "host") == args[0] {
				routeID = firstOf(route, "id")
				break
			}
		}
		if routeID == "" {
			return fmt.Errorf("route for '%s' not found", args[0])
		}

		_, err = cp.Delete("/api/caddy/routes/" + routeID)
		if err != nil {
			return err
		}
		output.Success("Route removed: " + args[0])
		return nil
	},
}

var proxyStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show Caddy status",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := cp.Get("/api/caddy/status")
		if err != nil {
			return err
		}
		status := firstOf(data, "status", "running")
		output.StatusLine("Caddy", status, statusColor(status))
		return nil
	},
}

func init() {
	proxyCmd.AddCommand(proxyListCmd)
	proxyCmd.AddCommand(proxyAddCmd)
	proxyCmd.AddCommand(proxyRemoveCmd)
	proxyCmd.AddCommand(proxyStatusCmd)
}
