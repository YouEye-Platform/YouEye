package installer

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
)

const (
	DefaultCoreRepoURL     = "https://github.com/youeye-platform/YouEye"
	DefaultMarketRepoURL   = "https://github.com/youeye-platform/Market"
	DefaultReleaseChannel  = "main"
	InstallerVersion       = "0.1.0"
	defaultInstallerMode   = "auto"
	defaultInstallerBranch = "main"
)

// CLIOptions holds command-line overrides shared by the interactive TUI and
// silent installer.
type CLIOptions struct {
	Silent bool
	Yes    bool

	Mode           string
	CoreRepoURL    string
	MarketRepoURL  string
	ReleaseChannel string

	ContainerID      string
	Hostname         string
	StoragePool      string
	NetworkBridge    string
	CPUCores         int
	RAMMB            int
	DiskGB           int
	RootPasswordFile string
	RootPassword     string
	NamesBundlePath  string
	DomainBundlePath string
}

// ParseOptions parses installer flags. It intentionally uses only the stdlib
// flag package so the public bootstrap stays small and predictable.
func ParseOptions(args []string, stdin io.Reader, stderr io.Writer) (CLIOptions, error) {
	opts := CLIOptions{
		Mode:           envOrDefault("YOUEYE_INSTALL_MODE", defaultInstallerMode),
		CoreRepoURL:    envOrDefault("YOUEYE_CORE_REPO", DefaultCoreRepoURL),
		MarketRepoURL:  envOrDefault("YOUEYE_MARKET_REPO", DefaultMarketRepoURL),
		ReleaseChannel: envOrDefault("YOUEYE_RELEASE_CHANNEL", DefaultReleaseChannel),
	}

	fs := flag.NewFlagSet("youeye-installer", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.BoolVar(&opts.Silent, "silent", false, "run without the interactive TUI")
	fs.BoolVar(&opts.Yes, "yes", false, "confirm a silent installation")
	fs.StringVar(&opts.Mode, "mode", opts.Mode, "install mode: auto, proxmox-vm, or host")
	fs.StringVar(&opts.CoreRepoURL, "core-repo", opts.CoreRepoURL, "core YouEye release repository")
	fs.StringVar(&opts.MarketRepoURL, "market-repo", opts.MarketRepoURL, "Market catalog repository")
	fs.StringVar(&opts.ReleaseChannel, "release-channel", opts.ReleaseChannel, "release channel/branch")
	fs.StringVar(&opts.ReleaseChannel, "branch", opts.ReleaseChannel, "alias for --release-channel")
	fs.StringVar(&opts.ContainerID, "vmid", "", "Proxmox VM ID")
	fs.StringVar(&opts.ContainerID, "id", "", "alias for --vmid")
	fs.StringVar(&opts.Hostname, "hostname", "", "installed host/VM hostname")
	fs.StringVar(&opts.StoragePool, "storage", "", "Proxmox storage pool")
	fs.StringVar(&opts.NetworkBridge, "bridge", "", "Proxmox network bridge")
	fs.IntVar(&opts.CPUCores, "cpu", 0, "CPU cores")
	fs.IntVar(&opts.RAMMB, "memory", 0, "memory in MiB")
	fs.IntVar(&opts.DiskGB, "disk", 0, "disk size in GiB")
	fs.StringVar(&opts.RootPasswordFile, "root-password-file", "", "read VM root password from file")
	rootPasswordStdin := fs.Bool("root-password-stdin", false, "read VM root password from stdin")
	fs.StringVar(&opts.NamesBundlePath, "names-bundle", "", "YouEye Names export bundle to reuse")
	fs.StringVar(&opts.DomainBundlePath, "domain-bundle", "", "BYO domain export bundle to reuse")

	if err := fs.Parse(args); err != nil {
		return opts, err
	}

	if opts.RootPasswordFile != "" {
		data, err := os.ReadFile(opts.RootPasswordFile)
		if err != nil {
			return opts, fmt.Errorf("reading --root-password-file: %w", err)
		}
		opts.RootPassword = strings.TrimRight(string(data), "\r\n")
	}
	if *rootPasswordStdin {
		data, err := io.ReadAll(stdin)
		if err != nil {
			return opts, fmt.Errorf("reading --root-password-stdin: %w", err)
		}
		opts.RootPassword = strings.TrimRight(string(data), "\r\n")
	}

	opts.CoreRepoURL = normalizeRepoURL(opts.CoreRepoURL)
	opts.MarketRepoURL = normalizeRepoURL(opts.MarketRepoURL)
	opts.ReleaseChannel = normalizeReleaseChannel(opts.ReleaseChannel)
	if opts.Mode == "" {
		opts.Mode = defaultInstallerMode
	}

	return opts, nil
}

func envOrDefault(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func normalizeReleaseChannel(channel string) string {
	channel = strings.TrimSpace(channel)
	if channel == "" {
		return DefaultReleaseChannel
	}
	return channel
}

func normalizeRepoURL(repoURL string) string {
	repoURL = strings.TrimSpace(repoURL)
	repoURL = strings.TrimRight(repoURL, "/")
	repoURL = strings.TrimSuffix(repoURL, ".git")
	return repoURL
}

func applyOptionsToConfig(cfg *installConfig, opts CLIOptions) {
	if opts.CoreRepoURL != "" {
		cfg.CoreRepoURL = normalizeRepoURL(opts.CoreRepoURL)
	}
	if opts.MarketRepoURL != "" {
		cfg.MarketRepoURL = normalizeRepoURL(opts.MarketRepoURL)
	}
	if opts.ReleaseChannel != "" {
		cfg.ReleaseChannel = normalizeReleaseChannel(opts.ReleaseChannel)
	}
	if opts.ContainerID != "" {
		cfg.ContainerID = opts.ContainerID
	}
	if opts.Hostname != "" {
		cfg.Hostname = opts.Hostname
	}
	if opts.StoragePool != "" {
		cfg.StoragePool = opts.StoragePool
	}
	if opts.NetworkBridge != "" {
		cfg.NetworkBridge = opts.NetworkBridge
	}
	if opts.CPUCores > 0 {
		cfg.CPUCores = opts.CPUCores
	}
	if opts.RAMMB > 0 {
		cfg.RAMMB = opts.RAMMB
	}
	if opts.DiskGB > 0 {
		cfg.DiskGB = opts.DiskGB
	}
	if opts.RootPassword != "" {
		cfg.RootPassword = opts.RootPassword
	}
	if opts.NamesBundlePath != "" {
		cfg.NamesBundlePath = opts.NamesBundlePath
	}
	if opts.DomainBundlePath != "" {
		cfg.DomainBundlePath = opts.DomainBundlePath
	}
}

func configFromEnvAndOptions(env envInfo, opts CLIOptions) (installConfig, error) {
	cfg := newConfigFromEnv(env)
	applyOptionsToConfig(&cfg, opts)

	switch opts.Mode {
	case "", "auto":
		if env.IsProxmox {
			cfg.Mode = modeVM
		} else {
			cfg.Mode = modeHost
		}
	case "proxmox-vm", "vm":
		cfg.Mode = modeVM
	case "host", "baremetal", "linux":
		cfg.Mode = modeHost
	default:
		return cfg, fmt.Errorf("unsupported --mode %q (use auto, proxmox-vm, or host)", opts.Mode)
	}

	return cfg, nil
}

func validateConfigSources(cfg installConfig) error {
	if _, err := parseRepoURL(cfg.CoreRepoURL); err != nil {
		return fmt.Errorf("core repo: %w", err)
	}
	if _, err := parseRepoURL(cfg.MarketRepoURL); err != nil {
		return fmt.Errorf("market repo: %w", err)
	}
	return nil
}

type repoRef struct {
	Provider     string
	BaseURL      string
	Organization string
	Repository   string
}

func parseRepoURL(repoURL string) (repoRef, error) {
	trimmed := normalizeRepoURL(repoURL)
	if trimmed == "" {
		return repoRef{}, fmt.Errorf("repository URL is required")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return repoRef{}, fmt.Errorf("must be a valid URL")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return repoRef{}, fmt.Errorf("must start with http:// or https://")
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return repoRef{}, fmt.Errorf("must include owner and repository")
	}
	base := parsed.Scheme + "://" + parsed.Host
	provider := "gitea"
	if strings.EqualFold(parsed.Hostname(), "github.com") {
		provider = "github"
	}
	return repoRef{
		Provider:     provider,
		BaseURL:      base,
		Organization: parts[0],
		Repository:   strings.TrimSuffix(parts[1], ".git"),
	}, nil
}

func rawFileURL(repoURL, channel, filePath string) (string, error) {
	ref, err := parseRepoURL(repoURL)
	if err != nil {
		return "", err
	}
	branch := normalizeReleaseChannel(channel)
	cleanPath := path.Clean(strings.TrimPrefix(filePath, "/"))
	if ref.Provider == "github" {
		return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/%s", ref.Organization, ref.Repository, url.PathEscape(branch), cleanPath), nil
	}
	return fmt.Sprintf("%s/%s/%s/raw/branch/%s/%s", ref.BaseURL, ref.Organization, ref.Repository, url.PathEscape(branch), cleanPath), nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

type marketSourceRecord struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	RepoURL      string `json:"repo_url"`
	Enabled      bool   `json:"enabled"`
	Priority     int    `json:"priority"`
	Trust        string `json:"trust"`
	Provider     string `json:"provider"`
	BaseURL      string `json:"base_url"`
	APIPath      string `json:"api_path"`
	Organization string `json:"organization"`
	Repository   string `json:"repository"`
}

func marketSourceRecordFor(repoURL string) (marketSourceRecord, error) {
	ref, err := parseRepoURL(repoURL)
	if err != nil {
		return marketSourceRecord{}, err
	}
	apiPath := "/api/v1"
	if ref.Provider == "github" {
		apiPath = ""
	}
	return marketSourceRecord{
		ID:           "official",
		Name:         "Official YouEye Market",
		RepoURL:      fmt.Sprintf("%s/%s/%s", ref.BaseURL, ref.Organization, ref.Repository),
		Enabled:      true,
		Priority:     0,
		Trust:        "official",
		Provider:     ref.Provider,
		BaseURL:      ref.BaseURL,
		APIPath:      apiPath,
		Organization: ref.Organization,
		Repository:   ref.Repository,
	}, nil
}

func marketSourceJSON(repoURL string) ([]byte, []byte, error) {
	source, err := marketSourceRecordFor(repoURL)
	if err != nil {
		return nil, nil, err
	}
	legacy, err := json.MarshalIndent(struct {
		RepoURL string `json:"repo_url"`
	}{RepoURL: source.RepoURL}, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	multi, err := json.MarshalIndent(struct {
		ActiveSources []marketSourceRecord `json:"active_sources"`
	}{ActiveSources: []marketSourceRecord{source}}, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return append(legacy, '\n'), append(multi, '\n'), nil
}

func parsePositiveInt(raw string) int {
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || v <= 0 {
		return 0
	}
	return v
}
