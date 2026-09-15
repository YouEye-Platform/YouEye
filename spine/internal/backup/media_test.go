package backup

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseMediaExcludesSystemAndClassifiesBlankAndReady(t *testing.T) {
	raw := []byte(`{
  "blockdevices": [
    {"name":"sda","path":"/dev/sda","type":"disk","size":103079215104,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"system","wwn":"","model":"System","children":[
      {"name":"sda1","path":"/dev/sda1","type":"part","size":103000000000,"fstype":"ext4","label":"YE-SYSTEM-A","mountpoints":["/"],"ro":false,"serial":"","wwn":"","model":""}
    ]},
    {"name":"sdb","path":"/dev/sdb","type":"disk","size":53687091200,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"backup-1","wwn":"","model":"Virtual Backup","children":[]},
    {"name":"sdc","path":"/dev/sdc","type":"disk","size":53687091200,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"backup-2","wwn":"","model":"Prepared","children":[
      {"name":"sdc1","path":"/dev/sdc1","type":"part","size":53680000000,"fstype":"ext4","label":"YOUEYE-BACKUP","mountpoints":["/var/lib/youeye/backups/media/media-test"],"ro":false,"serial":"","wwn":"","model":""}
    ]}
  ]
}`)
	media, err := parseMedia(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(media) != 2 {
		t.Fatalf("expected only two eligible non-system drives, got %#v", media)
	}
	if media[0].State != "blank" || media[0].Device != "/dev/sdb" {
		t.Fatalf("blank drive misclassified: %#v", media[0])
	}
	if media[1].State != "ready" || media[1].Filesystem != "ext4" || media[1].partition != "/dev/sdc1" {
		t.Fatalf("prepared drive misclassified: %#v", media[1])
	}
}

func TestRecoveryCatalogIsAtomicAndContainsNoRecoveryKey(t *testing.T) {
	mountpoint := t.TempDir()
	catalog := recoveryCatalog{Schema: "youeye.recovery.catalog.v1", Backups: []RecoveryPoint{{
		BackupID: "backup-20260815T010203Z-deadbeef", CreatedAt: "2026-08-15T01:02:03Z", Apps: []string{"notes"},
	}}}
	if err := writeCatalog(mountpoint, catalog); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(catalogPath(mountpoint))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) == "" || len(catalogBackupIDs(mountpoint)) != 1 {
		t.Fatalf("catalog was not readable: %s", raw)
	}
	if strings.Contains(string(raw), "test-recovery-key") {
		t.Fatal("catalog unexpectedly contained recovery key material")
	}
	entries, err := os.ReadDir(mountpoint)
	if err != nil || len(entries) != 1 {
		t.Fatalf("atomic catalog left temporary files: %#v, %v", entries, err)
	}
}

func TestResticCommandKeepsRecoveryKeyOutOfArguments(t *testing.T) {
	const recoveryKey = "test-only-recovery-key"
	command := resticCommand("/var/lib/youeye/backups/media/test/.youeye/repository", recoveryKey, "check")
	if strings.Contains(strings.Join(command.Args, " "), recoveryKey) {
		t.Fatal("recovery key was included in restic command arguments")
	}
	found := false
	for _, variable := range command.Env {
		if variable == "RESTIC_PASSWORD="+recoveryKey {
			found = true
		}
	}
	if !found {
		t.Fatal("restic command did not receive the recovery key through its environment")
	}
}

