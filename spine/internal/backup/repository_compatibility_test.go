package backup

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateBackupSource(t *testing.T) {
	valid := BackupSourceIdentity{
		Schema: "youeye.backup.source.v1", RuntimeKind: "appliance-image", ImageVersion: "0.5.6.0.2.13",
		SourceTree:         "64fa44912fe0b8bee067d3761a0e2ff4fc8516b6",
		StateSchemaVersion: 1, DataSchemaVersion: 1, DiskLayoutVersion: 1,
		SpineVersion: "0.5.17.0.2.7", ControlPanelVersion: "0.5.23.0.0.36", UIVersion: "0.5.3.0.2.2",
	}
	if err := validateBackupSource(valid); err != nil {
		t.Fatalf("valid source rejected: %v", err)
	}
	invalid := valid
	invalid.DataSchemaVersion = 0
	if err := validateBackupSource(invalid); err == nil {
		t.Fatal("incomplete appliance identity accepted")
	}
	invalid = valid
	invalid.Schema = "youeye.backup.source.v0"
	if err := validateBackupSource(invalid); err == nil {
		t.Fatal("unsupported source schema accepted")
	}
}

// From 0.6.12 a backup names the installed releases by ordering key and git
// tree, next to the older build names. Spine decodes the Control Panel's
// request strictly, so these fields must be known here before the Control
// Panel sends them.
func TestBackupSourceCarriesReleaseKeys(t *testing.T) {
	body := `{"schema":"youeye.backup.source.v1","runtime_kind":"appliance-image","image_version":"0.6.12-dev.3",
	 "source_tree":"1111111111111111111111111111111111111111","state_schema_version":1,"data_schema_version":1,
	 "spine_version":"0.6.12-dev.3","control_panel_version":"0.6.12-dev.3","ui_version":"0.6.12-dev.2","pointer_version":"0.6.3",
	 "release":{"version":"0.6.12","line":"0.6.12","sequence":1795100000,"source_tree":"1111111111111111111111111111111111111111"},
	 "control_panel":{"version":"0.6.12","line":"0.6.12","sequence":1795100000,"source_tree":"2222222222222222222222222222222222222222"},
	 "ui":{"version":"0.6.12","line":"0.6.12","sequence":1795100000,"source_tree":"3333333333333333333333333333333333333333"},
	 "pointer":{"version":"0.6.3-beta.1","line":"0.6.3","sequence":1795000000,"source_tree":"4444444444444444444444444444444444444444"}}`
	var source BackupSourceIdentity
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&source); err != nil {
		t.Fatal(err)
	}
	if err := validateBackupSource(source); err != nil {
		t.Fatal(err)
	}
	if source.Release == nil || source.Release.Sequence != 1795100000 || source.Pointer.Line != "0.6.3" || source.UI.SourceTree != strings.Repeat("3", 40) {
		t.Fatalf("release keys lost: %+v", source)
	}
	// They survive the recovery catalog (a JSON round trip), and an older
	// backup without them stays without them.
	raw, err := json.Marshal(source)
	if err != nil || !strings.Contains(string(raw), `"pointer":{"version":"0.6.3-beta.1","line":"0.6.3","sequence":1795000000`) {
		t.Fatalf("round trip: %s %v", raw, err)
	}
	older := source
	older.Release, older.ControlPanel, older.UI, older.Pointer = nil, nil, nil, nil
	if raw, _ := json.Marshal(older); strings.Contains(string(raw), `"release"`) || strings.Contains(string(raw), `"control_panel":`) {
		t.Fatalf("an older identity gained release keys: %s", raw)
	}
	for name, change := range map[string]func(*BackupRelease){
		"line is a name":      func(r *BackupRelease) { r.Line = "0.6.12-dev.3" },
		"version of another":  func(r *BackupRelease) { r.Version = "0.6.13" },
		"no sequence":         func(r *BackupRelease) { r.Sequence = 0 },
		"sequence too large":  func(r *BackupRelease) { r.Sequence = 9007199254740992 },
		"tree is not a tree":  func(r *BackupRelease) { r.SourceTree = "abc" },
		"version is no name":  func(r *BackupRelease) { r.Version = "latest" },
		"line is not a line":  func(r *BackupRelease) { r.Line, r.Version = "0.6", "0.6" },
		"version has no line": func(r *BackupRelease) { r.Version = "" },
	} {
		bad := source
		release := *source.ControlPanel
		change(&release)
		bad.ControlPanel = &release
		if err := validateBackupSource(bad); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
