package systemupdate

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCoreServiceSelectionPartialPairAndLostReceipt(t *testing.T) {
	for _, mode := range []string{"normal", "partial-pair", "lost-receipt", "foreign", "foreign-proof", "missing-paired-proof"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "var/lib/youeye-state/core-selection")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			old := CoreHostSelection{Raw: []byte("old signed manifest"), Signature: []byte("old signature")}
			next := CoreHostSelection{Raw: []byte("new signed manifest"), Signature: []byte("new signature"), MetadataProof: []byte(`{"documents":{"canonical":"eQ=="}}`)}
			if mode == "missing-paired-proof" {
				old.MetadataProof = []byte(`{"documents":{"canonical":"eA=="}}`)
			}
			if mode == "foreign-proof" {
				if err := os.WriteFile(filepath.Join(dir, CoreMetadataProofName), []byte("foreign proof"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			r := CoreServiceStage{Role: "cp", Phase: "reused", StageName: ".youeye-core-fixture", ManifestSHA256: checksum(next.Raw)}
			raw := old.Raw
			if mode == "partial-pair" {
				raw = next.Raw
				r.SelectionState = "requested"
			}
			if mode == "foreign" {
				raw = []byte("foreign")
			}
			if err := os.WriteFile(filepath.Join(dir, "core-release.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "core-release.json.sig"), old.Signature, 0600); err != nil {
				t.Fatal(err)
			}
			rootFile, err := os.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			defer rootFile.Close()
			retained := r
			lose := mode == "lost-receipt"
			save := func(value CoreServiceStage) error {
				if value.SelectionState == "installed" && lose {
					lose = false
					return errors.New("lost receipt")
				}
				retained = value
				return nil
			}
			err = installCoreServiceSelection(rootFile, &r, old, next, save)
			if mode == "foreign" || mode == "foreign-proof" || mode == "missing-paired-proof" {
				if err == nil {
					t.Fatal("overwrote foreign selection")
				}
				return
			}
			if mode == "lost-receipt" {
				if err == nil {
					t.Fatal("missing lost receipt")
				}
				r = retained
				err = installCoreServiceSelection(rootFile, &r, old, next, save)
			}
			if err != nil || r.SelectionState != "installed" {
				t.Fatal(r.SelectionState, err)
			}
			actual, err := os.ReadFile(filepath.Join(dir, "core-release.json"))
			if err != nil || string(actual) != string(next.Raw) {
				t.Fatal("wrong manifest", err)
			}
			proof, err := os.ReadFile(filepath.Join(dir, CoreMetadataProofName))
			if err != nil || string(proof) != string(next.MetadataProof) {
				t.Fatal("wrong metadata proof", err)
			}
			sig, err := os.ReadFile(filepath.Join(dir, "core-release.json.sig"))
			if err != nil || string(sig) != string(next.Signature) {
				t.Fatal("wrong signature", err)
			}
		})
	}
}
