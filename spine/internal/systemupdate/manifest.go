// Package systemupdate implements signed transactional updates for sealed
// YouEye appliance System slots.
package systemupdate

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"runtime"
	"strings"

	"github.com/youeye-platform/YouEye/appliance/ordering"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const (
	ManifestSchema = "youeye.system-update.v1"
	TrustClassDev  = "development"
	RootSlotBytes  = int64(8 * 1024 * 1024 * 1024)
	BootAttempts   = 3
)

type Manifest struct {
	Schema                     string               `json:"schema"`
	TargetImageVersion         string               `json:"target_image_version"`
	BuildID                    string               `json:"build_id"`
	SourceCommit               string               `json:"source_commit"`
	Architecture               string               `json:"architecture"`
	FirmwareMode               string               `json:"firmware_mode"`
	HardwareProfile            string               `json:"hardware_profile"`
	DiskLayoutVersion          int                  `json:"disk_layout_version"`
	StateSchemaMin             int                  `json:"state_schema_min"`
	StateSchemaMax             int                  `json:"state_schema_max"`
	DataSchemaMin              int                  `json:"data_schema_min"`
	DataSchemaMax              int                  `json:"data_schema_max"`
	RecoveryVersion            string               `json:"recovery_version"`
	MinimumCurrentImageVersion string               `json:"minimum_current_image_version"`
	RootSlotSizeBytes          int64                `json:"root_slot_size_bytes"`
	BootAttempts               int                  `json:"boot_attempts"`
	HealthProfile              string               `json:"health_profile"`
	ArtifactKind               string               `json:"artifact_kind"`
	Trust                      Trust                `json:"trust"`
	Rollback                   RollbackContract     `json:"rollback"`
	ReleaseSet                 appliance.ReleaseSet `json:"release_set"`
	Artifacts                  []Artifact           `json:"artifacts"`
	SourceDateEpoch            int64                `json:"source_date_epoch"`
}

type Trust struct {
	Class string `json:"class"`
	KeyID string `json:"key_id"`
}

type RollbackContract struct {
	Supported        bool `json:"supported"`
	StateSchemaMin   int  `json:"state_schema_min"`
	StateSchemaMax   int  `json:"state_schema_max"`
	DataSchemaMin    int  `json:"data_schema_min"`
	DataSchemaMax    int  `json:"data_schema_max"`
	PreserveState    bool `json:"preserve_state"`
	PreserveData     bool `json:"preserve_data"`
	PreserveRecovery bool `json:"preserve_recovery"`
}

type Artifact struct {
	Role                  string `json:"role"`
	Path                  string `json:"path"`
	SHA256                string `json:"sha256"`
	SizeBytes             int64  `json:"size_bytes"`
	Compression           string `json:"compression,omitempty"`
	UncompressedSHA256    string `json:"uncompressed_sha256,omitempty"`
	UncompressedSizeBytes int64  `json:"uncompressed_size_bytes,omitempty"`
}

type VerifiedManifest struct {
	Manifest Manifest
	Raw      []byte
	SHA256   string
}

func VerifyManifest(manifestPath, signaturePath, trustKeyPath string) (VerifiedManifest, error) {
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return VerifiedManifest{}, fmt.Errorf("read system update manifest: %w", err)
	}
	manifest, err := ParseManifest(raw)
	if err != nil {
		return VerifiedManifest{}, err
	}
	key, err := readPublicKey(trustKeyPath)
	if manifest.Trust.Class != TrustClassDev {
		key, err = publicReleaseKey(manifest.Trust.Class)
	}
	if err != nil {
		return VerifiedManifest{}, err
	}
	keyID, err := publicKeyID(key)
	if err != nil {
		return VerifiedManifest{}, err
	}
	if manifest.Trust.KeyID != keyID {
		return VerifiedManifest{}, errors.New("system update manifest trust key ID does not match the installed trust anchor")
	}
	signature, err := readSignature(signaturePath)
	if err != nil {
		return VerifiedManifest{}, err
	}
	if !ed25519.Verify(key, raw, signature) {
		return VerifiedManifest{}, errors.New("system update manifest signature is not valid")
	}
	digest := sha256.Sum256(raw)
	return VerifiedManifest{Manifest: manifest, Raw: raw, SHA256: hex.EncodeToString(digest[:])}, nil
}

