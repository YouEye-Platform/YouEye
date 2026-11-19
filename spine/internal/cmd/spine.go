package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/spineselect"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// The spine commands always run in the seed (see spineselect.SeedOnly).

var spineRoot = spineselect.DefaultRoot

var spineCmd = &cobra.Command{
	Use:   "spine",
	Short: "Show and manage the Spine this box runs (seed in the image, selected Spine on State)",
}

func bootedSlot() (string, error) {
	raw, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return "", err
	}
	return appliance.SystemSlotFromKernelCommandLine(string(raw))
}

// seedVersion is the version of the seed baked into the running image.
func seedVersion() string {
	if _, image, err := applianceRuntime(); err == nil && image != nil && image.ReleaseSet != nil {
		return image.ReleaseSet.Spine.Version
	}
	return Version
}

func readSpineStatus() (spineselect.Report, error) {
	slot, err := bootedSlot()
	if err != nil {
		return spineselect.Report{}, err
	}
	return spineselect.Status(spineRoot, slot, seedVersion())
}

func init() {
	spineCmd.AddCommand(&cobra.Command{Use: "status", Args: cobra.NoArgs, Short: "Seed, selected Spine per slot, trial state", RunE: func(cmd *cobra.Command, _ []string) error {
		status, err := readSpineStatus()
		if err != nil {
			return err
		}
		// release names the running Spine by the installed release's version.
		// The seed and the selected Spines below are named by their line: the
		// record on State may hold build names (Shown), which a box never shows.
		view := struct {
			Release string `json:"release"`
			spineselect.Report
		}{Report: status.Shown()}
		var installed *releasecache.CoreRelease
		if r, _, err := installedRelease(); err == nil {
			installed = &r
		}
		view.Release = runningSpineVersion(installed)
		enc := json.NewEncoder(cmd.OutOrStdout())
		enc.SetIndent("", "  ")
		return enc.Encode(view)
	}})
	var digest, version string
	install := &cobra.Command{Use: "install <file>", Args: cobra.ExactArgs(1), Short: "Run a Spine binary as a trial and keep it when healthy", RunE: func(cmd *cobra.Command, args []string) error {
		slot, err := bootedSlot()
		if err != nil {
			return err
		}
		if digest == "" {
			return fmt.Errorf("--sha256 is required")
		}
		if version == "" {
			return fmt.Errorf("--version is required")
		}
		if got, err := spineselect.FileDigest(args[0]); err != nil || got != digest {
			return fmt.Errorf("%s does not match --sha256", args[0])
		}
		e, err := spineEntry(cmd.Context(), args[0], spineIdentity{SHA256: digest, Version: version})
		if err != nil {
			return err
		}
		if err := spineselect.ApplyTrial(cmd.Context(), spineRoot, slot, args[0], e, spineTrialHooks()); err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Spine %s is now current on slot %s\n", e.Version, slot)
		return nil
	}}
	install.Flags().StringVar(&digest, "sha256", "", "expected SHA-256 of the binary")
	install.Flags().StringVar(&version, "version", "", "name of this Spine in the selection record (shown, never compared)")
	spineCmd.AddCommand(install)
	spineCmd.AddCommand(&cobra.Command{Use: "rollback", Args: cobra.NoArgs, Short: "Make the previous Spine of this slot current again", RunE: func(cmd *cobra.Command, _ []string) error {
		slot, err := bootedSlot()
		if err != nil {
			return err
		}
		if err := spineselect.Rollback(spineRoot, slot, time.Now()); err != nil {
			return err
		}
		return restartSpineService(cmd.Context())
	}})
	spineCmd.AddCommand(&cobra.Command{Use: "use-seed", Args: cobra.NoArgs, Short: "Run the seed Spine of this slot's image", RunE: func(cmd *cobra.Command, _ []string) error {
		slot, err := bootedSlot()
		if err != nil {
			return err
		}
		if err := spineselect.UseSeed(spineRoot, slot, time.Now()); err != nil {
			return err
		}
		return restartSpineService(cmd.Context())
	}})
}

// spineIdentity is what a release says about its Spine. SHA256 identifies the
// binary. Version is the name the release gives it (a member's build name in
// documents up to 0.6.12, else empty); Line is the release's line, used when
// neither the release nor the binary names the Spine.
type spineIdentity struct {
	SHA256     string
	Version    string
	Line       string
	SourceTree string
	// Release is the version of the release this Spine comes from, for
	// messages ("Spine of YouEye 0.6.13"); empty for a Spine installed by hand.
	Release string
}

