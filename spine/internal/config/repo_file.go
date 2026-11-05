package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"gopkg.in/yaml.v3"
)

const DefaultConfigFilePath = "/etc/youeye/config.yaml"
const PersistentConfigFilePath = "/var/lib/youeye/config/config.yaml"

func writableDefaultConfigFilePath() (string, error) {
	status, _, err := appliance.Detect()
	if err != nil {
		return "", fmt.Errorf("resolve runtime configuration path: %w", err)
	}
	if status.Kind == appliance.RuntimeApplianceImage {
		return PersistentConfigFilePath, nil
	}
	return DefaultConfigFilePath, nil
}

// WriteCoreRepoURL persists the canonical core release repository URL.
// It removes deprecated split release-source fields so future loads derive
// provider, API path, owner, and repository from releases.repo_url.
func WriteCoreRepoURL(path, repoURL string) error {
	if path == "" {
		path = GetConfigFile()
	}
	if path == "" {
		var err error
		path, err = writableDefaultConfigFilePath()
		if err != nil {
			return err
		}
	}

	raw := map[string]interface{}{}
	if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
		if err := yaml.Unmarshal(data, &raw); err != nil {
			return fmt.Errorf("failed to parse %s: %w", path, err)
		}
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read %s: %w", path, err)
	}

	releases, _ := raw["releases"].(map[string]interface{})
	if releases == nil {
		releases = map[string]interface{}{}
	}
	releases["repo_url"] = repoURL
	delete(releases, "provider")
	delete(releases, "base_url")
	delete(releases, "api_path")
	delete(releases, "organization")
	delete(releases, "repositories")
	raw["releases"] = releases

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}
	data, err := yaml.Marshal(raw)
	if err != nil {
		return fmt.Errorf("failed to encode config: %w", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("failed to write %s: %w", path, err)
	}
	return nil
}
