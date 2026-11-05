package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

func coreReadyFixture(t *testing.T) (CoreReaderReadiness, CoreHostSelection, string, *int) {
	t.Helper()
	manager, _, target := coreJournalFixture(t)
	key, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(key)
	previous := publicReleaseTrustJSON
	publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": map[string]string{"stable": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}})
	t.Cleanup(func() { publicReleaseTrustJSON = previous })
	target.SignerSHA256 = checksum(der)
	for i := range target.Members {
		target.Members[i].KeyID = target.SignerSHA256
	}
	var member *releasecache.CoreMember
	for i := range target.Members {
		if target.Members[i].Role == "spine" {
			member = &target.Members[i]
		}
	}
	member.BuildVersion, member.Tag = target.Version, target.Tag
	files := map[string][]byte{}
	blob := func(name string, data []byte) releasecache.CoreBlob {
		b := releasecache.CoreBlob{Name: name, URL: target.Source + "/releases/download/" + target.Tag + "/" + name, SHA256: checksum(data), SizeBytes: int64(len(data))}
		files[b.URL] = data
		return b
	}
	member.Artifact = blob("spine-linux-amd64", []byte("original signed future reader; not executed"))
	provenance, _ := json.Marshal(map[string]any{"component": "spine", "version": member.BuildVersion, "source_commit": member.SourceCommit, "reader_capabilities": coreReaderRequiredCapabilities})
	member.Provenance = blob("spine-provenance.json", provenance)
	member.SBOM = blob("spine-sbom.json", []byte(`{"packages":[]}`))
	var sums strings.Builder
	for _, b := range []releasecache.CoreBlob{member.Artifact, member.Provenance, member.SBOM} {
		fmt.Fprintf(&sums, "%s  %s\n", b.SHA256, b.Name)
	}
	member.Checksums = blob("spine-checksums", []byte(sums.String()))
	member.Signature = blob("spine-signature", ed25519.Sign(private, []byte(sums.String())))
	raw, _ := json.Marshal(target)
	selection := CoreHostSelection{Raw: raw, Signature: ed25519.Sign(private, raw)}
	digest := checksum(raw)
	requests := 0
	cache := CoreArtifactCache{Root: filepath.Join(t.TempDir(), "cache"), AvailableBytes: func(string) (uint64, error) { return 1 << 30, nil }, Client: &http.Client{Transport: signedRedirectTransport(func(request *http.Request) (*http.Response, error) {
		requests++
		data, ok := files[request.URL.String()]
		if !ok {
			return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("not found")), Header: http.Header{}, Request: request}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: request}, nil
	})}}
	installed, err := manager.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	store := CoreReaderReadiness{Manager: manager, Cache: cache, Checkpoint: NativeCoreCheckpoint{Root: manager.Root, MachineObservation: func() (CoreMachineIdentity, error) { return installed.Machine, nil }}, Hardware: func() (string, error) { return "30803ef1-d063-48ed-88df-2196f3b2e869", nil }, Quiescent: func(_ context.Context, run func() error) error { return run() }}
	return store, selection, digest, &requests
}

