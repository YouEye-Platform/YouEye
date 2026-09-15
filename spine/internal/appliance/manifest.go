// Package appliance defines the sealed-image contracts shared by Spine's
// deploy, update, health, and API surfaces. Runtime identity comes only from a
// builder-owned marker in the read-only image; mutable configuration is never
// consulted when deciding whether a host is an appliance image.
package appliance

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strings"

	"github.com/youeye-platform/YouEye/appliance/ordering"
)

const (
	ManifestPath          = "/usr/lib/youeye/appliance-release"
	ManifestSchemaVersion = 1
	CurrentDiskLayout     = 3

	RuntimeMutableHost    = "mutable-host"
	RuntimeApplianceImage = "appliance-image"
)

// Capabilities is the stable capability vocabulary consumed by the CLI, API,
// and Control Panel. False means that the action must be rejected before any
// mutation begins.
type Capabilities struct {
	SpineUpdate   bool `json:"spine_update"`
	SystemUpdate  bool `json:"system_update"`
	IncusUpdate   bool `json:"incus_update"`
	ControlUpdate bool `json:"control_update"`
	UIUpdate      bool `json:"ui_update"`
	AppUpdate     bool `json:"app_update"`
	ImageUpdate   bool `json:"image_update"`
	Recovery      bool `json:"recovery"`
	Health        bool `json:"health"`
}

const (
	ActionSpineUpdate   = "spine-update"
	ActionSystemUpdate  = "system-update"
	ActionImageUpdate   = "image-update"
	ActionIncusUpdate   = "incus-update"
	ActionControlUpdate = "control-update"
	ActionUIUpdate      = "ui-update"
	ActionAppUpdate     = "app-update"
)

type CapabilityError struct {
	Code    string `json:"code"`
	Action  string `json:"action"`
	Runtime string `json:"runtime"`
	Message string `json:"message"`
}

func (e *CapabilityError) Error() string { return e.Message }

func RequireCapability(status RuntimeStatus, action string) error {
	supported := false
	switch action {
	case ActionSpineUpdate:
		supported = status.Capabilities.SpineUpdate
	case ActionSystemUpdate:
		supported = status.Capabilities.SystemUpdate
	case ActionImageUpdate:
		supported = status.Capabilities.ImageUpdate
	case ActionIncusUpdate:
		supported = status.Capabilities.IncusUpdate
	case ActionControlUpdate:
		supported = status.Capabilities.ControlUpdate
	case ActionUIUpdate:
		supported = status.Capabilities.UIUpdate
	case ActionAppUpdate:
		supported = status.Capabilities.AppUpdate
	default:
		return &CapabilityError{Code: "unknown_capability", Action: action, Runtime: status.Kind, Message: fmt.Sprintf("unknown runtime capability %q", action)}
	}
	if supported {
		return nil
	}
	message := fmt.Sprintf("%s is image-managed on %s and cannot be updated in place", action, status.Kind)
	if status.Kind == RuntimeApplianceImage {
		message += "; install a compatible appliance image or use recovery"
	}
	return &CapabilityError{Code: "capability_not_supported", Action: action, Runtime: status.Kind, Message: message}
}

// Manifest is written by the appliance image builder. All fields affecting
// compatibility are required so an incomplete marker fails closed.
type Manifest struct {
	SchemaVersion       int         `json:"schema_version"`
	ImageVersion        string      `json:"image_version"`
	BuildID             string      `json:"build_id"`
	SourceCommit        string      `json:"source_commit"`
	Architecture        string      `json:"architecture"`
	FirmwareMode        string      `json:"firmware_mode"`
	DiskLayoutVersion   int         `json:"disk_layout_version"`
	StateSchemaMin      int         `json:"state_schema_min"`
	StateSchemaMax      int         `json:"state_schema_max"`
	DataSchemaMin       int         `json:"data_schema_min"`
	DataSchemaMax       int         `json:"data_schema_max"`
	KernelCompatibility string      `json:"kernel_compatibility"`
	ZFSCompatibility    string      `json:"zfs_compatibility"`
	ZFSFeatureProfile   string      `json:"zfs_feature_profile"`
	IncusCompatibility  string      `json:"incus_compatibility"`
	RecoveryVersion     string      `json:"recovery_version"`
	ArtifactKind        string      `json:"artifact_kind"`
	SupportedActions    []string    `json:"supported_actions"`
	ReleaseSet          *ReleaseSet `json:"release_set,omitempty"`
}

// ReleaseSet records the exact core payload selected by the image builder.
// Spine is baked into the image; Control Panel and UI are immutable release
// assets selected by tag and verified by digest during first deployment.
type ReleaseSet struct {
	Source       string           `json:"source"`
	Branch       string           `json:"branch"`
	Fallback     []string         `json:"fallback"`
	Spine        ComponentRelease `json:"spine"`
	ControlPanel ComponentRelease `json:"control_panel"`
	UI           ComponentRelease `json:"ui"`
}

