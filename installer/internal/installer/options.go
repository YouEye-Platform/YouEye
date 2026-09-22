package installer

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	InstallerVersion              = "0.5.7.0.0.0.1"
	defaultApplianceArtifactRoot  = "/run/youeye-appliance/artifacts"
	defaultApplianceManifestPath  = defaultApplianceArtifactRoot + "/appliance-manifest.json"
	defaultApplianceSignaturePath = defaultApplianceArtifactRoot + "/appliance-manifest.json.sig"
	defaultApplianceTrustKeyPath  = "/usr/share/youeye/appliance-development.pub"
	defaultApplianceProvider      = "github"
	defaultApplianceReleasesAPI   = "https://api.github.com/repos/YouEye-Platform/YouEye/releases"
)

type InstallerMode string

const (
	InstallerModeInstall InstallerMode = "install"
	InstallerModeProxmox InstallerMode = "proxmox"
	InstallerModeNetwork InstallerMode = "network"
	InstallerModeAccess  InstallerMode = "development-access"
	InstallerModeConsole InstallerMode = "console"
)

// CLIOptions covers the two supported installer surfaces: booted signed media
// and Proxmox provisioning of that exact media. The retired mutable-host and
// Debian-cloud-VM installers are intentionally absent.
type CLIOptions struct {
	Silent  bool
	Yes     bool
	Command string
	Mode    string

	ContainerID   string
	Hostname      string
	NetworkBridge string
	CPUCores      int
	RAMMB         int

	ApplianceSeedPath      string
	ApplianceAnswerPath    string
	ApplianceManifestPath  string
	ApplianceSignaturePath string
	ApplianceTrustKeyPath  string
	ApplianceTargetDisk    string
	ApplianceTargetDiskGB  int
	AppliancePlanOnly      bool

	ProxmoxOperation          string
	ProxmoxTargetStorage      string
	ProxmoxISOStorage         string
	ProxmoxTargetDiskGB       int
	ProxmoxNetworkMode        string
	ProxmoxAddress            string
	ProxmoxGateway            string
	ProxmoxDNS                string
	ProxmoxImportHostSSHKeys  bool
	ProxmoxSSHKeysPath        string
	ProxmoxEraseConfirmed     bool
	ApplianceChannel          string
	ApplianceReleaseBranch    string
	ApplianceFreshness        string
	ApplianceServiceSelection string
	ApplianceReleaseTag       string
	ApplianceISOSHA256        string
	InstallerBootstrapSHA256  string
	ApplianceReleaseProvider  string
	ApplianceReleasesAPI      string
	ConsoleKind               string
}

