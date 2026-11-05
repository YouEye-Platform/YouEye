package cmd

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// readYouEyeConfigRaw reads the raw bytes of youeye.yaml.
// Returns os.ErrNotExist-style error if the file doesn't exist.
func readYouEyeConfigRaw() ([]byte, error) {
	data, err := os.ReadFile(youeyeConfigPath)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// yamlUnmarshalForLanguage unmarshals YAML data into a generic map.
// This preserves all fields (including ones not in our struct) when
// doing read-modify-write operations.
func yamlUnmarshalForLanguage(data []byte, out *map[string]interface{}) error {
	return yaml.Unmarshal(data, out)
}

// writeYouEyeConfigRaw writes a generic map back to youeye.yaml,
// preserving all fields. This is used by language commands to avoid
// losing fields not in the branchConfig struct.
func writeYouEyeConfigRaw(raw map[string]interface{}) error {
	if err := os.MkdirAll("/var/lib/youeye/config", 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	data, err := yaml.Marshal(raw)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	header := "# YouEye Configuration\n# Managed by Spine - do not edit manually unless you know what you're doing\n\n"
	if err := os.WriteFile(youeyeConfigPath, []byte(header+string(data)), 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}
