package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

// backupSetsRoot holds the completed local sets; a test moves it into a temporary tree.
var backupSetsRoot = "/var/lib/youeye/backups/sets"

var repositoryBackupID = regexp.MustCompile(`^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$`)
var repositorySourceTree = regexp.MustCompile(`^[0-9a-f]{40}$`)

type RecoveryPoint struct {
	BackupID   string                `json:"backup_id"`
	CreatedAt  string                `json:"created_at"`
	Apps       []string              `json:"apps"`
	SizeBytes  int64                 `json:"size_bytes,omitempty"`
	Reason     string                `json:"reason,omitempty"`
	VerifiedAt string                `json:"verified_at,omitempty"`
	Source     *BackupSourceIdentity `json:"source,omitempty"`
}

// BackupSourceIdentity says what made a backup. The Control Panel writes it
// and judges it on restore (control-panel/src/lib/backup/compatibility.ts);
// Spine checks its form and keeps it with the recovery point.
//
// From 0.6.12 the installed releases are recorded by their ordering key and
// git tree: Release (YouEye), ControlPanel and UI (the YouEye release, with
// each part's own tree) and Pointer (its product release). The three
// *_version fields are the older form (build names); they are still written
// next to the keys until the Release cleanup, for a Control Panel that orders
// backups by them, and are all an older backup has.
type BackupSourceIdentity struct {
	Schema              string         `json:"schema"`
	RuntimeKind         string         `json:"runtime_kind"`
	ImageVersion        string         `json:"image_version,omitempty"`
	SourceTree          string         `json:"source_tree,omitempty"`
	StateSchemaVersion  int            `json:"state_schema_version,omitempty"`
	DataSchemaVersion   int            `json:"data_schema_version,omitempty"`
	DiskLayoutVersion   int            `json:"disk_layout_version,omitempty"`
	SpineVersion        string         `json:"spine_version"`
	ControlPanelVersion string         `json:"control_panel_version,omitempty"`
	UIVersion           string         `json:"ui_version,omitempty"`
	PointerVersion      string         `json:"pointer_version,omitempty"`
	Release             *BackupRelease `json:"release,omitempty"`
	ControlPanel        *BackupRelease `json:"control_panel,omitempty"`
	UI                  *BackupRelease `json:"ui,omitempty"`
	Pointer             *BackupRelease `json:"pointer,omitempty"`
}

// BackupRelease is a release in a backup's identity: its name (shown), its
// ordering key (the line X.Y.Z, then the build's sequence) and the git tree
// of the software.
type BackupRelease struct {
	Version    string `json:"version"`
	Line       string `json:"line"`
	Sequence   int64  `json:"sequence"`
	SourceTree string `json:"source_tree"`
}

func (r BackupRelease) validate() error {
	key, err := releasecache.KeyOfVersion(r.Line, r.Sequence)
	if err != nil || key.Line != r.Line {
		return fmt.Errorf("invalid backup release key")
	}
	if line, ok := releasecache.LineOfVersion(r.Version); !ok || line != r.Line || len(r.Version) > 128 {
		return fmt.Errorf("invalid backup release version")
	}
	if !repositorySourceTree.MatchString(r.SourceTree) {
		return fmt.Errorf("invalid backup release source tree")
	}
	return nil
}

type recoveryCatalog struct {
	Schema    string          `json:"schema"`
	UpdatedAt string          `json:"updated_at"`
	Backups   []RecoveryPoint `json:"backups"`
}

type RepositoryStoreRequest struct {
	MediaID             string               `json:"media_id"`
	BackupID            string               `json:"backup_id"`
	Passphrase          string               `json:"passphrase"`
	UseStoredPassphrase bool                 `json:"use_stored_passphrase"`
	Apps                []string             `json:"apps"`
	CreatedAt           string               `json:"created_at"`
	SizeBytes           int64                `json:"size_bytes"`
	Reason              string               `json:"reason"`
	Source              BackupSourceIdentity `json:"source"`
}

