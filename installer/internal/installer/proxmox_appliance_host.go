package installer

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/youeye-platform/YouEye/releasecache"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kdomanski/iso9660"
)

const (
	proxmoxMinimumCPU          = 2
	proxmoxMinimumRAMMiB       = 4096
	proxmoxQuickCPU            = 4
	proxmoxQuickRAMMiB         = 8192
	proxmoxMinimumTargetGiB    = 32
	proxmoxQuickTargetGiB      = 128
	proxmoxLowCapacityGiB      = 64
	proxmoxInstallTimeout      = 45 * time.Minute
	proxmoxGuestStartupTimeout = 10 * time.Minute
	proxmoxSetupTimeout        = 30 * time.Minute
)

var (
	proxmoxInstallerStatusInterval = 5 * time.Second
	proxmoxReadyPollInterval       = 10 * time.Second
)

const proxmoxDurableReadinessScript = `set -eu
test -e /var/lib/youeye-state/first-deploy/complete
jq -e '(.schema == "youeye.installer.progress.v1" or .schema == "youeye.appliance.progress.v1" or .schema == "youeye.appliance.progress.v2") and .operation == "first-deploy" and .stage == "complete"' /var/lib/youeye-state/first-deploy/progress.json >/dev/null
jq -e '.status == "healthy" and .exit_code == 0' /var/lib/youeye-state/first-deploy/health.json >/dev/null
test "$(jq -r '.boot_id' /var/lib/youeye-state/boot/last-bless.json)" = "$(cat /proc/sys/kernel/random/boot_id)"
jq -e '.schema == "youeye.appliance.boot-bless.v1" and .status == "healthy"' /var/lib/youeye-state/boot/last-bless.json >/dev/null
jq -e '.status == "healthy" and .exit_code == 0' /var/lib/youeye-state/boot/last-bless-health.json >/dev/null`

type proxmoxApplianceConfig struct {
	Operation         string
	VMID              int
	Name              string
	CPUCores          int
	RAMMiB            int
	TargetStorage     string
	ISOStorage        string
	TargetDiskGiB     int
	Bridge            string
	Network           applianceAnswerNetwork
	ImportHostSSHKeys bool
	SSHKeysPath       string
	EraseConfirmed    bool
	Channel           string
	ReleaseBranch     string
	Freshness         string
	ServiceSelection  string
	ReleaseTag        string
	ISOSHA256         string
	ReleaseProvider   string
	ReleasesAPI       string
	CacheRoot         string
	Development       developmentAccessPolicy
}

type proxmoxApplianceInventory struct {
	ImageStorages []string
	ISOStorages   []string
	Bridges       []string
	NextVMID      int
}

type proxmoxApplianceProgress struct {
	Stage   string
	Detail  string
	Percent float64
	Done    bool
	URL     string
	Err     error
}

type proxmoxGuestProgress struct {
	Schema    string `json:"schema"`
	Operation string `json:"operation"`
	State     string `json:"state"`
	Stage     string `json:"stage"`
	Detail    string `json:"detail"`
	Percent   int    `json:"percent"`
	Attempt   int    `json:"attempt"`
	UpdatedAt string `json:"updated_at"`
}

type proxmoxCommandRunner interface {
	Run(name string, args ...string) (string, error)
}

type execProxmoxCommandRunner struct{}

func (execProxmoxCommandRunner) Run(name string, args ...string) (string, error) {
	return run(name, args...)
}

func discoverProxmoxApplianceInventory(runner proxmoxCommandRunner) (proxmoxApplianceInventory, error) {
	if _, err := runner.Run("qm", "help"); err != nil {
		return proxmoxApplianceInventory{}, fmt.Errorf("qm is unavailable; run this helper on a Proxmox VE host")
	}
	imagesRaw, err := runner.Run("pvesm", "status", "-content", "images")
	if err != nil {
		return proxmoxApplianceInventory{}, fmt.Errorf("discover VM image storage: %w", err)
	}
	isoRaw, err := runner.Run("pvesm", "status", "-content", "iso")
	if err != nil {
		return proxmoxApplianceInventory{}, fmt.Errorf("discover ISO storage: %w", err)
	}
	bridgesRaw, err := runner.Run("ip", "-j", "link", "show", "type", "bridge")
	if err != nil {
		return proxmoxApplianceInventory{}, fmt.Errorf("discover Proxmox bridges: %w", err)
	}
	nextRaw, err := runner.Run("pvesh", "get", "/cluster/nextid")
	if err != nil {
		return proxmoxApplianceInventory{}, fmt.Errorf("discover next Proxmox VMID: %w", err)
	}
	next, err := strconv.Atoi(strings.TrimSpace(nextRaw))
	if err != nil {
		return proxmoxApplianceInventory{}, fmt.Errorf("invalid next Proxmox VMID %q", nextRaw)
	}
	inventory := proxmoxApplianceInventory{
		ImageStorages: parseActiveProxmoxStorages(imagesRaw),
		ISOStorages:   parseActiveProxmoxStorages(isoRaw),
		Bridges:       parseProxmoxBridges(bridgesRaw),
		NextVMID:      next,
	}
	if len(inventory.ImageStorages) == 0 {
		return inventory, fmt.Errorf("no active Proxmox storage supports VM images")
	}
	if len(inventory.ISOStorages) == 0 {
		return inventory, fmt.Errorf("no active Proxmox storage supports ISO images")
	}
	if len(inventory.Bridges) == 0 {
		return inventory, fmt.Errorf("no Proxmox network bridge was found")
	}
	return inventory, nil
}

func parseActiveProxmoxStorages(output string) []string {
	var names []string
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] == "Name" || fields[2] != "active" {
			continue
		}
		names = append(names, fields[0])
	}
	return names
}

