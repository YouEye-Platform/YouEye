package backup

import "testing"

func TestValidateBackupSource(t *testing.T) {
	valid := BackupSourceIdentity{
		Schema: "youeye.backup.source.v1", RuntimeKind: "appliance-image", ImageVersion: "0.5.6.0.2.13",
		SourceCommit: "64fa44912fe0b8bee067d3761a0e2ff4fc8516b6", ReleaseBranch: "dev",
		StateSchemaVersion: 2, DataSchemaVersion: 1, DiskLayoutVersion: 3,
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
	invalid.Schema = "youeye.backup.source.v2"
	if err := validateBackupSource(invalid); err == nil {
		t.Fatal("unsupported source schema accepted")
	}
}
