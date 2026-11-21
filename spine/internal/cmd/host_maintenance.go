package cmd

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/util"
)

// Host maintenance the API service runs at start and then daily. It lives in the selected Spine (not in the seed's
// `appliance prepare`), so it ships as a Spine update without an image rebuild.
const (
	arcMaxParameter     = "/sys/module/zfs/parameters/zfs_arc_max"
	incusContainersPath = "/var/lib/incus/containers"
	execOutputMaxAge    = 24 * time.Hour // longer than any exec (a large pg_dump), so a running one keeps its file
	arcFloorBytes       = 512 << 20
	arcCeilingBytes     = 16 << 30
)

// stageTreeSweepDelay: see startHostMaintenance.
const stageTreeSweepDelay = 15 * time.Minute

func startHostMaintenance() {
	go func() {
		for first := true; ; first = false {
			runHostMaintenance()
			if !first {
				pruneFinishedCoreUpdates()
			}
			time.Sleep(24 * time.Hour)
		}
	}()
	// The run at start is usually too early for the old service trees: at boot the two containers are not running
	// yet, and a Spine update restarts this service in the middle of its own request. Look once more when either
	// has settled, so the sweep does not wait for a box that is restarted more often than once a day.
	go func() {
		time.Sleep(stageTreeSweepDelay)
		sweepFinishedCoreStageTrees()
		// Not at the start itself: after a boot the boot unit may be releasing the request at that moment, and
		// the pruning holds the coordinator lock while it deletes snapshots.
		pruneFinishedCoreUpdates()
	}()
}

func runHostMaintenance() {
	if err := applyARCCeiling(arcMaxParameter, "/proc/meminfo"); err != nil {
		util.LogError("ZFS ARC ceiling not applied: " + err.Error())
	}
	removed, err := sweepExecOutput(incusContainersPath, time.Now().Add(-execOutputMaxAge))
	if err != nil {
		util.LogError("Incus exec output sweep incomplete: " + err.Error())
	}
	if removed > 0 {
		util.LogSuccess(fmt.Sprintf("Removed %d old Incus exec output files", removed))
	}
	// Last: it may wait for Incus, which can still be starting when the API service comes up.
	if err := disableIncusImageRefresh(incusConfig, incusImageRefreshAttempts, incusImageRefreshWait); err != nil {
		util.LogError("Incus cached-image refresh not disabled: " + err.Error())
	}
	sweepFinishedCoreStageTrees()
}

func sweepFinishedCoreStageTrees() {
	if removed := removeFinishedCoreStageTrees(); len(removed) > 0 {
		util.LogSuccess(fmt.Sprintf("Removed %d old service trees left by finished System updates", len(removed)))
	}
}

// pruneFinishedCoreUpdates removes the checkpoints, cached release files and receipts that finished System updates
// left, except the last good checkpoint (NativeCoreRuntime.PruneFinished). A finished request prunes when it ends;
// this catches what earlier versions left (they never removed any), a request that an earlier Spine finished and
// whatever could not be removed at that moment. It runs 15 minutes after the API service started and then daily.
// It does nothing while a System request is unfinished or on a
// machine that is not an installed appliance.
func pruneFinishedCoreUpdates() {
	defer func() {
		if r := recover(); r != nil {
			util.LogError(fmt.Sprintf("System update pruning: %v", r))
		}
	}()
	runtime, err := installedCoreRuntime()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	if pruned := runtime.PruneFinished(ctx); pruned.Changed() {
		util.LogSuccess("System updates: " + pruned.String())
	}
}

// removeFinishedCoreStageTrees deletes the old Control Panel and UI trees that finished System updates left under
// their stage names (/opt/.youeye-core-<hash>) in youeye-control and youeye-ui. A finished request removes its own
// when it ends; this catches what earlier versions left (they never removed any) and a container that was stopped
// at that moment. It does nothing while a System request is unfinished, on a machine that is not an installed
// appliance, or when a container is not running.
func removeFinishedCoreStageTrees() []string {
	runtime, err := installedCoreRuntime()
	if err != nil {
		return nil
	}
	return runtime.Services.RemoveFinishedStageTrees(context.Background())
}

