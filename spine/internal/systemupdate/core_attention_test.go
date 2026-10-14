package systemupdate

import (
	"context"
	"testing"
)

func TestCoreAttentionPreservesUncertainIntentAndResumesPositiveEvidence(t *testing.T) {
	m, e, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	e.lose = "apply-cp"
	j, err := m.Advance(context.Background(), j.RequestID, false)
	if err == nil {
		t.Fatal("expected lost receipt")
	}
	j, err = m.RecordAttention(j.RequestID, j.ManifestSHA256, "apply-cp")
	if err != nil || j.Phase != "needs-recovery" {
		t.Fatal(j.Phase, err)
	}
	for _, s := range j.Steps {
		if s.Name == "apply-cp" && s.State != "started" {
			t.Fatal("uncertain intent rewritten")
		}
	}
	if _, err = m.RecordAttention(j.RequestID, j.ManifestSHA256, "apply-ui"); err == nil {
		t.Fatal("unstarted action marked uncertain")
	}
	j, err = m.Advance(context.Background(), j.RequestID, false)
	if err != nil || j.Phase != "committed" || e.starts["apply-cp"] != 1 {
		t.Fatal(j.Phase, err, e.starts)
	}
	again, err := m.RecordAttention(j.RequestID, j.ManifestSHA256, "apply-cp")
	if err != nil || again.Phase != "committed" {
		t.Fatal("late observation replaced completion", again.Phase, err)
	}
}
