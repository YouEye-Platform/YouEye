package installer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/youeye-platform/YouEye/appliance/ordering"
)

const (
	applianceBundleSchema        = "youeye.appliance.manifest.v1"
	applianceStateSchema         = 1
	applianceDataSchema          = 1
	applianceKernelCompatibility = ">=6.12"
	applianceZFSCompatibility    = ">=2.3"
	applianceZFSFeatureProfile   = "openzfs-2.2"
	applianceIncusCompatibility  = ">=7.0"
	applianceRecoveryVersion     = "1"
)

type applianceBundleManifest struct {
	Schema              string                    `json:"schema"`
	ImageVersion        string                    `json:"image_version"`
	BuildID             string                    `json:"build_id"`
	SourceTree          string                    `json:"source_tree"`
	Architecture        string                    `json:"architecture"`
	FirmwareMode        string                    `json:"firmware_mode"`
	DiskLayout          applianceManifestLayout   `json:"disk_layout"`
	StateSchemaMin      int                       `json:"state_schema_min"`
	StateSchemaMax      int                       `json:"state_schema_max"`
	DataSchemaMin       int                       `json:"data_schema_min"`
	DataSchemaMax       int                       `json:"data_schema_max"`
	KernelCompatibility string                    `json:"kernel_compatibility"`
	ZFSCompatibility    string                    `json:"zfs_compatibility"`
	ZFSFeatureProfile   string                    `json:"zfs_feature_profile"`
	IncusCompatibility  string                    `json:"incus_compatibility"`
	RecoveryVersion     string                    `json:"recovery_version"`
	ReleaseSet          applianceManifestReleases `json:"release_set"`
	Artifacts           []applianceManifestAsset  `json:"artifacts"`
	SourceDateEpoch     int64                     `json:"source_date_epoch"`
}

type applianceManifestLayout struct {
	Version      int   `json:"version"`
	TargetMinGiB int64 `json:"target_min_gib"`
	ESPGiB       int64 `json:"esp_gib"`
	RecoveryGiB  int64 `json:"recovery_gib"`
	RootSlotGiB  int64 `json:"root_slot_gib"`
	StateGiB     int64 `json:"state_gib"`
}

type applianceManifestReleases struct {
	Spine        applianceManifestComponent `json:"spine"`
	ControlPanel applianceManifestComponent `json:"control_panel"`
	UI           applianceManifestComponent `json:"ui"`
}

type applianceManifestComponent struct {
	Version        string `json:"version"`
	SourceTree     string `json:"source_tree"`
	ArtifactSHA256 string `json:"artifact_sha256"`
}

type applianceManifestAsset struct {
	Role                  string `json:"role"`
	Path                  string `json:"path"`
	SHA256                string `json:"sha256"`
	SizeBytes             int64  `json:"size_bytes"`
	Compression           string `json:"compression,omitempty"`
	UncompressedSHA256    string `json:"uncompressed_sha256,omitempty"`
	UncompressedSizeBytes int64  `json:"uncompressed_size_bytes,omitempty"`
}

type verifiedApplianceBundle struct {
	Manifest       applianceBundleManifest
	ManifestSHA256 string
	Assets         map[string]verifiedApplianceAsset
}

type verifiedApplianceAsset struct {
	Manifest applianceManifestAsset
	Path     string
}

// verifyApplianceBundle reads the image manifest from the boot medium and
// checks every artifact it names by size and sha256. The manifest itself is
// bound by digest to the accepted core release when one is selected.
func verifyApplianceBundle(manifestPath string) (verifiedApplianceBundle, error) {
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return verifiedApplianceBundle{}, fmt.Errorf("read appliance manifest: %w", err)
	}
	manifest, err := parseApplianceBundleManifest(raw)
	if err != nil {
		return verifiedApplianceBundle{}, err
	}

	base := filepath.Dir(manifestPath)
	assets := make(map[string]verifiedApplianceAsset, len(manifest.Artifacts))
	for _, asset := range manifest.Artifacts {
		path, err := applianceAssetPath(base, asset.Path)
		if err != nil {
			return verifiedApplianceBundle{}, fmt.Errorf("artifact %s: %w", asset.Role, err)
		}
		if err := verifyFileIdentity(path, asset.SizeBytes, asset.SHA256); err != nil {
			return verifiedApplianceBundle{}, fmt.Errorf("artifact %s: %w", asset.Role, err)
		}
		assets[asset.Role] = verifiedApplianceAsset{Manifest: asset, Path: path}
	}
	digest := sha256.Sum256(raw)
	return verifiedApplianceBundle{
		Manifest:       manifest,
		ManifestSHA256: hex.EncodeToString(digest[:]),
		Assets:         assets,
	}, nil
}

