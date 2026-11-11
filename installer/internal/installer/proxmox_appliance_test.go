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

func TestParseOptionsRepositoryURL(t *testing.T) {
	t.Setenv("YOUEYE_INSTALLER_REPOSITORY", "")
	opts, err := ParseOptions([]string{"proxmox", "--repository", "https://code.example.test/owner/YouEye.git"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opts.ApplianceRepository != "https://code.example.test/owner/YouEye" || opts.ApplianceReleaseProvider != "custom" || opts.ApplianceReleasesAPI != "https://code.example.test/api/v1/repos/owner/YouEye/releases" {
		t.Fatalf("repository was not normalized: %+v", opts)
	}
	for _, args := range [][]string{{"proxmox", "--provider", "custom"}, {"proxmox", "--releases-api", "https://code.example.test/releases"}, {"proxmox", "--repository", "https://user:password@code.example.test/owner/YouEye"}} {
		if _, err := ParseOptions(args, strings.NewReader(""), io.Discard); err == nil {
			t.Fatal("retired flags or unsafe repository accepted")
		}
	}
}

// coreReleaseServer serves a release listing whose youeye-v releases each
// carry a core-release.json naming the given branch.
func coreReleaseServer(t *testing.T, releases []applianceRelease, branches map[string]string) *httptest.Server {
	t.Helper()
	documents := map[string][]byte{}
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/core-release.json") {
			tag := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/owner/YouEye/releases/download/"), "/core-release.json")
			if raw, ok := documents[tag]; ok {
				_, _ = response.Write(raw)
				return
			}
			http.NotFound(response, request)
			return
		}
		if request.URL.Query().Get("page") != "1" {
			_ = json.NewEncoder(response).Encode([]applianceRelease{})
			return
		}
		_ = json.NewEncoder(response).Encode(releases)
	}))
	source := server.URL + "/owner/YouEye"
	for index := range releases {
		tag := releases[index].TagName
		if branch, ok := branches[tag]; ok {
			documents[tag] = testCoreDocument(t, source, strings.TrimPrefix(tag, "youeye-v"), branch)
			releases[index].Assets = []applianceReleaseAsset{{Name: "core-release.json", BrowserDownloadURL: source + "/releases/download/" + tag + "/core-release.json"}}
		}
	}
	return server
}

func TestResolveApplianceReleaseChannelRules(t *testing.T) {
	published := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	releases := []applianceRelease{
		{TagName: "youeye-v0.6.0", PublishedAt: published},
		{TagName: "youeye-v0.6.1", PublishedAt: published.Add(-time.Hour)},
		{TagName: "youeye-v0.7.0-dev.2", Prerelease: true, PublishedAt: published.Add(time.Hour)},
		{TagName: "youeye-v0.7.0-dev.10", Prerelease: true, PublishedAt: published},
		{TagName: "youeye-v0.7.0-beta.1", Prerelease: true, PublishedAt: published},
		{TagName: "youeye-v9.0.0", Draft: true, PublishedAt: published},
		{TagName: "youeye-v8.0.0", PublishedAt: published},
		{TagName: "cp-v9.9.9", PublishedAt: published},
	}
	branches := map[string]string{
		"youeye-v0.6.0": "main", "youeye-v0.6.1": "main", "youeye-v0.7.0-dev.2": "dev",
		"youeye-v0.7.0-dev.10": "dev", "youeye-v0.7.0-beta.1": "beta", "youeye-v9.0.0": "main",
		"youeye-v8.0.0": "other",
	}
	server := coreReleaseServer(t, releases, branches)
	defer server.Close()
	api := server.URL + "/api/v1/repos/owner/YouEye/releases"
	for channel, want := range map[string]string{
		"stable": "youeye-v0.6.1", "development": "youeye-v0.7.0-dev.10", "dev": "youeye-v0.7.0-dev.10",
		"branch:beta": "youeye-v0.7.0-beta.1", "branch:other": "youeye-v8.0.0",
	} {
		release, err := resolveApplianceRelease(context.Background(), server.Client(), "custom", api, channel, "")
		if err != nil || release.TagName != want || release.core == nil || release.coreSHA256 != coreManifestDigest(release.coreRaw) {
			t.Fatalf("%s resolution: release=%s err=%v", channel, release.TagName, err)
		}
	}
	exact, err := resolveApplianceRelease(context.Background(), server.Client(), "custom", api, "exact", "youeye-v0.6.0")
	if err != nil || exact.TagName != "youeye-v0.6.0" {
		t.Fatalf("exact resolution: %s %v", exact.TagName, err)
	}
	for _, tag := range []string{"youeye-v9.9.9", "youeye-v9.0.0", "appliance-v0.6.0"} {
		if _, err := resolveApplianceRelease(context.Background(), server.Client(), "custom", api, "exact", tag); err == nil {
			t.Fatalf("missing, draft or legacy exact release %s was accepted", tag)
		}
	}
	if _, err := resolveApplianceRelease(context.Background(), server.Client(), "custom", api, "branch:missing", ""); err == nil {
		t.Fatal("missing branch fell back to another channel")
	}
}

