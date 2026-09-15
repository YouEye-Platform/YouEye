package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/container"
	incusutil "github.com/youeye-platform/YouEye/spine/internal/incus"
	"github.com/youeye-platform/YouEye/spine/internal/util"
)

// Migration architecture (post-0.2.18.7 — see YE-Wiki/spine/host-ip-migration.md
// for the full story including the two earlier failed designs).
//
// Spine is the canonical owner of youeye-pihole's lifecycle at boot. The
// container is created with `boot.autostart=false`, so Incus does NOT start it
// automatically. Instead, this goroutine runs at the start of every
// `spine api serve` and:
//
//   1. Ensures pihole has boot.autostart=false (idempotent migration for
//      installs that predate this feature).
//
//   2. Refreshes pihole's port-53 proxy device listen address to the
//      current host primary IP. This is a pure metadata edit — pihole is
//      stopped at this point so Incus does not try to hot-reconcile a live
//      proxy and the call cannot hang.
//
//   3. Starts pihole. With the proxy device matching the current host IP,
//      the bind succeeds and pihole comes up cleanly.
//
//   4. Ensures the Control Panel container is running. Spine owns the
//      Spine↔CP boundary; CP owns the rest of the platform.
//
//   5. If the stored .host_ip differs from the current IP, runs the rest
//      of the migration: CP HOST_IP env, dnsmasq_lines, Caddy IP-literal
//      route. Persists the new IP to .host_ip last.
//
// EVERY exec.Command in this file uses CommandContext with an explicit
// timeout via runWithTimeout. The lesson from the 0.2.18.5 hang was that
// a goroutine blocking on a hung child process is invisible to systemd
// and will eventually take down the migration on every subsequent boot
// too. With timeouts, every step has a known upper bound and a clean
// error path.
//
// Why this design replaces the earlier ExecStartPre approach (0.2.18.6):
//   - 0.2.18.6 ran the proxy device fix as ExecStartPre of spine.service,
//     ordered After=incus.service Before=incus-startup.service. The
//     assumption was that `incus-startup.service` brings up boot.autostart
//     containers. WRONG — `incus.service` itself brings them up before
//     `waitready` returns. By the time spine.service was allowed to run,
//     pihole was already up with the stale listen address and `incus
//     config device set` against it hung (the same hang we were trying
//     to avoid).
//
//   - The fix is structural: don't let Incus autostart pihole at all.
//     Then there's no race — by the time Spine runs, pihole is guaranteed
//     stopped, and the device update is always safe.

// hostIPLog is the prefix used by every line emitted by this routine.
// Filter with `journalctl -u spine -b | grep host-ip`.
func hostIPLog(format string, args ...interface{}) {
	fmt.Printf("[host-ip-check] "+format+"\n", args...)
}

const (
	hostIPMigrationLockPath = "/var/run/youeye/host-ip-migration.lock"
	piholePasswordFile      = "/var/lib/youeye/pihole/.web_password"
	migrateMaxAttempts      = 8
	migrateRetryDelay       = 5 * time.Second

	// Incus readiness budgets. A socket-activated incusd on a freshly cloned
	// VM has been observed to need anywhere from 20s (normal cold start) to
	// 10.5 minutes (first-boot incusd SIGKILL + waitready hanging on the dead
	// socket until systemd's TimeoutStartSec=600 restarts the unit — clone
	// .77, 2026-07-03). The startup budget must cover the worst case.
	startupIncusReadyBudget     = 15 * time.Minute
	manualIncusReadyBudget      = 90 * time.Second
	steadyStateIncusReadyBudget = 10 * time.Minute

	// Steady-state self-healing guard cadence. Failures must be observed
	// twice, steadyStateConfirmDelay apart, before the guard acts — so a
	// container that is briefly down for an update or manual maintenance is
	// not fought over.
	steadyStateInterval     = 5 * time.Minute
	steadyStateConfirmDelay = 30 * time.Second
)

type hostIPMigrationOptions struct {
	Startup bool
	Force   bool
	Reason  string
	// IncusReadyBudget bounds how long the migration waits for the Incus
	// daemon to answer before giving up. Zero means manualIncusReadyBudget.
	IncusReadyBudget time.Duration
}

type hostIPMigrationResult struct {
	Stored    string
	Current   string
	Changed   bool
	Migrated  bool
	Refreshed bool
	Seeded    bool
}

// runHostIPCheck is launched as a goroutine at the start of `spine api serve`
// (cmd/api.go). It owns pihole's lifecycle at boot and runs the host-IP
// migration if the host's primary IP has changed since the last successful
// migration.
//
// This is a CONVERGENCE LOOP, not a one-shot check. On cloned/template boots
// the first attempts routinely race a cold (or crashed-and-restarting) Incus
// daemon; a single attempt that logs warnings and gives up leaves the platform
// permanently degraded (pihole down, .host_ip stale — clones .77/.78,
// 2026-07-03). Instead we retry with backoff until the boot state converges,
// then hand off to the steady-state guard for the rest of the process
// lifetime.
func runHostIPCheck(_ *config.Config) {
	// Small delay so the first lines of "spine api serve" output are not
	// interleaved with our startup banner.
	time.Sleep(500 * time.Millisecond)

	for attempt := 1; ; attempt++ {
		reason := "startup"
		if attempt > 1 {
			reason = fmt.Sprintf("startup retry %d", attempt)
		}
		_, err := runHostIPMigration(hostIPMigrationOptions{
			Startup:          true,
			Reason:           reason,
			IncusReadyBudget: startupIncusReadyBudget,
		})
		if err == nil {
			if attempt > 1 {
				hostIPLog("boot state converged after %d attempts", attempt)
			}
			break
		}
		delay := bootRetryDelay(attempt)
		hostIPLog("ERROR: %v — retrying in %s (attempt %d)", err, delay, attempt)
		time.Sleep(delay)
	}

	runSteadyStateGuard()
}

// bootRetryDelay implements the boot-convergence backoff: quick retries first
// (a healthy Incus cold start is ~20s), then a steady once-a-minute cadence
// through the incusd worst case, then a low-noise five-minute cadence forever.
// The loop never gives up — on an appliance there is nobody to try again.
func bootRetryDelay(attempt int) time.Duration {
	switch {
	case attempt <= 1:
		return 5 * time.Second
	case attempt == 2:
		return 10 * time.Second
	case attempt == 3:
		return 30 * time.Second
	case attempt <= 15:
		return time.Minute
	default:
		return 5 * time.Minute
	}
}