type ComponentRelease struct {
	Version        string `json:"version"`
	Tag            string `json:"tag,omitempty"`
	SourceCommit   string `json:"source_commit"`
	ArtifactSHA256 string `json:"artifact_sha256"`
}

// RuntimeStatus is deliberately safe to expose. It contains no device
// identity, secret, or raw marker content.
type RuntimeStatus struct {
	Kind              string       `json:"kind"`
	ManifestValid     bool         `json:"manifest_valid"`
	RepairRequired    bool         `json:"repair_required"`
	ErrorCode         string       `json:"error_code,omitempty"`
	ImageVersion      string       `json:"image_version,omitempty"`
	BuildID           string       `json:"build_id,omitempty"`
	SourceCommit      string       `json:"source_commit,omitempty"`
	Architecture      string       `json:"architecture,omitempty"`
	FirmwareMode      string       `json:"firmware_mode,omitempty"`
	DiskLayoutVersion int          `json:"disk_layout_version,omitempty"`
	RecoveryVersion   string       `json:"recovery_version,omitempty"`
	ArtifactKind      string       `json:"artifact_kind,omitempty"`
	ReleaseSource     string       `json:"release_source,omitempty"`
	ReleaseBranch     string       `json:"release_branch,omitempty"`
	Capabilities      Capabilities `json:"capabilities"`
}

// ManifestError is stable enough for CLI/API consumers to distinguish a
// missing marker from a present-but-invalid sealed image.
type ManifestError struct {
	Code string
	Err  error
}

func (e *ManifestError) Error() string { return fmt.Sprintf("%s: %v", e.Code, e.Err) }
func (e *ManifestError) Unwrap() error { return e.Err }

func MutableCapabilities() Capabilities {
	return Capabilities{
		SpineUpdate: true, SystemUpdate: true, IncusUpdate: true,
		ControlUpdate: true, UIUpdate: true, AppUpdate: true,
		Health: true,
	}
}

func ApplianceCapabilities(m Manifest) Capabilities {
	c := Capabilities{ControlUpdate: true, UIUpdate: true, AppUpdate: true, Health: true}
	for _, action := range m.SupportedActions {
		switch strings.TrimSpace(strings.ToLower(action)) {
		case "image-update":
			c.ImageUpdate = true
		case "recovery":
			c.Recovery = true
		case "control-update":
			c.ControlUpdate = true
		case "ui-update":
			c.UIUpdate = true
		case "app-update":
			c.AppUpdate = true
		}
	}
	return c
}

// Detect reads the canonical marker. An absent marker is the only condition
// that identifies mutable-host. Any unreadable or malformed present marker is
// an appliance image requiring repair and returns an error.
func Detect() (RuntimeStatus, *Manifest, error) { return DetectAt(ManifestPath) }

func DetectAt(path string) (RuntimeStatus, *Manifest, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return RuntimeStatus{Kind: RuntimeMutableHost, ManifestValid: true, Capabilities: MutableCapabilities()}, nil, nil
	}
	if err != nil {
		return invalidStatus("manifest_unreadable"), nil, &ManifestError{Code: "manifest_unreadable", Err: err}
	}
	if err := validateMarkerImmutability(path); err != nil {
		return invalidStatus("manifest_mutable"), nil, &ManifestError{Code: "manifest_mutable", Err: err}
	}
	m, err := ParseManifest(data)
	if err != nil {
		return invalidStatus("manifest_invalid"), nil, &ManifestError{Code: "manifest_invalid", Err: err}
	}
	status := RuntimeStatus{
		Kind: RuntimeApplianceImage, ManifestValid: true,
		ImageVersion: m.ImageVersion, BuildID: m.BuildID, SourceCommit: m.SourceCommit,
		Architecture: m.Architecture, FirmwareMode: m.FirmwareMode,
		DiskLayoutVersion: m.DiskLayoutVersion, RecoveryVersion: m.RecoveryVersion,
		ArtifactKind: m.ArtifactKind, Capabilities: ApplianceCapabilities(m),
	}
	if m.ReleaseSet != nil {
		status.ReleaseSource = m.ReleaseSet.Source
		status.ReleaseBranch = m.ReleaseSet.Branch
	}
	return status, &m, nil
}

func validateMarkerImmutability(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("sealed marker must be a regular file")
	}
	if info.Mode().Perm()&0222 != 0 {
		return fmt.Errorf("sealed marker must not be writable (mode %04o)", info.Mode().Perm())
	}
	if path == ManifestPath {
		out, err := exec.Command("findmnt", "-n", "-o", "OPTIONS", "--target", path).CombinedOutput()
		if err != nil {
			return fmt.Errorf("inspect sealed marker filesystem: %w", err)
		}
		readOnly := false
		for _, option := range strings.Split(strings.TrimSpace(string(out)), ",") {
			if strings.TrimSpace(option) == "ro" {
				readOnly = true
			}
		}
		if !readOnly {
			return fmt.Errorf("sealed marker must be on a read-only filesystem")
		}
	}
	return nil
}

