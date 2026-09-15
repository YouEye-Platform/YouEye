package appliance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

const (
	StatePartitionLabel = "YE-STATE"
	DataPartitionLabel  = "YE-DATA"
)

type BlockDevice struct {
	Name        string        `json:"name"`
	Path        string        `json:"path"`
	Type        string        `json:"type"`
	PartLabel   string        `json:"partlabel"`
	PartUUID    string        `json:"partuuid"`
	FSType      string        `json:"fstype"`
	ParentName  string        `json:"pkname"`
	Serial      string        `json:"serial"`
	WWN         string        `json:"wwn"`
	Removable   bool          `json:"rm"`
	Transport   string        `json:"tran"`
	Mountpoints []any         `json:"mountpoints"`
	Children    []BlockDevice `json:"children"`
	ParentID    string        `json:"-"`
}

type DeviceInventory struct {
	BlockDevices []BlockDevice `json:"blockdevices"`
}

type PartitionContract struct {
	StateDevice       string `json:"state_device"`
	StatePartUUID     string `json:"state_partuuid"`
	StateParentDevice string `json:"state_parent_device"`
	StateParentID     string `json:"-"`
	DataDevice        string `json:"data_device"`
	DataPartUUID      string `json:"data_partuuid"`
	DataParentDevice  string `json:"data_parent_device"`
	DataParentID      string `json:"-"`

	// ParentDevice is retained for storage callers that need the YE-DATA
	// parent disk as safety context.
	ParentDevice string `json:"parent_device"`
}

func DiscoverPartitions() (PartitionContract, error) {
	out, err := exec.Command("lsblk", "--json", "--bytes", "--output", "NAME,PATH,TYPE,PARTLABEL,PARTUUID,FSTYPE,PKNAME,SERIAL,WWN,RM,TRAN,MOUNTPOINTS").CombinedOutput()
	if err != nil {
		return PartitionContract{}, fmt.Errorf("inspect appliance partitions: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return ParseAndFindPartitions(out, "")
}

func ParseAndFindPartitions(data []byte, excludedParent string) (PartitionContract, error) {
	var inv DeviceInventory
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&inv); err != nil {
		return PartitionContract{}, fmt.Errorf("decode lsblk inventory: %w", err)
	}
	return FindPartitions(inv.BlockDevices, excludedParent)
}

func FindPartitions(devices []BlockDevice, excludedParent string) (PartitionContract, error) {
	var state, data []BlockDevice
	var walk func([]BlockDevice, string, string, bool)
	walk = func(items []BlockDevice, inheritedParent, inheritedParentID string, inheritedRemovable bool) {
		for _, d := range items {
			parent := strings.TrimSpace(d.ParentName)
			if parent == "" {
				parent = inheritedParent
			}
			d.ParentName = parent
			d.ParentID = inheritedParentID
			d.Removable = d.Removable || inheritedRemovable
			switch strings.TrimSpace(d.PartLabel) {
			case StatePartitionLabel:
				state = append(state, d)
			case DataPartitionLabel:
				data = append(data, d)
			}
			childParent := parent
			childParentID := inheritedParentID
			if d.Type == "disk" {
				childParent = d.Name
				childParentID = stableDiskIdentity(d)
			}
			walk(d.Children, childParent, childParentID, d.Removable)
		}
	}
	walk(devices, "", "", false)
	if len(state) != 1 {
		return PartitionContract{}, fmt.Errorf("expected exactly one %s partition, found %d", StatePartitionLabel, len(state))
	}
	if len(data) != 1 {
		return PartitionContract{}, fmt.Errorf("expected exactly one %s partition, found %d", DataPartitionLabel, len(data))
	}
	s, d := state[0], data[0]
	if s.Type != "part" || d.Type != "part" {
		return PartitionContract{}, fmt.Errorf("appliance labels must identify partitions")
	}
	if strings.TrimSpace(s.PartUUID) == "" || strings.TrimSpace(d.PartUUID) == "" {
		return PartitionContract{}, fmt.Errorf("appliance partitions must have PARTUUID values")
	}
	if strings.EqualFold(strings.TrimSpace(s.PartUUID), strings.TrimSpace(d.PartUUID)) {
		return PartitionContract{}, fmt.Errorf("%s and %s must have distinct PARTUUID values", StatePartitionLabel, DataPartitionLabel)
	}
	if !strings.EqualFold(strings.TrimSpace(s.FSType), "ext4") {
		return PartitionContract{}, fmt.Errorf("%s must use ext4 (found %q)", StatePartitionLabel, s.FSType)
	}
	dataType := strings.ToLower(strings.TrimSpace(d.FSType))
	if dataType != "" && dataType != "zfs_member" {
		return PartitionContract{}, fmt.Errorf("%s contains unsupported filesystem signature %q; boot recovery", DataPartitionLabel, d.FSType)
	}
	if s.ParentName == "" || d.ParentName == "" {
		return PartitionContract{}, fmt.Errorf("appliance partitions must have parent disk identities")
	}
	if !sameDeviceName(s.ParentName, d.ParentName) {
		return PartitionContract{}, fmt.Errorf("%s and %s must be distinct partitions on the same installation drive", StatePartitionLabel, DataPartitionLabel)
	}
	if s.Removable || d.Removable {
		return PartitionContract{}, fmt.Errorf("appliance partitions cannot be selected from removable media")
	}
	if excludedParent != "" && sameDeviceName(s.ParentName, excludedParent) {
		return PartitionContract{}, fmt.Errorf("refusing appliance persistence on the active boot or recovery source %s", excludedParent)
	}
	stateParent := "/dev/" + strings.TrimPrefix(s.ParentName, "/dev/")
	dataParent := "/dev/" + strings.TrimPrefix(d.ParentName, "/dev/")
	stateParentID := strings.TrimSpace(s.ParentID)
	dataParentID := strings.TrimSpace(d.ParentID)
	if stateParentID == "" && dataParentID == "" {
		stateParentID = "partuuid-pair:" + strings.ToLower(strings.TrimSpace(s.PartUUID)) + ":" + strings.ToLower(strings.TrimSpace(d.PartUUID))
		dataParentID = stateParentID
	}
	if stateParentID == "" || dataParentID == "" || stateParentID != dataParentID {
		return PartitionContract{}, fmt.Errorf("%s and %s must resolve to one stable parent identity", StatePartitionLabel, DataPartitionLabel)
	}
	return PartitionContract{
		StateDevice: s.Path, StatePartUUID: s.PartUUID, StateParentDevice: stateParent, StateParentID: stateParentID,
		DataDevice: d.Path, DataPartUUID: d.PartUUID, DataParentDevice: dataParent, DataParentID: dataParentID,
		ParentDevice: stateParent,
	}, nil
}

func stableDiskIdentity(device BlockDevice) string {
	if wwn := strings.ToLower(strings.TrimSpace(device.WWN)); wwn != "" {
		return "wwn:" + wwn
	}
	if serial := strings.ToLower(strings.TrimSpace(device.Serial)); serial != "" {
		return "serial:" + serial
	}
	return ""
}

func sameDeviceName(a, b string) bool {
	return strings.TrimPrefix(strings.TrimSpace(a), "/dev/") == strings.TrimPrefix(strings.TrimSpace(b), "/dev/")
}
