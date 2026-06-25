package installer

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestRootPasswordTreeBackdropFillsTerminal(t *testing.T) {
	rows := rootPasswordTreeBackdrop(80, 24)
	if len(rows) != 24 {
		t.Fatalf("expected 24 rows, got %d", len(rows))
	}
	for i, row := range rows {
		if len(row) != 80 {
			t.Fatalf("row %d width = %d, want 80", i, len(row))
		}
	}
	if !strings.Contains(strings.Join(rows, "\n"), "==#==") {
		t.Fatalf("backdrop did not include expected generated roots art: %q", strings.Join(rows, "\n"))
	}
}

func TestRootPasswordDialogOverlaysBackdrop(t *testing.T) {
	got := renderRootPasswordBackdropWithDialog(100, 32, "Create a root password")
	if !strings.Contains(got, "Create a root password") {
		t.Fatalf("dialog title missing from rendered screen: %q", got)
	}
	if !strings.Contains(got, "==#==") {
		t.Fatalf("background art missing from rendered screen: %q", got)
	}
}

func TestPasswordEnterMovesToConfirmBeforeAdvancing(t *testing.T) {
	w := wizardModel{
		steps: []wizStep{{kind: stepPassword, title: "Root Password"}},
	}
	w.initStep()
	w.inputs[0].SetValue("secret")

	var cmd tea.Cmd
	w, cmd = w.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("expected focus command after first Enter")
	}
	if w.current != 0 {
		t.Fatalf("first Enter should not advance, current=%d", w.current)
	}
	if w.focusField != 1 {
		t.Fatalf("first Enter should focus confirm field, got focusField=%d", w.focusField)
	}

	w.inputs[1].SetValue("secret")
	w, _ = w.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if !w.done {
		t.Fatal("second Enter on confirm field should advance past final step")
	}
}
