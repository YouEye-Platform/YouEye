package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreInstalledObservationNeverTurnsReceiptIntoFreshProof(t *testing.T) {
	for _, mode := range []string{"verified", "extra-files", "modified", "no-verifier", "failed-scan", "pending", "receipt-changed", "journal-changed", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			m, _, target := coreJournalFixture(t)
			receipt, err := m.ReadReceipt()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			verify := func(context.Context, CoreReceipt) ([]CoreInstalledMember, error) {
				calls++
				member := func(role string, found CorePayloadFindings) CoreInstalledMember {
					return CoreInstalledMember{Role: role, Summary: found.Summary(), Findings: found}
				}
				members := []CoreInstalledMember{member("cp", CorePayloadFindings{}), member("ui", CorePayloadFindings{})}
				switch mode {
				case "extra-files":
					members[0] = member("cp", CorePayloadFindings{Unrecorded: 3})
				case "modified":
					members[1] = member("ui", CorePayloadFindings{Unrecorded: 1, Changed: 1, Missing: 2})
				case "failed-scan":
					return nil, fmt.Errorf("private scan error must not escape")
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
				return members, nil
			}
			if mode == "no-verifier" {
				verify = nil
			}
			if mode == "pending" {
				prepareCoreFixture(t, m, target)
			}
			out := m.ObserveInstalled(ctx, receipt, verify)
			want := "unverified"
			switch mode {
			case "verified", "extra-files", "modified", "pending":
				want = mode
			}
			if mode == "extra-files" {
				// Files we did not ship do not make an installation modified.
				want = "verified"
			}
			observed := want == "verified" || want == "modified"
			if out.State != want || out.ManifestSHA256 != receipt.ManifestSHA256 || (out.ObservedAt != "") != observed || (len(out.Members) == 2) != observed {
				t.Fatalf("%+v", out)
			}
			if mode == "pending" && calls != 0 {
				t.Fatal("scanned an active transaction")
			}
			if out.Reason == "private scan error must not escape" {
				t.Fatal("raw error exposed")
			}
			switch mode {
			case "extra-files":
				if got := CoreInstalledSummary(out.Members); got != "cp verified, 3 extra files; ui verified" || out.Reason != "" {
					t.Fatal(got, out.Reason)
				}
			case "modified":
				if got := CoreInstalledSummary(out.Members); got != "cp verified; ui modified (1 changed, 2 missing), 1 extra file" || !strings.Contains(out.Reason, got) {
					t.Fatal(got, out.Reason)
				}
			}
		})
	}
}

func TestCoreObservationRequiresRetainedDigestBeforeNativeScan(t *testing.T) {
	m, _, _ := coreJournalFixture(t)
	receipt, _ := m.ReadReceipt()
	if err := os.WriteFile(filepath.Join(m.Root, "targets", receipt.ManifestSHA256+".json"), []byte(`{"changed":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	s := NativeCoreServices{Checkpoint: NativeCoreCheckpoint{Root: m.Root, MachineObservation: func() (CoreMachineIdentity, error) { calls++; return receipt.Machine, nil }}}
	if _, err := s.VerifyInstalled(context.Background(), receipt, CorePayloadRecord, func(context.Context, CoreReceipt) error { calls++; return nil }); err == nil || calls != 0 {
		t.Fatal("changed retained JSON supplied fresh proof", err, calls)
	}
}
