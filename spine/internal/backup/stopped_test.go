package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// tempBackupTree moves the backup roots into a temporary tree.
func tempBackupTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	previousData, previousBackups, previousStaging, previousSets, previousMount := backupDataRoot, backupRoot, backupStagingRoot, backupSetsRoot, backupMountRoot
	backupDataRoot = root
	backupRoot = filepath.Join(root, "backups")
	backupStagingRoot = filepath.Join(backupRoot, ".staging")
	backupSetsRoot = filepath.Join(backupRoot, "sets")
	backupMountRoot = filepath.Join(backupRoot, "media")
	t.Cleanup(func() {
		backupDataRoot, backupRoot, backupStagingRoot, backupSetsRoot, backupMountRoot = previousData, previousBackups, previousStaging, previousSets, previousMount
	})
	for _, directory := range []string{backupStagingRoot, backupSetsRoot, backupMountRoot} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// fakeCommand puts a shell script named name first on PATH and returns a directory it can keep its state in
// (the script reads it as $FAKE_STATE).
func fakeCommand(t *testing.T, name, script string) string {
	t.Helper()
	bin, state := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_STATE", state)
	return state
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s did not appear", path)
}

func loggedLines(t *testing.T, state string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(state, "log"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func indexOfLine(lines []string, wanted string) int {
	for index, line := range lines {
		if line == wanted {
			return index
		}
	}
	return -1
}

// A volume restore whose copy is stopped midway removes the staged copy it was making, and nothing live changes.
func TestApplyVolumesStoppedMidCopyLeavesNoStagedCopy(t *testing.T) {
	root := tempBackupTree(t)
	shortStepTimes(t, time.Hour, 5*time.Second, 5*time.Second)
	// cp has copied part of the tree when the request ends.
	state := fakeCommand(t, "cp", `mkdir -p "$4" && echo half > "$4/partial" && touch "$FAKE_STATE/copying" && exec sleep 600`+"\n")
	staging := filepath.Join(backupStagingRoot, "restore")
	live := filepath.Join(root, "apps", "notes")
	writeTestFile(t, filepath.Join(staging, "volumes", "apps-notes", "data.txt"), "restored")
	writeTestFile(t, filepath.Join(live, "data.txt"), "live")
	if _, err := prepareVolumeMappings(staging, []VolumeMapping{{Source: live, ArchivePath: "volumes/apps-notes"}}); err != nil {
		t.Fatal(err)
	}

	request, hangUp := context.WithCancel(context.Background())
	defer hangUp()
	go func() {
		waitForFile(t, filepath.Join(state, "copying"))
		hangUp()
	}()
	count, err := ApplyVolumes(request, staging)
	if err == nil || count != 0 || !strings.Contains(err.Error(), "the request ended") {
		t.Fatalf("count = %d, error = %v, want a stopped step", count, err)
	}
	entries, err := os.ReadDir(filepath.Dir(live))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "notes" {
		names := []string{}
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("beside the live path are %v, want only the live path (no .youeye-restore-new-* or -old-*)", names)
	}
	if raw, err := os.ReadFile(filepath.Join(live, "data.txt")); err != nil || string(raw) != "live" {
		t.Fatalf("the live path changed: %q, %v", raw, err)
	}
}

// A copy that ends well replaces the live path and leaves nothing beside it either.
func TestApplyVolumesReplacesTheLivePath(t *testing.T) {
	root := tempBackupTree(t)
	staging := filepath.Join(backupStagingRoot, "restore")
	live := filepath.Join(root, "apps", "notes")
	writeTestFile(t, filepath.Join(staging, "volumes", "apps-notes", "data.txt"), "restored")
	writeTestFile(t, filepath.Join(live, "data.txt"), "live")
	if _, err := prepareVolumeMappings(staging, []VolumeMapping{{Source: live, ArchivePath: "volumes/apps-notes"}}); err != nil {
		t.Fatal(err)
	}
	if count, err := ApplyVolumes(context.Background(), staging); err != nil || count != 1 {
		t.Fatalf("count = %d, error = %v", count, err)
	}
	if raw, err := os.ReadFile(filepath.Join(live, "data.txt")); err != nil || string(raw) != "restored" {
		t.Fatalf("the live path holds %q, %v", raw, err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(live)); len(entries) != 1 {
		t.Fatalf("%d entries beside the live path, want 1", len(entries))
	}
}

// fakeRestic logs its subcommand; "snapshots" lists nothing and "restore" makes the set it was asked for.
const fakeRestic = `echo "$3" >> "$FAKE_STATE/log"
case "$3" in
snapshots) echo '[]' ;;
restore)
	for last in "$@"; do :; done
	mkdir -p "$last/$FAKE_SET" && echo '{}' > "$last/$FAKE_SET/backup-set.json" ;;
esac
`

// readyDrive makes MountMedia find one drive that is already mounted, and returns its ID.
func readyDrive(t *testing.T) string {
	t.Helper()
	mediaID := stableMediaID(blockDevice{Serial: "test-backup-drive"})
	mountpoint := mediaMountpoint(mediaID)
	writeTestFile(t, filepath.Join(mountpoint, ".youeye", "repository", "config"), "restic")
	previous := runMediaCommand
	t.Cleanup(func() { runMediaCommand = previous })
	runMediaCommand = func(name string, args ...string) ([]byte, error) {
		if name != "lsblk" {
			t.Errorf("unexpected drive command %s %v", name, args)
		}
		return []byte(`{"blockdevices":[{"name":"sdb","path":"/dev/sdb","type":"disk","size":53687091200,"fstype":"","label":"","mountpoints":[null],"ro":false,"serial":"test-backup-drive","wwn":"","model":"Test","children":[{"name":"sdb1","path":"/dev/sdb1","type":"part","size":53680000000,"fstype":"ext4","label":"YOUEYE-BACKUP","mountpoints":["` + mountpoint + `"],"ro":false,"serial":"","wwn":"","model":""}]}]}`), nil
	}
	return mediaID
}

// A killed restic leaves its repository lock, with which check and prune refuse to run: the locks of processes
// that are gone are removed before a store and before an import.
func TestRepositoryIsUnlockedBeforeStoreAndImport(t *testing.T) {
	const backupID = "backup-20261121T010203Z-0000aaaa"
	tempBackupTree(t)
	state := fakeCommand(t, "restic", fakeRestic)
	t.Setenv("FAKE_SET", backupID)
	mediaID := readyDrive(t)
	writeTestFile(t, filepath.Join(backupSetsRoot, backupID, "backup-set.json"), "{}")

	err := StoreBackupSet(context.Background(), RepositoryStoreRequest{
		MediaID: mediaID, BackupID: backupID, Passphrase: "a recovery key of length", Reason: "scheduled",
		Source: BackupSourceIdentity{Schema: "youeye.backup.source.v1", RuntimeKind: "mutable-host", SpineVersion: "0.6.15"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(loggedLines(t, state), " "); got != "unlock backup check forget snapshots" {
		t.Fatalf("a store ran restic %q, want unlock first", got)
	}
	if ids := catalogBackupIDs(mediaMountpoint(mediaID)); len(ids) != 1 || ids[0] != backupID {
		t.Fatalf("the drive's catalog lists %v", ids)
	}

	if err := os.Remove(filepath.Join(state, "log")); err != nil {
		t.Fatal(err)
	}
	destination, err := ImportBackupSet(context.Background(), RepositoryImportRequest{MediaID: mediaID, BackupID: backupID, Passphrase: "a recovery key of length"})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(loggedLines(t, state), " "); got != "unlock restore" {
		t.Fatalf("an import ran restic %q, want unlock first", got)
	}
	if destination != filepath.Join(backupRoot, "import-"+backupID) {
		t.Fatalf("imported to %s", destination)
	}
	if left, _ := filepath.Glob(filepath.Join(backupRoot, ".importing-*")); len(left) != 0 {
		t.Fatalf("the import left %v", left)
	}
}

// fakeIncus keeps volumes and instances as files in $FAKE_STATE and logs every call. A rename and an instance
// import do their work in "incusd" and then hang, like a client whose incusd answers late.
const fakeIncus = `echo "$*" >> "$FAKE_STATE/log"
case "$1 $2 $3" in
"storage show "*) exit 0 ;;
"storage volume list") cat "$FAKE_STATE/volumes.json"; exit 0 ;;
"storage volume show") [ -e "$FAKE_STATE/volume-$5" ] && exit 0; echo "Error: Storage volume not found" >&2; exit 1 ;;
"storage volume import") touch "$FAKE_STATE/volume-$6"; exit 0 ;;
"storage volume rename")
	mv "$FAKE_STATE/volume-$5" "$FAKE_STATE/volume-$6"
	[ -e "$FAKE_STATE/hang" ] || exit 0
	touch "$FAKE_STATE/hanging"; exec sleep 600 ;;
"storage volume delete") rm "$FAKE_STATE/volume-$5"; exit $? ;;
esac
case "$1" in
info) [ -e "$FAKE_STATE/instance-$2" ] && exit 0; echo "Error: Instance not found" >&2; exit 1 ;;
network) exit 0 ;;
import)
	[ -e "$FAKE_STATE/late" ] || touch "$FAKE_STATE/instance-$3"
	[ -e "$FAKE_STATE/hang" ] || exit 0
	touch "$FAKE_STATE/hanging"; exec sleep 600 ;;
delete) rm "$FAKE_STATE/instance-$3"; exit $? ;;
esac
exit 1
`

// incusRecoveryStaging writes a restore's Incus recovery document with one custom volume.
func incusRecoveryStaging(t *testing.T) string {
	t.Helper()
	staging := filepath.Join(backupStagingRoot, "restore")
	writeTestFile(t, filepath.Join(staging, "incus", "volumes", "default", "app-data.tar.gz"), "archive")
	writeTestFile(t, filepath.Join(staging, "incus", "recovery.json"),
		`{"schema":"youeye.backup.incus.v1","runtimes":[],"volumes":[{"pool":"default","name":"app-data","file":"incus/volumes/default/app-data.tar.gz"}]}`)
	return staging
}

func stateHas(state, name string) bool {
	_, err := os.Stat(filepath.Join(state, name))
	return err == nil
}

// A restore that was stopped during a volume import can leave its one-use volume: the next restore deletes it,
// and nothing else.
func TestPrepareIncusRecoveryDeletesLeftoverRestoreVolumes(t *testing.T) {
	tempBackupTree(t)
	state := fakeCommand(t, "incus", fakeIncus)
	staging := incusRecoveryStaging(t)
	const leftover = "ye-restore-0123456789abcdef"
	for _, volume := range []string{leftover, "other-app", "ye-restore-notes"} {
		writeTestFile(t, filepath.Join(state, "volume-"+volume), "")
	}
	writeTestFile(t, filepath.Join(state, "volumes.json"), `[
		{"name":"`+leftover+`","type":"custom"},
		{"name":"other-app","type":"custom"},
		{"name":"ye-restore-notes","type":"custom"},
		{"name":"ye-restore-aaaaaaaaaaaaaaaa","type":"container"}]`)

	result, err := PrepareIncusRecovery(context.Background(), IncusPrepareRequest{StagingDir: staging})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Volumes) != 1 || !result.Volumes[0].Created || !stateHas(state, "volume-app-data") {
		t.Fatalf("the volume was not restored: %#v", result.Volumes)
	}
	if stateHas(state, "volume-"+leftover) || !stateHas(state, "volume-other-app") || !stateHas(state, "volume-ye-restore-notes") {
		t.Fatal("exactly the leftover one-use volume must be deleted")
	}
	lines := loggedLines(t, state)
	swept := indexOfLine(lines, "storage volume delete default "+leftover)
	if swept < 0 || swept > indexOfLine(lines, "storage volume show default app-data") {
		t.Fatalf("the leftover volume must be deleted before the restore's own work: %v", lines)
	}
	for _, line := range lines {
		if strings.HasPrefix(line, "storage volume delete") && line != "storage volume delete default "+leftover {
			t.Fatalf("unexpected delete: %s", line)
		}
	}
}

// Stopping the incus client does not stop incusd: a rename that was stopped may have ended there. The volume
// then has its final name, the caller got an error and knows of no volume, so it is deleted here.
func TestPrepareIncusRecoveryDeletesAVolumeWhoseStoppedRenameEnded(t *testing.T) {
	tempBackupTree(t)
	shortStepTimes(t, time.Hour, 5*time.Second, 5*time.Second)
	state := fakeCommand(t, "incus", fakeIncus)
	staging := incusRecoveryStaging(t)
	writeTestFile(t, filepath.Join(state, "volumes.json"), `[]`)
	writeTestFile(t, filepath.Join(state, "hang"), "")

	request, hangUp := context.WithCancel(context.Background())
	defer hangUp()
	go func() {
		waitForFile(t, filepath.Join(state, "hanging"))
		hangUp()
	}()
	result, err := PrepareIncusRecovery(request, IncusPrepareRequest{StagingDir: staging})
	if err == nil || result != nil || !strings.Contains(err.Error(), "the request ended") {
		t.Fatalf("result = %#v, error = %v, want a stopped step", result, err)
	}
	if left, _ := filepath.Glob(filepath.Join(state, "volume-*")); len(left) != 0 {
		t.Fatalf("the stopped step left %v", left)
	}
	if indexOfLine(loggedLines(t, state), "storage volume delete default app-data") < 0 {
		t.Fatalf("the renamed volume was not deleted: %v", loggedLines(t, state))
	}
}

func importRequest(t *testing.T) IncusInstanceImportRequest {
	t.Helper()
	archive := filepath.Join(backupStagingRoot, "restore", "app-search.tar.gz")
	writeTestFile(t, archive, "archive")
	return IncusInstanceImportRequest{ArchivePath: archive, Name: "app-search", Pool: "default", Network: "yeapp1"}
}

// An instance import that was stopped may still have ended in incusd. The caller got an error, so an instance
// that is there now, and was not before, is deleted.
func TestImportIncusInstanceDeletesAnInstanceItsStoppedImportLeft(t *testing.T) {
	tempBackupTree(t)
	shortStepTimes(t, time.Hour, 5*time.Second, 5*time.Second)
	state := fakeCommand(t, "incus", fakeIncus)
	writeTestFile(t, filepath.Join(state, "hang"), "")

	request, hangUp := context.WithCancel(context.Background())
	defer hangUp()
	go func() {
		waitForFile(t, filepath.Join(state, "hanging"))
		hangUp()
	}()
	err := ImportIncusInstance(request, importRequest(t))
	if err == nil || !strings.Contains(err.Error(), "the request ended") {
		t.Fatalf("error = %v, want a stopped step", err)
	}
	if stateHas(state, "instance-app-search") {
		t.Fatal("the instance of a stopped import was left")
	}
	lines := loggedLines(t, state)
	if lines[len(lines)-1] != "delete -f app-search" || lines[len(lines)-2] != "info app-search" {
		t.Fatalf("after the stop ran %v, want a look and the delete", lines)
	}
}

// An instance that was there before is refused and never deleted, and a stopped import that left nothing deletes
// nothing.
func TestImportIncusInstanceNeverDeletesWhatItDidNotMake(t *testing.T) {
	tempBackupTree(t)
	shortStepTimes(t, time.Hour, 5*time.Second, 5*time.Second)
	state := fakeCommand(t, "incus", fakeIncus)
	writeTestFile(t, filepath.Join(state, "instance-app-search"), "")
	err := ImportIncusInstance(context.Background(), importRequest(t))
	if err == nil || !strings.Contains(err.Error(), "already exists") || !stateHas(state, "instance-app-search") {
		t.Fatalf("error = %v; an instance that was there must be refused and kept", err)
	}

	if err := os.Remove(filepath.Join(state, "instance-app-search")); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(state, "hang"), "")
	writeTestFile(t, filepath.Join(state, "late"), "") // incusd has not made the instance when the client stops
	request, hangUp := context.WithCancel(context.Background())
	defer hangUp()
	go func() {
		waitForFile(t, filepath.Join(state, "hanging"))
		hangUp()
	}()
	if err := ImportIncusInstance(request, importRequest(t)); err == nil {
		t.Fatal("a stopped import must be an error")
	}
	for _, line := range loggedLines(t, state) {
		if strings.HasPrefix(line, "delete") {
			t.Fatalf("deleted an instance that was not there: %s", line)
		}
	}
}
