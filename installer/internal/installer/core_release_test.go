package installer

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreInstallerDiscoveryPreservesBranchAndExactAnswerBytes(t *testing.T) {
	var manifestRaw []byte
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
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	source := server.URL + "/owner/YouEye"
	core := releasecache.CoreRelease{Schema: releasecache.CoreReleaseSchema, Version: "0.5.37-worker-abcdef.1", Tag: "youeye-v0.5.37-worker-abcdef.1", Source: source, Branch: "Team/Fix", SourceCommit: strings.Repeat("a", 40), Channel: "feature", Sequence: 1, MinimumReader: 1, Authority: releasecache.CoreReleaseAuthority, Compatibility: releasecache.CoreCompatibility{StateMin: 1, StateMax: 1, DataMin: 1, DataMax: 1, MinimumRelease: "0.5.37", Capabilities: []string{"core-release-v1"}}}
	for _, role := range []string{"installer", "media", "appliance", "system-update", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap", "spine", "cp", "ui"} {
		blob := func(name string) releasecache.CoreBlob {
			return releasecache.CoreBlob{Name: name, URL: source + "/releases/download/" + core.Tag + "/appliance-" + name, SHA256: strings.Repeat("b", 64), SizeBytes: 42}
		}
		member := releasecache.CoreMember{Role: role, BuildVersion: core.Version, Source: source, Branch: core.Branch, SourceCommit: core.SourceCommit, Tag: core.Tag, InputSHA256: strings.Repeat("c", 64), Artifact: blob(role + ".bin")}
		if role == "cp" {
			member.DependsOn = []string{"spine"}
		}
		if role == "ui" {
			member.DependsOn = []string{"cp"}
		}
		if role == "appliance" {
			inputs := blob("build-inputs.json")
			member.BuildInputs = &inputs
		}
		core.Members = append(core.Members, member)
	}
	manifestRaw, _ = json.MarshalIndent(core, "", "  ")
	manifestRaw = append(manifestRaw, '\n')
	release = applianceRelease{TagName: core.Tag, Assets: []applianceReleaseAsset{{Name: "core-release.json", BrowserDownloadURL: source + "/releases/download/" + core.Tag + "/core-release.json", Size: int64(len(manifestRaw))}}}
	api := server.URL + "/api/v1/repos/owner/YouEye/releases"
	selected, err := resolveApplianceRelease(t.Context(), server.Client(), "custom", api, "branch:Team/Fix", "")
	if err != nil || selected.core == nil || selected.core.Branch != "Team/Fix" {
		t.Fatal("exact branch was folded", err)
	}
	if _, err := resolveApplianceRelease(t.Context(), server.Client(), "custom", api, "branch:team/fix", ""); err == nil {
		t.Fatal("different branch was selected")
	}
	answer := applianceAnswer{Schema: applianceAnswerSchema, Operation: "erase-install", TransactionID: strings.Repeat("a", 32), TargetSerial: "TARGET", EraseConfirmed: true, Network: applianceAnswerNetwork{Mode: "dhcp"}, ReleasePolicy: applianceReleasePolicy{Schema: releasePolicySchema, Provider: "custom", ReleasesAPI: api, Mode: "exact", ExactTag: core.Tag, ManifestSHA256: strings.Repeat("b", 64), CoreManifestSHA256: selected.coreSHA256, Freshness: "require-current"}, Development: defaultDevelopmentAccessPolicy(), CoreRelease: coreAnswerFromRelease(selected)}
	encoded, _ := json.MarshalIndent(answer, "", "    ")
	decoded, err := parseApplianceAnswer(encoded)
	if err != nil {
		t.Fatal("formatting changed exact bytes", err)
	}
	if decoded.CoreRelease.ManifestBase64 != answer.CoreRelease.ManifestBase64 {
		t.Fatal("answer rewrote core manifest")
	}
	// Both an interactive input and a supplied answer reach the same exact
	// selection before the provider discovers or writes disks.
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
		t.Fatal("lost runtime selection", err)
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
		t.Fatal("resume did not retain the exact selection", err)
	}
	resumeInput.TransactionID = strings.Repeat("c", 32)
	if _, err = restoreCoreInstallSelection(coreSelectionRunner{raw: string(retained)}, applianceDisk{Path: "/dev/test", Serial: "TARGET"}, resumeInput, bundle.ManifestSHA256); err == nil {
		t.Fatal("resume accepted another transaction's selection")
	}
	cachedInput := input
	cachedInput.ReleaseCacheSHA256 = strings.Repeat("f", 64)
	if _, err = prepareCoreInstallInput(t.Context(), cachedInput, bundle, nil, true); err == nil {
		t.Fatal("cache silently lost its frozen transport")
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
	manifestRaw = append([]byte(" "), manifestRaw...)
	retampered, err := resolveApplianceRelease(t.Context(), server.Client(), "custom", api, "exact", core.Tag)
	if err == nil && retampered.coreSHA256 == selected.coreSHA256 {
		t.Fatal("changed document kept its digest")
	}
}

type coreSelectionRunner struct{ raw string }

func (r coreSelectionRunner) Run(_ string, _ ...string) (string, error) { return r.raw, nil }

// testCoreDocument returns a valid core-release.json for source/version/branch.
func testCoreDocument(t *testing.T, source, version, branch string) []byte {
	t.Helper()
	channel := "stable"
	if parts := strings.SplitN(version, "-", 2); len(parts) == 2 {
		channel = strings.SplitN(parts[1], ".", 2)[0]
		if channel != "dev" && channel != "alpha" && channel != "beta" {
			channel = "feature"
		}
	}
	tag := "youeye-v" + version
	core := releasecache.CoreRelease{Schema: releasecache.CoreReleaseSchema, Version: version, Tag: tag, Source: source, Branch: branch, SourceCommit: strings.Repeat("a", 40), Channel: channel, Sequence: 1, MinimumReader: 1, Authority: releasecache.CoreReleaseAuthority, Compatibility: releasecache.CoreCompatibility{StateMin: 1, StateMax: 1, DataMin: 1, DataMax: 1, MinimumRelease: "0.5.37", Capabilities: []string{"core-release-v1"}}}
	for _, role := range []string{"installer", "media", "appliance", "system-update", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap", "spine", "cp", "ui"} {
		blob := func(name string) releasecache.CoreBlob {
			return releasecache.CoreBlob{Name: name, URL: source + "/releases/download/" + tag + "/" + name, SHA256: strings.Repeat("b", 64), SizeBytes: 42}
		}
		member := releasecache.CoreMember{Role: role, BuildVersion: version, Source: source, Branch: branch, SourceCommit: core.SourceCommit, Tag: tag, InputSHA256: strings.Repeat("c", 64), Artifact: blob(role + ".bin")}
		switch role {
		case "cp":
			member.DependsOn = []string{"spine"}
		case "ui":
			member.DependsOn = []string{"cp"}
		case "appliance":
			inputs := blob("build-inputs.json")
			member.BuildInputs = &inputs
		}
		core.Members = append(core.Members, member)
	}
	raw, err := json.MarshalIndent(core, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := releasecache.ParseCoreRelease(raw); err != nil {
		t.Fatal(err)
	}
	return append(raw, '\n')
}