type RepositoryImportRequest struct {
	MediaID             string `json:"media_id"`
	BackupID            string `json:"backup_id"`
	Passphrase          string `json:"passphrase"`
	UseStoredPassphrase bool   `json:"use_stored_passphrase"`
}

func catalogPath(mountpoint string) string {
	return filepath.Join(mountpoint, "YOUEYE-RECOVERY.json")
}

func readCatalog(mountpoint string) recoveryCatalog {
	catalog := recoveryCatalog{Schema: "youeye.recovery.catalog.v1", Backups: []RecoveryPoint{}}
	raw, err := os.ReadFile(catalogPath(mountpoint))
	if err == nil {
		var parsed recoveryCatalog
		if json.Unmarshal(raw, &parsed) == nil && parsed.Schema == catalog.Schema {
			catalog = parsed
		}
	}
	return catalog
}

func catalogBackupIDs(mountpoint string) []string {
	catalog := readCatalog(mountpoint)
	ids := make([]string, 0, len(catalog.Backups))
	for _, point := range catalog.Backups {
		ids = append(ids, point.BackupID)
	}
	return ids
}

func RecoveryPoints(mediaID string) ([]RecoveryPoint, error) {
	media, err := MountMedia(mediaID)
	if err != nil {
		return nil, err
	}
	return readCatalog(media.Mountpoint).Backups, nil
}

