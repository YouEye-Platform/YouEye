package installer

import (
	"strings"
	"testing"
)

func TestRootPasswordTreeResponsiveVisibility(t *testing.T) {
	if got := rootPasswordTreeView(80, 24); got != "" {
		t.Fatalf("80x24 terminal should hide decorative tree, got %q", got)
	}

	got := rootPasswordTreeView(120, 40)
	if got == "" {
		t.Fatal("large terminal should show decorative tree")
	}
	if !strings.Contains(got, "++*-:::") {
		t.Fatalf("tree output did not contain expected generated art, got %q", got)
	}
}
