package cmd

import (
	"fmt"
	"strings"

	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var containerMgmtCmd = &cobra.Command{
	Use:     "container",
	Aliases: []string{"ctr"},
	Short:   "Manage Incus containers",
}

var containerMgmtListCmd = &cobra.Command{
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

var containerMgmtExecCmd = &cobra.Command{
	Use:                "exec <name> -- <command...>",
	Short:              "Execute a command in a container",
	Args:               cobra.MinimumNArgs(1),
	DisableFlagParsing: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}

		container := args[0]

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

var containerMgmtLogsCmd = &cobra.Command{
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
	containerMgmtCmd.AddCommand(containerMgmtListCmd)
	containerMgmtCmd.AddCommand(containerMgmtExecCmd)
	containerMgmtCmd.AddCommand(containerMgmtLogsCmd)
}
