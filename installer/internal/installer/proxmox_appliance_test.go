package installer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/kdomanski/iso9660"
)

func TestParseOptionsSelectsSupportedInstallerCommands(t *testing.T) {
	t.Setenv("YOUEYE_INSTALLER_PROVIDER", "")
	t.Setenv("YOUEYE_INSTALLER_RELEASES_API", "")
	opts, err := ParseOptions([]string{"proxmox", "--silent", "--yes", "--vmid", "166"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if !IsProxmoxMode(opts) || !opts.Silent || !opts.Yes || opts.ContainerID != "166" {
		t.Fatalf("unexpected Proxmox options: %+v", opts)
	}
	if opts.ApplianceReleaseProvider != "github" || opts.ApplianceReleasesAPI != defaultApplianceReleasesAPI || opts.ApplianceChannel != "stable" {
		t.Fatalf("official release defaults were not selected: %+v", opts)
	}
	opts, err = ParseOptions([]string{"install", "--silent", "--yes"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Mode != "install" {
		t.Fatalf("install command selected mode %q", opts.Mode)
	}
	for _, command := range []string{"network", "development-access", "console"} {
		opts, err = ParseOptions([]string{command}, strings.NewReader(""), io.Discard)
		if err != nil || opts.Mode != command {
			t.Fatalf("%s command selected mode %q: %v", command, opts.Mode, err)
		}
	}
	opts, err = ParseOptions([]string{"appliance"}, strings.NewReader(""), io.Discard)
	if err == nil {
		t.Fatalf("retired appliance command alias was accepted: %+v", opts)
	}
}

func TestParseOptionsDoesNotPrefillAlternativeReleaseSources(t *testing.T) {
	t.Setenv("YOUEYE_INSTALLER_PROVIDER", "forgejo")
	t.Setenv("YOUEYE_INSTALLER_RELEASES_API", "")
	opts, err := ParseOptions([]string{"proxmox"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opts.ApplianceReleaseProvider != "forgejo" || opts.ApplianceReleasesAPI != "" {
		t.Fatalf("Forgejo was unexpectedly prefilled: %+v", opts)
	}

	opts, err = ParseOptions([]string{"proxmox", "--provider", "custom", "--releases-api", "https://releases.example.test/api/releases"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opts.ApplianceReleaseProvider != "custom" || opts.ApplianceReleasesAPI != "https://releases.example.test/api/releases" {
		t.Fatalf("explicit custom source was not preserved: %+v", opts)
	}
}

func TestResolveApplianceReleaseNeverFallsBackChannels(t *testing.T) {
	var serverURL string
	assets := func(tag string) []applianceReleaseAsset {
		var result []applianceReleaseAsset
		for _, name := range append(append([]string{}, applianceSignedAssetNames...), applianceChecksumsFilename, applianceChecksumsSigName) {
			result = append(result, applianceReleaseAsset{Name: name, BrowserDownloadURL: serverURL + "/owner/YouEye/releases/download/" + tag + "/" + name})
		}
		return result
	}
	published := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	tags := []string{
		"appliance-dev-v0.5.23.0.0.4", "appliance-dev-v0.5.23.0.0.999-invalid+",
		"appliance-v0.5.9", "appliance-dev-v0.5.23.0.0.5", "appliance-v0.6.0",
		"appliance-dev-v0.5.23.0.0.7", "appliance-dev-v0.5.23.0.0.8",
		"appliance-dev-v0.5.23.0.0.9", "appliance-dev-v0.5.23.0.0.12",
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("page") != "1" {
			_ = json.NewEncoder(response).Encode([]applianceRelease{})
			return
		}
		releases := make([]applianceRelease, 0, len(tags))
		for index, tag := range tags {
			releases = append(releases, applianceRelease{TagName: tag, PublishedAt: published.Add(time.Duration(index) * time.Minute), Assets: assets(tag)})
		}
		if err := json.NewEncoder(response).Encode(releases); err != nil {
			t.Error(err)
		}
	}))
	serverURL = server.URL
	defer server.Close()

	development, err := resolveApplianceRelease(context.Background(), server.Client(), "custom", server.URL, "development", "")
	if err != nil || development.TagName != "appliance-dev-v0.5.23.0.0.12" {
		t.Fatalf("development resolution: release=%+v err=%v", development, err)
	}
	stable, err := resolveApplianceRelease(context.Background(), server.Client(), "custom", server.URL, "stable", "")
	if err != nil || stable.TagName != "appliance-v0.6.0" {
		t.Fatalf("stable resolution: release=%+v err=%v", stable, err)
	}
	if _, err := resolveApplianceRelease(context.Background(), server.Client(), "custom", server.URL, "exact", "appliance-dev-v9.9.9"); err == nil {
		t.Fatal("missing exact release unexpectedly fell back")
	}
}

func TestResolveApplianceReleaseFindsNewestCandidateAfterFirstPage(t *testing.T) {
	var serverURL string
	assets := func(tag string) []applianceReleaseAsset {
		var result []applianceReleaseAsset
		for _, name := range append(append([]string{}, applianceSignedAssetNames...), applianceChecksumsFilename, applianceChecksumsSigName) {
			result = append(result, applianceReleaseAsset{Name: name, BrowserDownloadURL: serverURL + "/owner/YouEye/releases/download/" + tag + "/" + name})
		}
		return result
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("limit") != "50" {
			t.Errorf("limit = %q, want 50", request.URL.Query().Get("limit"))
		}
		if request.URL.Query().Get("page") == "1" {
			releases := make([]applianceRelease, applianceForgejoPageSize)
			for index := range releases {
				releases[index] = applianceRelease{TagName: fmt.Sprintf("cp-dev-v0.0.%d", index), PublishedAt: time.Unix(int64(index+1), 0).UTC()}
			}
			_ = json.NewEncoder(response).Encode(releases)
			return
		}
		if request.URL.Query().Get("page") == "2" {
			tag := "appliance-dev-v0.5.6.0.3"
			_ = json.NewEncoder(response).Encode([]applianceRelease{{TagName: tag, PublishedAt: time.Now().UTC(), Assets: assets(tag)}})
			return
		}
		_ = json.NewEncoder(response).Encode([]applianceRelease{})
	}))
	serverURL = server.URL
	defer server.Close()

	release, err := resolveApplianceRelease(context.Background(), server.Client(), "forgejo", server.URL+"?limit=1", "development", "")
	if err != nil || release.TagName != "appliance-dev-v0.5.6.0.3" {
		t.Fatalf("paginated development resolution: release=%+v err=%v", release, err)
	}
}

func TestResolveApplianceReleaseUsesGitHubPaginationAndPublicationOrder(t *testing.T) {
	assets := func(tag string) []applianceReleaseAsset {
		var result []applianceReleaseAsset
		for _, name := range append(append([]string{}, applianceSignedAssetNames...), applianceChecksumsFilename, applianceChecksumsSigName) {
			result = append(result, applianceReleaseAsset{Name: name, BrowserDownloadURL: "https://github.com/YouEye-Platform/YouEye/releases/download/" + tag + "/" + name})
		}
		return result
	}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Query().Get("per_page") != "100" || request.URL.Query().Get("limit") != "" {
			t.Errorf("unexpected GitHub pagination: %s", request.URL.RawQuery)
		}
		var payload []applianceRelease
		switch request.URL.Query().Get("page") {
		case "1":
			payload = make([]applianceRelease, applianceGitHubPageSize)
			for index := range payload {
				payload[index] = applianceRelease{TagName: fmt.Sprintf("unrelated-v%d", index), PublishedAt: time.Unix(int64(index+1), 0).UTC()}
			}
		case "2":
			payload = []applianceRelease{
				{TagName: "appliance-dev-v9.0.0", PublishedAt: time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC), Assets: assets("appliance-dev-v9.0.0")},
				{TagName: "appliance-dev-v1.0.0", PublishedAt: time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC), Assets: assets("appliance-dev-v1.0.0")},
			}
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Status: "200 OK", Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(raw)), Request: request}, nil
	})}

	release, err := resolveApplianceRelease(context.Background(), client, "github", defaultApplianceReleasesAPI, "development", "")
	if err != nil {
		t.Fatal(err)
	}
	if release.TagName != "appliance-dev-v1.0.0" {
		t.Fatalf("release = %s, want most recently published tag", release.TagName)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestValidateApplianceReleaseAssetURLRejectsUnsafeIdentities(t *testing.T) {
	api, err := url.Parse("https://api.github.com/repos/YouEye-Platform/YouEye/releases")
	if err != nil {
		t.Fatal(err)
	}
	tests := []string{
		"https://downloads.example.test/YouEye-Platform/YouEye/releases/download/appliance-dev-v1.0.0/youeye-appliance-amd64.iso",
		"https://github.com/YouEye-Platform/YouEye/attachments/uuid",
		"https://github.com/YouEye-Platform/YouEye/releases/download/appliance-dev-v1.0.0/nested%2Fyoueye-appliance-amd64.iso",
		"https://github.com/another/YouEye/releases/download/appliance-dev-v1.0.0/youeye-appliance-amd64.iso",
	}
	for _, raw := range tests {
		if err := validateApplianceReleaseAssetURL("github", api, "appliance-dev-v1.0.0", applianceISOFilename, raw); err == nil {
			t.Fatalf("unsafe asset URL was accepted: %s", raw)
		}
	}
}

func TestApplianceReleaseAssetURLPreservesEncodedMultiSegmentBranchTag(t *testing.T) {
	api, err := url.Parse("https://api.github.com/repos/YouEye-Platform/YouEye/releases")
	if err != nil {
		t.Fatal(err)
	}
	tag := "appliance-codex/phase1-repository-builds-v1.2.3"
	raw := "https://github.com/YouEye-Platform/YouEye/releases/download/appliance-codex%2Fphase1-repository-builds-v1.2.3/youeye-appliance-amd64.iso"
	if !validExactApplianceReleaseTag(tag) {
		t.Fatalf("safe multi-segment exact release tag was rejected: %s", tag)
	}
	if err := validateApplianceReleaseAssetURL("github", api, tag, applianceISOFilename, raw); err != nil {
		t.Fatalf("encoded multi-segment release tag was rejected: %v", err)
	}
}

func TestGitHubReleaseAPIRequiresOneRepository(t *testing.T) {
	for _, raw := range []string{
		"https://api.github.com/repos/owner/repository/extra/releases",
		"https://api.github.com/repos/owner/releases",
		"https://github.com/repos/owner/repository/releases",
	} {
		if _, _, err := normalizeApplianceReleaseSource("github", raw); err == nil {
			t.Fatalf("unsafe GitHub releases API was accepted: %s", raw)
		}
	}
}

func TestApplianceReleaseRequiresExactAssetAndChecksumSets(t *testing.T) {
	api, err := url.Parse("https://api.github.com/repos/YouEye-Platform/YouEye/releases")
	if err != nil {
		t.Fatal(err)
	}
	tag := "appliance-dev-v1.0.0"
	assets := make([]applianceReleaseAsset, 0, len(applianceSignedAssetNames)+2)
	for _, name := range append(append([]string{}, applianceSignedAssetNames...), applianceChecksumsFilename, applianceChecksumsSigName) {
		assets = append(assets, applianceReleaseAsset{
			Name: name, BrowserDownloadURL: "https://github.com/YouEye-Platform/YouEye/releases/download/" + tag + "/" + name,
		})
	}
	release := applianceRelease{TagName: tag, Assets: assets}
	if err := validateApplianceReleaseAssets("github", api, release); err != nil {
		t.Fatalf("exact release assets rejected: %v", err)
	}
	release.Assets = append(release.Assets, applianceReleaseAsset{Name: "unexpected.bin", BrowserDownloadURL: "https://github.com/YouEye-Platform/YouEye/releases/download/" + tag + "/unexpected.bin"})
	if err := validateApplianceReleaseAssets("github", api, release); err == nil {
		t.Fatal("unexpected release asset was accepted")
	}

	var sums strings.Builder
	for _, name := range applianceSignedAssetNames {
		fmt.Fprintf(&sums, "%s  %s\n", strings.Repeat("a", 64), name)
	}
	parsed, err := parseSHA256SUMS([]byte(sums.String()))
	if err != nil || len(parsed) != len(applianceSignedAssetNames) {
		t.Fatalf("exact checksum set failed to parse: entries=%d err=%v", len(parsed), err)
	}
	if err := validateApplianceChecksumSet(parsed); err != nil {
		t.Fatalf("exact checksum set rejected: %v", err)
	}
	parsed["unexpected.bin"] = strings.Repeat("b", 64)
	if err := validateApplianceChecksumSet(parsed); err == nil {
		t.Fatal("unexpected checksum was accepted")
	}
}

func TestDevelopmentInstallerFailsClosedForStableTrust(t *testing.T) {
	_, err := downloadVerifiedApplianceRelease(context.Background(), http.DefaultClient, applianceRelease{TagName: "appliance-v1.0.0"}, t.TempDir(), "")
	if err == nil || !strings.Contains(err.Error(), "public stable trust is not provisioned") {
		t.Fatalf("stable release did not fail closed: %v", err)
	}
}

func TestProxmoxAdvancedReleaseSourceDefaults(t *testing.T) {
	model := newProxmoxApplianceModel(CLIOptions{
		ProxmoxOperation: "create", ProxmoxTargetDiskGB: 128, ProxmoxNetworkMode: "dhcp",
		ApplianceChannel: "stable", ApplianceReleaseProvider: "github", ApplianceReleasesAPI: defaultApplianceReleasesAPI,
	})
	updated, _ := model.Update(proxmoxInventoryMsg{Inventory: proxmoxApplianceInventory{
		ImageStorages: []string{"local-lvm"}, ISOStorages: []string{"local"}, Bridges: []string{"vmbr0"}, NextVMID: 166,
	}})
	model = updated.(proxmoxApplianceModel)
	if model.config.ReleaseProvider != "github" || model.config.ReleasesAPI != defaultApplianceReleasesAPI || model.inputs["releases-api"].Value() != "" {
		t.Fatalf("official source defaults are not safely hidden: config=%+v input=%q", model.config, model.inputs["releases-api"].Value())
	}
	model.cycleAdvancedSelection("release-provider", true)
	if model.config.ReleaseProvider != "forgejo" || model.config.ReleasesAPI != "" || model.inputs["releases-api"].Value() != "" {
		t.Fatalf("Forgejo source was unexpectedly prefilled: config=%+v input=%q", model.config, model.inputs["releases-api"].Value())
	}
	if got := estimatedProxmoxDataGiB(32); got != 7 {
		t.Fatalf("estimated 32 GiB data capacity = %d, want 7", got)
	}
}

func TestProxmoxQuickAndAdvancedUsePagedConditionalControls(t *testing.T) {
	model := newProxmoxApplianceModel(CLIOptions{
		ProxmoxOperation: "create", ProxmoxTargetDiskGB: 128, ProxmoxNetworkMode: "dhcp",
		ProxmoxImportHostSSHKeys: false, ApplianceChannel: "stable", ApplianceFreshness: "require-current",
		ApplianceReleaseProvider: defaultApplianceProvider, ApplianceReleasesAPI: defaultApplianceReleasesAPI,
	})
	updated, _ := model.Update(proxmoxInventoryMsg{Inventory: proxmoxApplianceInventory{
		ImageStorages: []string{"local-lvm"}, ISOStorages: []string{"local"}, Bridges: []string{"vmbr0"}, NextVMID: 166,
	}})
	model = updated.(proxmoxApplianceModel)
	updated, _ = model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	model = updated.(proxmoxApplianceModel)
	if !model.quick || model.page != 0 || !strings.Contains(model.View(), "Quick installation · VM · 1/6") {
		t.Fatalf("Quick did not enter shared page model: phase=%d page=%d", model.phase, model.page)
	}

	model.page = 3
	if fields := model.visibleAdvancedFields(); len(fields) != 4 || fields[2].Kind != "advanced-route" {
		t.Fatalf("Quick software page did not keep the public default plus Advanced route: %+v", fields)
	}
	model.quick = false
	model.page = 4
	model.config.Channel = "branch"
	model.config.ReleaseBranch = "feature/test"
	branchVisible, exactVisible := false, false
	for _, field := range model.visibleAdvancedFields() {
		branchVisible = branchVisible || field.InputKey == "branch"
		exactVisible = exactVisible || field.InputKey == "tag" || field.InputKey == "digest"
	}
	if !branchVisible || exactVisible {
		t.Fatalf("branch page controls were not conditional: %+v", model.visibleAdvancedFields())
	}

	model.page = 6
	for _, key := range []string{"root-password", "root-password-confirm"} {
		input := model.inputs[key]
		input.SetValue("a masked testing passphrase")
		model.inputs[key] = input
	}
	if rendered := model.View(); strings.Contains(rendered, "a masked testing passphrase") {
		t.Fatal("Proxmox TUI rendered a plaintext development password")
	}
	if err := model.validateAdvancedPage(); err != nil {
		t.Fatal(err)
	}
	if !validYescryptHash(model.config.Development.PasswordHash) || model.inputs["root-password"].Value() != "" || model.inputs["root-password-confirm"].Value() != "" {
		t.Fatal("development policy was not hashed and plaintext controls cleared")
	}
}

func TestProxmoxPageModelRendersDeterministicallyAtSupportedConsoleSizes(t *testing.T) {
	model := newProxmoxApplianceModel(CLIOptions{
		ProxmoxOperation: "create", ProxmoxTargetDiskGB: 128, ProxmoxNetworkMode: "dhcp",
		ApplianceChannel: "stable", ApplianceReleaseProvider: defaultApplianceProvider,
		ApplianceReleasesAPI: defaultApplianceReleasesAPI,
	})
	updated, _ := model.Update(proxmoxInventoryMsg{Inventory: proxmoxApplianceInventory{
		ImageStorages: []string{"local-lvm"}, ISOStorages: []string{"local"}, Bridges: []string{"vmbr0"}, NextVMID: 166,
	}})
	model = updated.(proxmoxApplianceModel)
	updated, _ = model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	model = updated.(proxmoxApplianceModel)
	for _, size := range []tea.WindowSizeMsg{{Width: 120, Height: 40}, {Width: 72, Height: 22}, {Width: 48, Height: 14}} {
		updated, _ = model.Update(size)
		resized := updated.(proxmoxApplianceModel)
		first, second := resized.View(), resized.View()
		if first != second || !strings.Contains(first, "Quick installation · VM · 1/6") {
			t.Fatalf("console %dx%d did not render a deterministic Quick snapshot", size.Width, size.Height)
		}
		if size.Width == 48 && resized.inputs["name"].Width != 18 {
			t.Fatalf("narrow console input width = %d, want 18", resized.inputs["name"].Width)
		}
	}
	model.height = 14
	model.phase = proxmoxPhaseReview
	model.keyPreflight = sshKeyImportResult{Rejected: map[sshKeyRejection]int{}}
	review := model.View()
	for _, text := range []string{"Review YouEye installation · 6/6", "Yes, erase and install", "No, go back"} {
		if !strings.Contains(review, text) {
			t.Fatalf("short Review snapshot hid %q", text)
		}
	}
}

func TestProxmoxQuickExplicitlyRestoresOfficialStablePolicy(t *testing.T) {
	model := newProxmoxApplianceModel(CLIOptions{
		ProxmoxOperation: "create", ProxmoxTargetDiskGB: 128, ProxmoxNetworkMode: "dhcp",
		ApplianceChannel: "branch", ApplianceReleaseBranch: "codex/phase1",
		ApplianceReleaseProvider: "custom", ApplianceReleasesAPI: "https://updates.example.test/releases",
	})
	updated, _ := model.Update(proxmoxInventoryMsg{Inventory: proxmoxApplianceInventory{
		ImageStorages: []string{"local-lvm"}, ISOStorages: []string{"local"}, Bridges: []string{"vmbr0"}, NextVMID: 166,
	}})
	model = updated.(proxmoxApplianceModel)
	updated, _ = model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	model = updated.(proxmoxApplianceModel)
	if model.config.Channel != "stable" || model.config.ReleaseProvider != "github" || model.config.ReleaseBranch != "" || model.inputs["branch"].Value() != "" {
		t.Fatalf("Quick retained an Advanced release override: %+v", model.config)
	}
}

func TestDecodeApplianceProgressLineToleratesConsoleNoise(t *testing.T) {
	line := []byte("\x1b[6nfirmware noise {not-json} \x1b[0m" +
		`{"schema":"youeye.installer.progress.v1","operation":"install","state":"complete","stage":"Install complete","percent":1}` +
		"\r shutdown output")
	record, ok := decodeApplianceProgressLine(line)
	if !ok || record.State != "complete" || record.Stage != "Install complete" {
		t.Fatalf("noisy appliance progress was not decoded: ok=%v record=%+v", ok, record)
	}
	if _, ok := decodeApplianceProgressLine([]byte("ordinary console output")); ok {
		t.Fatal("ordinary console output was decoded as appliance progress")
	}
}

func TestParseVMIPPrefersRoutableIPv4OverLinkLocal(t *testing.T) {
	raw := `[{"name":"lo","ip-addresses":[{"ip-address":"127.0.0.1","ip-address-type":"ipv4"}]},{"name":"ens18","ip-addresses":[{"ip-address":"169.254.66.141","ip-address-type":"ipv4"},{"ip-address":"192.168.31.61","ip-address-type":"ipv4"}]}]`
	if got := parseVMIP(raw); got != "192.168.31.61" {
		t.Fatalf("parseVMIP() = %q, want routable static address", got)
	}
	linkLocalOnly := `[{"name":"ens18","ip-addresses":[{"ip-address":"169.254.66.141","ip-address-type":"ipv4"}]}]`
	if got := parseVMIP(linkLocalOnly); got != "" {
		t.Fatalf("parseVMIP(link-local only) = %q, want empty", got)
	}
}

func TestProxmoxDurableReadinessRequiresCompletedDeploymentAndCurrentBless(t *testing.T) {
	for _, required := range []string{
		"/var/lib/youeye-state/first-deploy/complete",
		"/var/lib/youeye-state/first-deploy/progress.json",
		"/var/lib/youeye-state/first-deploy/health.json",
		"/var/lib/youeye-state/boot/last-bless.json",
		"/var/lib/youeye-state/boot/last-bless-health.json",
		"/proc/sys/kernel/random/boot_id",
	} {
		if !strings.Contains(proxmoxDurableReadinessScript, required) {
			t.Fatalf("durable readiness probe does not require %s", required)
		}
	}
	if !proxmoxGuestExecSucceeded(`{"exited":1,"exitcode":0}`) {
		t.Fatal("successful completed guest probe was rejected")
	}
	for _, result := range []string{
		`{"exited":0,"exitcode":0}`,
		`{"exited":1,"exitcode":1}`,
		`not-json`,
	} {
		if proxmoxGuestExecSucceeded(result) {
			t.Fatalf("incomplete or failed guest probe was accepted: %s", result)
		}
	}
}

func TestReadProxmoxGuestProgressAcceptsOnlyBoundedV2Records(t *testing.T) {
	progressJSON := `{"schema":"youeye.appliance.progress.v2","operation":"first-deploy","state":"running","stage":"server_interface","detail":"Installing the Server interface","percent":55,"attempt":2,"updated_at":"2026-08-16T00:00:00Z"}`
	runner := fakeProxmoxRunner{outputs: map[string]string{
		"qm guest exec 166 --timeout 10 -- /bin/sh -c test -s /var/lib/youeye-state/first-deploy/progress.json && test $(stat -c %s /var/lib/youeye-state/first-deploy/progress.json) -le 4096 && cat /var/lib/youeye-state/first-deploy/progress.json": `{"exited":1,"exitcode":0,"out-data":` + fmt.Sprintf("%q", progressJSON) + `}`,
	}}
	record, ok := readProxmoxGuestProgress(166, runner)
	if !ok || record.Stage != "server_interface" || record.Percent != 55 {
		t.Fatalf("safe guest progress was rejected: ok=%v record=%+v", ok, record)
	}
	runner.outputs["qm guest exec 166 --timeout 10 -- /bin/sh -c test -s /var/lib/youeye-state/first-deploy/progress.json && test $(stat -c %s /var/lib/youeye-state/first-deploy/progress.json) -le 4096 && cat /var/lib/youeye-state/first-deploy/progress.json"] =
		`{"exited":1,"exitcode":0,"out-data":"{\"schema\":\"youeye.appliance.progress.v2\",\"operation\":\"first-deploy\",\"stage\":\"unsafe stage\",\"percent\":101,\"attempt\":1}"}`
	if _, ok := readProxmoxGuestProgress(166, runner); ok {
		t.Fatal("malformed or out-of-range guest progress was accepted")
	}
}

func TestTerminalProxmoxGuestProgressFailsImmediatelyWithBoundedDetail(t *testing.T) {
	record := proxmoxGuestProgress{
		State: "needs_attention", Stage: "needs_attention",
		Detail:  "First deployment stopped after 8 attempts during verifying",
		Attempt: 8,
	}
	err := terminalProxmoxGuestProgressError(171, record)
	if err == nil || !strings.Contains(err.Error(), "VM 171 needs attention after first-deployment attempt 8") ||
		!strings.Contains(err.Error(), record.Detail) {
		t.Fatalf("terminal progress error = %v", err)
	}
	if err := terminalProxmoxGuestProgressError(171, proxmoxGuestProgress{State: "running", Stage: "verifying", Attempt: 1}); err != nil {
		t.Fatalf("running progress was treated as terminal: %v", err)
	}
}

func TestWaitForProxmoxApplianceReadyStopsOnNeedsAttention(t *testing.T) {
	progressJSON := `{"schema":"youeye.appliance.progress.v2","operation":"first-deploy","state":"needs_attention","stage":"needs_attention","detail":"First deployment stopped during verifying","percent":99,"attempt":8,"updated_at":"2026-08-19T00:00:00Z"}`
	runner := fakeProxmoxRunner{outputs: map[string]string{
		"qm guest exec 171 --timeout 10 -- /bin/sh -c test -s /var/lib/youeye-state/first-deploy/progress.json && test $(stat -c %s /var/lib/youeye-state/first-deploy/progress.json) -le 4096 && cat /var/lib/youeye-state/first-deploy/progress.json": `{"exited":1,"exitcode":0,"out-data":` + fmt.Sprintf("%q", progressJSON) + `}`,
	}}
	updates := make(chan proxmoxApplianceProgress, 2)
	err := waitForProxmoxApplianceReady(context.Background(), 171, "https://192.0.2.171", runner, updates, time.Second)
	if err == nil || !strings.Contains(err.Error(), "VM 171 needs attention") {
		t.Fatalf("needs-attention progress did not stop readiness immediately: %v", err)
	}
}

func TestProxmoxGuestProgressStateAllowlist(t *testing.T) {
	for _, state := range []string{"running", "retrying", "needs_attention", "complete"} {
		if !validProxmoxGuestProgressState(state) {
			t.Fatalf("valid state %q was rejected", state)
		}
	}
	for _, state := range []string{"", "failed", "success", "NEEDS_ATTENTION"} {
		if validProxmoxGuestProgressState(state) {
			t.Fatalf("invalid state %q was accepted", state)
		}
	}
}

func TestDownloadApplianceAssetCanRefreshSameSizeCache(t *testing.T) {
	wanted := []byte("verified release bytes")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(wanted)
	}))
	defer server.Close()

	destination := filepath.Join(t.TempDir(), "asset")
	if err := os.WriteFile(destination, []byte("corrupted release byte"), 0o600); err != nil {
		t.Fatal(err)
	}
	asset := applianceReleaseAsset{Name: "asset", BrowserDownloadURL: server.URL, Size: int64(len(wanted))}
	if err := downloadApplianceAsset(context.Background(), server.Client(), asset, destination, 1<<20, false); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(wanted)
	if err := verifyPathSHA256(destination, fmt.Sprintf("%x", digest[:])); err != nil {
		t.Fatal(err)
	}
}