func ParseManifest(raw []byte) (Manifest, error) {
	var manifest Manifest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&manifest); err != nil {
		return manifest, fmt.Errorf("decode system update manifest: %w", err)
	}
	if err := requireEOF(dec); err != nil {
		return manifest, err
	}
	if err := manifest.Validate(); err != nil {
		return manifest, err
	}
	return manifest, nil
}

func (m Manifest) Validate() error {
	if m.Schema != ManifestSchema {
		return fmt.Errorf("unsupported system update schema %q", m.Schema)
	}
	for name, value := range map[string]string{
		"target_image_version": m.TargetImageVersion, "build_id": m.BuildID,
		"source_commit": m.SourceCommit, "architecture": m.Architecture,
		"firmware_mode": m.FirmwareMode, "hardware_profile": m.HardwareProfile,
		"recovery_version": m.RecoveryVersion, "minimum_current_image_version": m.MinimumCurrentImageVersion,
		"health_profile": m.HealthProfile, "artifact_kind": m.ArtifactKind,
		"trust.class": m.Trust.Class, "trust.key_id": m.Trust.KeyID,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("system update manifest %s is required", name)
		}
	}
	if len(m.SourceCommit) != 40 || !lowerHex(m.SourceCommit) {
		return errors.New("system update source_commit must be a full lowercase Git commit")
	}
	if err := ordering.ValidateIdentity(m.TargetImageVersion); err != nil {
		return fmt.Errorf("system update target identity: %w", err)
	}
	if err := ordering.ValidateIdentity(m.MinimumCurrentImageVersion); err != nil {
		return fmt.Errorf("system update minimum identity: %w", err)
	}
	if m.Architecture != runtime.GOARCH || m.FirmwareMode != "uefi" || m.HardwareProfile != "youeye-appliance-amd64-v1" {
		return fmt.Errorf("system update target %s/%s/%s is not supported", m.Architecture, m.FirmwareMode, m.HardwareProfile)
	}
	if m.DiskLayoutVersion != appliance.CurrentDiskLayout || m.RootSlotSizeBytes != RootSlotBytes {
		return errors.New("system update disk layout or root slot size is not supported")
	}
	if !validRange(m.StateSchemaMin, m.StateSchemaMax) || !validRange(m.DataSchemaMin, m.DataSchemaMax) {
		return errors.New("system update schema compatibility range is invalid")
	}
	if m.BootAttempts != BootAttempts || m.HealthProfile != "operational" {
		return errors.New("system update requires three boot attempts and the operational health profile")
	}
	if m.SourceDateEpoch <= 0 || (m.Trust.Class != TrustClassDev && m.Trust.Class != "beta" && m.Trust.Class != "stable") {
		return errors.New("system update provenance or trust class is invalid")
	}
	if m.ArtifactKind != m.Trust.Class && !(m.Trust.Class == TrustClassDev && m.ArtifactKind == "test") {
		return fmt.Errorf("unsupported system update artifact kind %q", m.ArtifactKind)
	}
	if !m.Rollback.Supported || !m.Rollback.PreserveState || !m.Rollback.PreserveData || !m.Rollback.PreserveRecovery ||
		!validRange(m.Rollback.StateSchemaMin, m.Rollback.StateSchemaMax) || !validRange(m.Rollback.DataSchemaMin, m.Rollback.DataSchemaMax) {
		return errors.New("system update rollback contract is incomplete")
	}
	if m.Trust.Class != TrustClassDev {
		branch := "main"
		if m.Trust.Class == "beta" {
			branch = "beta"
		}
		if m.ReleaseSet.Branch != branch || !strings.HasPrefix(m.ReleaseSet.Source, "https://github.com/") {
			return errors.New("public system update trust must match its GitHub release source and branch")
		}
	}
	if err := validateReleaseSet(m.ReleaseSet); err != nil {
		return err
	}
	required := map[string]bool{
		"system-root": false, "system-a-uki": false, "system-b-uki": false,
		"system-updater": false,
	}
	paths := map[string]bool{}
	for _, artifact := range m.Artifacts {
		if _, ok := required[artifact.Role]; !ok {
			return fmt.Errorf("unsupported system update artifact role %q", artifact.Role)
		}
		if required[artifact.Role] {
			return fmt.Errorf("duplicate system update artifact role %q", artifact.Role)
		}
		required[artifact.Role] = true
		if strings.TrimSpace(artifact.Path) == "" || artifact.Path != path.Base(artifact.Path) || artifact.Path == "." || strings.Contains(artifact.Path, "..") || strings.ContainsAny(artifact.Path, "\\\x00") {
			return fmt.Errorf("system update artifact %s path is unsafe", artifact.Role)
		}
		if paths[artifact.Path] {
			return fmt.Errorf("duplicate system update artifact path %q", artifact.Path)
		}
		paths[artifact.Path] = true
		if artifact.SizeBytes <= 0 || !validSHA256(artifact.SHA256) {
			return fmt.Errorf("system update artifact %s identity is invalid", artifact.Role)
		}
		if artifact.Role == "system-root" {
			if artifact.Compression != "zstd" || artifact.UncompressedSizeBytes != RootSlotBytes || !validSHA256(artifact.UncompressedSHA256) {
				return errors.New("system root requires exact bounded zstd and uncompressed identities")
			}
		} else if artifact.Compression != "" || artifact.UncompressedSizeBytes != 0 || artifact.UncompressedSHA256 != "" {
			return fmt.Errorf("artifact %s must be uncompressed", artifact.Role)
		}
	}
	for role, present := range required {
		if !present {
			return fmt.Errorf("system update manifest is missing %s", role)
		}
	}
	return nil
}

