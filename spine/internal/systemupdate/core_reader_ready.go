package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const CoreReaderReadySchema = "youeye.core-reader-ready.v1"

var ErrCoreReaderUnsupported = errors.New("selected Spine does not advertise the managed reader contract")
var ErrCoreReaderBusy = errors.New("reader acquisition is already in progress")
var coreReaderRequiredCapabilities = []string{"core-release-v1", "core-metadata-pair-v2", "core-control-v1", "bootstrap-state-v1"}

type CoreReaderReady struct {
	Schema                  string              `json:"schema"`
	State                   string              `json:"state"`
	ManifestSHA256          string              `json:"manifest_sha256"`
	ArtifactSHA256          string              `json:"artifact_sha256"`
	Executable              string              `json:"executable"`
	Version                 string              `json:"version"`
	Capabilities            []string            `json:"capabilities"`
	InstalledManifestSHA256 string              `json:"installed_manifest_sha256"`
	Machine                 CoreMachineIdentity `json:"machine"`
	HardwareUUID            string              `json:"hardware_uuid"`
	VerifiedAt              string              `json:"verified_at"`
}
type CoreReaderReadiness struct {
	Manager     CoreManager
	Cache       CoreArtifactCache
	Checkpoint  NativeCoreCheckpoint
	Hardware    func() (string, error)
	Quiescent   func(context.Context, func() error) error
	BeforeReady func() error // Owned fault/recovery seam; never supplied by an API caller.
}

func (r CoreReaderReadiness) path() string { return filepath.Join(r.Manager.Root, "reader-ready.json") }

