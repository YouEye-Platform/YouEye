package cmd

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/incus"
	hoststorage "github.com/youeye-platform/YouEye/spine/internal/storage"
	"github.com/youeye-platform/YouEye/spine/internal/update"
)

const (
	healthExitHealthy     = 0
	healthExitDegraded    = 2
	healthExitUnhealthy   = 3
	healthExitUnsupported = 4
)

type applianceHealthCheck struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	Summary string `json:"summary"`
}

type applianceHealthResult struct {
	SchemaVersion   int                         `json:"schema_version"`
	Profile         string                      `json:"profile"`
	Status          string                      `json:"status"`
	ExitCode        int                         `json:"exit_code"`
	CheckedAt       string                      `json:"checked_at"`
	Runtime         appliance.RuntimeStatus     `json:"runtime"`
	PersistentState *appliance.PersistentStatus `json:"persistent_state,omitempty"`
	Checks          []applianceHealthCheck      `json:"checks"`
}

var applianceHealthProfile string
var applianceHealthJSON bool
var appliancePreparePhase string

var applianceCommand = &cobra.Command{Use: "appliance", Short: "Inspect sealed appliance runtime state"}
var applianceHealthCommand = &cobra.Command{
	Use: "health", Short: "Run read-only structural, recovery, or operational appliance checks",
	RunE: func(cmd *cobra.Command, args []string) error { return runApplianceHealth() },
}
var appliancePrepareCommand = &cobra.Command{
	Use: "prepare", Short: "Prepare persistent appliance mounts during boot",
	RunE: func(cmd *cobra.Command, args []string) error { return runAppliancePrepare() },
}
var applianceCommitHealthySlotCommand = &cobra.Command{
	Use: "commit-healthy-slot", Short: "Commit the health-checked appliance boot", Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error { return runApplianceCommitHealthySlot() },
}

func init() {
	applianceHealthCommand.Flags().StringVar(&applianceHealthProfile, "profile", "operational", "health profile: structural, recovery, or operational")
	applianceHealthCommand.Flags().BoolVar(&applianceHealthJSON, "json", false, "emit stable machine-readable JSON")
	appliancePrepareCommand.Flags().StringVar(&appliancePreparePhase, "phase", "", "required boot phase: state or storage")
	applianceCommand.AddCommand(applianceHealthCommand)
	applianceCommand.AddCommand(appliancePrepareCommand)
	applianceCommand.AddCommand(applianceCommitHealthySlotCommand)
	rootCmd.AddCommand(applianceCommand)
}

func runApplianceCommitHealthySlot() error {
	status, manifest, err := applianceRuntime()
	if err != nil {
		return err
	}
	if status.Kind != appliance.RuntimeApplianceImage || manifest == nil {
		return fmt.Errorf("slot commit is available only on a sealed appliance image")
	}
	cmdline, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return fmt.Errorf("read kernel command line: %w", err)
	}
	state, err := appliance.CommitHealthySlot(appliance.StatePath, *manifest, string(cmdline))
	if err != nil {
		return err
	}
	fmt.Printf("Committed healthy System %s (%s)\n", state.Slots.Current, state.Slots.CurrentImageVersion)
	return nil
}

func runAppliancePrepare() error {
	status, manifest, err := applianceRuntime()
	if err != nil {
		return err
	}
	if status.Kind != appliance.RuntimeApplianceImage || manifest == nil {
		return fmt.Errorf("appliance prepare is available only on a sealed appliance image")
	}
	switch strings.ToLower(strings.TrimSpace(appliancePreparePhase)) {
	case "state":
		contract, err := appliance.DiscoverPartitions()
		if err != nil {
			return fmt.Errorf("discover persistent partitions: %w", err)
		}
		if _, err := appliance.LoadOrInitializeState(*manifest, contract); err != nil {
			return err
		}
		fmt.Println("Appliance state is mounted and compatible")
		return nil
	case "storage":
		decision, err := resolveApplianceStorage(*manifest)
		if err != nil {
			return err
		}
		if err := prepareAppliancePartitionStorage(decision); err != nil {
			return err
		}
		fmt.Println("Appliance persistent storage is mounted and compatible")
		return nil
	default:
		return fmt.Errorf("phase must be state or storage")
	}
}

func runApplianceHealth() error {
	profile, err := normalizeApplianceHealthProfile(applianceHealthProfile)
	if err != nil {
		return err
	}
	result := collectApplianceHealth(profile)
	if applianceHealthJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(result); err != nil {
			return err
		}
	} else {
		fmt.Printf("Appliance health (%s): %s\n", result.Profile, result.Status)
		for _, check := range result.Checks {
			fmt.Printf("  %-5s %-28s %s\n", strings.ToUpper(check.Status), check.Name, check.Summary)
		}
	}
	if result.ExitCode != 0 {
		message := "appliance health is " + result.Status
		if applianceHealthJSON {
			message = ""
		}
		return &ExitError{Code: result.ExitCode, Message: message}
	}
	return nil
}

