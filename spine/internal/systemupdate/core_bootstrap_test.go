package systemupdate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreBootstrapRetainsExactCoordinatorAndRejectsSubstitution(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	binary := []byte("coordinator fixture")
	var member *releasecache.CoreMember
	for i := range target.Members {
		if target.Members[i].Role == "spine" {
			member = &target.Members[i]
		}
	}
	member.BuildVersion = target.Version
	member.Artifact = releasecache.CoreBlob{Name: "spine-linux-amd64", SHA256: checksum(binary), SizeBytes: int64(len(binary))}
	raw, _ := json.Marshal(target)
	digest := checksum(raw)
	j, err := m.PrepareSelected(context.Background(), "bootstrap-fixture", CoreHostSelection{Raw: raw}, digest)
	if err != nil {
		t.Fatal(err)
	}
	file, err := m.BootstrapBinaryPath(member.Artifact.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, binary, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := m.RegisterBootstrap(j.RequestID, digest, "/tmp/arbitrary-reader"); err == nil {
		t.Fatal("accepted unrelated executable")
	}
	for range 2 {
		if got, err := m.RegisterBootstrap(j.RequestID, digest, file); err != nil || got != file {
			t.Fatal(got, err)
		}
	}
	retained := CoreManager{Root: m.Root}
	if got, err := retained.BootstrapExecutable(); err != nil || got != file {
		t.Fatal(got, err)
	}
	if err := m.ForgetBootstrap(j.RequestID); err == nil {
		t.Fatal("retired unfinished coordinator")
	}
	if err := os.WriteFile(file, []byte("substituted"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := retained.BootstrapExecutable(); err == nil {
		t.Fatal("accepted changed coordinator bytes")
	}
	if err := os.WriteFile(file, binary, 0700); err != nil {
		t.Fatal(err)
	}
	j.Phase = "cancelled"
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	if err := m.ForgetBootstrap(j.RequestID); err != nil {
		t.Fatal(err)
	}
	if got, err := retained.BootstrapExecutable(); err != nil || got != "" {
		t.Fatal(got, err)
	}
}