func (m Manifest) ValidateCurrent(current appliance.Manifest, state appliance.StateRecord, allowTest bool) error {
	return m.validateCurrent(current, state, allowTest, false)
}

func (m Manifest) validateCurrent(current appliance.Manifest, state appliance.StateRecord, allowTest, allowCurrent bool) error {
	if m.ArtifactKind == "test" && !allowTest {
		return errors.New("test system image requires explicit --allow-test-artifact confirmation")
	}
	if current.Architecture != m.Architecture || current.FirmwareMode != m.FirmwareMode || current.DiskLayoutVersion != m.DiskLayoutVersion {
		return errors.New("system update target is incompatible with the running appliance")
	}
	if state.SchemaVersion < m.StateSchemaMin || state.SchemaVersion > m.StateSchemaMax || state.DataSchemaVersion < m.DataSchemaMin || state.DataSchemaVersion > m.DataSchemaMax {
		return errors.New("system update target is incompatible with persistent State or Data schema")
	}
	if state.SchemaVersion < m.Rollback.StateSchemaMin || state.SchemaVersion > m.Rollback.StateSchemaMax || state.DataSchemaVersion < m.Rollback.DataSchemaMin || state.DataSchemaVersion > m.Rollback.DataSchemaMax {
		return errors.New("system update cannot preserve the current schemas during rollback")
	}
	if state.RecoveryVersion != m.RecoveryVersion || current.RecoveryVersion != m.RecoveryVersion {
		return errors.New("system update recovery expectation does not match the installed Recovery image")
	}
	minimum, _ := ordering.ParseVersion(m.MinimumCurrentImageVersion)
	installed, err := ordering.ParseVersion(current.ImageVersion)
	if err != nil {
		return fmt.Errorf("current appliance image version: %w", err)
	}
	if ordering.CompareVersion(minimum, installed) > 0 {
		return &CurrentCompatibilityError{
			Code:    "bridge_required",
			Message: fmt.Sprintf("current image %s is older than required minimum %s", current.ImageVersion, m.MinimumCurrentImageVersion),
		}
	}
	target, _ := ordering.ParseVersion(m.TargetImageVersion)
	switch ordering.CompareVersion(target, installed) {
	case -1:
		return &CurrentCompatibilityError{Code: "downgrade", Message: fmt.Sprintf("target image %s is older than installed image %s", m.TargetImageVersion, current.ImageVersion)}
	case 0:
		if allowCurrent {
			return nil
		}
		return fmt.Errorf("system update ordering: incoming image version %s is not newer than installed version %s", m.TargetImageVersion, current.ImageVersion)
	}
	return nil
}

