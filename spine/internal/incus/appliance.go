package incus

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/storage"
	"github.com/youeye-platform/YouEye/spine/internal/version"
)

var numericVersion = regexp.MustCompile(`[0-9]+(?:\.[0-9]+)+`)

var requiredApplianceBinaries = []string{"incus", "zfs", "zpool", "pamtester"}
var requiredApplianceFiles = []string{
	"/dev/zfs",
	"/usr/lib/systemd/system/youeye.service",
	"/usr/lib/systemd/system/youeye-appliance-state.service",
	"/usr/lib/systemd/system/youeye-appliance-storage.service",
	"/usr/lib/systemd/system/youeye-appliance-ssh-keys.service",
	"/usr/lib/systemd/zram-generator.conf",
}

type prerequisiteProbe interface {
	LookPath(string) (string, error)
	Stat(string) error
	Run(string, ...string) (string, error)
}

type osPrerequisiteProbe struct{}

func (osPrerequisiteProbe) LookPath(name string) (string, error) { return exec.LookPath(name) }
func (osPrerequisiteProbe) Stat(path string) error               { _, err := os.Stat(path); return err }
func (osPrerequisiteProbe) Run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return string(out), err
}

// VerifyBakedPrerequisites reports every missing/incompatible image
// prerequisite in one actionable error. It performs no installation or repair.
func VerifyBakedPrerequisites(manifest appliance.Manifest) error {
	return verifyBakedPrerequisites(manifest, osPrerequisiteProbe{})
}

func verifyBakedPrerequisites(manifest appliance.Manifest, probe prerequisiteProbe) error {
	var problems []string
	for _, binary := range requiredApplianceBinaries {
		if _, err := probe.LookPath(binary); err != nil {
			problems = append(problems, fmt.Sprintf("required baked binary %s is missing", binary))
		}
	}
	for _, path := range requiredApplianceFiles {
		if err := probe.Stat(path); err != nil {
			problems = append(problems, fmt.Sprintf("required baked file %s is missing", path))
		}
	}
	profilePath := "/usr/share/zfs/compatibility.d/" + manifest.ZFSFeatureProfile
	if err := probe.Stat(profilePath); err != nil {
		problems = append(problems, fmt.Sprintf("required ZFS feature profile %s is missing", manifest.ZFSFeatureProfile))
	}
	checks := []struct {
		name, command string
		args          []string
		requirement   string
	}{
		{name: "kernel", command: "uname", args: []string{"-r"}, requirement: manifest.KernelCompatibility},
		{name: "ZFS", command: "zfs", args: []string{"version"}, requirement: manifest.ZFSCompatibility},
		{name: "Incus", command: "incus", args: []string{"--version"}, requirement: manifest.IncusCompatibility},
	}
	for _, check := range checks {
		out, err := probe.Run(check.command, check.args...)
		if err != nil {
			problems = append(problems, fmt.Sprintf("cannot read baked %s version", check.name))
			continue
		}
		if err := versionSatisfies(out, check.requirement); err != nil {
			problems = append(problems, fmt.Sprintf("%s %v", check.name, err))
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("appliance image prerequisites are incomplete; boot recovery or install a compatible image:\n- %s", strings.Join(problems, "\n- "))
	}
	return nil
}

func versionSatisfies(actualOutput, requirement string) error {
	actual := numericVersion.FindString(actualOutput)
	required := numericVersion.FindString(requirement)
	if actual == "" || required == "" {
		return fmt.Errorf("version %q cannot be evaluated against %q", strings.TrimSpace(actualOutput), requirement)
	}
	if strings.HasPrefix(strings.TrimSpace(requirement), ">=") {
		if version.CompareVersions(actual, required) < 0 {
			return fmt.Errorf("version %s does not satisfy %s", actual, requirement)
		}
		return nil
	}
	if version.CompareVersions(actual, required) != 0 {
		return fmt.Errorf("version %s does not satisfy %s", actual, requirement)
	}
	return nil
}

// ReconcileAppliance initializes or reuses Incus strictly from the baked
// image and persistent appliance datasets. It contains no apt, repository,
// package, unit-file, or pool-feature mutation path.
func ReconcileAppliance(opts InstallOptions) error {
	if opts.Decision.Kind != storage.DecisionAdoptAppliancePartition {
		return fmt.Errorf("appliance Incus reconciliation requires an appliance-partition storage decision")
	}
	if err := storage.EnsureAppliancePoolLayout(); err != nil {
		return err
	}
	if out, err := exec.Command("systemctl", "start", "incus").CombinedOutput(); err != nil {
		return fmt.Errorf("start baked Incus service: %w: %s", err, strings.TrimSpace(string(out)))
	}
	out, err := exec.Command("incus", "storage", "list", "--format", "csv").Output()
	if err == nil && len(strings.TrimSpace(string(out))) > 0 {
		if err := VerifyStorageMatchesDecision(opts.Decision); err != nil {
			return err
		}
	} else if err := initializeWithPreseed(true, opts); err != nil {
		return err
	}
	StorageDriver = "zfs"
	if err := ensureIncusBridgeReady(); err != nil {
		return err
	}
	if err := EnsureSystemBaseImage(); err != nil {
		return err
	}
	configureOCIRemote()
	if out, err := exec.Command("incus", "version").CombinedOutput(); err != nil {
		return fmt.Errorf("verify baked Incus: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
