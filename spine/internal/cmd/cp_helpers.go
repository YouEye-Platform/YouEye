package cmd

import (
	"fmt"

	"git.byka.wtf/potemsla/YouEye/spine/internal/cpapi"
	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
)

// cp is the global Control Panel API client, initialized in PersistentPreRunE.
var cp *cpapi.Client

// requireCP prints an error and returns false if CP is unreachable or has no token.
func requireCP() bool {
	if cp == nil {
		cp = cpapi.NewClient()
	}
	if !cp.Available() {
		output.Error("Control Panel is unreachable.")
		fmt.Println("  Check that YouEye is deployed and running: spine status")
		return false
	}
	if !cp.HasToken() {
		output.Warn("CLI token not found at " + cpapi.CLITokenPath)
		fmt.Println("  Run: sudo spine deploy (or provision the CLI token manually)")
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
func sseHandler(event cpapi.SSEEvent) {
	output.SSEProgress(event.Step, event.TotalSteps, event.Status, event.Message)
	if event.Detail != "" && (event.Status == "error" || event.Status == "failed") {
		fmt.Printf("    %s%s%s\n", output.Red, event.Detail, output.Reset)
	}
}

// capitalize returns s with the first letter uppercased.
func capitalize(s string) string {
	if s == "" {
		return s
	}
	return string(s[0]-32) + s[1:]
}