// CurrentCompatibilityError distinguishes a signed target that needs an
// earlier bridge from a corrupt or untrusted update. Only bridge_required may
// cause convergence to inspect another signed release on the same track.
type CurrentCompatibilityError struct {
	Code           string
	Message        string
	ManifestSHA256 string
	TargetImage    string
	ReleaseBranch  string
}

func (err *CurrentCompatibilityError) Error() string { return err.Message }

func BridgeRequired(err error) bool {
	var compatibility *CurrentCompatibilityError
	return errors.As(err, &compatibility) && compatibility.Code == "bridge_required"
}

func (m Manifest) Artifact(role string) (Artifact, bool) {
	for _, artifact := range m.Artifacts {
		if artifact.Role == role {
			return artifact, true
		}
	}
	return Artifact{}, false
}

func validateReleaseSet(set appliance.ReleaseSet) error {
	if err := set.Validate(); err != nil {
		return fmt.Errorf("system update release_set: %w", err)
	}
	for name, component := range map[string]appliance.ComponentRelease{"spine": set.Spine, "control_panel": set.ControlPanel, "ui": set.UI} {
		if strings.TrimSpace(component.Version) == "" || len(component.SourceCommit) != 40 || !lowerHex(component.SourceCommit) || !validSHA256(component.ArtifactSHA256) {
			return fmt.Errorf("system update release_set %s identity is incomplete", name)
		}
		if name != "spine" && strings.TrimSpace(component.Tag) == "" {
			return fmt.Errorf("system update release_set %s tag is required", name)
		}
	}
	return nil
}

func readPublicKey(path string) (ed25519.PublicKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read system update trust key: %w", err)
	}
	trimmed := bytes.TrimSpace(raw)
	if block, _ := pem.Decode(trimmed); block != nil {
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse system update trust key: %w", err)
		}
		key, ok := parsed.(ed25519.PublicKey)
		if !ok {
			return nil, errors.New("system update trust key is not Ed25519")
		}
		return key, nil
	}
	for _, decode := range []func(string) ([]byte, error){hex.DecodeString, base64.StdEncoding.DecodeString} {
		if decoded, err := decode(string(trimmed)); err == nil && len(decoded) == ed25519.PublicKeySize {
			return ed25519.PublicKey(decoded), nil
		}
	}
	return nil, errors.New("system update trust key has unsupported encoding")
}

func publicKeyID(key ed25519.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return "", fmt.Errorf("encode system update trust key: %w", err)
	}
	digest := sha256.Sum256(der)
	return hex.EncodeToString(digest[:8]), nil
}

func readSignature(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read system update signature: %w", err)
	}
	if len(raw) == ed25519.SignatureSize {
		return raw, nil
	}
	trimmed := strings.TrimSpace(string(raw))
	for _, decode := range []func(string) ([]byte, error){hex.DecodeString, base64.StdEncoding.DecodeString} {
		if decoded, err := decode(trimmed); err == nil && len(decoded) == ed25519.SignatureSize {
			return decoded, nil
		}
	}
	return nil, errors.New("system update signature has unsupported encoding")
}

func requireEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("system update manifest contains trailing JSON")
	}
	return nil
}

func validRange(minimum, maximum int) bool { return minimum > 0 && maximum >= minimum }
func validSHA256(value string) bool        { return len(value) == 64 && lowerHex(value) }

func lowerHex(value string) bool {
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