func TestWriteApplianceAnswerISO(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "answer.iso")
	answer := applianceAnswer{
		Schema: applianceAnswerSchema, Operation: "erase-install", EraseConfirmed: true,
		TransactionID:  "0123456789abcdef0123456789abcdef",
		TargetSerial:   "TARGET-TEST",
		Network:        applianceAnswerNetwork{Mode: "dhcp"},
		ReleasePolicy:  defaultApplianceReleasePolicy(),
		Development:    defaultDevelopmentAccessPolicy(),
		AuthorizedKeys: []string{testApplianceAuthorizedKey(t)},
	}
	if err := writeApplianceAnswerISO(destination, answer); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	image, err := iso9660.OpenImage(file)
	if err != nil {
		t.Fatal(err)
	}
	label, err := image.Label()
	if err != nil || strings.TrimSpace(label) != "YOUEYE_ANSWER" {
		t.Fatalf("answer ISO label=%q err=%v", label, err)
	}
	root, err := image.RootDir()
	if err != nil {
		t.Fatal(err)
	}
	children, err := root.GetChildren()
	if err != nil {
		t.Fatal(err)
	}
	if len(children) != 1 || children[0].Name() != "appliance-answer.json" {
		t.Fatalf("answer ISO children: %+v", children)
	}
	raw, err := io.ReadAll(children[0].Reader())
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseApplianceAnswer(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.TransactionID != answer.TransactionID || parsed.TargetSerial != answer.TargetSerial || len(parsed.AuthorizedKeys) != 1 {
		t.Fatalf("unexpected answer payload: %+v", parsed)
	}
}

