package installer

import (
	"fmt"
)

// RunSilent performs a non-interactive install for automation and fresh-install
// tests. It uses the same detection and providers as the TUI, but prints plain
// progress lines instead of starting Bubble Tea.
func RunSilent(opts CLIOptions) error {
	if !opts.Yes {
		return fmt.Errorf("--silent requires --yes")
	}

	env, err := detectEnvironment()
	if err != nil {
		return fmt.Errorf("detecting environment: %w", err)
	}
	if env.IsContainer {
		return fmt.Errorf("cannot install inside a container (%s)", env.ContainerType)
	}

	cfg, err := configFromEnvAndOptions(env, opts)
	if err != nil {
		return err
	}
	if cfg.Mode == modeVM && !env.IsProxmox {
		return fmt.Errorf("--mode proxmox-vm requires running on a Proxmox host")
	}
	if cfg.Mode == modeHost && env.IsProxmox {
		return fmt.Errorf("refusing direct host install on Proxmox; use --mode proxmox-vm")
	}
	if err := validateConfigSources(cfg); err != nil {
		return err
	}

	fmt.Println("YouEye silent installer")
	fmt.Printf("Mode: %s\n", cfg.Mode.String())
	if cfg.Mode != modeHost {
		fmt.Printf("Target ID: %s\n", cfg.ContainerID)
	}
	fmt.Printf("Hostname: %s\n", cfg.Hostname)
	fmt.Printf("Core repo: %s\n", cfg.CoreRepoURL)
	fmt.Printf("Market repo: %s\n", cfg.MarketRepoURL)
	fmt.Printf("Channel: %s\n", cfg.ReleaseChannel)
	if cfg.Mode == modeVM {
		if cfg.IncusZFSGB > 0 {
			fmt.Printf("Incus ZFS disk: %d GiB\n", cfg.IncusZFSGB)
		} else {
			fmt.Println("Incus ZFS disk: disabled (guest will use Spine fallback storage)")
		}
	}
	if cfg.Mode == modeVM && cfg.RootPassword == "" {
		fmt.Println("Warning: no VM root password provided; console root password will not be set")
	}
	fmt.Println()

	var lastStep string
	for msg := range startEngine(cfg) {
		if msg.Err != nil {
			return msg.Err
		}
		if msg.StepName != "" && msg.StepName != lastStep {
			lastStep = msg.StepName
			fmt.Printf("[%3.0f%%] %s\n", msg.Percent*100, msg.StepName)
		}
		if msg.LogLine != "" {
			fmt.Printf("  %s\n", msg.LogLine)
		}
		if msg.Done {
			fmt.Printf("Installation complete: %s\n", msg.ResultIP)
			return nil
		}
	}

	return fmt.Errorf("installer stopped before completion")
}
