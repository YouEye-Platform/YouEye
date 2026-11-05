package systemupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreFirstBootFreezesSignedTargetAcrossRestartAndPolicyChanges(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	release, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	public, key, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(public)
	oldSource := release.Source
	release.Source, release.SignerSHA256 = "https://forge.example/owner/YouEye", checksum(der)
	for i := range release.Members {
		member := &release.Members[i]
		member.Source, member.KeyID = release.Source, release.SignerSHA256
		for _, blob := range []*releasecache.CoreBlob{&member.Artifact, &member.Checksums, &member.Signature, &member.Provenance, &member.SBOM, member.DocumentSignature, member.ReleaseLock} {
			if blob != nil {
				blob.URL = strings.Replace(blob.URL, oldSource, release.Source, 1)
			}
		}
	}
	sign := func(r releasecache.CoreRelease) CoreHostSelection {
		raw, _ := json.Marshal(r)
		return CoreHostSelection{Raw: raw, Signature: ed25519.Sign(key, raw)}
	}
	baseline := sign(release)
	root := t.TempDir()
	trust := filepath.Join(root, "key.pub")
	if err := os.WriteFile(trust, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	machine := CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state", DataPartUUID: "data"}
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Provider: "custom", ReleasesAPI: "https://forge.example/api/v1/repos/owner/YouEye/releases", Mode: "track", Track: "branch", Branch: release.Branch, CoreManifestSHA256: checksum(baseline.Raw), Freshness: "require-current"}
	target := release
	target.Version, target.Tag, target.Sequence = "0.5.38", "youeye-v0.5.38", release.Sequence+1
	target.PreviousManifestSHA256 = checksum(baseline.Raw)
	selected := sign(target)
	initManager := func() CoreManager {
		m := CoreManager{Root: filepath.Join(t.TempDir(), "core")}
		if _, err := m.Initialize(context.Background(), baseline, checksum(baseline.Raw), trust, func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
			return machine, "verified fixture baseline", nil
		}); err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := initManager()
	calls := 0
	resolve := func(context.Context) (CoreHostSelection, error) { calls++; return selected, nil }
	frozen, first, err := m.FreezeFirstBoot(context.Background(), policy, baseline, trust, resolve)
	if err != nil || !reflect.DeepEqual(first, selected) || frozen.ManifestSHA256 != checksum(selected.Raw) || calls != 1 {
		t.Fatal(frozen, err, calls)
	}
	again, second, err := m.FreezeFirstBoot(context.Background(), policy, baseline, trust, func(context.Context) (CoreHostSelection, error) {
		t.Error("resolved a newer head after restart")
		return CoreHostSelection{}, fmt.Errorf("offline")
	})
	if err != nil || again != frozen || !reflect.DeepEqual(second, first) {
		t.Fatal(again, err)
	}
	changed := policy
	changed.Freshness = "prefer-current"
	if _, _, err = m.FreezeFirstBoot(context.Background(), changed, baseline, trust, resolve); err == nil {
		t.Fatal("changed frozen policy admitted")
	}
	current, _ := m.ReadReceipt()
	current.Machine.DeviceIDRef = "other"
	encoded, _ := json.Marshal(current)
	if err = atomicWrite(filepath.Join(m.Root, "committed.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.FreezeFirstBoot(context.Background(), policy, baseline, trust, resolve); err == nil {
		t.Fatal("changed machine admitted")
	}
	for _, mutation := range []string{"same-sequence", "older", "branch", "source", "signature"} {
		t.Run(mutation, func(t *testing.T) {
			m := initManager()
			r := target
			switch mutation {
			case "same-sequence":
				r.Sequence = release.Sequence
			case "older":
				r.Sequence = release.Sequence - 1
			case "branch":
				r.Branch = "another"
			case "source":
				r.Source = "https://forge.example/another/YouEye"
			}
			candidate := sign(r)
			if mutation == "signature" {
				candidate.Signature[0] ^= 1
			}
			if _, _, err := m.FreezeFirstBoot(context.Background(), policy, baseline, trust, func(context.Context) (CoreHostSelection, error) { return candidate, nil }); err == nil {
				t.Fatal("unsafe initial target admitted")
			}
			if _, err := os.Stat(filepath.Join(m.Root, "first-boot.json")); !os.IsNotExist(err) {
				t.Fatal("failed discovery froze intent", err)
			}
		})
	}
	for _, cause := range []error{&net.DNSError{Err: "no route", Name: "fixture.example"}, syscall.ECONNREFUSED, fmt.Errorf("invalid signature"), fmt.Errorf("distribution metadata expired or clock is incorrect"), ErrNoCoreRelease} {
		t.Run(cause.Error(), func(t *testing.T) {
			pref := policy
			pref.Freshness = "prefer-current"
			m := initManager()
			frozen, selected, err := m.FreezeFirstBoot(context.Background(), pref, baseline, trust, func(context.Context) (CoreHostSelection, error) { return CoreHostSelection{}, cause })
			allowed := coreDiscoveryUnavailable(cause)
			if !allowed {
				if err == nil {
					t.Fatal("unsafe freshness fallback")
				}
				return
			}
			if err != nil || !frozen.OfflineBaseline || !reflect.DeepEqual(selected, baseline) {
				t.Fatal(frozen, err)
			}
			paths := t.TempDir()
			policyPath, completePath := filepath.Join(paths, "policy.json"), filepath.Join(paths, "complete")
			raw, _ := json.Marshal(pref)
			if err = os.WriteFile(policyPath, raw, 0600); err != nil {
				t.Fatal(err)
			}
			a := NativeCoreAuthority{Checkpoint: NativeCoreCheckpoint{Root: m.Root}, FirstBootPolicyPath: policyPath, FirstBootCompletePath: completePath}
			previous, _ := m.ReadReceipt()
			j := CoreJournal{NoOp: true, RequestID: frozen.RequestID, ManifestSHA256: frozen.ManifestSHA256, Previous: previous, Target: release}
			if ok, err := a.allowOfflineFirstBoot(j); err != nil || !ok {
				t.Fatal(ok, err)
			}
			j.NoOp = false
			if ok, err := a.allowOfflineFirstBoot(j); err != nil || ok {
				t.Fatal("effectful update bypassed freshness", ok, err)
			}
			j.NoOp = true
			if err = os.WriteFile(completePath, []byte("complete"), 0600); err != nil {
				t.Fatal(err)
			}
			if ok, err := a.allowOfflineFirstBoot(j); err != nil || ok {
				t.Fatal("exposed installation bypassed freshness", ok, err)
			}
			required := policy
			if _, _, err := initManager().FreezeFirstBoot(context.Background(), required, baseline, trust, func(context.Context) (CoreHostSelection, error) { return CoreHostSelection{}, cause }); err == nil {
				t.Fatal("required discovery silently fell back")
			}
		})
	}
	exact := policy
	exact.Mode, exact.Track, exact.Branch, exact.ExactTag, exact.ManifestSHA256 = "exact", "", "", release.Tag, strings.Repeat("e", 64)
	m = initManager()
	exactRecord, exactSelected, err := m.FreezeFirstBoot(context.Background(), exact, baseline, trust, func(context.Context) (CoreHostSelection, error) {
		t.Error("exact installation queried a head")
		return selected, nil
	})
	if err != nil || !reflect.DeepEqual(exactSelected, baseline) || exactRecord.ManifestSHA256 != checksum(baseline.Raw) {
		t.Fatal(exactRecord, err)
	}
}