func TestCompareCoreTagsOrdersPrereleases(t *testing.T) {
	ordered := []string{"youeye-v0.6.0-beta.1", "youeye-v0.6.0-dev.2", "youeye-v0.6.0-dev.10", "youeye-v0.6.0", "youeye-v0.6.1-dev.1", "youeye-v0.10.0"}
	for i := 1; i < len(ordered); i++ {
		if compareCoreTags(ordered[i-1], ordered[i]) >= 0 || compareCoreTags(ordered[i], ordered[i-1]) <= 0 {
			t.Fatalf("%s should sort before %s", ordered[i-1], ordered[i])
		}
	}
}

func TestResolveApplianceReleaseFindsNewestCandidateAfterFirstPage(t *testing.T) {
	var documents = map[string][]byte{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/core-release.json") {
			_, _ = response.Write(documents["youeye-v0.6.0-dev.3"])
			return
		}
		if request.URL.Query().Get("limit") != "50" {
			t.Errorf("limit = %q, want 50", request.URL.Query().Get("limit"))
		}
		if request.URL.Query().Get("page") == "1" {
			releases := make([]applianceRelease, applianceCompatiblePageSize)
			for index := range releases {
				releases[index] = applianceRelease{TagName: fmt.Sprintf("cp-dev-v0.0.%d", index), PublishedAt: time.Unix(int64(index+1), 0).UTC()}
			}
			_ = json.NewEncoder(response).Encode(releases)
			return
		}
		if request.URL.Query().Get("page") == "2" {
			tag := "youeye-v0.6.0-dev.3"
			_ = json.NewEncoder(response).Encode([]applianceRelease{{TagName: tag, Prerelease: true, PublishedAt: time.Now().UTC(), Assets: []applianceReleaseAsset{{Name: "core-release.json", BrowserDownloadURL: "https://" + request.Host + "/owner/YouEye/releases/download/" + tag + "/core-release.json"}}}})
			return
		}
		_ = json.NewEncoder(response).Encode([]applianceRelease{})
	}))
	defer server.Close()
	documents["youeye-v0.6.0-dev.3"] = testCoreDocument(t, server.URL+"/owner/YouEye", "0.6.0-dev.3", "dev")

	release, err := resolveApplianceRelease(context.Background(), server.Client(), "custom", server.URL+"/api/v1/repos/owner/YouEye/releases?limit=1", "development", "")
	if err != nil || release.TagName != "youeye-v0.6.0-dev.3" {
		t.Fatalf("paginated development resolution: release=%+v err=%v", release.TagName, err)
	}
}

