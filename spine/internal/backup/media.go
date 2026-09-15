package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	backupMediaLabel = "YOUEYE-BACKUP"
	backupMountRoot  = "/var/lib/youeye/backups/media"
)

// Media describes one non-system disk that can hold a YouEye repository.
// Device paths are informational only; effectful requests are rebound to ID.
type Media struct {
	ID         string   `json:"id"`
	Device     string   `json:"device"`
	Model      string   `json:"model,omitempty"`
	Serial     string   `json:"-"`
	SizeBytes  uint64   `json:"size_bytes"`
	State      string   `json:"state"` // blank, available, ready, unsupported
	Filesystem string   `json:"filesystem,omitempty"`
	Mountpoint string   `json:"mountpoint,omitempty"`
	Reason     string   `json:"reason,omitempty"`
	BackupIDs  []string `json:"backup_ids,omitempty"`
	partition  string
}

type blockDevice struct {
	Name        string        `json:"name"`
	Path        string        `json:"path"`
	Type        string        `json:"type"`
	Size        json.Number   `json:"size"`
	FSType      string        `json:"fstype"`
	Label       string        `json:"label"`
	UUID        string        `json:"uuid"`
	PartUUID    string        `json:"partuuid"`
	Mountpoints []interface{} `json:"mountpoints"`
	ReadOnly    bool          `json:"ro"`
	Serial      string        `json:"serial"`
	WWN         string        `json:"wwn"`
	Model       string        `json:"model"`
	Children    []blockDevice `json:"children"`
}

