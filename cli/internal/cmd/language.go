package cmd

import (
	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var languageCmd = &cobra.Command{
	Use:   "language",
	Short: "Manage system language",
	RunE: func(cmd *cobra.Command, args []string) error {
		// Show current language when called without subcommand
		data, err := spine.Get("/api/config")
		if err != nil {
			return err
		}
		lang := str(data, "language")
		if lang == "" {
			lang = "en"
		}
		output.StatusLine("Language", lang, "")
		return nil
	},
}

var languageListCmd = &cobra.Command{
	Use:   "list",
	Short: "List supported languages",
	RunE: func(cmd *cobra.Command, args []string) error {
		languages := [][]string{
			{"en", "English"},
			{"ru", "Russian"},
			{"es", "Spanish"},
			{"de", "German"},
			{"fr", "French"},
		}
		output.Table([]string{"CODE", "LANGUAGE"}, languages)
		return nil
	},
}

var languageSetCmd = &cobra.Command{
	Use:   "set <code>",
	Short: "Set the system language (ISO code or full name)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		_, err := spine.Post("/api/config", map[string]interface{}{
			"language": args[0],
		})
		if err != nil {
			return err
		}
		output.Success("Language set to " + args[0])
		return nil
	},
}

func init() {
	languageCmd.AddCommand(languageListCmd)
	languageCmd.AddCommand(languageSetCmd)
}
