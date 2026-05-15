package backup

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ScheduleConfig represents the backup schedule section in youeye.yaml.
type ScheduleConfig struct {
	Enabled    bool                          `yaml:"enabled" json:"enabled"`
	TargetPath string                        `yaml:"target_path" json:"target_path"`
	Schedule   ScheduleEntries               `yaml:"schedule" json:"schedule"`
}

// ScheduleEntries holds the core schedule, default app schedule, and per-app overrides.
type ScheduleEntries struct {
	Core       ScheduleEntry                 `yaml:"core" json:"core"`
	DefaultApp ScheduleEntry                 `yaml:"default_app" json:"default_app"`
	Overrides  map[string]ScheduleEntry      `yaml:"overrides" json:"overrides"`
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

var (
	schedulerRunning bool
	youeyeConfigFile = "/var/lib/youeye/config/youeye.yaml"
	cpSocketPath     = "/var/lib/youeye/youeye.sock"
)

// StartScheduler begins the backup scheduler goroutine.
// It checks every 60 seconds whether any backup is due.
func StartScheduler(cfgPath string) {
	if cfgPath != "" {
		youeyeConfigFile = cfgPath
	}

	if schedulerRunning {
		return
	}
	schedulerRunning = true

	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			checkAndRunScheduled()
		}
	}()

	fmt.Println("Backup scheduler started")
}

// checkAndRunScheduled reads the backup config and triggers any due backups.
func checkAndRunScheduled() {
	cfg, err := readBackupSchedule()
	if err != nil || cfg == nil || !cfg.Enabled {
		return
	}

	now := time.Now()

	// Check core backup
	if isDue(cfg.Schedule.Core, now) {
		if err := triggerScheduledBackup("core", ""); err != nil {
			fmt.Printf("Scheduled core backup failed: %v\n", err)
		} else {
			cfg.Schedule.Core.LastRun = now.UTC().Format(time.RFC3339)
			saveBackupSchedule(cfg)

			// Run retention cleanup
			if cfg.Schedule.Core.Retention > 0 {
				PruneEntries(cfg.TargetPath, "core", "", cfg.Schedule.Core.Retention)
			}
		}
	}

	// Check app backups (overrides take precedence over default)
	// The scheduler only triggers — CP knows which apps exist
	for appID, override := range cfg.Schedule.Overrides {
		if override.Frequency == "never" {
			continue
		}
		if isDue(override, now) {
			if err := triggerScheduledBackup("app", appID); err != nil {
				fmt.Printf("Scheduled app backup for %s failed: %v\n", appID, err)
			} else {
				override.LastRun = now.UTC().Format(time.RFC3339)
				cfg.Schedule.Overrides[appID] = override
				saveBackupSchedule(cfg)

				retention := override.Retention
				if retention <= 0 {
					retention = cfg.Schedule.DefaultApp.Retention
				}
				if retention > 0 {
					PruneEntries(cfg.TargetPath, "app", appID, retention)
				}
			}
		}
	}
}

// isDue returns true if a backup should run based on frequency, time, and last_run.
func isDue(entry ScheduleEntry, now time.Time) bool {
	if entry.Frequency == "" || entry.Frequency == "never" {
		return false
	}

	// Parse scheduled time (default to "03:00")
	schedTime := entry.Time
	if schedTime == "" {
		schedTime = "03:00"
	}
	parts := strings.Split(schedTime, ":")
	if len(parts) != 2 {
		return false
	}

	schedHour := 3
	schedMin := 0
	fmt.Sscanf(parts[0], "%d", &schedHour)
	fmt.Sscanf(parts[1], "%d", &schedMin)

	// Check if we're past the scheduled time today
	todayScheduled := time.Date(now.Year(), now.Month(), now.Day(), schedHour, schedMin, 0, 0, now.Location())
	if now.Before(todayScheduled) {
		return false
	}

	// Check if it already ran since the last scheduled time
	if entry.LastRun != "" {
		lastRun, err := time.Parse(time.RFC3339, entry.LastRun)
		if err == nil {
			switch entry.Frequency {
			case "daily":
				if lastRun.After(todayScheduled) {
					return false
				}
			case "weekly":
				weekAgo := todayScheduled.AddDate(0, 0, -7)
				if lastRun.After(weekAgo) {
					return false
				}
			}
		}
	}

	return true
}

// triggerScheduledBackup makes an HTTP request to the CP's scheduled backup endpoint.
func triggerScheduledBackup(backupType, appID string) error {
	url := "http://localhost:3000/api/backup/scheduled"
	body := fmt.Sprintf(`{"backup_type":"%s","app_id":"%s"}`, backupType, appID)

	req, err := http.NewRequest("POST", url, strings.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 300 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("request to CP: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("CP returned %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

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
