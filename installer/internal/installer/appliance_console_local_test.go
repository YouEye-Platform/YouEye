package installer

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestConsoleQRCodeIsSquareHalfBlocks(t *testing.T) {
	code := consoleQRCode("http://192.168.31.24")
	lines := strings.Split(code, "\n")
	if len(lines) < 10 {
		t.Fatalf("QR code too small: %d lines", len(lines))
	}
	width := utf8.RuneCountInString(lines[0])
	for _, line := range lines {
		if utf8.RuneCountInString(line) != width {
			t.Fatalf("ragged QR line %q", line)
		}
		if strings.Trim(line, "█▀▄ ") != "" {
			t.Fatalf("unexpected characters in %q", line)
		}
	}
	// Two module rows per line, plus the quiet zone.
	if want := (width + 1) / 2; len(lines) != want {
		t.Fatalf("QR has %d lines for width %d, want %d", len(lines), width, want)
	}
}

func TestConsoleShowsSetupAddressesAndQR(t *testing.T) {
	model := applianceConsoleModel{snapshot: applianceConsoleSnapshot{
		IPv4Address: "192.168.31.24", LocalName: "youeye-2.local", Detail: "Installing the YouEye UI", Stage: "ui",
		CAFingerprint: strings.TrimSuffix(strings.Repeat("AB:", 32), ":"),
	}}
	view := model.View()
	for _, want := range []string{"Box CA      SHA-256 AB:AB:", "Installing YouEye…", "Installing the YouEye UI", "Watch at    http://youeye-2.local or http://192.168.31.24", "█"} {
		if !strings.Contains(view, want) {
			t.Errorf("installing view lacks %q", want)
		}
	}
	model.snapshot.Complete, model.snapshot.ConsoleUnclaimed = true, true
	model.snapshot.LocalName = ""
	view = model.View()
	if !strings.Contains(view, "Set up at   http://youeye.local or http://192.168.31.24") || !strings.Contains(view, "█") {
		t.Errorf("unclaimed view: %s", view)
	}
	model.snapshot.ConsoleUnclaimed = false
	view = model.View()
	if !strings.Contains(view, "Setup       https://192.168.31.24") || strings.Contains(view, "█") || strings.Contains(view, ".local") || strings.Contains(view, "SHA-256") {
		t.Errorf("claimed view: %s", view)
	}
	model.snapshot.IPv4Address = ""
	if view = model.View(); !strings.Contains(view, "waiting for wired IPv4") {
		t.Errorf("no-address view: %s", view)
	}
}
