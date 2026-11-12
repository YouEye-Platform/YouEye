package cmd

import (
	"fmt"
	"regexp"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

var appIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// appSuggestionsCmd lists the connections the Control Panel suggests (`/api/suggestions`).
var appSuggestionsCmd = &cobra.Command{
	Use:   "suggestions",
	Short: "List suggested app connections",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		items, err := controlClient.GetArray("/api/suggestions")
		if err != nil {
			return err
		}
		var rows [][]string
		for _, item := range items {
			s, ok := item.(map[string]interface{})
			if !ok || s["type"] != "bridge" {
				continue
			}
			ready := "waiting for " + firstOf(s, "targetAppId")
			if installed, _ := s["targetInstalled"].(bool); installed {
				ready = "ready"
			}
			rows = append(rows, []string{firstOf(s, "fromAppId"), firstOf(s, "targetAppId"), firstOf(s, "scope"), ready})
		}
		if len(rows) == 0 {
			output.Info("No suggested connections")
			return nil
		}
		output.Table([]string{"FROM", "TO", "SCOPE", "STATE"}, rows)
		return nil
	},
}

// appConnectCmd approves one suggested connection, as the Connect button does: the network grant, then the
// consumer's connect setup file.
var appConnectCmd = &cobra.Command{
	Use:   "connect <from-app> <to-app>",
	Short: "Approve a suggested connection between two installed apps",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		from, to := args[0], args[1]
		if !appIDPattern.MatchString(from) || !appIDPattern.MatchString(to) {
			return fmt.Errorf("app ids are lowercase letters, digits and dashes")
		}
		result, err := controlClient.Post("/api/suggestions", map[string]interface{}{
			"action": "approve",
			"id":     "bridge-" + from + "-" + to,
		})
		if err != nil {
			return err
		}
		if ok, _ := result["ok"].(bool); !ok {
			return fmt.Errorf("the connection %s → %s was not approved", from, to)
		}
		output.Success(fmt.Sprintf("Connected %s → %s", from, to))
		return nil
	},
}

func init() {
	appCmd.AddCommand(appSuggestionsCmd)
	appCmd.AddCommand(appConnectCmd)
}
