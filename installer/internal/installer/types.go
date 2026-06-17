package installer

import "fmt"

// installMode describes the target environment.
type installMode int

const (
	modeLXC  installMode = iota // Proxmox LXC container
	modeVM                      // Proxmox virtual machine
	modeHost                    // Bare-metal Linux host
)

func (m installMode) String() string {
	switch m {
	case modeLXC:
		return "LXC Container"
	case modeVM:
		return "Virtual Machine"
	case modeHost:
		return "Linux Host"
	}
	return "unknown"
}

// installPath is quick (3 questions) or advanced (full wizard).
type installPath int

const (
	pathQuick    installPath = iota
	pathAdvanced
)

// ---------------------------------------------------------------------------
// Environment detection results
// ---------------------------------------------------------------------------

// storagePool represents a Proxmox storage pool.
type storagePool struct {
	Name     string
	Type     string // "lvmthin", "dir", "zfspool", "nfs", etc.
	Status   string // "active"
	TotalKiB int64
	UsedKiB  int64
	AvailKiB int64
}

// FormatFree returns a human-readable free-space string.
func (s storagePool) FormatFree() string {
	avail := s.AvailKiB
	switch {
	case avail >= 1024*1024:
		return fmt.Sprintf("%.0f GB free", float64(avail)/(1024*1024))
	case avail >= 1024:
		return fmt.Sprintf("%.0f MB free", float64(avail)/1024)
	default:
		return fmt.Sprintf("%d KB free", avail)
	}
}

// envInfo holds real detection results from the host.
type envInfo struct {
	OS         string
	Arch       string
	Kernel     string
	IsProxmox  bool
	PVEVersion string

	IsContainer   bool   // true = abort, can't install inside container
	ContainerType string // "lxc", "docker", etc.
	IsVM          bool   // true = treat as bare Linux

	// Proxmox-specific (only populated when IsProxmox == true)
	RootdirPools []storagePool // pools supporting container rootfs
	VztmplPools  []storagePool // pools supporting templates
	ImagePools   []storagePool // pools supporting VM disk images
	Bridges      []string      // network bridges (vmbr0, vmbr1, ...)
	NextID       string        // next available CTID/VMID
	Templates    []string      // already-downloaded templates (full refs like "local:vztmpl/...")

	Warnings []string // non-fatal issues found during detection
}

// AllPools returns all unique storage pools across all content types.
func (e envInfo) AllPools() []storagePool {
	seen := map[string]bool{}
	var all []storagePool
	for _, pools := range [][]storagePool{e.RootdirPools, e.VztmplPools, e.ImagePools} {
		for _, p := range pools {
			if !seen[p.Name] {
				all = append(all, p)
				seen[p.Name] = true
			}
		}
	}
	return all
}

// HasDebianTemplate returns true if a Debian 13 template is available.
func (e envInfo) HasDebianTemplate() bool {
	for _, t := range e.Templates {
		if containsStr(t, "debian-13") {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Install configuration (wizard answers)
// ---------------------------------------------------------------------------

// installConfig accumulates every answer the user provides across all
// wizard screens. Fields have sensible defaults set in newConfig().
type installConfig struct {
	Mode installMode
	Path installPath

	// Container / VM basics
	ContainerType string // "Unprivileged" or "Privileged" (LXC)
	MachineType   string // "q35" or "i440fx" (VM)
	RootPassword  string
	ContainerID   string
	Hostname      string

	// Resources
	DiskGB   int
	CPUCores int
	RAMMB    int

	// Network
	StoragePool     string
	TemplateStorage string // which pool stores vztmpl (LXC only)
	NetworkBridge   string
	IPMode          string // "DHCP" or "Static"
	StaticIP        string
	Gateway         string
	DNSSearch       string
	DNSServer       string

	// SSH
	SSHEnabled   bool
	SSHKeySource string

	// Features (LXC only)
	FeatFUSE    bool
	FeatTUN     bool
	FeatNesting bool
	FeatGPU     bool
	FeatKeyctl  bool

	// VM-only
	CPUModel   string
	DiskCache  string
	StartAfter bool

	// General
	Timezone string
	Tags     string

	// Result — set by the engine after installation completes.
	ResultIP string
}

// newConfig returns a config with sensible defaults pre-filled.
// Detection data overrides these when available.
func newConfig() installConfig {
	return installConfig{
		Mode:          modeLXC,
		ContainerType: "Privileged",
		MachineType:   "q35",
		ContainerID:   "100",
		Hostname:      "youeye",
		DiskGB:        25,
		CPUCores:      4,
		RAMMB:         5120,
		StoragePool:   "local-lvm",
		NetworkBridge: "vmbr0",
		IPMode:        "DHCP",
		DNSSearch:     "lan",
		DNSServer:     "inherit from host",
		SSHKeySource:  "None",
		CPUModel:      "KVM64",
		DiskCache:     "None",
		StartAfter:    true,
		FeatNesting:   true,
		Timezone:      "UTC",
		Tags:          "youeye",
	}
}

// newConfigFromEnv creates a config with defaults derived from real detection.
func newConfigFromEnv(env envInfo) installConfig {
	c := newConfig()

	// Default container/VM ID from detection
	if env.NextID != "" {
		c.ContainerID = env.NextID
	}

	// Default storage pool from first available rootdir pool
	if len(env.RootdirPools) > 0 {
		c.StoragePool = env.RootdirPools[0].Name
	}

	// Default template storage from first available vztmpl pool
	if len(env.VztmplPools) > 0 {
		c.TemplateStorage = env.VztmplPools[0].Name
	}

	// Default bridge from first available (prefer vmbr0)
	if len(env.Bridges) > 0 {
		c.NetworkBridge = env.Bridges[0]
		for _, b := range env.Bridges {
			if b == "vmbr0" {
				c.NetworkBridge = b
				break
			}
		}
	}

	// Default mode based on environment
	if !env.IsProxmox {
		c.Mode = modeHost
	}

	return c
}

// containsStr checks if s contains substr (case-insensitive-ish, simple check).
func containsStr(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && findSubstr(s, substr))
}

func findSubstr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
