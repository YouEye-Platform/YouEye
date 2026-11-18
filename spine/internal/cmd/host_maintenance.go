package cmd

import (
	"bufio"
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

func startHostMaintenance() {
	go func() {
		for {
			runHostMaintenance()
			time.Sleep(24 * time.Hour)
		}
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
