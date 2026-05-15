package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"

	"github.com/YouEye-Platform/YouEye/spine/internal/api"
	"github.com/spf13/cobra"
)

var apiCmd = &cobra.Command{
	Use:   "api",
	Short: "Manage API server",
}

var apiServeCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the API server",
	RunE: func(cmd *cobra.Command, args []string) error {
		return startAPIServer()
	},
}

var apiStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the API server",
	RunE: func(cmd *cobra.Command, args []string) error {
		return stopAPIServer()
	},
}

func init() {
	apiCmd.AddCommand(apiServeCmd)
	apiCmd.AddCommand(apiStopCmd)
}

func startAPIServer() error {
	fmt.Println("Starting Spine API server...")
	
	// Get config
	cfg := GetConfig()
	
	// Create socket directory from config path
	socketDir := cfg.Paths.ConfigDir
	// Actually, socket dir should be derived from socket path
	socketPath := cfg.API.SocketPath
	// Extract directory from socket path
	lastSlash := len(socketPath) - 1
	for lastSlash >= 0 && socketPath[lastSlash] != '/' {
		lastSlash--
	}
	if lastSlash > 0 {
		socketDir = socketPath[:lastSlash]
	} else {
		socketDir = "/var/run/youeye"
	}
	
	if err := os.MkdirAll(socketDir, 0755); err != nil {
		return fmt.Errorf("failed to create socket directory: %w", err)
	}

	// Write PID file
	pidFile := socketDir + "/youeye.pid"
	if err := os.WriteFile(pidFile, []byte(fmt.Sprintf("%d", os.Getpid())), 0644); err != nil {
		fmt.Printf("Warning: could not write PID file: %v\n", err)
	}

	// Handle shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	
	go func() {
		<-sigChan
		fmt.Println("\nShutting down...")
		os.Remove(socketPath)
		os.Remove(pidFile)
		os.Exit(0)
	}()

	// Launch the host-IP-change check in a goroutine. It runs after a small
	// delay so its log lines don't interleave with the API server banner,
	// and it must NOT block ListenAndServe — incus-startup is waiting for
	// our socket to exist before bringing up containers, and the host-IP
	// migration depends on those containers being up.
	go runHostIPCheck(cfg)

	// Start server with config
	server := api.NewServer(Version, cfg)
	return server.ListenAndServe()
}

func stopAPIServer() error {
	pidFile := "/var/run/youeye/youeye.pid"
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return fmt.Errorf("API server not running (no PID file)")
	}

	// Send SIGTERM
	cmd := exec.Command("kill", string(data))
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to stop API server: %w", err)
	}

	fmt.Println("API server stopped")
	return nil
}
