package installer

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type applianceLSBLKReport struct {
	BlockDevices []applianceLSBLKDevice `json:"blockdevices"`
}

type applianceLSBLKDevice struct {
	Name        string                 `json:"name"`
	Path        string                 `json:"path"`
	Type        string                 `json:"type"`
	Size        json.Number            `json:"size"`
	Model       string                 `json:"model"`
	Serial      string                 `json:"serial"`
	Removable   bool                   `json:"rm"`
	ReadOnly    bool                   `json:"ro"`
	Mountpoints []string               `json:"mountpoints"`
	FSType      string                 `json:"fstype"`
	Label       string                 `json:"label"`
	Children    []applianceLSBLKDevice `json:"children"`
}

func discoverApplianceTargetDisk(runner applianceCommandRunner, seed applianceSeed) (applianceDisk, error) {
	targetSerial := strings.TrimSpace(seed.TargetSerial)
	if targetSerial == "" {
		return applianceDisk{}, fmt.Errorf("appliance seed requires target_serial for automatic disk discovery")
	}
	disks, err := discoverApplianceDisks(runner)
	if err != nil {
		return applianceDisk{}, err
	}
	return selectApplianceDiskBySerial(disks, targetSerial, "installation")
}

func discoverApplianceDisks(runner applianceCommandRunner) ([]applianceDisk, error) {
	out, err := runner.Run("lsblk", "--json", "--bytes", "--output", "NAME,PATH,TYPE,SIZE,MODEL,SERIAL,RM,RO,MOUNTPOINTS,FSTYPE,LABEL")
	if err != nil {
		return nil, fmt.Errorf("discover appliance disks: %w", err)
	}
	disks, err := parseApplianceLSBLK(out)
	if err != nil {
		return nil, err
	}
	if len(disks) == 0 {
		return nil, fmt.Errorf("no disk devices were discovered")
	}
	return disks, nil
}

func parseApplianceLSBLK(raw string) ([]applianceDisk, error) {
	var report applianceLSBLKReport
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&report); err != nil {
		return nil, fmt.Errorf("decode lsblk appliance inventory: %w", err)
	}
	var disks []applianceDisk
	for _, node := range report.BlockDevices {
		if strings.TrimSpace(node.Type) != "disk" {
			continue
		}
		if applianceNodeIsInstallerMedia(node) {
			continue
		}
		size, err := node.Size.Int64()
		if err != nil {
			return nil, fmt.Errorf("decode lsblk size for %s: %w", node.Path, err)
		}
		disk := applianceDisk{
			Path:           strings.TrimSpace(node.Path),
			Model:          strings.TrimSpace(node.Model),
			Serial:         strings.TrimSpace(node.Serial),
			SizeBytes:      size,
			Removable:      node.Removable,
			ReadOnly:       node.ReadOnly,
			Mounted:        applianceNodeMounted(node),
			HasHolders:     applianceNodeHasHolders(node),
			InstallerMedia: false,
			Signatures:     applianceNodeSignatures(node),
		}
		disks = append(disks, disk)
	}
	return disks, nil
}

func applianceNodeIsInstallerMedia(node applianceLSBLKDevice) bool {
	for _, mountpoint := range node.Mountpoints {
		mountpoint = strings.TrimSpace(mountpoint)
		if mountpoint == "/run/live/medium" || mountpoint == "/lib/live/mount/medium" {
			return true
		}
	}
	for _, child := range node.Children {
		if applianceNodeIsInstallerMedia(child) {
			return true
		}
	}
	return false
}

func selectApplianceDiskBySerial(disks []applianceDisk, serial, role string) (applianceDisk, error) {
	var matches []applianceDisk
	for _, disk := range disks {
		if strings.EqualFold(strings.TrimSpace(disk.Serial), strings.TrimSpace(serial)) {
			matches = append(matches, disk)
		}
	}
	if len(matches) == 0 {
		return applianceDisk{}, fmt.Errorf("no %s disk with serial %q was found", role, serial)
	}
	if len(matches) > 1 {
		return applianceDisk{}, fmt.Errorf("multiple %s disks with serial %q were found", role, serial)
	}
	return matches[0], nil
}

func applianceNodeMounted(node applianceLSBLKDevice) bool {
	for _, mountpoint := range node.Mountpoints {
		if strings.TrimSpace(mountpoint) != "" {
			return true
		}
	}
	for _, child := range node.Children {
		if applianceNodeMounted(child) {
			return true
		}
	}
	return false
}

func applianceNodeHasHolders(node applianceLSBLKDevice) bool {
	for _, child := range node.Children {
		if child.Type != "" && child.Type != "part" {
			return true
		}
		if applianceNodeHasHolders(child) {
			return true
		}
	}
	return false
}

func applianceNodeSignatures(node applianceLSBLKDevice) []string {
	var signatures []string
	if value := strings.TrimSpace(node.FSType); value != "" {
		signatures = append(signatures, "fstype:"+value)
	}
	if value := strings.TrimSpace(node.Label); value != "" {
		signatures = append(signatures, "label:"+value)
	}
	for _, child := range node.Children {
		if child.Type == "part" {
			label := strings.TrimSpace(child.Label)
			if label == "" {
				label = strings.TrimSpace(child.Name)
			}
			if label == "" {
				label = strconv.Itoa(len(signatures) + 1)
			}
			signatures = append(signatures, "partition:"+label)
		}
		signatures = append(signatures, applianceNodeSignatures(child)...)
	}
	return signatures
}
