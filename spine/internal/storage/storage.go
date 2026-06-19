// Package storage plans and applies appliance-style host storage management.
package storage

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"git.potemk.in/potemsla/YouEye/spine/internal/config"
)

const (
	GiB = int64(1024 * 1024 * 1024)
)

// Policy controls automatic storage management.
type Policy struct {
	Mode                string
	AutoExpandRoot      bool
	AutoGrowIncus       bool
	HostReserveGB       int
	MaxIncusPoolPercent int
}

// Snapshot is the host storage state used by the planner.
type Snapshot struct {
	InContainer bool

	RootSource          string
	RootSourceCanonical string
	RootFSType          string
	RootTotalBytes      int64
	RootUsedBytes       int64
	RootAvailBytes      int64

	LVs []LogicalVolume
	VGs []VolumeGroup

	IncusPool *IncusPool
}

// LogicalVolume describes an LVM logical volume.
type LogicalVolume struct {
	Path          string
	CanonicalPath string
	VGName        string
	Name          string
	SizeBytes     int64
}

// VolumeGroup describes an LVM volume group.
type VolumeGroup struct {
	Name      string
	SizeBytes int64
	FreeBytes int64
	LVCount   int
	PVCount   int
}

// IncusPool describes the default Incus storage pool when present.
type IncusPool struct {
	Name            string
	Driver          string
	Source          string
	ConfigSize      string
	ConfigSizeBytes int64
	AllocatedBytes  int64
	ManagedLoop     bool
}

// Plan is the deterministic decision from a Snapshot and Policy.
type Plan struct {
	Policy Policy

	RootLV          *LogicalVolume
	RootVG          *VolumeGroup
	RootGrow        bool
	RootGrowBytes   int64
	RootGrowReason  string
	RootSkipReasons []string

	RootTotalAfterBytes int64
	RootAvailAfterBytes int64
	HostReserveBytes    int64

	IncusTargetBytes int64
	IncusGrow        bool
	IncusGrowBytes   int64
	IncusSkipReasons []string
}

// Result is returned after an ensure run.
type Result struct {
	InitialSnapshot Snapshot
	InitialPlan     Plan
	FinalSnapshot   Snapshot
	FinalPlan       Plan
	Warnings        []string
}

type commandRunner interface {
	Run(name string, args ...string) (string, error)
}

type osRunner struct{}

func (osRunner) Run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return string(out), err
}

// PolicyFromConfig normalizes persisted Spine config into a storage policy.
func PolicyFromConfig(cfg config.StorageConfig) Policy {
	mode := strings.TrimSpace(cfg.Mode)
	if mode == "" {
		mode = "appliance"
	}
	hostReserveGB := cfg.HostReserveGB
	if hostReserveGB <= 0 {
		hostReserveGB = 60
	}
	maxPercent := cfg.MaxIncusPoolPercent
	if maxPercent <= 0 || maxPercent > 100 {
		maxPercent = 85
	}
	return Policy{
		Mode:                mode,
		AutoExpandRoot:      cfg.AutoExpandRoot,
		AutoGrowIncus:       cfg.AutoGrowIncus,
		HostReserveGB:       hostReserveGB,
		MaxIncusPoolPercent: maxPercent,
	}
}

// EnsureApplianceStorage applies safe host storage growth and returns the
// desired Incus pool target for the caller to use while initializing Incus.
func EnsureApplianceStorage(policy Policy) (Result, error) {
	return ensureApplianceStorage(policy, osRunner{})
}

// PlanCurrentStorage inspects host storage without applying changes.
func PlanCurrentStorage(policy Policy) Result {
	snap, warnings := collectSnapshot(osRunner{})
	plan := ComputePlan(policy, snap)
	return Result{
		InitialSnapshot: snap,
		InitialPlan:     plan,
		FinalSnapshot:   snap,
		FinalPlan:       plan,
		Warnings:        warnings,
	}
}

