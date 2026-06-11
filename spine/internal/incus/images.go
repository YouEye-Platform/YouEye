package incus

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	SystemBaseImageSource = "images:debian/12"
	SystemBaseImageAlias  = "youeye-debian-12"
	imageMetadataDir      = "/var/lib/youeye/images"
)

type imageInfo struct {
	Fingerprint  string            `json:"fingerprint"`
	Architecture string            `json:"architecture"`
	Type         string            `json:"type"`
	Properties   map[string]string `json:"properties"`
	Aliases      []struct {
		Name string `json:"name"`
	} `json:"aliases"`
}

type storedImageMetadata struct {
	Alias        string            `json:"alias"`
	Source       string            `json:"source"`
	Fingerprint  string            `json:"fingerprint"`
	Architecture string            `json:"architecture"`
	Type         string            `json:"type"`
	Properties   map[string]string `json:"properties"`
	VerifiedAt   string            `json:"verified_at"`
}

// EnsureSystemBaseImage makes the supported Debian 12 base image available as a
// local Incus alias. System containers must be created from this local alias so
// repeated deploy attempts do not depend on a regional image mirror.
func EnsureSystemBaseImage() error {
	fmt.Println("Ensuring YouEye base image is available locally...")

	info, err := localImageInfo(SystemBaseImageAlias)
	if err == nil {
		if err := validateDebian12Image(info); err != nil {
			return fmt.Errorf("local image %s failed validation: %w", SystemBaseImageAlias, err)
		}
		if err := writeImageMetadata(info); err != nil {
			return err
		}
		fmt.Printf("✓ Base image %s already available (%s)\n", SystemBaseImageAlias, shortFingerprint(info.Fingerprint))
		return nil
	}

	fmt.Printf("Base image %s not found locally; copying %s...\n", SystemBaseImageAlias, SystemBaseImageSource)
	if err := copyBaseImageWithRetry(SystemBaseImageSource, SystemBaseImageAlias, 3); err != nil {
		return fmt.Errorf("failed to copy base image %s into local Incus store: %w", SystemBaseImageSource, err)
	}

	info, err = localImageInfo(SystemBaseImageAlias)
	if err != nil {
		return fmt.Errorf("base image copy completed but local alias %s is unavailable: %w", SystemBaseImageAlias, err)
	}
	if err := validateDebian12Image(info); err != nil {
		return fmt.Errorf("copied base image %s failed validation: %w", SystemBaseImageAlias, err)
	}
	if err := writeImageMetadata(info); err != nil {
		return err
	}

	fmt.Printf("✓ Base image %s ready (%s)\n", SystemBaseImageAlias, shortFingerprint(info.Fingerprint))
	return nil
}

func copyBaseImageWithRetry(source, alias string, attempts int) error {
	var lastErr error
	for i := 1; i <= attempts; i++ {
		args := []string{"image", "copy", source, "local:", "--alias", alias, "--copy-aliases=false"}
		out, err := exec.Command("incus", args...).CombinedOutput()
		if err == nil {
			return nil
		}
		lastErr = fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
		if i < attempts {
			time.Sleep(time.Duration(i) * 2 * time.Second)
		}
	}
	return lastErr
}

func localImageInfo(alias string) (*imageInfo, error) {
	out, err := exec.Command("incus", "image", "info", "local:"+alias, "--format", "json").Output()
	if err != nil {
		return nil, err
	}
	var info imageInfo
	if err := json.Unmarshal(out, &info); err != nil {
		return nil, err
	}
	return &info, nil
}

func validateDebian12Image(info *imageInfo) error {
	if info == nil {
		return fmt.Errorf("image info is empty")
	}
	if info.Fingerprint == "" {
		return fmt.Errorf("fingerprint is empty")
	}
	if info.Type != "container" {
		return fmt.Errorf("type is %q, want container", info.Type)
	}
	if info.Architecture != "x86_64" && info.Properties["architecture"] != "amd64" {
		return fmt.Errorf("architecture is %q/%q, want amd64", info.Architecture, info.Properties["architecture"])
	}
	if !strings.EqualFold(info.Properties["os"], "debian") {
		return fmt.Errorf("os is %q, want Debian", info.Properties["os"])
	}
	release := strings.ToLower(info.Properties["release"])
	if release != "bookworm" && release != "12" {
		return fmt.Errorf("release is %q, want bookworm/12", info.Properties["release"])
	}
	return nil
}

func writeImageMetadata(info *imageInfo) error {
	if err := os.MkdirAll(imageMetadataDir, 0700); err != nil {
		return fmt.Errorf("failed to create image metadata directory: %w", err)
	}
	metadata := storedImageMetadata{
		Alias:        SystemBaseImageAlias,
		Source:       SystemBaseImageSource,
		Fingerprint:  info.Fingerprint,
		Architecture: info.Architecture,
		Type:         info.Type,
		Properties:   info.Properties,
		VerifiedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to encode image metadata: %w", err)
	}
	path := filepath.Join(imageMetadataDir, "debian-12.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("failed to write image metadata: %w", err)
	}
	return nil
}

func shortFingerprint(fingerprint string) string {
	if len(fingerprint) <= 12 {
		return fingerprint
	}
	return fingerprint[:12]
}
