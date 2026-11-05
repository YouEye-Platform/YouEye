// Command youeye-installer installs the signed YouEye appliance either from
// booted ISO media or by provisioning that same media on Proxmox VE.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/youeye-platform/YouEye/installer/internal/installer"
)

func main() {
	opts, err := installer.ParseOptions(os.Args[1:], os.Stdin, os.Stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	mode, err := installer.SelectedInstallerMode(opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if mode == installer.InstallerModeConsole {
		if opts.Silent {
			fmt.Fprintln(os.Stderr, "the local appliance console is interactive")
			os.Exit(2)
		}
		if err := installer.RunApplianceConsole(opts); err != nil {
			fmt.Fprintln(os.Stderr, "console error:", err)
			os.Exit(1)
		}
		return
	}
	if mode == installer.InstallerModeNetwork || mode == installer.InstallerModeAccess {
		if opts.Silent {
			fmt.Fprintln(os.Stderr, "local appliance configuration requires an interactive terminal")
			os.Exit(2)
		}
		var runErr error
		if mode == installer.InstallerModeNetwork {
			runErr = installer.RunLocalNetworkConfiguration()
		} else {
			runErr = installer.RunLocalDevelopmentAccess()
		}
		if runErr != nil {
			fmt.Fprintln(os.Stderr, "configuration error:", runErr)
			os.Exit(1)
		}
		return
	}

	if opts.Silent {
		if mode == installer.InstallerModeProxmox {
			if err := installer.RunProxmoxApplianceSilent(opts); err != nil {
				fmt.Fprintln(os.Stderr, "installer error:", err)
				os.Exit(1)
			}
			return
		}
		if err := installer.RunInstallerMediaSilent(opts); err != nil {
			fmt.Fprintln(os.Stderr, "installer error:", err)
			os.Exit(1)
		}
		return
	}

	// The TUI needs an interactive terminal. Bubble Tea opens /dev/tty as a
	// fallback for stdin, so we only require that /dev/tty exists (i.e. we are
	// not in a container/CI with no terminal at all).
	if _, err := os.Open("/dev/tty"); err != nil {
		fmt.Fprintln(os.Stderr, "The interactive installer requires /dev/tty.")
		fmt.Fprintln(os.Stderr, "Use --silent --yes for non-interactive installs.")
		os.Exit(1)
	}

	if mode == installer.InstallerModeProxmox {
		if err := installer.RunProxmoxAppliance(opts); err != nil {
			os.Exit(1)
		}
		return
	}
	if err := installer.RunInstallerMedia(opts); err != nil {
		os.Exit(1)
	}
}