func TestNewApplianceTransactionIDIsValidAndUnique(t *testing.T) {
	first, err := newApplianceTransactionID()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newApplianceTransactionID()
	if err != nil {
		t.Fatal(err)
	}
	if !validApplianceTransactionID(first) || !validApplianceTransactionID(second) || first == second {
		t.Fatalf("invalid transaction identities: %q %q", first, second)
	}
}

func TestInspectCompatibleProxmoxApplianceVM(t *testing.T) {
	runner := fakeProxmoxRunner{outputs: map[string]string{
		"qm status 166": "status: stopped",
		"qm config 166": strings.Join([]string{
			"name: youeye-166", "bios: ovmf", "machine: q35",
			"description: YouEye signed appliance appliance-dev-v0.5.23.0.0.12; one-drive ISO install.",
			"scsi0: local-lvm:vm-166-disk-1,size=128G,serial=TARGET166",
		}, "\n"),
		"pvesm path local-lvm:vm-166-disk-1": "/dev/pve/vm-166-disk-1",
		"sgdisk -p /dev/pve/vm-166-disk-1":   "GPT: YE-ESP YE-RECOVERY YE-SYSTEM-A YE-SYSTEM-B YE-STATE YE-DATA",
		"blkid -p /dev/pve/vm-166-disk-1":    `PTTYPE="gpt"`,
	}}
	vm, err := inspectCompatibleProxmoxApplianceVM(166, runner)
	if err != nil {
		t.Fatal(err)
	}
	if vm.Name != "youeye-166" || vm.TargetDiskGiB != 128 || vm.TargetSerial != "TARGET166" || vm.RecordedRelease != "appliance-dev-v0.5.23.0.0.12" {
		t.Fatalf("unexpected compatible VM: %+v", vm)
	}
}

