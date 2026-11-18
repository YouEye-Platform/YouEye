package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// The inventory/reservation commands are native pieces of the copy protocol.
// No capability marker is advertised until preparation and verification are
// implemented together. A source hold is never mistaken for a completed copy.
var applianceCopyRequestFile string
var applianceCopyCommand = &cobra.Command{Use: "independent-copy", Short: "Inspect and reconcile a native independent appliance copy", Hidden: true}
var applianceCopyInventoryCommand = &cobra.Command{Use: "inventory", Args: cobra.NoArgs, RunE: withNativeCopyCommand(func(cmd *cobra.Command, args []string) error {
	inventory, err := inspectNativeCopy(cmd.Context())
	if err != nil {
		return err
	}
	return json.NewEncoder(cmd.OutOrStdout()).Encode(inventory)
})}
var applianceCopyReserveCommand = &cobra.Command{Use: "reserve-source", Args: cobra.NoArgs, RunE: withNativeCopyCommand(func(cmd *cobra.Command, args []string) error {
	request, err := readNativeCopyRequest(applianceCopyRequestFile)
	if err != nil {
		return err
	}
	inventory, err := inspectNativeCopy(cmd.Context())
	if err != nil {
		return err
	}
	if inventory.Hardware != request.SourceHardware || inventory.SourceReceiptSHA256 != request.SourceReceiptSHA256 || inventory.ManifestSHA256 != request.ManifestSHA256 {
		return fmt.Errorf("copy source selection changed")
	}
	manager := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	barrier := systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}
	if err = manager.ReserveIndependentCopySource(request, barrier, copyHardware); err != nil {
		return err
	}
	// Inventory is repeated inside the durable lifecycle reservation. A failure
	// retains that reservation; source release verifies the same machine/receipt.
	after, err := inspectNativeCopy(cmd.Context())
	if err != nil {
		return err
	}
	beforeJSON, _ := json.Marshal(inventory)
	afterJSON, _ := json.Marshal(after)
	if string(beforeJSON) != string(afterJSON) {
		return fmt.Errorf("source inventory changed during copy reservation; reconcile before copying")
	}
	if err = manager.SaveCopySource(request, barrier, after.Resources, after.Platform); err != nil {
		return err
	}
	return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"schema": "youeye.copy-source-reservation.v1", "request": request, "inventory": after})
})}
var applianceCopyReleaseCommand = &cobra.Command{Use: "release-source", Args: cobra.NoArgs, RunE: withNativeCopyCommand(func(cmd *cobra.Command, args []string) error {
	request, err := readNativeCopyRequest(applianceCopyRequestFile)
	if err != nil {
		return err
	}
	barrier := systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}
	err = barrier.ReleaseCopy(request, "source", func() error {
		hardware, err := copyHardware()
		if err != nil || hardware != request.SourceHardware {
			return fmt.Errorf("source hardware changed")
		}
		receipt, err := (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).ReadReceipt()
		if err != nil || systemupdate.CoreReceiptDigest(receipt) != request.SourceReceiptSHA256 {
			return fmt.Errorf("source receipt changed")
		}
		return copySourceReleaseObservation((coreAPIOperations{}).ObserveInstalled(cmd.Context(), receipt))
	})
	if err != nil {
		return err
	}
	return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"schema": "youeye.copy-source-release.v1", "request_id": request.RequestID, "state": "released"})
})}

func copySourceRuntimeCommand(name string, restore bool) *cobra.Command {
	return &cobra.Command{Use: name, Args: cobra.NoArgs, RunE: withNativeCopyCommand(func(cmd *cobra.Command, args []string) error {
		request, err := readNativeCopyRequest(applianceCopyRequestFile)
		if err != nil {
			return err
		}
		runtime, err := installedCoreRuntime()
		if err != nil {
			return err
		}
		manager := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
		if err = manager.SetCopySourceRuntime(cmd.Context(), request, systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}, runtime.Checkpoint, restore, copyHardware); err != nil {
			return err
		}
		source, err := manager.ReadCopySource(request)
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"schema": "youeye.copy-source-runtime.v1", "request_id": request.RequestID, "quiesced": source.Quiesced})
	})}
}
func init() {
	quiesce, restore := copySourceRuntimeCommand("quiesce-source", false), copySourceRuntimeCommand("restore-source", true)
	for _, command := range []*cobra.Command{applianceCopyReserveCommand, applianceCopyReleaseCommand, quiesce, restore} {
		command.Flags().StringVar(&applianceCopyRequestFile, "request-file", "", "protected exact native copy request")
		_ = command.MarkFlagRequired("request-file")
	}
	applianceCopyCommand.AddCommand(applianceCopyInventoryCommand, applianceCopyReserveCommand, applianceCopyReleaseCommand, quiesce, restore)
	applianceCommand.AddCommand(applianceCopyCommand)
}

