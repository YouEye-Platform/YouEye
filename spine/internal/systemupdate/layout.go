package systemupdate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const (
	labelESP      = "YE-ESP"
	labelRecovery = "YE-RECOVERY"
	labelSystemA  = "YE-SYSTEM-A"
	labelSystemB  = "YE-SYSTEM-B"
	labelState    = "YE-STATE"
	labelData     = "YE-DATA"
)

type layoutDevice struct {
	Name        string         `json:"name"`
	Path        string         `json:"path"`
	Type        string         `json:"type"`
	Size        int64          `json:"size"`
	ReadOnly    bool           `json:"ro"`
	Removable   bool           `json:"rm"`
	PartLabel   string         `json:"partlabel"`
	PartUUID    string         `json:"partuuid"`
	ParentName  string         `json:"pkname"`
	Mountpoints []any          `json:"mountpoints"`
	Children    []layoutDevice `json:"children"`
}

type layoutInventory struct {
	BlockDevices []layoutDevice `json:"blockdevices"`
}

type Layout struct {
	ESP            layoutDevice
	Recovery       layoutDevice
	SystemA        layoutDevice
	SystemB        layoutDevice
	State          layoutDevice
	Data           layoutDevice
	Parent         string
	InactiveDevice string
	ActiveDevice   string
	ActiveSlot     string
	InactiveSlot   string
}

func DiscoverLayout(activeSlot string) (Layout, error) {
	out, err := exec.Command("lsblk", "--json", "--bytes", "--output", "NAME,PATH,TYPE,SIZE,RO,RM,PARTLABEL,PARTUUID,PKNAME,MOUNTPOINTS").CombinedOutput()
	if err != nil {
		return Layout{}, fmt.Errorf("inspect system update layout: %w: %s", err, strings.TrimSpace(string(out)))
	}
	layout, err := ParseLayout(out, activeSlot)
	if err != nil {
		return Layout{}, err
	}
	holders, err := filepath.Glob(filepath.Join("/sys/class/block", filepath.Base(layout.InactiveDevice), "holders", "*"))
	if err != nil {
		return Layout{}, fmt.Errorf("inspect inactive System holders: %w", err)
	}
	if len(holders) != 0 {
		return Layout{}, fmt.Errorf("inactive System %s is held by another block device", layout.InactiveSlot)
	}
	return layout, nil
}

func ParseLayout(raw []byte, activeSlot string) (Layout, error) {
	var inventory layoutInventory
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&inventory); err != nil {
		return Layout{}, fmt.Errorf("decode system update layout: %w", err)
	}
	labels := map[string][]layoutDevice{}
	var walk func([]layoutDevice, string, bool, bool)
	walk = func(devices []layoutDevice, parent string, parentRO, parentRM bool) {
		for _, device := range devices {
			if device.ParentName == "" {
				device.ParentName = parent
			}
			device.ReadOnly = device.ReadOnly || parentRO
			device.Removable = device.Removable || parentRM
			if device.PartLabel != "" {
				labels[device.PartLabel] = append(labels[device.PartLabel], device)
			}
			childParent := device.ParentName
			if device.Type == "disk" {
				childParent = device.Name
			}
			walk(device.Children, childParent, device.ReadOnly, device.Removable)
		}
	}
	walk(inventory.BlockDevices, "", false, false)
	one := func(label string) (layoutDevice, error) {
		matches := labels[label]
		if len(matches) != 1 {
			return layoutDevice{}, fmt.Errorf("expected exactly one %s partition, found %d", label, len(matches))
		}
		device := matches[0]
		if device.Type != "part" || strings.TrimSpace(device.Path) == "" || strings.TrimSpace(device.PartUUID) == "" || strings.TrimSpace(device.ParentName) == "" {
			return layoutDevice{}, fmt.Errorf("%s partition identity is incomplete", label)
		}
		if device.ReadOnly || device.Removable {
			return layoutDevice{}, fmt.Errorf("%s is read-only or removable", label)
		}
		return device, nil
	}
	var layout Layout
	for label, destination := range map[string]*layoutDevice{
		labelESP: &layout.ESP, labelRecovery: &layout.Recovery, labelSystemA: &layout.SystemA,
		labelSystemB: &layout.SystemB, labelState: &layout.State, labelData: &layout.Data,
	} {
		device, err := one(label)
		if err != nil {
			return Layout{}, err
		}
		*destination = device
	}
	layout.Parent = layout.ESP.ParentName
	for label, device := range map[string]layoutDevice{
		labelRecovery: layout.Recovery, labelSystemA: layout.SystemA, labelSystemB: layout.SystemB,
		labelState: layout.State, labelData: layout.Data,
	} {
		if device.ParentName != layout.Parent {
			return Layout{}, fmt.Errorf("%s is not on the accepted layout-3 installation drive", label)
		}
	}
	if layout.SystemA.Size != RootSlotBytes || layout.SystemB.Size != RootSlotBytes {
		return Layout{}, fmt.Errorf("System A and B must both be exactly %d bytes", RootSlotBytes)
	}
	switch activeSlot {
	case "A":
		layout.ActiveSlot, layout.InactiveSlot = "A", "B"
		layout.ActiveDevice, layout.InactiveDevice = layout.SystemA.Path, layout.SystemB.Path
	case "B":
		layout.ActiveSlot, layout.InactiveSlot = "B", "A"
		layout.ActiveDevice, layout.InactiveDevice = layout.SystemB.Path, layout.SystemA.Path
	default:
		return Layout{}, fmt.Errorf("active System slot must be A or B, found %q", activeSlot)
	}
	if mounted(layoutDeviceForSlot(layout, layout.InactiveSlot)) {
		return Layout{}, fmt.Errorf("inactive System %s is mounted", layout.InactiveSlot)
	}
	return layout, nil
}

func layoutDeviceForSlot(layout Layout, slot string) layoutDevice {
	if slot == "A" {
		return layout.SystemA
	}
	return layout.SystemB
}

func mounted(device layoutDevice) bool {
	for _, mountpoint := range device.Mountpoints {
		if value, ok := mountpoint.(string); ok && strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

func validateLayoutAgainstState(layout Layout, state appliance.StateRecord) error {
	if !strings.EqualFold(layout.State.PartUUID, state.StatePartUUID) || !strings.EqualFold(layout.Data.PartUUID, state.DataPartUUID) {
		return fmt.Errorf("system update layout does not match the installer-recorded State/Data identity")
	}
	return nil
}