func parseApplianceBundleManifest(raw []byte) (applianceBundleManifest, error) {
	var manifest applianceBundleManifest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&manifest); err != nil {
		return manifest, fmt.Errorf("decode appliance manifest: %w", err)
	}
	if err := requireApplianceJSONEOF(dec); err != nil {
		return manifest, err
	}
	if err := validateApplianceBundleManifest(manifest); err != nil {
		return manifest, err
	}
	return manifest, nil
}

func validateApplianceBundleManifest(manifest applianceBundleManifest) error {
	if manifest.Schema != applianceBundleSchema {
		return fmt.Errorf("unsupported appliance manifest schema %q", manifest.Schema)
	}
	for name, value := range map[string]string{
		"image_version":        manifest.ImageVersion,
		"build_id":             manifest.BuildID,
		"source_tree":          manifest.SourceTree,
		"architecture":         manifest.Architecture,
		"firmware_mode":        manifest.FirmwareMode,
		"kernel_compatibility": manifest.KernelCompatibility,
		"zfs_compatibility":    manifest.ZFSCompatibility,
		"zfs_feature_profile":  manifest.ZFSFeatureProfile,
		"incus_compatibility":  manifest.IncusCompatibility,
		"recovery_version":     manifest.RecoveryVersion,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("appliance manifest %s is required", name)
		}
	}
	if len(manifest.SourceTree) != 40 || !isLowerHex(manifest.SourceTree) {
		return fmt.Errorf("appliance manifest source_tree must be a full lowercase git tree id")
	}
	if err := ordering.ValidateIdentity(manifest.ImageVersion); err != nil {
		return fmt.Errorf("appliance manifest ordering identity: %w", err)
	}
	if manifest.Architecture != runtime.GOARCH || manifest.FirmwareMode != "uefi" {
		return fmt.Errorf("appliance manifest is incompatible with %s/%s installer", runtime.GOARCH, manifest.FirmwareMode)
	}
	if manifest.SourceDateEpoch <= 0 {
		return fmt.Errorf("appliance manifest source_date_epoch must be positive")
	}
	if manifest.DiskLayout.Version != 1 ||
		manifest.DiskLayout.TargetMinGiB != applianceTargetMinBytes/applianceGiB ||
		manifest.DiskLayout.ESPGiB != applianceESPBytes/applianceGiB ||
		manifest.DiskLayout.RecoveryGiB != applianceRecoveryBytes/applianceGiB ||
		manifest.DiskLayout.RootSlotGiB != applianceRootSlotBytes/applianceGiB ||
		manifest.DiskLayout.StateGiB != applianceStateBytes/applianceGiB {
		return fmt.Errorf("appliance manifest disk layout is not supported by this installer")
	}
	if manifest.StateSchemaMin != applianceStateSchema || manifest.StateSchemaMax != applianceStateSchema {
		return fmt.Errorf("appliance manifest state schema compatibility range is not supported")
	}
	if manifest.DataSchemaMin != applianceDataSchema || manifest.DataSchemaMax != applianceDataSchema {
		return fmt.Errorf("appliance manifest data schema compatibility range is not supported")
	}
	if manifest.KernelCompatibility != applianceKernelCompatibility ||
		manifest.ZFSCompatibility != applianceZFSCompatibility ||
		manifest.ZFSFeatureProfile != applianceZFSFeatureProfile ||
		manifest.IncusCompatibility != applianceIncusCompatibility ||
		manifest.RecoveryVersion != applianceRecoveryVersion {
		return fmt.Errorf("appliance manifest runtime compatibility is not supported by this installer")
	}
	for name, component := range map[string]applianceManifestComponent{
		"spine":         manifest.ReleaseSet.Spine,
		"control_panel": manifest.ReleaseSet.ControlPanel,
		"ui":            manifest.ReleaseSet.UI,
	} {
		if err := validateManifestComponent(name, component); err != nil {
			return err
		}
	}
	required := map[string]bool{
		"system-root": false, "internal-recovery": false,
		"system-a-uki": false, "system-b-uki": false, "recovery-uki": false,
	}
	for _, asset := range manifest.Artifacts {
		if _, exists := required[asset.Role]; !exists {
			return fmt.Errorf("unsupported appliance artifact role %q", asset.Role)
		}
		if required[asset.Role] {
			return fmt.Errorf("duplicate appliance artifact role %q", asset.Role)
		}
		required[asset.Role] = true
		if strings.TrimSpace(asset.Path) == "" || asset.SizeBytes <= 0 || !validSHA256Hex(asset.SHA256) {
			return fmt.Errorf("appliance artifact %s has invalid path, size, or sha256", asset.Role)
		}
		switch asset.Compression {
		case "":
			if asset.UncompressedSHA256 != "" || asset.UncompressedSizeBytes != 0 {
				return fmt.Errorf("uncompressed appliance artifact %s has compressed metadata", asset.Role)
			}
		case "zstd":
			if !validSHA256Hex(asset.UncompressedSHA256) || asset.UncompressedSizeBytes <= 0 {
				return fmt.Errorf("zstd appliance artifact %s requires uncompressed identity", asset.Role)
			}
		default:
			return fmt.Errorf("unsupported appliance artifact compression %q", asset.Compression)
		}
	}
	for role, found := range required {
		if !found {
			return fmt.Errorf("appliance manifest is missing %s artifact", role)
		}
	}
	root := findManifestAsset(manifest.Artifacts, "system-root")
	if root.UncompressedSizeBytes <= 0 {
		root.UncompressedSizeBytes = root.SizeBytes
	}
	if root.UncompressedSizeBytes > applianceRootSlotBytes {
		return fmt.Errorf("system root payload exceeds the fixed %s slot", formatBytes(applianceRootSlotBytes))
	}
	recovery := findManifestAsset(manifest.Artifacts, "internal-recovery")
	if recovery.UncompressedSizeBytes <= 0 {
		recovery.UncompressedSizeBytes = recovery.SizeBytes
	}
	if recovery.UncompressedSizeBytes > applianceRecoveryBytes {
		return fmt.Errorf("internal recovery payload exceeds the fixed %s partition", formatBytes(applianceRecoveryBytes))
	}
	return nil
}

