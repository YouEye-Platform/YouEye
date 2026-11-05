package installer

import (
	"strings"
	"testing"
)

func TestApplianceProgressViewDoesNotRenderGameSurface(t *testing.T) {
	p := newProgressModel(installConfig{})
	p.stepName = "Plan appliance layout"
	p.lastLog = "No disk writes were performed"
	view := p.View()
	if !strings.Contains(view, "YouEye Installer") {
		t.Fatalf("installer title missing from view:\n%s", view)
	}
	for _, forbidden := range []string{"TETRIS", "Lines", "Score"} {
		if strings.Contains(view, forbidden) {
			t.Fatalf("appliance progress rendered game text %q:\n%s", forbidden, view)
		}
	}
}
