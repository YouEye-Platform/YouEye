package systemupdate

// Standalone component testing has explicit authority separate from installed
// System membership and the target-bound signed production bootstrap.
import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const SpineCandidateRoot = "/var/lib/youeye-state/spine-candidates"
const SpineCandidateBindingSchema = "youeye.spine-candidate-binding.v1"
const SpineCandidateStatusSchema = "youeye.spine-candidate-status.v1"
const SpineCandidateStatusSchemaV2 = "youeye.spine-candidate-status.v2"
const SpineCandidateArtifact = "spine-linux-amd64"

type SpineCandidateProjection struct {
	Schema            string `json:"schema"`
	SourceCommit      string `json:"source_commit"`
	ProjectedCommit   string `json:"projected_commit"`
	Tree              string `json:"tree"`
	InputsSHA256      string `json:"inputs_sha256"`
	SourceDateEpoch   int64  `json:"source_date_epoch"`
	TrustFingerprint  string `json:"trust_fingerprint"`
	IndependentBuilds int    `json:"independent_builds"`
}
type SpineCandidateRequest struct {
	Root           string `json:"root"`
	CandidateID    string `json:"candidate_id"`
	ArtifactSHA256 string `json:"artifact_sha256"`
	SourceCommit   string `json:"source_commit"`
	Identity       string `json:"identity"`
}
type SpineCandidateBinding struct {
	Schema                  string              `json:"schema"`
	CandidateID             string              `json:"candidate_id"`
	ArtifactSHA256          string              `json:"artifact_sha256"`
	SourceCommit            string              `json:"source_commit"`
	Root                    string              `json:"root"`
	HardwareUUID            string              `json:"hardware_uuid"`
	InstalledManifestSHA256 string              `json:"installed_manifest_sha256"`
	ActivatedAt             time.Time           `json:"activated_at"`
	BaselineKind            string              `json:"baseline_kind,omitempty"`
	BaselineMachine         CoreMachineIdentity `json:"baseline_machine,omitempty"`
	FrozenMediaSHA256       string              `json:"frozen_media_sha256,omitempty"`
}
type SpineCandidateStatus struct {
	Schema       string                `json:"schema"`
	BaselineKind string                `json:"baseline_kind"`
	Binding      SpineCandidateBinding `json:"binding"`
	API          struct {
		Healthy        bool   `json:"healthy"`
		ArtifactSHA256 string `json:"artifact_sha256"`
	} `json:"api"`
}
type SpineCandidateManager struct {
	Root, CoreRoot, LifecycleRoot string
	baselineObservation           *spineCandidateBaselineObservation
}

// Only native observations are replaceable by confined tests. Signed selection,
// metadata, role grants, policy, bundle signatures and file hashes stay real.
type spineCandidateBaselineObservation struct {
	BootstrapRoot, ImagePath, BundlePath, BundleSignaturePath, BakedPath, FirstDeployRoot, CacheRoot string
	Hardware                                                                                         func() (string, error)
	Image                                                                                            func() (appliance.RuntimeStatus, *appliance.Manifest, error)
	Machine                                                                                          func() (CoreMachineIdentity, error)
	Capture                                                                                          func(context.Context, string, ...string) ([]byte, error)
	EffectiveUID                                                                                     func() int
	Client                                                                                           *http.Client
}

type spineCandidateBaseline struct {
	Kind, ManifestSHA256, HardwareUUID, FrozenMediaSHA256 string
	Machine                                               CoreMachineIdentity
}

func (m SpineCandidateManager) baselineObservations() spineCandidateBaselineObservation {
	if m.baselineObservation != nil {
		return *m.baselineObservation
	}
	manager := m.core()
	stateRoot := filepath.Dir(manager.Root)
	return spineCandidateBaselineObservation{BootstrapRoot: filepath.Join(stateRoot, "bootstrap"), ImagePath: appliance.ManifestPath, BundlePath: filepath.Join(stateRoot, "installer", "appliance-manifest.json"), BundleSignaturePath: filepath.Join(stateRoot, "installer", "appliance-manifest.json.sig"), BakedPath: "/usr/local/bin/youeye", FirstDeployRoot: filepath.Join(stateRoot, "first-deploy"), CacheRoot: "/var/lib/youeye/cache/core-update", Hardware: SpineCandidateHardware, Image: appliance.Detect, Machine: func() (CoreMachineIdentity, error) {
		return (NativeCoreCheckpoint{Root: manager.Root, StatePath: appliance.StatePath}).observeMachine()
	}, Capture: captureCoreNative, EffectiveUID: os.Geteuid}
}

func (m SpineCandidateManager) effectiveUID() int {
	if m.baselineObservation != nil && m.baselineObservation.EffectiveUID != nil {
		return m.baselineObservation.EffectiveUID()
	}
	return os.Geteuid()
}

