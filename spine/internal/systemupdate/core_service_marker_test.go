package systemupdate

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCoreComponentMarkerLostAcknowledgementAndReuse(t *testing.T) {
	for _, reuse := range []bool{false, true} {
		t.Run(map[bool]string{false: "changed", true: "reused"}[reuse], func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "etc", "youeye")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			old := coreComponentMarker{Schema: "youeye.core-component.v1", Role: "cp", RequestID: "install-baseline", ManifestSHA256: checksum([]byte("baseline")), ArtifactSHA256: checksum([]byte("old"))}
			raw, _ := json.Marshal(old)
			file := filepath.Join(dir, "core-component.json")
			if err := os.WriteFile(file, raw, 0600); err != nil {
				t.Fatal(err)
			}
			j := CoreJournal{RequestID: "update-1", ManifestSHA256: checksum([]byte("new manifest"))}
			r := CoreServiceStage{Role: "cp", StageName: ".youeye-core-fixture", Phase: "swapped", PreviousSHA256: old.ArtifactSHA256, ArtifactSHA256: checksum([]byte("new"))}
			if reuse {
				r.Phase = "reused"
				r.ArtifactSHA256 = old.ArtifactSHA256
			}
			held, err := os.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			defer held.Close()
			retained := r
			lose := !reuse
			save := func(value CoreServiceStage) error {
				if value.MarkerState == "installed" && lose {
					lose = false
					return errors.New("lost marker acknowledgement")
				}
				retained = value
				return nil
			}
			err = installCoreComponentMarker(held, j, &r, save)
			if reuse {
				if err != nil {
					t.Fatal(err)
				}
				after, _ := os.ReadFile(file)
				if string(after) != string(raw) {
					t.Fatal("changed reused schema identity")
				}
				return
			}
			if err == nil || retained.MarkerState != "requested" {
				t.Fatal("lost acknowledgement not retained", err)
			}
			r = retained
			if err = installCoreComponentMarker(held, j, &r, save); err != nil || r.MarkerState != "installed" {
				t.Fatal(r.MarkerState, err)
			}
			after, _ := os.ReadFile(file)
			var marker coreComponentMarker
			if json.Unmarshal(after, &marker) != nil || marker.RequestID != j.RequestID || marker.ManifestSHA256 != j.ManifestSHA256 || marker.ArtifactSHA256 != r.ArtifactSHA256 {
				t.Fatal("incorrect marker")
			}
			marker.RequestID = "foreign-request"
			after, _ = json.Marshal(marker)
			if err = os.WriteFile(file, after, 0600); err != nil {
				t.Fatal(err)
			}
			if err = installCoreComponentMarker(held, j, &r, save); err == nil {
				t.Fatal("overwrote changed completed marker")
			}
		})
	}
}
