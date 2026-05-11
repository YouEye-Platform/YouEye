package cmd

import (
	"fmt"

	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show platform status",
	Long:  `Shows Spine status, Control Panel health, and app health. Degrades gracefully if CP is down.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Header("YouEye Platform Status")

		// Spine status [S]
		spineOK := spine.Available()
		if spineOK {
			data, err := spine.Get("/api/status")
			if err == nil {
				output.Section("Infrastructure")
				output.StatusLine("Spine", nested(data, "spine", "version"), output.Green)
				output.StatusLine("Host OS", nested(data, "host", "os"), "")
				output.StatusLine("Incus", nested(data, "incus", "version"), "")

				cpStatus := nested(data, "control_panel", "status")
				cpVersion := nested(data, "control_panel", "version")
				cpDisplay := cpStatus
				if cpVersion != "" {
					cpDisplay = cpStatus + " (v" + cpVersion + ")"
				}
				output.StatusLine("Control Panel", cpDisplay, statusColor(cpStatus))

				uiStatus := nested(data, "ui", "status")
				output.StatusLine("UI", uiStatus, statusColor(uiStatus))
			} else {
				output.Section("Infrastructure")
				output.Error("Could not query Spine API: " + err.Error())
			}

			// Container count from config
			if cfgData, err := spine.GetRaw("/api/status"); err == nil {
				_ = cfgData // already parsed above
			}
		} else {
			output.Section("Infrastructure")
			output.Error("Spine API unreachable")
		}

		// CP health + apps [CP]
		if cp.Available() {
			if cp.HasToken() {
				output.Section("Services")
				svcList, err := cp.GetArray("/api/health/services")
				if err == nil {
					rows := [][]string{}
					for _, svc := range svcList {
						if s, ok := svc.(map[string]interface{}); ok {
							name := firstOf(s, "name", "slug")
							health := firstOf(s, "status", "health")
							ver := firstOf(s, "version")
							rows = append(rows, []string{name, health, ver})
						}
					}
					output.Table([]string{"SERVICE", "STATUS", "VERSION"}, rows)
				} else {
					output.Warn("Services: " + err.Error())
				}

				output.Section("Apps")
				apps, err := cp.GetArray("/api/apps")
				if err == nil {
					rows := [][]string{}
					for _, a := range apps {
						if app, ok := a.(map[string]interface{}); ok {
							name := firstOf(app, "name", "appId")
							version := firstOf(app, "version", "installedVersion")
							health := firstOf(app, "healthStatus", "health", "status")
							rows = append(rows, []string{name, version, health})
						}
					}
					if len(rows) > 0 {
						output.Table([]string{"APP", "VERSION", "HEALTH"}, rows)
					} else {
						fmt.Println("  No apps installed")
					}
				} else {
					output.Warn("Apps: " + err.Error())
				}
			} else {
				output.Section("Control Panel")
				output.Warn("CLI token not configured — CP details unavailable")
				output.Info("Run: sudo youeye setup or provision CLI token via spine deploy")
			}
		} else {
			output.Section("Control Panel")
			output.Warn("Control Panel unreachable — app and service status unavailable")
			fmt.Println("  Spine-level commands still work. Fix CP: youeye update control")
		}

		return nil
	},
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

func str(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

func versionHint(m map[string]interface{}, key string) string {
	v := str(m, key)
	if v != "" && v != "<nil>" {
		return output.Yellow + "(update: " + v + ")" + output.Reset
	}
	return output.Green + "(latest)" + output.Reset
}

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