func ParseOptions(args []string, _ io.Reader, stderr io.Writer) (CLIOptions, error) {
	commandArg := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		commandArg, args = args[0], args[1:]
	}
	provider := envOrDefault("YOUEYE_INSTALLER_PROVIDER", defaultApplianceProvider)
	releasesAPI := strings.TrimSpace(os.Getenv("YOUEYE_INSTALLER_RELEASES_API"))
	if releasesAPI == "" && strings.EqualFold(provider, defaultApplianceProvider) {
		releasesAPI = defaultApplianceReleasesAPI
	}
	opts := CLIOptions{
		Mode:                     "auto",
		ProxmoxOperation:         "create",
		ProxmoxTargetDiskGB:      128,
		ProxmoxNetworkMode:       "dhcp",
		ProxmoxImportHostSSHKeys: true,
		ApplianceChannel:         "stable",
		ApplianceFreshness:       "require-current",
		ApplianceReleaseProvider: provider,
		ApplianceReleasesAPI:     releasesAPI,
	}

	fs := flag.NewFlagSet("youeye-installer", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.BoolVar(&opts.Silent, "silent", false, "run without the interactive interface")
	fs.BoolVar(&opts.Yes, "yes", false, "confirm a silent installation")
	fs.StringVar(&opts.Mode, "mode", opts.Mode, "compatibility selector: install or proxmox")
	fs.StringVar(&opts.ContainerID, "vmid", "", "Proxmox VM ID")
	fs.StringVar(&opts.ContainerID, "id", "", "alias for --vmid")
	fs.StringVar(&opts.Hostname, "hostname", "", "Proxmox VM name")
	fs.StringVar(&opts.NetworkBridge, "bridge", "", "Proxmox network bridge")
	fs.IntVar(&opts.CPUCores, "cpu", 0, "CPU cores")
	fs.IntVar(&opts.RAMMB, "memory", 0, "memory in MiB")

	fs.StringVar(&opts.ApplianceSeedPath, "seed", "", "Infra automation seed JSON")
	fs.StringVar(&opts.ApplianceAnswerPath, "answer", "", "non-secret installer answer JSON")
	fs.StringVar(&opts.ApplianceManifestPath, "manifest", "", "signed installer manifest JSON")
	fs.StringVar(&opts.ApplianceSignaturePath, "signature", "", "detached installer manifest signature")
	fs.StringVar(&opts.ApplianceTrustKeyPath, "trust-key", "", "trusted Ed25519 installer public key")
	fs.StringVar(&opts.ApplianceTargetDisk, "target-disk", "", "installation drive path for plan-only validation")
	fs.IntVar(&opts.ApplianceTargetDiskGB, "target-disk-size-gb", 0, "installation drive size in GiB for plan-only validation")
	fs.BoolVar(&opts.AppliancePlanOnly, "plan-only", false, "verify and print the disk plan without writing")

	fs.StringVar(&opts.ProxmoxOperation, "operation", opts.ProxmoxOperation, "Proxmox operation: create or reinstall")
	fs.StringVar(&opts.ProxmoxTargetStorage, "target-storage", "", "Proxmox storage for the installation drive")
	fs.StringVar(&opts.ProxmoxISOStorage, "iso-storage", "", "Proxmox ISO-capable storage")
	fs.IntVar(&opts.ProxmoxTargetDiskGB, "target-disk-gb", opts.ProxmoxTargetDiskGB, "installation drive size in GiB")
	fs.StringVar(&opts.ProxmoxNetworkMode, "network-mode", opts.ProxmoxNetworkMode, "guest network mode: dhcp or static")
	fs.StringVar(&opts.ProxmoxAddress, "address", "", "static guest IPv4 address in CIDR form")
	fs.StringVar(&opts.ProxmoxGateway, "gateway", "", "static guest IPv4 gateway")
	fs.StringVar(&opts.ProxmoxDNS, "dns", "", "static guest IPv4 DNS server")
	fs.BoolVar(&opts.ProxmoxImportHostSSHKeys, "import-host-ssh-keys", opts.ProxmoxImportHostSSHKeys, "import Proxmox root public keys")
	fs.StringVar(&opts.ProxmoxSSHKeysPath, "ssh-keys-file", "", "additional public SSH keys file")
	fs.BoolVar(&opts.ProxmoxEraseConfirmed, "erase-confirmed", false, "confirm destructive reinstall disk erasure")
	fs.StringVar(&opts.ApplianceChannel, "channel", opts.ApplianceChannel, "signed image track: stable, development, branch, or exact")
	fs.StringVar(&opts.ApplianceReleaseBranch, "release-branch", "", "signed branch-associated release track (never a raw branch checkout)")
	fs.StringVar(&opts.ApplianceServiceSelection, "service-selection", opts.ApplianceServiceSelection, "first-boot services: current signed selection or sealed image pins")
	fs.StringVar(&opts.ApplianceFreshness, "freshness", opts.ApplianceFreshness, "first-boot policy: require-current or prefer-current")
	fs.StringVar(&opts.ApplianceReleaseTag, "release-tag", "", "exact image release tag")
	fs.StringVar(&opts.ApplianceISOSHA256, "iso-sha256", "", "required ISO SHA-256 for exact selection")
	fs.StringVar(&opts.InstallerBootstrapSHA256, "installer-sha256", "", "signed Installer binary SHA-256 used by the bootstrap")
	fs.StringVar(&opts.ApplianceReleaseProvider, "provider", opts.ApplianceReleaseProvider, "release provider: github, forgejo, or custom")
	fs.StringVar(&opts.ApplianceReleasesAPI, "releases-api", opts.ApplianceReleasesAPI, "HTTPS image releases API (required for Forgejo or custom)")
	fs.StringVar(&opts.ConsoleKind, "console-kind", "physical", "local status console kind: physical or serial")

	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if commandArg == "" && len(fs.Args()) == 1 {
		commandArg = fs.Args()[0]
	} else if len(fs.Args()) > 0 {
		return opts, fmt.Errorf("unexpected installer arguments: %s", strings.Join(fs.Args(), " "))
	}
	if commandArg != "" {
		opts.Command = strings.ToLower(strings.TrimSpace(commandArg))
		switch opts.Command {
		case "install":
			opts.Mode = "install"
		case "proxmox":
			opts.Mode = "proxmox"
		case "network":
			opts.Mode = "network"
		case "development-access":
			opts.Mode = "development-access"
		case "console":
			opts.Mode = "console"
		default:
			return opts, fmt.Errorf("unsupported installer command %q (use install, proxmox, network, or development-access)", commandArg)
		}
	}
	opts.Mode = strings.ToLower(strings.TrimSpace(opts.Mode))
	opts.ProxmoxOperation = strings.ToLower(strings.TrimSpace(opts.ProxmoxOperation))
	opts.ProxmoxNetworkMode = strings.ToLower(strings.TrimSpace(opts.ProxmoxNetworkMode))
	opts.ApplianceChannel = strings.ToLower(strings.TrimSpace(opts.ApplianceChannel))
	opts.ApplianceReleaseBranch = strings.TrimSpace(opts.ApplianceReleaseBranch)
	opts.ApplianceFreshness = strings.ToLower(strings.TrimSpace(opts.ApplianceFreshness))
	opts.ApplianceReleaseTag = strings.TrimSpace(opts.ApplianceReleaseTag)
	opts.ApplianceISOSHA256 = strings.ToLower(strings.TrimSpace(opts.ApplianceISOSHA256))
	opts.InstallerBootstrapSHA256 = strings.ToLower(strings.TrimSpace(opts.InstallerBootstrapSHA256))
	opts.ApplianceReleaseProvider = strings.ToLower(strings.TrimSpace(opts.ApplianceReleaseProvider))
	opts.ApplianceReleasesAPI = strings.TrimSpace(opts.ApplianceReleasesAPI)
	opts.ConsoleKind = strings.ToLower(strings.TrimSpace(opts.ConsoleKind))
	if opts.ApplianceReleaseProvider == "" {
		opts.ApplianceReleaseProvider = defaultApplianceProvider
	}
	if opts.ApplianceReleasesAPI == "" && opts.ApplianceReleaseProvider == defaultApplianceProvider {
		opts.ApplianceReleasesAPI = defaultApplianceReleasesAPI
	}
	return opts, nil
}