// Lease excludes retargeting through an exact verify/prepare/register boundary.
func (r CoreReaderReadiness) Lease() (func(), error) {
	if !filepath.IsAbs(r.Manager.Root) {
		return nil, fmt.Errorf("absolute protected reader state required")
	}
	if err := os.MkdirAll(r.Manager.Root, 0700); err != nil {
		return nil, err
	}
	if err := candidateProtectedDirectory(r.Manager.Root); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(r.Manager.Root, "reader-ready.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || int(stat.Uid) != os.Geteuid() || stat.Nlink != 1 || info.Size() != 0 {
		file.Close()
		return nil, fmt.Errorf("unsafe reader acquisition lease")
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, ErrCoreReaderBusy
	}
	return func() { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN); _ = file.Close() }, nil
}
func CoreReaderEligible(target releasecache.CoreRelease, installed CoreReceipt) bool {
	if target.Source != releasecache.OfficialRepository || target.Branch != "main" || target.Channel != "stable" {
		return false
	}
	member, err := coreServiceMember(target, "spine")
	if err != nil || member.Source != releasecache.OfficialRepository || member.Branch != "main" || member.Artifact.SizeBytes > 128<<20 {
		return false
	}
	channel, err := releasecache.CoreMemberChannel(member, target.Channel)
	if err != nil || channel != "stable" {
		return false
	}
	previous, err := coreServiceMember(installed.Release, "spine")
	return err == nil && previous.Artifact.SHA256 != member.Artifact.SHA256
}
func (r CoreReaderReadiness) hardware() (string, error) {
	if r.Hardware != nil {
		return r.Hardware()
	}
	return SpineCandidateHardware()
}
func (r CoreReaderReadiness) machine() (CoreMachineIdentity, error) {
	p := r.Checkpoint
	if p.Root == "" {
		p.Root = r.Manager.Root
	}
	if p.StatePath == "" {
		p.StatePath = appliance.StatePath
	}
	return p.observeMachine()
}
func (r CoreReaderReadiness) guard(ctx context.Context, run func() error) error {
	if r.Quiescent != nil {
		return r.Quiescent(ctx, run)
	}
	return (SpineCandidateManager{CoreRoot: r.Manager.Root}).WithQuiescent(ctx, run)
}
func (r CoreReaderReadiness) installed() (CoreReceipt, string, error) {
	installed, err := r.Manager.ReadReceipt()
	if err != nil {
		return installed, "", err
	}
	machine, err := r.machine()
	if err != nil || machine != installed.Machine {
		return installed, "", fmt.Errorf("current machine differs from committed System baseline")
	}
	hardware, err := r.hardware()
	if err != nil {
		return installed, "", err
	}
	hardware, err = NormalizeSpineCandidateHardware(hardware)
	return installed, hardware, err
}
func (r CoreReaderReadiness) Read() (CoreReaderReady, error) {
	var ready CoreReaderReady
	raw, err := candidateProtectedRead(r.path(), 32768)
	if err != nil {
		return ready, err
	}
	if err := candidateJSON(raw, &ready); err != nil {
		return ready, err
	}
	if ready.Schema != CoreReaderReadySchema || ready.State != "ready" || !validSHA256(ready.ManifestSHA256) || !validSHA256(ready.ArtifactSHA256) || !validSHA256(ready.InstalledManifestSHA256) || ready.Machine.Validate() != nil || ready.VerifiedAt == "" {
		return ready, fmt.Errorf("invalid protected reader readiness record")
	}
	file, err := r.Manager.BootstrapBinaryPath(ready.ArtifactSHA256)
	if err != nil || file != ready.Executable {
		return ready, fmt.Errorf("reader readiness executable differs")
	}
	return ready, nil
}
func readerCapabilities(path string, member releasecache.CoreMember) ([]string, error) {
	raw, err := candidateProtectedRead(path, 1<<20)
	if err != nil {
		return nil, err
	}
	var provenance struct {
		Component, Version string
		SourceCommit       string   `json:"source_commit"`
		ReaderCapabilities []string `json:"reader_capabilities"`
	}
	if json.Unmarshal(raw, &provenance) != nil || provenance.Component != "spine" || provenance.Version != member.BuildVersion || provenance.SourceCommit != member.SourceCommit {
		return nil, ErrCoreReaderUnsupported
	}
	seen := map[string]bool{}
	if len(provenance.ReaderCapabilities) > 64 {
		return nil, ErrCoreReaderUnsupported
	}
	for _, capability := range provenance.ReaderCapabilities {
		if capability == "" || len(capability) > 128 || strings.ContainsAny(capability, "\r\n\x00") || seen[capability] {
			return nil, ErrCoreReaderUnsupported
		}
		seen[capability] = true
	}
	for _, required := range coreReaderRequiredCapabilities {
		if !seen[required] {
			return nil, ErrCoreReaderUnsupported
		}
	}
	return provenance.ReaderCapabilities, nil
}
func (r CoreReaderReadiness) Verify(ready CoreReaderReady, selection CoreHostSelection, digest string) (CoreReaderReady, error) {
	target, actual, err := VerifyCoreSelection(selection.Raw, selection.Signature, r.Cache.TrustKeyPath)
	if err != nil || actual != digest || ready.ManifestSHA256 != digest {
		return ready, fmt.Errorf("ready reader differs from exact authenticated selection")
	}
	installed, hardware, err := r.installed()
	if err != nil {
		return ready, err
	}
	if !CoreReaderEligible(target, installed) || ready.InstalledManifestSHA256 != installed.ManifestSHA256 || ready.Machine != installed.Machine || ready.HardwareUUID != hardware {
		return ready, fmt.Errorf("reader readiness is stale for this installed machine/selection")
	}
	member, err := coreServiceMember(target, "spine")
	if err != nil || member.Artifact.SHA256 != ready.ArtifactSHA256 || member.BuildVersion != ready.Version {
		return ready, fmt.Errorf("ready reader is not the exact target Spine")
	}
	for _, m := range target.Members {
		if err := CheckCoreMemberAuthority(m, target.Channel, r.Cache.TrustKeyPath); err != nil {
			return ready, err
		}
	}
	if err := r.Manager.VerifyBootstrapReader(ready.Executable, digest, r.Cache.TrustKeyPath); err != nil {
		return ready, err
	}
	proof, err := candidateProtectedRead(filepath.Join(filepath.Dir(ready.Executable), CoreMetadataProofName), CoreMetadataProofMaxBytes)
	if err != nil {
		return ready, err
	}
	selection.MetadataProof = proof
	if _, err := VerifyCoreSelectionMetadata(selection, r.Cache.TrustKeyPath); err != nil {
		return ready, err
	}
	capabilities, err := readerCapabilities(filepath.Join(filepath.Dir(ready.Executable), "provenance"), member)
	if err != nil {
		return ready, err
	}
	if !reflect.DeepEqual(capabilities, ready.Capabilities) {
		return ready, fmt.Errorf("ready reader capability evidence changed")
	}
	return ready, nil
}
func (r CoreReaderReadiness) Current(selection CoreHostSelection, digest string) (CoreReaderReady, error) {
	ready, err := r.Read()
	if err != nil {
		return ready, err
	}
	return r.Verify(ready, selection, digest)
}

