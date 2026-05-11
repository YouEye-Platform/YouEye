package cmd

import (
	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Show all component versions",
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Header("YouEye Versions")

		output.StatusLine("YouEye CLI", Version+" (built "+BuildDate+")", output.Cyan)

		// Spine version [S]
		if data, err := spine.Get("/api/version"); err == nil {
			output.StatusLine("Spine", str(data, "version"), "")
		} else {
			output.StatusLine("Spine", "unreachable", output.Red)
		}

		// Component versions from Spine status [S]
		if data, err := spine.Get("/api/status"); err == nil {
			output.StatusLine("Incus", nested(data, "incus", "version"), "")
			cpVer := nested(data, "control_panel", "version")
			if cpVer != "" {
				output.StatusLine("Control Panel", cpVer, "")
			}
		}

		// App versions from CP [CP]
		if cp.Available() && cp.HasToken() {
			apps, err := cp.GetArray("/api/apps")
			if err == nil {
				for _, a := range apps {
					if app, ok := a.(map[string]interface{}); ok {
						name := firstOf(app, "name", "appId")
						ver := firstOf(app, "version", "installedVersion")
						if name != "" && ver != "" {
							output.StatusLine(name, ver, "")
						}
					}
				}
			}
		} else {
			output.StatusLine("Apps", "CP unreachable or no token", output.Yellow)
		}

		return nil
	},
}
