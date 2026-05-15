package update_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"

	"github.com/YouEye-Platform/YouEye/spine/internal/update"
)

func sha256Of(data string) string {
	h := sha256.New()
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

func TestDownloadBinary_Success(t *testing.T) {
	content := "#!/bin/sh\necho hello"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(content)) //nolint:errcheck
	}))
	defer srv.Close()

	dest := t.TempDir() + "/spine-new"
	if err := update.DownloadBinary(srv.Client(), srv.URL+"/spine-linux-amd64", dest); err != nil {
		t.Fatalf("DownloadBinary() error: %v", err)
	}

	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != content {
		t.Errorf("content mismatch: got %q, want %q", string(data), content)
	}

	// Verify executable bit (Linux/macOS only — Windows does not use Unix permission bits)
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(dest)
		if info.Mode()&0111 == 0 {
			t.Error("downloaded binary should be executable")
		}
	}
}

func TestDownloadBinary_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	dest := t.TempDir() + "/spine-new"
	err := update.DownloadBinary(srv.Client(), srv.URL+"/notfound", dest)
	if err == nil {
		t.Error("expected error for 404 response")
	}
}

func TestDownloadBinary_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	dest := t.TempDir() + "/spine-new"
	err := update.DownloadBinary(srv.Client(), srv.URL+"/spine-linux-amd64", dest)
	if err == nil {
		t.Error("expected error for 500 response")
	}
}

func TestDownloadBinary_CorrectURL(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Write([]byte("binary content")) //nolint:errcheck
	}))
	defer srv.Close()

	dest := t.TempDir() + "/spine-new"
	assetPath := "/testorg/TestSpine/releases/download/sam-v0.2.6.1/spine-linux-amd64"
	_ = update.DownloadBinary(srv.Client(), srv.URL+assetPath, dest)

	if gotPath != assetPath {
		t.Errorf("server received path %q, want %q", gotPath, assetPath)
	}
}

// ─── Checksum tests ───────────────────────────────────────────────────────────

func TestVerifyChecksum_Valid(t *testing.T) {
	content := "fake binary content"
	expected := sha256Of(content)

	f, _ := os.CreateTemp("", "checksum-test-*")
	f.WriteString(content) //nolint:errcheck
	f.Close()
	defer os.Remove(f.Name())

	if err := update.VerifyChecksum(f.Name(), expected); err != nil {
		t.Errorf("VerifyChecksum() unexpected error: %v", err)
	}
}

func TestVerifyChecksum_Tampered(t *testing.T) {
	original := "real binary content"

	f, _ := os.CreateTemp("", "tampered-test-*")
	f.WriteString("tampered content — different bytes than original") //nolint:errcheck
	f.Close()
	defer os.Remove(f.Name())

	// Checksum of the *original* content — file contains different bytes
	expected := sha256Of(original)

	err := update.VerifyChecksum(f.Name(), expected)
	if err == nil {
		t.Error("VerifyChecksum() should fail for tampered binary")
	}
}

func TestVerifyChecksum_FileNotFound(t *testing.T) {
	err := update.VerifyChecksum("/nonexistent/path/binary", "abc123")
	if err == nil {
		t.Error("VerifyChecksum() should fail if file does not exist")
	}
}

// ─── Atomic swap tests ────────────────────────────────────────────────────────

func TestAtomicInstall_Replace(t *testing.T) {
	dir := t.TempDir()
	dest := dir + "/spine"
	src := dir + "/spine-new"

	os.WriteFile(dest, []byte("old binary"), 0755) //nolint:errcheck
	os.WriteFile(src, []byte("new binary"), 0755)  //nolint:errcheck

	backupPath, err := update.AtomicInstall(src, dest)
	if err != nil {
		t.Fatalf("AtomicInstall() error: %v", err)
	}

	// Dest should have new content
	data, _ := os.ReadFile(dest)
	if string(data) != "new binary" {
		t.Errorf("dest = %q, want %q", string(data), "new binary")
	}

	// Backup should exist and contain old content
	if backupPath != "" {
		backupData, err := os.ReadFile(backupPath)
		if err != nil {
			t.Errorf("backup file not readable: %v", err)
		} else if string(backupData) != "old binary" {
			t.Errorf("backup = %q, want %q", string(backupData), "old binary")
		}
	}

	// Src should be gone after atomic move
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Error("source file should not exist after atomic install")
	}
}

func TestAtomicInstall_NoDest(t *testing.T) {
	dir := t.TempDir()
	src := dir + "/spine-new"
	dest := dir + "/spine" // does not exist yet

	os.WriteFile(src, []byte("new binary"), 0755) //nolint:errcheck

	_, err := update.AtomicInstall(src, dest)
	if err != nil {
		t.Fatalf("AtomicInstall() with no existing dest error: %v", err)
	}

	data, _ := os.ReadFile(dest)
	if string(data) != "new binary" {
		t.Errorf("dest = %q, want %q", string(data), "new binary")
	}
}

func TestAtomicInstall_OldBinaryRemoved(t *testing.T) {
	dir := t.TempDir()
	dest := dir + "/spine"
	src := dir + "/spine-new"

	os.WriteFile(dest, []byte("old"), 0755) //nolint:errcheck
	os.WriteFile(src, []byte("new"), 0755)  //nolint:errcheck

	_, err := update.AtomicInstall(src, dest)
	if err != nil {
		t.Fatalf("AtomicInstall() error: %v", err)
	}

	// Old binary must not survive at original path (replaced)
	data, _ := os.ReadFile(dest)
	if string(data) == "old" {
		t.Error("old binary should be replaced after atomic install")
	}
}

// ─── Rollback tests ───────────────────────────────────────────────────────────

func TestRollbackInstall_RestoresOriginal(t *testing.T) {
	dir := t.TempDir()
	backup := dir + "/spine.backup"
	dest := dir + "/spine"

	os.WriteFile(backup, []byte("original binary"), 0755) //nolint:errcheck
	os.WriteFile(dest, []byte("broken new binary"), 0755) //nolint:errcheck

	if err := update.RollbackInstall(dest, backup); err != nil {
		t.Fatalf("RollbackInstall() error: %v", err)
	}

	data, _ := os.ReadFile(dest)
	if string(data) != "original binary" {
		t.Errorf("after rollback, dest = %q, want %q", string(data), "original binary")
	}
}

func TestRollbackInstall_NoBackup(t *testing.T) {
	dir := t.TempDir()
	dest := dir + "/spine"

	err := update.RollbackInstall(dest, "")
	if err == nil {
		t.Error("RollbackInstall() with empty backupPath should return error")
	}
}