const (
	incusImageRefreshKey      = "images.auto_update_interval"
	incusImageRefreshAttempts = 10
	incusImageRefreshWait     = 30 * time.Second
)

func incusConfig(args ...string) (string, error) {
	out, err := runWithTimeout(15*time.Second, "incus", append([]string{"config"}, args...)...)
	return string(out), err
}

// disableIncusImageRefresh sets images.auto_update_interval to 0 on a box installed before the preseed carried it.
// App and system images are pinned by digest and the Debian base is a local image that never refreshes, so the
// periodic refresh (default every 6 hours, one registry request per cached image) can only waste requests.
func disableIncusImageRefresh(config func(args ...string) (string, error), attempts int, wait time.Duration) error {
	var err error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			time.Sleep(wait)
		}
		var current string
		if current, err = config("get", incusImageRefreshKey); err != nil {
			continue // Incus not ready yet
		}
		if strings.TrimSpace(current) == "0" {
			return nil
		}
		if _, err = config("set", incusImageRefreshKey, "0"); err == nil {
			util.LogSuccess("Incus cached-image refresh disabled (images are pinned by digest)")
			return nil
		}
	}
	return err
}

// arcCeiling is Proxmox VE's rule for new installs (10 % of RAM, at most 16 GiB) with a 512 MiB floor. Unset, the
// ARC grows toward all RAM (about 6.9 GiB on an 8 GB box) and starves containers under memory pressure.
func arcCeiling(memTotalBytes uint64) uint64 {
	ceiling := memTotalBytes / 10
	if ceiling < arcFloorBytes {
		ceiling = arcFloorBytes
	}
	if ceiling > arcCeilingBytes {
		ceiling = arcCeilingBytes
	}
	return ceiling
}

func applyARCCeiling(parameter, meminfo string) error {
	if _, err := os.Stat(parameter); err != nil {
		return nil // ZFS module not loaded (not an appliance with a pool)
	}
	total, err := memTotalBytes(meminfo)
	if err != nil {
		return err
	}
	want := strconv.FormatUint(arcCeiling(total), 10)
	current, err := os.ReadFile(parameter)
	if err != nil {
		return err
	}
	// 0 is ZFS's "no ceiling" default (every boot). Any other value is ours or an administrator's: leave it.
	if strings.TrimSpace(string(current)) != "0" {
		return nil
	}
	return os.WriteFile(parameter, []byte(want+"\n"), 0644)
}

func memTotalBytes(meminfo string) (uint64, error) {
	file, err := os.Open(meminfo)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return 0, err
			}
			return kb * 1024, nil
		}
	}
	return 0, fmt.Errorf("MemTotal not found")
}

// sweepExecOutput deletes recorded `incus exec` output older than the cutoff. Incus keeps every exec's stdout and
// stderr for ever (the Control Panel recorded about 1.2 GB a day on a 36-app box before 0.6.9, across reboots); the
// Control Panel now deletes what it reads, and this removes what earlier versions left. Only running containers'
// directories are reachable: a stopped container's dataset is unmounted and is swept after its next start.
func sweepExecOutput(containers string, cutoff time.Time) (int, error) {
	entries, err := os.ReadDir(containers)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	removed := 0
	var firstErr error
	for _, entry := range entries {
		dir := filepath.Join(containers, entry.Name(), "exec-output")
		files, err := os.ReadDir(dir)
		if err != nil {
			continue // unmounted (stopped) or no exec yet
		}
		for _, file := range files {
			if !file.Type().IsRegular() || !strings.HasPrefix(file.Name(), "exec_") {
				continue
			}
			info, err := file.Info()
			if err != nil || !info.ModTime().Before(cutoff) {
				continue
			}
			if err := os.Remove(filepath.Join(dir, file.Name())); err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			removed++
		}
	}
	return removed, firstErr
}
