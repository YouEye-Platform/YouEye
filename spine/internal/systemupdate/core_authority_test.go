package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func TestNativeCoreAuthorityUsesFrozenTargetWithoutDiscovery(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	r.Version, r.Build, r.Tag = "0.6.1-dev.2", "0.6.1-dev.2", "youeye-v0.6.1-dev.2"
	r.Compatibility.MinimumRelease = "0.5.36"
	r.Compatibility.StateMin = appliance.CurrentStateSchema
	r.Compatibility.StateMax = appliance.CurrentStateSchema
	raw, _ = json.Marshal(r)
	digest := checksum(raw)
	state := testState()
	statePath := filepath.Join(root, "appliance-state.json")
	stateRaw, _ := json.Marshal(state)
	if err = os.WriteFile(statePath, stateRaw, 0600); err != nil {
		t.Fatal(err)
	}
	machine := CoreMachineIdentity{InstallIDRef: state.InstallIDRef, DeviceIDRef: state.DeviceIDRef, ParentDiskID: state.ParentDiskID, StatePartUUID: state.StatePartUUID, DataPartUUID: state.DataPartUUID}
	m := CoreManager{Root: filepath.Join(root, "core")}
	receipt, err := m.Initialize(ctx, CoreHostSelection{Raw: raw}, digest, func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		return machine, "fixture acceptance", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	j := CoreJournal{RequestID: "authority-fixture", ManifestSHA256: digest, Target: r, Previous: receipt, Phase: "prepared", RestartRequired: true, Steps: []CoreStep{{Name: "checkpoint", State: "pending"}}}
	requests := 0
	client := &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		return nil, fmt.Errorf("fixture offline")
	})}
	a := NativeCoreAuthority{Checkpoint: NativeCoreCheckpoint{Root: m.Root, DataRoot: root, StatePath: statePath, MachineObservation: func() (CoreMachineIdentity, error) { return machine, nil }}, Client: client}
	if err = a.AuthorizeTarget(ctx, j, false); err != nil {
		t.Fatal(err)
	}
	j.Steps[0].State = "started"
	j.Phase = "applying"
	if err = a.AuthorizeTarget(ctx, j, true); err != nil {
		t.Fatal("frozen continuation required discovery", err)
	}
	if requests != 0 {
		t.Fatal("authority re-resolved the channel for a digest-bound target")
	}
	if err = a.AuthorizePrevious(ctx, j); err != nil {
		t.Fatal("independently authorized recovery refused", err)
	}
	machine.DeviceIDRef = "another-device"
	if err = a.AuthorizeTarget(ctx, j, true); err == nil {
		t.Fatal("ignored hardware replacement")
	}
	machine = receipt.Machine
	if err = os.WriteFile(filepath.Join(m.Root, "targets", digest+".json"), append(raw, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if err = a.AuthorizeTarget(ctx, j, true); err == nil {
		t.Fatal("changed retained release admitted")
	}
}

func TestCoreCompatibilityBoundaries(t *testing.T) {
	_, _, r := coreJournalFixture(t)
	r.Compatibility.MinimumRelease = "0.5.36"
	r.Compatibility.StateMin = appliance.CurrentStateSchema
	r.Compatibility.StateMax = appliance.CurrentStateSchema
	state := testState()
	if err := validateCoreCompatibility(r, state, r.Version); err != nil {
		t.Fatal(err)
	}
	if err := validateCoreCompatibility(r, state, "0.5.1"); err == nil {
		t.Fatal("missing bridge accepted")
	}
	state.DataSchemaVersion++
	if err := validateCoreCompatibility(r, state, r.Version); err == nil {
		t.Fatal("future Data accepted")
	}
	state = testState()
	r.Compatibility.Capabilities = append(r.Compatibility.Capabilities, "future-reader")
	if err := validateCoreCompatibility(r, state, r.Version); err == nil {
		t.Fatal("unknown capability accepted")
	}
}
