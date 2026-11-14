package installer

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/kdomanski/iso9660"
	"github.com/youeye-platform/YouEye/releasecache"
)

func TestParseOptionsSelectsSupportedInstallerCommands(t *testing.T) {
	t.Setenv("YOUEYE_INSTALLER_REPOSITORY", "")
	opts, err := ParseOptions([]string{"proxmox", "--silent", "--yes", "--vmid", "166"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if !IsProxmoxMode(opts) || !opts.Silent || !opts.Yes || opts.ContainerID != "166" {
		t.Fatalf("unexpected Proxmox options: %+v", opts)
	}
	if opts.ApplianceRepository != releasecache.OfficialRepository || opts.ApplianceChannel != "stable" || opts.ApplianceReleaseTag != "" {
		t.Fatalf("official release defaults were not selected: %+v", opts)
	}
	opts, err = ParseOptions([]string{"install", "--silent", "--yes"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Mode != "install" {
		t.Fatalf("install command selected mode %q", opts.Mode)
	}
	for _, command := range []string{"network", "console"} {
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

func TestParseOptionsRepositoryAndChannel(t *testing.T) {
	t.Setenv("YOUEYE_INSTALLER_REPOSITORY", "")
	opts, err := ParseOptions([]string{"proxmox", "--repository", "https://Code.Example.test/owner/YouEye.git", "--channel", "DEV"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opts.ApplianceRepository != "https://code.example.test/owner/YouEye" || opts.ApplianceChannel != "dev" {
		t.Fatalf("repository or channel was not normalized: %+v", opts)
	}
	for _, channel := range []string{"dev", "alpha", "beta", "stable"} {
		if _, err := ParseOptions([]string{"proxmox", "--channel", channel}, strings.NewReader(""), io.Discard); err != nil {
			t.Fatalf("channel %s rejected: %v", channel, err)
		}
	}
	for _, args := range [][]string{
		{"proxmox", "--provider", "custom"},
		{"proxmox", "--releases-api", "https://code.example.test/releases"},
		{"proxmox", "--release-branch", "dev"},
		{"proxmox", "--freshness", "require-current"},
		{"proxmox", "--channel", "development"},
		{"proxmox", "--channel", "branch"},
		{"proxmox", "--repository", "https://user:password@code.example.test/owner/YouEye"},
		{"proxmox", "--repository", "http://code.example.test/owner/YouEye"},
		{"proxmox", "--repository", "https://code.example.test/api/v1/repos/owner/YouEye/releases"},
		{"proxmox", "--release-tag", "youeye-v0.6.1-dev.1"},
		{"proxmox", "--core-manifest-sha256", strings.Repeat("a", 64)},
	} {
		if _, err := ParseOptions(args, strings.NewReader(""), io.Discard); err == nil {
			t.Fatalf("retired flag, unknown channel or unsafe repository accepted: %v", args)
		}
	}
	t.Setenv("YOUEYE_INSTALLER_REPOSITORY", "https://forge.example.test/owner/YouEye/")
	if opts, err := ParseOptions([]string{"proxmox"}, strings.NewReader(""), io.Discard); err != nil || opts.ApplianceRepository != "https://forge.example.test/owner/YouEye" {
		t.Fatalf("environment repository: %+v %v", opts.ApplianceRepository, err)
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
		ApplianceChannel: "stable", ApplianceRepository: releasecache.OfficialRepository,
	})
	updated, _ := model.Update(proxmoxInventoryMsg{Inventory: proxmoxApplianceInventory{
		ImageStorages: []string{"local-lvm"}, ISOStorages: []string{"local"}, Bridges: []string{"vmbr0"}, NextVMID: 166,
	}})
	model = updated.(proxmoxApplianceModel)
	if model.config.ReleaseProvider != defaultApplianceProvider || model.config.RepositoryURL != releasecache.OfficialRepository || model.inputs["releases-api"].Value() != "" {
		t.Fatalf("official source defaults are not safely hidden: config=%+v input=%q", model.config, model.inputs["releases-api"].Value())
	}
	model.cycleAdvancedSelection("release-provider", true)
	if model.config.ReleaseProvider != "custom" || model.config.RepositoryURL != "" || model.inputs["releases-api"].Value() != "" {
		t.Fatalf("repository source was unexpectedly prefilled: config=%+v input=%q", model.config, model.inputs["releases-api"].Value())
	}
	model.cycleAdvancedSelection("release-provider", true)
	if model.config.ReleaseProvider != defaultApplianceProvider || model.config.RepositoryURL != releasecache.OfficialRepository {
		t.Fatalf("official source was not restored: %+v", model.config)
	}
	var channels []string
	for range 4 {
		model.cycleAdvancedSelection("channel", true)
		channels = append(channels, model.config.Channel)
	}
	if strings.Join(channels, ",") != "beta,alpha,dev,stable" {
		t.Fatalf("channel choices = %v", channels)
	}
	model.config.ReleaseTag, model.config.CoreManifestSHA256 = "youeye-v0.6.1-dev.1", strings.Repeat("a", 64)
	model.cycleAdvancedSelection("channel", true)
	if model.config.ReleaseTag != "" || model.config.CoreManifestSHA256 != "" {
		t.Fatal("changing the channel kept a pinned release of another channel")
	}
	if got := estimatedProxmoxDataGiB(32); got != 11 {
		t.Fatalf("estimated 32 GiB data capacity = %d, want 11", got)
	}
}

func TestProxmoxQuickAndAdvancedUsePagedConditionalControls(t *testing.T) {
	model := newProxmoxApplianceModel(CLIOptions{
		ProxmoxOperation: "create", ProxmoxTargetDiskGB: 128, ProxmoxNetworkMode: "dhcp",
		ProxmoxImportHostSSHKeys: false, ApplianceChannel: "stable", ApplianceRepository: releasecache.OfficialRepository,
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
	model.page = 4 // Advanced "Software" page
	repositoryVisible := func() bool {
		for _, field := range model.visibleAdvancedFields() {
			if field.InputKey == "releases-api" {
				return true
			}
		}
		return false
	}
	if repositoryVisible() {
		t.Fatalf("official source showed a repository URL field: %+v", model.visibleAdvancedFields())
	}
	model.cycleAdvancedSelection("release-provider", true)
	if !repositoryVisible() {
		t.Fatalf("custom source hid its repository URL field: %+v", model.visibleAdvancedFields())
	}
	for _, field := range model.visibleAdvancedFields() {
		if field.InputKey == "branch" || field.InputKey == "tag" || field.InputKey == "digest" || field.Kind == "freshness" {
			t.Fatalf("removed release control %+v is still offered", field)
		}
	}
	input := model.inputs["releases-api"]
	input.SetValue("https://forge.example.test/owner/YouEye.git")
	model.inputs["releases-api"] = input
	if err := model.applyAdvancedInputs(); err != nil || model.config.RepositoryURL != "https://forge.example.test/owner/YouEye" {
		t.Fatalf("custom repository was not canonicalized: %q %v", model.config.RepositoryURL, err)
	}
	if err := model.validateAdvancedPage(); err != nil {
		t.Fatalf("custom repository was not canonicalized: %q %v", model.config.RepositoryURL, err)
	}
	input.SetValue("https://forge.example.test/api/v1/repos/owner/YouEye/releases")
	model.inputs["releases-api"] = input
	if err := model.applyAdvancedInputs(); err == nil {
		t.Fatal("releases API URL accepted as a repository")
	}

	model.page = 6 // Advanced "Console access" page
	if fields := model.visibleAdvancedFields(); len(fields) != 2 || fields[0].Kind != "console-root" {
		t.Fatalf("without a root password only its switch and Continue are shown: %+v", fields)
	}
	if err := model.validateAdvancedPage(); err != nil || model.config.ConsoleAccess != defaultConsoleAccessPolicy() {
		t.Fatalf("console access must default to a locked root: %+v err=%v", model.config.ConsoleAccess, err)
	}
	model.cycleAdvancedSelection("console-root", true)
	if fields := model.visibleAdvancedFields(); len(fields) != 5 {
		t.Fatalf("root password fields are hidden after turning it on: %+v", fields)
	}
	for _, key := range []string{"root-password", "root-password-confirm"} {
		input := model.inputs[key]
		input.SetValue("a masked testing passphrase")
		model.inputs[key] = input
	}
	if rendered := model.View(); strings.Contains(rendered, "a masked testing passphrase") {
		t.Fatal("Proxmox TUI rendered a plaintext root password")
	}
	if err := model.validateAdvancedPage(); err != nil {
		t.Fatal(err)
	}
	if !validYescryptHash(model.config.ConsoleAccess.RootPasswordHash) || model.inputs["root-password"].Value() != "" || model.inputs["root-password-confirm"].Value() != "" {
		t.Fatal("root password was not hashed and plaintext controls cleared")
	}
}

func TestProxmoxPageModelRendersDeterministicallyAtSupportedConsoleSizes(t *testing.T) {
	model := newProxmoxApplianceModel(CLIOptions{
		ProxmoxOperation: "create", ProxmoxTargetDiskGB: 128, ProxmoxNetworkMode: "dhcp",
		ApplianceChannel: "stable", ApplianceRepository: releasecache.OfficialRepository,
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
	t.Setenv("YOUEYE_INSTALLER_REPOSITORY", "")
	opts, err := ParseOptions([]string{"proxmox"}, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	model := newProxmoxApplianceModel(opts)
	updated, _ := model.Update(proxmoxInventoryMsg{Inventory: proxmoxApplianceInventory{
		ImageStorages: []string{"local-lvm"}, ISOStorages: []string{"local"}, Bridges: []string{"vmbr0"}, NextVMID: 166,
	}})
	model = updated.(proxmoxApplianceModel)
	// Advanced edits made before choosing Quick do not survive into it.
	model.config.Channel, model.config.ReleaseProvider, model.config.RepositoryURL = "dev", "custom", "https://updates.example.test/owner/YouEye"
	model.config.ReleaseTag, model.config.CoreManifestSHA256 = "youeye-v0.7.0-dev.1", strings.Repeat("a", 64)
	updated, _ = model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	model = updated.(proxmoxApplianceModel)
	if model.config.Channel != "stable" || model.config.ReleaseProvider != defaultApplianceProvider || model.config.RepositoryURL != releasecache.OfficialRepository || model.config.ReleaseTag != "" || model.config.CoreManifestSHA256 != "" {
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
		ConsoleAccess:  defaultConsoleAccessPolicy(),
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
	answer := applianceAnswer{Schema: applianceAnswerSchema, Operation: "erase-install", EraseConfirmed: true, TransactionID: "0123456789abcdef0123456789abcdef", TargetSerial: "TARGET-TEST", Network: applianceAnswerNetwork{Mode: "dhcp"}, ReleasePolicy: defaultApplianceReleasePolicy(), ConsoleAccess: defaultConsoleAccessPolicy()}
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
	opts, err := ParseOptions([]string{"proxmox", "--repository", "https://code.example.test/owner/YouEye", "--channel", "dev"}, strings.NewReader(""), io.Discard)
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
	if result.config.ReleaseProvider != "custom" || result.config.RepositoryURL != "https://code.example.test/owner/YouEye" || result.config.Channel != "dev" {
		t.Fatalf("explicit source reset by quick install: %+v", result.config)
	}
}

// The piped bootstrap verifies one release and pins the installer to it while
// the machine keeps following its channel for later System updates.
func TestProxmoxChannelAcceptsOnlyACompleteReleasePin(t *testing.T) {
	t.Setenv("YOUEYE_INSTALLER_REPOSITORY", "")
	inventory := proxmoxApplianceInventory{ImageStorages: []string{"local-lvm"}, ISOStorages: []string{"local"}, Bridges: []string{"vmbr0"}, NextVMID: 166}
	digest := strings.Repeat("d", 64)
	for _, tc := range []struct {
		args  []string
		valid bool
	}{
		{[]string{"--channel", "dev", "--release-tag", "youeye-v0.7.0-dev.10", "--core-manifest-sha256", digest}, true},
		{[]string{"--channel", "stable", "--release-tag", "youeye-v0.6.1", "--core-manifest-sha256", digest}, true},
		{[]string{"--channel", "beta"}, true},
		{[]string{"--channel", "dev", "--release-tag", "youeye-v0.7.0-dev.10"}, false},
		{[]string{"--channel", "dev", "--core-manifest-sha256", digest}, false},
		{[]string{"--channel", "stable", "--release-tag", "appliance-v0.6.1", "--core-manifest-sha256", digest}, false},
		{[]string{"--channel", "stable", "--release-tag", "youeye-v0.6.1", "--core-manifest-sha256", strings.Repeat("D", 64)}, false},
		{[]string{"--channel", "branch", "--release-branch", "team/fix", "--release-tag", "youeye-v0.7.0-dev.3", "--core-manifest-sha256", digest}, false},
	} {
		opts, err := ParseOptions(append([]string{"proxmox", "--repository", "https://code.example.test/owner/YouEye", "--yes"}, tc.args...), strings.NewReader(""), io.Discard)
		if err == nil {
			opts.ProxmoxEraseConfirmed = true
			config := proxmoxApplianceConfigFromOptions(opts, inventory)
			if err = validateProxmoxApplianceConfig(config, inventory); err == nil {
				policy := config.releasePolicy()
				if policy.Repository != "https://code.example.test/owner/YouEye" || policy.Channel != opts.ApplianceChannel || policy.CoreManifestSHA256 != opts.CoreManifestSHA256 {
					t.Fatalf("%v: policy did not record repository, channel and pin: %+v", tc.args, policy)
				}
				err = validateApplianceReleasePolicy(policy)
			}
		}
		if (err == nil) != tc.valid {
			t.Fatalf("%v: valid=%v err=%v", tc.args, tc.valid, err)
		}
	}
}
