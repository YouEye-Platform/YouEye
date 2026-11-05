package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

const spineCandidateDropIn = "/run/systemd/system/youeye.service.d/91-signed-spine-candidate.conf"
const spineCandidateOverlay = "/run/youeye/development-overlay/spine.json"

func init() {
	development := &cobra.Command{Use: "development", Short: "Explicit appliance development operations"}
	candidate := &cobra.Command{Use: "spine-candidate", Short: "Verify and bind an exact signed standalone Spine for development testing"}
	for _, action := range []string{"activate", "status", "deactivate", "verify-core", "reconcile-baseline"} {
		action := action
		var request systemupdate.SpineCandidateRequest
		command := &cobra.Command{Use: action, Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
			ctx, cancel := context.WithTimeout(cmd.Context(), 10*time.Minute)
			defer cancel()
			if request.Root == "" {
				request.Root = filepath.Join(systemupdate.SpineCandidateRoot, request.ArtifactSHA256)
			}
			m := systemupdate.SpineCandidateManager{}
			if action == "deactivate" {
				binding, err := m.ReadBinding()
				if err != nil {
					return err
				}
				request.SourceCommit = binding.SourceCommit
			}
			if err := verifyCandidateInvocation(m, request); err != nil {
				return err
			}
			switch action {
			case "activate":
				if err := activateSpineCandidate(ctx, m, request); err != nil {
					return err
				}
				status, err := spineCandidateStatus(ctx, m, request)
				if err != nil {
					return err
				}
				return json.NewEncoder(cmd.OutOrStdout()).Encode(status)
			case "status":
				status, err := spineCandidateStatus(ctx, m, request)
				if err != nil {
					return err
				}
				return json.NewEncoder(cmd.OutOrStdout()).Encode(status)
			case "deactivate":
				if err := deactivateSpineCandidate(ctx, m, request); err != nil {
					return err
				}
				return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"candidate_id": request.CandidateID, "state": "deactivated", "installed_system_unchanged": true})
			case "verify-core":
				result, err := verifyCandidateCore(ctx, m, request)
				if err != nil {
					return err
				}
				return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
			case "reconcile-baseline":
				binding, err := m.ReadBinding()
				if err != nil {
					return err
				}
				if err := candidateBindingMatches(binding, request); err != nil {
					return err
				}
				if err := candidateFileMatches(spineCandidateDropIn, candidateOverride(filepath.Join(binding.Root, systemupdate.SpineCandidateArtifact))); err != nil {
					return err
				}
				if err := candidateFileMatches(spineCandidateOverlay, candidateOverlayBytes(binding)); err != nil {
					return err
				}
				hash, err := candidateAPIHash(ctx)
				if err != nil || hash != binding.ArtifactSHA256 {
					return fmt.Errorf("actual API differs from exact candidate before baseline reconciliation")
				}
				if _, err := m.ReconcileBaseline(ctx, request); err != nil {
					return err
				}
				status, err := spineCandidateStatus(ctx, m, request)
				if err != nil {
					return err
				}
				return json.NewEncoder(cmd.OutOrStdout()).Encode(status)
			}
			return fmt.Errorf("unknown candidate operation")
		}}
		command.Flags().StringVar(&request.CandidateID, "candidate-id", "", "exact retained nonpublishable Spine candidate identity")
		command.Flags().StringVar(&request.ArtifactSHA256, "sha256", "", "reviewed original signed Spine artifact digest")
		command.Flags().StringVar(&request.Identity, "identity", "", "exact target SMBIOS UUID")
		if action != "deactivate" {
			command.Flags().StringVar(&request.SourceCommit, "source-commit", "", "original private source commit authenticated by signed provenance")
		}
		if action == "activate" {
			command.Flags().StringVar(&request.Root, "root", "", "protected content-addressed six-file signed component set")
		}
		candidate.AddCommand(command)
	}
	development.AddCommand(candidate)
	rootCmd.AddCommand(development)
}