func validateManifestComponent(name string, component applianceManifestComponent) error {
	if strings.TrimSpace(component.Version) == "" || len(component.SourceTree) != 40 || !isLowerHex(component.SourceTree) || !validSHA256Hex(component.ArtifactSHA256) {
		return fmt.Errorf("appliance release_set %s identity is incomplete", name)
	}
	return nil
}

func findManifestAsset(assets []applianceManifestAsset, role string) applianceManifestAsset {
	for _, asset := range assets {
		if asset.Role == role {
			return asset
		}
	}
	return applianceManifestAsset{}
}

func applianceAssetPath(base, relative string) (string, error) {
	if filepath.IsAbs(relative) {
		return "", fmt.Errorf("path must be relative")
	}
	clean := filepath.Clean(relative)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes the artifact directory")
	}
	path := filepath.Join(base, clean)
	rel, err := filepath.Rel(base, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes the artifact directory")
	}
	return path, nil
}

func verifyFileIdentity(path string, size int64, wantSHA string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() != size {
		return fmt.Errorf("size mismatch: got %d, want %d", info.Size(), size)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return fmt.Errorf("hash: %w", err)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != wantSHA {
		return fmt.Errorf("sha256 mismatch: got %s, want %s", got, wantSHA)
	}
	return nil
}

func validSHA256Hex(value string) bool { return len(value) == 64 && isLowerHex(value) }

func isLowerHex(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func requireApplianceJSONEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return fmt.Errorf("decode appliance manifest: trailing JSON value")
	}
	return nil
}

func applianceArtifactRoles(assets map[string]verifiedApplianceAsset) []string {
	roles := make([]string, 0, len(assets))
	for role := range assets {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	return roles
}