func TestParseMediaRefusesExistingFilesystem(t *testing.T) {
	raw := []byte(`{"blockdevices":[{"name":"sdb","path":"/dev/sdb","type":"disk","size":53687091200,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"backup-3","wwn":"","model":"Used","children":[{"name":"sdb1","path":"/dev/sdb1","type":"part","size":53680000000,"fstype":"ext4","label":"DATA","mountpoints":[null],"ro":false,"serial":"","wwn":"","model":""}]}]}`)
	media, err := parseMedia(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(media) != 1 || media[0].State != "unsupported" || media[0].Reason == "" {
		t.Fatalf("used drive must fail closed: %#v", media)
	}
}

func TestStableMediaIDDoesNotExposeSerial(t *testing.T) {
	id := stableMediaID(blockDevice{Serial: "sensitive-hardware-serial", Path: "/dev/sdb"})
	if id == "" || id == "sensitive-hardware-serial" {
		t.Fatalf("unexpected stable media id %q", id)
	}
}

func TestParseMediaRequiresStableHardwareIdentity(t *testing.T) {
	raw := []byte(`{"blockdevices":[{"name":"sdb","path":"/dev/sdb","type":"disk","size":53687091200,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"","wwn":"","model":"Anonymous","children":[]}]}`)
	media, err := parseMedia(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(media) != 1 || media[0].State != "unsupported" || !strings.Contains(media[0].Reason, "stable hardware identity") {
		t.Fatalf("anonymous drive must fail closed: %#v", media)
	}
}

func TestParseMediaExcludesCompressedRAMSwap(t *testing.T) {
	raw := []byte(`{"blockdevices":[{"name":"zram0","path":"/dev/zram0","type":"disk","size":3123183616,"fstype":"swap","label":"zram0","mountpoints":["[SWAP]"],"ro":false,"serial":"","wwn":"","model":"","children":[]}]}`)
	media, err := parseMedia(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(media) != 0 {
		t.Fatalf("memory-backed system swap must not be offered as backup media: %#v", media)
	}
	if media == nil {
		t.Fatal("empty media inventory must serialize as an empty array")
	}
}

func TestPrepareMediaRereadsPartitionsWithApplianceTooling(t *testing.T) {
	previous := runMediaCommand
	defer func() { runMediaCommand = previous }()

	const serial = "test-backup-drive"
	mediaID := stableMediaID(blockDevice{Serial: serial})
	blank := []byte(`{"blockdevices":[{"name":"sdb","path":"/dev/sdb","type":"disk","size":53687091200,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"test-backup-drive","wwn":"","model":"Test","children":[]}]}`)
	partitioned := []byte(`{"blockdevices":[{"name":"sdb","path":"/dev/sdb","type":"disk","size":53687091200,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"test-backup-drive","wwn":"","model":"Test","children":[{"name":"sdb1","path":"/dev/sdb1","type":"part","size":53680000000,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"","wwn":"","model":""}]}]}`)
	partitionTree := []byte(`{"blockdevices":[{"path":"/dev/sdb","type":"disk","children":[{"path":"/dev/sdb1","type":"part"}]}]}`)
	var rereadArgs []string
	var resolveArgs []string
	var inventoryCalls int
	runMediaCommand = func(name string, args ...string) ([]byte, error) {
		if name == "lsblk" {
			if strings.Contains(strings.Join(args, " "), "--bytes") {
				inventoryCalls++
				if inventoryCalls == 1 {
					return blank, nil
				}
				return partitioned, nil
			}
			resolveArgs = append([]string(nil), args...)
			return partitionTree, nil
		}
		if name == "blockdev" {
			rereadArgs = append([]string(nil), args...)
			return nil, nil
		}
		if name == "partprobe" {
			t.Fatal("partprobe is not present in the sealed appliance")
		}
		if name == "mkfs.ext4" {
			if strings.Join(args, " ") != "-F -L YOUEYE-BACKUP -- /dev/sdb1" {
				t.Fatalf("unexpected mkfs arguments: %#v", args)
			}
			return []byte("expected stop"), errors.New("expected stop")
		}
		return nil, nil
	}

	_, err := PrepareMedia(mediaID, "ERASE "+mediaID)
	if err == nil || !strings.Contains(err.Error(), "format backup drive") {
		t.Fatalf("expected the synthetic mkfs stop, got %v", err)
	}
	if strings.Join(rereadArgs, " ") != "--rereadpt /dev/sdb" {
		t.Fatalf("unexpected partition reread arguments: %#v", rereadArgs)
	}
	if strings.Join(resolveArgs, " ") != "--json --tree --output PATH,TYPE /dev/sdb" {
		t.Fatalf("partition resolution must request tree output: %#v", resolveArgs)
	}
}

func TestParseMediaRejectsPreparedDriveMountedOutsideOwnedRoot(t *testing.T) {
	raw := []byte(`{"blockdevices":[{"name":"sdb","path":"/dev/sdb","type":"disk","size":53687091200,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"backup-4","wwn":"","model":"Foreign mount","children":[{"name":"sdb1","path":"/dev/sdb1","type":"part","size":53680000000,"fstype":"ext4","label":"YOUEYE-BACKUP","mountpoints":["/media/foreign"],"ro":false,"serial":"","wwn":"","model":""}]}]}`)
	media, err := parseMedia(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(media) != 1 || media[0].State != "unsupported" || !strings.Contains(media[0].Reason, "outside YouEye") {
		t.Fatalf("foreign mount must fail closed: %#v", media)
	}
}

func TestDataSnapshotSourceUsesHostDatasetSnapshot(t *testing.T) {
	source := dataSnapshotSource("/var/lib/youeye/apps/notes", []zfsDataSnapshot{{
		Dataset: "default/data", Mountpoint: "/var/lib/youeye", Name: "backup-temp-test",
	}})
	want := filepath.Join("/var/lib/youeye", ".zfs", "snapshot", "backup-temp-test", "apps", "notes")
	if source != want {
		t.Fatalf("snapshot source = %q, want %q", source, want)
	}
}
