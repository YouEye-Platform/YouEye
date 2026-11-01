package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	hoststorage "github.com/youeye-platform/YouEye/spine/internal/storage"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// This is one quarantined phase, not copy completion. Infra must retain its
// exact destination/network reservation through reboot and service preparation.
var applianceCopyHostCommand = &cobra.Command{Use: "prepare-host", Args: cobra.NoArgs, RunE: withNativeCopyCommand(func(cmd *cobra.Command, args []string) error {
	request, err := readNativeCopyRequest(applianceCopyRequestFile)
	if err != nil {
		return err
	}
	result, err := prepareNativeCopyHost(cmd.Context(), request)
	if err != nil {
		return err
	}
	return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"schema": "youeye.copy-host-preparation.v1", "request_id": request.RequestID, "host": result, "state": "host-prepared", "quarantine_required": true})
})}

func init() {
	applianceCopyHostCommand.Flags().StringVar(&applianceCopyRequestFile, "request-file", "", "protected exact native copy request")
	_ = applianceCopyHostCommand.MarkFlagRequired("request-file")
	applianceCopyCommand.AddCommand(applianceCopyHostCommand)
}

func prepareNativeCopyHost(ctx context.Context, request systemupdate.CoreCopyRequest) (systemupdate.CopyHostIdentityEvidence, error) {
	var result systemupdate.CopyHostIdentityEvidence
	if err := request.Validate(); err != nil {
		return result, err
	}
	actual, err := copyHardware()
	if err != nil || actual != request.DestinationHardware {
		return result, fmt.Errorf("copy host destination differs from request")
	}
	status, manifest, err := applianceRuntime()
	if err != nil || status.Kind != appliance.RuntimeApplianceImage || manifest == nil {
		return result, fmt.Errorf("copy requires the installed immutable appliance")
	}
	partitions, err := appliance.DiscoverPartitions()
	if err != nil {
		return result, err
	}
	if err = appliance.EnsureStateMounted(partitions); err != nil {
		return result, err
	}
	m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	source, err := m.ReadCopySource(request)
	if err != nil || !source.Quiesced {
		return result, fmt.Errorf("copy requires its retained quiesced source inventory")
	}
	receipt, err := m.ReadReceipt()
	if err != nil || systemupdate.CoreReceiptDigest(receipt) != request.SourceReceiptSHA256 || receipt.ManifestSHA256 != request.ManifestSHA256 || receipt.Machine.StatePartUUID != partitions.StatePartUUID || receipt.Machine.DataPartUUID != partitions.DataPartUUID {
		return result, fmt.Errorf("copied source receipt or persistent partition identity changed")
	}
	_, signed, err := m.Selection(request.ManifestSHA256, systemupdate.CoreDevelopmentTrustPath)
	if err != nil {
		return result, err
	}
	if err = systemupdate.BindCoreImage(signed, *manifest); err != nil {
		return result, err
	}
	executable, err := os.Executable()
	if err != nil {
		return result, err
	}
	digest, err := fileSHA256(executable)
	if err != nil || manifest.ReleaseSet == nil || digest != manifest.ReleaseSet.Spine.ArtifactSHA256 || Version != manifest.ReleaseSet.Spine.Version {
		return result, fmt.Errorf("copy preparation Spine differs from the signed installed member")
	}
	// Import/mount only the full copy's existing datasets. Never use deploy's
	// blank-pool fallback or initialize a missing data-schema record.
	if err = hoststorage.MountIndependentCopyData("/dev/disk/by-partuuid/"+partitions.DataPartUUID, partitions.DataPartUUID, manifest.DiskLayoutVersion, manifest.ZFSFeatureProfile); err != nil {
		return result, err
	}
	b := systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}
	if err = b.BeginCopy(request, "destination", copyHardware); err != nil {
		return result, err
	}
	if err = m.BeginIndependentCopy(request, systemupdate.CoreDevelopmentTrustPath, copyHardware); err != nil {
		return result, err
	}
	// Stop the host's automatic convergence loop before changing inherited
	// service authority; QGA/native CLI continues without the Spine API daemon.
	if err = exec.CommandContext(ctx, "systemctl", "stop", "youeye.service").Run(); err != nil {
		return result, fmt.Errorf("copy host convergence loop requires stop reconciliation")
	}
	runtime, err := installedCoreRuntime()
	if err != nil {
		return result, err
	}
	if err = m.QuiesceCopyDestination(ctx, request, b, runtime.Checkpoint, copyHardware); err != nil {
		return result, err
	}
	if _, err = m.PrepareIndependentCopyIdentity(request, appliance.StatePath, appliance.DataSchemaPath, func() (systemupdate.CopyDiskObservation, error) {
		hardware, e := copyHardware()
		if e != nil {
			return systemupdate.CopyDiskObservation{}, e
		}
		current, e := appliance.DiscoverPartitions()
		return systemupdate.CopyDiskObservation{Hardware: hardware, Manifest: *manifest, Partitions: current}, e
	}); err != nil {
		return result, err
	}
	if err = m.PrepareIndependentCopyRuntimeAuthority(ctx, request, b, runtime.Checkpoint, copyHardware); err != nil {
		return result, err
	}
	if err = m.PrepareIndependentCopyIncus(ctx, request, b, runtime.Checkpoint, copyHardware); err != nil {
		return result, err
	}
	if err = m.PrepareIndependentCopyCaddy(ctx, request, b, runtime.Checkpoint, copyHardware); err != nil {
		return result, err
	}
	return m.PrepareIndependentCopyHost(request, "/", copyHardware)
}
