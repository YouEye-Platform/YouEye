package incus

import "testing"

func TestValidateDebian12Image(t *testing.T) {
	valid := &imageInfo{
		Fingerprint:  "3b3bd7f47fcaf505ddedf82c2a61ca27207ea945d3f595fa61076330f471e95d",
		Architecture: "x86_64",
		Type:         "container",
		Properties: map[string]string{
			"architecture": "amd64",
			"os":           "Debian",
			"release":      "bookworm",
		},
	}
	if err := validateDebian12Image(valid); err != nil {
		t.Fatalf("validateDebian12Image(valid) returned error: %v", err)
	}
}

func TestValidateDebian12ImageRejectsWrongRelease(t *testing.T) {
	info := &imageInfo{
		Fingerprint:  "abc123",
		Architecture: "x86_64",
		Type:         "container",
		Properties: map[string]string{
			"architecture": "amd64",
			"os":           "Debian",
			"release":      "trixie",
		},
	}
	if err := validateDebian12Image(info); err == nil {
		t.Fatal("validateDebian12Image() accepted wrong release")
	}
}

func TestValidateDebian12ImageRejectsWrongArch(t *testing.T) {
	info := &imageInfo{
		Fingerprint:  "abc123",
		Architecture: "aarch64",
		Type:         "container",
		Properties: map[string]string{
			"architecture": "arm64",
			"os":           "Debian",
			"release":      "bookworm",
		},
	}
	if err := validateDebian12Image(info); err == nil {
		t.Fatal("validateDebian12Image() accepted wrong architecture")
	}
}

func TestShortFingerprint(t *testing.T) {
	got := shortFingerprint("1234567890abcdef")
	if got != "1234567890ab" {
		t.Fatalf("shortFingerprint() = %q, want %q", got, "1234567890ab")
	}
}