func TestInspectCompatibleProxmoxApplianceVMAllowsForeignOrPartialDisk(t *testing.T) {
	runner := fakeProxmoxRunner{outputs: map[string]string{
		"qm status 166":                      "status: stopped",
		"qm config 166":                      "name: youeye-166\nbios: ovmf\nmachine: q35\nscsi0: local-lvm:vm-166-disk-1,size=128G,serial=TARGET166",
		"pvesm path local-lvm:vm-166-disk-1": "/dev/pve/vm-166-disk-1",
		"sgdisk -p /dev/pve/vm-166-disk-1":   "MBR with one partial foreign partition",
		"blkid -p /dev/pve/vm-166-disk-1":    `TYPE="ext4"`,
	}}
	vm, err := inspectCompatibleProxmoxApplianceVM(166, runner)
	if err != nil {
		t.Fatalf("confirmed full erase was blocked by foreign contents: %v", err)
	}
	if !strings.Contains(vm.TargetContents, "foreign") {
		t.Fatalf("existing contents were not retained for review: %+v", vm)
	}
}

func TestCreateProxmoxApplianceVMUsesOneInstallationDrive(t *testing.T) {
	runner := &recordingProxmoxRunner{errors: map[string]error{"qm config 166": fmt.Errorf("missing")}}
	config := proxmoxApplianceConfig{
		VMID: 166, Name: "youeye-166", CPUCores: 4, RAMMiB: 8192,
		TargetStorage: "local-lvm", TargetDiskGiB: 128, Bridge: "vmbr0",
	}
	if err := createProxmoxApplianceVM(config, "YEIDISK166", "local:iso/youeye.iso", "local:iso/answer.iso", "appliance-dev-v0.5.23.0.0.12", runner); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.calls, "\n")
	if strings.Contains(joined, "--scsi1") {
		t.Fatalf("one-drive appliance creation attached a second target:\n%s", joined)
	}
	for _, required := range []string{
		"qm set 166 --scsi0 local-lvm:128,discard=on,iothread=1,ssd=1,serial=YEIDISK166",
		"qm set 166 --boot order=ide2;scsi0",
		"one-drive ISO install",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("one-drive appliance creation missing %q:\n%s", required, joined)
		}
	}
}

