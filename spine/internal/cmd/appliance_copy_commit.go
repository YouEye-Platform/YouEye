package cmd

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/util"
)

var applianceCopyCommitCommand = &cobra.Command{Use: "commit", Args: cobra.NoArgs, RunE: withNativeCopyCommand(func(cmd *cobra.Command, args []string) error {
	request, err := readNativeCopyRequest(applianceCopyRequestFile)
	if err != nil {
		return err
	}
	m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	b := systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}
	ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Minute)
	defer cancel()
	runtime, err := installedCoreRuntime()
	if err != nil {
		return err
	}
	hold, holdErr := b.ReadCopy()
	if errors.Is(holdErr, os.ErrNotExist) {
		// A lost final acknowledgement must not re-enter preparation or regenerate
		// authority after release. Require the retained completion and live install.
		receipt, e := m.IndependentCopyReceipt(request)
		if e != nil {
			return e
		}
		if e = b.ReleaseCopy(request, "destination", func() error { return verifyCommittedCopy(ctx, request, receipt) }); e != nil {
			return e
		}
		return emitNativeCopyReceipt(cmd, request, receipt)
	}
	if holdErr != nil || hold.Request != request || hold.Role != "destination" {
		return fmt.Errorf("exact destination copy hold required")
	}
	platform, err := nativeCopyPlatformStep(request, "verify", applianceCopyNamesFile)
	if err != nil {
		return err
	}
	domain, ok := platform["domain"].(string)
	fingerprint, ok2 := platform["certificateFingerprint"].(string)
	if !ok || !ok2 || platform["phase"] != "platform-prepared" {
		return fmt.Errorf("complete platform verification receipt required")
	}
	address := util.GetPrimaryIP()
	if ip := net.ParseIP(address); ip == nil || !ip.IsPrivate() {
		return fmt.Errorf("copy maintenance address unavailable")
	}
	if err = verifyCopyNetwork(ctx, address, domain, fingerprint); err != nil {
		return err
	}
	if err = util.WriteStoredHostIP(address); err != nil {
		return err
	}
	if _, e := m.IndependentCopyReceipt(request); e != nil {
		if err = m.FinalizeIndependentCopyBoot(ctx, request, b, runtime.Checkpoint, copyHardware); err != nil {
			return err
		}
	}
	receipt, err := m.VerifyIndependentCopy(ctx, request, func(ctx context.Context, source systemupdate.CoreReceipt, request systemupdate.CoreCopyRequest) (systemupdate.CoreMachineIdentity, string, error) {
		fail := func(e error) (systemupdate.CoreMachineIdentity, string, error) {
			return systemupdate.CoreMachineIdentity{}, "", e
		}
		_, manifest, e := applianceRuntime()
		if e != nil || manifest == nil {
			return fail(fmt.Errorf("immutable installed host unavailable"))
		}
		partitions, e := appliance.DiscoverPartitions()
		if e != nil {
			return fail(e)
		}
		hardware, e := copyHardware()
		if e != nil {
			return fail(e)
		}
		machine, e := m.VerifyIndependentCopyIdentity(request, appliance.StatePath, appliance.DataSchemaPath, systemupdate.CopyDiskObservation{Hardware: hardware, Manifest: *manifest, Partitions: partitions})
		if e != nil {
			return fail(e)
		}
		if _, e = m.VerifyIndependentCopyHost(request, "/", copyHardware); e != nil {
			return fail(e)
		}
		if e = m.VerifyIndependentCopyAuthority(ctx, request, runtime.Checkpoint); e != nil {
			return fail(e)
		}
		expected := source
		expected.Machine = machine
		if e = runtime.Services.VerifyInstalled(ctx, expected, verifyCopySignedHost); e != nil {
			return fail(e)
		}
		if e = verifyDeploymentCompletion(address); e != nil {
			return fail(e)
		}
		if health := collectApplianceHealth("operational"); health.ExitCode != healthExitHealthy {
			return fail(fmt.Errorf("copy operational health failed"))
		}
		if e = waitForPiholeHealthy(30 * time.Second); e != nil {
			return fail(fmt.Errorf("copy DNS service credential failed"))
		}
		return machine, "independent host/boot/SSH identity; digest-bound host, Spine, CP and UI bytes; paired persistent data; loaded platform credentials; live independent signing/TLS/app authority and local DNS; operational health", nil
	})
	if err != nil {
		return err
	}
	if err = b.ReleaseCopy(request, "destination", func() error { return verifyCommittedCopy(ctx, request, receipt) }); err != nil {
		return err
	}
	return emitNativeCopyReceipt(cmd, request, receipt)
})}

func verifyCopySignedHost(ctx context.Context, receipt systemupdate.CoreReceipt) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, manifest, err := applianceRuntime()
	if err != nil || manifest == nil {
		return fmt.Errorf("immutable copy host unavailable")
	}
	if err = systemupdate.BindCoreImage(receipt.Release, *manifest); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if err := verifyRunningSpine(executable); err != nil {
		return fmt.Errorf("copy Spine: %w", err)
	}
	return nil
}
func verifyCommittedCopy(ctx context.Context, request systemupdate.CoreCopyRequest, receipt systemupdate.CoreReceipt) error {
	m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	if _, err := m.VerifyIndependentCopyHost(request, "/", copyHardware); err != nil {
		return err
	}
	if observation := (coreAPIOperations{}).ObserveInstalled(ctx, receipt); observation.State != "verified" {
		return fmt.Errorf("committed copy installed observation failed")
	}
	return nil
}
func emitNativeCopyReceipt(cmd *cobra.Command, request systemupdate.CoreCopyRequest, receipt systemupdate.CoreReceipt) error {
	return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"schema": "youeye.independent-copy.v1", "request": request, "receipt": receipt, "state": "committed", "native_ready": true, "provider_network_release_required": true})
}
func verifyCopyNetwork(ctx context.Context, address, domain, fingerprint string) error {
	if len(domain) > 253 || strings.ContainsAny(domain, "/: ") || !strings.Contains(domain, ".") || len(fingerprint) != 64 {
		return fmt.Errorf("invalid independent domain receipt")
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	resolver := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, net.JoinHostPort(address, "53"))
	}}
	addresses, err := resolver.LookupHost(ctx, domain)
	if err != nil {
		return fmt.Errorf("independent local DNS unavailable")
	}
	found := false
	for _, a := range addresses {
		if a == address {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("independent local DNS points elsewhere")
	}
	connection, err := tls.DialWithDialer(dialer, "tcp", net.JoinHostPort(address, "443"), &tls.Config{ServerName: domain, MinVersion: tls.VersionTLS12})
	if err != nil {
		return fmt.Errorf("independent served TLS verification failed")
	}
	defer connection.Close()
	certificates := connection.ConnectionState().PeerCertificates
	if len(certificates) == 0 || fmt.Sprintf("%x", sha256.Sum256(certificates[0].Raw)) != fingerprint {
		return fmt.Errorf("served certificate differs from destination Names bundle")
	}
	return nil
}
func init() {
	applianceCopyCommitCommand.Flags().StringVar(&applianceCopyRequestFile, "request-file", "", "protected exact native copy request")
	applianceCopyCommitCommand.Flags().StringVar(&applianceCopyNamesFile, "names-bundle-file", "", "protected destination Names bundle")
	_ = applianceCopyCommitCommand.MarkFlagRequired("request-file")
	_ = applianceCopyCommitCommand.MarkFlagRequired("names-bundle-file")
	applianceCopyCommand.AddCommand(applianceCopyCommitCommand)
}
