package backup

import (
	"os"

	"gopkg.in/yaml.v3"
)

// ScheduleConfig represents the backup schedule section in youeye.yaml.
type ScheduleConfig struct {
	Enabled           bool            `yaml:"enabled" json:"enabled"`
	TargetPath        string          `yaml:"target_path" json:"targetPath"`
	MediaID           string          `yaml:"media_id,omitempty" json:"mediaId,omitempty"`
	SelectedApps      []string        `yaml:"selected_apps,omitempty" json:"selectedApps,omitempty"`
	RecoveryKeyStored bool            `yaml:"recovery_key_stored,omitempty" json:"recoveryKeyStored,omitempty"`
	LastError         string          `yaml:"last_error,omitempty" json:"lastError,omitempty"`
	Schedule          ScheduleEntries `yaml:"schedule" json:"schedule"`
}

// ScheduleEntries holds the core schedule, default app schedule, and per-app overrides.
type ScheduleEntries struct {
	Core       ScheduleEntry            `yaml:"core" json:"core"`
	DefaultApp ScheduleEntry            `yaml:"default_app" json:"default_app"`
	Overrides  map[string]ScheduleEntry `yaml:"overrides" json:"overrides"`
}

// ScheduleEntry defines the schedule for a single backup target.
type ScheduleEntry struct {
	Frequency string `yaml:"frequency" json:"frequency"` // "daily", "weekly", "never"
	Retention int    `yaml:"retention" json:"retention"`
	Time      string `yaml:"time,omitempty" json:"time,omitempty"` // "HH:MM" format
	LastRun   string `yaml:"last_run,omitempty" json:"last_run,omitempty"`
}

// youeyeYAML is a partial struct for reading/writing the backup section of youeye.yaml.
type youeyeYAML struct {
	Backup *ScheduleConfig `yaml:"backup,omitempty"`
	// Preserve other fields via raw map
}

var youeyeConfigFile = "/var/lib/youeye/config/youeye.yaml"

// readBackupSchedule reads the backup section from youeye.yaml.
func readBackupSchedule() (*ScheduleConfig, error) {
	data, err := os.ReadFile(youeyeConfigFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var raw map[string]interface{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, err
	}

	backupRaw, ok := raw["backup"]
	if !ok {
		return nil, nil
	}

	// Re-marshal and unmarshal into the typed struct
	backupBytes, err := yaml.Marshal(backupRaw)
	if err != nil {
		return nil, err
	}

	var cfg ScheduleConfig
	if err := yaml.Unmarshal(backupBytes, &cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// saveBackupSchedule writes the backup schedule back to youeye.yaml,
// preserving all other fields.
func saveBackupSchedule(cfg *ScheduleConfig) error {
	data, err := os.ReadFile(youeyeConfigFile)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	var raw map[string]interface{}
	if len(data) > 0 {
		if err := yaml.Unmarshal(data, &raw); err != nil {
			raw = make(map[string]interface{})
		}
	} else {
		raw = make(map[string]interface{})
	}

	// Marshal the backup config to a generic map, then insert
	backupBytes, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	var backupMap interface{}
	if err := yaml.Unmarshal(backupBytes, &backupMap); err != nil {
		return err
	}
	raw["backup"] = backupMap

	outData, err := yaml.Marshal(raw)
	if err != nil {
		return err
	}

	return os.WriteFile(youeyeConfigFile, outData, 0644)
}

// ReadBackupConfig returns the current backup schedule config (for the API).
func ReadBackupConfig() (*ScheduleConfig, error) {
	return readBackupSchedule()
}

// SaveBackupConfig saves backup schedule config (for the API).
func SaveBackupConfig(cfg *ScheduleConfig) error {
	return saveBackupSchedule(cfg)
}