func TestAttachProxmoxApplianceMediaRefreshesReleaseDescription(t *testing.T) {
	runner := &recordingProxmoxRunner{outputs: map[string]string{"qm status 166": "status: stopped"}}
	if err := attachProxmoxApplianceMedia(166, "local:iso/youeye.iso", "local:iso/answer.iso", "appliance-dev-v0.5.23.0.0.12", runner); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.calls, "\n")
	for _, required := range []string{
		"qm status 166",
		"qm set 166 --description YouEye signed appliance appliance-dev-v0.5.23.0.0.12; one-drive ISO install.",
		"qm set 166 --ide2 local:iso/youeye.iso,media=cdrom",
		"qm set 166 --sata0 local:iso/answer.iso,media=cdrom",
		"qm set 166 --boot order=ide2;scsi0",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("reinstall preparation missing %q:\n%s", required, joined)
		}
	}
}

func TestSensitiveProxmoxAnswerMediaIsProtectedAndRemoved(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source.iso")
	destination := filepath.Join(dir, "answer.iso")
	if err := os.WriteFile(source, []byte("protected answer media"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &recordingProxmoxRunner{outputs: map[string]string{
		"pvesm path local:iso/answer.iso": destination,
		"qm status 166":                   "status: running",
	}}
	_, path, err := stageProxmoxSensitiveISO("local", source, "answer.iso", runner)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("sensitive staged mode=%#o, want 0600", info.Mode().Perm())
	}
	if err := cleanupProxmoxAnswerMedia(166, path, true, runner); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("sensitive answer media was retained: %v", err)
	}
	joined := strings.Join(runner.calls, "\n")
	for _, required := range []string{"qm stop 166", "qm set 166 --delete sata0"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("cleanup omitted %q:\n%s", required, joined)
		}
	}
}