func parseProxmoxBridges(raw string) []string {
	var links []struct {
		Name string `json:"ifname"`
	}
	if err := json.Unmarshal([]byte(raw), &links); err != nil {
		return nil
	}
	var bridges []string
	for _, link := range links {
		if link.Name != "" && !strings.HasPrefix(link.Name, "fwbr") {
			bridges = append(bridges, link.Name)
		}
	}
	return bridges
}

func proxmoxApplianceConfigFromOptions(opts CLIOptions, inventory proxmoxApplianceInventory) proxmoxApplianceConfig {
	vmid := inventory.NextVMID
	if parsed, err := strconv.Atoi(strings.TrimSpace(opts.ContainerID)); err == nil && parsed > 0 {
		vmid = parsed
	}
	name := strings.TrimSpace(opts.Hostname)
	if name == "" {
		name = fmt.Sprintf("youeye-%d", vmid)
	}
	cpu := opts.CPUCores
	if cpu == 0 {
		cpu = proxmoxQuickCPU
	}
	ram := opts.RAMMB
	if ram == 0 {
		ram = proxmoxQuickRAMMiB
	}
	config := proxmoxApplianceConfig{
		Operation: opts.ProxmoxOperation, VMID: vmid, Name: name,
		CPUCores: cpu, RAMMiB: ram, TargetDiskGiB: opts.ProxmoxTargetDiskGB, Bridge: opts.NetworkBridge,
		Network:           applianceAnswerNetwork{Mode: opts.ProxmoxNetworkMode, Address: opts.ProxmoxAddress, Gateway: opts.ProxmoxGateway, DNS: opts.ProxmoxDNS},
		ImportHostSSHKeys: opts.ProxmoxImportHostSSHKeys, SSHKeysPath: opts.ProxmoxSSHKeysPath,
		EraseConfirmed: opts.ProxmoxEraseConfirmed,
		Channel:        opts.ApplianceChannel, ReleaseTag: opts.ApplianceReleaseTag,
		ReleaseBranch: opts.ApplianceReleaseBranch, Freshness: opts.ApplianceFreshness, ServiceSelection: opts.ApplianceServiceSelection,
		ISOSHA256: opts.ApplianceISOSHA256, ReleaseProvider: opts.ApplianceReleaseProvider,
		ReleasesAPI: opts.ApplianceReleasesAPI,
		CacheRoot:   "/var/cache/youeye-installer/releases",
		Development: defaultDevelopmentAccessPolicy(),
	}
	config.TargetStorage = firstSelected(opts.ProxmoxTargetStorage, inventory.ImageStorages)
	config.ISOStorage = firstSelected(opts.ProxmoxISOStorage, inventory.ISOStorages)
	config.Bridge = firstSelected(config.Bridge, inventory.Bridges)
	return config
}

func (config proxmoxApplianceConfig) releasePolicy(manifestSHA256 string) applianceReleasePolicy {
	policy := applianceReleasePolicy{
		Schema: releasePolicySchema, Provider: config.ReleaseProvider,
		ReleasesAPI: nonDefaultReleaseAPI(config.ReleaseProvider, config.ReleasesAPI),
		Mode:        "track", Track: config.Channel, Branch: config.ReleaseBranch,
		Freshness: config.Freshness, ServiceSelection: config.ServiceSelection,
	}
	if policy.Freshness == "" {
		policy.Freshness = "require-current"
	}
	if config.Channel == "exact" {
		policy.Mode, policy.Track, policy.Branch = "exact", "", ""
		policy.ExactTag, policy.ManifestSHA256 = config.ReleaseTag, manifestSHA256
	}
	return policy
}

func (config proxmoxApplianceConfig) developmentPolicy() developmentAccessPolicy {
	if config.Development.Schema == "" {
		return defaultDevelopmentAccessPolicy()
	}
	return config.Development
}

func firstSelected(selected string, values []string) string {
	selected = strings.TrimSpace(selected)
	if selected != "" {
		return selected
	}
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func nonDefaultReleaseAPI(provider, apiURL string) string {
	if strings.EqualFold(strings.TrimSpace(provider), defaultApplianceProvider) {
		return ""
	}
	return strings.TrimSpace(apiURL)
}

func releaseProviderLabel(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case defaultApplianceProvider:
		return "Official GitHub"
	case "forgejo":
		return "Forgejo"
	case "custom":
		return "Custom HTTPS"
	default:
		return "Unknown"
	}
}

func estimatedProxmoxDataGiB(targetGiB int) int {
	fixedGiB := int((applianceESPBytes + applianceRecoveryBytes + 2*applianceRootSlotBytes + applianceStateBytes) / applianceGiB)
	if targetGiB <= fixedGiB {
		return 0
	}
	return targetGiB - fixedGiB
}

