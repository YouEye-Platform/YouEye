package installer

import (
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

const (
	applianceMiB = int64(1024 * 1024)
	applianceGiB = int64(1024) * applianceMiB

	applianceESPBytes         = 1 * applianceGiB
	applianceRecoveryBytes    = 4 * applianceGiB
	applianceStateBytes       = 4 * applianceGiB
	applianceRootSlotBytes    = 8 * applianceGiB
	applianceTargetMinBytes   = 32 * applianceGiB
	applianceRecommendedBytes = 128 * applianceGiB
)

type applianceDisk struct {
	Path           string
	Model          string
	Serial         string
	SizeBytes      int64
	Removable      bool
	ReadOnly       bool
	Mounted        bool
	HasHolders     bool
	InstallerMedia bool
	Signatures     []string
}

type applianceArtifactSet struct {
	RootPayloadBytes int64
	ManifestSHA256   string
	Verified         bool
	Compatible       bool
	AllowNonBlank    bool
}

type appliancePartition struct {
	Name      string
	Label     string
	Role      string
	SizeBytes int64
}

type applianceInstallPlan struct {
	TargetDiskPath string
	TargetSerial   string
	RootSlotBytes  int64
	TotalBytes     int64
	DataBytes      int64
	Partitions     []appliancePartition
}

func planApplianceInstall(targetDisk applianceDisk, artifacts applianceArtifactSet) (applianceInstallPlan, error) {
	if err := validateApplianceArtifacts(artifacts); err != nil {
		return applianceInstallPlan{}, err
	}
	if err := validateApplianceTargetDisk("installation drive", targetDisk, artifacts.AllowNonBlank); err != nil {
		return applianceInstallPlan{}, err
	}
	rootSlotBytes, err := applianceRootSlotSize(artifacts.RootPayloadBytes)
	if err != nil {
		return applianceInstallPlan{}, err
	}
	fixedBytes := applianceESPBytes + applianceRecoveryBytes + rootSlotBytes + rootSlotBytes + applianceStateBytes
	if targetDisk.SizeBytes < applianceTargetMinBytes {
		return applianceInstallPlan{}, fmt.Errorf("installation drive is too small: need at least %s, found %s", formatBytes(applianceTargetMinBytes), formatBytes(targetDisk.SizeBytes))
	}
	plan := applianceInstallPlan{
		TargetDiskPath: targetDisk.Path,
		TargetSerial:   targetDisk.Serial,
		RootSlotBytes:  rootSlotBytes,
		TotalBytes:     targetDisk.SizeBytes,
		DataBytes:      targetDisk.SizeBytes - fixedBytes,
		Partitions: []appliancePartition{
			{Name: "ESP", Label: "YE-ESP", Role: "uefi-system", SizeBytes: applianceESPBytes},
			{Name: "Recovery", Label: "YE-RECOVERY", Role: "internal-recovery", SizeBytes: applianceRecoveryBytes},
			{Name: "System A", Label: "YE-SYSTEM-A", Role: "current-root", SizeBytes: rootSlotBytes},
			{Name: "System B", Label: "YE-SYSTEM-B", Role: "inactive-root", SizeBytes: rootSlotBytes},
			{Name: "State", Label: "YE-STATE", Role: "persistent-state", SizeBytes: applianceStateBytes},
			{Name: "Data", Label: "YE-DATA", Role: "persistent-data", SizeBytes: targetDisk.SizeBytes - fixedBytes},
		},
	}
	return plan, nil
}

func validateApplianceArtifacts(artifacts applianceArtifactSet) error {
	if artifacts.RootPayloadBytes <= 0 {
		return fmt.Errorf("appliance root payload size is required")
	}
	if strings.TrimSpace(artifacts.ManifestSHA256) == "" {
		return fmt.Errorf("appliance manifest digest is required")
	}
	if _, err := hex.DecodeString(artifacts.ManifestSHA256); err != nil || len(artifacts.ManifestSHA256) != 64 {
		return fmt.Errorf("appliance manifest digest must be a SHA-256 hex value")
	}
	if !artifacts.Verified {
		return fmt.Errorf("appliance artifact set was not cryptographically verified")
	}
	if !artifacts.Compatible {
		return fmt.Errorf("appliance artifacts are not compatible with this installer")
	}
	return nil
}

func validateApplianceTargetDisk(label string, disk applianceDisk, allowNonBlank bool) error {
	if strings.TrimSpace(disk.Path) == "" {
		return fmt.Errorf("%s path is required", label)
	}
	if disk.SizeBytes <= 0 {
		return fmt.Errorf("%s size is required", label)
	}
	if disk.Removable {
		return fmt.Errorf("%s is removable media", label)
	}
	if disk.ReadOnly {
		return fmt.Errorf("%s is read-only", label)
	}
	if disk.Mounted {
		return fmt.Errorf("%s has mounted filesystems", label)
	}
	if disk.HasHolders {
		return fmt.Errorf("%s has active device holders", label)
	}
	if disk.InstallerMedia {
		return fmt.Errorf("%s is the booted installer media", label)
	}
	if len(nonBlankSignatures(disk.Signatures)) > 0 && !allowNonBlank {
		return fmt.Errorf("%s is not blank", label)
	}
	return nil
}

func applianceRootSlotSize(payloadBytes int64) (int64, error) {
	if payloadBytes <= 0 {
		return 0, fmt.Errorf("appliance root payload size is required")
	}
	if payloadBytes > applianceRootSlotBytes {
		return 0, fmt.Errorf("appliance root payload exceeds fixed %s slot", formatBytes(applianceRootSlotBytes))
	}
	return applianceRootSlotBytes, nil
}

func nonBlankSignatures(values []string) []string {
	var out []string
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}

func formatBytes(value int64) string {
	if value%applianceGiB == 0 {
		return fmt.Sprintf("%d GiB", value/applianceGiB)
	}
	return fmt.Sprintf("%.1f GiB", float64(value)/float64(applianceGiB))
}