func ensureApplianceStorage(policy Policy, runner commandRunner) (Result, error) {
	var result Result
	snap, warnings := collectSnapshot(runner)
	result.InitialSnapshot = snap
	result.Warnings = append(result.Warnings, warnings...)
	result.InitialPlan = ComputePlan(policy, snap)

	printPlan(result.InitialPlan, result.Warnings)

	if result.InitialPlan.RootGrow {
		fmt.Printf("  -> Expanding root filesystem by %s...\n", FormatBytes(result.InitialPlan.RootGrowBytes))
		if _, err := runner.Run("lvextend", "--resizefs", "--extents", "+100%FREE", result.InitialPlan.RootLV.Path); err != nil {
			return result, fmt.Errorf("expanding root logical volume: %w", err)
		}
		fmt.Println("  OK root filesystem expanded")
		snap, warnings = collectSnapshot(runner)
		result.Warnings = append(result.Warnings, warnings...)
	}

	result.FinalSnapshot = snap
	result.FinalPlan = ComputePlan(policy, snap)
	if result.InitialPlan.RootGrow {
		printIncusTarget(result.FinalPlan)
	}
	return result, nil
}

// ComputePlan returns a side-effect-free storage plan.
func ComputePlan(policy Policy, snap Snapshot) Plan {
	policy = normalizePolicy(policy)
	plan := Plan{
		Policy:              policy,
		RootTotalAfterBytes: snap.RootTotalBytes,
		RootAvailAfterBytes: snap.RootAvailBytes,
	}

	if strings.EqualFold(policy.Mode, "disabled") || strings.EqualFold(policy.Mode, "off") {
		plan.RootSkipReasons = append(plan.RootSkipReasons, "storage automation disabled")
		plan.IncusSkipReasons = append(plan.IncusSkipReasons, "storage automation disabled")
		return plan
	}

	if snap.InContainer {
		plan.RootSkipReasons = append(plan.RootSkipReasons, "running inside a container")
	} else if !policy.AutoExpandRoot {
		plan.RootSkipReasons = append(plan.RootSkipReasons, "root auto-expand disabled")
	} else {
		plan.RootLV = findRootLV(snap)
		if plan.RootLV == nil {
			plan.RootSkipReasons = append(plan.RootSkipReasons, "root filesystem is not a detected LVM logical volume")
		} else if !onlineGrowSupported(snap.RootFSType) {
			plan.RootSkipReasons = append(plan.RootSkipReasons, "root filesystem type does not support this online grow path")
		} else {
			plan.RootVG = findVG(snap, plan.RootLV.VGName)
			if plan.RootVG == nil {
				plan.RootSkipReasons = append(plan.RootSkipReasons, "root volume group was not detected")
			} else if plan.RootVG.LVCount > 1 {
				plan.RootSkipReasons = append(plan.RootSkipReasons, "root volume group has multiple logical volumes")
			} else if plan.RootVG.FreeBytes < 20*GiB {
				plan.RootSkipReasons = append(plan.RootSkipReasons, "less than 20 GiB free in root volume group")
			} else {
				plan.RootGrow = true
				plan.RootGrowBytes = plan.RootVG.FreeBytes
				plan.RootGrowReason = "safe unused LVM space detected"
				plan.RootTotalAfterBytes += plan.RootGrowBytes
				plan.RootAvailAfterBytes += plan.RootGrowBytes
			}
		}
	}

	plan.HostReserveBytes = hostReserveBytes(policy, plan.RootTotalAfterBytes)
	plan.IncusTargetBytes = computeIncusTarget(policy, snap, plan)

	if plan.IncusTargetBytes == 0 {
		plan.IncusSkipReasons = append(plan.IncusSkipReasons, "not enough root filesystem headroom for an appliance-sized Incus pool")
		return plan
	}
	if snap.IncusPool == nil {
		return plan
	}
	if !policy.AutoGrowIncus {
		plan.IncusSkipReasons = append(plan.IncusSkipReasons, "Incus auto-grow disabled")
		return plan
	}
	if !snap.IncusPool.ManagedLoop {
		plan.IncusSkipReasons = append(plan.IncusSkipReasons, "Incus pool is not a managed loop-backed pool")
		return plan
	}
	if snap.IncusPool.ConfigSizeBytes <= 0 {
		plan.IncusSkipReasons = append(plan.IncusSkipReasons, "Incus pool has no managed size config")
		return plan
	}
	if plan.IncusTargetBytes <= snap.IncusPool.ConfigSizeBytes {
		plan.IncusSkipReasons = append(plan.IncusSkipReasons, "Incus pool is already at or above target size")
		return plan
	}

	plan.IncusGrow = true
	plan.IncusGrowBytes = plan.IncusTargetBytes - snap.IncusPool.ConfigSizeBytes
	return plan
}

