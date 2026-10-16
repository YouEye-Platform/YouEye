package installer

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreInstallerDiscoveryPreservesBranchAndExactAnswerBytes(t *testing.T) {
	key, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(key)
	fingerprint := sha256.Sum256(der)
	prior := embeddedApplianceDevelopmentTrust
	embeddedApplianceDevelopmentTrust = pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	t.Cleanup(func() { embeddedApplianceDevelopmentTrust = prior })
	var manifestRaw, signature []byte
	var release applianceRelease
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/releases"):
			if r.URL.Query().Get("page") == "2" {
				w.Write([]byte("[]"))
				return
			}
			json.NewEncoder(w).Encode([]applianceRelease{release})
		case strings.HasSuffix(r.URL.Path, "/core-release.json"):
			w.Write(manifestRaw)
		case strings.HasSuffix(r.URL.Path, "/core-release.json.sig"):
			w.Write(signature)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	source := server.URL + "/owner/YouEye"
	core := releasecache.CoreRelease{Schema: releasecache.CoreReleaseSchema, Version: "0.5.37-worker-abcdef.1", Tag: "youeye-v0.5.37-worker-abcdef.1", Source: source, Branch: "Team/Fix", SourceCommit: strings.Repeat("a", 40), Channel: "feature", Sequence: 1, MinimumReader: 1, SignerSHA256: hex.EncodeToString(fingerprint[:]), Compatibility: releasecache.CoreCompatibility{StateMin: 1, StateMax: 1, DataMin: 1, DataMax: 1, MinimumRelease: "0.5.37", Capabilities: []string{"core-release-v1"}}}
	for _, role := range []string{"installer", "media", "appliance", "system-update", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap", "spine", "cp", "ui"} {
		blob := func(name string) releasecache.CoreBlob {
			return releasecache.CoreBlob{Name: name, URL: source + "/releases/download/" + core.Tag + "/appliance-" + name, SHA256: strings.Repeat("b", 64), SizeBytes: 42}
		}
		member := releasecache.CoreMember{Role: role, BuildVersion: core.Version, Source: source, Branch: core.Branch, SourceCommit: core.SourceCommit, Tag: core.Tag, InputSHA256: strings.Repeat("c", 64), KeyID: core.SignerSHA256, Artifact: blob(role + ".bin"), Checksums: blob("SHA256SUMS"), Signature: blob("SHA256SUMS.sig"), Provenance: blob("provenance.json"), SBOM: blob("sbom.spdx.json")}
		if role == "cp" {
			member.DependsOn = []string{"spine"}
		}
		if role == "ui" {
			member.DependsOn = []string{"cp"}
		}
		if role == "appliance" || role == "system-update" {
			sig := blob(role + ".sig")
			member.DocumentSignature = &sig
		}
		if role == "appliance" {
			lock := blob("release-lock.json")
			member.ReleaseLock = &lock
		}
		core.Members = append(core.Members, member)
	}
	manifestRaw, _ = json.MarshalIndent(core, "", "  ")
	manifestRaw = append(manifestRaw, '\n')
	signature = ed25519.Sign(private, manifestRaw)
	release = applianceRelease{TagName: core.Tag, Assets: []applianceReleaseAsset{{Name: "core-release.json", BrowserDownloadURL: source + "/releases/download/" + core.Tag + "/core-release.json", Size: int64(len(manifestRaw))}, {Name: "core-release.json.sig", BrowserDownloadURL: source + "/releases/download/" + core.Tag + "/core-release.json.sig", Size: int64(len(signature))}}}
	api := server.URL + "/api/v1/repos/owner/YouEye/releases"
	selected, err := resolveApplianceRelease(t.Context(), server.Client(), "custom", api, "branch:Team/Fix", "")
	if err != nil || selected.core == nil || selected.core.Branch != "Team/Fix" {
		t.Fatal("exact branch was folded", err)
	}
	if _, err := resolveApplianceRelease(t.Context(), server.Client(), "custom", api, "branch:team/fix", ""); err == nil {
		t.Fatal("different branch acquired authority")
	}
	answer := applianceAnswer{Schema: applianceAnswerCoreSchema, Operation: "erase-install", TransactionID: strings.Repeat("a", 32), TargetSerial: "TARGET", EraseConfirmed: true, Network: applianceAnswerNetwork{Mode: "dhcp"}, ReleasePolicy: applianceReleasePolicy{Schema: releasePolicySchema, Provider: "custom", ReleasesAPI: api, Mode: "exact", ExactTag: core.Tag, ManifestSHA256: strings.Repeat("b", 64), CoreManifestSHA256: selected.coreSHA256, Freshness: "require-current"}, Development: defaultDevelopmentAccessPolicy(), CoreRelease: coreAnswerFromRelease(selected)}
	encoded, _ := json.MarshalIndent(answer, "", "    ")
	decoded, err := parseApplianceAnswer(encoded)
	if err != nil {
		t.Fatal("formatting changed signed bytes", err)
	}
	if decoded.CoreRelease.ManifestBase64 != answer.CoreRelease.ManifestBase64 {
		t.Fatal("answer rewrote core manifest")
	}
	// Both an interactive/legacy-shaped input and a supplied v5 answer reach
	// the same signed selection before the provider discovers or writes disks.
	bundle := verifiedApplianceBundle{ManifestSHA256: strings.Repeat("b", 64), Manifest: applianceBundleManifest{
		ImageVersion: core.Version, SourceCommit: core.SourceCommit,
		ReleaseSet: applianceManifestReleases{Source: source, Branch: core.Branch,
			Spine: applianceManifestComponent{Version: core.Version, SourceCommit: core.SourceCommit, ArtifactSHA256: strings.Repeat("b", 64)}},
	}}
	input := applianceInstallInput{Operation: "erase-install", TransactionID: answer.TransactionID, TargetSerial: "TARGET", EraseConfirmed: true, Network: answer.Network, Development: answer.Development, ReleasePolicy: answer.ReleasePolicy, AnswerPath: "/original/answer.json"}
	input.ReleasePolicy.CoreManifestSHA256 = ""
	prepared, err := prepareCoreInstallInput(t.Context(), input, bundle, server.Client(), true)
	if err != nil || prepared.CoreRelease == nil || prepared.AnswerPath != "" || prepared.CoreRelease.ManifestBase64 != answer.CoreRelease.ManifestBase64 {
		t.Fatal("complete selection was not frozen", err)
	}
	path, err := writeRuntimeApplianceAnswer(prepared, applianceDisk{Serial: "TARGET"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(path) })
	saved, err := loadApplianceInstallInput(installConfig{ApplianceAnswerPath: path})
	if err != nil || saved.CoreRelease == nil || saved.ReleasePolicy.CoreManifestSHA256 != selected.coreSHA256 {
		t.Fatal("lost runtime v5 selection", err)
	}
	if _, err := prepareCoreInstallInput(t.Context(), saved, bundle, nil, true); err != nil {
		t.Fatal("frozen answer unexpectedly needed discovery", err)
	}
	retained, _ := json.Marshal(map[string]any{"transaction_id": answer.TransactionID, "target_serial": "TARGET", "manifest_sha256": bundle.ManifestSHA256, "release_policy": saved.ReleasePolicy, "core_release": saved.CoreRelease})
	resumeInput := input
	resumeInput.Operation = "resume"
	restored, err := restoreCoreInstallSelection(coreSelectionRunner{raw: string(retained)}, applianceDisk{Path: "/dev/test", Serial: "TARGET"}, resumeInput, bundle.ManifestSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = prepareCoreInstallInput(t.Context(), restored, bundle, nil, true); err != nil {
		t.Fatal("resume did not retain signed selection", err)
	}
	resumeInput.TransactionID = strings.Repeat("c", 32)
	if _, err = restoreCoreInstallSelection(coreSelectionRunner{raw: string(retained)}, applianceDisk{Path: "/dev/test", Serial: "TARGET"}, resumeInput, bundle.ManifestSHA256); err == nil {
		t.Fatal("resume accepted another transaction's selection")
	}
	cachedInput := input
	cachedInput.ReleaseCacheSHA256 = strings.Repeat("f", 64)
	if _, err = prepareCoreInstallInput(t.Context(), cachedInput, bundle, nil, true); err == nil {
		t.Fatal("v4 cache silently lost its frozen transport")
	}
	wrong := bundle
	wrong.ManifestSHA256 = strings.Repeat("e", 64)
	if _, err := prepareCoreInstallInput(t.Context(), saved, wrong, nil, true); err == nil {
		t.Fatal("foreign media accepted")
	}
	resuming := input
	resuming.Operation = "resume"
	if _, err := prepareCoreInstallInput(t.Context(), resuming, bundle, nil, true); err == nil {
		t.Fatal("resume selected a moving release")
	}
	answer.CoreRelease.ManifestSHA256 = strings.Repeat("f", 64)
	if err := validateApplianceAnswer(answer); err == nil {
		t.Fatal("changed exact selection accepted")
	}
	signature[0] ^= 1
	if _, err := resolveApplianceRelease(t.Context(), server.Client(), "custom", api, "exact", core.Tag); err == nil {
		t.Fatal("tampered core signature accepted")
	}
}

type coreSelectionRunner struct{ raw string }

func (r coreSelectionRunner) Run(_ string, _ ...string) (string, error) { return r.raw, nil }