func validateProxmoxApplianceConfig(config proxmoxApplianceConfig, inventory proxmoxApplianceInventory) error {
	if config.Operation != "create" && config.Operation != "reinstall" {
		return fmt.Errorf("Proxmox appliance operation must be create or reinstall")
	}
	if config.VMID < 100 || config.VMID > 999999999 {
		return fmt.Errorf("Proxmox VMID must be between 100 and 999999999")
	}
	if !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$`).MatchString(config.Name) {
		return fmt.Errorf("VM name must be 1-63 DNS-safe characters")
	}
	if config.CPUCores < proxmoxMinimumCPU {
		return fmt.Errorf("YouEye requires at least %d CPU cores", proxmoxMinimumCPU)
	}
	if config.RAMMiB < proxmoxMinimumRAMMiB {
		return fmt.Errorf("YouEye requires at least %d MiB RAM", proxmoxMinimumRAMMiB)
	}
	if config.TargetDiskGiB < proxmoxMinimumTargetGiB {
		return fmt.Errorf("YouEye requires an installation drive of at least %d GiB", proxmoxMinimumTargetGiB)
	}
	if !containsString(inventory.ImageStorages, config.TargetStorage) {
		return fmt.Errorf("installation-drive storage must support VM images")
	}
	if !containsString(inventory.ISOStorages, config.ISOStorage) {
		return fmt.Errorf("installer media storage must support ISO images")
	}
	if !containsString(inventory.Bridges, config.Bridge) {
		return fmt.Errorf("network bridge %q is unavailable", config.Bridge)
	}
	answer := applianceAnswer{
		Schema: applianceAnswerSchema, Operation: "erase-install", EraseConfirmed: true, TransactionID: "00000000000000000000000000000000", TargetSerial: "TARGET", Network: config.Network,
		ReleasePolicy: config.releasePolicy(strings.Repeat("0", 64)), Development: config.developmentPolicy(),
	}
	if err := validateApplianceAnswer(answer); err != nil {
		return err
	}
	if config.Freshness != "require-current" && config.Freshness != "prefer-current" {
		return fmt.Errorf("freshness must be require-current or prefer-current")
	}
	switch config.Channel {
	case "stable", "development", "dev":
		if config.ReleaseBranch != "" || config.ReleaseTag != "" || config.ISOSHA256 != "" {
			return fmt.Errorf("channel selection cannot include an exact tag or ISO digest")
		}
	case "branch":
		if !validApplianceReleaseBranch(config.ReleaseBranch) || config.ReleaseTag != "" || config.ISOSHA256 != "" {
			return fmt.Errorf("branch selection requires a safe signed release branch and cannot include an exact identity")
		}
	case "exact":
		if config.ReleaseBranch != "" || !validExactApplianceReleaseTag(config.ReleaseTag) || !validSHA256Hex(config.ISOSHA256) {
			return fmt.Errorf("exact selection requires an exact release tag and lowercase ISO SHA-256")
		}
	default:
		return fmt.Errorf("appliance channel must be stable, development, branch, or exact")
	}
	if _, _, err := normalizeApplianceReleaseSource(config.ReleaseProvider, config.ReleasesAPI); err != nil {
		return err
	}
	return nil
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func startProxmoxApplianceProvision(config proxmoxApplianceConfig, inventory proxmoxApplianceInventory) <-chan proxmoxApplianceProgress {
	progress := make(chan proxmoxApplianceProgress, 32)
	go func() {
		defer close(progress)
		if err := provisionProxmoxAppliance(context.Background(), config, inventory, execProxmoxCommandRunner{}, applianceHTTPClient(), progress); err != nil {
			progress <- proxmoxApplianceProgress{Stage: "Installation failed", Detail: err.Error(), Err: err, Done: true}
		}
	}()
	return progress
}

func provisionProxmoxAppliance(ctx context.Context, config proxmoxApplianceConfig, inventory proxmoxApplianceInventory, runner proxmoxCommandRunner, client *http.Client, progress chan<- proxmoxApplianceProgress) (returnErr error) {
	if err := validateProxmoxApplianceConfig(config, inventory); err != nil {
		return err
	}
	keyPreflight, err := loadProxmoxAuthorizedKeys(config)
	if err != nil {
		return err
	}
	if len(keyPreflight.Accepted) == 0 && (config.ImportHostSSHKeys || strings.TrimSpace(config.SSHKeysPath) != "") {
		return fmt.Errorf("no compatible SSH public key was found; choose no SSH-key import explicitly or provide a supported key")
	}
	emitProxmoxProgress(progress, "Check SSH keys", fmt.Sprintf("%d compatible key(s); %d restricted or invalid entry/entries will be skipped", len(keyPreflight.Accepted), keyPreflight.RejectedTotal()), 0.02)
	emitProxmoxProgress(progress, "Resolve signed appliance", "Selecting one exact release without channel fallback", 0.03)
	selection := config.Channel
	if config.Channel == "branch" {
		selection = "branch:" + config.ReleaseBranch
	}
	release, err := resolveApplianceRelease(ctx, client, config.ReleaseProvider, config.ReleasesAPI, selection, config.ReleaseTag)
	if err != nil {
		return err
	}
	emitProxmoxProgress(progress, "Verify signed appliance", "Downloading signed metadata for "+release.TagName, 0.08)
	verified, err := downloadVerifiedApplianceRelease(ctx, client, release, config.CacheRoot, config.ISOSHA256)
	if err != nil {
		return err
	}
	expectedBranch := ""
	switch config.Channel {
	case "stable":
		expectedBranch = "main"
	case "development", "dev":
		expectedBranch = "dev"
	case "branch":
		expectedBranch = config.ReleaseBranch
	}
	if expectedBranch != "" && verified.Manifest.ReleaseSet.Branch != expectedBranch {
		return fmt.Errorf("signed appliance provenance branch %q does not match requested track %q", verified.Manifest.ReleaseSet.Branch, expectedBranch)
	}
	emitProxmoxProgress(progress, "Verify signed appliance", "Manifest, checksums, and ISO verified for "+verified.Manifest.ImageVersion, 0.35)

	keyFinal, err := loadProxmoxAuthorizedKeys(config)
	if err != nil {
		return err
	}
	if !slices.Equal(keyPreflight.Accepted, keyFinal.Accepted) || keyPreflight.RejectedTotal() != keyFinal.RejectedTotal() {
		return fmt.Errorf("SSH key source changed after review; review the compatible/skipped counts and retry")
	}
	targetSerial := fmt.Sprintf("YEIDISK%d%s", config.VMID, strings.ToUpper(verified.ISOSHA[:6]))
	if config.Operation == "reinstall" {
		existing, err := inspectCompatibleProxmoxApplianceVM(config.VMID, runner)
		if err != nil {
			return err
		}
		if existing.Name != config.Name {
			return fmt.Errorf("existing VM %d is named %q, not %q", config.VMID, existing.Name, config.Name)
		}
		targetSerial = existing.TargetSerial
		config.TargetDiskGiB = existing.TargetDiskGiB
		config.TargetStorage = strings.SplitN(existing.TargetVolume, ":", 2)[0]
	}
	if !config.EraseConfirmed {
		return fmt.Errorf("disk erasure was not confirmed; no VM or disk was changed")
	}
	transactionID, err := newApplianceTransactionID()
	if err != nil {
		return err
	}
	answer := applianceAnswer{
		Schema: applianceAnswerSchema, Operation: "erase-install", EraseConfirmed: true,
		TransactionID: transactionID, TargetSerial: targetSerial,
		Network: config.Network, ReleasePolicy: config.releasePolicy(verified.ManifestSHA), Development: config.developmentPolicy(),
		AuthorizedKeys: keyFinal.Accepted,
	}
	if err := validateApplianceAnswer(answer); err != nil {
		return err
	}
	answerPath := filepath.Join(config.CacheRoot, safeReleaseCacheName(release.TagName), fmt.Sprintf("youeye-answer-%d.iso", config.VMID))
	if err := writeApplianceAnswerISO(answerPath, answer); err != nil {
		return err
	}
	defer func() {
		if err := os.Remove(answerPath); err != nil && !os.IsNotExist(err) {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove sensitive answer media cache: %w", err))
		}
	}()

	emitProxmoxProgress(progress, "Stage installer media", "Copying verified ISO and protected answer media into Proxmox storage", 0.42)
	isoVolume, isoHostPath, err := stageProxmoxISO(config.ISOStorage, verified.ISOPath, fmt.Sprintf("youeye-appliance-%s.iso", verified.ISOSHA[:12]), runner)
	if err != nil {
		return err
	}
	answerVolume, answerHostPath, err := stageProxmoxSensitiveISO(config.ISOStorage, answerPath, fmt.Sprintf("youeye-answer-%d-%s.iso", config.VMID, verified.ISOSHA[:12]), runner)
	if err != nil {
		return err
	}
	answerAttached := false
	defer func() {
		if cleanupErr := cleanupProxmoxAnswerMedia(config.VMID, answerHostPath, answerAttached, runner); cleanupErr != nil {
			returnErr = errors.Join(returnErr, cleanupErr)
		}
	}()
	if config.Operation == "create" {
		emitProxmoxProgress(progress, "Create Proxmox VM", "Creating Q35/OVMF with one appliance installation drive", 0.48)
		answerAttached = true
		if err := createProxmoxApplianceVM(config, targetSerial, isoVolume, answerVolume, release.TagName, runner); err != nil {
			return err
		}
	} else {
		emitProxmoxProgress(progress, "Prepare reinstall", "Attaching verified media to the confirmed compatible one-drive VM", 0.48)
		answerAttached = true
		if err := attachProxmoxApplianceMedia(config.VMID, isoVolume, answerVolume, release.TagName, runner); err != nil {
			return err
		}
	}
	if _, err := runner.Run("qm", "start", strconv.Itoa(config.VMID)); err != nil {
		return fmt.Errorf("start YouEye Installer VM: %w", err)
	}

	emitProxmoxProgress(progress, "Run ISO installer", "The signed ISO now owns discovery, validation, and disk writes", 0.55)
	installCtx, cancelInstall := context.WithTimeout(ctx, proxmoxInstallTimeout)
	defer cancelInstall()
	serial := make(chan applianceProgressRecord, 16)
	go streamProxmoxSerialProgress(installCtx, config.VMID, serial)
	if err := waitForProxmoxInstaller(installCtx, config.VMID, runner, serial, progress); err != nil {
		return err
	}

	emitProxmoxProgress(progress, "Boot installed appliance", "Detaching installer media and booting the verified installation drive", 0.90)
	if err := detachAndBootProxmoxAppliance(config.VMID, runner); err != nil {
		return err
	}
	answerAttached = false
	ip, err := waitForProxmoxGuestIP(ctx, config.VMID, runner, proxmoxGuestStartupTimeout)
	if err != nil {
		return err
	}
	setupURL := "https://" + net.JoinHostPort(ip, "443") + "/login"
	emitProxmoxProgress(progress, "Wait for YouEye setup", "Exact first deployment is running at "+ip, 0.94)
	if err := waitForProxmoxApplianceReady(ctx, config.VMID, setupURL, runner, progress, proxmoxSetupTimeout); err != nil {
		return err
	}
	_ = isoHostPath
	progress <- proxmoxApplianceProgress{Stage: "YouEye is ready", Detail: setupURL, Percent: 1, Done: true, URL: setupURL}
	return nil
}

func newApplianceTransactionID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("create appliance install transaction identity: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

func emitProxmoxProgress(progress chan<- proxmoxApplianceProgress, stage, detail string, percent float64) {
	progress <- proxmoxApplianceProgress{Stage: stage, Detail: detail, Percent: percent}
}

func writeApplianceAnswerISO(destination string, answer applianceAnswer) error {
	cacheRoot := releasecache.Root()
	guestIndex, e := os.ReadFile(filepath.Join(cacheRoot, "guest-index.json"))
	var cached releasecache.Index
	var hostIndex releasecache.Index
	if e == nil {
		if json.Unmarshal(guestIndex, &cached) != nil || cached.Schema != "youeye.release-cache.v1" {
			return fmt.Errorf("invalid guest release cache")
		}
		hostIndex, e = releasecache.Load(cacheRoot)
		if e != nil {
			return e
		}
		for source, object := range cached.Objects {
			if hostIndex.Objects[source] != object {
				return fmt.Errorf("guest release cache differs from verified host cache")
			}
		}
		digest := sha256.Sum256(guestIndex)
		answer.ReleaseCacheSHA256 = hex.EncodeToString(digest[:])
		answer.Schema = applianceAnswerCacheSchema
	} else if !os.IsNotExist(e) {
		return e
	}

	if err := validateApplianceAnswer(answer); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(answer, "", "  ")
	if err != nil {
		return fmt.Errorf("encode appliance answer: %w", err)
	}
	raw = append(raw, '\n')
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return fmt.Errorf("create answer media directory: %w", err)
	}
	writer, err := iso9660.NewWriter()
	if err != nil {
		return fmt.Errorf("create answer ISO writer: %w", err)
	}
	defer writer.Cleanup()
	if err := writer.AddFile(bytes.NewReader(raw), "appliance-answer.json"); err != nil {
		return fmt.Errorf("add appliance answer to ISO: %w", err)
	}
	if guestIndex != nil {
		if err := writer.AddFile(bytes.NewReader(guestIndex), "release-cache/index.json"); err != nil {
			return err
		}
		names := make([]string, 0, len(cached.Objects))
		for u := range cached.Objects {
			names = append(names, u)
		}
		sort.Strings(names)
		seen := map[string]bool{}
		for _, u := range names {
			obj := cached.Objects[u]
			if seen[obj.SHA256] {
				continue
			}
			f, _, err := releasecache.Open(cacheRoot, u)
			if err != nil {
				return err
			}
			defer f.Close()
			if err = writer.AddFile(f, "release-cache/objects/"+filepath.ToSlash(releasecache.MediaObjectPath(obj.SHA256))); err != nil {
				return err
			}
			seen[obj.SHA256] = true
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".answer-*.iso")
	if err != nil {
		return fmt.Errorf("create answer ISO: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := writer.WriteTo(tmp, "YOUEYE_ANSWER"); err != nil {
		tmp.Close()
		return fmt.Errorf("write answer ISO: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync answer ISO: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close answer ISO: %w", err)
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return fmt.Errorf("protect answer ISO: %w", err)
	}
	if err := os.Rename(tmpPath, destination); err != nil {
		return fmt.Errorf("publish answer ISO: %w", err)
	}
	return nil
}

func stageProxmoxISO(storage, source, filename string, runner proxmoxCommandRunner) (string, string, error) {
	return stageProxmoxISOWithMode(storage, source, filename, 0o644, runner)
}

func stageProxmoxSensitiveISO(storage, source, filename string, runner proxmoxCommandRunner) (string, string, error) {
	return stageProxmoxISOWithMode(storage, source, filename, 0o600, runner)
}

func stageProxmoxISOWithMode(storage, source, filename string, mode os.FileMode, runner proxmoxCommandRunner) (string, string, error) {
	volume := storage + ":iso/" + filename
	destination, err := runner.Run("pvesm", "path", volume)
	if err != nil {
		return "", "", fmt.Errorf("resolve Proxmox ISO path for %s: %w", volume, err)
	}
	destination = strings.TrimSpace(destination)
	if destination == "" || !filepath.IsAbs(destination) {
		return "", "", fmt.Errorf("Proxmox returned an invalid path for %s", volume)
	}
	if err := copyVerifiedFileWithMode(source, destination, mode); err != nil {
		return "", "", err
	}
	return volume, destination, nil
}

func copyVerifiedFileWithMode(source, destination string, mode os.FileMode) error {
	sourceSHA, err := fileSHA256(source)
	if err != nil {
		return err
	}
	if existingSHA, err := fileSHA256(destination); err == nil && existingSHA == sourceSHA {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return fmt.Errorf("create Proxmox media directory: %w", err)
	}
	in, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("open staged media source: %w", err)
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".youeye-media-*")
	if err != nil {
		return fmt.Errorf("create staged media: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return fmt.Errorf("copy staged media: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync staged media: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close staged media: %w", err)
	}
	if err := os.Chmod(tmpPath, mode); err != nil {
		return fmt.Errorf("set staged media permissions: %w", err)
	}
	if err := os.Rename(tmpPath, destination); err != nil {
		return fmt.Errorf("publish staged media: %w", err)
	}
	if got, err := fileSHA256(destination); err != nil || got != sourceSHA {
		return fmt.Errorf("staged media readback failed")
	}
	return nil
}

func cleanupProxmoxAnswerMedia(vmid int, answerHostPath string, attached bool, runner proxmoxCommandRunner) error {
	var cleanupErr error
	if attached {
		id := strconv.Itoa(vmid)
		if status, err := runner.Run("qm", "status", id); err == nil && !strings.Contains(status, "stopped") {
			if output, stopErr := runner.Run("qm", "stop", id); stopErr != nil {
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("stop VM to remove sensitive answer media: %w: %s", stopErr, clip(output, 300)))
			}
		}
		if output, err := runner.Run("qm", "set", id, "--delete", "sata0"); err != nil && !strings.Contains(strings.ToLower(output), "does not exist") {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("detach sensitive answer media: %w: %s", err, clip(output, 300)))
		}
	}
	if err := os.Remove(answerHostPath); err != nil && !os.IsNotExist(err) {
		cleanupErr = errors.Join(cleanupErr, fmt.Errorf("remove sensitive staged answer media: %w", err))
	}
	return cleanupErr
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func createProxmoxApplianceVM(config proxmoxApplianceConfig, targetSerial, isoVolume, answerVolume, releaseTag string, runner proxmoxCommandRunner) error {
	vmid := strconv.Itoa(config.VMID)
	if _, err := runner.Run("qm", "config", vmid); err == nil {
		return fmt.Errorf("VMID %d already exists; use Advanced reinstall or choose another VMID", config.VMID)
	}
	description := proxmoxApplianceDescription(releaseTag)
	commands := [][]string{
		{"create", vmid, "--name", config.Name, "--description", description, "--machine", "q35", "--bios", "ovmf", "--ostype", "l26", "--cpu", "host", "--cores", strconv.Itoa(config.CPUCores), "--memory", strconv.Itoa(config.RAMMiB), "--scsihw", "virtio-scsi-single", "--agent", "enabled=1", "--serial0", "socket", "--vga", "std", "--net0", "virtio,bridge=" + config.Bridge},
		{"set", vmid, "--efidisk0", config.TargetStorage + ":1,efitype=4m,pre-enrolled-keys=0"},
		{"set", vmid, "--scsi0", fmt.Sprintf("%s:%d,discard=on,iothread=1,ssd=1,serial=%s", config.TargetStorage, config.TargetDiskGiB, targetSerial)},
		{"set", vmid, "--ide2", isoVolume + ",media=cdrom"},
		{"set", vmid, "--sata0", answerVolume + ",media=cdrom"},
		{"set", vmid, "--boot", "order=ide2;scsi0"},
	}
	for _, command := range commands {
		if output, err := runner.Run("qm", command...); err != nil {
			return fmt.Errorf("qm %s failed: %w: %s", command[0], err, clip(output, 300))
		}
	}
	return nil
}

func proxmoxApplianceDescription(releaseTag string) string {
	return fmt.Sprintf("YouEye signed appliance %s; one-drive ISO install.", releaseTag)
}

func attachProxmoxApplianceMedia(vmid int, isoVolume, answerVolume, releaseTag string, runner proxmoxCommandRunner) error {
	id := strconv.Itoa(vmid)
	status, err := runner.Run("qm", "status", id)
	if err != nil {
		return fmt.Errorf("read reinstall VM status: %w", err)
	}
	if !strings.Contains(status, "stopped") {
		return fmt.Errorf("reinstall VM %d must be stopped before destructive media is attached", vmid)
	}
	for _, args := range [][]string{
		{"set", id, "--ide2", isoVolume + ",media=cdrom"},
		{"set", id, "--sata0", answerVolume + ",media=cdrom"},
		{"set", id, "--boot", "order=ide2;scsi0"},
		{"set", id, "--description", proxmoxApplianceDescription(releaseTag)},
	} {
		if output, err := runner.Run("qm", args...); err != nil {
			return fmt.Errorf("attach reinstall media: %w: %s", err, clip(output, 300))
		}
	}
	return nil
}

type compatibleProxmoxApplianceVM struct {
	Name            string
	RecordedRelease string
	TargetSerial    string
	TargetDiskGiB   int
	TargetVolume    string
	TargetContents  string
}

func inspectCompatibleProxmoxApplianceVM(vmid int, runner proxmoxCommandRunner) (compatibleProxmoxApplianceVM, error) {
	status, err := runner.Run("qm", "status", strconv.Itoa(vmid))
	if err != nil {
		return compatibleProxmoxApplianceVM{}, fmt.Errorf("read reinstall VM %d status: %w", vmid, err)
	}
	if !strings.Contains(status, "stopped") {
		return compatibleProxmoxApplianceVM{}, fmt.Errorf("reinstall VM %d must be stopped before its disk contents are inspected", vmid)
	}
	raw, err := runner.Run("qm", "config", strconv.Itoa(vmid))
	if err != nil {
		return compatibleProxmoxApplianceVM{}, fmt.Errorf("read reinstall VM %d: %w", vmid, err)
	}
	config := parseProxmoxVMConfig(raw)
	if config["bios"] != "ovmf" || !strings.HasPrefix(config["machine"], "q35") {
		return compatibleProxmoxApplianceVM{}, fmt.Errorf("reinstall requires an existing Q35/OVMF VM")
	}
	targetVolume, targetSerial, targetSize, err := parseProxmoxDiskIdentity(config["scsi0"])
	if err != nil || targetSize < proxmoxMinimumTargetGiB {
		return compatibleProxmoxApplianceVM{}, fmt.Errorf("reinstall requires scsi0 with a stable serial and at least %d GiB", proxmoxMinimumTargetGiB)
	}
	targetContents, err := inspectProxmoxDiskContents(targetVolume, runner)
	if err != nil {
		return compatibleProxmoxApplianceVM{}, fmt.Errorf("inspect reinstall drive: %w", err)
	}
	return compatibleProxmoxApplianceVM{
		Name: config["name"], RecordedRelease: parseProxmoxRecordedRelease(config["description"]), TargetSerial: targetSerial, TargetDiskGiB: targetSize,
		TargetVolume: targetVolume, TargetContents: targetContents,
	}, nil
}

func parseProxmoxRecordedRelease(description string) string {
	const prefix = "YouEye signed appliance "
	description = strings.TrimSpace(description)
	if !strings.HasPrefix(description, prefix) {
		return ""
	}
	release, _, _ := strings.Cut(strings.TrimPrefix(description, prefix), ";")
	return strings.TrimSpace(release)
}

func parseProxmoxVMConfig(raw string) map[string]string {
	values := make(map[string]string)
	for _, line := range strings.Split(raw, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return values
}

func parseProxmoxDiskIdentity(raw string) (string, string, int, error) {
	volume := ""
	serial := ""
	sizeGiB := 0
	parts := strings.Split(raw, ",")
	if len(parts) > 0 && strings.Contains(parts[0], ":") && !strings.Contains(parts[0], "=") {
		volume = strings.TrimSpace(parts[0])
	}
	for _, part := range parts {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "serial":
			serial = strings.TrimSpace(value)
		case "size":
			value = strings.TrimSpace(value)
			if strings.HasSuffix(value, "G") {
				sizeGiB, _ = strconv.Atoi(strings.TrimSuffix(value, "G"))
			}
		}
	}
	if volume == "" || serial == "" || sizeGiB == 0 {
		return "", "", 0, fmt.Errorf("disk volume, serial, or size is missing")
	}
	return volume, serial, sizeGiB, nil
}

func inspectProxmoxDiskContents(volume string, runner proxmoxCommandRunner) (string, error) {
	path, err := runner.Run("pvesm", "path", volume)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", volume, err)
	}
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return "", fmt.Errorf("storage returned an invalid path for %s", volume)
	}
	contents, err := runner.Run("sgdisk", "-p", path)
	if err != nil {
		return "", fmt.Errorf("read %s contents: %w", volume, err)
	}
	signatures, _ := runner.Run("blkid", "-p", path)
	return strings.TrimSpace(contents + "\n" + signatures), nil
}

func summarizeProxmoxDiskContents(contents string) string {
	labels := regexp.MustCompile(`YE-[A-Z-]+`).FindAllString(contents, -1)
	seen := make(map[string]bool)
	var unique []string
	for _, label := range labels {
		if !seen[label] {
			seen[label] = true
			unique = append(unique, label)
		}
	}
	summary := strings.Join(unique, ", ")
	if strings.Contains(strings.ToLower(contents), "gpt") {
		if summary != "" {
			summary += "; "
		}
		summary += "GPT"
	}
	if summary == "" {
		summary = "no recognized YouEye layout; existing contents will still be erased"
	}
	return summary
}

func streamProxmoxSerialProgress(ctx context.Context, vmid int, output chan<- applianceProgressRecord) {
	defer close(output)
	socket := fmt.Sprintf("/var/run/qemu-server/%d.serial0", vmid)
	var connection net.Conn
	for connection == nil {
		if ctx.Err() != nil {
			return
		}
		conn, err := net.DialTimeout("unix", socket, time.Second)
		if err == nil {
			connection = conn
			break
		}
		time.Sleep(time.Second)
	}
	defer connection.Close()
	scanner := bufio.NewScanner(connection)
	scanner.Buffer(make([]byte, 4096), 8<<20)
	for scanner.Scan() {
		if record, ok := decodeApplianceProgressLine(scanner.Bytes()); ok {
			select {
			case output <- record:
			case <-ctx.Done():
				return
			}
		}
	}
}

func decodeApplianceProgressLine(line []byte) (applianceProgressRecord, bool) {
	line = bytes.TrimSpace(line)
	for len(line) > 0 {
		start := bytes.IndexByte(line, '{')
		if start < 0 {
			break
		}
		line = line[start:]
		var record applianceProgressRecord
		if json.NewDecoder(bytes.NewReader(line)).Decode(&record) == nil &&
			(record.Schema == "youeye.installer.progress.v1" || record.Schema == "youeye.appliance.progress.v1" || record.Schema == "youeye.appliance.progress.v2") {
			return record, true
		}
		line = line[1:]
	}
	return applianceProgressRecord{}, false
}

func waitForProxmoxInstaller(ctx context.Context, vmid int, runner proxmoxCommandRunner, serial <-chan applianceProgressRecord, progress chan<- proxmoxApplianceProgress) error {
	ticker := time.NewTicker(proxmoxInstallerStatusInterval)
	defer ticker.Stop()
	complete := false
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("ISO installer did not complete within %s; VM %d and media were preserved", proxmoxInstallTimeout, vmid)
		case record, ok := <-serial:
			if !ok {
				serial = nil
				continue
			}
			recordComplete, err := handleProxmoxInstallerRecord(record, vmid, progress)
			if err != nil {
				return err
			}
			complete = complete || recordComplete
		case <-ticker.C:
			status, err := runner.Run("qm", "status", strconv.Itoa(vmid))
			if err != nil {
				return fmt.Errorf("read installer VM status: %w", err)
			}
			if strings.Contains(status, "stopped") {
				if !complete {
					grace := time.NewTimer(proxmoxInstallerStatusInterval)
					for !complete {
						select {
						case record, ok := <-serial:
							if !ok {
								grace.Stop()
								return fmt.Errorf("ISO installer powered off without a terminal success record; VM %d and media were preserved", vmid)
							}
							recordComplete, recordErr := handleProxmoxInstallerRecord(record, vmid, progress)
							if recordErr != nil {
								grace.Stop()
								return recordErr
							}
							complete = recordComplete
						case <-grace.C:
							return fmt.Errorf("ISO installer powered off without a terminal success record; VM %d and media were preserved", vmid)
						case <-ctx.Done():
							grace.Stop()
							return fmt.Errorf("ISO installer completion could not be verified: %w; VM %d and media were preserved", ctx.Err(), vmid)
						}
					}
					grace.Stop()
				}
				emitProxmoxProgress(progress, "Verify installer completion", "Installer powered off after its signed terminal success record", 0.89)
				return nil
			}
		}
	}
}

func handleProxmoxInstallerRecord(record applianceProgressRecord, vmid int, progress chan<- proxmoxApplianceProgress) (bool, error) {
	percent := 0.55 + record.Percent*0.34
	emitProxmoxProgress(progress, firstSelected(record.Stage, []string{"Run ISO installer"}), record.Detail, percent)
	if record.State == "failed" {
		return false, fmt.Errorf("ISO installer failed at %s: %s; VM %d was preserved", record.Stage, record.Detail, vmid)
	}
	return record.State == "complete", nil
}

func detachAndBootProxmoxAppliance(vmid int, runner proxmoxCommandRunner) error {
	id := strconv.Itoa(vmid)
	for _, args := range [][]string{
		{"set", id, "--delete", "ide2"},
		{"set", id, "--delete", "sata0"},
		{"set", id, "--boot", "order=scsi0"},
	} {
		if output, err := runner.Run("qm", args...); err != nil {
			return fmt.Errorf("detach installer media: %w: %s", err, clip(output, 300))
		}
	}
	if output, err := runner.Run("qm", "start", id); err != nil {
		return fmt.Errorf("start installed appliance: %w: %s", err, clip(output, 300))
	}
	return nil
}

func waitForProxmoxGuestIP(ctx context.Context, vmid int, runner proxmoxCommandRunner, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	id := strconv.Itoa(vmid)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if _, err := runner.Run("qm", "guest", "cmd", id, "ping"); err == nil {
			if raw, err := runner.Run("qm", "guest", "cmd", id, "network-get-interfaces"); err == nil {
				if ip := parseVMIP(raw); ip != "" {
					return ip, nil
				}
			}
		}
		time.Sleep(5 * time.Second)
	}
	return "", fmt.Errorf("installed appliance VM %d did not report an IPv4 address within %s", vmid, timeout)
}

func waitForYouEyeSetup(ctx context.Context, setupURL string, timeout time.Duration) error {
	transport := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, setupURL, nil)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err == nil {
			response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 400 {
				return nil
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		time.Sleep(10 * time.Second)
	}
	return fmt.Errorf("YouEye setup page did not become reachable within %s", timeout)
}

func waitForProxmoxApplianceReady(ctx context.Context, vmid int, setupURL string, runner proxmoxCommandRunner, progress chan<- proxmoxApplianceProgress, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	lastStage := ""
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		output, err := runner.Run(
			"qm", "guest", "exec", strconv.Itoa(vmid), "--timeout", "10", "--",
			"/bin/sh", "-c", proxmoxDurableReadinessScript,
		)
		if err == nil && proxmoxGuestExecSucceeded(output) {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				break
			}
			return waitForYouEyeSetup(ctx, setupURL, remaining)
		}
		if guestProgress, ok := readProxmoxGuestProgress(vmid, runner); ok {
			if guestProgress.Stage != lastStage {
				lastStage = guestProgress.Stage
				percent := 0.9 + (float64(guestProgress.Percent)/100)*0.09
				emitProxmoxProgress(progress, friendlyGuestProgressStage(guestProgress.Stage), guestProgress.Detail, percent)
			}
			if err := terminalProxmoxGuestProgressError(vmid, guestProgress); err != nil {
				return err
			}
		}
		time.Sleep(proxmoxReadyPollInterval)
	}
	return fmt.Errorf("installed appliance VM %d did not record a healthy first deployment and current-boot blessing within %s", vmid, timeout)
}

func readProxmoxGuestProgress(vmid int, runner proxmoxCommandRunner) (proxmoxGuestProgress, bool) {
	output, err := runner.Run(
		"qm", "guest", "exec", strconv.Itoa(vmid), "--timeout", "10", "--",
		"/bin/sh", "-c", "test -s /var/lib/youeye-state/first-deploy/progress.json && test $(stat -c %s /var/lib/youeye-state/first-deploy/progress.json) -le 4096 && cat /var/lib/youeye-state/first-deploy/progress.json",
	)
	if err != nil {
		return proxmoxGuestProgress{}, false
	}
	var result guestExecResult
	if err := json.Unmarshal([]byte(output), &result); err != nil || result.Exited != 1 || result.ExitCode != 0 || len(result.OutData) > 4096 {
		return proxmoxGuestProgress{}, false
	}
	var record proxmoxGuestProgress
	decoder := json.NewDecoder(strings.NewReader(result.OutData))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil || record.Schema != "youeye.appliance.progress.v2" || record.Operation != "first-deploy" ||
		record.Percent < 0 || record.Percent > 100 || record.Attempt < 1 || len(record.Stage) > 64 || len(record.Detail) > 256 ||
		!regexp.MustCompile(`^[a-z][a-z0-9_]*$`).MatchString(record.Stage) || !validProxmoxGuestProgressState(record.State) {
		return proxmoxGuestProgress{}, false
	}
	return record, true
}

func validProxmoxGuestProgressState(state string) bool {
	switch state {
	case "running", "retrying", "needs_attention", "complete":
		return true
	default:
		return false
	}
}

func terminalProxmoxGuestProgressError(vmid int, progress proxmoxGuestProgress) error {
	if progress.State != "needs_attention" && progress.Stage != "needs_attention" {
		return nil
	}
	return fmt.Errorf(
		"installed appliance VM %d needs attention after first-deployment attempt %d: %s",
		vmid,
		progress.Attempt,
		progress.Detail,
	)
}

func friendlyGuestProgressStage(stage string) string {
	labels := map[string]string{
		"network": "Check wired network", "release_convergence": "Verify signed platform bundle",
		"system_restart": "Restart into updated System", "market_seed": "Prepare Market",
		"storage": "Prepare storage", "incus": "Start Incus", "system_core": "Start System core",
		"server_interface": "Install Server interface", "database": "Prepare Database",
		"web_gateway": "Prepare Web gateway", "network_shield": "Prepare Network shield",
		"ui": "Install UI", "verifying": "Verify platform", "setup": "Open setup", "complete": "YouEye is healthy",
	}
	if label := labels[stage]; label != "" {
		return label
	}
	return "Continue first deployment"
}

func proxmoxGuestExecSucceeded(output string) bool {
	var result guestExecResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return false
	}
	return result.Exited == 1 && result.ExitCode == 0
}

// RunProxmoxApplianceSilent runs the host-side provisioner without Bubble Tea.
func RunProxmoxApplianceSilent(opts CLIOptions) error {
	if !opts.Yes {
		return fmt.Errorf("--silent requires --yes")
	}
	inventory, err := discoverProxmoxApplianceInventory(execProxmoxCommandRunner{})
	if err != nil {
		return err
	}
	config := proxmoxApplianceConfigFromOptions(opts, inventory)
	progress := make(chan proxmoxApplianceProgress, 32)
	go func() {
		defer close(progress)
		if err := provisionProxmoxAppliance(context.Background(), config, inventory, execProxmoxCommandRunner{}, applianceHTTPClient(), progress); err != nil {
			progress <- proxmoxApplianceProgress{Stage: "Installation failed", Detail: err.Error(), Err: err, Done: true}
		}
	}()
	encoder := json.NewEncoder(os.Stdout)
	for update := range progress {
		record := map[string]any{
			"schema": "youeye.proxmox.progress.v1", "stage": update.Stage,
			"detail": update.Detail, "percent": update.Percent, "done": update.Done,
		}
		if update.URL != "" {
			record["url"] = update.URL
		}
		if update.Err != nil {
			record["error"] = update.Err.Error()
		}
		if err := encoder.Encode(record); err != nil {
			return err
		}
		if update.Err != nil {
			return update.Err
		}
	}
	return nil
}
