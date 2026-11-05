package cmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

func installedReaderFixture(t *testing.T) (coreInstalledReaderObserver, string) {
	t.Helper()
	root := t.TempDir()
	current := "/var/lib/youeye-state/development-overlays/artifacts/devart-b-fixture/youeye"
	payload := []byte("exact explicitly bound quick Spine reader")
	digest := fmt.Sprintf("%x", sha256.Sum256(payload))
	write := func(path string, raw []byte, mode os.FileMode) {
		t.Helper()
		path = filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, mode); err != nil {
			t.Fatal(err)
		}
	}
	marker, _ := json.Marshal(map[string]any{"schema": "youeye.development-overlay-runtime.v1", "component": "spine", "state": "active", "unsigned": true, "artifact_id": "devart-b-fixture", "source_commit": strings.Repeat("a", 40), "sha256": digest})
	write(coreBakedExecutable, []byte("unchanged canonical baked Spine"), 0755)
	write(current, payload, 0700)
	write("/run/youeye/development-overlay/spine.json", marker, 0600)
	write("/run/systemd/system/youeye.service.d/90-youeye-development-spine.conf", []byte("[Service]\nExecStart=\nExecStart="+current+" api serve\n"), 0600)
	return coreInstalledReaderObserver{Root: root, Owner: uint32(os.Geteuid()), CurrentExecutable: func() (string, error) { return current, nil }, CurrentSHA256: func() (string, error) { return digest, nil }, APISHA256: func(context.Context) (string, error) { return digest, nil }}, current
}

func TestInstalledReaderQuickOverlayPreservesBakedMembership(t *testing.T) {
	o, _ := installedReaderFixture(t)
	got, err := observeCoreInstalledReader(context.Background(), o)
	if err != nil || got.Executable != coreBakedExecutable || !got.Bound || got.ReaderClass != "unsigned-development" {
		t.Fatalf("valid explicit reader must observe unchanged baked membership: %+v, %v", got, err)
	}
}

func TestInstalledReaderCanonicalCLIWithQuickAPIKeepsBakedVersionCheck(t *testing.T) {
	o, _ := installedReaderFixture(t)
	o.CurrentExecutable = func() (string, error) { return coreBakedExecutable, nil }
	o.CurrentSHA256 = func() (string, error) { return o.hash(coreBakedExecutable) }
	got, err := observeCoreInstalledReader(context.Background(), o)
	if err != nil || got.Executable != coreBakedExecutable || got.Bound || got.ReaderClass != "baked" {
		t.Fatal(got, err)
	}
}

func TestInstalledReaderUnregisteredBakedAndUnknownSelf(t *testing.T) {
	o, external := installedReaderFixture(t)
	for _, path := range []string{spineCandidateOverlay, coreQuickSpineDropIn} {
		if err := os.Remove(o.path(path)); err != nil {
			t.Fatal(err)
		}
	}
	o.CurrentExecutable = func() (string, error) { return coreBakedExecutable, nil }
	o.CurrentSHA256 = func() (string, error) { return o.hash(coreBakedExecutable) }
	got, err := observeCoreInstalledReader(context.Background(), o)
	if err != nil || got.Bound || got.ReaderClass != "baked" {
		t.Fatal(got, err)
	}
	o.CurrentExecutable = func() (string, error) { return external, nil }
	if _, err := observeCoreInstalledReader(context.Background(), o); err == nil {
		t.Fatal("unregistered external executable accepted")
	}
}

