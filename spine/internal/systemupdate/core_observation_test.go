package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
)

func TestCoreInstalledObservationNeverTurnsReceiptIntoFreshProof(t *testing.T) {
	for _, mode := range []string{"verified", "no-verifier", "failed-scan", "pending", "receipt-changed", "journal-changed", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			m, _, target := coreJournalFixture(t)
			receipt, err := m.ReadReceipt()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			verify := func(context.Context, CoreReceipt) error {
				calls++
				switch mode {
				case "failed-scan":
					return fmt.Errorf("private scan error must not escape")
				case "receipt-changed":
					next := receipt
					next.AcceptedAt = "changed"
					raw, _ := json.Marshal(next)
					if err := atomicWrite(filepath.Join(m.Root, "committed.json"), raw, 0600); err != nil {
						t.Fatal(err)
					}
				case "journal-changed":
					prepareCoreFixture(t, m, target)
				case "timeout":
					cancel()
				}
				return nil
			}
			if mode == "no-verifier" {
				verify = nil
			}
			if mode == "pending" {
				prepareCoreFixture(t, m, target)
			}
			out := m.ObserveInstalled(ctx, receipt, verify)
			want := "unverified"
			if mode == "verified" {
				want = "verified"
			}
			if mode == "pending" {
				want = "pending"
			}
			if out.State != want || out.ManifestSHA256 != receipt.ManifestSHA256 || (out.ObservedAt != "") != (want == "verified") {
				t.Fatalf("%+v", out)
			}
			if mode == "pending" && calls != 0 {
				t.Fatal("scanned an active transaction")
			}
			if out.Reason == "private scan error must not escape" {
				t.Fatal("raw error exposed")
			}
		})
	}
}

func TestCoreObservationRequiresSignedAuthorityBeforeNativeScan(t *testing.T) {
	m, _, _ := coreJournalFixture(t)
	receipt, _ := m.ReadReceipt()
	calls := 0
	s := NativeCoreServices{Checkpoint: NativeCoreCheckpoint{Root: m.Root, MachineObservation: func() (CoreMachineIdentity, error) { calls++; return receipt.Machine, nil }}}
	if err := s.VerifyInstalled(context.Background(), receipt, func(context.Context, CoreReceipt) error { calls++; return nil }); err == nil || calls != 0 {
		t.Fatal("unsigned retained JSON supplied fresh proof", err, calls)
	}
}