func SelectedInstallerMode(opts CLIOptions) (InstallerMode, error) {
	switch opts.Mode {
	case "install":
		return InstallerModeInstall, nil
	case "proxmox":
		return InstallerModeProxmox, nil
	case "network":
		return InstallerModeNetwork, nil
	case "development-access":
		return InstallerModeAccess, nil
	case "console":
		if opts.ConsoleKind != "physical" && opts.ConsoleKind != "serial" {
			return "", fmt.Errorf("unsupported console kind %q", opts.ConsoleKind)
		}
		return InstallerModeConsole, nil
	case "", "auto":
		return "", fmt.Errorf("choose an installer target: youeye-installer install or youeye-installer proxmox")
	case "host", "baremetal", "linux", "vm", "proxmox-vm":
		return "", fmt.Errorf("the mutable-host installer was retired; use the signed ISO directly or the proxmox command")
	default:
		return "", fmt.Errorf("unsupported --mode %q", opts.Mode)
	}
}

func IsProxmoxMode(opts CLIOptions) bool {
	mode, err := SelectedInstallerMode(opts)
	return err == nil && mode == InstallerModeProxmox
}

func configFromOptions(opts CLIOptions) installConfig {
	cfg := newConfig()
	if opts.ApplianceSeedPath != "" {
		cfg.ApplianceSeedPath = opts.ApplianceSeedPath
	}
	if opts.ApplianceAnswerPath != "" {
		cfg.ApplianceAnswerPath = opts.ApplianceAnswerPath
	}
	if opts.ApplianceManifestPath != "" {
		cfg.ApplianceManifestPath = opts.ApplianceManifestPath
	}
	if opts.ApplianceSignaturePath != "" {
		cfg.ApplianceSignaturePath = opts.ApplianceSignaturePath
	}
	if opts.ApplianceTrustKeyPath != "" {
		cfg.ApplianceTrustKeyPath = opts.ApplianceTrustKeyPath
	}
	if opts.ApplianceTargetDisk != "" {
		cfg.ApplianceTargetDisk = opts.ApplianceTargetDisk
	}
	if opts.ApplianceTargetDiskGB > 0 {
		cfg.ApplianceTargetDiskGB = opts.ApplianceTargetDiskGB
	}
	cfg.AppliancePlanOnly = opts.AppliancePlanOnly
	return cfg
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