func TestInstalledReaderQuickBindingRejectsChangedRuntime(t *testing.T) {
	for _, name := range []string{"self path", "self bytes", "API bytes", "API unavailable", "dropin", "marker removed", "orphan signed override", "corrupt production registration", "corrupt candidate registration", "canceled observation"} {
		t.Run(name, func(t *testing.T) {
			o, current := installedReaderFixture(t)
			switch name {
			case "self path":
				o.CurrentExecutable = func() (string, error) { return "/tmp/youeye", nil }
			case "self bytes":
				o.CurrentSHA256 = func() (string, error) { return strings.Repeat("f", 64), nil }
			case "API bytes":
				o.APISHA256 = func(context.Context) (string, error) { return strings.Repeat("f", 64), nil }
			case "API unavailable":
				o.APISHA256 = func(context.Context) (string, error) { return "", errors.New("unavailable") }
			case "dropin":
				if err := os.WriteFile(o.path(coreQuickSpineDropIn), []byte("[Service]\nExecStart=/tmp/other api serve\n"), 0600); err != nil {
					t.Fatal(err)
				}
			case "marker removed":
				if err := os.Remove(o.path(spineCandidateOverlay)); err != nil {
					t.Fatal(err)
				}
			case "orphan signed override":
				if err := os.WriteFile(o.path(spineCandidateDropIn), candidateOverride(current), 0600); err != nil {
					t.Fatal(err)
				}
			case "corrupt production registration":
				path := o.path(filepath.Join(systemupdate.CoreStatePath, "bootstrap-coordinator.json"))
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(`{"schema":"corrupt"}`), 0600); err != nil {
					t.Fatal(err)
				}
				o.APISHA256 = func(context.Context) (string, error) {
					t.Fatal("corrupt production registration fell through to API")
					return "", nil
				}
			case "corrupt candidate registration":
				path := o.path(filepath.Join(systemupdate.SpineCandidateRoot, "active.json"))
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(`{"schema":"corrupt"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "canceled observation":
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				if _, err := observeCoreInstalledReader(ctx, o); err == nil {
					t.Fatal("canceled observation accepted")
				}
				return
			}
			if _, err := observeCoreInstalledReader(context.Background(), o); err == nil {
				t.Fatal("changed reader accepted")
			}
		})
	}
}

func TestInstalledReaderQuickMarkerRequiresExactHonestProducer(t *testing.T) {
	for _, name := range []string{"duplicate", "trailing", "signed marker", "unknown", "unsigned false", "bad source", "bad hash", "bad ID", "traversal"} {
		t.Run(name, func(t *testing.T) {
			o, _ := installedReaderFixture(t)
			path := o.path(spineCandidateOverlay)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var marker map[string]any
			if err := json.Unmarshal(raw, &marker); err != nil {
				t.Fatal(err)
			}
			switch name {
			case "duplicate":
				raw = []byte(strings.Replace(string(raw), `"component":"spine"`, `"component":"spine","component":"spine"`, 1))
			case "trailing":
				raw = append(raw, []byte(` {}`)...)
			case "signed marker":
				marker["unsigned"] = false
				marker["signed"] = true
			case "unknown":
				marker["other"] = true
			case "unsigned false":
				marker["unsigned"] = false
			case "bad source":
				marker["source_commit"] = "main"
			case "bad hash":
				marker["sha256"] = strings.Repeat("f", 64)
			case "bad ID":
				marker["artifact_id"] = "spine-candidate-b-other"
			case "traversal":
				marker["artifact_id"] = "devart-b-../other"
			}
			if name != "duplicate" && name != "trailing" {
				raw, err = json.Marshal(marker)
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := observeCoreInstalledReader(context.Background(), o); err == nil {
				t.Fatal("invalid marker accepted")
			}
		})
	}
}

func TestInstalledReaderQuickFilesRejectUnsafeFilesystem(t *testing.T) {
	for _, name := range []string{"binary symlink", "binary hardlink", "binary writable", "binary not executable", "marker symlink", "marker writable", "dropin symlink", "parent symlink", "parent writable", "wrong owner", "oversized marker"} {
		t.Run(name, func(t *testing.T) {
			o, current := installedReaderFixture(t)
			binary, marker, dropin := o.path(current), o.path(spineCandidateOverlay), o.path(coreQuickSpineDropIn)
			link := func(path string) {
				t.Helper()
				target := path + ".original"
				if err := os.Rename(path, target); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			}
			switch name {
			case "binary symlink":
				link(binary)
			case "binary hardlink":
				if err := os.Link(binary, binary+".alias"); err != nil {
					t.Fatal(err)
				}
			case "binary writable":
				if err := os.Chmod(binary, 0777); err != nil {
					t.Fatal(err)
				}
			case "binary not executable":
				if err := os.Chmod(binary, 0600); err != nil {
					t.Fatal(err)
				}
			case "marker symlink":
				link(marker)
			case "marker writable":
				if err := os.Chmod(marker, 0666); err != nil {
					t.Fatal(err)
				}
			case "dropin symlink":
				link(dropin)
			case "parent symlink":
				link(filepath.Dir(binary))
			case "parent writable":
				if err := os.Chmod(filepath.Dir(binary), 0777); err != nil {
					t.Fatal(err)
				}
			case "wrong owner":
				o.Owner++
			case "oversized marker":
				if err := os.WriteFile(marker, []byte(strings.Repeat(" ", 16385)), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := observeCoreInstalledReader(context.Background(), o); err == nil {
				t.Fatal("unsafe reader evidence accepted")
			}
		})
	}
}

func TestInstalledReaderQuickEvidenceIsRecheckedAfterAPI(t *testing.T) {
	for _, name := range []string{"marker", "dropin", "payload", "self"} {
		t.Run(name, func(t *testing.T) {
			o, current := installedReaderFixture(t)
			originalHash := o.APISHA256
			o.APISHA256 = func(ctx context.Context) (string, error) {
				digest, err := originalHash(ctx)
				path := map[string]string{"marker": spineCandidateOverlay, "dropin": coreQuickSpineDropIn, "payload": current}[name]
				if name == "self" {
					o.CurrentExecutable = func() (string, error) { return "/tmp/foreign", nil }
				} else if writeErr := os.WriteFile(o.path(path), []byte("changed"), 0700); writeErr != nil {
					t.Fatal(writeErr)
				}
				return digest, err
			}
			// Self is a process observation, not a mutable file in the fixture.
			if name == "self" {
				calls := 0
				o.CurrentExecutable = func() (string, error) {
					calls++
					if calls > 1 {
						return "/tmp/foreign", nil
					}
					return current, nil
				}
			}
			if _, err := observeCoreInstalledReader(context.Background(), o); err == nil {
				t.Fatal("changed evidence accepted after API observation")
			}
		})
	}
}

func TestInstalledReaderHostWrapperUsesAuthenticatedObservation(t *testing.T) {
	o, _ := installedReaderFixture(t)
	previous := coreInstalledReaderHost
	coreInstalledReaderHost = func() coreInstalledReaderObserver { return o }
	t.Cleanup(func() { coreInstalledReaderHost = previous })
	path, bound, err := coreInstalledExecutable()
	if err != nil || path != o.path(coreBakedExecutable) || !bound {
		t.Fatal(path, bound, err)
	}
}

func productionInstalledReaderFixture(t *testing.T) (coreInstalledReaderObserver, string, *mixedCoreDeploymentFixture) {
	t.Helper()
	f := newMixedCoreDeploymentFixture(t)
	sbom := []byte(`{"spdxVersion":"SPDX-2.3","packages":[]}`)
	var member releasecache.CoreMember
	for index := range f.release.Members {
		m := &f.release.Members[index]
		if m.Role == "spine" {
			m.SBOM.SHA256 = mixedCoreHash(sbom)
			m.SBOM.SizeBytes = int64(len(sbom))
			member = *m
		}
	}
	f.writeSelection(t)
	for _, m := range f.release.Members {
		if m.Role == "spine" {
			member = m
		}
	}
	o := coreInstalledReaderHost()
	m := systemupdate.CoreManager{Root: o.path(systemupdate.CoreStatePath)}
	raw, err := os.ReadFile(filepath.Join(f.root, "core-release.json"))
	if err != nil {
		t.Fatal(err)
	}
	sig, err := os.ReadFile(filepath.Join(f.root, "core-release.json.sig"))
	if err != nil {
		t.Fatal(err)
	}
	proofRaw, err := os.ReadFile(filepath.Join(f.root, systemupdate.CoreMetadataProofName))
	if err != nil {
		t.Fatal(err)
	}
	var proof releasecache.CoreMetadataProof
	if err := json.Unmarshal(proofRaw, &proof); err != nil {
		t.Fatal(err)
	}
	digest := mixedCoreHash(raw)
	previous := f.release
	previous.Members = append([]releasecache.CoreMember(nil), f.release.Members...)
	for index := range previous.Members {
		if previous.Members[index].Role == "appliance" {
			previous.Members[index].Artifact.SHA256 = strings.Repeat("f", 64)
		}
	}
	journal := systemupdate.CoreJournal{Schema: systemupdate.CoreJournalSchema, RequestID: "registered-production-reader", ManifestSHA256: digest, Target: f.release, Previous: systemupdate.CoreReceipt{ManifestSHA256: strings.Repeat("e", 64), Release: previous, Machine: systemupdate.CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state-fixture", DataPartUUID: "data-fixture"}, AcceptedAt: "2026-11-04T14:00:00Z", Evidence: "prepared native fixture"}, Phase: "prepared", RestartRequired: true}
	for _, name := range []string{"verify-members", "stage-host", "checkpoint", "activate-host", "host-health", "apply-cp", "apply-ui", "authenticated-health", "commit-host"} {
		journal.Steps = append(journal.Steps, systemupdate.CoreStep{Name: name, RequestID: journal.RequestID + "/" + name, State: "pending"})
	}
	journalRaw, _ := json.Marshal(journal)
	write := func(path string, data []byte, mode os.FileMode) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(m.Root, "journal.json"), journalRaw, 0600)
	write(filepath.Join(m.Root, "targets", digest+".json"), raw, 0600)
	write(filepath.Join(m.Root, "targets", digest+".json.sig"), sig, 0600)
	write(filepath.Join(m.Root, "targets", digest+".metadata.json"), proofRaw, 0600)
	reader, err := m.BootstrapBinaryPath(member.Artifact.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(f.binary)
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{"youeye": payload, "checksums": proof.SpineChecksums, "signature": proof.SpineSignature, "provenance": proof.SpineProvenance, "sbom": sbom, systemupdate.CoreMetadataProofName: proofRaw} {
		write(filepath.Join(filepath.Dir(reader), name), data, 0700)
	}
	if _, err := m.RegisterBootstrap(journal.RequestID, digest, reader, systemupdate.CoreDevelopmentTrustPath); err != nil {
		t.Fatal("real signed registration failed", err)
	}
	logical, err := o.logical(reader)
	if err != nil {
		t.Fatal(err)
	}
	o.CurrentExecutable = func() (string, error) { return logical, nil }
	o.CurrentSHA256 = func() (string, error) { return member.Artifact.SHA256, nil }
	o.APISHA256 = func(context.Context) (string, error) {
		t.Fatal("production registered reader inherited development API observation")
		return "", nil
	}
	// Lower-priority test state can be stale/corrupt while a registered production
	// coordinator owns continuation. It supplies no permission to another self.
	write(o.path(spineCandidateOverlay), []byte(`{"corrupt":"lower priority"}`), 0600)
	write(o.path(filepath.Join(systemupdate.SpineCandidateRoot, "active.json")), []byte(`{"corrupt":"lower priority"}`), 0600)
	return o, logical, f
}

func TestInstalledReaderProductionBootstrapPriorityUsesActualSignedRegistration(t *testing.T) {
	o, _, _ := productionInstalledReaderFixture(t)
	got, err := observeCoreInstalledReader(context.Background(), o)
	if err != nil || got.Executable != coreBakedExecutable || got.ReaderClass != "production-bootstrap" || !got.Bound {
		t.Fatal("registered exact production self did not retain priority", got, err)
	}
	o.CurrentExecutable = func() (string, error) { return coreBakedExecutable, nil }
	o.CurrentSHA256 = func() (string, error) { return o.hash(coreBakedExecutable) }
	got, err = observeCoreInstalledReader(context.Background(), o)
	if err != nil || got.ReaderClass != "baked" || got.Bound {
		t.Fatal("canonical current self lost baked classification", got, err)
	}
}

func TestInstalledReaderProductionBootstrapRejectsForeignSelfAndChangedAuthority(t *testing.T) {
	for _, name := range []string{"foreign same bytes", "self bytes", "reader payload", "production record", "target proof", "revoked signer"} {
		t.Run(name, func(t *testing.T) {
			o, reader, f := productionInstalledReaderFixture(t)
			switch name {
			case "foreign same bytes":
				o.CurrentExecutable = func() (string, error) { return "/tmp/other-youeye", nil }
			case "self bytes":
				o.CurrentSHA256 = func() (string, error) { return strings.Repeat("f", 64), nil }
			case "reader payload":
				if err := os.WriteFile(o.path(reader), []byte("changed"), 0700); err != nil {
					t.Fatal(err)
				}
			case "production record":
				if err := os.WriteFile(o.path(filepath.Join(systemupdate.CoreStatePath, "bootstrap-coordinator.json")), []byte(`{"schema":"corrupt"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "target proof":
				m := systemupdate.CoreManager{Root: o.path(systemupdate.CoreStatePath)}
				j, err := m.Read()
				if err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(m.Root, "targets", j.ManifestSHA256+".metadata.json")
				if err := os.WriteFile(path, bytes.Repeat([]byte{'x'}, 64), 0600); err != nil {
					t.Fatal(err)
				}
			case "revoked signer":
				for index := range f.trust.Grants {
					if f.trust.Grants[index].Scope == "spine" {
						f.trust.Grants[index].Revoked = true
					}
				}
				if err := updatetrust.Save(updatetrust.Path, f.trust); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := observeCoreInstalledReader(context.Background(), o); err == nil {
				t.Fatal("production permission leaked or changed protected authority accepted")
			}
		})
	}
}
