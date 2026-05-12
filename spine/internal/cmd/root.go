package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
	"git.byka.wtf/potemsla/YouEye/spine/internal/cpapi"
	"git.byka.wtf/potemsla/YouEye/spine/internal/logging"
	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"git.byka.wtf/potemsla/YouEye/spine/internal/version"
	"github.com/spf13/cobra"
)

// Version and BuildDate are set at build time via ldflags:
//   go build -ldflags "-X git.byka.wtf/potemsla/YouEye/spine/internal/cmd.Version=0.2.4.1 -X git.byka.wtf/potemsla/YouEye/spine/internal/cmd.BuildDate=2026-03-27"
// Defaults here are used only for development builds.
var Version = "0.3.2.6"
var BuildDate = "dev"

// Global configuration
var cfg *config.Config

// CLI flags for config override
var cfgFile string

var rootCmd = &cobra.Command{
	Use:   "spine",
	Short: "YouEye Spine - Platform bootstrap and management",
	Long: `Spine is the unified management tool for the YouEye platform.

It bootstraps infrastructure (Incus, Control Panel), manages apps,
users, proxy routes, and provides an API for system integration.`,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		// Load configuration
		var err error
		if cfgFile != "" {
			cfg, err = config.LoadFromFile(cfgFile)
		} else {
			cfg, err = config.Load()
		}
		if err != nil {
			return fmt.Errorf("failed to load configuration: %w", err)
		}

		// Initialize structured logging based on config
		logging.Init(cfg.Logging.Level, cfg.Logging.Format)

		// Initialize CP client (lazy — commands that need it call requireCP())
		cp = cpapi.NewClient()

		return nil
	},
}

func Execute() error {
	return rootCmd.Execute()
}

// GetConfig returns the global configuration.
// Must be called after rootCmd.Execute() starts.
func GetConfig() *config.Config {
	if cfg == nil {
		return config.Default()
	}
	return cfg
}

func init() {
	// Persistent flags (available to all subcommands)
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default: /etc/spine/config.yaml)")

	// Version command flags
	versionCmd.Flags().BoolVar(&versionCheckFlag, "check", false, "Check for available updates")

	// Infrastructure commands (existing)
	rootCmd.AddCommand(installCmd)
	rootCmd.AddCommand(deployCmd)
	rootCmd.AddCommand(apiCmd)
	rootCmd.AddCommand(updateCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(logsCmd)
	rootCmd.AddCommand(cleanupCmd)
	rootCmd.AddCommand(uninstallCmd)
	rootCmd.AddCommand(configCmd)
	rootCmd.AddCommand(branchCmd)
	rootCmd.AddCommand(languageCmd)

	// Platform management commands (merged from CLI)
	rootCmd.AddCommand(appCmd)
	rootCmd.AddCommand(marketCmd)
	rootCmd.AddCommand(userCmd)
	rootCmd.AddCommand(proxyCmd)
	rootCmd.AddCommand(domainCmd)
	rootCmd.AddCommand(servicesCmd)
	rootCmd.AddCommand(containerMgmtCmd)
	rootCmd.AddCommand(setupCmd)
}

// versionCmd shows version info
var versionCheckFlag bool

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Show all component versions",
	Run: func(cmd *cobra.Command, args []string) {
		output.Header("YouEye Versions")
		output.StatusLine("Spine", Version+" (built "+BuildDate+")", output.Cyan)

		// Incus version
		incusVer := getIncusVersion()
		output.StatusLine("Incus", incusVer, "")

		// CP version
		cpStatus := getControlPanelStatus(GetConfig())
		output.StatusLine("Control Panel", cpStatus, "")

		// App versions from CP
		if cp != nil && cp.Available() && cp.HasToken() {
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
		}

		if versionCheckFlag {
			fmt.Println()
			fmt.Println("Checking for updates...")
			if update, newVer := checkSpineUpdate(cfg); update {
				cmp := version.CompareVersions(newVer, Version)
				if cmp > 0 {
					fmt.Printf("Update available: v%s -> v%s\n", Version, newVer)
					fmt.Println("Run 'spine update self' to update.")
				} else {
					fmt.Printf("Remote version v%s is not newer than current v%s\n", newVer, Version)
				}
			} else {
				output.Success("Spine is up to date")
			}
		}
	},
}

// statusCmd shows system status
var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show system status and available updates",
	RunE: func(cmd *cobra.Command, args []string) error {
		return runStatus()
	},
}

// logsCmd shows service logs
var logsCmd = &cobra.Command{
	Use:   "logs [component]",
	Short: "View logs (spine, control, ui, or app name)",
	Long: `View logs for a component. Without arguments, shows Spine logs.
  spine logs           Spine service logs
  spine logs control   Control Panel logs
  spine logs ui        UI logs
  spine logs <app>     App container logs`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		component := "spine"
		if len(args) > 0 {
			component = args[0]
		}

		switch component {
		case "spine":
			execCommand("journalctl", "-u", "spine", "-n", "100", "--no-pager")
		case "control", "control-panel", "cp":
			execCommand("incus", "exec", "youeye-control", "--", "journalctl", "-u", "youeye-control", "-n", "100", "--no-pager")
		case "ui":
			execCommand("incus", "exec", "youeye-ui", "--", "journalctl", "-u", "youeye-ui", "-n", "100", "--no-pager")
		default:
			c := exec.Command("incus", "exec", component, "--", "journalctl", "-n", "100", "--no-pager")
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			if err := c.Run(); err != nil {
				c2 := exec.Command("incus", "exec", "app-"+component, "--", "journalctl", "-n", "100", "--no-pager")
				c2.Stdout = os.Stdout
				c2.Stderr = os.Stderr
				if err2 := c2.Run(); err2 != nil {
					fmt.Fprintf(os.Stderr, "Could not find container '%s' or 'app-%s'\n", component, component)
				}
			}
		}
	},
}

func execCommand(name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Run()
}