func (m SpineCandidateManager) root() string {
	if m.Root != "" {
		return m.Root
	}
	return SpineCandidateRoot
}
func (m SpineCandidateManager) core() CoreManager {
	root := m.CoreRoot
	if root == "" {
		root = CoreStatePath
	}
	return CoreManager{Root: root}
}
func (m SpineCandidateManager) barrier() CoreLifecycleBarrier {
	root := m.LifecycleRoot
	if root == "" {
		root = CoreAppLifecycleRoot
	}
	return CoreLifecycleBarrier{Root: root}
}
func (m SpineCandidateManager) BindingPath() string { return filepath.Join(m.root(), "active.json") }

var spineCandidateID = regexp.MustCompile(`^spine-candidate-b-[A-Za-z0-9._-]{1,120}$`)
var spineCandidateCommit = regexp.MustCompile(`^[0-9a-f]{40}$`)
var spineCandidateUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func NormalizeSpineCandidateHardware(identity string) (string, error) {
	value := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(identity)), "smbios:")
	if !spineCandidateUUID.MatchString(value) || value == "00000000-0000-0000-0000-000000000000" {
		return "", fmt.Errorf("exact SMBIOS hardware UUID required")
	}
	return value, nil
}
func SpineCandidateHardware() (string, error) {
	raw, err := os.ReadFile("/sys/class/dmi/id/product_uuid")
	if err != nil {
		return "", fmt.Errorf("actual SMBIOS identity unavailable")
	}
	return NormalizeSpineCandidateHardware(string(raw))
}

func candidateProtectedDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 || int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("unsafe candidate directory")
	}
	return nil
}
func candidateProtectedRead(path string, limit int64) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || int(stat.Uid) != os.Geteuid() || stat.Nlink != 1 || info.Size() < 1 || info.Size() > limit {
		return nil, fmt.Errorf("unsafe candidate regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	current, pathErr := os.Lstat(path)
	if err != nil || pathErr != nil || !os.SameFile(info, current) || !after.ModTime().Equal(info.ModTime()) || after.Size() != info.Size() || int64(len(raw)) != info.Size() {
		return nil, fmt.Errorf("candidate file changed during protected read")
	}
	return raw, nil
}
func candidateJSON(raw []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return fmt.Errorf("candidate JSON requires one document")
	}
	return nil
}
func candidateHash(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }

// The key parameter is supplied only by the scoped authority resolver in the
// public entry point. The downloaded release-public.pub never supplies trust.
func verifySpineCandidateSet(root, digest, source string, key ed25519.PublicKey) error {
	if !filepath.IsAbs(root) || filepath.Base(root) != digest || !validSHA256(digest) || !spineCandidateCommit.MatchString(source) {
		return fmt.Errorf("exact content-addressed candidate root/digest/source required")
	}
	if err := candidateProtectedDirectory(filepath.Dir(root)); err != nil {
		return err
	}
	if err := candidateProtectedDirectory(root); err != nil {
		return err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	if len(entries) != 6 {
		return fmt.Errorf("candidate requires the exact six-file signed component envelope")
	}
	wanted := map[string]int64{SpineCandidateArtifact: 128 << 20, "provenance.json": 1 << 20, "sbom.spdx.json": 16 << 20, "release-public.pub": 16384, "SHA256SUMS": 16384, "SHA256SUMS.sig": 64}
	assets := map[string][]byte{}
	for _, entry := range entries {
		limit, ok := wanted[entry.Name()]
		if !ok {
			return fmt.Errorf("undeclared candidate envelope file")
		}
		data, err := candidateProtectedRead(filepath.Join(root, entry.Name()), limit)
		if err != nil {
			return err
		}
		assets[entry.Name()] = data
	}
	if !ed25519.Verify(key, assets["SHA256SUMS"], assets["SHA256SUMS.sig"]) {
		return fmt.Errorf("candidate checksum signature is not authorized by current scoped Stable Spine trust")
	}
	covered := map[string]bool{SpineCandidateArtifact: false, "provenance.json": false, "sbom.spdx.json": false, "release-public.pub": false}
	scanner := bufio.NewScanner(bytes.NewReader(assets["SHA256SUMS"]))
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), "  ", 2)
		if len(parts) != 2 || !validSHA256(parts[0]) {
			return fmt.Errorf("malformed candidate signed checksum set")
		}
		seen, ok := covered[parts[1]]
		if !ok || seen || candidateHash(assets[parts[1]]) != parts[0] {
			return fmt.Errorf("candidate signed checksum coverage differs")
		}
		covered[parts[1]] = true
	}
	if scanner.Err() != nil {
		return scanner.Err()
	}
	for _, present := range covered {
		if !present {
			return fmt.Errorf("candidate signature omits required envelope evidence")
		}
	}
	if candidateHash(assets[SpineCandidateArtifact]) != digest {
		return fmt.Errorf("candidate binary differs from reviewed digest")
	}
	var provenance struct {
		Schema, Component, Repository, Branch, Version string
		SourceCommit                                   string                        `json:"source_commit"`
		SourceDateEpoch                                int64                         `json:"source_date_epoch"`
		TrustClass                                     string                        `json:"trust_class"`
		CoreMetadata                                   string                        `json:"core_metadata"`
		Projection                                     SpineCandidateProjection      `json:"build_projection"`
		Manifest                                       struct{ Path, SHA256 string } `json:"manifest"`
		BuildKit                                       struct{ Digest string }       `json:"build_kit"`
		Artifact                                       struct {
			Name, SHA256 string
			Size         int64 `json:"size_bytes"`
		}
		BuilderCredentials bool   `json:"builder_credentials"`
		SignerNetwork      bool   `json:"signer_network"`
		ValidationProfile  string `json:"validation_profile"`
	}
	if err := json.Unmarshal(assets["provenance.json"], &provenance); err != nil {
		return fmt.Errorf("invalid signed candidate provenance")
	}
	p := provenance.Projection
	if provenance.Schema != "youeye.release.provenance.v1" || provenance.Component != "spine" || provenance.Repository != "YouEye" || provenance.Branch != "main" || !releasecache.ValidCoreVersion(provenance.Version) || strings.Contains(provenance.Version, "-") || provenance.SourceCommit != source || provenance.TrustClass != "stable" || provenance.CoreMetadata != "paired-v2" || provenance.Artifact.Name != SpineCandidateArtifact || provenance.Artifact.SHA256 != digest || provenance.Artifact.Size != int64(len(assets[SpineCandidateArtifact])) || provenance.BuilderCredentials || provenance.SignerNetwork || provenance.ValidationProfile != "spine-elf-v1" || !validSHA256(provenance.Manifest.SHA256) || provenance.Manifest.Path != ".youeye/build/manifests/spine.json" || !validSHA256(provenance.BuildKit.Digest) || p.Schema != "youeye.spine-candidate-projection.v1" || p.SourceCommit != source || !spineCandidateCommit.MatchString(p.ProjectedCommit) || !spineCandidateCommit.MatchString(p.Tree) || !validSHA256(p.InputsSHA256) || !validSHA256(p.TrustFingerprint) || p.SourceDateEpoch <= 0 || p.SourceDateEpoch != provenance.SourceDateEpoch || p.IndependentBuilds != 2 {
		return fmt.Errorf("signed candidate build provenance, production profile or projection identity differs")
	}
	return nil
}