func TestCoreReadyAcquireIsDurableAndCreatesNoNativeIntent(t *testing.T) {
	store, selection, digest, calls := coreReadyFixture(t)
	before, err := store.Manager.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	ready, err := store.Acquire(context.Background(), selection, digest)
	if err != nil {
		t.Fatal(err)
	}
	if *calls == 0 || ready.State != "ready" || ready.ManifestSHA256 != digest {
		t.Fatal("reader did not acquire real signed envelope")
	}
	if _, err := store.Manager.Read(); !os.IsNotExist(err) {
		t.Fatal("acquisition created native journal", err)
	}
	if _, err := store.Manager.readBootstrap(); !os.IsNotExist(err) {
		t.Fatal("acquisition registered coordinator", err)
	}
	if _, err := os.Stat(filepath.Join(store.Manager.Root, "requests")); !os.IsNotExist(err) {
		t.Fatal("acquisition created request history")
	}
	after, err := store.Manager.ReadReceipt()
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("acquisition changed installed receipt", err)
	}
	restarted := store
	restarted.Manager = CoreManager{Root: store.Manager.Root}
	current, err := restarted.Current(selection, digest)
	if err != nil || !reflect.DeepEqual(current, ready) {
		t.Fatal("API restart/reboot lost authenticated readiness", err)
	}
	count := *calls
	if _, err := restarted.Acquire(context.Background(), selection, digest); err != nil {
		t.Fatal(err)
	}
	if *calls != count {
		t.Fatal("valid repeated acquisition redownloaded/replayed work")
	}
}
func TestCoreReadyPartialAcquisitionNeverBecomesAccepted(t *testing.T) {
	store, selection, digest, _ := coreReadyFixture(t)
	store.BeforeReady = func() error { return fmt.Errorf("interrupted before readiness publication") }
	if _, err := store.Acquire(context.Background(), selection, digest); err == nil {
		t.Fatal("interrupted acquisition accepted")
	}
	if _, err := store.Read(); !os.IsNotExist(err) {
		t.Fatal("partial attempt published readiness", err)
	}
	if _, err := store.Manager.Read(); !os.IsNotExist(err) {
		t.Fatal("partial acquisition created native intent")
	}
	store.BeforeReady = nil
	if _, err := store.Acquire(context.Background(), selection, digest); err != nil {
		t.Fatal("exact retry failed to settle verified partial assets", err)
	}
}
func TestCoreReadyRejectsChangedSelectionMachineBytesAndRevocation(t *testing.T) {
	store, selection, digest, _ := coreReadyFixture(t)
	ready, err := store.Acquire(context.Background(), selection, digest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Current(selection, strings.Repeat("f", 64)); err == nil {
		t.Fatal("stale selected manifest accepted")
	}
	copy := store
	copy.Hardware = func() (string, error) { return "40803ef1-d063-48ed-88df-2196f3b2e869", nil }
	if _, err := copy.Current(selection, digest); err == nil {
		t.Fatal("another machine borrowed ready reader")
	}
	priorLookup := coreTrustLookup
	t.Cleanup(func() { coreTrustLookup = priorLookup })
	coreTrustLookup = func(source, branch, scope string) (*updatetrust.Grant, error) {
		if scope == "spine" {
			return nil, fmt.Errorf("revoked")
		}
		return priorLookup(source, branch, scope)
	}
	if _, err := store.Current(selection, digest); err == nil {
		t.Fatal("revoked reader authority fell back")
	}
	coreTrustLookup = priorLookup
	if err := os.Chmod(ready.Executable, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ready.Executable, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Current(selection, digest); err == nil {
		t.Fatal("corrupt retained reader accepted")
	}
}
func TestCoreReadyDoesNotRetargetDuringActiveWorkOrBorrowOtherSources(t *testing.T) {
	store, selection, digest, calls := coreReadyFixture(t)
	store.Quiescent = func(context.Context, func() error) error { return fmt.Errorf("native transaction active") }
	if _, err := store.Acquire(context.Background(), selection, digest); err == nil {
		t.Fatal("active work replaced reader state")
	}
	if _, err := store.Read(); !os.IsNotExist(err) {
		t.Fatal("active work published ready record")
	}
	var target releasecache.CoreRelease
	if err := json.Unmarshal(selection.Raw, &target); err != nil {
		t.Fatal(err)
	}
	installed, _ := store.Manager.ReadReceipt()
	target.Source = "https://forge.example/team/YouEye"
	if CoreReaderEligible(target, installed) {
		t.Fatal("custom selected source acquired official fallback")
	}
	target.Source = releasecache.OfficialRepository
	target.Members[11].Source = "https://forge.example/team/YouEye"
	if CoreReaderEligible(target, installed) {
		t.Fatal("private original Spine borrowed public scope")
	}
	_ = calls
}
func TestCoreReadyWrongSignatureCannotPublish(t *testing.T) {
	store, selection, digest, calls := coreReadyFixture(t)
	selection.Signature[0] ^= 1
	if _, err := store.Acquire(context.Background(), selection, digest); err == nil {
		t.Fatal("wrong signature admitted")
	}
	if *calls != 0 {
		t.Fatal("unauthenticated selection downloaded")
	}
	if _, err := store.Read(); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("wrong signature published state")
	}
}

func TestCoreReadyActiveRetargetPreservesPriorReadiness(t *testing.T) {
	store, selection, digest, _ := coreReadyFixture(t)
	ready, err := store.Acquire(context.Background(), selection, digest)
	if err != nil {
		t.Fatal(err)
	}
	ready.ManifestSHA256 = strings.Repeat("f", 64)
	raw, _ := json.Marshal(ready)
	if err := atomicWrite(store.path(), raw, 0600); err != nil {
		t.Fatal(err)
	}
	store.Quiescent = func(context.Context, func() error) error { return fmt.Errorf("active owner must settle") }
	if _, err := store.Acquire(context.Background(), selection, digest); err == nil {
		t.Fatal("active work allowed retarget")
	}
	after, err := os.ReadFile(store.path())
	if err != nil || !bytes.Equal(raw, after) {
		t.Fatal("active retarget replaced prior protected evidence", err)
	}
}
func TestCoreReaderCapabilityDeclarationMatchesImplementedContract(t *testing.T) {
	raw, err := os.ReadFile("../../../.youeye/release/reader-capabilities.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Schema       string   `json:"schema"`
		Capabilities []string `json:"capabilities"`
	}
	if json.Unmarshal(raw, &contract) != nil || contract.Schema != "youeye.reader-capabilities.v1" || !reflect.DeepEqual(contract.Capabilities, coreReaderRequiredCapabilities) {
		t.Fatal("source capability declaration drifted from implemented native reader contract")
	}
}

func TestCoreReadyConsumerLeasePreventsRetargetRace(t *testing.T) {
	store, selection, digest, _ := coreReadyFixture(t)
	lease, err := store.Lease()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Acquire(context.Background(), selection, digest); !errors.Is(err, ErrCoreReaderBusy) {
		t.Fatal("retarget raced exact Stage consumer lease", err)
	}
	lease()
	if _, err := store.Acquire(context.Background(), selection, digest); err != nil {
		t.Fatal(err)
	}
}