func normalizeApplianceHealthProfile(raw string) (string, error) {
	profile := strings.ToLower(strings.TrimSpace(raw))
	switch profile {
	case "structural", "recovery", "operational":
		return profile, nil
	default:
		return "", fmt.Errorf("profile must be structural, recovery, or operational")
	}
}

func collectApplianceHealth(profile string) applianceHealthResult {
	status, manifest, detectErr := appliance.Detect()
	result := applianceHealthResult{SchemaVersion: 1, Profile: profile, CheckedAt: time.Now().UTC().Format(time.RFC3339), Runtime: status}
	add := func(name, status, summary string) {
		result.Checks = append(result.Checks, applianceHealthCheck{Name: name, Status: status, Summary: summary})
	}
	if status.Kind != appliance.RuntimeApplianceImage {
		add("runtime identity", "fail", "this command applies only to sealed appliance images")
		result.Status = "unsupported"
		result.ExitCode = healthExitUnsupported
		return result
	}
	if detectErr != nil || manifest == nil {
		add("sealed manifest", "fail", "the sealed appliance marker is invalid; boot recovery")
		result.Status = "unhealthy"
		result.ExitCode = healthExitUnhealthy
		return result
	}
	add("sealed manifest", "pass", "schema and required compatibility fields are valid")
	if info, err := os.Stat(appliance.ManifestPath); err != nil || info.Mode().Perm()&0222 != 0 {
		add("manifest immutability", "fail", "the sealed marker is missing or writable")
	} else if out, err := exec.Command("findmnt", "-n", "-o", "OPTIONS", "--target", appliance.ManifestPath).CombinedOutput(); err != nil || !mountOptionsContain(string(out), "ro") {
		add("read-only image", "fail", "the sealed marker is not on a read-only filesystem")
	} else {
		add("read-only image", "pass", "the sealed marker is on a read-only filesystem")
	}

	contract, partErr := appliance.DiscoverPartitions()
	if partErr != nil {
		add("persistent partitions", "fail", "YE-STATE/YE-DATA partition contract is invalid")
	} else {
		add("persistent partitions", "pass", "distinct YE-STATE and YE-DATA partitions are present on the installation drive")
		state, err := appliance.LoadState(appliance.StatePath)
		if err != nil || appliance.ValidateStateContract(*manifest, state, contract) != nil {
			add("persistent state", "fail", "state schema, layout, or recorded disk identity requires recovery")
		} else if profile == "recovery" {
			compat := appliance.CheckCompatibility(*manifest, state.SchemaVersion, state.DataSchemaVersion)
			result.PersistentState = &appliance.PersistentStatus{
				Available: true, Lifecycle: state.Lifecycle,
				StateSchemaVersion: state.SchemaVersion, DataSchemaVersion: state.DataSchemaVersion,
				DiskLayoutVersion: state.DiskLayoutVersion, Compatibility: compat,
				Slots: state.Slots, TransactionStage: state.Transaction.Stage,
				TargetImageVersion: state.Transaction.TargetImageVersion,
				RecoveryVersion:    state.RecoveryVersion,
			}
			add("persistent state", "pass", "State schema, layout, disk identity, and recorded Data schema are compatible")
		} else {
			persistent, inspectErr := appliance.InspectPersistentStatus(*manifest)
			result.PersistentState = &persistent
			if inspectErr != nil {
				add("persistent state", "fail", "state/data schema compatibility requires recovery")
			} else {
				add("persistent state", "pass", "state and data schemas are compatible with this image")
			}
		}
		if profile != "recovery" {
			if err := hoststorage.ValidateAppliancePartitionPool("/dev/disk/by-partuuid/"+contract.DataPartUUID, contract.DataPartUUID, manifest.DiskLayoutVersion, manifest.ZFSFeatureProfile); err != nil {
				add("storage topology", "fail", "the ZFS pool is not bound exclusively to the recorded YE-DATA partition")
			} else {
				add("storage topology", "pass", "the ZFS pool is bound exclusively to YE-DATA")
			}
		} else {
			cmdline, err := os.ReadFile("/proc/cmdline")
			if err != nil || !strings.Contains(string(cmdline), "root=PARTLABEL=YE-RECOVERY") || !strings.Contains(string(cmdline), "systemd.unit=youeye-recovery.target") {
				add("Recovery boot", "fail", "the active kernel command line does not select the isolated Recovery target")
			} else {
				add("Recovery boot", "pass", "the isolated YE-RECOVERY image and target are active")
			}
			out, mountErr := exec.Command("findmnt", "-n", "-o", "SOURCE", "--target", appliance.StateMountpoint).CombinedOutput()
			mounted, mountedErr := filepath.EvalSymlinks(strings.TrimSpace(string(out)))
			expected, expectedErr := filepath.EvalSymlinks(contract.StateDevice)
			mountOptions, optionsErr := exec.Command("findmnt", "-n", "-o", "OPTIONS", "--target", appliance.StateMountpoint).CombinedOutput()
			if mountErr != nil || mountedErr != nil || expectedErr != nil || mounted != expected || optionsErr != nil || !mountOptionsContain(string(mountOptions), "rw") {
				add("State mount", "fail", "YE-STATE is not mounted from the discovered system disk")
			} else {
				add("State mount", "pass", "YE-STATE is mounted read-write from the discovered system disk")
			}
			out, err = exec.Command("systemctl", "is-active", "youeye-recovery.target").CombinedOutput()
			if err != nil || strings.TrimSpace(string(out)) != "active" {
				add("Recovery target", "fail", "youeye-recovery.target is not active")
			} else {
				add("Recovery target", "pass", "youeye-recovery.target is active")
			}
			activeNormal := []string{}
			for _, unit := range []string{"incus.service", "youeye.service"} {
				out, _ := exec.Command("systemctl", "is-active", unit).CombinedOutput()
				if strings.TrimSpace(string(out)) == "active" {
					activeNormal = append(activeNormal, unit)
				}
			}
			if len(activeNormal) != 0 {
				add("normal runtime isolation", "fail", "normal services are active in Recovery: "+strings.Join(activeNormal, ", "))
			} else {
				add("normal runtime isolation", "pass", "Incus and Spine remain inactive in offline Recovery")
			}
		}
	}
	checkMount := func(name, target, source string) {
		out, err := exec.Command("findmnt", "-n", "-o", "SOURCE", "--target", target).CombinedOutput()
		if err != nil || strings.TrimSpace(string(out)) != source {
			add(name, "fail", fmt.Sprintf("%s must be mounted from %s", target, source))
		} else {
			add(name, "pass", fmt.Sprintf("%s is mounted from %s", target, source))
		}
	}
	if profile != "recovery" {
		checkMount("data mount", hoststorage.DataMountpoint, hoststorage.DataDataset)
		checkMount("Incus state mount", hoststorage.IncusStateMountpoint, hoststorage.IncusStateDataset)
	}
	if err := incus.VerifyBakedPrerequisites(*manifest); err != nil {
		add("baked prerequisites", "fail", "one or more baked binaries, units, policies, or versions is incompatible")
	} else {
		add("baked prerequisites", "pass", "baked runtime prerequisites are present and compatible")
	}

	if profile == "operational" {
		for _, unit := range []string{"incus.service", "youeye.service"} {
			out, err := exec.Command("systemctl", "is-active", unit).CombinedOutput()
			if err != nil || strings.TrimSpace(string(out)) != "active" {
				add(unit, "fail", "service is not active")
			} else {
				add(unit, "pass", "service is active")
			}
		}
		out, err := exec.Command("zpool", "get", "-H", "-o", "value", "health", hoststorage.PoolName).CombinedOutput()
		if err != nil || strings.TrimSpace(string(out)) != "ONLINE" {
			add("ZFS health", "fail", "persistent pool is not ONLINE")
		} else {
			add("ZFS health", "pass", "persistent pool is ONLINE")
		}
		for _, container := range []string{"youeye-control", "youeye-postgres", "youeye-caddy", "youeye-pihole", "youeye-ui"} {
			out, err := exec.Command("incus", "list", container, "--format", "csv", "-c", "s").CombinedOutput()
			if err != nil || strings.TrimSpace(strings.ToUpper(string(out))) != "RUNNING" {
				add(container, "fail", "required container is not running")
			} else {
				add(container, "pass", "required container is running")
			}
		}
		if _, err := os.Stat("/var/lib/youeye-state/first-deploy/complete"); errors.Is(err, os.ErrNotExist) {
			addFirstDeployReleaseSetChecks(*manifest, add)
		}
		if _, err := os.Stat(GetConfig().API.SocketPath); err != nil {
			add("Spine API socket", "fail", "API socket is unavailable")
		} else {
			add("Spine API socket", "pass", "API socket is present")
		}
		if result.PersistentState != nil && result.PersistentState.TransactionStage == "trial" {
			add("image transaction", "pass", "the counted candidate trial is ready for explicit blessing")
		} else if result.PersistentState != nil && result.PersistentState.TransactionStage != "" {
			add("image transaction", "warn", "an image transaction is incomplete")
		} else {
			add("image transaction", "pass", "no incomplete image transaction is recorded")
		}
	}
	result.Status, result.ExitCode = aggregateApplianceHealth(result.Checks)
	return result
}

