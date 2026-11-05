package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/util"
)

type deploymentFinalizationOps interface {
	ProvisionBridgeToken() error
	ProvisionCLIToken() error
	EnableService() error
	PersistHostIP(string) error
	Verify(string) error
}

type systemDeploymentFinalizationOps struct{ appliance bool }

func (systemDeploymentFinalizationOps) ProvisionBridgeToken() error { return provisionBridgeToken() }
func (systemDeploymentFinalizationOps) ProvisionCLIToken() error    { return provisionCLIToken() }
func (o systemDeploymentFinalizationOps) EnableService() error {
	if o.appliance {
		return enableBakedSpineService()
	}
	return enableSpineService()
}
func (systemDeploymentFinalizationOps) PersistHostIP(ip string) error {
	return util.WriteStoredHostIP(ip)
}
func (systemDeploymentFinalizationOps) Verify(ip string) error {
	return verifyDeploymentCompletion(ip)
}

func finalizeDeployment(hostIP string) error {
	status, _, err := applianceRuntime()
	if err != nil {
		return err
	}
	return runDeploymentFinalization(systemDeploymentFinalizationOps{appliance: status.Kind == "appliance-image"}, hostIP)
}

func runDeploymentFinalization(ops deploymentFinalizationOps, hostIP string) error {
	steps := []struct {
		name string
		run  func() error
	}{
		{"bridge token", ops.ProvisionBridgeToken},
		{"CLI token", ops.ProvisionCLIToken},
		{"boot service and Incus dependency", ops.EnableService},
		{"stored host IP", func() error { return ops.PersistHostIP(hostIP) }},
		{"completion invariants", func() error { return ops.Verify(hostIP) }},
	}
	for _, step := range steps {
		if err := step.run(); err != nil {
			return fmt.Errorf("%s: %w", step.name, err)
		}
	}
	return nil
}

func requireContainerRunning(container string) error {
	out, err := exec.Command("incus", "list", container, "--format", "csv", "-c", "s").CombinedOutput()
	if err != nil {
		return fmt.Errorf("read %s state: %w: %s", container, err, strings.TrimSpace(string(out)))
	}
	if strings.TrimSpace(strings.ToUpper(string(out))) != "RUNNING" {
		return fmt.Errorf("required container %s is not running (state %q)", container, strings.TrimSpace(string(out)))
	}
	return nil
}

func waitForContainerService(container, service string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out, err := exec.Command("incus", "exec", container, "--", "systemctl", "is-active", service).CombinedOutput()
		if err == nil && strings.TrimSpace(string(out)) == "active" {
			return nil
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("%s service %s did not become active within %s", container, service, timeout)
}

func verifyHostToken(path, expected string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(data)) != expected {
		return fmt.Errorf("token value does not match the provisioned value")
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm() != 0600 {
		return fmt.Errorf("permissions are %04o, want 0600", info.Mode().Perm())
	}
	return nil
}

func verifyContainerToken(container, path, expected string) error {
	out, err := exec.Command("incus", "exec", container, "--", "cat", path).Output()
	if err != nil {
		return fmt.Errorf("read token: %w", err)
	}
	if strings.TrimSpace(string(out)) != expected {
		return fmt.Errorf("token value does not match the host")
	}
	mode, err := exec.Command("incus", "exec", container, "--", "stat", "-c", "%a", path).Output()
	if err != nil {
		return fmt.Errorf("read token permissions: %w", err)
	}
	if strings.TrimSpace(string(mode)) != "600" {
		return fmt.Errorf("permissions are %q, want 600", strings.TrimSpace(string(mode)))
	}
	return nil
}

func verifySystemdState(service, command, expected string) error {
	out, err := exec.Command("systemctl", command, service).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s %s: %w: %s", command, service, err, strings.TrimSpace(string(out)))
	}
	if strings.TrimSpace(string(out)) != expected {
		return fmt.Errorf("systemctl %s %s returned %q, want %q", command, service, strings.TrimSpace(string(out)), expected)
	}
	return nil
}

func reapDetachedProcess(cmd *exec.Cmd) <-chan error {
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
		close(done)
	}()
	return done
}

func processState(status []byte) string {
	for _, line := range bytes.Split(status, []byte{'\n'}) {
		if !bytes.HasPrefix(line, []byte("State:")) {
			continue
		}
		fields := bytes.Fields(line)
		if len(fields) >= 2 {
			return string(fields[1])
		}
	}
	return ""
}

// detachedProcessExited considers zombies exited: they cannot own the API
// socket or do work, and only await reaping by their parent. Fresh deploys reap
// their child in the background; the zombie check also makes finalisation safe
// when resuming a deployment started by an older Spine binary.
func detachedProcessExited(pid int) (bool, error) {
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if os.IsNotExist(err) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("read detached API process state: %w", err)
	}
	switch processState(status) {
	case "Z", "X":
		return true, nil
	case "":
		return false, fmt.Errorf("detached API process state is unavailable")
	default:
		return false, nil
	}
}

func isYouEyeAPIServerCommandLine(commandLine []byte) bool {
	parts := bytes.Split(bytes.TrimRight(commandLine, "\x00"), []byte{'\x00'})
	if len(parts) < 3 {
		return false
	}
	binary := filepath.Base(string(parts[0]))
	return (binary == "youeye" || binary == "spine") && string(parts[1]) == "api" && string(parts[2]) == "serve"
}

