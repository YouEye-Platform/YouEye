package cmd

import (
	"fmt"

	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var orphansCmd = &cobra.Command{
	Use:   "orphans",
	Short: "Find untracked containers, routes, and databases",
	Long: `Scan the platform for resources that exist but aren't tracked by any known app.
This includes containers running in Incus that aren't associated with any installed
app, Caddy routes pointing to unknown upstreams, and orphaned database entries.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Get("/api/admin/orphans")
		if err != nil {
			return err
		}

		countRaw := data["count"]
		count := 0
		if c, ok := countRaw.(float64); ok {
			count = int(c)
		}

		if count == 0 {
			output.Success("No orphaned resources found")
			return nil
		}

		orphansRaw, ok := data["orphans"].([]interface{})
		if !ok {
			return fmt.Errorf("unexpected response format")
		}

		rows := [][]string{}
		for _, o := range orphansRaw {
			orphan, ok := o.(map[string]interface{})
			if !ok {
				continue
			}
			oType := firstOf(orphan, "type")
			identifier := firstOf(orphan, "identifier")
			detail := firstOf(orphan, "detail")
			action := firstOf(orphan, "action")
			rows = append(rows, []string{oType, identifier, detail, action})
		}

		output.Warn(fmt.Sprintf("Found %d orphaned resource(s):", count))
		fmt.Println()
		output.Table([]string{"TYPE", "IDENTIFIER", "DETAIL", "ACTION"}, rows)
		fmt.Println()
		fmt.Println("Run 'youeye orphans clean' to remove orphaned resources.")
		return nil
	},
}

var orphansCleanCmd = &cobra.Command{
	Use:   "clean",
	Short: "Remove orphaned resources",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		result, err := controlClient.Post("/api/admin/orphans", nil)
		if err != nil {
			return err
		}
		if msg := str(result, "message"); msg != "" {
			output.Success(msg)
		} else {
			output.Success("Orphaned resources cleaned up")
		}
		return nil
	},
}

func init() {
	orphansCmd.AddCommand(orphansCleanCmd)
}