// runSteadyStateGuard is the long-lived self-healing loop for the pieces of
// the platform Spine owns: pihole (proxy devices + running state) and the
// Control Panel container. CP's own watchdog covers everything else and
// explicitly excludes these two. Runs in the runHostIPCheck goroutine after
// boot convergence.
func runSteadyStateGuard() {
	hostIPLog("steady-state guard active (checks every %s)", steadyStateInterval)
	for {
		time.Sleep(steadyStateInterval)
		issues := checkSteadyState()
		if len(issues) == 0 {
			continue
		}
		hostIPLog("steady-state: detected %s; confirming in %s", strings.Join(issues, "; "), steadyStateConfirmDelay)
		time.Sleep(steadyStateConfirmDelay)
		issues = checkSteadyState()
		if len(issues) == 0 {
			hostIPLog("steady-state: cleared on re-check; no action")
			continue
		}
		hostIPLog("steady-state: confirmed %s; reconciling", strings.Join(issues, "; "))
		if _, err := runHostIPMigration(hostIPMigrationOptions{
			Startup:          true,
			Reason:           "steady-state repair",
			IncusReadyBudget: steadyStateIncusReadyBudget,
		}); err != nil {
			hostIPLog("steady-state: reconcile failed: %v (next check in %s)", err, steadyStateInterval)
		}
	}
}

// checkSteadyState returns a list of human-readable divergences from the
// desired steady state, or nil when everything Spine owns looks healthy.
func checkSteadyState() []string {
	var issues []string

	current := util.GetPrimaryIP()
	if current == "" || current == "<your-ip>" {
		// Without a host IP there is no desired state to reconcile toward;
		// the network is more broken than anything this loop could repair.
		return nil
	}

	if stored, err := util.ReadStoredHostIP(); err == nil && stored != "" && stored != current {
		issues = append(issues, fmt.Sprintf("host IP changed (%s -> %s)", stored, current))
	}

	piholeRunning, err := isContainerRunning("youeye-pihole")
	if err != nil {
		// Incus itself unreachable — reconcile will wait for readiness.
		return append(issues, fmt.Sprintf("incus unreachable (%v)", err))
	}
	if !piholeRunning {
		issues = append(issues, "youeye-pihole not running")
	}

	for _, dev := range piholeProxyDevices {
		desired := fmt.Sprintf("%s:%s:53", dev.proto, current)
		if listen, err := getProxyListen(dev.name); err == nil && listen != desired {
			issues = append(issues, fmt.Sprintf("%s listen is %s (want %s)", dev.name, listen, desired))
		}
	}

	if cpRunning, err := isContainerRunning("youeye-control"); err == nil && !cpRunning {
		issues = append(issues, "youeye-control not running")
	} else if err == nil && cpRunning {
		if err := container.VerifyControlPanelPortProxy("youeye-control", 3000); err != nil {
			issues = append(issues, fmt.Sprintf("Control Panel localhost proxy drift (%v)", err))
		}

		// Unit HOST_IP env drift (read-only probe; repair happens in the
		// reconcile pass via verifyCPUnitHostIPEnv). Only checked while the
		// container is running — a stopped container is already an issue.
		for _, service := range cpHostIPServices {
			val, err := readUnitHostIP(service)
			if err != nil {
				continue
			}
			if val != current {
				issues = append(issues, fmt.Sprintf("%s.service HOST_IP is %s (want %s)", service, val, current))
			}
		}
	}

	issues = append(issues, container.CheckUIEgressBlock()...)

	return issues
}