// Acquire stages immutable signed inputs only. It never calls retainSelection,
// Prepare, RegisterBootstrap or a slot/boot operation. Only actual Stage may
// turn a verified ready reader into the target-bound native coordinator.
func (r CoreReaderReadiness) Acquire(ctx context.Context, selection CoreHostSelection, digest string) (CoreReaderReady, error) {
	var ready CoreReaderReady
	target, actual, err := VerifyCoreSelection(selection.Raw, selection.Signature, r.Cache.TrustKeyPath)
	if err != nil {
		return ready, err
	}
	if actual != digest {
		return ready, fmt.Errorf("reader acquisition selection digest changed")
	}
	selection, _, err = EnsureCoreMetadata(ctx, selection, r.Cache.TrustKeyPath, r.Cache.Root, r.Cache.Client, "")
	if err != nil {
		return ready, err
	}
	installed, hardware, err := r.installed()
	if err != nil {
		return ready, err
	}
	if !CoreReaderEligible(target, installed) {
		return ready, ErrCoreReaderUnsupported
	}
	if existing, err := r.Current(selection, digest); err == nil {
		return existing, nil
	}
	unlock, err := r.Lease()
	if err != nil {
		return ready, err
	}
	defer unlock()
	if existing, err := r.Current(selection, digest); err == nil {
		return existing, nil
	}
	if err := r.guard(ctx, func() error { return nil }); err != nil {
		return ready, err
	}
	staged, stagedDigest, err := r.Cache.StageReader(ctx, selection)
	if err != nil {
		return ready, err
	}
	if stagedDigest != digest || !reflect.DeepEqual(staged, target) {
		return ready, fmt.Errorf("reader staging changed authenticated selection")
	}
	member, err := coreServiceMember(target, "spine")
	if err != nil {
		return ready, err
	}
	provenancePath, err := r.Cache.Path(member.Provenance)
	if err != nil {
		return ready, err
	}
	capabilities, err := readerCapabilities(provenancePath, member)
	if err != nil {
		return ready, err
	}
	file, err := r.Manager.BootstrapBinaryPath(member.Artifact.SHA256)
	if err != nil {
		return ready, err
	}
	ready = CoreReaderReady{Schema: CoreReaderReadySchema, State: "ready", ManifestSHA256: digest, ArtifactSHA256: member.Artifact.SHA256, Executable: file, Version: member.BuildVersion, Capabilities: capabilities, InstalledManifestSHA256: installed.ManifestSHA256, Machine: installed.Machine, HardwareUUID: hardware, VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	err = r.guard(ctx, func() error {
		after, afterHardware, err := r.installed()
		if err != nil || !reflect.DeepEqual(after, installed) || afterHardware != hardware {
			return fmt.Errorf("installed machine/baseline changed during reader acquisition")
		}
		if err := r.retainReader(selection, target, file); err != nil {
			return err
		}
		if _, err := r.Verify(ready, selection, digest); err != nil {
			return err
		}
		if r.BeforeReady != nil {
			if err := r.BeforeReady(); err != nil {
				return err
			}
		}
		raw, err := json.Marshal(ready)
		if err != nil {
			return err
		}
		return atomicWrite(r.path(), append(raw, '\n'), 0600)
	})
	return ready, err
}
func (r CoreReaderReadiness) retainReader(selection CoreHostSelection, target releasecache.CoreRelease, file string) error {
	root := filepath.Dir(file)
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	if err := r.Manager.verifyBootstrapDirectories(file); err != nil {
		return err
	}
	member, err := coreServiceMember(target, "spine")
	if err != nil {
		return err
	}
	for name, blob := range map[string]releasecache.CoreBlob{"youeye": member.Artifact, "checksums": member.Checksums, "signature": member.Signature, "provenance": member.Provenance, "sbom": member.SBOM} {
		destination := filepath.Join(root, name)
		if _, err := os.Lstat(destination); err == nil {
			if err := verifyFile(destination, blob.SizeBytes, blob.SHA256); err != nil {
				return fmt.Errorf("retained original reader asset conflicts")
			}
			if _, err := candidateProtectedRead(destination, 128<<20); err != nil {
				return err
			}
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		input, err := r.Cache.open(blob)
		if err != nil {
			return err
		}
		raw, readErr := io.ReadAll(io.LimitReader(input, blob.SizeBytes+1))
		input.Close()
		if readErr != nil {
			return readErr
		}
		if int64(len(raw)) != blob.SizeBytes || candidateHash(raw) != blob.SHA256 {
			return fmt.Errorf("verified reader cache changed before retention")
		}
		mode := os.FileMode(0400)
		if name == "youeye" {
			mode = 0500
		}
		if err := atomicWrite(destination, raw, mode); err != nil {
			return err
		}
	}
	// These are selection wrappers around unchanged original Spine evidence.
	// Retargeting them is guarded by complete native lifecycle quiescence.
	if err := atomicWrite(filepath.Join(root, "core-release.json"), selection.Raw, 0400); err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(root, "core-release.json.sig"), selection.Signature, 0400); err != nil {
		return err
	}
	if _, err := VerifyCoreSelectionMetadata(selection, r.Cache.TrustKeyPath); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(root, CoreMetadataProofName), selection.MetadataProof, 0400)
}