func collectSnapshot(runner commandRunner) (Snapshot, []string) {
	var snap Snapshot
	var warnings []string

	if out, err := runner.Run("systemd-detect-virt", "-c"); err == nil {
		vtype := strings.TrimSpace(out)
		snap.InContainer = vtype != "" && vtype != "none"
	}

	if out, err := runner.Run("findmnt", "-n", "-o", "SOURCE,FSTYPE", "/"); err == nil {
		fields := strings.Fields(out)
		if len(fields) >= 1 {
			snap.RootSource = fields[0]
			snap.RootSourceCanonical = canonicalDevice(runner, snap.RootSource)
		}
		if len(fields) >= 2 {
			snap.RootFSType = fields[1]
		}
	} else {
		warnings = append(warnings, "could not inspect root mount")
	}

	if out, err := runner.Run("df", "-B1", "--output=size,used,avail", "/"); err == nil {
		total, used, avail, ok := parseDF(out)
		if ok {
			snap.RootTotalBytes = total
			snap.RootUsedBytes = used
			snap.RootAvailBytes = avail
		} else {
			warnings = append(warnings, "could not parse root filesystem size")
		}
	} else {
		warnings = append(warnings, "could not inspect root filesystem size")
	}

	if out, err := runner.Run("lvs", "--reportformat", "json", "--units", "b", "--nosuffix", "-o", "lv_path,vg_name,lv_name,lv_size"); err == nil {
		snap.LVs = parseLVS(out)
		for i := range snap.LVs {
			snap.LVs[i].CanonicalPath = canonicalDevice(runner, snap.LVs[i].Path)
		}
	}
	if out, err := runner.Run("vgs", "--reportformat", "json", "--units", "b", "--nosuffix", "-o", "vg_name,vg_size,vg_free,lv_count,pv_count"); err == nil {
		snap.VGs = parseVGS(out)
	}

	if out, err := runner.Run("incus", "storage", "show", "default"); err == nil {
		pool := parseIncusStorageShow(out)
		if pool.Name == "" {
			pool.Name = "default"
		}
		if pool.Driver != "" {
			if pool.Source != "" {
				if info, statErr := os.Stat(pool.Source); statErr == nil && info.Mode().IsRegular() {
					pool.ManagedLoop = true
				} else if strings.HasPrefix(pool.Source, "/var/lib/incus/disks/") {
					pool.ManagedLoop = true
				}
			}
			if out, err := runner.Run("zpool", "list", "-Hp", "-o", "alloc", pool.Name); err == nil {
				pool.AllocatedBytes = parseInt64(out)
			}
			snap.IncusPool = &pool
		}
	}

	return snap, warnings
}

func printPlan(plan Plan, warnings []string) {
	fmt.Println("Preparing appliance storage...")
	for _, warning := range warnings {
		fmt.Printf("  Warning: %s\n", warning)
	}
	if plan.RootGrow {
		fmt.Printf("  OK found %s unused root LVM space\n", FormatBytes(plan.RootGrowBytes))
	} else if len(plan.RootSkipReasons) > 0 {
		fmt.Printf("  OK root storage unchanged (%s)\n", strings.Join(plan.RootSkipReasons, "; "))
	}
	printIncusTarget(plan)
}

