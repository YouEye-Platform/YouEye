package backup

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const backupSetsRoot = "/var/lib/youeye/backups/sets"

var repositoryBackupID = regexp.MustCompile(`^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$`)
var repositorySourceCommit = regexp.MustCompile(`^[0-9a-f]{40}$`)

type RecoveryPoint struct {
	BackupID   string                `json:"backup_id"`
	CreatedAt  string                `json:"created_at"`
	Apps       []string              `json:"apps"`
	SizeBytes  int64                 `json:"size_bytes,omitempty"`
	Reason     string                `json:"reason,omitempty"`
	VerifiedAt string                `json:"verified_at,omitempty"`
	Source     *BackupSourceIdentity `json:"source,omitempty"`
}

type BackupSourceIdentity struct {
	Schema              string `json:"schema"`
	RuntimeKind         string `json:"runtime_kind"`
	ImageVersion        string `json:"image_version,omitempty"`
	SourceCommit        string `json:"source_commit,omitempty"`
	ReleaseBranch       string `json:"release_branch,omitempty"`
	StateSchemaVersion  int    `json:"state_schema_version,omitempty"`
	DataSchemaVersion   int    `json:"data_schema_version,omitempty"`
	DiskLayoutVersion   int    `json:"disk_layout_version,omitempty"`
	SpineVersion        string `json:"spine_version"`
	ControlPanelVersion string `json:"control_panel_version,omitempty"`
	UIVersion           string `json:"ui_version,omitempty"`
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

func resticCommand(repository, passphrase string, args ...string) *exec.Cmd {
	cmd := exec.Command("restic", append([]string{"-r", repository}, args...)...)
	environment := make([]string, 0, len(os.Environ())+1)
	for _, variable := range os.Environ() {
		if !strings.HasPrefix(variable, "RESTIC_PASSWORD=") {
			environment = append(environment, variable)
		}
	}
	cmd.Env = append(environment, "RESTIC_PASSWORD="+passphrase)
	return cmd
}

func ensureRepository(repository, passphrase string) error {
	if _, err := os.Stat(filepath.Join(repository, "config")); err == nil {
		return nil
	}
	if err := os.MkdirAll(repository, 0700); err != nil {
		return err
	}
	if output, err := resticCommand(repository, passphrase, "init").CombinedOutput(); err != nil {
		return fmt.Errorf("initialize encrypted repository: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func repositoryBackupIDs(repository, passphrase string) (map[string]bool, error) {
	output, err := resticCommand(repository, passphrase, "snapshots", "--json", "--tag", "youeye-v1").Output()
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
	if source.RuntimeKind == "appliance-image" && (source.ImageVersion == "" || source.SourceCommit == "" || source.StateSchemaVersion < 1 || source.DataSchemaVersion < 1) {
		return fmt.Errorf("incomplete appliance backup source identity")
	}
	if source.SourceCommit != "" && !repositorySourceCommit.MatchString(source.SourceCommit) {
		return fmt.Errorf("invalid backup source commit")
	}
	for _, value := range []string{source.ImageVersion, source.SourceCommit, source.ReleaseBranch, source.ControlPanelVersion, source.UIVersion} {
		if len(value) > 256 {
			return fmt.Errorf("backup source identity field is too long")
		}
	}
	return nil
}

func StoreBackupSet(request RepositoryStoreRequest) error {
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
	media, err := MountMedia(request.MediaID)
	if err != nil {
		return err
	}
	repository := filepath.Join(media.Mountpoint, ".youeye", "repository")
	if err := ensureRepository(repository, request.Passphrase); err != nil {
		return err
	}
	reason := request.Reason
	if reason != "scheduled" {
		reason = "manual"
	}
	cmd := resticCommand(repository, request.Passphrase, "backup", "--host", "youeye", "--tag", "youeye-v1", "--tag", "backup-id:"+request.BackupID, "--tag", "reason:"+reason, filepath.Base(source))
	cmd.Dir = filepath.Dir(source)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("write encrypted recovery point: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := resticCommand(repository, request.Passphrase, "check").CombinedOutput(); err != nil {
		return fmt.Errorf("verify encrypted recovery point: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if reason == "scheduled" {
		if output, err := resticCommand(repository, request.Passphrase, "forget", "--tag", "reason:scheduled", "--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "6", "--prune").CombinedOutput(); err != nil {
			return fmt.Errorf("apply recovery-point retention: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	catalog := readCatalog(media.Mountpoint)
	if retained, inventoryErr := repositoryBackupIDs(repository, request.Passphrase); inventoryErr == nil {
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
		BackupID: request.BackupID, CreatedAt: request.CreatedAt, Apps: append([]string(nil), request.Apps...),
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

func ImportBackupSet(request RepositoryImportRequest) (string, error) {
	if !validBackupID(request.BackupID) || len(request.Passphrase) < 12 {
		return "", fmt.Errorf("valid backup identifier and passphrase are required")
	}
	media, err := MountMedia(request.MediaID)
	if err != nil {
		return "", err
	}
	repository := filepath.Join(media.Mountpoint, ".youeye", "repository")
	parent := "/var/lib/youeye/backups"
	temporary, err := os.MkdirTemp(parent, ".importing-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(temporary)
	output, err := resticCommand(repository, request.Passphrase, "restore", "latest", "--tag", "backup-id:"+request.BackupID, "--target", temporary).CombinedOutput()
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