func runHostIPMigration(opts hostIPMigrationOptions) (hostIPMigrationResult, error) {
	if opts.Reason == "" {
		opts.Reason = "manual refresh"
	}

	unlock, err := acquireHostIPMigrationLock()
	if err != nil {
		return hostIPMigrationResult{}, err
	}
	defer unlock()

	result := hostIPMigrationResult{}

	current := util.GetPrimaryIP()
	if current == "" || current == "<your-ip>" {
		return result, fmt.Errorf("could not detect primary host IP (got %q)", current)
	}
	result.Current = current

	stored, err := util.ReadStoredHostIP()
	if err != nil {
		return result, fmt.Errorf("failed to read %s: %v", util.HostIPFile, err)
	}
	result.Stored = stored
	result.Changed = stored != "" && stored != current

	if !opts.Startup && !opts.Force && stored == current {
		hostIPLog("%s: host IP unchanged (%s)", opts.Reason, current)
		return result, nil
	}

	hostIPLog("%s: current host IP is %s", opts.Reason, current)

	// ─── Step 0a — Wait for Incus to be ready ──────────────────────────
	// Every step below shells out to the incus CLI. On cloned boots the
	// daemon is socket-activated moments before we run and is NOT ready:
	// calls fail with EOF or time out client-side while still being applied
	// server-side later (the torn proxy0/proxy1 split observed on clone
	// .78). Never mutate a daemon that has not proven it can answer reads.
	incusBudget := opts.IncusReadyBudget
	if incusBudget <= 0 {
		incusBudget = manualIncusReadyBudget
	}
	if err := waitForIncusReady(incusBudget); err != nil {
		return result, fmt.Errorf("incus not ready: %v", err)
	}
	if opts.Startup {
		repairIncusStartupUnit()
	}

	// bootIssues collects best-effort failures on the unchanged-IP path.
	// Historically these were logged and swallowed, so the startup call
	// reported success while pihole stayed down forever. Returning them as
	// an error lets the boot convergence loop retry until they clear.
	var bootIssues []string

	// ─── Step 0 — Ensure pihole has autostart disabled ─────────────────
	// Idempotent migration for installs that predate the autostart=false
	// change in CP 0.2.18.5. New installs already have autostart=false set
	// at the manifest level. We do this BEFORE touching the proxy device
	// so that any subsequent unexpected stop doesn't get auto-restarted
	// into the broken state.
	if err := ensurePiholeAutostartDisabled(); err != nil {
		hostIPLog("WARNING: could not disable pihole autostart: %v (continuing — best effort)", err)
	}

	// ─── Step 1 — Update pihole proxy device to current host IP ────────
	// On startup we still refresh the proxy device even if .host_ip has not
	// changed, because it repairs older installs and any manual drift. Manual
	// refresh only reaches this path when the stored and current IP differ.
	piholeRunning, _ := isContainerRunning("youeye-pihole")
	refreshPiholeProxy := true
	if opts.Startup && !opts.Force && !result.Changed && piholeRunning && piholeProxyDevicesMatch(current) {
		refreshPiholeProxy = false
		hostIPLog("pihole already running, host IP unchanged, proxy devices verified; leaving as-is")
	}

	if refreshPiholeProxy && piholeRunning {
		if err := stopContainer("youeye-pihole", 45*time.Second); err != nil {
			if result.Changed {
				return result, fmt.Errorf("failed to stop pihole before proxy device update: %v", err)
			}
			hostIPLog("WARNING: failed to stop pihole before proxy device update: %v", err)
		}
	}
	if refreshPiholeProxy {
		if err := migratePiholeProxyDevice(current); err != nil {
			if result.Changed {
				_ = ensureContainerRunning("youeye-pihole", 30*time.Second)
				return result, fmt.Errorf("pihole proxy device update failed: %v", err)
			}
			hostIPLog("WARNING: pihole proxy device update failed: %v", err)
			bootIssues = append(bootIssues, fmt.Sprintf("pihole proxy device update failed: %v", err))
			// Continue — pihole may still come up if the existing listen
			// happens to be the same as `current`.
		} else {
			hostIPLog("✓ pihole proxy device → %s", current)
		}
	}

	// ─── Step 2 — Start pihole (if not already running) ────────────────
	if err := ensureContainerRunning("youeye-pihole", 60*time.Second); err != nil {
		hostIPLog("ERROR: pihole did not come up: %v (DNS will be degraded; platform still reachable via FQDN through Caddy catch-all + LAN resolver)", err)
		if result.Changed {
			return result, fmt.Errorf("pihole did not come up: %v", err)
		}
		bootIssues = append(bootIssues, fmt.Sprintf("pihole did not come up: %v", err))
		// Don't return — the rest of the migration (CP env, dnsmasq via
		// CP, etc.) doesn't strictly need pihole running. The CP-side
		// step will fail and log a warning, that's OK.
	} else {
		hostIPLog("✓ youeye-pihole running")
	}

	// ─── Step 2b — Ensure Control Panel is running ─────────────────────
	// Spine owns the Spine↔Control Panel boundary. CP owns the rest of the
	// platform, so CP must be alive even when the host IP is unchanged and no
	// network migration is needed. Without this, a cloned/template VM whose CP
	// container is stopped can boot with only Incus-autostart containers running.
	if err := ensureControlPanelBootRunning(60 * time.Second); err != nil {
		if result.Changed || opts.Force {
			return result, fmt.Errorf("control panel boot guarantee failed: %v", err)
		}
		hostIPLog("WARNING: control panel boot guarantee failed: %v", err)
		bootIssues = append(bootIssues, fmt.Sprintf("control panel boot guarantee failed: %v", err))
	}

	// ─── Step 2c — Repair Spine-owned security posture ────────────────
	// These are independent of host-IP changes: existing installs may have
	// missing/stale UI ACLs or the legacy LAN-wide CP :3000 proxy.
	if err := container.RepairControlPanelPortProxy("youeye-control", 3000); err != nil {
		hostIPLog("WARNING: Control Panel localhost proxy repair failed: %v", err)
		bootIssues = append(bootIssues, fmt.Sprintf("Control Panel localhost proxy repair failed: %v", err))
	} else {
		hostIPLog("✓ Control Panel raw proxy is localhost-only")
	}
	if err := container.EnforceUIEgressBlock(); err != nil {
		hostIPLog("WARNING: UI→CP ACL repair failed: %v", err)
		bootIssues = append(bootIssues, fmt.Sprintf("UI→CP ACL repair failed: %v", err))
	} else {
		hostIPLog("✓ UI→CP ACL enforced")
	}

	// ─── Step 2d — Verify CP unit HOST_IP env (unchanged path too) ─────
	// A stale Environment=HOST_IP= (youeye-id was never migrated before
	// 0.5.7) can never be repaired by the IP-change path once .host_ip
	// matches the live IP, so verify the unit files on every boot and
	// steady-state pass. The changed path re-syncs them in Step 4 anyway.
	if !result.Changed {
		if err := verifyCPUnitHostIPEnv(current); err != nil {
			hostIPLog("WARNING: CP unit HOST_IP verification failed: %v", err)
			bootIssues = append(bootIssues, fmt.Sprintf("CP unit HOST_IP verification failed: %v", err))
		}
	}

	// ─── Step 3 — IP-change detection ──────────────────────────────────
	if stored == "" {
		// First run / upgrade-from-pre-feature-Spine: seed the file and
		// exit. The pihole-lifecycle steps above already ran, so pihole
		// is now correctly configured and running.
		if err := util.WriteStoredHostIP(current); err != nil {
			return result, fmt.Errorf("failed to seed %s with %s: %v", util.HostIPFile, current, err)
		}
		result.Seeded = true
		hostIPLog("first run — recorded current IP %s", current)
		if !opts.Force {
			if len(bootIssues) > 0 {
				return result, fmt.Errorf("startup issues: %s", strings.Join(bootIssues, "; "))
			}
			return result, nil
		}
		stored = current
		result.Stored = current
	}

	if !result.Changed && !opts.Force {
		if len(bootIssues) > 0 {
			return result, fmt.Errorf("startup issues: %s", strings.Join(bootIssues, "; "))
		}
		hostIPLog("host IP unchanged (%s); pihole lifecycle handled", current)
		return result, nil
	}

	if result.Changed {
		hostIPLog("HOST IP CHANGED: %s → %s; running CP-side migration", stored, current)
	} else {
		hostIPLog("host IP unchanged (%s); refreshing CP-side network state", current)
	}

	// ─── Step 4 — CP systemd HOST_IP env (strict) ──────────────────────
	if err := ensureContainerRunning("youeye-control", 60*time.Second); err != nil {
		hostIPLog("ERROR (strict): youeye-control container is not running: %v; aborting migration", err)
		return result, fmt.Errorf("youeye-control container is not running: %v", err)
	}
	if err := migrateControlHostIPEnv(stored, current); err != nil {
		hostIPLog("ERROR (strict): CP systemd HOST_IP update failed: %v; aborting migration", err)
		return result, fmt.Errorf("CP systemd HOST_IP update failed: %v", err)
	}
	hostIPLog("✓ CP systemd HOST_IP → %s", current)

	// ─── Step 5 — Wait for CP to come back up ──────────────────────────
	if err := waitForCPHealthy(90 * time.Second); err != nil {
		return result, fmt.Errorf("CP did not become healthy after restart: %v; NOT persisting", err)
	}
	hostIPLog("✓ CP healthy after restart")

	// ─── Step 6 — Wait for Pi-Hole to be reachable from CP ─────────────
	// CP /api/host-ip/migrate calls setDomainDNS which makes an HTTP API
	// call to Pi-Hole. If Pi-Hole isn't responding, setDomainDNS throws,
	// the endpoint catches the error, and returns {ok:true, dns:false}.
	// We need pihole reachable BEFORE calling the migrate endpoint.
	//
	// Bug history (BUG-006, found in 0.2.18.7 physical IP-change test):
	// the goroutine called CP migrate during a window where pihole was
	// down (Step 3 had timed out, Steps 4-5 succeeded for CP, then Step 6
	// hit pihole-down). CP returned {dns:false, caddy:true}. Spine only
	// checked the curl exit code (200), treated as success, persisted
	// .host_ip. Result: dnsmasq_lines stayed on the old IP and the
	// goroutine never retried.
	if err := waitForPiholeHealthy(60 * time.Second); err != nil {
		hostIPLog("WARNING: pihole not reachable: %v; skipping CP-side migration AND skipping persist (next boot will retry)", err)
		return result, fmt.Errorf("pihole not reachable: %v; NOT persisting", err)
	}

	// ─── Step 7 — CP-side dnsmasq + Caddy migration ────────────────────
	// Now strict: parses the response and refuses to persist if any required
	// DNS step failed.
	var migrateErr error
	for attempt := 1; attempt <= migrateMaxAttempts; attempt++ {
		migrateErr = callCPHostIPMigrate(stored, current, opts.Force)
		if migrateErr == nil {
			break
		}
		if attempt < migrateMaxAttempts {
			hostIPLog("WARNING: CP /api/host-ip/migrate attempt %d/%d failed: %v; retrying in %s", attempt, migrateMaxAttempts, migrateErr, migrateRetryDelay)
			time.Sleep(migrateRetryDelay)
		}
	}
	if migrateErr != nil {
		return result, fmt.Errorf("CP /api/host-ip/migrate failed after %d attempts: %v; NOT persisting", migrateMaxAttempts, migrateErr)
	}
	hostIPLog("✓ CP migrated dnsmasq_lines + caddy route")

	// ─── Persist ───────────────────────────────────────────────────────
	if err := util.WriteStoredHostIP(current); err != nil {
		return result, fmt.Errorf("failed to persist new IP %s to %s: %v", current, util.HostIPFile, err)
	}
	result.Migrated = result.Changed
	result.Refreshed = !result.Changed
	if result.Migrated {
		hostIPLog("HOST IP MIGRATION COMPLETE: %s → %s", stored, current)
	} else {
		hostIPLog("HOST IP NETWORK REFRESH COMPLETE: %s", current)
	}
	return result, nil
}

