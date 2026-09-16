package cmd

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/releases"
	"github.com/youeye-platform/YouEye/spine/internal/update"
	"github.com/youeye-platform/YouEye/spine/internal/version"
)

var channelCmd = &cobra.Command{
	Use:   "channel",
	Short: "Manage per-component release channels",
	Long: `Manage the release channel (repo + branch + fallback chain) each component
installs from. Components: default, spine, control, ui, and app:<id> for native apps.

The "default" channel is inherited by any component without an override. Each
override merges per-field onto the default. The fallback chain is resolved in the
same source repo; an empty chain disables fallback (holds on the selected branch).

Examples:
  youeye channel                                  Show all channels
  youeye channel set spine --branch f-updatelogic Set spine to a feature branch
  youeye channel set spine --fallback none        Disable fallback for spine
  youeye channel set ui --branch dev --fallback main,dev
  youeye channel set app:wiki --source https://forgejo.example.test/apps/Wiki --branch f-drawer
  youeye channel reset spine                       Drop spine's override
  youeye channel reset --all                       Reset everything to default`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return channelList()
	},
}

var channelListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all component channels",
	RunE: func(cmd *cobra.Command, args []string) error {
		return channelList()
	},
}

var (
	channelSetBranch   string
	channelSetSource   string
	channelSetTag      string
	channelSetSHA256   string
	channelSetFallback string
	channelResetAll    bool
)

var channelSetCmd = &cobra.Command{
	Use:   "set <component>",
	Short: "Set a component's channel (branch, source, and/or fallback)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return channelSet(cmd, args[0])
	},
}

var channelResetCmd = &cobra.Command{
	Use:   "reset [component]",
	Short: "Reset a component's channel (or --all)",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if channelResetAll {
			return channelResetAllChannels()
		}
		if len(args) != 1 {
			return fmt.Errorf("specify a component or use --all")
		}
		return channelReset(args[0])
	},
}

func init() {
	channelSetCmd.Flags().StringVar(&channelSetBranch, "branch", "", "branch to install from")
	channelSetCmd.Flags().StringVar(&channelSetSource, "source", "", "source repository URL")
	channelSetCmd.Flags().StringVar(&channelSetTag, "tag", "", "exact release tag (empty clears the pin)")
	channelSetCmd.Flags().StringVar(&channelSetSHA256, "artifact-sha256", "", "expected SHA-256 for the exact release asset")
	channelSetCmd.Flags().StringVar(&channelSetFallback, "fallback", "", `fallback chain: "main", "none" (disable), or a comma list "a,b,c"`)
	channelResetCmd.Flags().BoolVar(&channelResetAll, "all", false, "reset all components to default")

	channelCmd.AddCommand(channelListCmd)
	channelCmd.AddCommand(channelSetCmd)
	channelCmd.AddCommand(channelResetCmd)
}

// normalizeComponent validates and normalizes a component id.
func normalizeComponent(component string) (string, error) {
	switch component {
	case channels.ComponentDefault, channels.ComponentSpine, channels.ComponentControl, channels.ComponentUI:
		return component, nil
	}
	if strings.HasPrefix(component, channels.AppPrefix) {
		id := strings.TrimPrefix(component, channels.AppPrefix)
		if id == "" {
			return "", fmt.Errorf("app component needs an id, e.g. app:wiki")
		}
		return component, nil
	}
	return "", fmt.Errorf("unknown component %q (want: default, spine, control, ui, or app:<id>)", component)
}

func channelSet(cmd *cobra.Command, component string) error {
	component, err := normalizeComponent(component)
	if err != nil {
		return err
	}

	cfgCh, err := channels.Load()
	if err != nil {
		return err
	}

	// Start from the existing override so unset flags are preserved.
	current, _ := currentOverride(cfgCh, component)

	if cmd.Flags().Changed("branch") {
		b, err := channels.NormalizeBranch(channelSetBranch)
		if err != nil {
			return err
		}
		current.Branch = b
	}
	if cmd.Flags().Changed("source") {
		current.Source = strings.TrimSpace(channelSetSource)
	}
	if cmd.Flags().Changed("tag") {
		current.Tag = strings.TrimSpace(channelSetTag)
		if current.Tag == "" {
			current.ArtifactSHA256 = ""
		}
	}
	if cmd.Flags().Changed("artifact-sha256") {
		current.ArtifactSHA256 = strings.ToLower(strings.TrimSpace(channelSetSHA256))
	}
	if cmd.Flags().Changed("fallback") {
		fb, err := parseFallback(channelSetFallback)
		if err != nil {
			return err
		}
		current.Fallback = fb
	}

	if err := cfgCh.SetChannel(component, current); err != nil {
		return err
	}
	if err := cfgCh.Save(); err != nil {
		return err
	}

	fmt.Printf("Channel updated: %s\n", component)
	eff := cfgCh.Effective(component, GetConfig())
	printEffective(component, eff)
	return nil
}

// currentOverride returns the raw override for a component (for merge-preserving set).
func currentOverride(c *channels.Config, component string) (channels.Channel, bool) {
	switch component {
	case channels.ComponentDefault:
		return c.Default, true
	case channels.ComponentSpine:
		return c.Spine, true
	case channels.ComponentControl:
		return c.Control, true
	case channels.ComponentUI:
		return c.UI, true
	}
	if id := strings.TrimPrefix(component, channels.AppPrefix); id != component {
		if c.Apps != nil {
			ch, ok := c.Apps[id]
			return ch, ok
		}
	}
	return channels.Channel{}, false
}

