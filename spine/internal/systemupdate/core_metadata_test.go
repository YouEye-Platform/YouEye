package systemupdate

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreMetadataPromotionCommitsWithoutApplyingPayloads(t *testing.T) {
	m, e, target := coreJournalFixture(t)
	before, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	target.Members = before.Release.Members
	e.lose = "authenticated-health"
	j := prepareCoreFixture(t, m, target)
	if !j.MetadataOnly || j.NoOp || j.RestartRequired {
		t.Fatal("promotion misclassified", j)
	}
	if got := coreJournalStepNames(j); !reflect.DeepEqual(got, []string{"verify-members", "authenticated-health"}) {
		t.Fatal(got)
	}
	if _, err := m.Advance(context.Background(), j.RequestID, false); err == nil {
		t.Fatal("lost acknowledgement not retained")
	}
	still, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(still, before) {
		t.Fatal("premature metadata commit", err)
	}
	j, err = m.Advance(context.Background(), j.RequestID, false)
	if err != nil || j.Phase != "committed" || !m.TransactionComplete(j) {
		t.Fatal(j.Phase, err)
	}
	after, err := m.ReadReceipt()
	if err != nil || after.Release.Version != target.Version || after.Machine != before.Machine {
		t.Fatal(after, err)
	}
	if len(e.starts) != 2 || e.starts["verify-members"] != 1 || e.starts["authenticated-health"] != 1 {
		t.Fatal("payload effect or replay", e.starts)
	}
	if _, err := m.Advance(context.Background(), j.RequestID, false); err != nil {
		t.Fatal("committed replay", err)
	}
}

func TestCoreMetadataPromotionRejectsChangedInputsOrForgedGraph(t *testing.T) {
	for _, change := range []struct {
		name  string
		apply func(*releasecache.CoreRelease)
	}{
		{"payload", func(r *releasecache.CoreRelease) { r.Members[0].Artifact.SizeBytes++ }},
		{"compatibility", func(r *releasecache.CoreRelease) { r.Compatibility.DataMax++ }},
		{"authority", func(r *releasecache.CoreRelease) { r.Members[0].Branch = "beta" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			m, _, target := coreJournalFixture(t)
			before, _ := m.ReadReceipt()
			raw, _ := json.Marshal(before.Release.Members)
			json.Unmarshal(raw, &target.Members)
			change.apply(&target)
			if sameCorePayloads(before.Release, target) {
				t.Fatal("changed requirements treated as metadata")
			}
			j := CoreJournal{MetadataOnly: true, Target: target, Previous: before, ManifestSHA256: "different"}
			if validateCoreSteps(j) == nil {
				t.Fatal("forged metadata graph accepted")
			}
		})
	}
}