func acquireHostIPMigrationLock() (func(), error) {
	if err := os.MkdirAll("/var/run/youeye", 0755); err != nil {
		return nil, fmt.Errorf("create lock directory: %v", err)
	}
	f, err := os.OpenFile(hostIPMigrationLockPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("open migration lock: %v", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if err == syscall.EWOULDBLOCK || err == syscall.EAGAIN {
			return nil, fmt.Errorf("host-IP migration already running")
		}
		return nil, fmt.Errorf("lock migration: %v", err)
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

// waitForPiholeHealthy polls Pi-Hole's authenticated FTL API from inside
// youeye-control, using the same bridge network path and credentials that
// CP's setDomainDNS call uses. A bare HTTP response from /api/auth is not
// enough: during cold starts the webserver can answer before the auth/session
// subsystem is ready for config writes.
//
// Falling back to the in-container loopback probe is allowed only when we
// cannot resolve Pi-Hole's bridge IP at all, and even that fallback uses the
// real password/auth contract so it cannot go green before FTL auth works.
func waitForPiholeHealthy(timeout time.Duration) error {
	password, err := readStoredPiholePassword()
	if err != nil {
		return fmt.Errorf("read Pi-Hole password: %v", err)
	}

	piholeIP, err := containerIPv4("youeye-pihole")
	if err != nil {
		hostIPLog("WARNING: could not resolve youeye-pihole bridge IP: %v; falling back to in-container loopback health check", err)
		return waitForPiholeHealthyLoopback(password, timeout)
	}
	return waitForPiholeHealthyFromControl(piholeIP, password, timeout)
}

func waitForPiholeHealthyFromControl(piholeIP, password string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := fmt.Sprintf("http://%s:80/api/auth", piholeIP)
	var lastErr error
	for time.Now().Before(deadline) {
		if err := probePiholeAuth("youeye-control", url, password); err == nil {
			return nil
		} else {
			lastErr = err
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("pihole FTL auth did not become ready on %s from youeye-control within %s (last error: %v)", url, timeout, lastErr)
}

func waitForPiholeHealthyLoopback(password string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := "http://127.0.0.1:80/api/auth"
	var lastErr error
	for time.Now().Before(deadline) {
		if err := probePiholeAuth("youeye-pihole", url, password); err == nil {
			return nil
		} else {
			lastErr = err
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("pihole FTL auth did not become ready on container loopback within %s (last error: %v)", timeout, lastErr)
}

func readStoredPiholePassword() (string, error) {
	passwordBytes, err := os.ReadFile(piholePasswordFile)
	if err == nil {
		password := strings.TrimSpace(string(passwordBytes))
		if password == "" {
			return "", fmt.Errorf("%s is empty", piholePasswordFile)
		}
		return password, nil
	}

	password, migrateErr := migrateStoredPiholePasswordFromContainer()
	if migrateErr != nil {
		return "", fmt.Errorf("%s unavailable: %v; legacy env migration failed: %v", piholePasswordFile, err, migrateErr)
	}
	return password, nil
}

func migrateStoredPiholePasswordFromContainer() (string, error) {
	keys := []string{
		"environment.FTLCONF_webserver_api_password",
		"environment.WEBPASSWORD",
	}
	for _, key := range keys {
		out, err := runWithTimeout(10*time.Second, "incus", "config", "get", "youeye-pihole", key)
		if err != nil {
			continue
		}
		password := strings.TrimSpace(string(out))
		if password == "" {
			continue
		}

		if err := os.MkdirAll("/var/lib/youeye/pihole", 0700); err != nil {
			return "", fmt.Errorf("create pihole password directory: %v", err)
		}
		if err := os.WriteFile(piholePasswordFile, []byte(password), 0600); err != nil {
			return "", fmt.Errorf("save migrated password from %s: %v", key, err)
		}
		hostIPLog("migrated Pi-Hole password from %s to %s", key, piholePasswordFile)
		return password, nil
	}
	return "", fmt.Errorf("no legacy Pi-Hole password env var found")
}

func probePiholeAuth(containerName, url, password string) error {
	payload, err := json.Marshal(map[string]string{"password": password})
	if err != nil {
		return fmt.Errorf("build auth payload: %v", err)
	}
	out, err := runWithTimeoutInput(5*time.Second, string(payload), "incus", "exec", containerName, "--",
		"curl", "-sS", "-X", "POST",
		"-H", "Content-Type: application/json",
		"--data-binary", "@-",
		url)
	if err != nil {
		return fmt.Errorf("curl auth from %s: %v: %s", containerName, err, strings.TrimSpace(string(out)))
	}
	return validatePiholeAuthResponse(out)
}

func validatePiholeAuthResponse(out []byte) error {
	trimmed := bytes.TrimSpace(out)
	if len(trimmed) == 0 {
		return fmt.Errorf("empty auth response")
	}

	var resp struct {
		Session *struct {
			Valid   bool   `json:"valid"`
			SID     string `json:"sid"`
			CSRF    string `json:"csrf"`
			Message string `json:"message"`
		} `json:"session"`
		Error interface{} `json:"error"`
	}
	if err := json.Unmarshal(trimmed, &resp); err != nil {
		return fmt.Errorf("parse auth response %q: %v", truncateForLog(string(trimmed), 240), err)
	}
	if resp.Session == nil {
		return fmt.Errorf("auth response missing session")
	}
	if !resp.Session.Valid {
		if resp.Session.Message != "" {
			return fmt.Errorf("auth session invalid: %s", resp.Session.Message)
		}
		return fmt.Errorf("auth session invalid")
	}
	if resp.Session.SID == "" {
		return fmt.Errorf("auth session valid but sid missing")
	}
	if resp.Session.CSRF == "" {
		return fmt.Errorf("auth session valid but csrf missing")
	}
	return nil
}

func truncateForLog(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-3] + "..."
}

// runWithTimeout is a wrapper around exec.CommandContext that returns the
// combined output and a meaningful error on timeout. Every host-IP-check
// shell-out goes through this — never raw exec.Command.Run() — so the
// migration cannot get stuck on a hung child process.
func runWithTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("timed out after %s running %s %s", timeout, name, strings.Join(args, " "))
	}
	return out, err
}

func runWithTimeoutInput(timeout time.Duration, input string, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = strings.NewReader(input)
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("timed out after %s running %s %s", timeout, name, strings.Join(args, " "))
	}
	return out, err
}

// ensurePiholeAutostartDisabled sets boot.autostart=false on youeye-pihole
// if it isn't already. Idempotent: a no-op when the value is already false.
// We check first because `incus config set` triggers a state-update event
// even when the value is unchanged, and we'd rather not generate noise on
// every spine startup.
func ensurePiholeAutostartDisabled() error {
	out, err := runWithTimeout(10*time.Second, "incus", "config", "get", "youeye-pihole", "boot.autostart")
	if err != nil {
		return fmt.Errorf("get boot.autostart: %v: %s", err, strings.TrimSpace(string(out)))
	}
	current := strings.TrimSpace(string(out))
	if current == "false" {
		return nil
	}
	hostIPLog("setting youeye-pihole boot.autostart=false (was %q)", current)
	if out, err := runWithTimeout(10*time.Second, "incus", "config", "set", "youeye-pihole", "boot.autostart", "false"); err != nil {
		return fmt.Errorf("set boot.autostart: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func ensureControlPanelBootRunning(timeout time.Duration) error {
	state, err := containerState("youeye-control")
	if err != nil {
		return fmt.Errorf("inspect: %v", err)
	}
	if state == "" {
		hostIPLog("youeye-control container not present yet; skipping CP boot guarantee")
		return nil
	}
	if err := ensureContainerRunning("youeye-control", timeout); err != nil {
		return err
	}
	if err := waitForCPHealthy(90 * time.Second); err != nil {
		return err
	}
	hostIPLog("✓ youeye-control running")
	return nil
}

// waitForIncusReady blocks until the Incus daemon answers a cheap instances
// query, or the budget elapses. The probe exercises the same CLI + unix
// socket + DB path that every mutation below uses, so a green probe means
// config/device calls will be answered (not queued behind a starting daemon).
// A poll loop of short probes is deliberately used instead of one long
// blocking call — a probe against a dead-but-socket-activated daemon fails
// fast with EOF instead of hanging (which is exactly how `incusd waitready`
// got stuck for 600s on clone .77).
func waitForIncusReady(budget time.Duration) error {
	deadline := time.Now().Add(budget)
	var lastErr error
	for attempt := 1; ; attempt++ {
		out, err := runWithTimeout(8*time.Second, "incus", "list", "youeye-pihole", "-c", "s", "--format", "csv")
		if err == nil {
			if attempt > 1 {
				hostIPLog("✓ incus ready after %d probes", attempt)
			}
			return nil
		}
		lastErr = fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
		if time.Now().After(deadline) {
			return fmt.Errorf("incus did not become ready within %s (last probe: %v)", budget, lastErr)
		}
		if attempt == 1 || attempt%10 == 0 {
			hostIPLog("waiting for incus to become ready (probe %d: %v)", attempt, lastErr)
		}
		time.Sleep(4 * time.Second)
	}
}

// repairIncusStartupUnit restarts incus-startup.service if it failed at boot.
// On cloned boots the unit races the socket-activated daemon, gets an EOF,
// and fails permanently (clone .77). A failed oneshot never reaches its
// RemainAfterExit state, so its ExecStop clean-shutdown coordination is lost
// for the whole session. Best-effort: only runs once Incus is known ready.
func repairIncusStartupUnit() {
	out, err := runWithTimeout(10*time.Second, "systemctl", "is-failed", "incus-startup.service")
	if err != nil || strings.TrimSpace(string(out)) != "failed" {
		// `systemctl is-failed` exits 0 only when the unit is failed.
		return
	}
	hostIPLog("incus-startup.service failed at boot (raced incusd activation); restarting it now that incus is ready")
	if out, err := runWithTimeout(90*time.Second, "systemctl", "restart", "incus-startup.service"); err != nil {
		hostIPLog("WARNING: could not repair incus-startup.service: %v: %s", err, strings.TrimSpace(string(out)))
		return
	}
	hostIPLog("✓ incus-startup.service repaired")
}

// piholeProxyDevices are youeye-pihole's host port-53 proxy devices. Both
// must always listen on the same host IP; a split (tcp on one IP, udp on
// another) leaves the container unable to start when the stale IP is no
// longer assigned to the host.
var piholeProxyDevices = []struct {
	name  string
	proto string
}{
	{"proxy0", "tcp"},
	{"proxy1", "udp"},
}

func getProxyListen(device string) (string, error) {
	out, err := runWithTimeout(10*time.Second, "incus", "config", "device", "get", "youeye-pihole", device, "listen")
	if err != nil {
		return "", fmt.Errorf("get %s listen: %v: %s", device, err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// piholeProxyDevicesMatch reports whether both proxy devices already listen
// on the given host IP. Any read error counts as a mismatch so the caller
// takes the full verified-refresh path.
func piholeProxyDevicesMatch(hostIP string) bool {
	for _, dev := range piholeProxyDevices {
		desired := fmt.Sprintf("%s:%s:53", dev.proto, hostIP)
		listen, err := getProxyListen(dev.name)
		if err != nil || listen != desired {
			return false
		}
	}
	return true
}

// waitForProxyListen polls a proxy device's listen value until it matches
// the desired address or the timeout elapses. Used as the write-verification
// step: a device set that timed out client-side may still land server-side
// a few seconds later.
func waitForProxyListen(device, desired string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last string
	var lastErr error
	for time.Now().Before(deadline) {
		last, lastErr = getProxyListen(device)
		if lastErr == nil && last == desired {
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	if lastErr != nil {
		return fmt.Errorf("%s listen could not be verified as %s within %s (last error: %v)", device, desired, timeout, lastErr)
	}
	return fmt.Errorf("%s listen is %q, want %q (unverified after %s)", device, last, desired, timeout)
}

// migratePiholeProxyDevice rewrites the listen address of youeye-pihole's
// port-53 proxy devices to the new host IP and VERIFIES each write by
// reading the device back.
//
// Two hard-won rules encoded here (clone .78, 2026-07-03):
//   - A client-side timeout on `incus config device set` does NOT mean the
//     change failed. Incus can apply the update after the CLI gives up.
//     Treating the timeout as failure and aborting left proxy0 on the new
//     IP and proxy1 on the old one — a torn state that kept pihole from
//     ever starting. Timeouts are "unknown"; only the read-back decides.
//   - Both devices are reconciled independently and idempotently, so this
//     function also REPAIRS a pre-existing split state on the next run.
//
// With autostart=false this normally runs against a stopped container (pure
// metadata edit). The per-call timeout is a safety net for the degraded case
// where something already started pihole before this routine ran.
func migratePiholeProxyDevice(newIP string) error {
	for _, dev := range piholeProxyDevices {
		desired := fmt.Sprintf("%s:%s:53", dev.proto, newIP)
		if current, err := getProxyListen(dev.name); err == nil && current == desired {
			continue
		}
		if out, err := runWithTimeout(15*time.Second, "incus", "config", "device", "set",
			"youeye-pihole", dev.name, "listen="+desired); err != nil {
			hostIPLog("WARNING: %s (%s) device set returned %v: %s; verifying actual state", dev.name, dev.proto, err, strings.TrimSpace(string(out)))
		}
		if err := waitForProxyListen(dev.name, desired, 30*time.Second); err != nil {
			return fmt.Errorf("%s (%s): %v", dev.name, dev.proto, err)
		}
	}
	return nil
}

// isContainerRunning returns true if the named container is in state RUNNING.
// Used to short-circuit `incus start` calls (and to log warnings when we
// expected a container to be stopped at this point in the boot flow).
func isContainerRunning(name string) (bool, error) {
	state, err := containerState(name)
	if err != nil {
		return false, err
	}
	return state == "RUNNING", nil
}

// ensureContainerRunning starts the named Incus container if it is not
// already running, then polls until its state is RUNNING or the timeout
// elapses.
//
// Critical: treats the "already running" case as success — calling this
// against a container that is already up is a no-op, NOT a fatal error.
// This was BUG-004 in 0.2.18.6, where the strict path aborted because CP
// was already running and `incus start` returned exit-1 with the message
// "The instance is already running".
func ensureContainerRunning(name string, timeout time.Duration) error {
	state, err := containerState(name)
	if err != nil {
		return fmt.Errorf("inspect: %v", err)
	}
	if state == "RUNNING" {
		return nil
	}
	hostIPLog("starting %s (was %s)...", name, state)
	if out, err := runWithTimeout(60*time.Second, "incus", "start", name); err != nil {
		// Defensive: if `incus start` raced with another caller and the
		// container is now RUNNING, treat as success.
		s, ierr := containerState(name)
		if ierr == nil && s == "RUNNING" {
			return nil
		}
		return fmt.Errorf("start: %v: %s", err, strings.TrimSpace(string(out)))
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s, err := containerState(name)
		if err == nil && s == "RUNNING" {
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("%s did not reach RUNNING within %s", name, timeout)
}

func stopContainer(name string, timeout time.Duration) error {
	state, err := containerState(name)
	if err != nil {
		return fmt.Errorf("inspect: %v", err)
	}
	if state != "RUNNING" {
		return nil
	}

	hostIPLog("stopping %s before host-IP network migration...", name)
	if out, err := runWithTimeout(timeout, "incus", "stop", name); err != nil {
		hostIPLog("WARNING: graceful stop of %s failed: %v: %s; forcing stop", name, err, strings.TrimSpace(string(out)))
		if out, ferr := runWithTimeout(20*time.Second, "incus", "stop", name, "--force"); ferr != nil {
			return fmt.Errorf("force stop: %v: %s", ferr, strings.TrimSpace(string(out)))
		}
	}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s, err := containerState(name)
		if err == nil && s != "RUNNING" {
			return nil
		}
		time.Sleep(1 * time.Second)
	}
	return fmt.Errorf("%s did not stop within %s", name, timeout)
}

func containerState(name string) (string, error) {
	out, err := runWithTimeout(10*time.Second, "incus", "list", name, "-c", "s", "--format", "csv")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func containerIPv4(name string) (string, error) {
	out, err := runWithTimeout(10*time.Second, "incus", "list", name, "-c", "4", "--format", "csv")
	if err == nil {
		if ip := firstIPv4Token(string(out)); ip != "" {
			return ip, nil
		}
	} else {
		hostIPLog("WARNING: incus list IPv4 lookup for %s failed: %v: %s", name, err, strings.TrimSpace(string(out)))
	}

	if ip, staticErr := incusutil.GetSystemContainerIP(name); staticErr == nil && ip != "" {
		return ip, nil
	}

	if err != nil {
		return "", fmt.Errorf("incus list IPv4 lookup failed: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return "", fmt.Errorf("incus list returned no IPv4 address for %s", name)
}

func firstIPv4Token(output string) string {
	fields := strings.FieldsFunc(output, func(r rune) bool {
		return r == ',' || r == '\n' || r == '\t' || r == ' ' || r == '(' || r == ')'
	})
	for _, field := range fields {
		ip := net.ParseIP(strings.TrimSpace(field))
		if ip != nil && ip.To4() != nil {
			return ip.String()
		}
	}
	return ""
}

// cpHostIPServices are the systemd services inside the youeye-control
// container that carry an Environment=HOST_IP= line in their unit file.
// youeye-control is strict (the migration aborts if it cannot be updated);
// youeye-id is best-effort (identity keeps serving on a stale IP until the
// next converge pass repairs it). Before 0.5.7 only youeye-control was
// migrated — observed live on clone .80 with youeye-id two IP generations
// stale, unrepairable because .host_ip already matched the live IP.
var cpHostIPServices = []string{"youeye-control", "youeye-id"}

// errHostIPUnitMissing marks a unit file (or its HOST_IP line) that does not
// exist in the container — callers decide whether that is fatal per service.
var errHostIPUnitMissing = fmt.Errorf("unit file or HOST_IP line not found")

// pullUnitFile reads /etc/systemd/system/<service>.service from the
// youeye-control container. Returns errHostIPUnitMissing when the file does
// not exist.
func pullUnitFile(service string) (string, error) {
	containerPath := "youeye-control/etc/systemd/system/" + service + ".service"

	// `incus file pull` to stdout requires capturing stdout, not combined
	// output. Use exec.CommandContext directly.
	pullCtx, pullCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer pullCancel()
	pullCmd := exec.CommandContext(pullCtx, "incus", "file", "pull", containerPath, "-")
	var pulled, pullErr bytes.Buffer
	pullCmd.Stdout = &pulled
	pullCmd.Stderr = &pullErr
	if err := pullCmd.Run(); err != nil {
		if pullCtx.Err() == context.DeadlineExceeded {
			return "", fmt.Errorf("incus file pull %s: timed out after 15s", service)
		}
		stderr := strings.ToLower(pullErr.String())
		if strings.Contains(stderr, "not found") || strings.Contains(stderr, "no such file") {
			return "", errHostIPUnitMissing
		}
		return "", fmt.Errorf("incus file pull %s: %v: %s", service, err, strings.TrimSpace(pullErr.String()))
	}
	return pulled.String(), nil
}

// readUnitHostIP returns the current value of the Environment=HOST_IP= line
// in a service's unit file (read-only; used by the steady-state check).
func readUnitHostIP(service string) (string, error) {
	unit, err := pullUnitFile(service)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(unit, "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		if strings.HasPrefix(trimmed, "Environment=HOST_IP=") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "Environment=HOST_IP=")), nil
		}
	}
	return "", errHostIPUnitMissing
}

// syncUnitHostIP ensures the service's unit file has Environment=HOST_IP=newIP.
// Returns whether the file was changed. Does NOT daemon-reload or restart —
// callers batch that via reloadAndRestartUnits.
func syncUnitHostIP(service, newIP string) (bool, error) {
	original, err := pullUnitFile(service)
	if err != nil {
		return false, err
	}
	if !strings.Contains(original, "Environment=HOST_IP=") {
		return false, errHostIPUnitMissing
	}

	updated := replaceHostIPLine(original, newIP)
	if updated == original {
		return false, nil
	}

	tmp, err := os.CreateTemp("", service+".service.*")
	if err != nil {
		return false, fmt.Errorf("tempfile: %v", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(updated); err != nil {
		tmp.Close()
		return false, fmt.Errorf("write tempfile: %v", err)
	}
	tmp.Close()

	containerPath := "youeye-control/etc/systemd/system/" + service + ".service"
	if out, err := runWithTimeout(15*time.Second, "incus", "file", "push", tmp.Name(), containerPath); err != nil {
		return false, fmt.Errorf("incus file push %s: %v: %s", service, err, strings.TrimSpace(string(out)))
	}
	return true, nil
}

// reloadAndRestartUnits daemon-reloads once and restarts each changed service
// inside the youeye-control container.
func reloadAndRestartUnits(services []string) error {
	if len(services) == 0 {
		return nil
	}
	if out, err := runWithTimeout(15*time.Second, "incus", "exec", "youeye-control", "--",
		"systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("daemon-reload: %v: %s", err, strings.TrimSpace(string(out)))
	}
	for _, service := range services {
		if out, err := runWithTimeout(20*time.Second, "incus", "exec", "youeye-control", "--",
			"systemctl", "restart", service); err != nil {
			return fmt.Errorf("restart %s: %v: %s", service, err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// migrateControlHostIPEnv updates the Environment=HOST_IP= line in every
// CP-container service unit (youeye-control strict, youeye-id best-effort),
// then daemon-reloads and restarts the changed services.
func migrateControlHostIPEnv(oldIP, newIP string) error {
	var changed []string

	ctrlChanged, err := syncUnitHostIP("youeye-control", newIP)
	if err != nil {
		return fmt.Errorf("youeye-control: %v", err)
	}
	if ctrlChanged {
		changed = append(changed, "youeye-control")
	} else {
		hostIPLog("CP unit already has HOST_IP=%s (no change)", newIP)
	}

	idChanged, idErr := syncUnitHostIP("youeye-id", newIP)
	switch {
	case idErr == errHostIPUnitMissing:
		hostIPLog("youeye-id unit has no HOST_IP line (or no unit); skipping")
	case idErr != nil:
		hostIPLog("WARNING: youeye-id HOST_IP update failed: %v (identity service repaired on a later converge pass)", idErr)
	case idChanged:
		changed = append(changed, "youeye-id")
	}

	if err := reloadAndRestartUnits(changed); err != nil {
		return err
	}

	_ = oldIP
	return nil
}

// verifyCPUnitHostIPEnv repairs any CP-container unit whose HOST_IP env does
// not match the current host IP. Runs on the unchanged-IP boot path and via
// steady-state repair — this is what heals a youeye-id left stale by
// pre-0.5.7 migrations, where the IP-change path can never fire again
// because .host_ip already matches the live IP.
func verifyCPUnitHostIPEnv(current string) error {
	var changed []string
	var errs []string
	for _, service := range cpHostIPServices {
		unitChanged, err := syncUnitHostIP(service, current)
		if err == errHostIPUnitMissing {
			continue
		}
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", service, err))
			continue
		}
		if unitChanged {
			hostIPLog("repaired stale HOST_IP in %s.service → %s", service, current)
			changed = append(changed, service)
		}
	}
	if err := reloadAndRestartUnits(changed); err != nil {
		errs = append(errs, err.Error())
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

// replaceHostIPLine substitutes the value of an Environment=HOST_IP=... line
// in a systemd unit file. Returns the file unchanged if no such line is found.
func replaceHostIPLine(unit, newIP string) string {
	lines := strings.Split(unit, "\n")
	for i, line := range lines {
		trimmed := strings.TrimLeft(line, " \t")
		if strings.HasPrefix(trimmed, "Environment=HOST_IP=") {
			indent := line[:len(line)-len(trimmed)]
			lines[i] = indent + "Environment=HOST_IP=" + newIP
		}
	}
	return strings.Join(lines, "\n")
}

// waitForCPHealthy polls the CP /api/setup/config endpoint inside the
// youeye-control container until it returns success or the timeout elapses.
func waitForCPHealthy(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, err := runWithTimeout(5*time.Second, "incus", "exec", "youeye-control", "--",
			"curl", "-sf", "-o", "/dev/null",
			"http://127.0.0.1:3000/api/setup/config")
		if err == nil {
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("CP /api/setup/config did not respond within %s", timeout)
}

// callCPHostIPMigrate POSTs to the CP /api/host-ip/migrate endpoint via
// `incus exec ... curl` (since CP listens on 127.0.0.1:3000 inside the
// container only).
//
// **Strict response parsing (BUG-006 fix from 0.2.18.7)**: the CP endpoint
// catches errors from its sub-steps and ALWAYS returns ok:true with per-step
// flags `dns` and `caddy`. Earlier versions of this function only checked
// the curl exit code, so a partial-failure response (e.g. dns:false because
// Pi-Hole was down) was treated as success and the goroutine persisted the
// new IP — leaving dnsmasq_lines stale forever. Now we parse the JSON and
// require both dns:true AND caddy:true (or caddy:false acceptable iff there
// was no legacy IP-literal route to remove — but the endpoint reports
// caddy:true on no-op as well, so this is conservatively strict).
func callCPHostIPMigrate(oldIP, newIP string, force bool) error {
	secretBytes, err := os.ReadFile("/var/lib/youeye/control/.deploy_secret")
	if err != nil {
		return fmt.Errorf("read deploy secret: %v", err)
	}
	deploySecret := strings.TrimSpace(string(secretBytes))

	body := fmt.Sprintf(`{"old":"%s","new":"%s","force":%t}`, oldIP, newIP, force)

	// Note: NOT using `curl -f` here. We want the response body even on
	// non-2xx, so we can include it in the error message.
	out, err := runWithTimeout(30*time.Second, "incus", "exec", "youeye-control", "--",
		"curl", "-s", "-X", "POST",
		"-H", "Content-Type: application/json",
		"-H", "X-Deploy-Secret: "+deploySecret,
		"-d", body,
		"http://127.0.0.1:3000/api/host-ip/migrate")
	if err != nil {
		return fmt.Errorf("curl: %v: %s", err, strings.TrimSpace(string(out)))
	}

	// Parse {ok, dns, caddy, ...}
	var resp struct {
		OK                     bool   `json:"ok"`
		DNS                    bool   `json:"dns"`
		DNSRequired            *bool  `json:"dnsRequired"`
		ProviderDNS            bool   `json:"providerDns"`
		ProviderDNSRequired    bool   `json:"providerDnsRequired"`
		ProviderDNSError       string `json:"providerDnsError"`
		YouEyeNamesDNS         bool   `json:"youeyeNamesDns"`
		YouEyeNamesDNSRequired bool   `json:"youeyeNamesDnsRequired"`
		YouEyeNamesError       string `json:"youeyeNamesError"`
		Caddy                  bool   `json:"caddy"`
		Error                  string `json:"error"`
	}
	if jerr := json.Unmarshal(bytes.TrimSpace(out), &resp); jerr != nil {
		return fmt.Errorf("parse response %q: %v", strings.TrimSpace(string(out)), jerr)
	}
	if !resp.OK {
		return fmt.Errorf("endpoint returned not-ok: %s", resp.Error)
	}
	dnsRequired := true
	if resp.DNSRequired != nil {
		dnsRequired = *resp.DNSRequired
	}
	// dns:false means setDomainDNS failed (most likely Pi-Hole was not
	// reachable). This is the BUG-006 case — we MUST return an error so
	// the caller does not persist .host_ip and the next boot retries.
	if dnsRequired && !resp.DNS {
		return fmt.Errorf("endpoint reported dns:false (Pi-Hole likely unreachable when CP tried setDomainDNS)")
	}
	if resp.ProviderDNSRequired && !resp.ProviderDNS {
		if resp.ProviderDNSError != "" {
			return fmt.Errorf("endpoint reported providerDns:false: %s", resp.ProviderDNSError)
		}
		return fmt.Errorf("endpoint reported providerDns:false")
	}
	if resp.YouEyeNamesDNSRequired && !resp.YouEyeNamesDNS {
		if resp.YouEyeNamesError != "" {
			return fmt.Errorf("endpoint reported youeyeNamesDns:false: %s", resp.YouEyeNamesError)
		}
		return fmt.Errorf("endpoint reported youeyeNamesDns:false")
	}
	// caddy:false on its own is OK if there was no legacy IP-literal
	// route to remove (the endpoint logs "no legacy route" in that case
	// and still returns caddy:false because removeIPLiteralRoute returned
	// false). On a fresh install with CP >= 0.2.18.3 there will never be
	// such a route, so caddy:false is the expected steady state.
	return nil
}
