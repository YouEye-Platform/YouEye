package cmd

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/YouEye-Platform/YouEye/spine/internal/controlapi"
	"github.com/YouEye-Platform/YouEye/spine/internal/output"
)

// incusContainer holds basic container info from Incus CLI.
type incusContainer struct {
	Name   string
	Status string
	IP     string
}

// getIncusContainers returns all containers from Incus via CLI.
func getIncusContainers() []incusContainer {
	out, err := exec.Command("incus", "list", "--format", "csv", "-c", "ns4").Output()
	if err != nil {
		return nil
	}
	var result []incusContainer
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ",", 3)
		if len(parts) < 2 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		status := strings.ToLower(strings.TrimSpace(parts[1]))
		ip := ""
		if len(parts) >= 3 {
			ipField := strings.TrimSpace(parts[2])
			if idx := strings.Index(ipField, " "); idx > 0 {
				ip = ipField[:idx]
			} else {
				ip = ipField
			}
		}
		result = append(result, incusContainer{Name: name, Status: status, IP: ip})
	}
	return result
}

// trackedContainerNames extracts all container names from unified app data.
func trackedContainerNames(appsRaw []interface{}) map[string]bool {
	tracked := make(map[string]bool)
	for _, a := range appsRaw {
		app, ok := a.(map[string]interface{})
		if !ok {
			continue
		}
		containers, ok := app["containers"].([]interface{})
		if !ok {
			continue
		}
		for _, c := range containers {
			if ctr, ok := c.(map[string]interface{}); ok {
				name := firstOf(ctr, "name")
				if name != "" {
					tracked[name] = true
				}
			}
		}
	}
	return tracked
}

// untrackedContainers returns Incus containers not present in the tracked set.
func untrackedContainers(tracked map[string]bool) []incusContainer {
	all := getIncusContainers()
	var untracked []incusContainer
	for _, c := range all {
		if !tracked[c.Name] {
			untracked = append(untracked, c)
		}
	}
	return untracked
}

// groupUntrackedAsApps groups untracked containers into inferred app entries.
// Containers sharing a common prefix (e.g. app-searxng-main, app-searxng-redis → "searxng")
// are grouped under one app.
func groupUntrackedAsApps(containers []incusContainer) []untrackedApp {
	if len(containers) == 0 {
		return nil
	}
	// Build list of stripped names for prefix matching
	stripped := make([]string, len(containers))
	for i, c := range containers {
		s := c.Name
		if strings.HasPrefix(s, "app-") {
			s = strings.TrimPrefix(s, "app-")
		} else if strings.HasPrefix(s, "youeye-") {
			s = strings.TrimPrefix(s, "youeye-")
		}
		stripped[i] = s
	}

	assigned := make(map[int]bool)
	var apps []untrackedApp

	for i, c := range containers {
		if assigned[i] {
			continue
		}
		parts := strings.Split(stripped[i], "-")
		appName := stripped[i]
		group := []incusContainer{c}
		assigned[i] = true

		// Try to find siblings with the same prefix (only if multi-part name)
		if len(parts) > 1 {
			prefix := parts[0]
			for j, other := range containers {
				if assigned[j] {
					continue
				}
				if strings.HasPrefix(stripped[j], prefix+"-") {
					group = append(group, other)
					assigned[j] = true
					appName = prefix
				}
			}
		}

		apps = append(apps, untrackedApp{
			Name:       appName,
			Containers: group,
		})
	}
	return apps
}

type untrackedApp struct {
	Name       string
	Containers []incusContainer
}

// controlClient is the global Control Panel API client, initialized in PersistentPreRunE.
var controlClient *controlapi.Client

// requireControlPanel prints an error and returns false if CP is unreachable or has no token.
func requireCP() bool {
	if controlClient == nil {
		controlClient = controlapi.NewClient()
	}
	if !controlClient.Available() {
		output.Error("Control Panel is unreachable.")
		fmt.Println("  Check that YouEye is deployed and running: youeye status")
		return false
	}
	if !controlClient.HasToken() {
		output.Warn("CLI token not found at " + controlapi.CLITokenPath)
		fmt.Println("  Run: sudo youeye deploy (or provision the CLI token manually)")
		return false
	}
	return true
}

// nested safely extracts a value from a nested map like {"spine": {"version": "1.0"}}.
func nested(m map[string]interface{}, keys ...string) string {
	current := m
	for i, key := range keys {
		v, ok := current[key]
		if !ok {
			return ""
		}
		if i == len(keys)-1 {
			return fmt.Sprintf("%v", v)
		}
		next, ok := v.(map[string]interface{})
		if !ok {
			return ""
		}
		current = next
	}
	return ""
}

// str gets a string value from a map.
func str(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

// firstOf returns the first non-empty, non-nil value from multiple possible key names.
func firstOf(m map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			s := fmt.Sprintf("%v", v)
			if s != "" && s != "<nil>" {
				return s
			}
		}
	}
	return ""
}

// statusColor returns an ANSI color code for a status string.
func statusColor(s string) string {
	switch s {
	case "running", "Running", "healthy", "ok":
		return output.Green
	case "stopped", "Stopped", "error", "unhealthy", "failed":
		return output.Red
	case "unknown":
		return output.Yellow
	default:
		return ""
	}
}

// truncate shortens a string with "..." suffix.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-3] + "..."
}

// sseHandler formats SSE progress events for terminal output.
func sseHandler(event controlapi.SSEEvent) {
	output.SSEProgress(event.Step, event.TotalSteps, event.Status, event.Message)
	if event.Detail != "" && (event.Status == "error" || event.Status == "failed") {
		fmt.Printf("    %s%s%s\n", output.Red, event.Detail, output.Reset)
	}
}

// findUnifiedApp looks up an app by id or displayName from /api/apps/unified.
func findUnifiedApp(name string) map[string]interface{} {
	data, err := controlClient.Get("/api/apps/unified")
	if err != nil {
		return nil
	}
	appsRaw, ok := data["apps"].([]interface{})
	if !ok {
		return nil
	}
	nameLower := strings.ToLower(name)
	for _, a := range appsRaw {
		app, ok := a.(map[string]interface{})
		if !ok {
			continue
		}
		id := strings.ToLower(firstOf(app, "id"))
		display := strings.ToLower(firstOf(app, "displayName"))
		if id == nameLower || display == nameLower {
			return app
		}
	}
	return nil
}

// capitalize returns s with the first letter uppercased.
func capitalize(s string) string {
	if s == "" {
		return s
	}
	return string(s[0]-32) + s[1:]
}
