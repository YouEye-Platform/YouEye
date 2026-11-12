package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/container"
	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/util"
)

var applianceCopyNamesFile string

func checkNativeCopyServices(ctx context.Context, request systemupdate.CoreCopyRequest) error {
	runtime, err := installedCoreRuntime()
	if err != nil {
		return err
	}
	m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	if _, err = m.VerifyIndependentCopyHost(request, "/", copyHardware); err != nil {
		return err
	}
	return m.CheckIndependentCopyRuntime(ctx, request, systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}, runtime.Checkpoint, copyHardware)
}

var applianceCopyStartCommand = &cobra.Command{Use: "start-core", Args: cobra.NoArgs, RunE: withNativeCopyCommand(func(cmd *cobra.Command, args []string) error {
	request, err := readNativeCopyRequest(applianceCopyRequestFile)
	if err != nil {
		return err
	}
	if err = checkNativeCopyServices(cmd.Context(), request); err != nil {
		return err
	}
	current := util.GetPrimaryIP()
	if ip := net.ParseIP(current); ip == nil || !ip.IsPrivate() {
		return fmt.Errorf("copy requires an observed private maintenance address")
	}
	unlock, err := acquireHostIPMigrationLock()
	if err != nil {
		return err
	}
	defer unlock()
	// The ordinary host convergence loop remains excluded by the copy hold.
	// Use its existing network primitives without invoking source Names work.
	if !piholeProxyDevicesMatch(current) {
		if running, e := isContainerRunning("youeye-pihole"); e != nil {
			return e
		} else if running {
			if err = stopContainer("youeye-pihole", 45*time.Second); err != nil {
				return err
			}
		}
		if err = migratePiholeProxyDevice(current); err != nil {
			return err
		}
	}
	if err = ensureContainerRunning("youeye-pihole", 60*time.Second); err != nil {
		return err
	}
	if err = prepareCopyPihole(cmd.Context()); err != nil {
		return err
	}
	if err = ensureContainerRunning("youeye-postgres", 60*time.Second); err != nil {
		return err
	}
	runtime, err := installedCoreRuntime()
	if err != nil {
		return err
	}
	if err = (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).PrepareIndependentCopyPostgres(cmd.Context(), request, systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}, runtime.Checkpoint, copyHardware); err != nil {
		return err
	}
	for _, name := range []string{"youeye-caddy", "youeye-pointer", "youeye-ui", "youeye-control"} {
		if err = checkNativeCopyServices(cmd.Context(), request); err != nil {
			return err
		}
		if err = ensureContainerRunning(name, 60*time.Second); err != nil {
			return err
		}
	}
	stored, err := util.ReadStoredHostIP()
	if err != nil {
		return err
	}
	if err = migrateControlHostIPEnv(stored, current); err != nil {
		return err
	}
	if err = container.RepairControlPanelPortProxy("youeye-control", 3000); err != nil {
		return err
	}
	if err = container.EnforceUIEgressBlock(); err != nil {
		return err
	}
	// CP's protected Spine calls need the newly prepared host daemon/token.
	// Its automatic convergence still cannot enter this copy reservation.
	if err = enableBakedSpineService(); err != nil {
		return err
	}
	if err = waitForCPHealthy(90 * time.Second); err != nil {
		return err
	}
	return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"schema": "youeye.copy-core-start.v1", "request_id": request.RequestID, "state": "core-started", "quarantine_required": true})
})}

func copyPlatformCommand(step string) *cobra.Command {
	command := &cobra.Command{Use: "prepare-" + step, Args: cobra.NoArgs, RunE: withNativeCopyCommand(func(cmd *cobra.Command, args []string) error {
		request, err := readNativeCopyRequest(applianceCopyRequestFile)
		if err != nil {
			return err
		}
		if err = checkNativeCopyServices(cmd.Context(), request); err != nil {
			return err
		}
		result, err := nativeCopyPlatformStep(request, step, applianceCopyNamesFile)
		if err != nil {
			return err
		}
		// Return only public phase evidence, never the protected bundle or an
		// unexpected response body from a changed platform endpoint.
		return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"schema": "youeye.copy-platform-step.v1", "request_id": request.RequestID, "phase": result["phase"], "quarantine_required": true})
	})}
	command.Flags().StringVar(&applianceCopyNamesFile, "names-bundle-file", "", "protected independent destination Names bundle")
	_ = command.MarkFlagRequired("names-bundle-file")
	return command
}

func init() {
	commands := []*cobra.Command{applianceCopyStartCommand}
	for _, step := range []string{"identity", "domain", "apps", "verify"} {
		commands = append(commands, copyPlatformCommand(step))
	}
	for _, command := range commands {
		command.Flags().StringVar(&applianceCopyRequestFile, "request-file", "", "protected exact native copy request")
		_ = command.MarkFlagRequired("request-file")
		applianceCopyCommand.AddCommand(command)
	}
}

func nativeCopyPlatformStep(request systemupdate.CoreCopyRequest, step, bundleFile string) (map[string]any, error) {
	source, err := (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).ReadCopySource(request)
	if err != nil {
		return nil, err
	}
	if os.Geteuid() != 0 || !filepath.IsAbs(bundleFile) {
		return nil, fmt.Errorf("protected destination Names bundle required")
	}
	raw, err := systemupdate.ReadCoreState(bundleFile, 1<<20)
	if err != nil || !json.Valid(raw) {
		return nil, fmt.Errorf("destination Names bundle unavailable")
	}
	result, err := controlapi.NewClient().Post("/api/appliance/independent-copy", map[string]any{"request": request, "inventory": source.Platform, "namesBundle": json.RawMessage(raw), "step": step})
	if err != nil {
		return nil, fmt.Errorf("native platform %s phase requires reconciliation; quarantine remains required", step)
	}
	if result["requestId"] != request.RequestID || result["quarantineRequired"] != true {
		return nil, fmt.Errorf("native copy platform returned a different receipt")
	}
	return result, nil
}
