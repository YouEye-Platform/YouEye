package systemupdate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreFirstBootFreezesInstalledBaselineAcrossRestart(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	release, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	baseline := CoreHostSelection{Raw: raw}
	machine := CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state", DataPartUUID: "data"}
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Repository: "https://forge.example/owner/YouEye", Channel: "dev", CoreManifestSHA256: checksum(raw)}
	initManager := func() CoreManager {
		m := CoreManager{Root: filepath.Join(t.TempDir(), "core")}
		if _, err := m.Initialize(context.Background(), baseline, checksum(baseline.Raw), func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
			return machine, "verified fixture baseline", nil
		}); err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := initManager()
	frozen, first, err := m.FreezeFirstBoot(context.Background(), policy, baseline)
	if err != nil || !reflect.DeepEqual(first, baseline) || frozen.ManifestSHA256 != checksum(raw) || frozen.BaselineSHA256 != checksum(raw) {
		t.Fatal(frozen, err)
	}
	again, second, err := m.FreezeFirstBoot(context.Background(), policy, baseline)
	if err != nil || again != frozen || !reflect.DeepEqual(second, first) {
		t.Fatal(again, err)
	}
	// The owner may change channel before first deployment finishes.
	channel := policy
	channel.Channel = "beta"
	if again, _, err := m.FreezeFirstBoot(context.Background(), channel, baseline); err != nil || again != frozen {
		t.Fatal("a channel change broke first boot:", err)
	}
	changed := policy
	changed.Repository = "https://forge.example.test/other/YouEye"
	if _, _, err = m.FreezeFirstBoot(context.Background(), changed, baseline); err == nil {
		t.Fatal("changed frozen policy admitted")
	}
	current, _ := m.ReadReceipt()
	current.Machine.DeviceIDRef = "other"
	encoded, _ := json.Marshal(current)
	if err = atomicWrite(filepath.Join(m.Root, "committed.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.FreezeFirstBoot(context.Background(), policy, baseline); err == nil {
		t.Fatal("changed machine admitted")
	}
	for _, mutation := range []string{"policy-digest", "other-baseline", "malformed"} {
		t.Run(mutation, func(t *testing.T) {
			m := initManager()
			p, candidate := policy, baseline
			switch mutation {
			case "policy-digest":
				p.CoreManifestSHA256 = strings.Repeat("e", 64)
			case "other-baseline":
				r := release
				r.Version, r.Tag = "0.6.1-rc.2", "youeye-v0.6.1-rc.2"
				candidate.Raw, _ = json.Marshal(r)
				p.CoreManifestSHA256 = checksum(candidate.Raw)
			case "malformed":
				candidate.Raw = append([]byte(nil), raw...)
				candidate.Raw[0] ^= 1
			}
			if _, _, err := m.FreezeFirstBoot(context.Background(), p, candidate); err == nil {
				t.Fatal("unsafe first-boot baseline admitted")
			}
			if _, err := os.Stat(filepath.Join(m.Root, "first-boot.json")); !os.IsNotExist(err) {
				t.Fatal("failed first boot froze intent", err)
			}
		})
	}
}
