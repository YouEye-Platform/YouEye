package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func (r CoreSystemdRunner) AuthorizeLiveFence(ctx context.Context, j CoreJournal, s CoreStep) error {
	launch, err := r.read(j, s)
	if err != nil {
		return err
	}
	boot, err := r.boot()
	if err != nil || boot != launch.BootID {
		return fmt.Errorf("live native action is not on the recorded boot")
	}
	unit, err := r.observeUnit(ctx, launch)
	if err != nil {
		return err
	}
	pid, pidErr := strconv.Atoi(unit["MainPID"])
	if unit["LoadState"] != "loaded" || (unit["ActiveState"] != "active" && unit["ActiveState"] != "activating") || pidErr != nil || pid <= 1 || len(unit["InvocationID"]) != 32 || !isLowerHex(unit["InvocationID"]) {
		return fmt.Errorf("live action lacks exact owned service evidence")
	}
	result, err := r.readResult(j, s, launch)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && result.InvocationID != unit["InvocationID"] {
		return fmt.Errorf("live action invocation changed")
	}
	return nil
}

// SettleApplyChildren is only the local-process part of recovery fencing. It
// excludes the original executor with its kernel lock, stops only exact owned
// systemd units, and verifies their entire cgroups. Incus operations and SQL
// writers must separately settle before the recovery-fence action can pass.
func (r CoreSystemdRunner) SettleApplyChildren(ctx context.Context, request string) (string, error) {
	j, err := (CoreManager{Root: r.Root}).Read()
	if err != nil || j.RequestID != request || j.Phase != "recovering" {
		return "", fmt.Errorf("active native recovery required for child settlement")
	}
	active := false
	for _, step := range j.RecoverySteps {
		if step.Name == "recovery-fence" && step.State == "started" {
			active = true
		}
	}
	if !active {
		return "", fmt.Errorf("coordinator has not requested recovery fence")
	}
	settled := []string{}
	for _, step := range j.Steps {
		if step.State == "pending" {
			continue
		}
		if err = r.settleApplyChild(ctx, j, step); err != nil {
			return "", err
		}
		settled = append(settled, r.unit(j, step))
	}
	raw, err := json.Marshal(struct {
		Scope string   `json:"scope"`
		Units []string `json:"units"`
	}{"owned-native-children-only", settled})
	return string(raw), err
}

// SettlePreparationChildren runs only while the coordinator's exclusive cancel
// intent prevents new launches. Preparation has no Incus/SQL mutation authority.
func (r CoreSystemdRunner) SettlePreparationChildren(ctx context.Context, request string) error {
	j, err := (CoreManager{Root: r.Root}).Read()
	if err != nil || j.RequestID != request || j.Phase != "cancelling" || j.ActivationRequested || len(j.RecoverySteps) > 0 {
		return fmt.Errorf("exact unactivated cancellation required")
	}
	for _, step := range j.Steps {
		if step.State != "pending" && step.Name != "verify-members" && step.Name != "stage-host" {
			return fmt.Errorf("activation effects require paired recovery")
		}
	}
	for _, step := range j.Steps {
		if step.State == "pending" {
			continue
		}
		if err = r.settleApplyChild(ctx, j, step); err != nil {
			return err
		}
	}
	return nil
}

func (r CoreSystemdRunner) settleApplyChild(ctx context.Context, j CoreJournal, s CoreStep) error {
	// Hold the same lease used by NativeCoreExecutor through its launch. A live
	// caller cannot race a missing runner receipt into a new background action.
	unlock, err := (NativeCoreExecutor{Root: r.Root}).lockAction(s)
	if err != nil {
		return err
	}
	defer unlock()
	expected, err := r.expected(j, s)
	if err != nil {
		return err
	}
	launch, readErr := r.read(j, s)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	if errors.Is(readErr, os.ErrNotExist) {
		launch = expected
	}
	unit, err := r.observeUnit(ctx, launch)
	if err != nil {
		return err
	}
	if unit["LoadState"] == "not-found" {
		// Absence of a PID is insufficient. The original executor lease is held,
		// the service manager reports this exact unit absent, and its complete
		// cgroup must be absent/empty as well. Provider settlement follows later.
		return r.requireEmptyCgroup(launch.Unit, true)
	}
	if readErr != nil || launch.BootID != expected.BootID {
		return fmt.Errorf("unrecorded or different-boot native unit prevents settlement")
	}
	result, resultErr := r.readResult(j, s, launch)
	if resultErr != nil && !errors.Is(resultErr, os.ErrNotExist) {
		return resultErr
	}
	if resultErr == nil && unit["InvocationID"] != "" && unit["InvocationID"] != result.InvocationID {
		return fmt.Errorf("native child invocation changed before settlement")
	}
	if group := unit["ControlGroup"]; group != "" && group != "/system.slice/"+launch.Unit {
		return fmt.Errorf("native child has an unexpected control group")
	}
	if unit["ActiveState"] != "inactive" && unit["ActiveState"] != "failed" {
		// Do not trust the stop acknowledgement. Reconcile service state and
		// cgroup even when the transport loses that acknowledgement.
		_, _ = r.capture(ctx, "systemctl", "stop", launch.Unit)
		unit, err = r.observeUnit(ctx, launch)
		if err != nil {
			return err
		}
	}
	if unit["LoadState"] != "not-found" && ((unit["ActiveState"] != "inactive" && unit["ActiveState"] != "failed") || unit["MainPID"] != "0") {
		return fmt.Errorf("native action still has an unsettled service")
	}
	return r.requireEmptyCgroup(launch.Unit, true)
}

func (r CoreSystemdRunner) requireEmptyCgroup(unit string, allowAbsent bool) error {
	root := r.CgroupRoot
	if root == "" {
		root = "/sys/fs/cgroup"
	}
	if !filepath.IsAbs(root) || !strings.HasPrefix(unit, "youeye-core-") || strings.ContainsAny(unit, "/\\") {
		return fmt.Errorf("invalid owned cgroup identity")
	}
	file, err := os.OpenFile(filepath.Join(root, "system.slice", unit, "cgroup.events"), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if allowAbsent && errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("native cgroup settlement unavailable")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(raw) > 4096 {
		return fmt.Errorf("invalid native cgroup evidence")
	}
	populated := ""
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return fmt.Errorf("invalid native cgroup event")
		}
		if fields[0] == "populated" {
			if populated != "" {
				return fmt.Errorf("duplicate native cgroup event")
			}
			populated = fields[1]
		}
	}
	if populated != "0" {
		return fmt.Errorf("owned native cgroup has unsettled descendants")
	}
	return nil
}