func TestWaitForProxmoxInstallerRequiresTerminalSuccess(t *testing.T) {
	previousInterval := proxmoxInstallerStatusInterval
	proxmoxInstallerStatusInterval = time.Millisecond
	defer func() { proxmoxInstallerStatusInterval = previousInterval }()

	runner := fakeProxmoxRunner{outputs: map[string]string{"qm status 166": "status: stopped"}}
	serial := make(chan applianceProgressRecord)
	close(serial)
	progress := make(chan proxmoxApplianceProgress, 8)
	err := waitForProxmoxInstaller(context.Background(), 166, runner, serial, progress)
	if err == nil || !strings.Contains(err.Error(), "without a terminal success record") {
		t.Fatalf("unexpected stopped-installer result: %v", err)
	}

	serial = make(chan applianceProgressRecord, 1)
	serial <- applianceProgressRecord{Schema: "youeye.installer.progress.v1", State: "complete", Stage: "complete", Percent: 1}
	close(serial)
	if err := waitForProxmoxInstaller(context.Background(), 166, runner, serial, progress); err != nil {
		t.Fatalf("terminal success was rejected: %v", err)
	}
}

type fakeProxmoxRunner struct {
	outputs map[string]string
	errors  map[string]error
}

type recordingProxmoxRunner struct {
	calls   []string
	outputs map[string]string
	errors  map[string]error
}