func (m SpineCandidateManager) VerifySet(request SpineCandidateRequest) error {
	if m.effectiveUID() != 0 {
		return fmt.Errorf("candidate testing requires root")
	}
	if !spineCandidateID.MatchString(request.CandidateID) || request.Root != filepath.Join(m.root(), request.ArtifactSHA256) {
		return fmt.Errorf("exact protected candidate identity required")
	}
	key, err := spineCandidateScopedKey()
	if err != nil {
		return err
	}
	return verifySpineCandidateSet(request.Root, request.ArtifactSHA256, request.SourceCommit, key)
}
func spineCandidateScopedKey() (ed25519.PublicKey, error) {
	return CoreRoleKey(releasecache.OfficialRepository, "main", "stable", "spine", CoreDevelopmentTrustPath)
}
func (m SpineCandidateManager) baseline(identity string) (spineCandidateBaseline, error) {
	return m.baselineFor(identity, false)
}

func (m SpineCandidateManager) baselineFor(identity string, admission bool) (spineCandidateBaseline, error) {
	return m.baselineContext(context.Background(), identity, admission)
}

func (m SpineCandidateManager) baselineContext(ctx context.Context, identity string, admission bool) (spineCandidateBaseline, error) {
	var empty spineCandidateBaseline
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	o := m.baselineObservations()
	want, err := NormalizeSpineCandidateHardware(identity)
	if err != nil {
		return empty, err
	}
	hardware, err := o.Hardware()
	if err != nil || hardware != want {
		return empty, fmt.Errorf("candidate target hardware differs")
	}
	manager := m.core()
	receipt, err := manager.ReadReceipt()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			frozen, err := m.frozenMediaBaselineContext(ctx, hardware, admission, false)
			if err != nil {
				return empty, err
			}
			if _, err := manager.ReadReceipt(); !errors.Is(err, os.ErrNotExist) {
				return empty, fmt.Errorf("committed baseline appeared during frozen media observation; explicit reconciliation required")
			}
			return frozen, nil
		}
		return empty, err
	}
	selection, release, err := manager.Selection(receipt.ManifestSHA256, CoreDevelopmentTrustPath)
	if err != nil || !reflect.DeepEqual(release, receipt.Release) {
		return empty, fmt.Errorf("current committed signed System baseline unavailable")
	}
	if _, _, err := EnsureCoreMetadata(ctx, selection, CoreDevelopmentTrustPath, o.CacheRoot, o.Client, ""); err != nil {
		return empty, err
	}
	for _, member := range release.Members {
		if err := CheckCoreMemberAuthority(member, release.Channel, CoreDevelopmentTrustPath); err != nil {
			return empty, err
		}
		if member.Role == "spine" {
			if err := verifyFile(o.BakedPath, member.Artifact.SizeBytes, member.Artifact.SHA256); err != nil {
				return empty, fmt.Errorf("baked Spine differs from committed baseline")
			}
		}
	}
	_, image, err := o.Image()
	if err != nil || image == nil || BindCoreImage(release, *image) != nil {
		return empty, fmt.Errorf("running immutable host differs from committed baseline")
	}
	machine, err := o.Machine()
	if err != nil || machine != receipt.Machine {
		return empty, fmt.Errorf("candidate baseline actual installed machine differs")
	}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	return spineCandidateBaseline{Kind: "committed", ManifestSHA256: receipt.ManifestSHA256, HardwareUUID: hardware, Machine: machine}, nil
}