func printIncusTarget(plan Plan) {
	if plan.IncusTargetBytes > 0 {
		fmt.Printf("  OK Incus pool target: %s (host reserve: %s)\n", FormatBytes(plan.IncusTargetBytes), FormatBytes(plan.HostReserveBytes))
	} else if len(plan.IncusSkipReasons) > 0 {
		fmt.Printf("  Warning: Incus pool target unavailable (%s)\n", strings.Join(plan.IncusSkipReasons, "; "))
	}
}

func normalizePolicy(policy Policy) Policy {
	if strings.TrimSpace(policy.Mode) == "" {
		policy.Mode = "appliance"
	}
	if policy.HostReserveGB <= 0 {
		policy.HostReserveGB = 60
	}
	if policy.MaxIncusPoolPercent <= 0 || policy.MaxIncusPoolPercent > 100 {
		policy.MaxIncusPoolPercent = 85
	}
	return policy
}

func findRootLV(snap Snapshot) *LogicalVolume {
	for i := range snap.LVs {
		lv := &snap.LVs[i]
		if sameDevice(lv.Path, snap.RootSource) || sameDevice(lv.CanonicalPath, snap.RootSourceCanonical) {
			return lv
		}
	}
	return nil
}

func findVG(snap Snapshot, name string) *VolumeGroup {
	for i := range snap.VGs {
		if snap.VGs[i].Name == name {
			return &snap.VGs[i]
		}
	}
	return nil
}

func sameDevice(a, b string) bool {
	return strings.TrimSpace(a) != "" && strings.TrimSpace(a) == strings.TrimSpace(b)
}

func onlineGrowSupported(fs string) bool {
	switch strings.ToLower(strings.TrimSpace(fs)) {
	case "ext4", "xfs":
		return true
	default:
		return false
	}
}

func hostReserveBytes(policy Policy, rootTotal int64) int64 {
	configured := int64(policy.HostReserveGB) * GiB
	percent := rootTotal * 15 / 100
	if percent > configured {
		return percent
	}
	return configured
}

func computeIncusTarget(policy Policy, snap Snapshot, plan Plan) int64 {
	if plan.RootTotalAfterBytes <= 0 || plan.RootAvailAfterBytes <= 0 {
		return 0
	}
	currentPoolAlloc := int64(0)
	if snap.IncusPool != nil && snap.IncusPool.AllocatedBytes > 0 {
		currentPoolAlloc = snap.IncusPool.AllocatedBytes
	}
	target := plan.RootAvailAfterBytes + currentPoolAlloc - plan.HostReserveBytes
	if target <= 0 {
		return 0
	}
	if policy.MaxIncusPoolPercent > 0 && policy.MaxIncusPoolPercent < 100 {
		percentTarget := plan.RootTotalAfterBytes * int64(policy.MaxIncusPoolPercent) / 100
		if percentTarget < target {
			target = percentTarget
		}
	}
	target = floorToGiB(target)
	if target < 60*GiB {
		return 0
	}
	return target
}

func floorToGiB(v int64) int64 {
	if v <= 0 {
		return 0
	}
	return (v / GiB) * GiB
}

// IncusTargetSize returns the target size in an Incus-compatible suffix form.
func (p Plan) IncusTargetSize() string {
	if p.IncusTargetBytes <= 0 {
		return ""
	}
	return fmt.Sprintf("%dGiB", int(math.Ceil(float64(p.IncusTargetBytes)/float64(GiB))))
}

// FormatBytes returns a compact binary-size string.
func FormatBytes(bytes int64) string {
	if bytes <= 0 {
		return "0 GiB"
	}
	if bytes%GiB == 0 {
		return fmt.Sprintf("%d GiB", bytes/GiB)
	}
	return fmt.Sprintf("%.1f GiB", float64(bytes)/float64(GiB))
}

func canonicalDevice(runner commandRunner, path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if out, err := runner.Run("readlink", "-f", path); err == nil {
		canon := strings.TrimSpace(out)
		if canon != "" {
			return canon
		}
	}
	return path
}

func parseDF(out string) (total, used, avail int64, ok bool) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 2 {
		return 0, 0, 0, false
	}
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 3 {
		return 0, 0, 0, false
	}
	total = parseInt64(fields[0])
	used = parseInt64(fields[1])
	avail = parseInt64(fields[2])
	return total, used, avail, total > 0
}

