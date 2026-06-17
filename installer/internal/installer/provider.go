package installer

// ---------------------------------------------------------------------------
// Provider registry
//
// Each installer target (a Proxmox VM, a bare Linux host, and — in future —
// libvirt/cloud/etc.) is a Provider. Adding a new installer is just:
//
//	1. implement Provider (usually in its own provider_<name>.go),
//	2. register it in init() below for the install mode it serves.
//
// The TUI/engine stay provider-agnostic — they look the provider up by mode.
// ---------------------------------------------------------------------------

// Provider performs one kind of YouEye installation, streaming progress.
type Provider interface {
	ID() string                                       // stable id, e.g. "proxmox-vm"
	DisplayName() string                              // human label
	Available(env envInfo) bool                       // can this run on the detected host?
	Provision(cfg installConfig, ch chan<- engineMsg) // do the install
}

var registry = map[installMode]Provider{}

func registerProvider(mode installMode, p Provider) { registry[mode] = p }

func providerForMode(mode installMode) (Provider, bool) {
	p, ok := registry[mode]
	return p, ok
}

// availableProviders returns every provider that can run on the detected host.
func availableProviders(env envInfo) []Provider {
	var out []Provider
	for _, p := range registry {
		if p.Available(env) {
			out = append(out, p)
		}
	}
	return out
}

// --- Providers -------------------------------------------------------------

// proxmoxVMProvider provisions a Debian VM on a Proxmox host (see
// provider_proxmox.go for the logic).
type proxmoxVMProvider struct{}

func (proxmoxVMProvider) ID() string                 { return "proxmox-vm" }
func (proxmoxVMProvider) DisplayName() string        { return "Proxmox VE — Virtual Machine" }
func (proxmoxVMProvider) Available(env envInfo) bool { return env.IsProxmox }
func (proxmoxVMProvider) Provision(cfg installConfig, ch chan<- engineMsg) {
	installVM(cfg, ch)
}

// baremetalProvider installs YouEye directly on a bare Debian/Ubuntu host
// (see installHost in engine.go).
type baremetalProvider struct{}

func (baremetalProvider) ID() string                 { return "baremetal" }
func (baremetalProvider) DisplayName() string        { return "Bare Linux Host" }
func (baremetalProvider) Available(env envInfo) bool { return !env.IsProxmox && !env.IsContainer }
func (baremetalProvider) Provision(cfg installConfig, ch chan<- engineMsg) {
	installHost(cfg, ch)
}

func init() {
	registerProvider(modeVM, proxmoxVMProvider{})
	registerProvider(modeHost, baremetalProvider{})
}