type installedReleaseIdentity struct {
	Version        string
	Tag            string
	Branch         string
	ArtifactSHA256 string
}

type firstDeployReleaseComponent struct {
	name      string
	container string
	appDir    string
	expected  appliance.ComponentRelease
	key       string
}

func firstDeployReleaseComponents(releaseSet appliance.ReleaseSet) []firstDeployReleaseComponent {
	return []firstDeployReleaseComponent{
		{name: "Server interface", container: "youeye-control", appDir: "/opt/app", expected: releaseSet.ControlPanel, key: "control"},
		{name: "YouEye interface", container: "youeye-ui", appDir: "/opt/youeye-ui", expected: releaseSet.UI, key: "ui"},
	}
}

func validateInstalledReleaseIdentity(name string, expected appliance.ComponentRelease, expectedBranch string, installed installedReleaseIdentity) error {
	if strings.TrimSpace(installed.Version) != expected.Version {
		return fmt.Errorf("%s version %q does not match selected bundle version %q", name, installed.Version, expected.Version)
	}
	if expected.Tag != "" && installed.Tag != expected.Tag {
		return fmt.Errorf("%s tag %q does not match selected bundle tag %q", name, installed.Tag, expected.Tag)
	}
	if installed.Branch != expectedBranch {
		return fmt.Errorf("%s branch %q does not match selected bundle branch %q", name, installed.Branch, expectedBranch)
	}
	if strings.ToLower(strings.TrimSpace(installed.ArtifactSHA256)) != expected.ArtifactSHA256 {
		return fmt.Errorf("%s artifact digest does not match the selected signed bundle", name)
	}
	return nil
}

