package systemupdate

import (
	"archive/tar"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestCoreMappedCreationDoesNotRetryOtherErrors(t *testing.T) {
	parent, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	for _, expected := range []error{nil, unix.EEXIST, unix.EACCES, unix.ENOSPC} {
		calls := 0
		err := mutateCoreMapped(parent, func() error { calls++; return expected })
		if !errors.Is(err, expected) || calls != 1 {
			t.Fatal("repeated a completed or non-mapping operation", calls, err)
		}
	}
	for _, expected := range []error{nil, unix.EACCES} {
		calls := 0
		err := mutateCoreMapped(parent, func() error {
			calls++
			if calls == 1 {
				return unix.EOVERFLOW
			}
			return expected
		})
		if !errors.Is(err, expected) || calls != 2 {
			t.Fatal("mapped operation did not return its exact result", calls, err)
		}
	}
	if err := os.Chmod(parent.Name(), 0777); err != nil {
		t.Fatal(err)
	}
	calls := 0
	if err := mutateCoreMapped(parent, func() error { calls++; return unix.EOVERFLOW }); err == nil || calls != 1 {
		t.Fatal("adopted unsafe mapped parent", calls, err)
	}
}

// Opt-in on a disposable native appliance: only a newly created probe tree is
// changed. This exercises the real Incus idmapped mount through its held init
// descriptor, without replacing installed payloads or modifying update state.
func TestCoreMappedFilesystemIntegration(t *testing.T) {
	parentPath := os.Getenv("YOUEYE_CORE_MAPPED_TEST_PARENT")
	if parentPath == "" {
		t.Skip("requires an explicitly owned disposable idmapped filesystem")
	}
	parent, err := os.Open(parentPath)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	var owner unix.Stat_t
	if err = unix.Fstat(int(parent.Fd()), &owner); err != nil {
		t.Fatal(err)
	}
	var nonce [8]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf(".youeye-core-probe-%x", nonce)
	if err = mkdirCoreMapped(parent, name, 0700); err != nil {
		t.Fatal(err)
	}
	probePath := filepath.Join(parentPath, name)
	t.Cleanup(func() {
		if err := os.RemoveAll(probePath); err != nil {
			t.Error("probe cleanup", err)
		}
	})
	probe, err := openCorePayloadDirectory(int(parent.Fd()), name)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	oldArchive, oldHash := corePayloadFixture(t, tar.Header{Name: "lib/module.js", Typeflag: tar.TypeReg, Mode: 0640}, tar.Header{Name: "entry", Typeflag: tar.TypeSymlink, Linkname: "lib/module.js"}, tar.Header{Name: "copy", Typeflag: tar.TypeLink, Linkname: "server.js"})
	old, err := IndexCorePayload(oldArchive, oldHash)
	if err != nil {
		t.Fatal(err)
	}
	if err = mkdirCoreMapped(probe, "app", 0755); err != nil {
		t.Fatal(err)
	}
	app, err := openCorePayloadDirectory(int(probe.Fd()), "app")
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	archive, err := os.Open(oldArchive)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if err = extractCorePayload(context.Background(), archive, app, old, int(owner.Uid), int(owner.Gid)); err != nil {
		t.Fatal("mapped extraction", err)
	}
	// Exercise the authenticated metadata writer's temporary file and rename.
	for _, content := range []string{"original fixture metadata", "updated fixture metadata"} {
		if err = writeCoreContainerFileAt(app, ".env", ".fixture-env", []byte(content), 1024); err != nil {
			t.Fatal("mapped metadata", err)
		}
	}
	nextArchive, nextHash := corePayloadFixture(t, tar.Header{Name: "new.js", Typeflag: tar.TypeReg, Mode: 0644})
	if path := os.Getenv("YOUEYE_CORE_MAPPED_TEST_ARCHIVE"); path != "" {
		nextArchive, nextHash = path, os.Getenv("YOUEYE_CORE_MAPPED_TEST_SHA256")
	}
	next, err := IndexCorePayload(nextArchive, nextHash)
	if err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(nextArchive)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	stage := CoreServiceStage{AppDir: "/opt/app", StageName: ".youeye-core-stage", ArtifactSHA256: nextHash, PreviousSHA256: oldHash, Phase: "prepared"}
	if err = stageCoreServiceTree(context.Background(), probe, input, &stage, old, next, func(CoreServiceStage) error { return nil }); err != nil {
		t.Fatal("mapped tree exchange", err)
	}
	if stage.Phase != "swapped" {
		t.Fatal(stage.Phase)
	}
	if err = VerifyCorePayload(filepath.Join(probePath, "app"), next); err != nil {
		t.Fatal(err)
	}
	if err = VerifyCorePayload(filepath.Join(probePath, stage.StageName), old); err != nil {
		t.Fatal(err)
	}
	t.Logf("mapped uid=%d gid=%d; verified %d target entries and preserved previous tree", owner.Uid, owner.Gid, len(next.Entries))
}
