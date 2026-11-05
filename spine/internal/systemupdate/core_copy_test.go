package systemupdate

import (
	"context"
	"fmt"
	"github.com/youeye-platform/YouEye/releasecache"
	"os"
	"path/filepath"
	"testing"
)

func TestIndependentCopyPreservesSignedMembershipAndRejectsSourceIdentity(t *testing.T) {
	selection, root, trust := signedCopyFixture(t)
	m := CoreManager{Root: filepath.Join(root, "state"), Executor: &coreTestExecutor{}}
	source := CoreMachineIdentity{InstallIDRef: "install:source", DeviceIDRef: "device:source", ParentDiskID: "disk:source", StatePartUUID: "state", DataPartUUID: "data"}
	receipt, err := m.Initialize(context.Background(), selection, checksum(selection.Raw), trust, func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		return source, "native source acceptance", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	request := CoreCopyRequest{RequestID: "copy-fixture", SourceHardware: "smbios:11111111-1111-1111-1111-111111111111", DestinationHardware: "smbios:22222222-2222-2222-2222-222222222222", SourceReceiptSHA256: CoreReceiptDigest(receipt), ManifestSHA256: receipt.ManifestSHA256}
	machine := source
	verifier := func(context.Context, CoreReceipt, CoreCopyRequest) (CoreMachineIdentity, string, error) {
		return machine, "native independent destination health", nil
	}
	if _, err = m.VerifyIndependentCopy(context.Background(), request, trust, verifier); err == nil {
		t.Fatal("copy retained source identity")
	}
	if _, err = m.Prepare(context.Background(), "ordinary-update", selection.Raw, request.ManifestSHA256); err == nil {
		t.Fatal("ordinary update entered incomplete copy")
	}
	if got, err := m.ReadReceipt(); err != nil || got.Machine != source {
		t.Fatal("failed copy changed source receipt")
	}
	machine.InstallIDRef = "install:destination"
	machine.DeviceIDRef = "device:destination"
	if _, err = m.VerifyIndependentCopy(context.Background(), request, trust, func(context.Context, CoreReceipt, CoreCopyRequest) (CoreMachineIdentity, string, error) {
		return machine, "", fmt.Errorf("service preparation incomplete")
	}); err == nil {
		t.Fatal("failed service acceptance committed copy")
	}
	accepted, err := m.VerifyIndependentCopy(context.Background(), request, trust, verifier)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.ManifestSHA256 != receipt.ManifestSHA256 || accepted.Release.Sequence != receipt.Release.Sequence || accepted.Machine != machine {
		t.Fatal("copy changed signed release or lost destination identity")
	}
	again, err := m.VerifyIndependentCopy(context.Background(), request, trust, verifier)
	if err != nil || again.AcceptedAt != accepted.AcceptedAt {
		t.Fatal("copy retry changed receipt", err)
	}
	request.DestinationHardware = "smbios:33333333-3333-3333-3333-333333333333"
	if _, err = m.VerifyIndependentCopy(context.Background(), request, trust, verifier); err == nil {
		t.Fatal("copy request changed destination")
	}
	if _, err = os.Stat(filepath.Join(m.Root, "copy.json")); err != nil {
		t.Fatal(err)
	}
	// Copying an independent copy keeps both generations of provenance and
	// makes inherited update requests inert under a new namespace.
	prior := CoreJournal{Schema: CoreJournalSchema, RequestID: "source-update", ManifestSHA256: accepted.ManifestSHA256, Target: accepted.Release, Previous: accepted, NoOp: true, Phase: "committed"}
	for _, name := range coreJournalStepNames(prior) {
		prior.Steps = append(prior.Steps, CoreStep{Name: name, RequestID: prior.RequestID + "/" + name, State: "succeeded", Evidence: "fixture"})
	}
	if err = m.saveCore(&prior); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(m.Root, "requests"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(m.Root, "requests", "old-request"), []byte("source-only"), 0600); err != nil {
		t.Fatal(err)
	}
	request = CoreCopyRequest{RequestID: "copy-second", SourceHardware: "smbios:22222222-2222-2222-2222-222222222222", DestinationHardware: "smbios:33333333-3333-3333-3333-333333333333", SourceReceiptSHA256: CoreReceiptDigest(accepted), ManifestSHA256: accepted.ManifestSHA256}
	machine.InstallIDRef = "install:second"
	machine.DeviceIDRef = "device:second"
	if _, err = m.VerifyIndependentCopy(context.Background(), request, trust, verifier); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(m.Root, "copy-history", "copy-fixture.json")); err != nil {
		t.Fatal("previous copy provenance lost", err)
	}
	if _, err = os.Stat(filepath.Join(m.Root, "requests")); !os.IsNotExist(err) {
		t.Fatal("inherited requests stayed live", err)
	}
	if raw, err := os.ReadFile(filepath.Join(m.Root, "copy-source-history", "copy-second", "requests", "old-request")); err != nil || string(raw) != "source-only" {
		t.Fatal("inherited requests not retained inertly", err)
	}

	if _, err = m.Initialize(context.Background(), selection, checksum(selection.Raw), trust, func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		return source, "source", nil
	}); err == nil {
		t.Fatal("fresh initialization rebound independent copy")
	}
}
