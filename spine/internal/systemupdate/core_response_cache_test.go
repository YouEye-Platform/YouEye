package systemupdate

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Sanitized layout observed after GET /manifest.webmanifest in both deployed
// CP and UI. The owner key is SHA-256 of /manifest.webmanifest/route.
const manifestCacheFixture = ".next/server/route-cache/APP_ROUTE/34ed36d6db35fbd1331104b4f001db6d5ff9aae7c5571d365de1b5f496f21575/$/manifest.webmanifest"

func manifestResponseCacheFixture(t *testing.T) (string, CorePayloadIndex) {
	t.Helper()
	archive, digest := corePayloadFixture(t, tar.Header{Name: ".next/server/app/manifest.webmanifest/route.js", Typeflag: tar.TypeReg, Mode: 0644})
	index, err := IndexCorePayload(archive, digest)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for _, e := range index.Entries {
		name := filepath.Join(root, e.Path)
		if e.Kind == "directory" {
			err = os.MkdirAll(name, os.FileMode(e.Mode))
		} else {
			var body []byte
			if e.Path == "server.js" {
				body = []byte("console.log('signed executable');\n")
			}
			err = os.WriteFile(name, body, os.FileMode(e.Mode))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	return root, index
}

func TestCoreManifestResponseCache(t *testing.T) {
	for _, test := range []struct {
		name  string
		valid bool
	}{
		{"cold", true}, {"warm", true}, {"body-only", true}, {"meta-only", true}, {"concurrent", true},
		{"extra-js", false}, {"extra-cache", false}, {"other-owner", false}, {"cache-executable", false},
		{"cache-link", false}, {"cache-hardlink", false}, {"cache-directory-link", false}, {"cache-root-link", false},
		{"cache-special-mode", false}, {"changed-indexed", false}, {"missing-route", false}, {"unsigned-route", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			root, index := manifestResponseCacheFixture(t)
			key := filepath.Join(root, manifestCacheFixture)
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			if test.name != "cold" {
				must(os.MkdirAll(filepath.Dir(key), 0755))
				if test.name != "meta-only" {
					must(os.WriteFile(key+".body", []byte("{}"), 0644))
				}
				if test.name != "body-only" {
					must(os.WriteFile(key+".meta", []byte("{}"), 0644))
				}
			}
			switch test.name {
			case "extra-js":
				must(os.WriteFile(filepath.Join(root, ".next/server/extra.js"), nil, 0644))
			case "extra-cache":
				must(os.WriteFile(key+".js", nil, 0644))
			case "other-owner":
				must(os.Mkdir(filepath.Join(root, coreResponseCacheRoot, "APP_ROUTE", strings.Repeat("a", 64)), 0755))
			case "cache-executable":
				must(os.Chmod(key+".body", 0755))
			case "cache-special-mode":
				must(os.Chmod(key+".body", 0644|os.ModeSetuid))
			case "cache-link":
				must(os.Remove(key + ".body"))
				must(os.Symlink(filepath.Join(root, "server.js"), key+".body"))
			case "cache-hardlink":
				must(os.Remove(key + ".body"))
				must(os.Link(filepath.Join(root, "server.js"), key+".body"))
			case "cache-directory-link", "cache-root-link":
				dir := filepath.Dir(key)
				if test.name == "cache-root-link" {
					dir = filepath.Join(root, coreResponseCacheRoot)
				}
				other := filepath.Join(t.TempDir(), "cache")
				must(os.Rename(dir, other))
				must(os.Symlink(other, dir))
			case "changed-indexed":
				must(os.WriteFile(filepath.Join(root, coreManifestRoute), []byte("changed"), 0644))
			case "missing-route":
				must(os.Remove(filepath.Join(root, coreManifestRoute)))
			case "unsigned-route":
				must(os.Remove(filepath.Join(root, coreManifestRoute)))
				for i, e := range index.Entries {
					if e.Path == coreManifestRoute {
						index.Entries = append(index.Entries[:i], index.Entries[i+1:]...)
						break
					}
				}
			}
			stop := make(chan struct{})
			var writers sync.WaitGroup
			if test.name == "concurrent" {
				writers.Add(1)
				go func() {
					defer writers.Done()
					for {
						select {
						case <-stop:
							return
						default:
						}
						for _, ext := range []string{".body", ".meta"} {
							_ = os.Remove(key + ext)
							_ = os.WriteFile(key+ext, []byte("{}"), 0644)
						}
					}
				}()
			}
			defer func() { close(stop); writers.Wait() }()
			checks := []struct {
				name   string
				verify func() error
			}{
				{"native", func() error {
					return verifyCoreContainerPayload(context.Background(), "fixture", root, index, func(context.Context, string) (int, error) { return os.Getpid(), nil })
				}},
				{"go-reference", func() error { return VerifyCorePayload(root, index) }},
				{"node-reference", func() error {
					raw, _ := json.Marshal(index)
					c := exec.Command("node", "-e", corePayloadVerifier, root)
					c.Stdin = bytes.NewReader(raw)
					return c.Run()
				}},
			}
			for _, check := range checks {
				t.Run(check.name, func(t *testing.T) {
					for i := 0; i < 3; i++ {
						if err := check.verify(); (err == nil) != test.valid {
							t.Fatalf("valid=%v: %v", test.valid, err)
						}
					}
				})
			}
		})
	}
}

func TestCoreArchiveRejectsResponseCache(t *testing.T) {
	for _, name := range []string{coreResponseCacheRoot, manifestCacheFixture + ".body", manifestCacheFixture + ".js"} {
		archive, digest := corePayloadFixture(t, tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0644})
		if _, err := IndexCorePayload(archive, digest); err == nil {
			t.Fatalf("signed archive accepted mutable response cache %s", name)
		}
	}
}

func TestCorePayloadFailurePersistsWithoutReplay(t *testing.T) {
	f := newCoreRunnerFixture(t)
	calls := 0
	execute := func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
		calls++
		out, known := corePayloadVerificationFailure("cp", corePayloadDiagnostic(fmt.Errorf("installed core contains an unrecorded path"), coreResponseCacheRoot+"/secret-user-name.js"))
		if !known {
			t.Fatal("missing diagnostic")
		}
		return out, nil
	}
	authorize := func(context.Context, CoreJournal, CoreStep) error { return nil }
	f.launch = func() error {
		out, err := f.runner.RunAction(context.Background(), f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256, authorize, execute)
		if err != nil || out.State != "failed" {
			t.Fatal(out, err)
		}
		return fmt.Errorf("lost acknowledgement")
	}
	_, _ = f.runner.Start(context.Background(), f.journal, f.step)
	// Recreate the reader and simulate reconnect after a lost launcher response.
	reader := f.runner
	out, err := reader.Observe(context.Background(), f.journal, f.step)
	if err != nil || out.State != "failed" || !strings.Contains(out.Evidence, "verify-members: cp manifest-response-cache: unrecorded-path") || strings.Contains(out.Evidence, "secret-user") {
		t.Fatal(out, err)
	}
	again, err := reader.RunAction(context.Background(), f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256, authorize, execute)
	if err != nil || again != out || calls != 1 {
		t.Fatal("replayed failed verification", again, err, calls)
	}
	for _, err := range []error{context.Canceled, context.DeadlineExceeded, fmt.Errorf("untrusted provider details")} {
		if _, known := corePayloadVerificationFailure("cp", corePayloadDiagnostic(err, coreResponseCacheRoot)); known {
			t.Fatal("uncertainty labelled a verified payload failure")
		}
	}
}
