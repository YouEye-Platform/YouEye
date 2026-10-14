package systemupdate

import (
	"context"
	"fmt"
	"os"
	"syscall"
)

type CorePowerRestore struct {
	Name  string `json:"name"`
	UUID  string `json:"uuid"`
	State string `json:"state"`
}

// PrepareHealth brings back only originally running platform/app containers.
// Admission, ingress and autostart holds remain until accepted completion.
// Each start has a durable intent; unknown starts are observed, never retried.
func (p NativeCoreCheckpoint) PrepareHealth(ctx context.Context, request string, recovery, observeOnly bool) error {
	j, err := (CoreManager{Root: p.Root}).Read()
	if err != nil || j.RequestID != request {
		return fmt.Errorf("exact core health request required")
	}
	steps, name, phase := j.Steps, "authenticated-health", "applying"
	if recovery {
		steps, name, phase = j.RecoverySteps, "recovery-health", "recovering"
	}
	active := false
	for _, step := range steps {
		if step.Name == name && step.State == "started" {
			active = true
		}
	}
	if j.Phase != phase || !active {
		return fmt.Errorf("active core health step required before restoring power")
	}
	if j.NoOp && !recovery {
		return nil
	}
	if err = p.verifyReservation(j); err != nil {
		return err
	}
	machine, err := p.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return fmt.Errorf("health preparation machine changed")
	}
	lock, err := os.OpenFile(p.recordPath(request)+".power.lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("native power preparation is already owned")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	record, err := p.Read(j)
	if err != nil {
		return err
	}
	valid := record.Phase == "captured"
	if recovery {
		valid = record.Phase == "paired-restored" || record.Phase == "aborted-unapplied"
	}
	if !valid || record.CompletionState != "" {
		return fmt.Errorf("paired checkpoint outcome does not admit health startup")
	}
	if err = p.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return err
	}
	_, digest, err := p.installedOwners()
	if err != nil || digest != record.Inventory.AppInventorySHA256 {
		return fmt.Errorf("app ownership changed during native health preparation")
	}
	if err = p.requireProviderSettled(ctx); err != nil {
		return err
	}
	starts := &record.PowerRestores
	if recovery {
		starts = &record.RecoveryPowerRestores
	}
	seen := map[string]bool{}
	for _, start := range *starts {
		found := false
		for _, c := range record.Inventory.Containers {
			if c.Name == start.Name && c.UUID == start.UUID && c.Running && c.Name != "youeye-control" && c.Name != "youeye-ui" && c.Name != "youeye-postgres" {
				found = true
			}
		}
		if !found || seen[start.Name] || (start.State != "requested" && start.State != "running") {
			return fmt.Errorf("power restoration receipt differs from frozen inventory")
		}
		seen[start.Name] = true
	}
	for _, c := range record.Inventory.Containers {
		actual, err := p.completionContainer(ctx, c)
		if err != nil {
			return err
		}
		if c.Name == "youeye-postgres" || c.Name == "youeye-control" || c.Name == "youeye-ui" {
			if actual.Status != "Running" {
				return fmt.Errorf("core services must recover before platform health")
			}
			if c.Name != "youeye-postgres" && (actual.Config["user.youeye.core-request"] != j.RequestID || actual.Config["boot.autostart"] != "false") {
				return fmt.Errorf("core service power ownership changed before health")
			}
			continue
		}
		if actual.Config["user.youeye.core-request"] != j.RequestID || actual.Config["boot.autostart"] != "false" {
			return fmt.Errorf("original platform power hold changed")
		}
		if !c.Running {
			if actual.Status != "Stopped" {
				return fmt.Errorf("originally stopped application started outside this operation")
			}
			continue
		}
		index := -1
		for i, start := range *starts {
			if start.Name == c.Name {
				index = i
			}
		}
		if index < 0 {
			if observeOnly || actual.Status != "Stopped" {
				return fmt.Errorf("platform start has no owned intent")
			}
			*starts = append(*starts, CorePowerRestore{Name: c.Name, UUID: c.UUID, State: "requested"})
			index = len(*starts) - 1
			if err = p.saveRecord(record); err != nil {
				return err
			}
			_, _ = p.capture(ctx, "incus", "start", c.Name)
			actual, err = p.completionContainer(ctx, c)
			if err != nil {
				return err
			}
		}
		if actual.Status != "Running" || actual.Config["user.youeye.core-request"] != j.RequestID || actual.Config["boot.autostart"] != "false" {
			return fmt.Errorf("platform start remains uncertain; native replay refused")
		}
		(*starts)[index].State = "running"
		if err = p.saveRecord(record); err != nil {
			return err
		}
	}
	return p.requireProviderSettled(ctx)
}
