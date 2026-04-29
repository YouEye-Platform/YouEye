package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
	"git.byka.wtf/potemsla/YouEye/spine/internal/logging"
	"git.byka.wtf/potemsla/YouEye/spine/internal/version"
	"github.com/spf13/cobra"
)

// Version and BuildDate are set at build time via ldflags:
//   go build -ldflags "-X git.byka.wtf/potemsla/YouEye/spine/internal/cmd.Version=0.2.4.1 -X git.byka.wtf/potemsla/YouEye/spine/internal/cmd.BuildDate=2026-03-27"
// Defaults here are used only for development builds.
var Version = "0.3.2.2"
var BuildDate = "dev"

// Global configuration
var cfg *config.Config

// CLI flags for config override
var cfgFile string

var rootCmd = &cobra.Command{
	Use:   "spine",
	Short: "YouEye Spine - Infrastructure bootstrap and management",
	Long: `Spine is the bootstrap and management tool for YouEye infrastructure.

It installs Incus, deploys the Control Panel, and provides an API
for Control Panel to communicate with the host system.`,
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

	// Add all commands
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
}

// versionCmd shows version info
var versionCheckFlag bool

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Show Spine version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("YouEye Spine v%s\n", Version)
		fmt.Printf("Build: %s\n", BuildDate)

		if versionCheckFlag {
			fmt.Println("")
			fmt.Println("Checking for updates...")
			if update, newVer := checkSpineUpdate(cfg); update {
				cmp := version.CompareVersions(newVer, Version)
				if cmp > 0 {
					fmt.Printf("Update available: v%s → v%s\n", Version, newVer)
					fmt.Println("Run 'spine update self' to update.")
				} else {
					fmt.Printf("Remote version v%s is not newer than current v%s\n", newVer, Version)
				}
			} else {
				fmt.Println("✓ Spine is up to date")
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
	Use:   "logs",
	Short: "View Spine service logs",
	Run: func(cmd *cobra.Command, args []string) {
		runLogs()
	},
}

func runLogs() {
	// Show journalctl logs for spine service
	execCommand("journalctl", "-u", "spine", "-n", "50", "--no-pager")
}

func execCommand(name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Run()
}