func TestResolveApplianceReleaseUsesGitHubPagination(t *testing.T) {
	source := "https://github.com/YouEye-Platform/YouEye"
	document := testCoreDocument(t, source, "1.0.0", "main")
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var raw []byte
		if request.URL.Host == "github.com" {
			raw = document
		} else {
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
					{TagName: "youeye-v1.0.0", PublishedAt: time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC), Assets: []applianceReleaseAsset{{Name: "core-release.json", BrowserDownloadURL: source + "/releases/download/youeye-v1.0.0/core-release.json"}}},
				}
			}
			var err error
			if raw, err = json.Marshal(payload); err != nil {
				return nil, err
			}
		}
		return &http.Response{StatusCode: http.StatusOK, Status: "200 OK", Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(raw)), Request: request}, nil
	})}

	release, err := resolveApplianceRelease(context.Background(), client, "github", defaultApplianceReleasesAPI, "stable", "")
	if err != nil {
		t.Fatal(err)
	}
	if release.TagName != "youeye-v1.0.0" {
		t.Fatalf("release = %s", release.TagName)
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
		"https://downloads.example.test/YouEye-Platform/YouEye/releases/download/youeye-v1.0.0/youeye-appliance-amd64.iso",
		"https://github.com/YouEye-Platform/YouEye/attachments/uuid",
		"https://github.com/YouEye-Platform/YouEye/releases/download/youeye-v1.0.0/nested%2Fyoueye-appliance-amd64.iso",
		"https://github.com/another/YouEye/releases/download/youeye-v1.0.0/youeye-appliance-amd64.iso",
	}
	for _, raw := range tests {
		if err := validateApplianceReleaseAssetURL("github", api, "youeye-v1.0.0", applianceISOFilename, raw); err == nil {
			t.Fatalf("unsafe asset URL was accepted: %s", raw)
		}
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

func TestDownloadVerifiedApplianceReleaseRequiresCoreDocument(t *testing.T) {
	_, err := downloadVerifiedApplianceRelease(context.Background(), http.DefaultClient, applianceRelease{TagName: "youeye-v1.0.0"}, t.TempDir(), "")
	if err == nil || !strings.Contains(err.Error(), "no core release document") {
		t.Fatalf("release without core document did not fail closed: %v", err)
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
	if model.config.ReleaseProvider != "custom" || model.config.ReleasesAPI != "" || model.inputs["releases-api"].Value() != "" {
		t.Fatalf("repository source was unexpectedly prefilled: config=%+v input=%q", model.config, model.inputs["releases-api"].Value())
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

func TestReadProxmoxGuestProgressAcceptsOnlyBoundedRecords(t *testing.T) {
	progressJSON := `{"schema":"youeye.installer.progress.v1","operation":"first-deploy","state":"running","stage":"server_interface","detail":"Installing the Server interface","percent":55,"attempt":2,"updated_at":"2026-08-16T00:00:00Z"}`
	runner := fakeProxmoxRunner{outputs: map[string]string{
		"qm guest exec 166 --timeout 10 -- /bin/sh -c test -s /var/lib/youeye-state/first-deploy/progress.json && test $(stat -c %s /var/lib/youeye-state/first-deploy/progress.json) -le 4096 && cat /var/lib/youeye-state/first-deploy/progress.json": `{"exited":1,"exitcode":0,"out-data":` + fmt.Sprintf("%q", progressJSON) + `}`,
	}}
	record, ok := readProxmoxGuestProgress(166, runner)
	if !ok || record.Stage != "server_interface" || record.Percent != 55 {
		t.Fatalf("safe guest progress was rejected: ok=%v record=%+v", ok, record)
	}
	runner.outputs["qm guest exec 166 --timeout 10 -- /bin/sh -c test -s /var/lib/youeye-state/first-deploy/progress.json && test $(stat -c %s /var/lib/youeye-state/first-deploy/progress.json) -le 4096 && cat /var/lib/youeye-state/first-deploy/progress.json"] =
		`{"exited":1,"exitcode":0,"out-data":"{\"schema\":\"youeye.installer.progress.v1\",\"operation\":\"first-deploy\",\"stage\":\"unsafe stage\",\"percent\":101,\"attempt\":1}"}`
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
	progressJSON := `{"schema":"youeye.installer.progress.v1","operation":"first-deploy","state":"needs_attention","stage":"needs_attention","detail":"First deployment stopped during verifying","percent":99,"attempt":8,"updated_at":"2026-08-19T00:00:00Z"}`
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
			"description: YouEye appliance appliance-dev-v0.5.23.0.0.12; one-drive ISO install.",
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
		"qm set 166 --description YouEye appliance appliance-dev-v0.5.23.0.0.12; one-drive ISO install.",
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

func TestAnswerISOTransportsFullCacheDigestsAndPreflightsObjects(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("YOUEYE_RELEASE_CACHE", cache)
	if err := os.Mkdir(filepath.Join(cache, "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	objects := map[string]map[string]any{}
	for i, body := range []string{"original component bytes", "original document bytes"} {
		digest := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
		if err := os.WriteFile(filepath.Join(cache, "objects", digest), []byte(body), 0400); err != nil {
			t.Fatal(err)
		}
		objects[fmt.Sprintf("https://example.test/releases/download/test/object-%d", i)] = map[string]any{"sha256": digest, "bytes": len(body)}
	}
	index, _ := json.Marshal(map[string]any{"schema": "youeye.release-cache.v1", "objects": objects})
	for _, name := range []string{"index.json", "guest-index.json"} {
		if err := os.WriteFile(filepath.Join(cache, name), index, 0400); err != nil {
			t.Fatal(err)
		}
	}
	destination := filepath.Join(t.TempDir(), "answer.iso")
	answer := applianceAnswer{Schema: applianceAnswerSchema, Operation: "erase-install", EraseConfirmed: true, TransactionID: "0123456789abcdef0123456789abcdef", TargetSerial: "TARGET-TEST", Network: applianceAnswerNetwork{Mode: "dhcp"}, ReleasePolicy: defaultApplianceReleasePolicy(), Development: defaultDevelopmentAccessPolicy()}
	if err := writeApplianceAnswerISO(destination, answer); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	image, err := iso9660.OpenImage(f)
	if err != nil {
		t.Fatal(err)
	}
	root, err := image.RootDir()
	if err != nil {
		t.Fatal(err)
	}
	extracted := t.TempDir()
	var extract func(*iso9660.File, string)
	extract = func(dir *iso9660.File, target string) {
		children, err := dir.GetChildren()
		if err != nil {
			t.Fatal(err)
		}
		for _, child := range children {
			path := filepath.Join(target, child.Name())
			if child.IsDir() {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
				extract(child, path)
			} else {
				raw, err := io.ReadAll(child.Reader())
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, raw, 0400); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	extract(root, extracted)
	cfg := installConfig{ApplianceAnswerPath: filepath.Join(extracted, "appliance-answer.json")}
	if _, err := loadApplianceInstallInput(cfg); err != nil {
		t.Fatalf("actual ISO cache failed install preflight: %v", err)
	}
	// Digest identity must survive ISO serialization and missing media must fail
	// before partitioning, rather than only at first deployment.
	for _, obj := range objects {
		digest := obj["sha256"].(string)
		path := filepath.Join(extracted, "release-cache", "objects", digest[:16], digest[16:32], digest[32:48], digest[48:])
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("ISO truncated digest %s: %v", digest, err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if _, err := loadApplianceInstallInput(cfg); err == nil {
			t.Fatal("missing cache object passed destructive-install preflight")
		}
		break
	}
}

func TestProxmoxQuickPreservesExplicitRepository(t *testing.T) {
	opts, err := ParseOptions([]string{"proxmox", "--repository", "https://code.example.test/owner/YouEye", "--channel", "development"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	model := newProxmoxApplianceModel(opts)
	model.inventory = proxmoxApplianceInventory{}
	model.config = proxmoxApplianceConfigFromOptions(opts, model.inventory)
	model.initAdvancedInputs()
	model.phase = proxmoxPhaseChoice
	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	result := updated.(proxmoxApplianceModel)
	if result.config.ReleaseProvider != "custom" || result.config.ReleasesAPI != "https://code.example.test/api/v1/repos/owner/YouEye/releases" || result.config.Channel != "development" {
		t.Fatalf("explicit source reset by quick install: %+v", result.config)
	}
}

// The piped bootstrap verifies one release and pins the installer to it while
// the machine keeps following its selected track for later System updates.
func TestProxmoxTrackAcceptsOnlyACompleteReleasePin(t *testing.T) {
	t.Setenv("YOUEYE_INSTALLER_REPOSITORY", "")
	inventory := proxmoxApplianceInventory{ImageStorages: []string{"local-lvm"}, ISOStorages: []string{"local"}, Bridges: []string{"vmbr0"}, NextVMID: 166}
	digest := strings.Repeat("d", 64)
	for _, tc := range []struct {
		args  []string
		valid bool
	}{
		{[]string{"--channel", "development", "--release-tag", "youeye-v0.7.0-dev.10", "--core-manifest-sha256", digest}, true},
		{[]string{"--channel", "stable", "--release-tag", "youeye-v0.6.1", "--core-manifest-sha256", digest}, true},
		{[]string{"--channel", "branch", "--release-branch", "team/fix", "--release-tag", "youeye-v0.7.0-feature.3", "--core-manifest-sha256", digest}, true},
		{[]string{"--channel", "development", "--release-tag", "youeye-v0.7.0-dev.10"}, false},
		{[]string{"--channel", "development", "--core-manifest-sha256", digest}, false},
		{[]string{"--channel", "stable", "--release-tag", "appliance-v0.6.1", "--core-manifest-sha256", digest}, false},
	} {
		opts, err := ParseOptions(append([]string{"proxmox", "--repository", "https://code.example.test/owner/YouEye", "--yes"}, tc.args...), strings.NewReader(""), io.Discard)
		if err != nil {
			t.Fatal(err)
		}
		opts.ProxmoxEraseConfirmed = true
		config := proxmoxApplianceConfigFromOptions(opts, inventory)
		config.Freshness = "require-current"
		err = validateProxmoxApplianceConfig(config, inventory)
		if (err == nil) != tc.valid {
			t.Fatalf("%v: valid=%v err=%v", tc.args, tc.valid, err)
		}
		if tc.valid {
			policy := config.releasePolicy(strings.Repeat("b", 64))
			if policy.Mode != "track" || policy.ExactTag != "" || policy.CoreManifestSHA256 != digest {
				t.Fatalf("%v: pinned track did not record its track: %+v", tc.args, policy)
			}
		}
	}
}
