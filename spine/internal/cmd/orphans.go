package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

var orphansCmd = &cobra.Command{
	Use:   "orphans",
	Short: "Find untracked containers, routes, and databases",
	Long: `List resources an app install left behind: containers tagged by an install that no app record
names, app routes and databases of apps that are no longer installed, and YouEye app storage no record
names. Platform resources and data kept by a keep-data uninstall are never listed.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
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
		if err := requireCP(); err != nil {
			return err
		}
		result, err := controlClient.Post("/api/admin/orphans", map[string]string{"action": "cleanup-all"})
		if err != nil {
			return err
		}
		cleaned, failed := intOf(result["cleaned"]), intOf(result["failed"])
		if errs, ok := result["errors"].([]interface{}); ok {
			for _, e := range errs {
				if text, ok := e.(string); ok {
					output.Warn(text)
				}
			}
		}
		if failed > 0 {
			return fmt.Errorf("removed %d orphaned resource(s); %d could not be removed", cleaned, failed)
		}
		output.Success(fmt.Sprintf("Removed %d orphaned resource(s)", cleaned))
		return nil
	},
}

func intOf(value interface{}) int {
	if number, ok := value.(float64); ok {
		return int(number)
	}
	return 0
}

func init() {
	orphansCmd.AddCommand(orphansCleanCmd)
}
