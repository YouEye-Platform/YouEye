package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
)

type CoreFirstBootSelection struct {
	Schema          string              `json:"schema"`
	RequestID       string              `json:"request_id"`
	PolicySHA256    string              `json:"policy_sha256"`
	BaselineSHA256  string              `json:"baseline_sha256"`
	ManifestSHA256  string              `json:"manifest_sha256"`
	OfflineBaseline bool                `json:"offline_baseline,omitempty"`
	Machine         CoreMachineIdentity `json:"machine"`
}

// FreezeFirstBoot starts only from a verified fresh baseline. It retains one
// complete signed target before creating a normal core transaction. A restart
// never selects a newer head or replaces the installer/baseline provenance.
func (m CoreManager) FreezeFirstBoot(ctx context.Context, policy ReleasePolicy, baseline CoreHostSelection, trust string, resolve func(context.Context) (CoreHostSelection, error)) (CoreFirstBootSelection, CoreHostSelection, error) {
	var record CoreFirstBootSelection
	unlock, err := m.lockCore()
	if err != nil {
		return record, CoreHostSelection{}, err
	}
	defer unlock()
	initial, initialDigest, err := VerifyCoreSelection(baseline.Raw, baseline.Signature, trust)
	if err != nil {
		return record, CoreHostSelection{}, err
	}
	if err = ValidateCorePolicy(policy, initial, initialDigest); err != nil {
		return record, CoreHostSelection{}, err
	}
	policyRaw, _ := json.Marshal(policy)
	policyDigest := fmt.Sprintf("%x", sha256.Sum256(policyRaw))
	installed, err := m.ReadReceipt()
	if err != nil {
		return record, CoreHostSelection{}, err
	}
	path := filepath.Join(m.Root, "first-boot.json")
	raw, err := ReadCoreState(path, 16384)
	if err == nil {
		if json.Unmarshal(raw, &record) != nil || record.Schema != "youeye.core-first-boot.v1" || record.PolicySHA256 != policyDigest || record.BaselineSHA256 != initialDigest || record.Machine != installed.Machine || !validSHA256(record.ManifestSHA256) || record.RequestID != coreFirstBootRequest(record) {
			return record, CoreHostSelection{}, fmt.Errorf("first-boot selection differs from installed policy or machine")
		}
		selected, _, err := m.Selection(record.ManifestSHA256, trust)
		if installed.ManifestSHA256 != record.BaselineSHA256 && installed.ManifestSHA256 != record.ManifestSHA256 {
			return record, CoreHostSelection{}, fmt.Errorf("installed release advanced outside first boot")
		}
		return record, selected, err
	}
	if !errors.Is(err, os.ErrNotExist) {
		return record, CoreHostSelection{}, err
	}
	if installed.ManifestSHA256 != initialDigest || !reflect.DeepEqual(installed.Release, initial) {
		return record, CoreHostSelection{}, fmt.Errorf("first boot requires its exact initialized media baseline")
	}
	if _, err = m.Read(); !errors.Is(err, os.ErrNotExist) {
		return record, CoreHostSelection{}, fmt.Errorf("another core transaction precedes fresh convergence")
	}
	selected := baseline
	offlineBaseline := false
	if policy.Mode != "exact" {
		if resolve == nil {
			return record, CoreHostSelection{}, fmt.Errorf("tracked first boot requires current signed discovery")
		}
		selected, err = resolve(ctx)
		if err != nil {
			if ctx.Err() != nil || policy.Freshness != "prefer-current" || !coreDiscoveryUnavailable(err) {
				return record, CoreHostSelection{}, err
			}
			selected, offlineBaseline = baseline, true
		}
	}
	target, digest, err := VerifyCoreSelection(selected.Raw, selected.Signature, trust)
	if err != nil {
		return record, CoreHostSelection{}, err
	}
	if target.Source != initial.Source || target.Branch != initial.Branch || target.Sequence < initial.Sequence || (target.Sequence == initial.Sequence && digest != initialDigest) {
		return record, CoreHostSelection{}, fmt.Errorf("fresh selection changed source/branch or rolled back signed sequence")
	}
	if policy.Mode == "exact" && digest != initialDigest {
		return record, CoreHostSelection{}, fmt.Errorf("exact installation cannot converge to a different release")
	}
	record = CoreFirstBootSelection{OfflineBaseline: offlineBaseline, Schema: "youeye.core-first-boot.v1", PolicySHA256: policyDigest, BaselineSHA256: initialDigest, ManifestSHA256: digest, Machine: installed.Machine}
	record.RequestID = coreFirstBootRequest(record)
	if err = m.retainSelection(selected, digest); err != nil {
		return record, CoreHostSelection{}, err
	}
	raw, err = json.Marshal(record)
	if err != nil {
		return record, CoreHostSelection{}, err
	}
	if err = atomicWrite(path, raw, 0600); err != nil {
		return record, CoreHostSelection{}, err
	}
	return record, selected, nil
}
func coreFirstBootRequest(record CoreFirstBootSelection) string {
	record.RequestID = ""
	raw, _ := json.Marshal(record)
	return fmt.Sprintf("first-boot-%x", sha256.Sum256(raw))
}
