package cmd

import (
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

var proxyCmd = &cobra.Command{
	Use:   "proxy",
	Short: "Manage reverse proxy routes (Caddy)",
}

var proxyListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all proxy routes",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		routes, err := controlClient.GetArray("/api/caddy/routes")
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
			if port := firstOf(route, "port"); port != "" && target != "" {
				target = net.JoinHostPort(target, port)
			}
			tls := firstOf(route, "tls", "https")
			rows = append(rows, []string{host, target, tls})
		}
		output.Table([]string{"HOSTNAME", "UPSTREAM", "TLS"}, rows)
		return nil
	},
}

var proxyAddCmd = &cobra.Command{
	Use:   "add <name> <target>",
	Short: "Add a reverse proxy route",
	Long: `Add a new Caddy reverse proxy route. A single-label name gets the platform domain appended
(nas becomes nas.<domain>); a name with dots is used as given. Target is host:port, where host is
a DNS name or an IPv4 address (e.g. 10.0.0.5:8080, nas.lan:5000). IPv6 targets are not supported.`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		host, port, err := parseProxyTarget(args[1])
		if err != nil {
			return err
		}
		if err := requireCP(); err != nil {
			return err
		}
		hostname, err := proxyHostname(args[0])
		if err != nil {
			return err
		}
		result, err := controlClient.Post("/api/caddy/routes", map[string]interface{}{
			"hostname": hostname,
			"upstream": host,
			"port":     port,
		})
		if err != nil {
			return err
		}
		output.Success(fmt.Sprintf("Route added: %s -> %s", hostname, net.JoinHostPort(host, strconv.Itoa(port))))
		route := proxyAddedRoute(result)
		if id := str(route, "id"); id != "" {
			fmt.Printf("  Route ID: %s\n", id)
		}
		if warning := firstOf(proxyAddedResult(result), "warning"); warning != "" {
			output.Warn(warning)
		}
		return nil
	},
}

// The CP answers {success, route: {route: {id, ...}, warning}}.
func proxyAddedResult(result map[string]interface{}) map[string]interface{} {
	outer, _ := result["route"].(map[string]interface{})
	return outer
}

func proxyAddedRoute(result map[string]interface{}) map[string]interface{} {
	route, _ := proxyAddedResult(result)["route"].(map[string]interface{})
	return route
}

var proxyRemoveCmd = &cobra.Command{
	Use:   "remove <name>",
	Short: "Remove a proxy route",
	Long:  "Remove a proxy route by host name. A single-label name gets the platform domain appended, as for add.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		hostname, err := proxyHostname(args[0])
		if err != nil {
			return err
		}
		routes, err := controlClient.GetArray("/api/caddy/routes")
		if err != nil {
			return err
		}

		var routeID string
		for _, r := range routes {
			route, ok := r.(map[string]interface{})
			if !ok {
				continue
			}
			if strings.EqualFold(firstOf(route, "hostname", "host"), hostname) {
				routeID = firstOf(route, "id")
				break
			}
		}
		if routeID == "" {
			return fmt.Errorf("route for '%s' not found", hostname)
		}

		_, err = controlClient.Delete("/api/caddy/routes/" + routeID)
		if err != nil {
			return err
		}
		output.Success("Route removed: " + hostname)
		return nil
	},
}

var proxyStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show Caddy status",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		data, err := controlClient.Get("/api/caddy/status")
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

// parseProxyTarget splits host:port where host is a DNS name or an IPv4 address, and port is 1–65535. IPv6 is
// refused: the Control Panel dials only IPv4 addresses and DNS names (lib/caddy/client.ts resolveCaddyUpstream).
func parseProxyTarget(target string) (string, int, error) {
	host, portText, err := net.SplitHostPort(strings.TrimSpace(target))
	if err != nil {
		return "", 0, fmt.Errorf("target %q must be host:port", target)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("target %q: port must be 1–65535", target)
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.To4() == nil {
			return "", 0, fmt.Errorf("target %q: IPv6 targets are not supported; use an IPv4 address or a DNS name", target)
		}
		return ip.String(), port, nil
	}
	if !proxyHostName.MatchString(host) {
		return "", 0, fmt.Errorf("target %q: %q is not a DNS name or IPv4 address", target, host)
	}
	return strings.ToLower(host), port, nil
}

var proxyHostName = regexp.MustCompile(`^(?i)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// proxyHostname turns the route name into the host Caddy matches. A single label is a name under the platform
// domain (nas -> nas.<domain>); a name with dots is used as given. Empty or invalid names are refused, since an
// empty host would match every request.
func proxyHostname(name string) (string, error) {
	return expandProxyHostname(name, func() (string, error) {
		data, err := controlClient.Get("/api/domain")
		if err != nil {
			return "", err
		}
		return firstOf(data, "domain"), nil
	})
}

func expandProxyHostname(name string, platformDomain func() (string, error)) (string, error) {
	name = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(name), "."))
	if name == "" {
		return "", fmt.Errorf("a route name is required (for example nas, or nas.example.com)")
	}
	if !proxyHostName.MatchString(name) {
		return "", fmt.Errorf("%q is not a valid host name", name)
	}
	if strings.Contains(name, ".") {
		return name, nil
	}
	domain, err := platformDomain()
	if err != nil {
		return "", fmt.Errorf("reading the platform domain: %w", err)
	}
	domain = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(domain), "."))
	if domain == "" || !proxyHostName.MatchString(domain) {
		return "", fmt.Errorf("no platform domain is set; give the full host name (for example %s.example.com)", name)
	}
	if len(name)+1+len(domain) > 253 {
		return "", fmt.Errorf("%s.%s is too long for a host name", name, domain)
	}
	return name + "." + domain, nil
}
