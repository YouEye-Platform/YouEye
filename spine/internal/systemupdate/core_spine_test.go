package systemupdate

import (
	"reflect"
	"strings"
	"testing"
)

func journalStepNames(j CoreJournal) []string {
	var names []string
	for _, s := range j.Steps {
		names = append(names, s.Name)
	}
	return names
}

func TestCoreJournalSpineOnlyChangeAppliesWithoutRestart(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	for i := range target.Members {
		switch target.Members[i].Role {
		case "cp":
			// Undo the fixture's CP change: only Spine differs.
			target.Members[i].Artifact.SHA256 = strings.Repeat("c", 64)
		case "spine":
			target.Members[i].Artifact.SHA256 = strings.Repeat("f", 64)
		}
	}
	j := prepareCoreFixture(t, m, target)
	if j.RestartRequired || !j.SpineChanged || j.NoOp || j.MetadataOnly {
		t.Fatalf("Spine-only journal: restart=%v spine=%v noop=%v metadata=%v", j.RestartRequired, j.SpineChanged, j.NoOp, j.MetadataOnly)
	}
	want := []string{"verify-members", "checkpoint", "apply-spine", "apply-cp", "apply-ui", "authenticated-health"}
	if got := journalStepNames(j); !reflect.DeepEqual(got, want) {
		t.Fatalf("Spine-only steps = %v, want %v", got, want)
	}
	if err := validateCoreSteps(j); err != nil {
		t.Fatalf("Spine-only graph rejected: %v", err)
	}
	if err := validateNativeIdentity(j, j.Steps[2]); err != nil {
		t.Fatalf("apply-spine is not a native action: %v", err)
	}
}

func TestCoreJournalHostAndSpineChangeUsesRestartGraph(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	for i := range target.Members {
		switch target.Members[i].Role {
		case "system-root":
			target.Members[i].Artifact.SHA256 = strings.Repeat("9", 64)
		case "spine":
			target.Members[i].Artifact.SHA256 = strings.Repeat("f", 64)
		}
	}
	j := prepareCoreFixture(t, m, target)
	if !j.RestartRequired || !j.SpineChanged {
		t.Fatalf("host+Spine journal: restart=%v spine=%v", j.RestartRequired, j.SpineChanged)
	}
	got := journalStepNames(j)
	if want := coreStepNames(true, false); !reflect.DeepEqual(got, want) {
		t.Fatalf("host+Spine steps = %v, want restart graph %v", got, want)
	}
	for _, name := range got {
		if name == "apply-spine" {
			t.Fatalf("restart graph contains apply-spine: %v", got)
		}
	}
}

func TestCoreJournalUnchangedSpineIsNotSpineChanged(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	if j.SpineChanged || j.RestartRequired {
		t.Fatalf("CP-only journal: restart=%v spine=%v", j.RestartRequired, j.SpineChanged)
	}
	for _, name := range journalStepNames(j) {
		if name == "apply-spine" {
			t.Fatal("CP-only journal contains apply-spine")
		}
	}
}
