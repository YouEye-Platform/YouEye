package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

func TestNativeCoreAuthorityRechecksLivePolicyAndPreservesFrozenContinuation(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	key, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(key)
	source := r.Source
	r.Source = "https://forge.example/owner/YouEye"
	r.Version, r.Tag, r.Channel = "0.5.37-alpha.1", "youeye-v0.5.37-alpha.1", "alpha"
	r.SignerSHA256 = checksum(der)
	r.Compatibility.MinimumRelease = "0.5.36"
	r.Compatibility.StateMin = 2
	r.Compatibility.StateMax = 2
	for i := range r.Members {
		m := &r.Members[i]
		m.Source = r.Source
		m.KeyID = r.SignerSHA256
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM, m.DocumentSignature, m.ReleaseLock} {
			if b != nil {
				b.URL = strings.Replace(b.URL, source, r.Source, 1)
			}
		}
	}
	raw, _ = json.Marshal(r)
	digest := checksum(raw)
	sig := ed25519.Sign(private, raw)
	trust := filepath.Join(root, "key.pub")
	if err = os.WriteFile(trust, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	state := testState()
	statePath := filepath.Join(root, "appliance-state.json")
	stateRaw, _ := json.Marshal(state)
	if err = os.WriteFile(statePath, stateRaw, 0600); err != nil {
		t.Fatal(err)
	}
	machine := CoreMachineIdentity{InstallIDRef: state.InstallIDRef, DeviceIDRef: state.DeviceIDRef, ParentDiskID: state.ParentDiskID, StatePartUUID: state.StatePartUUID, DataPartUUID: state.DataPartUUID}
	m := CoreManager{Root: filepath.Join(root, "core")}
	receipt, err := m.Initialize(ctx, CoreHostSelection{Raw: raw, Signature: sig}, digest, trust, func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		return machine, "fixture acceptance", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	j := CoreJournal{RequestID: "authority-fixture", ManifestSHA256: digest, Target: r, Previous: receipt, Phase: "prepared", RestartRequired: true, Steps: []CoreStep{{Name: "checkpoint", State: "pending"}}}
	selection := CoreReleaseSelection{Source: r.Source, Branch: r.Branch}
	manifestURL := r.Source + "/releases/download/" + r.Tag + "/core-release.json"
	requests := 0
	offline := false
	client := &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		if offline {
			return nil, fmt.Errorf("fixture offline")
		}
		data := raw
		if strings.Contains(req.URL.Path, "/api/v1/repos/") {
			data, _ = json.Marshal([]release{{TagName: r.Tag, Assets: []releaseAsset{{Name: "core-release.json", BrowserDownloadURL: manifestURL}, {Name: "core-release.json.sig", BrowserDownloadURL: manifestURL + ".sig"}}}})
			if req.URL.Query().Get("page") != "1" {
				data = []byte("[]")
			}
		} else if strings.HasSuffix(req.URL.Path, ".sig") {
			data = sig
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
	})}
	a := NativeCoreAuthority{Checkpoint: NativeCoreCheckpoint{Root: m.Root, DataRoot: root, StatePath: statePath, MachineObservation: func() (CoreMachineIdentity, error) { return machine, nil }}, TrustKeyPath: trust, Client: client, CurrentSelection: func() (CoreReleaseSelection, error) { return selection, nil }}
	if err = a.AuthorizeTarget(ctx, j, false); err != nil {
		t.Fatal(err)
	}
	if requests == 0 {
		t.Fatal("initial policy did not verify selected release")
	}
	offline = true
	if err = a.AuthorizeTarget(ctx, j, true); err == nil {
		t.Fatal("stale restart admitted without discovery")
	}
	j.Steps[0].State = "started"
	j.Phase = "applying"
	before := requests
	if err = a.AuthorizeTarget(ctx, j, true); err != nil {
		t.Fatal("frozen continuation required new discovery", err)
	}
	if requests != before {
		t.Fatal("re-resolved in-flight transaction")
	}
	selection.Branch = "Other"
	if err = a.AuthorizeTarget(ctx, j, true); err == nil {
		t.Fatal("ignored changed source policy")
	}
	if err = a.AuthorizePrevious(ctx, j); err != nil {
		t.Fatal("channel change prevented independently authorized recovery", err)
	}
	selection.Branch = r.Branch
	machine.DeviceIDRef = "another-device"
	if err = a.AuthorizeTarget(ctx, j, true); err == nil {
		t.Fatal("ignored hardware replacement")
	}
	machine = receipt.Machine
	oldLookup := coreTrustLookup
	t.Cleanup(func() { coreTrustLookup = oldLookup })
	coreTrustLookup = func(source, branch, scope string) (*updatetrust.Grant, error) {
		if scope == "cp" {
			return nil, fmt.Errorf("fixture revoked CP grant")
		}
		return nil, nil
	}
	if err = a.AuthorizeTarget(ctx, j, true); err == nil {
		t.Fatal("revoked component admitted")
	}
	if err = a.AuthorizePrevious(ctx, j); err == nil {
		t.Fatal("recovery ignored previous component revocation")
	}
}

func TestCoreCompatibilityAndExactChannelBoundaries(t *testing.T) {
	_, _, r := coreJournalFixture(t)
	r.Compatibility.MinimumRelease = "0.5.36"
	r.Compatibility.StateMin = 2
	r.Compatibility.StateMax = 2
	state := testState()
	if err := validateCoreCompatibility(r, state, r.Version); err != nil {
		t.Fatal(err)
	}
	if err := validateCoreCompatibility(r, state, "0.5.1"); err == nil {
		t.Fatal("missing bridge accepted")
	}
	state.DataSchemaVersion++
	if err := validateCoreCompatibility(r, state, r.Version); err == nil {
		t.Fatal("future Data accepted")
	}
	state = testState()
	r.Compatibility.Capabilities = append(r.Compatibility.Capabilities, "future-reader")
	if err := validateCoreCompatibility(r, state, r.Version); err == nil {
		t.Fatal("unknown capability accepted")
	}
	selection := CoreReleaseSelection{Source: r.Source, Branch: "Team/Fix", Fallback: []string{"main"}}
	digest := strings.Repeat("a", 64)
	if err := validateCoreChannelSelection(selection, r, digest); err != nil {
		t.Fatal(err)
	}
	selection.Tag = r.Tag
	selection.ManifestSHA256 = digest
	if err := validateCoreChannelSelection(selection, r, digest); err == nil {
		t.Fatal("exact pin silently used fallback")
	}
	selection.Branch = "main"
	selection.ManifestSHA256 = strings.Repeat("b", 64)
	if err := validateCoreChannelSelection(selection, r, digest); err == nil {
		t.Fatal("different exact digest accepted")
	}
}