func invalidStatus(code string) RuntimeStatus {
	return RuntimeStatus{
		Kind: RuntimeApplianceImage, ManifestValid: false, RepairRequired: true,
		ErrorCode: code, Capabilities: Capabilities{Health: true, Recovery: true},
	}
}

func ParseManifest(data []byte) (Manifest, error) {
	var m Manifest
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return m, fmt.Errorf("decode manifest: %w", err)
	}
	if err := requireJSONEOF(dec); err != nil {
		return m, err
	}
	if err := m.Validate(); err != nil {
		return m, err
	}
	return m, nil
}

func requireJSONEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("multiple JSON values are not allowed")
		}
		return fmt.Errorf("trailing JSON content: %w", err)
	}
	return nil
}

func (m Manifest) Validate() error {
	if m.SchemaVersion != ManifestSchemaVersion {
		return fmt.Errorf("unsupported manifest schema %d (want %d)", m.SchemaVersion, ManifestSchemaVersion)
	}
	required := map[string]string{
		"image_version": m.ImageVersion, "build_id": m.BuildID, "source_commit": m.SourceCommit,
		"architecture": m.Architecture, "firmware_mode": m.FirmwareMode,
		"kernel_compatibility": m.KernelCompatibility, "zfs_compatibility": m.ZFSCompatibility,
		"zfs_feature_profile": m.ZFSFeatureProfile,
		"incus_compatibility": m.IncusCompatibility, "recovery_version": m.RecoveryVersion,
		"artifact_kind": m.ArtifactKind,
	}
	for name, value := range required {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if err := ordering.ValidateIdentity(m.ImageVersion); err != nil {
		return fmt.Errorf("image ordering identity: %w", err)
	}
	if m.DiskLayoutVersion != CurrentDiskLayout {
		return fmt.Errorf("unsupported disk_layout_version %d (want %d)", m.DiskLayoutVersion, CurrentDiskLayout)
	}
	if m.StateSchemaMin < 1 || m.StateSchemaMax < m.StateSchemaMin {
		return fmt.Errorf("invalid state schema compatibility range")
	}
	if m.DataSchemaMin < 1 || m.DataSchemaMax < m.DataSchemaMin {
		return fmt.Errorf("invalid data schema compatibility range")
	}
	switch m.ArtifactKind {
	case "production", "development", "test":
	default:
		return fmt.Errorf("artifact_kind must be production, development, or test")
	}
	if m.ReleaseSet != nil {
		if err := m.ReleaseSet.Validate(); err != nil {
			return fmt.Errorf("release_set: %w", err)
		}
	}
	return nil
}

func (r ReleaseSet) Validate() error {
	u, err := url.Parse(r.Source)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("source must be an absolute HTTP(S) repository URL")
	}
	if err := validateReleaseBranch(r.Branch); err != nil {
		return err
	}
	if r.Fallback == nil || len(r.Fallback) != 0 {
		return fmt.Errorf("fallback must be an explicit empty array")
	}
	if err := validateComponentRelease("spine", r.Branch, r.Spine, false); err != nil {
		return err
	}
	if err := validateComponentRelease("cp", r.Branch, r.ControlPanel, true); err != nil {
		return err
	}
	if err := validateComponentRelease("ui", r.Branch, r.UI, true); err != nil {
		return err
	}
	return nil
}

func validateReleaseBranch(branch string) error {
	if branch == "" || len(branch) > 128 {
		return fmt.Errorf("branch is required")
	}
	for _, component := range strings.Split(branch, "/") {
		if component == "" || component == "." || component == ".." || strings.HasPrefix(component, ".") ||
			strings.HasSuffix(component, ".") || strings.HasSuffix(component, ".lock") {
			return fmt.Errorf("invalid branch %q", branch)
		}
		for _, c := range component {
			if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
				return fmt.Errorf("invalid branch %q", branch)
			}
		}
	}
	return nil
}

func validateComponentRelease(prefix, branch string, release ComponentRelease, requireTag bool) error {
	name := prefix
	if prefix == "cp" {
		name = "control_panel"
	}
	if strings.TrimSpace(release.Version) == "" {
		return fmt.Errorf("%s.version is required", name)
	}
	if requireTag && release.Tag == "" {
		return fmt.Errorf("%s.tag is required", name)
	}
	if release.Tag != "" {
		want := prefix + "-v" + release.Version
		if branch != "main" {
			want = prefix + "-" + branch + "-v" + release.Version
		}
		if release.Tag != want {
			return fmt.Errorf("%s.tag %q does not match exact branch/version tag %q", name, release.Tag, want)
		}
	}
	if !isHexDigest(release.SourceCommit, 40) {
		return fmt.Errorf("%s.source_commit must be a 40-character hexadecimal commit", name)
	}
	if !isHexDigest(release.ArtifactSHA256, 64) {
		return fmt.Errorf("%s.artifact_sha256 must be a 64-character hexadecimal digest", name)
	}
	return nil
}

func isHexDigest(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, c := range value {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}