func verifyCandidateInvocation(m systemupdate.SpineCandidateManager, r systemupdate.SpineCandidateRequest) error {
	if err := m.VerifySet(r); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if filepath.Clean(self) != filepath.Join(r.Root, systemupdate.SpineCandidateArtifact) {
		return fmt.Errorf("candidate command must run from its exact protected original artifact path")
	}
	digest, err := fileSHA256("/proc/self/exe")
	if err != nil || digest != r.ArtifactSHA256 {
		return fmt.Errorf("executing candidate bytes differ from signed artifact")
	}
	if _, err := systemupdate.NormalizeSpineCandidateHardware(r.Identity); err != nil {
		return err
	}
	return nil
}
func candidateOverride(executable string) []byte {
	return []byte("[Service]\n# Explicit signed standalone Spine development binding\nExecStart=\nExecStart=" + executable + " api serve\n")
}
func candidateFileMatches(path string, want []byte) error {
	raw, err := systemupdate.ReadCoreState(path, 16384)
	if err != nil {
		return err
	}
	if !bytes.Equal(raw, want) {
		return fmt.Errorf("candidate-owned runtime override differs")
	}
	return nil
}
func candidateWriteNew(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	info, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || int(stat.Uid) != os.Geteuid() || info.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("unsafe candidate runtime directory")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return fmt.Errorf("candidate runtime path already exists or is unreadable")
	}
	return writeNewProtectedFile(path, data)
}
func candidateWriteOwned(path string, data []byte) error {
	err := candidateFileMatches(path, data)
	if err == nil {
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return candidateWriteNew(path, data)
}
func candidateRemoveOwned(path string, data []byte) error {
	err := candidateFileMatches(path, data)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return os.Remove(path)
}
func candidateOverlayBytes(b systemupdate.SpineCandidateBinding) []byte {
	raw, _ := json.Marshal(map[string]any{"schema": "youeye.development-overlay-runtime.v1", "component": "spine", "state": "active", "unsigned": false, "signed": true, "development": true, "nonpublishable": true, "artifact_id": b.CandidateID, "source_commit": b.SourceCommit, "sha256": b.ArtifactSHA256})
	return append(raw, '\n')
}
func candidateSystemctl(ctx context.Context, args ...string) error {
	if err := exec.CommandContext(ctx, "systemctl", args...).Run(); err != nil {
		return fmt.Errorf("candidate API service operation failed: %w", err)
	}
	return nil
}
func candidateAPIHash(ctx context.Context) (string, error) {
	raw, err := exec.CommandContext(ctx, "systemctl", "show", "--property=ActiveState,SubState,MainPID", "youeye.service").Output()
	if err != nil {
		return "", fmt.Errorf("actual API service unavailable")
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		kv := strings.SplitN(line, "=", 2)
		if len(kv) == 2 {
			values[kv[0]] = kv[1]
		}
	}
	pid, err := strconv.Atoi(values["MainPID"])
	if err != nil || pid < 1 || values["ActiveState"] != "active" || values["SubState"] != "running" {
		return "", fmt.Errorf("API service does not have a running MainPID")
	}
	digest, err := fileSHA256(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return "", fmt.Errorf("actual API executable cannot be hashed")
	}
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/youeye/youeye.sock")
	}}}
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://unix/api/health", nil)
	if err != nil {
		return "", err
	}
	response, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("actual candidate API socket health unavailable")
	}
	defer response.Body.Close()
	var health struct {
		Status string `json:"status"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&health) != nil || health.Status != "ok" {
		return "", fmt.Errorf("API socket health failed")
	}
	after, err := exec.CommandContext(ctx, "systemctl", "show", "--property=MainPID", "--value", "youeye.service").Output()
	if err != nil || strings.TrimSpace(string(after)) != strconv.Itoa(pid) {
		return "", fmt.Errorf("API MainPID changed during health verification")
	}
	return digest, nil
}
func candidateWaitAPI(ctx context.Context, want string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		hash, err := candidateAPIHash(ctx)
		if err == nil && hash == want {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("actual API executable/socket did not converge to expected signed bytes")
		case <-time.After(200 * time.Millisecond):
		}
	}
}
func candidateBindingMatches(b systemupdate.SpineCandidateBinding, r systemupdate.SpineCandidateRequest) error {
	want, err := systemupdate.NormalizeSpineCandidateHardware(r.Identity)
	if err != nil {
		return err
	}
	if b.CandidateID != r.CandidateID || b.ArtifactSHA256 != r.ArtifactSHA256 || b.SourceCommit != r.SourceCommit || b.Root != r.Root || b.HardwareUUID != want {
		return fmt.Errorf("exact candidate, source and hardware binding required")
	}
	return nil
}

// Older status readers understand committed membership only. A binding that
// began as frozen media retains v2 after reconciliation, preserving its explicit
// baseline meaning instead of relying on ignored additive v1 fields.
func spineCandidateStatusIdentity(b systemupdate.SpineCandidateBinding) (schema, kind string, err error) {
	kind = b.BaselineKind
	if kind == "" {
		kind = "committed"
	}
	if kind != "committed" && kind != "frozen-media" {
		return "", "", fmt.Errorf("unknown candidate status baseline")
	}
	if kind == "frozen-media" || b.FrozenMediaSHA256 != "" {
		if b.BaselineKind == "" || b.BaselineMachine.Validate() != nil || !coreReaderDigest.MatchString(b.FrozenMediaSHA256) {
			return "", "", fmt.Errorf("versioned candidate status requires exact frozen-media evidence")
		}
		return systemupdate.SpineCandidateStatusSchemaV2, kind, nil
	}
	return systemupdate.SpineCandidateStatusSchema, kind, nil
}

func spineCandidateStatus(ctx context.Context, m systemupdate.SpineCandidateManager, r systemupdate.SpineCandidateRequest) (systemupdate.SpineCandidateStatus, error) {
	var status systemupdate.SpineCandidateStatus
	b, err := m.VerifyBindingContext(ctx)
	if err != nil {
		return status, err
	}
	if err := candidateBindingMatches(b, r); err != nil {
		return status, err
	}
	if err := candidateFileMatches(spineCandidateDropIn, candidateOverride(filepath.Join(b.Root, systemupdate.SpineCandidateArtifact))); err != nil {
		return status, err
	}
	hash, err := candidateAPIHash(ctx)
	if err != nil || hash != b.ArtifactSHA256 {
		return status, fmt.Errorf("actual API process/socket differs from signed candidate")
	}
	after, err := m.VerifyBindingContext(ctx)
	if err != nil || after != b {
		return status, fmt.Errorf("candidate binding changed during runtime observation")
	}
	status.Schema, status.BaselineKind, err = spineCandidateStatusIdentity(b)
	if err != nil {
		return status, err
	}
	status.Binding = b
	status.API.Healthy, status.API.ArtifactSHA256 = true, hash
	return status, nil
}
func activateSpineCandidate(ctx context.Context, m systemupdate.SpineCandidateManager, r systemupdate.SpineCandidateRequest) error {
	return m.WithQuiescent(ctx, func() error {
		b, err := m.ReadBinding()
		fresh := errors.Is(err, os.ErrNotExist)
		if err != nil && !fresh {
			return err
		}
		if !fresh {
			if _, err := m.VerifyBindingContext(ctx); err != nil {
				return err
			}
			if err := candidateBindingMatches(b, r); err != nil {
				return err
			}
		}
		if _, err := os.Lstat("/run/systemd/system/youeye.service.d/90-youeye-development-spine.conf"); !os.IsNotExist(err) {
			return fmt.Errorf("another development override exists; reconcile it first")
		}
		if fresh {
			for _, path := range []string{spineCandidateDropIn, spineCandidateOverlay} {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					return fmt.Errorf("unowned candidate runtime path already exists")
				}
			}
		}
		if !fresh {
			if _, err := spineCandidateStatus(ctx, m, r); err == nil {
				return nil
			}
		}
		baseline, err := fileSHA256("/usr/local/bin/youeye")
		if err != nil {
			return err
		}
		if fresh {
			if err := candidateWaitAPI(ctx, baseline); err != nil {
				return fmt.Errorf("baked API baseline must be healthy before candidate binding: %w", err)
			}
		}
		if fresh {
			b, err = m.NewBindingContext(ctx, r)
			if err != nil {
				return err
			}
			if err := m.WriteBinding(b); err != nil {
				return err
			}
		}
		executable := filepath.Join(b.Root, systemupdate.SpineCandidateArtifact)
		if err := candidateWriteOwned(spineCandidateDropIn, candidateOverride(executable)); err != nil {
			return err
		}
		if err := candidateWriteOwned(spineCandidateOverlay, candidateOverlayBytes(b)); err != nil {
			return err
		}
		if err := candidateSystemctl(ctx, "daemon-reload"); err != nil {
			return err
		}
		if err := candidateSystemctl(ctx, "restart", "youeye.service"); err != nil {
			return err
		}
		return candidateWaitAPI(ctx, b.ArtifactSHA256)
	})
}
func deactivateSpineCandidate(ctx context.Context, m systemupdate.SpineCandidateManager, r systemupdate.SpineCandidateRequest) error {
	return m.WithQuiescent(ctx, func() error {
		b, err := m.VerifyBindingContext(ctx)
		if err != nil {
			return err
		}
		if err := candidateBindingMatches(b, r); err != nil {
			return err
		}
		baseline, err := fileSHA256("/usr/local/bin/youeye")
		if err != nil {
			return err
		}
		if err := candidateRemoveOwned(spineCandidateDropIn, candidateOverride(filepath.Join(b.Root, systemupdate.SpineCandidateArtifact))); err != nil {
			return err
		}
		if err := candidateRemoveOwned(spineCandidateOverlay, candidateOverlayBytes(b)); err != nil {
			return err
		}
		if err := candidateSystemctl(ctx, "daemon-reload"); err != nil {
			return err
		}
		if err := candidateSystemctl(ctx, "restart", "youeye.service"); err != nil {
			return err
		}
		if err := candidateWaitAPI(ctx, baseline); err != nil {
			return err
		}
		return os.Remove(m.BindingPath())
	})
}

type spineCandidateCoreVerification struct {
	Schema              string   `json:"schema"`
	CandidateID         string   `json:"candidate_id"`
	ManifestSHA256      string   `json:"manifest_sha256"`
	Version             string   `json:"version"`
	Roles               []string `json:"roles"`
	Cold                bool     `json:"cold"`
	NativeIntentCreated bool     `json:"native_intent_created"`
	CacheRemoved        bool     `json:"cache_removed"`
}

func verifyCandidateCore(ctx context.Context, m systemupdate.SpineCandidateManager, r systemupdate.SpineCandidateRequest) (out spineCandidateCoreVerification, resultErr error) {
	before, err := m.VerifyBindingContext(ctx)
	if err != nil {
		return out, err
	}
	if err := candidateBindingMatches(before, r); err != nil {
		return out, err
	}
	if _, err := spineCandidateStatus(ctx, m, r); err != nil {
		return out, err
	}
	lease, err := (systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}).AdmitOrdinary()
	if err != nil {
		return out, err
	}
	defer lease()
	selection, err := currentCoreSelection()
	if err != nil {
		return out, err
	}
	ctx = releasecache.UncachedVerification(ctx)
	cacheRoot, err := os.MkdirTemp(systemupdate.SpineCandidateRoot, ".verify-core-"+r.CandidateID+"-")
	if err != nil {
		return out, err
	}
	defer func() {
		if err := os.RemoveAll(cacheRoot); err != nil {
			if resultErr == nil {
				resultErr = fmt.Errorf("cold verification cache cleanup requires reconciliation: %w", err)
			} else {
				resultErr = fmt.Errorf("%v; cold cache cleanup requires reconciliation: %w", resultErr, err)
			}
			out.CacheRemoved = false
		} else {
			out.CacheRemoved = true
		}
	}()
	signed, release, digest, err := systemupdate.ResolveCoreReleaseWithMetadata(ctx, systemupdate.ReleaseHTTPClient(), selection, systemupdate.CoreDevelopmentTrustPath, cacheRoot)
	if err != nil {
		return out, err
	}
	cache := systemupdate.NewRuntimeCoreArtifactCache(cacheRoot, systemupdate.CoreDevelopmentTrustPath)
	if _, actual, err := cache.StageFreshServices(ctx, signed); err != nil {
		return out, err
	} else if actual != digest {
		return out, fmt.Errorf("cold service verification selection changed")
	}
	after, err := m.VerifyBindingContext(ctx)
	if err != nil || after != before {
		return out, fmt.Errorf("candidate or installed baseline changed during cold verification")
	}
	out = spineCandidateCoreVerification{Schema: "youeye.spine-candidate-core-verification.v1", CandidateID: r.CandidateID, ManifestSHA256: digest, Version: release.Version, Roles: []string{"cp", "ui"}, Cold: true, NativeIntentCreated: false, CacheRemoved: false}
	return out, nil
}