// parseFallback interprets the --fallback flag value.
//   - "none"        → disabled (non-nil empty)
//   - "main"        → ["main"]
//   - "a,b,c"       → chain
//   - ""            → disabled (explicit empty flag)
func parseFallback(v string) ([]string, error) {
	v = strings.TrimSpace(v)
	if v == "" || strings.EqualFold(v, "none") {
		return []string{}, nil
	}
	var out []string
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		b, err := channels.NormalizeBranch(part)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	if len(out) == 0 {
		return []string{}, nil
	}
	return out, nil
}

func channelReset(component string) error {
	component, err := normalizeComponent(component)
	if err != nil {
		return err
	}
	cfgCh, err := channels.Load()
	if err != nil {
		return err
	}
	if err := cfgCh.ResetChannel(component); err != nil {
		return err
	}
	if err := cfgCh.Save(); err != nil {
		return err
	}
	fmt.Printf("Channel reset: %s\n", component)
	return nil
}

func channelResetAllChannels() error {
	cfgCh, err := channels.Load()
	if err != nil {
		return err
	}
	cfgCh.ResetAll()
	if err := cfgCh.Save(); err != nil {
		return err
	}
	fmt.Println("All channels reset to default (main).")
	return nil
}

// componentMeta maps a component id to its repo + tag prefix for live resolve.
func componentMeta(cfg *config.Config, component string) (repo, tagPrefix string, ok bool) {
	switch component {
	case channels.ComponentDefault, channels.ComponentSpine:
		return cfg.Releases.Repositories.Spine, cfg.Releases.Repositories.SpineTagPrefix, true
	case channels.ComponentControl:
		return cfg.Releases.Repositories.ControlPanel, cfg.Releases.Repositories.ControlPanelTagPrefix, true
	case channels.ComponentUI:
		return cfg.Releases.Repositories.UI, cfg.Releases.Repositories.UITagPrefix, true
	}
	// Native apps aren't resolvable by spine (CP owns them) — skip live resolve.
	return "", "", false
}

// installedVersion returns the live installed version for a core component,
// preferring provenance and falling back to a live read where available.
func installedVersion(component string) (ver, branch string) {
	if entry, ok := update.GetProvenance(component); ok {
		return entry.Version, entry.Branch
	}
	switch component {
	case channels.ComponentSpine, channels.ComponentDefault:
		return Version, ""
	case channels.ComponentControl:
		return getControlPanelVersion(), ""
	}
	return "", ""
}

func channelList() error {
	cfg := GetConfig()
	cfgCh, err := channels.Load()
	if err != nil {
		return err
	}

	// Always show the core components + default, then any configured apps.
	rows := []string{channels.ComponentDefault, channels.ComponentSpine, channels.ComponentControl, channels.ComponentUI}
	for _, id := range cfgCh.ConfiguredComponents() {
		if strings.HasPrefix(id, channels.AppPrefix) {
			rows = append(rows, id)
		}
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(w, "COMPONENT\tINSTALLED\tFOLLOWING\tFALLBACK\tCANDIDATE")
	for _, component := range rows {
		eff := cfgCh.Effective(component, cfg)

		installed := "—"
		if component != channels.ComponentDefault {
			iv, ib := installedVersion(component)
			if iv != "" && iv != "unknown" {
				installed = version.FormatVersion(iv)
				if ib != "" {
					installed += "@" + ib
				}
			}
		}

		following := hostOf(eff.Source) + " " + eff.Branch
		if eff.Tag != "" {
			following += " (" + eff.Tag + ")"
		}

		fallback := "disabled"
		if eff.Fallback == nil {
			fallback = "—"
		} else if len(eff.Fallback) > 0 {
			fallback = strings.Join(eff.Fallback, " → ")
		}

		candidate := "—"
		if repo, prefix, ok := componentMeta(cfg, component); ok {
			if cand, err := releases.ResolveComponent(cfg, component, repo, prefix); err == nil {
				candDisplay := version.FormatVersion(cand.Version)
				iv, _ := installedVersion(component)
				if component != channels.ComponentDefault && iv != "" && iv != "unknown" && version.CompareVersions(cand.Version, iv) == 0 {
					candidate = "up to date"
				} else {
					candidate = candDisplay + "@" + cand.Branch
				}
			}
		}

		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", component, installed, following, fallback, candidate)
	}
	return w.Flush()
}

func printEffective(component string, eff channels.Channel) {
	fallback := "disabled"
	if eff.Fallback == nil {
		fallback = "inherit"
	} else if len(eff.Fallback) > 0 {
		fallback = strings.Join(eff.Fallback, " → ")
	}
	fmt.Printf("  source:   %s\n", eff.Source)
	fmt.Printf("  branch:   %s\n", eff.Branch)
	if eff.Tag != "" {
		fmt.Printf("  tag:      %s\n", eff.Tag)
	}
	if eff.ArtifactSHA256 != "" {
		fmt.Printf("  sha256:   %s\n", eff.ArtifactSHA256)
	}
	fmt.Printf("  fallback: %s\n", fallback)
}

func hostOf(rawURL string) string {
	if rawURL == "" {
		return "(default)"
	}
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		return u.Host
	}
	return rawURL
}