func addFirstDeployReleaseSetChecks(manifest appliance.Manifest, add func(string, string, string)) {
	if manifest.ReleaseSet == nil {
		add("first-deploy release identity", "fail", "the sealed System has no exact signed release set")
		return
	}
	releaseSet := *manifest.ReleaseSet
	executable, err := os.Executable()
	if err != nil {
		add("System core provenance", "fail", "the running System core identity is unavailable")
	} else if digest, digestErr := fileSHA256(executable); digestErr != nil || Version != releaseSet.Spine.Version || digest != releaseSet.Spine.ArtifactSHA256 {
		add("System core provenance", "fail", "the running System core does not match the selected signed bundle")
	} else {
		add("System core provenance", "pass", "the running System core version and digest match the selected signed bundle")
	}
	for _, component := range firstDeployReleaseComponents(releaseSet) {
		version := containerPackageVersion(component.container, component.appDir)
		provenance, ok := update.GetProvenance(component.key)
		installed := installedReleaseIdentity{Version: version}
		if ok {
			installed.Tag = provenance.Tag
			installed.Branch = provenance.Branch
			installed.ArtifactSHA256 = provenance.ArtifactSHA256
		}
		if !ok {
			add(component.name+" provenance", "fail", "installed release provenance is missing")
		} else if err := validateInstalledReleaseIdentity(component.name, component.expected, releaseSet.Branch, installed); err != nil {
			add(component.name+" provenance", "fail", err.Error())
		} else {
			add(component.name+" provenance", "pass", "the installed version, tag, branch, and digest match the selected signed bundle")
		}
	}
}

func containerPackageVersion(containerName, appDir string) string {
	raw, err := exec.Command("incus", "exec", containerName, "--", "cat", filepath.Join(appDir, "package.json")).Output()
	if err != nil || len(raw) > 1<<20 {
		return ""
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &manifest) != nil {
		return ""
	}
	return strings.TrimSpace(manifest.Version)
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func aggregateApplianceHealth(checks []applianceHealthCheck) (string, int) {
	warn, fail := false, false
	for _, c := range checks {
		if c.Status == "fail" {
			fail = true
		}
		if c.Status == "warn" {
			warn = true
		}
	}
	if fail {
		return "unhealthy", healthExitUnhealthy
	}
	if warn {
		return "degraded", healthExitDegraded
	}
	return "healthy", healthExitHealthy
}

func mountOptionsContain(options, want string) bool {
	for _, option := range strings.Split(strings.TrimSpace(options), ",") {
		if strings.TrimSpace(option) == want {
			return true
		}
	}
	return false
}