func writeCatalog(mountpoint string, catalog recoveryCatalog) error {
	catalog.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	sort.Slice(catalog.Backups, func(i, j int) bool { return catalog.Backups[i].CreatedAt > catalog.Backups[j].CreatedAt })
	raw, err := json.MarshalIndent(catalog, "", "  ")
	if err != nil {
		return err
	}
	temporary := catalogPath(mountpoint) + fmt.Sprintf(".%d.tmp", os.Getpid())
	if err := os.WriteFile(temporary, append(raw, '\n'), 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, catalogPath(mountpoint)); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

// resticCommand is a restic command that ends with ctx (stepCommand): SIGTERM first, on which restic removes its
// repository lock.
func resticCommand(ctx context.Context, repository, passphrase string, args ...string) *exec.Cmd {
	cmd := stepCommand(ctx, "restic", append([]string{"-r", repository}, args...)...)
	environment := make([]string, 0, len(os.Environ())+1)
	for _, variable := range os.Environ() {
		if !strings.HasPrefix(variable, "RESTIC_PASSWORD=") {
			environment = append(environment, variable)
		}
	}
	cmd.Env = append(environment, "RESTIC_PASSWORD="+passphrase)
	return cmd
}

// unlockRepository removes the locks of restic processes that are gone ("restic unlock" removes only those). A
// restic that was killed (the box lost power, or a store ran into StepCeiling and did not stop on SIGTERM) leaves
// its lock, and restic refuses to check or prune a repository that has one. Only Spine writes the repository, one
// step at a time. Best effort: a lock that stays makes the restic command after it say so.
func unlockRepository(ctx context.Context, repository, passphrase string) {
	_, _ = stepOutput(ctx, resticCommand(ctx, repository, passphrase, "unlock"), false)
}

func ensureRepository(ctx context.Context, repository, passphrase string) error {
	if _, err := os.Stat(filepath.Join(repository, "config")); err == nil {
		unlockRepository(ctx, repository, passphrase)
		return stepEnded(ctx)
	}
	if err := os.MkdirAll(repository, 0700); err != nil {
		return err
	}
	if output, err := stepOutput(ctx, resticCommand(ctx, repository, passphrase, "init"), false); err != nil {
		return fmt.Errorf("initialize encrypted repository: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func repositoryBackupIDs(ctx context.Context, repository, passphrase string) (map[string]bool, error) {
	output, err := stepOutput(ctx, resticCommand(ctx, repository, passphrase, "snapshots", "--json", "--tag", "youeye-v1"), true)
	if err != nil {
		return nil, fmt.Errorf("list encrypted recovery points: %w", err)
	}
	var snapshots []struct {
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal(output, &snapshots); err != nil {
		return nil, fmt.Errorf("decode recovery-point inventory: %w", err)
	}
	ids := make(map[string]bool)
	for _, snapshot := range snapshots {
		for _, tag := range snapshot.Tags {
			if strings.HasPrefix(tag, "backup-id:") && validBackupID(strings.TrimPrefix(tag, "backup-id:")) {
				ids[strings.TrimPrefix(tag, "backup-id:")] = true
			}
		}
	}
	return ids, nil
}

func validBackupID(id string) bool {
	return repositoryBackupID.MatchString(id)
}

func validateBackupSource(source BackupSourceIdentity) error {
	if source.Schema != "youeye.backup.source.v1" || source.SpineVersion == "" || len(source.SpineVersion) > 128 {
		return fmt.Errorf("invalid backup source identity")
	}
	if source.RuntimeKind != "appliance-image" && source.RuntimeKind != "mutable-host" {
		return fmt.Errorf("invalid backup runtime kind")
	}
	if source.RuntimeKind == "appliance-image" && (source.ImageVersion == "" || source.SourceTree == "" || source.StateSchemaVersion < 1 || source.DataSchemaVersion < 1) {
		return fmt.Errorf("incomplete appliance backup source identity")
	}
	if source.SourceTree != "" && !repositorySourceTree.MatchString(source.SourceTree) {
		return fmt.Errorf("invalid backup source tree")
	}
	for _, value := range []string{source.ImageVersion, source.SourceTree, source.ControlPanelVersion, source.UIVersion, source.PointerVersion} {
		if len(value) > 256 {
			return fmt.Errorf("backup source identity field is too long")
		}
	}
	for _, release := range []*BackupRelease{source.Release, source.ControlPanel, source.UI, source.Pointer} {
		if release == nil {
			continue
		}
		if err := release.validate(); err != nil {
			return err
		}
	}
	return nil
}

// StoreBackupSet writes a completed local set to the drive's repository, checks the repository and lists the set
// in the drive's catalog. restic ends with ctx or at StepCeiling. A restic that is stopped leaves nothing a later
// run trusts: a snapshot exists only once "backup" has ended well, the catalog lists the set only after "check"
// (and, for a scheduled set, the retention) passed, and a stopped "forget --prune" is finished by the next one.
func StoreBackupSet(ctx context.Context, request RepositoryStoreRequest) error {
	if !validBackupID(request.BackupID) {
		return fmt.Errorf("invalid backup identifier")
	}
	if len(request.Passphrase) < 12 {
		return fmt.Errorf("backup passphrase is required")
	}
	if err := validateBackupSource(request.Source); err != nil {
		return err
	}
	source := filepath.Join(backupSetsRoot, request.BackupID)
	if !pathWithin(backupSetsRoot, source) {
		return fmt.Errorf("backup source escaped protected set directory")
	}
	if info, err := os.Stat(source); err != nil || !info.IsDir() {
		return fmt.Errorf("completed backup set was not found")
	}
	// The ceiling starts before the mount, so the drive commands count inside it.
	ctx, cancel := stepContext(ctx)
	defer cancel()
	media, err := MountMedia(request.MediaID)
	if err != nil {
		return err
	}
	repository := filepath.Join(media.Mountpoint, ".youeye", "repository")
	if err := ensureRepository(ctx, repository, request.Passphrase); err != nil {
		return err
	}
	reason := request.Reason
	if reason != "scheduled" {
		reason = "manual"
	}
	cmd := resticCommand(ctx, repository, request.Passphrase, "backup", "--host", "youeye", "--tag", "youeye-v1", "--tag", "backup-id:"+request.BackupID, "--tag", "reason:"+reason, filepath.Base(source))
	cmd.Dir = filepath.Dir(source)
	if output, err := stepOutput(ctx, cmd, false); err != nil {
		return fmt.Errorf("write encrypted recovery point: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := stepOutput(ctx, resticCommand(ctx, repository, request.Passphrase, "check"), false); err != nil {
		return fmt.Errorf("verify encrypted recovery point: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if reason == "scheduled" {
		if output, err := stepOutput(ctx, resticCommand(ctx, repository, request.Passphrase, "forget", "--tag", "reason:scheduled", "--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "6", "--prune"), false); err != nil {
			return fmt.Errorf("apply recovery-point retention: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	catalog := readCatalog(media.Mountpoint)
	if retained, inventoryErr := repositoryBackupIDs(ctx, repository, request.Passphrase); inventoryErr == nil {
		filtered := catalog.Backups[:0]
		for _, existing := range catalog.Backups {
			if retained[existing.BackupID] {
				filtered = append(filtered, existing)
			}
		}
		catalog.Backups = filtered
	}
	verifiedAt := time.Now().UTC().Format(time.RFC3339)
	sourceIdentity := request.Source
	point := RecoveryPoint{
		BackupID: request.BackupID, CreatedAt: request.CreatedAt, Apps: append([]string{}, request.Apps...),
		SizeBytes: request.SizeBytes, Reason: reason, VerifiedAt: verifiedAt, Source: &sourceIdentity,
	}
	replaced := false
	for index := range catalog.Backups {
		if catalog.Backups[index].BackupID == point.BackupID {
			catalog.Backups[index] = point
			replaced = true
		}
	}
	if !replaced {
		catalog.Backups = append(catalog.Backups, point)
	}
	return writeCatalog(media.Mountpoint, catalog)
}

// ImportBackupSet reads a set from the drive's repository into the backup directory. restic ends with ctx or at
// StepCeiling; it restores into a temporary directory that is removed on every way out, and the set gets its
// name only by the rename of a whole restore.
func ImportBackupSet(ctx context.Context, request RepositoryImportRequest) (string, error) {
	if !validBackupID(request.BackupID) || len(request.Passphrase) < 12 {
		return "", fmt.Errorf("valid backup identifier and passphrase are required")
	}
	// The ceiling starts before the mount, so the drive commands count inside it.
	ctx, cancel := stepContext(ctx)
	defer cancel()
	media, err := MountMedia(request.MediaID)
	if err != nil {
		return "", err
	}
	repository := filepath.Join(media.Mountpoint, ".youeye", "repository")
	parent := backupRoot
	temporary, err := os.MkdirTemp(parent, ".importing-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(temporary)
	unlockRepository(ctx, repository, request.Passphrase)
	output, err := stepOutput(ctx, resticCommand(ctx, repository, request.Passphrase, "restore", "latest", "--tag", "backup-id:"+request.BackupID, "--target", temporary), false)
	if err != nil {
		return "", fmt.Errorf("read encrypted recovery point: %w: %s", err, strings.TrimSpace(string(output)))
	}
	restored := filepath.Join(temporary, request.BackupID)
	if info, err := os.Stat(restored); err != nil || !info.IsDir() {
		return "", fmt.Errorf("recovery point did not contain its declared backup set")
	}
	destination := filepath.Join(parent, "import-"+request.BackupID)
	if info, err := os.Stat(destination); err == nil {
		if !info.IsDir() {
			return "", fmt.Errorf("existing recovery import is not a directory")
		}
		raw, readErr := os.ReadFile(filepath.Join(destination, "backup-set.json"))
		var record struct {
			ID string `json:"id"`
		}
		if readErr != nil || json.Unmarshal(raw, &record) != nil || record.ID != request.BackupID {
			return "", fmt.Errorf("existing recovery import does not match the requested backup")
		}
		return destination, nil
	}
	if err := os.Rename(restored, destination); err != nil {
		return "", fmt.Errorf("activate imported recovery point: %w", err)
	}
	return destination, nil
}