// copySourceReleaseObservation decides whether the source's hold may be
// released. Releasing ends the copy on the source; refusing would leave that
// box closed to app and System work, updates included. The source was held to
// its shipped files when it was reserved, so a file that differs now is
// reported (`youeye update core observe`), not held against the release. An
// installation that cannot be observed at all keeps the hold.
func copySourceReleaseObservation(observation systemupdate.CoreInstalledObservation) error {
	if observation.State != "verified" && observation.State != "modified" {
		return fmt.Errorf("source installed health is not verified")
	}
	return nil
}

// copyInstalledObservation refuses a copy of (or onto) an installation whose
// shipped System files are changed or missing, and says so.
func copyInstalledObservation(observation systemupdate.CoreInstalledObservation) error {
	switch observation.State {
	case "verified":
		return nil
	case "modified":
		return fmt.Errorf("copy requires unmodified System files, but this installation has changed or missing ones (%s); see `youeye update core observe`", systemupdate.CoreInstalledSummary(observation.Members))
	}
	return fmt.Errorf("copy requires current verified installed System membership")
}

func readNativeCopyRequest(file string) (systemupdate.CoreCopyRequest, error) {
	var request systemupdate.CoreCopyRequest
	if os.Geteuid() != 0 || !filepath.IsAbs(file) {
		return request, fmt.Errorf("root and a protected absolute copy request file required")
	}
	raw, err := systemupdate.ReadCoreState(file, 4096)
	if err != nil {
		return request, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&request); err != nil {
		return request, fmt.Errorf("invalid copy request")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return request, fmt.Errorf("copy request has trailing data")
	}
	return request, request.Validate()
}
func copyHardware() (string, error) {
	raw, err := os.ReadFile("/sys/class/dmi/id/product_uuid")
	if err != nil {
		return "", fmt.Errorf("actual copy hardware unavailable")
	}
	value := "smbios:" + strings.ToLower(strings.TrimSpace(string(raw)))
	// CoreCopyRequest validation is repeated for every mutating command. Inventory
	// still refuses a missing/non-SMBIOS host instead of inventing an identity.
	if !regexp.MustCompile(`^smbios:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).MatchString(value) {
		return "", fmt.Errorf("copy requires SMBIOS hardware")
	}
	return value, nil
}

type nativeCopyInventory struct {
	Schema              string                             `json:"schema"`
	Hardware            string                             `json:"hardware"`
	SourceReceiptSHA256 string                             `json:"source_receipt_sha256"`
	ManifestSHA256      string                             `json:"manifest_sha256"`
	Platform            json.RawMessage                    `json:"platform"`
	Resources           systemupdate.CopyResourceInventory `json:"resources"`
}

func inspectNativeCopy(ctx context.Context) (nativeCopyInventory, error) {
	var out nativeCopyInventory
	if err := systemupdate.InspectIndependentCopyNetwork("/"); err != nil {
		return out, err
	}
	runtime, err := installedCoreRuntime()
	if err != nil {
		return out, err
	}
	hardware, err := copyHardware()
	if err != nil {
		return out, err
	}
	m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	receipt, err := m.ReadReceipt()
	if err != nil {
		return out, err
	}
	// A copy strands nobody, so its source is held to the shipped files: extra
	// files are fine, a changed or missing shipped file refuses the copy.
	observation := (coreAPIOperations{}).ObserveInstalled(ctx, receipt)
	if err := copyInstalledObservation(observation); err != nil {
		return out, err
	}
	if health := collectApplianceHealth("operational"); health.ExitCode != healthExitHealthy {
		return out, fmt.Errorf("copy source operational health failed")
	}
	platform, err := controlapi.NewClient().Get("/api/appliance/independent-copy")
	if err != nil {
		return out, fmt.Errorf("native platform copy inventory unavailable; inspect its supported integration requirements")
	}
	raw, err := json.Marshal(platform)
	if err != nil || len(raw) > 1<<20 {
		return out, fmt.Errorf("invalid platform copy inventory")
	}
	var apps struct {
		Schema string `json:"schema"`
		SHA256 string `json:"sha256"`
		Apps   []struct {
			Containers []string `json:"containers"`
		} `json:"apps"`
	}
	if json.Unmarshal(raw, &apps) != nil || apps.Schema != "youeye.copy-platform-inventory.v1" || len(apps.SHA256) != 64 {
		return out, fmt.Errorf("unsupported native platform copy inventory")
	}
	var containers []string
	for _, app := range apps.Apps {
		containers = append(containers, app.Containers...)
	}
	resources, err := runtime.Checkpoint.InspectCopyResources(ctx, containers)
	if err != nil {
		return out, err
	}
	return nativeCopyInventory{Schema: "youeye.copy-inventory.v1", Hardware: hardware, SourceReceiptSHA256: systemupdate.CoreReceiptDigest(receipt), ManifestSHA256: receipt.ManifestSHA256, Platform: raw, Resources: resources}, nil
}