var runMediaCommand = func(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

func stableMediaID(device blockDevice) string {
	basis := strings.TrimSpace(device.Serial)
	if basis == "" {
		basis = strings.TrimSpace(device.WWN)
	}
	digest := sha256.Sum256([]byte("youeye-backup-media\x00" + basis))
	return "media-" + hex.EncodeToString(digest[:8])
}

func mountpoints(device blockDevice) []string {
	var result []string
	for _, raw := range device.Mountpoints {
		if value, ok := raw.(string); ok && value != "" {
			result = append(result, value)
		}
	}
	return result
}

func isProtectedTree(device blockDevice) bool {
	for _, mount := range mountpoints(device) {
		if mount == "/" || mount == "/boot" || mount == "/boot/efi" || mount == "/var/lib/youeye" || mount == "[SWAP]" || strings.HasPrefix(mount, "/var/lib/incus") {
			return true
		}
	}
	if device.FSType == "zfs_member" || device.FSType == "crypto_LUKS" || device.FSType == "swap" || strings.HasPrefix(device.Label, "YE-") {
		return true
	}
	for _, child := range device.Children {
		if isProtectedTree(child) {
			return true
		}
	}
	return false
}

func backupPartition(device blockDevice) *blockDevice {
	if device.Label == backupMediaLabel {
		copy := device
		return &copy
	}
	for _, child := range device.Children {
		if found := backupPartition(child); found != nil {
			return found
		}
	}
	return nil
}

func parseMedia(raw []byte) ([]Media, error) {
	var document struct {
		Blockdevices []blockDevice `json:"blockdevices"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("decode block inventory: %w", err)
	}
	result := make([]Media, 0)
	for _, disk := range document.Blockdevices {
		if disk.Type != "disk" || disk.ReadOnly {
			continue
		}
		size, _ := disk.Size.Int64()
		if size < 1024*1024*1024 {
			continue
		}
		media := Media{
			ID: stableMediaID(disk), Device: disk.Path, Model: strings.TrimSpace(disk.Model),
			Serial: strings.TrimSpace(disk.Serial), SizeBytes: uint64(size), State: "unsupported",
		}
		if isProtectedTree(disk) {
			continue
		}
		if strings.TrimSpace(disk.Serial) == "" && strings.TrimSpace(disk.WWN) == "" {
			media.Reason = "Drive has no stable hardware identity"
			result = append(result, media)
			continue
		}
		if partition := backupPartition(disk); partition != nil {
			media.partition = partition.Path
			media.Filesystem = partition.FSType
			points := mountpoints(*partition)
			if len(points) > 0 {
				if pathWithin(backupMountRoot, points[0]) {
					media.Mountpoint = points[0]
					media.State = "ready"
				} else {
					media.Reason = "Drive is mounted outside YouEye backup storage"
				}
			} else {
				media.State = "available"
			}
			if partition.FSType != "ext4" {
				media.State = "unsupported"
				media.Reason = "YouEye backup media must use ext4"
			}
		} else if len(disk.Children) == 0 && disk.FSType == "" {
			media.State = "blank"
		} else {
			media.Reason = "Drive contains an existing non-YouEye filesystem"
		}
		result = append(result, media)
	}
	return result, nil
}

// ListMedia returns eligible non-system disks without mounting or changing them.
func ListMedia() ([]Media, error) {
	raw, err := runMediaCommand("lsblk", "--json", "--bytes", "--output", "NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,PARTUUID,MOUNTPOINTS,RO,SERIAL,WWN,MODEL")
	if err != nil {
		return nil, fmt.Errorf("list block devices: %w: %s", err, strings.TrimSpace(string(raw)))
	}
	media, err := parseMedia(raw)
	if err != nil {
		return nil, err
	}
	for index := range media {
		if media[index].Mountpoint != "" {
			media[index].BackupIDs = catalogBackupIDs(media[index].Mountpoint)
		}
	}
	return media, nil
}

func findMedia(id string) (Media, error) {
	media, err := ListMedia()
	if err != nil {
		return Media{}, err
	}
	for _, candidate := range media {
		if candidate.ID == id {
			return candidate, nil
		}
	}
	return Media{}, fmt.Errorf("backup drive is no longer attached")
}

func mediaMountpoint(id string) string {
	return filepath.Join(backupMountRoot, id)
}

// MountMedia revalidates a stable media identity, then mounts only its labelled partition.
func MountMedia(id string) (Media, error) {
	media, err := findMedia(id)
	if err != nil {
		return Media{}, err
	}
	if media.State != "available" && media.State != "ready" {
		return Media{}, fmt.Errorf("drive is not prepared YouEye backup media")
	}
	if media.State == "ready" {
		return media, nil
	}
	if media.partition == "" {
		return Media{}, fmt.Errorf("backup partition disappeared during validation")
	}
	mountpoint := mediaMountpoint(id)
	if err := os.MkdirAll(mountpoint, 0700); err != nil {
		return Media{}, fmt.Errorf("create backup mountpoint: %w", err)
	}
	output, err := runMediaCommand("mount", "-o", "nosuid,nodev,noexec", "--", media.partition, mountpoint)
	if err != nil {
		return Media{}, fmt.Errorf("mount backup drive: %w: %s", err, strings.TrimSpace(string(output)))
	}
	media.State = "ready"
	media.Mountpoint = mountpoint
	media.BackupIDs = catalogBackupIDs(mountpoint)
	return media, nil
}

// UnmountMedia flushes and unmounts only a mountpoint owned by the backup-media root.
func UnmountMedia(id string) error {
	media, err := findMedia(id)
	if err != nil {
		return err
	}
	if media.State != "ready" || !pathWithin(backupMountRoot, media.Mountpoint) {
		return fmt.Errorf("backup drive is not mounted by YouEye")
	}
	_, _ = runMediaCommand("sync")
	output, err := runMediaCommand("umount", "--", media.Mountpoint)
	if err != nil {
		return fmt.Errorf("eject backup drive: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// PrepareMedia destructively formats only a revalidated blank disk. The caller
// must echo the stable identity so a stale UI cannot erase a replacement disk.
func PrepareMedia(id, confirmation string) (Media, error) {
	media, err := findMedia(id)
	if err != nil {
		return Media{}, err
	}
	if media.State != "blank" || confirmation != "ERASE "+media.ID {
		return Media{}, fmt.Errorf("blank drive and exact erase confirmation required")
	}
	commands := [][]string{
		{"wipefs", "--all", "--", media.Device},
		{"sgdisk", "--zap-all", media.Device},
		{"sgdisk", "--new=1:0:0", "--typecode=1:8300", "--change-name=1:" + backupMediaLabel, media.Device},
		{"blockdev", "--rereadpt", media.Device},
		{"udevadm", "settle"},
	}
	for _, command := range commands {
		output, commandErr := runMediaCommand(command[0], command[1:]...)
		if commandErr != nil {
			return Media{}, fmt.Errorf("prepare backup drive: %s: %w: %s", command[0], commandErr, strings.TrimSpace(string(output)))
		}
	}
	refreshed, err := findMedia(id)
	if err != nil {
		return Media{}, err
	}
	partition := refreshed.partition
	if partition == "" {
		// The partition does not carry the filesystem label until mkfs. Resolve the
		// only child path without trusting a guessed sdX/nvme suffix.
		raw, listErr := runMediaCommand("lsblk", "--json", "--tree", "--output", "PATH,TYPE", media.Device)
		if listErr != nil {
			return Media{}, fmt.Errorf("resolve backup partition: %w", listErr)
		}
		var tree struct {
			Blockdevices []blockDevice `json:"blockdevices"`
		}
		if json.Unmarshal(raw, &tree) != nil || len(tree.Blockdevices) != 1 || len(tree.Blockdevices[0].Children) != 1 {
			return Media{}, fmt.Errorf("could not uniquely resolve the new backup partition")
		}
		partition = tree.Blockdevices[0].Children[0].Path
	}
	output, err := runMediaCommand("mkfs.ext4", "-F", "-L", backupMediaLabel, "--", partition)
	if err != nil {
		return Media{}, fmt.Errorf("format backup drive: %w: %s", err, strings.TrimSpace(string(output)))
	}
	_, _ = runMediaCommand("udevadm", "settle")
	return MountMedia(id)
}
