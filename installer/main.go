// Command youeye-installer is the YouEye platform installer.
//
// Run on a Proxmox VE host (it provisions a Debian VM and installs YouEye
// inside it) or on a bare Debian/Ubuntu host (it installs Spine + deploys
// YouEye directly). Interactive TUI by default.
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

	if opts.Silent {
		if err := installer.RunSilent(opts); err != nil {
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

	if err := installer.Run(opts); err != nil {
		os.Exit(1)
	}
}