// releaseSpineIdentity is the identity of the Spine member of r.
func releaseSpineIdentity(r releasecache.CoreRelease, member releasecache.CoreMember) spineIdentity {
	line, _ := releasecache.LineOfVersion(r.Version)
	return spineIdentity{SHA256: member.Artifact.SHA256, Version: member.BuildVersion, Line: line, SourceTree: member.SourceTree,
		Release: strings.TrimPrefix(partVersion(r, member), "from ")}
}

// shown names the Spine in messages: by the release it comes from, else by
// its label.
func (i spineIdentity) shown() string {
	if i.Release != "" {
		return "of YouEye " + i.Release
	}
	return i.label()
}

// label names the Spine in messages before its entry exists.
func (i spineIdentity) label() string {
	for _, name := range []string{i.Version, i.Line} {
		if name != "" {
			return name
		}
	}
	return fmt.Sprintf("%.12s", i.SHA256)
}

// spineContractReport is the answer of `<binary> spine contract`. Version is
// what the binary calls itself; Spines up to 0.6.11 do not report it.
type spineContractReport struct {
	spineselect.Host
	Version string `json:"version,omitempty"`
}

// spineEntry asks a Spine binary which disk layout and helper contract it
// supports (`<binary> spine contract`), so the launcher checks what the binary
// itself declares, not what the installing Spine assumes. The entry is
// identified by the digest alone. Its Version is only a name and is never
// empty: the release's name for this Spine, else what the binary calls itself
// (a reused Spine keeps its own line), else the release's line.
func spineEntry(ctx context.Context, path string, identity spineIdentity) (spineselect.Entry, error) {
	_ = os.Chmod(path, 0o500)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "spine", "contract").Output()
	if err != nil {
		return spineselect.Entry{}, fmt.Errorf("Spine %s cannot report its contract: %w", identity.shown(), err)
	}
	var report spineContractReport
	if json.Unmarshal(out, &report) != nil || report.DiskLayout <= 0 || report.HelperContract <= 0 {
		return spineselect.Entry{}, fmt.Errorf("Spine %s reported an invalid contract", identity.shown())
	}
	e := spineselect.Entry{SHA256: identity.SHA256, Version: identity.Version, SourceTree: identity.SourceTree, DiskLayout: report.DiskLayout, HelperContract: report.HelperContract}
	if e.Version == "" && releasecache.ValidCoreVersion(report.Version) {
		e.Version = report.Version
	}
	if e.Version == "" {
		e.Version = identity.label()
	}
	if line, ok := releasecache.LineOfVersion(e.Version); ok {
		e.Line = line
	} else {
		e.Line = identity.Line
	}
	return e, nil
}