type lvsReport struct {
	Report []struct {
		LV []struct {
			Path string `json:"lv_path"`
			VG   string `json:"vg_name"`
			Name string `json:"lv_name"`
			Size string `json:"lv_size"`
		} `json:"lv"`
	} `json:"report"`
}

func parseLVS(out string) []LogicalVolume {
	var parsed lvsReport
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return nil
	}
	var result []LogicalVolume
	for _, report := range parsed.Report {
		for _, lv := range report.LV {
			result = append(result, LogicalVolume{
				Path:      strings.TrimSpace(lv.Path),
				VGName:    strings.TrimSpace(lv.VG),
				Name:      strings.TrimSpace(lv.Name),
				SizeBytes: parseInt64(lv.Size),
			})
		}
	}
	return result
}

type vgsReport struct {
	Report []struct {
		VG []struct {
			Name    string `json:"vg_name"`
			Size    string `json:"vg_size"`
			Free    string `json:"vg_free"`
			LVCount string `json:"lv_count"`
			PVCount string `json:"pv_count"`
		} `json:"vg"`
	} `json:"report"`
}

func parseVGS(out string) []VolumeGroup {
	var parsed vgsReport
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return nil
	}
	var result []VolumeGroup
	for _, report := range parsed.Report {
		for _, vg := range report.VG {
			result = append(result, VolumeGroup{
				Name:      strings.TrimSpace(vg.Name),
				SizeBytes: parseInt64(vg.Size),
				FreeBytes: parseInt64(vg.Free),
				LVCount:   int(parseInt64(vg.LVCount)),
				PVCount:   int(parseInt64(vg.PVCount)),
			})
		}
	}
	return result
}

func parseIncusStorageShow(out string) IncusPool {
	var pool IncusPool
	inConfig := false
	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if trimmed == "config:" {
			inConfig = true
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			inConfig = false
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), "\"'")
		switch {
		case key == "name":
			pool.Name = value
		case key == "driver":
			pool.Driver = value
		case inConfig && key == "source":
			pool.Source = value
		case inConfig && key == "size":
			pool.ConfigSize = value
			pool.ConfigSizeBytes = ParseSizeBytes(value)
		}
	}
	return pool
}

// ParseSizeBytes parses common Incus/LVM size strings.
func ParseSizeBytes(raw string) int64 {
	raw = strings.TrimSpace(strings.ToUpper(raw))
	raw = strings.TrimSuffix(raw, "B")
	multiplier := int64(1)
	switch {
	case strings.HasSuffix(raw, "GIB"):
		multiplier = GiB
		raw = strings.TrimSuffix(raw, "GIB")
	case strings.HasSuffix(raw, "GI"):
		multiplier = GiB
		raw = strings.TrimSuffix(raw, "GI")
	case strings.HasSuffix(raw, "G"):
		multiplier = 1000 * 1000 * 1000
		raw = strings.TrimSuffix(raw, "G")
	case strings.HasSuffix(raw, "MIB"):
		multiplier = 1024 * 1024
		raw = strings.TrimSuffix(raw, "MIB")
	case strings.HasSuffix(raw, "MI"):
		multiplier = 1024 * 1024
		raw = strings.TrimSuffix(raw, "MI")
	case strings.HasSuffix(raw, "M"):
		multiplier = 1000 * 1000
		raw = strings.TrimSuffix(raw, "M")
	case strings.HasSuffix(raw, "KIB"):
		multiplier = 1024
		raw = strings.TrimSuffix(raw, "KIB")
	case strings.HasSuffix(raw, "KI"):
		multiplier = 1024
		raw = strings.TrimSuffix(raw, "KI")
	case strings.HasSuffix(raw, "K"):
		multiplier = 1000
		raw = strings.TrimSuffix(raw, "K")
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0
	}
	return int64(f * float64(multiplier))
}

func parseInt64(raw string) int64 {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimSuffix(raw, "B")
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0
	}
	return int64(f)
}
