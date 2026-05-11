package cmd

import (
	"fmt"
	"strings"

	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var containerCmd = &cobra.Command{
	Use:   "container",
	Short: "Manage Incus containers",
}

var containerListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all containers",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		containers, err := cp.GetArray("/api/containers")
		if err != nil {
			return err
		}

		rows := [][]string{}
		for _, c := range containers {
			ctr, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			name := firstOf(ctr, "name", "containerName")
			status := firstOf(ctr, "status", "state")
			ip := firstOf(ctr, "ip", "ipv4", "address")
			ctrType := firstOf(ctr, "type")
			rows = append(rows, []string{name, status, ip, ctrType})
		}
		output.Table([]string{"NAME", "STATUS", "IP", "TYPE"}, rows)
		return nil
	},
}

var containerExecCmd = &cobra.Command{
	Use:                "exec <name> -- <command...>",
	Short:              "Execute a command in a container",
	Args:               cobra.MinimumNArgs(1),
	DisableFlagParsing: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}

		container := args[0]

		// Find command after "--"
		cmdArgs := []string{}
		foundSep := false
		for _, a := range args[1:] {
			if a == "--" {
				foundSep = true
				continue
			}
			if foundSep {
				cmdArgs = append(cmdArgs, a)
			}
		}
		if !foundSep {
			// No separator, use everything after container name as command
			cmdArgs = args[1:]
		}
		if len(cmdArgs) == 0 {
			return fmt.Errorf("specify a command after '--'")
		}

		command := strings.Join(cmdArgs, " ")
		result, err := cp.Post("/api/incus/"+container+"/exec", map[string]interface{}{
			"command": command,
		})
		if err != nil {
			return err
		}
		if out := str(result, "output"); out != "" {
			fmt.Print(out)
		}
		if out := str(result, "stdout"); out != "" {
			fmt.Print(out)
		}
		return nil
	},
}

var containerLogsCmd = &cobra.Command{
	Use:   "logs <name>",
	Short: "View container logs",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := cp.Get("/api/incus/" + args[0] + "/logs")
		if err != nil {
			return err
		}
		if logs := str(data, "logs"); logs != "" {
			fmt.Println(logs)
		} else if logs := str(data, "output"); logs != "" {
			fmt.Println(logs)
		}
		return nil
	},
}

func init() {
	containerCmd.AddCommand(containerListCmd)
	containerCmd.AddCommand(containerExecCmd)
	containerCmd.AddCommand(containerLogsCmd)
}
