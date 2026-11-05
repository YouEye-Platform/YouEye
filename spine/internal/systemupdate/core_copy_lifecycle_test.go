package systemupdate

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestIndependentCopyLifecycleRetainsAuthorityAcrossHandoffAndFailure(t *testing.T) {
	b := CoreLifecycleBarrier{Root: filepath.Join(t.TempDir(), "app-updates")}
	request := CoreCopyRequest{RequestID: "copy-lifecycle", SourceHardware: "smbios:11111111-1111-1111-1111-111111111111", DestinationHardware: "smbios:22222222-2222-2222-2222-222222222222", SourceReceiptSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ManifestSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	hardware := request.SourceHardware
	observe := func() (string, error) { return hardware, nil }
	if err := b.BeginCopy(request, "source", observe); err != nil {
		t.Fatal(err)
	}
	if release, err := b.AdmitOutsideCopy(); err == nil {
		release()
		t.Fatal("automatic host convergence entered a frozen copy")
	}
	if release, err := b.AdmitOrdinary(); err == nil {
		release()
		t.Fatal("ordinary mutation entered source reservation")
	}
	if err := b.Begin(CoreJournal{RequestID: "update", ManifestSHA256: request.ManifestSHA256}); err == nil {
		t.Fatal("System update entered copy reservation")
	}
	if err := b.BeginCopy(request, "destination", observe); err == nil {
		t.Fatal("source host adopted destination identity")
	}
	hardware = request.DestinationHardware
	if err := b.BeginCopy(request, "destination", observe); err != nil {
		t.Fatal(err)
	}
	if err := b.ReleaseCopy(request, "destination", func() error { return fmt.Errorf("service identity not ready") }); err == nil {
		t.Fatal("failed completion released copy")
	}
	if r, err := b.ReadCopy(); err != nil || r.Role != "destination" {
		t.Fatal("failed completion lost reservation", err)
	}
	if err := b.ReleaseCopy(request, "destination", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := b.ReleaseCopy(request, "destination", func() error { return nil }); err != nil {
		t.Fatal("lost acknowledgement did not reconcile", err)
	}
	release, err := b.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	release()
	request.DestinationHardware = "smbios:33333333-3333-3333-3333-333333333333"
	if err := b.ReleaseCopy(request, "destination", func() error { return nil }); err == nil {
		t.Fatal("changed request reused completion receipt")
	}
}
