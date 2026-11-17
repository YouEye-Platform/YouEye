package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/boxca"
	"github.com/youeye-platform/YouEye/spine/internal/mdns"
	"github.com/youeye-platform/YouEye/spine/internal/setuppage"
)

const applianceStateRoot = "/var/lib/youeye-state"

// goBootSteps are boot steps written in Go (the others are embedded scripts).
var goBootSteps = map[string]func(args []string) error{
	"setup-page": runSetupPage,
}

// runSetupPage serves the Preparing page (youeye-setup-page.service) until
// first deployment stops it or completes.
func runSetupPage(args []string) error {
	if len(args) != 0 {
		return errors.New("usage: youeye boot setup-page")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	return setuppage.Run(ctx, setuppage.Config{
		StateRoot:  applianceStateRoot,
		CADir:      boxca.DefaultDir,
		HTTPAddr:   "0.0.0.0:47080",
		HTTPSAddr:  "0.0.0.0:47443",
		Journal:    firstDeployJournal,
		Retry:      retryFirstDeploy,
		LocalName:  publishedLocalName,
		LANAddress: lanIPv4Address,
	})
}

func firstDeployJournal(ctx context.Context) []string {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "journalctl", "--unit=youeye-first-deploy.service", "--boot",
		"--lines=30", "--output=cat", "--no-pager", "--quiet").Output()
	if err != nil && len(out) == 0 {
		return nil
	}
	return strings.Split(strings.TrimRight(string(out), "\n"), "\n")
}

// retryFirstDeploy starts first deployment again after it stopped at
// needs_attention: a fresh attempt count (first-deploy.sh refuses to run past
// its last attempt) and a cleared systemd start limit.
func retryFirstDeploy(ctx context.Context) error {
	path := filepath.Join(applianceStateRoot, "first-deploy/progress.json")
	record := map[string]any{
		"schema": firstDeployProgressSchema, "operation": "first-deploy", "state": "retrying",
		"stage": "retrying", "detail": "Retrying first deployment", "percent": 0, "attempt": 0,
		"updated_at": time.Now().UTC().Format(time.RFC3339),
	}
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	tmp := path + ".retry"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	_ = exec.CommandContext(ctx, "systemctl", "reset-failed", "youeye-first-deploy.service").Run()
	return exec.CommandContext(ctx, "systemctl", "restart", "--no-block", "youeye-first-deploy.service").Run()
}

func publishedLocalName(ctx context.Context) string {
	name, err := mdns.PublishedName(ctx)
	if err != nil {
		return ""
	}
	return name
}

// lanIPv4Address is the address of the adapter holding the default route.
func lanIPv4Address() string {
	routes, err := os.Open("/proc/net/route")
	if err != nil {
		return ""
	}
	defer routes.Close()
	name, err := mdns.LANInterface(routes)
	if err != nil {
		return ""
	}
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return ""
	}
	addresses, err := iface.Addrs()
	if err != nil {
		return ""
	}
	for _, address := range addresses {
		if ip, _, err := net.ParseCIDR(address.String()); err == nil && ip.To4() != nil && !ip.IsLinkLocalUnicast() {
			return ip.String()
		}
	}
	return ""
}

// youeye mdns: youeye.local on the LAN (youeye-mdns.service).
var mdnsCmd = &cobra.Command{
	Use:   "mdns",
	Short: "Publish the box as youeye.local on the LAN (Avahi, LAN adapter only)",
}

func init() {
	mdnsCmd.AddCommand(&cobra.Command{
		Use:   "run",
		Short: "Write the Avahi configuration for the LAN adapter and run avahi-daemon",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			iface, err := mdns.WriteConfig(mdns.ConfigPath)
			if err != nil {
				return err
			}
			fmt.Printf("Publishing %s on %s\n", mdns.DefaultName, iface)
			daemon := "/usr/sbin/avahi-daemon"
			return syscall.Exec(daemon, []string{daemon, "--no-rlimits", "--file=" + mdns.ConfigPath}, os.Environ())
		},
	})
	mdnsCmd.AddCommand(&cobra.Command{
		Use:   "name",
		Short: "Print the published mDNS name (youeye.local, or youeye-2.local … after a conflict)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			name, err := mdns.PublishedName(cmd.Context())
			if err != nil {
				return err
			}
			fmt.Println(name)
			return nil
		},
	})
	rootCmd.AddCommand(mdnsCmd)
}