type spineCandidateFirstDeployProgress struct {
	Schema    string `json:"schema"`
	Operation string `json:"operation"`
	State     string `json:"state"`
	Stage     string `json:"stage"`
	Detail    string `json:"detail"`
	Percent   int    `json:"percent"`
	Attempt   int    `json:"attempt"`
	UpdatedAt string `json:"updated_at"`
}

func candidateFirstDeployProgress(o spineCandidateBaselineObservation, admission, allowComplete bool) error {
	complete, err := os.Lstat(filepath.Join(o.FirstDeployRoot, "complete"))
	if err == nil {
		stat, ok := complete.Sys().(*syscall.Stat_t)
		if !allowComplete || !ok || !complete.Mode().IsRegular() || stat.Nlink != 1 || int(stat.Uid) != os.Geteuid() || complete.Mode().Perm()&0022 != 0 || complete.Size() > 4096 {
			return fmt.Errorf("frozen media requires unexposed first deployment")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := candidateProtectedDirectory(o.FirstDeployRoot); err != nil {
		return err
	}
	raw, err := candidateProtectedRead(filepath.Join(o.FirstDeployRoot, "progress.json"), 16384)
	if err != nil {
		return err
	}
	var progress spineCandidateFirstDeployProgress
	if candidateJSON(raw, &progress) != nil || progress.Schema != "youeye.appliance.progress.v2" || progress.Operation != "first-deploy" || progress.Attempt < 1 || progress.Attempt > 100000 || progress.Percent < 0 || progress.Percent > 100 || len(progress.Detail) > 4096 {
		return fmt.Errorf("protected first deployment progress unavailable")
	}
	if parsed, err := time.Parse(time.RFC3339, progress.UpdatedAt); err != nil || parsed.IsZero() {
		return fmt.Errorf("first deployment progress has invalid time")
	}
	if admission {
		if progress.State != "needs_attention" || progress.Stage != "needs_attention" {
			return fmt.Errorf("candidate requires explicit stopped first-deployment recovery")
		}
		return nil
	}
	allowedState := progress.State == "running" || progress.State == "retrying" || progress.State == "needs_attention" || allowComplete && progress.State == "complete"
	allowedStage := map[string]bool{"network": true, "core_selection": true, "core_convergence": true, "release_convergence": true, "system_restart": true, "preparing": true, "market_seed": true, "server_interface": true, "storage": true, "incus": true, "system_core": true, "database": true, "web_gateway": true, "network_shield": true, "ui": true, "verifying": true, "setup": true, "retrying": true, "needs_attention": true, "complete": allowComplete}
	if !allowedState || !allowedStage[progress.Stage] {
		return fmt.Errorf("first deployment recovery state unknown")
	}
	return nil
}

func candidateFirstDeploySettled(ctx context.Context, o spineCandidateBaselineObservation) error {
	units, err := o.Capture(ctx, "systemctl", "list-units", "--all", "--type=service", "--no-legend", "--plain", "youeye-first-deploy.service")
	if err != nil {
		return fmt.Errorf("first deployment service liveness unavailable")
	}
	for _, line := range strings.Split(string(units), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if len(fields) < 4 || fields[0] != "youeye-first-deploy.service" || fields[1] != "loaded" || !(fields[2] == "inactive" && fields[3] == "dead" || fields[2] == "failed" && fields[3] == "failed") {
			return fmt.Errorf("first deployment service must settle before candidate binding or reconciliation")
		}
	}
	return ctx.Err()
}

// The first-deploy shell holds this same inode through its complete attempt.
// Binding changes take its lock nonblockingly as well as observing systemd, so
// another manual/automatic start cannot enter between admission and API cutover.
func lockCandidateFirstDeploy(o spineCandidateBaselineObservation) (func(), error) {
	if _, err := os.Lstat(o.FirstDeployRoot); errors.Is(err, os.ErrNotExist) {
		return func() {}, nil
	} else if err != nil {
		return nil, err
	}
	if err := candidateProtectedDirectory(o.FirstDeployRoot); err != nil {
		return nil, err
	}
	path := filepath.Join(o.FirstDeployRoot, "lock")
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || int(stat.Uid) != os.Geteuid() || info.Mode().Perm()&0022 != 0 || stat.Nlink != 1 || info.Size() > 4096 {
		file.Close()
		return nil, fmt.Errorf("unsafe first deployment lock")
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("first deployment already owns its exact recovery lock")
	}
	current, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, current) {
		syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		file.Close()
		return nil, fmt.Errorf("first deployment lock changed during admission")
	}
	return func() { syscall.Flock(int(file.Fd()), syscall.LOCK_UN); file.Close() }, nil
}

// Frozen media is a signed pre-deployment baseline, never an installed receipt.
// Exact evidence is re-read after native machine observations to detect drift.
func (m SpineCandidateManager) frozenMediaBaseline(hardware string, admission, allowComplete bool) (spineCandidateBaseline, error) {
	return m.frozenMediaBaselineContext(context.Background(), hardware, admission, allowComplete)
}

func (m SpineCandidateManager) frozenMediaBaselineContext(ctx context.Context, hardware string, admission, allowComplete bool) (spineCandidateBaseline, error) {
	var empty spineCandidateBaseline
	o := m.baselineObservations()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	if err := candidateFirstDeployProgress(o, admission, allowComplete); err != nil {
		return empty, err
	}
	if admission {
		if err := m.candidateTransitionReady(ctx, o.Capture); err != nil {
			return empty, err
		}
		if err := candidateFirstDeploySettled(ctx, o); err != nil {
			return empty, err
		}
	}
	for _, directory := range []string{o.BootstrapRoot, filepath.Dir(o.ImagePath), filepath.Dir(o.BundlePath)} {
		if err := candidateProtectedDirectory(directory); err != nil {
			return empty, err
		}
	}
	policyPath := filepath.Join(o.BootstrapRoot, "release-policy.json")
	policyRaw, err := candidateProtectedRead(policyPath, 1<<20)
	if err != nil {
		return empty, err
	}
	var policy ReleasePolicy
	if err := candidateJSON(policyRaw, &policy); err != nil {
		return empty, err
	}
	if err := policy.Validate(); err != nil {
		return empty, err
	}
	selection, release, digest, err := ReadAuthenticatedCoreSelection(ctx, o.BootstrapRoot, CoreDevelopmentTrustPath, o.CacheRoot, o.Client)
	if err != nil {
		return empty, err
	}
	if err := ValidateCorePolicy(policy, release, digest); err != nil {
		return empty, err
	}
	if _, err := VerifyCoreInstalledMedia(policy, o.BootstrapRoot, o.ImagePath, o.BundlePath, o.BundleSignaturePath, CoreDevelopmentTrustPath); err != nil {
		return empty, err
	}
	_, image, err := o.Image()
	if err != nil || image == nil || BindCoreImage(release, *image) != nil {
		return empty, fmt.Errorf("frozen media differs from running immutable image")
	}
	machine, err := o.Machine()
	if err != nil || machine.Validate() != nil {
		return empty, fmt.Errorf("frozen media actual partition/machine identity unavailable")
	}
	var bakedDigest string
	var bakedSize int64
	for _, member := range release.Members {
		if err := CheckCoreMemberAuthority(member, release.Channel, CoreDevelopmentTrustPath); err != nil {
			return empty, err
		}
		if member.Role == "spine" {
			raw, err := candidateProtectedRead(o.BakedPath, 128<<20)
			if err != nil || int64(len(raw)) != member.Artifact.SizeBytes || candidateHash(raw) != member.Artifact.SHA256 {
				return empty, fmt.Errorf("baked Spine differs from frozen signed media")
			}
			bakedDigest = member.Artifact.SHA256
			bakedSize = member.Artifact.SizeBytes
		}
	}
	if bakedDigest == "" {
		return empty, fmt.Errorf("frozen media has no baked Spine identity")
	}
	readEvidence := func() (string, error) {
		evidence := map[string]string{"schema": "youeye.spine-candidate-frozen-media.v1", "manifest_sha256": digest, "metadata_proof_sha256": candidateHash(selection.MetadataProof), "baked_sha256": bakedDigest}
		baked, err := candidateProtectedRead(o.BakedPath, 128<<20)
		if err != nil || int64(len(baked)) != bakedSize || candidateHash(baked) != bakedDigest {
			return "", fmt.Errorf("frozen baked Spine changed")
		}
		for name, path := range map[string]string{"policy_sha256": policyPath, "image_sha256": o.ImagePath, "bundle_sha256": o.BundlePath, "bundle_signature_sha256": o.BundleSignaturePath, "execution_sha256": filepath.Join(o.BootstrapRoot, "core-release.json"), "execution_signature_sha256": filepath.Join(o.BootstrapRoot, "core-release.json.sig")} {
			raw, err := candidateProtectedRead(path, 1<<20)
			if err != nil {
				return "", err
			}
			evidence[name] = candidateHash(raw)
			if name == "policy_sha256" && !bytes.Equal(raw, policyRaw) {
				return "", fmt.Errorf("frozen policy changed")
			}
			if name == "execution_sha256" && !bytes.Equal(raw, selection.Raw) || name == "execution_signature_sha256" && !bytes.Equal(raw, selection.Signature) {
				return "", fmt.Errorf("frozen selection changed")
			}
			if name == "image_sha256" {
				parsed, err := appliance.ParseManifest(raw)
				if err != nil || !reflect.DeepEqual(parsed, *image) {
					return "", fmt.Errorf("immutable image observation changed")
				}
			}
		}
		machineRaw, _ := json.Marshal(machine)
		evidence["machine_sha256"] = candidateHash(machineRaw)
		raw, _ := json.Marshal(evidence)
		return candidateHash(raw), nil
	}
	fingerprint, err := readEvidence()
	if err != nil {
		return empty, err
	}
	after, afterRelease, afterDigest, err := ReadAuthenticatedCoreSelection(ctx, o.BootstrapRoot, CoreDevelopmentTrustPath, o.CacheRoot, o.Client)
	if err != nil || afterDigest != digest || !reflect.DeepEqual(afterRelease, release) || !bytes.Equal(after.Raw, selection.Raw) || !bytes.Equal(after.Signature, selection.Signature) || !bytes.Equal(after.MetadataProof, selection.MetadataProof) {
		return empty, fmt.Errorf("authenticated frozen media changed during observation")
	}
	currentMachine, err := o.Machine()
	if err != nil || currentMachine != machine {
		return empty, fmt.Errorf("frozen media actual machine changed")
	}
	currentHardware, err := o.Hardware()
	if err != nil || currentHardware != hardware {
		return empty, fmt.Errorf("frozen media hardware changed")
	}
	currentFingerprint, err := readEvidence()
	if err != nil || currentFingerprint != fingerprint {
		return empty, fmt.Errorf("frozen media files changed")
	}
	if err := candidateFirstDeployProgress(o, admission, allowComplete); err != nil {
		return empty, err
	}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	return spineCandidateBaseline{Kind: "frozen-media", ManifestSHA256: digest, HardwareUUID: hardware, Machine: machine, FrozenMediaSHA256: fingerprint}, nil
}
func (m SpineCandidateManager) ReadBinding() (SpineCandidateBinding, error) {
	var b SpineCandidateBinding
	raw, err := candidateProtectedRead(m.BindingPath(), 16384)
	if err != nil {
		return b, err
	}
	if err := candidateJSON(raw, &b); err != nil {
		return b, err
	}
	if b.Schema != SpineCandidateBindingSchema || !spineCandidateID.MatchString(b.CandidateID) || !validSHA256(b.ArtifactSHA256) || !spineCandidateCommit.MatchString(b.SourceCommit) || b.Root != filepath.Join(m.root(), b.ArtifactSHA256) || !validSHA256(b.InstalledManifestSHA256) || b.ActivatedAt.IsZero() {
		return b, fmt.Errorf("invalid protected candidate binding")
	}
	switch b.BaselineKind {
	case "": // Existing v1 bindings describe the committed baseline only.
		if b.BaselineMachine != (CoreMachineIdentity{}) || b.FrozenMediaSHA256 != "" {
			return b, fmt.Errorf("ambiguous legacy candidate baseline")
		}
	case "committed":
		if b.BaselineMachine.Validate() != nil || b.FrozenMediaSHA256 != "" && !validSHA256(b.FrozenMediaSHA256) {
			return b, fmt.Errorf("invalid committed candidate baseline")
		}
	case "frozen-media":
		if b.BaselineMachine.Validate() != nil || !validSHA256(b.FrozenMediaSHA256) {
			return b, fmt.Errorf("invalid frozen candidate baseline")
		}
	default:
		return b, fmt.Errorf("unknown candidate baseline kind")
	}
	return b, nil
}
func (m SpineCandidateManager) VerifyBinding() (SpineCandidateBinding, error) {
	return m.VerifyBindingContext(context.Background())
}

func (m SpineCandidateManager) VerifyBindingContext(ctx context.Context) (SpineCandidateBinding, error) {
	if err := ctx.Err(); err != nil {
		return SpineCandidateBinding{}, err
	}
	b, err := m.ReadBinding()
	if err != nil {
		return b, err
	}
	if err := m.VerifySet(SpineCandidateRequest{Root: b.Root, CandidateID: b.CandidateID, ArtifactSHA256: b.ArtifactSHA256, SourceCommit: b.SourceCommit, Identity: b.HardwareUUID}); err != nil {
		return b, err
	}
	baseline, err := m.baselineContext(ctx, b.HardwareUUID, false)
	if err != nil || baseline.ManifestSHA256 != b.InstalledManifestSHA256 {
		return b, fmt.Errorf("candidate binding no longer matches current committed baseline/hardware")
	}
	kind := b.BaselineKind
	if kind == "" {
		kind = "committed"
	}
	if baseline.Kind != kind || b.BaselineKind != "" && baseline.Machine != b.BaselineMachine || kind == "frozen-media" && baseline.FrozenMediaSHA256 != b.FrozenMediaSHA256 {
		return b, fmt.Errorf("candidate baseline changed; explicit reconciliation required")
	}
	if kind == "committed" && b.FrozenMediaSHA256 != "" {
		frozen, err := m.frozenMediaBaselineContext(ctx, b.HardwareUUID, false, true)
		if err != nil || frozen.ManifestSHA256 != b.InstalledManifestSHA256 || frozen.Machine != b.BaselineMachine || frozen.FrozenMediaSHA256 != b.FrozenMediaSHA256 {
			return b, fmt.Errorf("retained original frozen media evidence changed")
		}
	}
	if err := ctx.Err(); err != nil {
		return b, err
	}
	return b, nil
}

// ReconcileBaseline is an explicit, quiescent transition after normal first
// deployment has created its own genuine committed receipt. No receipt is made
// here, and the original frozen-media fingerprint remains retained provenance.
func (m SpineCandidateManager) ReconcileBaseline(ctx context.Context, request SpineCandidateRequest) (SpineCandidateBinding, error) {
	var result SpineCandidateBinding
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	err := m.WithQuiescent(ctx, func() error {
		if err := candidateFirstDeploySettled(ctx, m.baselineObservations()); err != nil {
			return err
		}
		var err error
		result, err = m.reconcileBaseline(ctx, request)
		return err
	})
	return result, err
}

func (m SpineCandidateManager) reconcileBaseline(ctx context.Context, request SpineCandidateRequest) (SpineCandidateBinding, error) {
	var empty SpineCandidateBinding
	preimage, err := candidateProtectedRead(m.BindingPath(), 16384)
	if err != nil {
		return empty, err
	}
	b, err := m.ReadBinding()
	if err != nil {
		return empty, err
	}
	hardware, err := NormalizeSpineCandidateHardware(request.Identity)
	if err != nil || hardware != b.HardwareUUID || request.Root != b.Root || request.CandidateID != b.CandidateID || request.ArtifactSHA256 != b.ArtifactSHA256 || request.SourceCommit != b.SourceCommit {
		return empty, fmt.Errorf("exact retained candidate required for baseline reconciliation")
	}
	if err := m.VerifySet(request); err != nil {
		return empty, err
	}
	if b.BaselineKind != "frozen-media" {
		return m.VerifyBindingContext(ctx)
	}
	baseline, err := m.baselineContext(ctx, b.HardwareUUID, false)
	if err != nil || baseline.Kind != "committed" || baseline.ManifestSHA256 != b.InstalledManifestSHA256 || baseline.Machine != b.BaselineMachine {
		return empty, fmt.Errorf("normal committed receipt must match exact frozen release and machine")
	}
	frozen, err := m.frozenMediaBaselineContext(ctx, hardware, false, true)
	if err != nil || frozen.ManifestSHA256 != b.InstalledManifestSHA256 || frozen.Machine != b.BaselineMachine || frozen.FrozenMediaSHA256 != b.FrozenMediaSHA256 {
		return empty, fmt.Errorf("original frozen media evidence differs")
	}
	current, err := candidateProtectedRead(m.BindingPath(), 16384)
	if err != nil || !bytes.Equal(current, preimage) {
		return empty, fmt.Errorf("candidate binding changed before reconciliation")
	}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	b.BaselineKind = "committed"
	raw, err := json.Marshal(b)
	if err != nil {
		return empty, err
	}
	if err := atomicWrite(m.BindingPath(), append(raw, '\n'), 0600); err != nil {
		return empty, err
	}
	return m.VerifyBindingContext(ctx)
}

// TestExecutable is subordinate to a registered signed production bootstrap.
// Callers select that bootstrap first and must propagate errors, never fallback.
func (m SpineCandidateManager) TestExecutable() (string, error) {
	_, err := m.ReadBinding()
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	b, err := m.VerifyBinding()
	if err != nil {
		return "", err
	}
	return filepath.Join(b.Root, SpineCandidateArtifact), nil
}

// WithQuiescent serializes only binding changes. It creates no update intent or
// lifecycle reservation and never expires another owner's durable work.
func (m SpineCandidateManager) WithQuiescent(ctx context.Context, run func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if m.effectiveUID() != 0 {
		return fmt.Errorf("candidate binding requires root")
	}
	manager := m.core()
	unlock, err := manager.lockCore()
	if err != nil {
		return err
	}
	defer unlock()
	host := New(Config{JournalPath: filepath.Join(filepath.Dir(manager.Root), "system-update", "journal.json")})
	hostUnlock, err := host.lock()
	if err != nil {
		return err
	}
	defer hostUnlock()
	b := m.barrier()
	// Close ordinary admission before draining its existing shared leases. Both
	// acquisitions share one budget; an earlier caller deadline/cancellation wins.
	admissionCtx, cancelAdmission := context.WithTimeout(ctx, 60*time.Second)
	defer cancelAdmission()
	gate, err := b.lockFile(admissionCtx, "core-admission.flock", syscall.LOCK_EX, true)
	if err != nil {
		return fmt.Errorf("candidate admission lock core-admission.flock: %w", err)
	}
	defer gate()
	lease, err := b.lockFile(admissionCtx, "core-lifecycle.flock", syscall.LOCK_EX, true)
	if err != nil {
		return fmt.Errorf("candidate lifecycle lock core-lifecycle.flock: %w", err)
	}
	defer lease()
	if err := admissionCtx.Err(); err != nil {
		return err
	}
	cancelAdmission() // The budget bounds admission, not the existing action body.
	firstDeployUnlock, err := lockCandidateFirstDeploy(m.baselineObservations())
	if err != nil {
		return err
	}
	defer firstDeployUnlock()
	if err := m.candidateTransitionReady(ctx, m.baselineObservations().Capture); err != nil {
		return err
	}
	return run()
}
func (m SpineCandidateManager) candidateTransitionReady(ctx context.Context, capture func(context.Context, string, ...string) ([]byte, error)) error {
	manager, b := m.core(), m.barrier()
	hostRaw, hostErr := candidateProtectedRead(filepath.Join(filepath.Dir(manager.Root), "system-update", "journal.json"), 1<<20)
	if hostErr != nil && !errors.Is(hostErr, os.ErrNotExist) {
		return hostErr
	}
	if hostErr == nil {
		var host Journal
		if candidateJSON(hostRaw, &host) != nil || host.Validate() != nil || (host.Phase != PhaseHealthy && host.Phase != PhaseRollback) {
			return fmt.Errorf("retained native host transaction must settle before candidate binding")
		}
	}
	if _, err := b.Read(); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("System lifecycle reservation requires reconciliation")
	}
	if _, err := b.ReadCopy(); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("independent copy requires reconciliation")
	}
	if err := b.checkQuiescent(); err != nil {
		return err
	}
	if _, err := manager.readBootstrap(); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("registered signed production coordinator cannot be replaced by a test candidate")
	}
	j, err := manager.Read()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && !manager.TransactionComplete(j) {
		return fmt.Errorf("retained native System request is unfinished")
	}
	units, err := capture(ctx, "systemctl", "list-units", "--all", "--type=service", "--no-legend", "--plain", "youeye-core-*.service")
	if err != nil {
		return fmt.Errorf("native controller/action liveness unavailable")
	}
	for _, line := range strings.Split(string(units), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if len(fields) < 4 {
			return fmt.Errorf("native controller/action state unknown")
		}
		if fields[2] != "inactive" && !(fields[2] == "active" && fields[3] == "exited") {
			return fmt.Errorf("native controller/action must settle before candidate binding")
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}
func (m SpineCandidateManager) NewBinding(request SpineCandidateRequest) (SpineCandidateBinding, error) {
	return m.NewBindingContext(context.Background(), request)
}

func (m SpineCandidateManager) NewBindingContext(ctx context.Context, request SpineCandidateRequest) (SpineCandidateBinding, error) {
	if err := ctx.Err(); err != nil {
		return SpineCandidateBinding{}, err
	}
	if err := m.VerifySet(request); err != nil {
		return SpineCandidateBinding{}, err
	}
	baseline, err := m.baselineContext(ctx, request.Identity, true)
	if err != nil {
		return SpineCandidateBinding{}, err
	}
	if err := ctx.Err(); err != nil {
		return SpineCandidateBinding{}, err
	}
	return SpineCandidateBinding{Schema: SpineCandidateBindingSchema, CandidateID: request.CandidateID, ArtifactSHA256: request.ArtifactSHA256, SourceCommit: request.SourceCommit, Root: request.Root, HardwareUUID: baseline.HardwareUUID, InstalledManifestSHA256: baseline.ManifestSHA256, ActivatedAt: time.Now().UTC(), BaselineKind: baseline.Kind, BaselineMachine: baseline.Machine, FrozenMediaSHA256: baseline.FrozenMediaSHA256}, nil
}
func (m SpineCandidateManager) WriteBinding(b SpineCandidateBinding) error {
	if err := candidateProtectedDirectory(m.root()); err != nil {
		return err
	}
	if _, err := os.Lstat(m.BindingPath()); !os.IsNotExist(err) {
		return fmt.Errorf("candidate binding already exists or is unreadable")
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	return atomicWrite(m.BindingPath(), append(raw, '\n'), 0600)
}