func verifyDetachedAPIIdentity(pid int) error {
	commandLine, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read detached API process identity: %w", err)
	}
	if !isYouEyeAPIServerCommandLine(commandLine) {
		return fmt.Errorf("refusing to signal PID %d because it is not a YouEye API server", pid)
	}
	return nil
}

func removeDetachedPIDFileIfMatches(path string, pid int) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(data)) != strconv.Itoa(pid) {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func systemdManagedYouEyePID() int {
	out, err := exec.Command("systemctl", "show", "youeye.service", "-p", "MainPID", "--value").Output()
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid <= 1 {
		return 0
	}
	return pid
}

func shouldStopDetachedAPI(pid, managedPID int) bool {
	return managedPID <= 1 || pid != managedPID
}

func stopDetachedAPIServer() error {
	const pidPath = "/var/run/youeye/youeye.pid"
	data, err := os.ReadFile(pidPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read detached API PID: %w", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 1 {
		return fmt.Errorf("detached API PID file is invalid")
	}
	exited, err := detachedProcessExited(pid)
	if err != nil {
		return err
	}
	if exited {
		return removeDetachedPIDFileIfMatches(pidPath, pid)
	}
	if err := verifyDetachedAPIIdentity(pid); err != nil {
		return err
	}
	if !shouldStopDetachedAPI(pid, systemdManagedYouEyePID()) {
		return nil
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		// A process that exited between the identity check and signal is already
		// in the desired state. Do not swallow any other signal error.
		exited, stateErr := detachedProcessExited(pid)
		if stateErr != nil {
			return errors.Join(fmt.Errorf("stop detached API process: %w", err), stateErr)
		}
		if !exited {
			return fmt.Errorf("stop detached API process: %w", err)
		}
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		exited, err := detachedProcessExited(pid)
		if err != nil {
			return err
		}
		if exited {
			return removeDetachedPIDFileIfMatches(pidPath, pid)
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("detached API process %d did not stop within 10s", pid)
}

func verifyDeploymentCompletion(hostIP string) error {
	bridgePath := "/var/lib/youeye/control/.bridge_token"
	bridge, err := os.ReadFile(bridgePath)
	if err != nil {
		return fmt.Errorf("read host bridge token: %w", err)
	}
	bridgeToken := strings.TrimSpace(string(bridge))
	if len(bridgeToken) != 64 {
		return fmt.Errorf("host bridge token has invalid length")
	}
	if err := verifyHostToken(bridgePath, bridgeToken); err != nil {
		return fmt.Errorf("host bridge token: %w", err)
	}
	for _, container := range []string{"youeye-control", "youeye-ui"} {
		if err := verifyContainerToken(container, "/etc/youeye/ui-bridge-token", bridgeToken); err != nil {
			return fmt.Errorf("%s bridge token: %w", container, err)
		}
	}

	cliPath := "/var/lib/youeye/config/cli-token"
	cli, err := os.ReadFile(cliPath)
	if err != nil {
		return fmt.Errorf("read host CLI token: %w", err)
	}
	cliToken := strings.TrimSpace(string(cli))
	if len(cliToken) != 64 {
		return fmt.Errorf("host CLI token has invalid length")
	}
	if err := verifyHostToken(cliPath, cliToken); err != nil {
		return fmt.Errorf("host CLI token: %w", err)
	}
	if err := verifyContainerToken("youeye-control", "/etc/youeye/cli-token", cliToken); err != nil {
		return fmt.Errorf("Control Panel CLI token: %w", err)
	}

	storedIP, err := util.ReadStoredHostIP()
	if err != nil {
		return fmt.Errorf("read stored host IP: %w", err)
	}
	if storedIP != hostIP {
		return fmt.Errorf("stored host IP is %q, want %q", storedIP, hostIP)
	}

	if err := verifySystemdState("youeye.service", "is-enabled", "enabled"); err != nil {
		return err
	}
	if err := verifySystemdState("youeye.service", "is-active", "active"); err != nil {
		return err
	}

	for _, container := range []string{
		"youeye-control",
		"youeye-postgres",
		"youeye-caddy",
		"youeye-pihole",
		"youeye-ui",
	} {
		if err := requireContainerRunning(container); err != nil {
			return err
		}
	}
	for _, service := range []struct{ container, unit string }{
		{"youeye-control", "youeye-control"},
		{"youeye-control", "youeye-id"},
		{"youeye-ui", "youeye-ui"},
	} {
		if err := waitForContainerService(service.container, service.unit, 5*time.Second); err != nil {
			return err
		}
	}

	runtimeStatus, _, err := applianceRuntime()
	if err != nil {
		return err
	}
	if runtimeStatus.Kind != "appliance-image" {
		overridePath := "/etc/systemd/system/incus-startup.service.d/youeye-dependency.conf"
		override, err := os.ReadFile(overridePath)
		if err != nil {
			return fmt.Errorf("read Incus dependency: %w", err)
		}
		for _, directive := range []string{"After=youeye.service", "Wants=youeye.service"} {
			if !strings.Contains(string(override), directive) {
				return fmt.Errorf("Incus dependency is missing %s", directive)
			}
		}
	}
	if err := verifyLoadedIncusDependency(); err != nil {
		return err
	}

	fmt.Println("✓ All deployment completion invariants verified")
	return nil
}
