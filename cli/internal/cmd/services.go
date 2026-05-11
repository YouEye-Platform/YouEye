package cmd

import (
	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var servicesCmd = &cobra.Command{
	Use:   "services",
	Short: "List services and their health",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		services, err := cp.GetArray("/api/health/services")
		if err != nil {
			return err
		}
		rows := [][]string{}
		for _, s := range services {
			svc, ok := s.(map[string]interface{})
			if !ok {
				continue
			}
			name := firstOf(svc, "name", "slug")
			status := firstOf(svc, "status", "health")
			version := firstOf(svc, "version")
			uptime := firstOf(svc, "uptime")
			rows = append(rows, []string{name, status, version, uptime})
		}
		output.Table([]string{"SERVICE", "STATUS", "VERSION", "UPTIME"}, rows)
		return nil
	},
}

var servicesRestartCmd = &cobra.Command{
	Use:   "restart <name>",
	Short: "Restart a service",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		_, err := cp.Post("/api/health/services/"+args[0]+"/restart", nil)
		if err != nil {
			return err
		}
		output.Success("Service restarted: " + args[0])
		return nil
	},
}

func init() {
	servicesCmd.AddCommand(servicesRestartCmd)
}