func restartSpineService(ctx context.Context) error {
	if out, err := exec.CommandContext(ctx, "systemctl", "restart", "youeye.service").CombinedOutput(); err != nil {
		return fmt.Errorf("restart youeye.service: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// spineTrialHooks restart youeye.service and check the trial: the service's
// main process runs exactly the trial binary (by SHA-256), the API socket
// answers, and Incus answers. What the binary calls itself is not compared:
// the release names its Spine by digest.
func spineTrialHooks() spineselect.TrialHooks {
	return spineselect.TrialHooks{Restart: restartSpineService, Healthy: spineServiceHealthy}
}

func spineServiceHealthy(ctx context.Context, e spineselect.Entry) error {
	out, err := exec.CommandContext(ctx, "systemctl", "show", "-p", "MainPID", "--value", "youeye.service").Output()
	if err != nil {
		return err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid <= 1 {
		return fmt.Errorf("youeye.service is not running")
	}
	digest, err := spineselect.FileDigest(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil || digest != e.SHA256 {
		return fmt.Errorf("youeye.service does not run the trial Spine (sha256 %.12s) yet", e.SHA256)
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", GetConfig().API.SocketPath)
	}}}
	resp, err := client.Get("http://youeye/api/version")
	if err != nil {
		return fmt.Errorf("Spine API does not answer: %w", err)
	}
	defer resp.Body.Close()
	var v map[string]any
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&v) != nil {
		return fmt.Errorf("Spine API of the trial Spine (sha256 %.12s) does not answer its version request", e.SHA256)
	}
	if out, err := exec.CommandContext(ctx, "incus", "query", "/1.0").CombinedOutput(); err != nil {
		return fmt.Errorf("Incus does not answer: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// verifyRunningSpine replaces every identity binding between the running Spine
// and the image's release set: the running binary must be the seed baked into
// this image, or a Spine selected for the booted slot.
var verifyRunningSpine = func(executable string) error {
	digest, err := spineselect.FileDigest(executable)
	if err != nil {
		return err
	}
	seed, err := spineselect.FileDigest(spineselect.BakedPath)
	if err != nil {
		return err
	}
	slot, err := bootedSlot()
	if err != nil {
		return err
	}
	return spineselect.Running(spineRoot, slot, digest, seed)
}

// releaseSpine returns the Spine member of the installed System release (the
// committed receipt, or the installer's accepted selection before the first
// commit).
func releaseSpine() (releasecache.CoreRelease, releasecache.CoreMember, error) {
	r := releasecache.CoreRelease{}
	if receipt, err := (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).ReadReceipt(); err == nil {
		r = receipt.Release
	} else if selected, _, err := systemupdate.ReadCoreSelection(systemupdate.CoreBootstrapPath); err == nil {
		r = selected
	} else {
		return r, releasecache.CoreMember{}, fmt.Errorf("no installed System release: %w", err)
	}
	member, ok := r.Member("spine")
	if !ok {
		return r, member, fmt.Errorf("installed System release has no Spine")
	}
	return r, member, nil
}

// downloadVerified downloads url to dest and checks size and SHA-256.
func downloadVerified(ctx context.Context, url, dest string, blob releasecache.CoreBlob) error {
	client := systemupdate.ReleaseHTTPClient()
	client.Timeout = 10 * time.Minute
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return releasecache.HTTPError(resp.StatusCode, url)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, blob.SizeBytes+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n != blob.SizeBytes || hex.EncodeToString(h.Sum(nil)) != blob.SHA256 {
		return fmt.Errorf("%s does not match its release digest", blob.Name)
	}
	return nil
}

// adoptReleaseSpine makes the installed release's Spine the booted slot's
// current Spine (as a trial that commits when healthy). It does nothing when
// that Spine already runs. First deployment calls it, so a fresh install runs
// its release's Spine even when the image carries an older seed.
func adoptReleaseSpine(ctx context.Context, out io.Writer) error {
	r, member, err := releaseSpine()
	if err != nil {
		return err
	}
	slot, err := bootedSlot()
	if err != nil {
		return err
	}
	seed, err := spineselect.FileDigest(spineselect.BakedPath)
	if err != nil {
		return err
	}
	res, err := spineselect.Resolve(spineRoot, slot, spineselect.ThisHost(), false, time.Now())
	if err != nil {
		return err
	}
	identity := releaseSpineIdentity(r, member)
	if (res.Entry != nil && res.Entry.SHA256 == member.Artifact.SHA256) || (res.Entry == nil && seed == member.Artifact.SHA256) {
		fmt.Fprintf(out, "Spine %s already runs on slot %s\n", identity.shown(), slot)
		return nil
	}
	url, err := systemupdate.CoreBlobURL(r, member.Artifact)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(spineRoot, 0o700); err != nil {
		return err
	}
	tmp := filepath.Join(spineRoot, ".download-"+member.Artifact.SHA256)
	defer os.Remove(tmp)
	if err := downloadVerified(ctx, url, tmp, member.Artifact); err != nil {
		return err
	}
	e, err := spineEntry(ctx, tmp, identity)
	if err != nil {
		return err
	}
	// An older image (for example a fresh install from older media) may not
	// fit the release's Spine yet; System convergence installs the matching
	// image first, and the next first-deployment run adopts it then.
	if err := spineselect.Compatible(e, spineselect.ThisHost()); err != nil {
		fmt.Fprintf(out, "Spine %s does not fit this image yet (%v); keeping the running Spine on slot %s\n", identity.shown(), err, slot)
		return nil
	}
	if err := spineselect.ApplyTrial(ctx, spineRoot, slot, tmp, e, spineTrialHooks()); err != nil {
		return err
	}
	fmt.Fprintf(out, "Spine %s is now current on slot %s\n", identity.shown(), slot)
	return nil
}

func init() {
	spineCmd.AddCommand(&cobra.Command{Use: "contract", Hidden: true, Args: cobra.NoArgs, Short: "Print the disk layout and helper contract this Spine supports", RunE: func(cmd *cobra.Command, _ []string) error {
		// Version is this binary's own name for itself, for the selection
		// record of the Spine that installs it. Older Spines ignore the key.
		return json.NewEncoder(cmd.OutOrStdout()).Encode(spineContractReport{Host: spineselect.ThisHost(), Version: Version})
	}})
	spineCmd.AddCommand(&cobra.Command{Use: "adopt", Args: cobra.NoArgs, Short: "Run the installed release's Spine on this slot", RunE: func(cmd *cobra.Command, _ []string) error {
		return adoptReleaseSpine(cmd.Context(), cmd.OutOrStdout())
	}})
}

// coreSpineHooks connect the System update engine to the Spine store: the
// target release's Spine comes from the verified core-update cache.
func coreSpineHooks(cache systemupdate.CoreArtifactCache) (func(context.Context, systemupdate.CoreJournal) (string, error), func(context.Context, systemupdate.CoreJournal, string) error, func(context.Context, systemupdate.CoreJournal) error) {
	target := func(j systemupdate.CoreJournal) (string, spineselect.Entry, error) {
		member, ok := j.Target.Member("spine")
		if !ok {
			return "", spineselect.Entry{}, fmt.Errorf("target release has no Spine")
		}
		path, err := cache.Path(member.Artifact)
		if err != nil {
			return "", spineselect.Entry{}, err
		}
		if digest, err := spineselect.FileDigest(path); err != nil || digest != member.Artifact.SHA256 {
			return "", spineselect.Entry{}, fmt.Errorf("cached Spine %s is missing or differs from its release digest", releaseSpineIdentity(j.Target, member).shown())
		}
		// Ask a private copy (the cache stays read-only) for its contract.
		probe := filepath.Join(spineRoot, ".contract-"+member.Artifact.SHA256)
		defer os.Remove(probe)
		if err := os.MkdirAll(spineRoot, 0o700); err != nil {
			return "", spineselect.Entry{}, err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return "", spineselect.Entry{}, err
		}
		if err := os.WriteFile(probe, raw, 0o500); err != nil {
			return "", spineselect.Entry{}, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		e, err := spineEntry(ctx, probe, releaseSpineIdentity(j.Target, member))
		return path, e, err
	}
	trial := func(ctx context.Context, j systemupdate.CoreJournal) (string, error) {
		path, e, err := target(j)
		if err != nil {
			return "", err
		}
		member, _ := j.Target.Member("spine")
		name := releaseSpineIdentity(j.Target, member).shown()
		slot, err := bootedSlot()
		if err != nil {
			return "", err
		}
		if res, err := spineselect.Resolve(spineRoot, slot, spineselect.ThisHost(), false, time.Now()); err == nil && res.Entry != nil && res.Entry.SHA256 == e.SHA256 && res.Role == "current" {
			return "Spine " + name + " already current on slot " + slot, nil
		}
		if err := spineselect.ApplyTrial(ctx, spineRoot, slot, path, e, spineTrialHooks()); err != nil {
			return "", err
		}
		return "Spine " + name + " ran healthy as a trial and is current on slot " + slot + " (no reboot)", nil
	}
	selectSlot := func(_ context.Context, j systemupdate.CoreJournal, slot string) error {
		path, e, err := target(j)
		if err != nil {
			return err
		}
		if err := spineselect.Stage(spineRoot, path, e); err != nil {
			return err
		}
		// The slot boots the target release's image, not this one, so this
		// Spine's helper contract is not the one to judge by: the target slot's
		// launcher checks the contract against its own image at boot (and runs
		// the seed if they differ). The disk layout is the disk's and is checked.
		return spineselect.Select(spineRoot, slot, e, spineselect.TargetSlotHost(e), time.Now())
	}
	restore := func(ctx context.Context, j systemupdate.CoreJournal) error {
		// By digest only: a broken target Spine cannot answer any probe.
		member, ok := j.Target.Member("spine")
		if !ok {
			return nil
		}
		e := spineselect.Entry{SHA256: member.Artifact.SHA256}
		slot, err := bootedSlot()
		if err != nil {
			return err
		}
		sel, err := spineselect.Load(spineRoot)
		if err != nil {
			return nil // nothing selected: the seed runs
		}
		if st := sel.Slots[slot]; st != nil {
			if st.Trial != nil && st.Trial.SHA256 == e.SHA256 {
				if err := spineselect.Abort(spineRoot, slot, time.Now()); err != nil {
					return err
				}
				return restartSpineService(ctx)
			}
			if st.Current != nil && st.Current.SHA256 == e.SHA256 {
				if st.Previous != nil {
					if err := spineselect.Rollback(spineRoot, slot, time.Now()); err != nil {
						return err
					}
				} else if err := spineselect.UseSeed(spineRoot, slot, time.Now()); err != nil {
					return err
				}
				return restartSpineService(ctx)
			}
		}
		return nil
	}
	return trial, selectSlot, restore
}
