package cmd

import (
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

// supportedLanguages maps ISO 639-1 codes to display names
var supportedLanguages = map[string]string{
	"en": "English",
	"ru": "Russian",
	"es": "Spanish",
	"de": "German",
	"fr": "French",
}

// languageNameToCode maps lowercase full names to ISO codes for convenience input
var languageNameToCode = map[string]string{
	"english": "en",
	"russian": "ru",
	"spanish": "es",
	"german":  "de",
	"french":  "fr",
}

var languageCmd = &cobra.Command{
	Use:   "language",
	Short: "Show or set the system language",
	Long: `Manage the system language for YouEye.

The language setting controls UI translations across the platform:
Control Panel, YouEye UI, and native apps.

Users can override the system language in their personal settings.
Marketplace apps receive the language via environment variables on
install and reconfigure.

Examples:
  spine language              Show current language
  spine language list         List all supported languages
  spine language set ru       Set language by ISO 639-1 code
  spine language set russian  Set language by full name`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return showLanguage()
	},
}

var languageListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all supported languages",
	RunE: func(cmd *cobra.Command, args []string) error {
		return listLanguages()
	},
}

var languageSetCmd = &cobra.Command{
	Use:   "set [language]",
	Short: "Set the system language (ISO code or full name)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return setLanguage(args[0])
	},
}

func init() {
	languageCmd.AddCommand(languageListCmd)
	languageCmd.AddCommand(languageSetCmd)
}

// resolveLanguageCode resolves user input to an ISO 639-1 code.
// Accepts both ISO codes ("ru") and full names ("russian", case-insensitive).
func resolveLanguageCode(input string) (string, error) {
	lower := strings.ToLower(strings.TrimSpace(input))

	// Direct ISO code match
	if _, ok := supportedLanguages[lower]; ok {
		return lower, nil
	}

	// Full name match
	if code, ok := languageNameToCode[lower]; ok {
		return code, nil
	}

	// Not found — build a helpful error
	codes := make([]string, 0, len(supportedLanguages))
	for code, name := range supportedLanguages {
		codes = append(codes, fmt.Sprintf("  %s (%s)", code, name))
	}
	sort.Strings(codes)

	return "", fmt.Errorf("unknown language: %q\n\nSupported languages:\n%s", input, strings.Join(codes, "\n"))
}

func showLanguage() error {
	cfg, err := loadBranchConfig()
	if err != nil {
		return err
	}

	// Language is stored in youeye.yaml alongside other config.
	// We read it via the raw YAML to get the language field.
	langCfg, err := loadLanguageFromConfig()
	if err != nil {
		return err
	}

	lang := langCfg
	if lang == "" {
		lang = "en"
	}

	name, ok := supportedLanguages[lang]
	if !ok {
		// Unknown code in config — show it but warn
		fmt.Printf("System language: %s (unknown code — will fall back to English)\n", lang)
		return nil
	}

	_ = cfg // suppress unused warning — we already loaded config for validation
	fmt.Printf("System language: %s (%s)\n", name, lang)
	return nil
}

func listLanguages() error {
	current, err := loadLanguageFromConfig()
	if err != nil {
		return err
	}
	if current == "" {
		current = "en"
	}

	// Sort by code for consistent output
	codes := make([]string, 0, len(supportedLanguages))
	for code := range supportedLanguages {
		codes = append(codes, code)
	}
	sort.Strings(codes)

	fmt.Println("Supported languages:")
	fmt.Println()
	for _, code := range codes {
		name := supportedLanguages[code]
		marker := "  "
		if code == current {
			marker = "* "
		}
		fmt.Printf("  %s%s  %s\n", marker, code, name)
	}
	fmt.Println()
	fmt.Printf("Current: %s (%s)\n", supportedLanguages[current], current)

	return nil
}

func setLanguage(input string) error {
	code, err := resolveLanguageCode(input)
	if err != nil {
		return err
	}

	current, err := loadLanguageFromConfig()
	if err != nil {
		return err
	}
	if current == "" {
		current = "en"
	}

	if code == current {
		fmt.Printf("System language is already set to: %s (%s)\n", supportedLanguages[code], code)
		return nil
	}

	if err := saveLanguageToConfig(code); err != nil {
		return err
	}

	fmt.Printf("System language changed: %s (%s) → %s (%s)\n",
		supportedLanguages[current], current,
		supportedLanguages[code], code)
	fmt.Println()
	fmt.Println("The language change will take effect across the platform:")
	fmt.Println("  - Control Panel: on next page load")
	fmt.Println("  - YouEye UI: on next page load (users with personal override are unaffected)")
	fmt.Println("  - Native apps: within 60 seconds")
	fmt.Println("  - Marketplace apps: after reconfigure (spine reconfigure or from CP settings)")

	return nil
}

// loadLanguageFromConfig reads just the language field from youeye.yaml.
// Returns empty string if not set (caller should treat as "en").
func loadLanguageFromConfig() (string, error) {
	cfg, err := loadBranchConfig()
	if err != nil {
		return "", err
	}
	_ = cfg

	// Read raw YAML to get language field (branchConfig doesn't have it)
	data, err := readYouEyeConfigRaw()
	if err != nil {
		return "", nil // file doesn't exist yet — default to empty
	}

	// Parse just the language field
	var raw map[string]interface{}
	if err := yamlUnmarshalForLanguage(data, &raw); err != nil {
		return "", nil
	}

	if lang, ok := raw["language"].(string); ok {
		return lang, nil
	}

	return "", nil
}

// saveLanguageToConfig writes the language field to youeye.yaml using
// the same load-modify-save pattern as branch.go to preserve all fields.
func saveLanguageToConfig(lang string) error {
	// Read existing raw YAML
	data, err := readYouEyeConfigRaw()
	if err != nil {
		data = []byte{} // fresh config
	}

	var raw map[string]interface{}
	if len(data) > 0 {
		if err := yamlUnmarshalForLanguage(data, &raw); err != nil {
			raw = make(map[string]interface{})
		}
	} else {
		raw = make(map[string]interface{})
	}

	raw["language"] = lang

	return writeYouEyeConfigRaw(raw)
}
