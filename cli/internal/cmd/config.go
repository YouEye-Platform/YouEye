package cmd

import (
	"encoding/json"
	"fmt"

	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage platform configuration",
}

var configShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show platform configuration",
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Section("Spine Configuration")

		// Spine config [S]
		if data, err := spine.Get("/api/config"); err == nil {
			prettyJSON, _ := json.MarshalIndent(data, "  ", "  ")
			fmt.Println("  " + string(prettyJSON))
		} else {
			output.Error("Spine config: " + err.Error())
		}

		// CP config [CP]
		if cp.Available() {
			output.Section("Platform Settings")
			if data, err := cp.Get("/api/settings"); err == nil {
				prettyJSON, _ := json.MarshalIndent(data, "  ", "  ")
				fmt.Println("  " + string(prettyJSON))
			} else {
				output.Error("CP settings: " + err.Error())
			}
		} else {
			output.Section("Platform Settings")
			output.Warn("Control Panel unreachable")
		}

		return nil
	},
}

var configSetCmd = &cobra.Command{
	Use:   "set <key> <value>",
	Short: "Set a Spine configuration value",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		_, err := spine.Post("/api/config", map[string]interface{}{
			args[0]: args[1],
		})
		if err != nil {
			return err
		}
		output.Success(fmt.Sprintf("Config set: %s = %s", args[0], args[1]))
		return nil
	},
}

var configValidateCmd = &cobra.Command{
	Use:   "validate",
	Short: "Validate configuration file syntax",
	RunE: func(cmd *cobra.Command, args []string) error {
		data, err := spine.Get("/api/config")
		if err != nil {
			return err
		}
		if errMsg := str(data, "error"); errMsg != "" {
			output.Error("Config validation failed: " + errMsg)
		} else {
			output.Success("Configuration is valid")
		}
		return nil
	},
}

func init() {
	configCmd.AddCommand(configShowCmd)
	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configValidateCmd)
}
