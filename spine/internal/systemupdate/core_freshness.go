package systemupdate

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

// Only observed transport unavailability can use the explicitly selected media
// preference. Invalid signatures, expired catalogs, bad clocks, revocations,
// malformed responses and missing releases never become an offline fallback.
func coreDiscoveryUnavailable(err error) bool {
	var dns *net.DNSError
	return errors.As(err, &dns) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ETIMEDOUT) || errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH)
}

func (a NativeCoreAuthority) allowOfflineFirstBoot(j CoreJournal) (bool, error) {
	if !j.NoOp || a.FirstBootPolicyPath == "" || a.FirstBootCompletePath == "" {
		return false, nil
	}
	if !filepath.IsAbs(a.FirstBootPolicyPath) || !filepath.IsAbs(a.FirstBootCompletePath) {
		return false, fmt.Errorf("protected first-boot paths required")
	}
	if _, err := os.Lstat(a.FirstBootCompletePath); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	raw, err := ReadCoreState(filepath.Join(a.Checkpoint.Root, "first-boot.json"), 16384)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var record CoreFirstBootSelection
	if json.Unmarshal(raw, &record) != nil {
		return false, fmt.Errorf("first-boot selection is damaged")
	}
	if !record.OfflineBaseline {
		return false, nil
	}
	if record.Schema != "youeye.core-first-boot.v1" || record.RequestID != coreFirstBootRequest(record) || record.RequestID != j.RequestID || record.ManifestSHA256 != j.ManifestSHA256 || record.BaselineSHA256 != j.ManifestSHA256 || record.Machine != j.Previous.Machine {
		return false, fmt.Errorf("offline first-boot identity changed")
	}
	raw, err = ReadCoreState(a.FirstBootPolicyPath, 16384)
	if err != nil {
		return false, err
	}
	var policy ReleasePolicy
	if json.Unmarshal(raw, &policy) != nil || policy.Validate() != nil || policy.Freshness != "prefer-current" || policy.Mode == "exact" {
		return false, fmt.Errorf("offline media preference is not authorized")
	}
	canonical, _ := json.Marshal(policy)
	if fmt.Sprintf("%x", sha256.Sum256(canonical)) != record.PolicySHA256 || ValidateCorePolicy(policy, j.Target, j.ManifestSHA256) != nil {
		return false, fmt.Errorf("offline policy differs from frozen baseline")
	}
	return true, nil
}
