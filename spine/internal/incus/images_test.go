package incus

import (
	"os"
	"path/filepath"
	"testing"
)

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

func TestParseLocalImageList(t *testing.T) {
	out := []byte(`[
		{
			"aliases": [{"name": "youeye-debian-12", "description": ""}],
			"architecture": "x86_64",
			"fingerprint": "c7dfccc48c6187fd2daf2846845d8cf98d88832b9d6aa76250a338a9ca4b7bf0",
			"properties": {
				"architecture": "amd64",
				"description": "Debian bookworm amd64 (20260602_05:24)",
				"os": "debian",
				"release": "bookworm",
				"serial": "20260602_05:24",
				"variant": "default"
			},
			"type": "container"
		}
	]`)

	info, err := parseLocalImageList(SystemBaseImageAlias, out)
	if err != nil {
		t.Fatalf("parseLocalImageList() returned error: %v", err)
	}
	if info.Fingerprint != "c7dfccc48c6187fd2daf2846845d8cf98d88832b9d6aa76250a338a9ca4b7bf0" {
		t.Fatalf("Fingerprint = %q", info.Fingerprint)
	}
	if err := validateDebian12Image(info); err != nil {
		t.Fatalf("parsed image failed validation: %v", err)
	}
}

func TestParseLocalImageListRejectsNoMatches(t *testing.T) {
	if _, err := parseLocalImageList(SystemBaseImageAlias, []byte(`[]`)); err == nil {
		t.Fatal("parseLocalImageList() accepted empty list")
	}
}

func TestParseLocalImageListRejectsAmbiguousMatches(t *testing.T) {
	out := []byte(`[
		{"fingerprint": "one"},
		{"fingerprint": "two"}
	]`)
	if _, err := parseLocalImageList(SystemBaseImageAlias, out); err == nil {
		t.Fatal("parseLocalImageList() accepted multiple matches")
	}
}

func TestShortFingerprint(t *testing.T) {
	got := shortFingerprint("1234567890abcdef")
	if got != "1234567890ab" {
		t.Fatalf("shortFingerprint() = %q, want %q", got, "1234567890ab")
	}
}

func TestSelectLatestVerifiedBaseImage(t *testing.T) {
	product := simpleStreamsProduct{
		Arch:    "amd64",
		OS:      "Debian",
		Release: "bookworm",
		Variant: "default",
		Versions: map[string]simpleStreamsVersion{
			"20260607_05:24": {
				Items: map[string]simpleStreamsItem{
					"incus.tar.xz": {
						Path:                   "images/debian/bookworm/amd64/default/20260607_05:24/incus.tar.xz",
						SHA256:                 "meta-old",
						CombinedSquashfsSHA256: "combined-old",
					},
					"root.squashfs": {
						Path:   "images/debian/bookworm/amd64/default/20260607_05:24/rootfs.squashfs",
						SHA256: "root-old",
					},
				},
			},
			"20260608_05:24": {
				Items: map[string]simpleStreamsItem{
					"incus.tar.xz": {
						Path:                   "images/debian/bookworm/amd64/default/20260608_05:24/incus.tar.xz",
						SHA256:                 "meta-new",
						CombinedSquashfsSHA256: "combined-new",
					},
					"root.squashfs": {
						Path:   "images/debian/bookworm/amd64/default/20260608_05:24/rootfs.squashfs",
						SHA256: "root-new",
					},
				},
			},
		},
	}

	got, err := selectLatestVerifiedBaseImage(product)
	if err != nil {
		t.Fatalf("selectLatestVerifiedBaseImage() returned error: %v", err)
	}
	if got.Version != "20260608_05:24" {
		t.Fatalf("Version = %q, want latest version", got.Version)
	}
	if got.MetadataSHA256 != "meta-new" || got.RootfsSHA256 != "root-new" || got.CombinedSHA256 != "combined-new" {
		t.Fatalf("selected wrong hashes: %+v", got)
	}
}

func TestSelectLatestVerifiedBaseImageSkipsIncompleteLatest(t *testing.T) {
	product := simpleStreamsProduct{
		Arch:    "amd64",
		OS:      "Debian",
		Release: "bookworm",
		Variant: "default",
		Versions: map[string]simpleStreamsVersion{
			"20260607_05:24": {
				Items: map[string]simpleStreamsItem{
					"incus.tar.xz": {
						Path:                   "images/debian/bookworm/amd64/default/20260607_05:24/incus.tar.xz",
						SHA256:                 "meta-old",
						CombinedSquashfsSHA256: "combined-old",
					},
					"root.squashfs": {
						Path:   "images/debian/bookworm/amd64/default/20260607_05:24/rootfs.squashfs",
						SHA256: "root-old",
					},
				},
			},
			"20260608_05:24": {
				Items: map[string]simpleStreamsItem{
					"incus.tar.xz": {
						Path:   "images/debian/bookworm/amd64/default/20260608_05:24/incus.tar.xz",
						SHA256: "meta-new",
					},
				},
			},
		},
	}

	got, err := selectLatestVerifiedBaseImage(product)
	if err != nil {
		t.Fatalf("selectLatestVerifiedBaseImage() returned error: %v", err)
	}
	if got.Version != "20260607_05:24" {
		t.Fatalf("Version = %q, want complete older version", got.Version)
	}
}

func TestCombinedFileSHA256(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first")
	second := filepath.Join(dir, "second")
	if err := os.WriteFile(first, []byte("abc"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("def"), 0600); err != nil {
		t.Fatal(err)
	}

	got, err := combinedFileSHA256(first, second)
	if err != nil {
		t.Fatalf("combinedFileSHA256() returned error: %v", err)
	}
	want := "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721"
	if got != want {
		t.Fatalf("combinedFileSHA256() = %q, want %q", got, want)
	}
}

func TestImageURL(t *testing.T) {
	got := imageURL("https://example.test/", "/images/debian/incus.tar.xz")
	want := "https://example.test/images/debian/incus.tar.xz"
	if got != want {
		t.Fatalf("imageURL() = %q, want %q", got, want)
	}
}