func (runner *recordingProxmoxRunner) Run(name string, args ...string) (string, error) {
	key := strings.Join(append([]string{name}, args...), " ")
	runner.calls = append(runner.calls, key)
	return runner.outputs[key], runner.errors[key]
}

func (runner fakeProxmoxRunner) Run(name string, args ...string) (string, error) {
	key := strings.Join(append([]string{name}, args...), " ")
	return runner.outputs[key], runner.errors[key]
}

func TestPrivateForgejoMainTrustIsProviderAndDepthBound(t *testing.T) {
	good := applianceRelease{TagName: "appliance-v0.5.6.0.3", sourceProvider: "forgejo", sourceRepository: "https://forgejo.example.test/owner/YouEye"}
	if !privateForgejoMainRelease(good) {
		t.Fatal("private main profile rejected")
	}
	for _, change := range []func(*applianceRelease){
		func(r *applianceRelease) { r.sourceProvider = "github" },
		func(r *applianceRelease) { r.sourceProvider = "custom" },
		func(r *applianceRelease) { r.sourceRepository = "https://github.com/owner/YouEye" },
		func(r *applianceRelease) { r.sourceRepository = "http://forgejo.example.test/owner/YouEye" },
		func(r *applianceRelease) {
			r.sourceRepository = "https://user:password@forgejo.example.test/owner/YouEye"
		},
		func(r *applianceRelease) { r.TagName = "appliance-v1.0.0" },
		func(r *applianceRelease) { r.TagName = "appliance-dev-v0.5.6.0.3" },
		func(r *applianceRelease) { r.TagName = "appliance-v0.5.6.0.3.1" },
	} {
		bad := good
		change(&bad)
		if privateForgejoMainRelease(bad) {
			t.Fatal("unapproved main profile accepted", bad.TagName, bad.sourceProvider)
		}
	}
}
