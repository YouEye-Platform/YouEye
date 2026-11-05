package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type NativeCoreCheckpointRecord struct {
	DNSBindings           []CoreDNSBinding         `json:"dns_bindings,omitempty"`
	PowerRestores         []CorePowerRestore       `json:"power_restores,omitempty"`
	RecoveryPowerRestores []CorePowerRestore       `json:"recovery_power_restores,omitempty"`
	CompletionState       string                   `json:"completion_state,omitempty"`
	FileRestores          []CoreFileRestore        `json:"file_restores,omitempty"`
	Schema                string                   `json:"schema"`
	Inventory             CoreCheckpointInventory  `json:"inventory"`
	Phase                 string                   `json:"phase"`
	Databases             []CoreCheckpointDatabase `json:"databases,omitempty"`
	Roots                 []CoreRootCheckpoint     `json:"roots,omitempty"`
	FileSnapshots         []CoreFilesCheckpoint    `json:"file_snapshots,omitempty"`
}

func (p NativeCoreCheckpoint) recordPath(requestID string) string {
	return filepath.Join(p.Root, "checkpoints", fmt.Sprintf("%x", sha256.Sum256([]byte(requestID))), "checkpoint.json")
}

func (p NativeCoreCheckpoint) saveRecord(record NativeCoreCheckpointRecord) error {
	if !filepath.IsAbs(p.Root) || !coreRequestPattern.MatchString(record.Inventory.RequestID) {
		return fmt.Errorf("protected checkpoint identity required")
	}
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return atomicWrite(p.recordPath(record.Inventory.RequestID), raw, 0600)
}

func (p NativeCoreCheckpoint) Read(j CoreJournal) (NativeCoreCheckpointRecord, error) {
	var record NativeCoreCheckpointRecord
	raw, err := ReadCoreState(p.recordPath(j.RequestID), 4<<20)
	if err != nil {
		return record, err
	}
	if json.Unmarshal(raw, &record) != nil || record.Schema != "youeye.core-checkpoint.v1" || record.Inventory.RequestID != j.RequestID || record.Inventory.ManifestSHA256 != j.ManifestSHA256 || record.Inventory.Machine != j.Previous.Machine {
		return record, fmt.Errorf("retained checkpoint identity differs from core request")
	}
	if !coreContainerName.MatchString(record.Inventory.Bridge) || len(record.Inventory.IngressPorts) == 0 {
		return record, fmt.Errorf("retained checkpoint ingress scope is invalid")
	}
	return record, nil
}

// Quiesce persists the original power intent before touching it. Repeating this
// method only reconciles idempotent holds/stops on the same UUIDs; it never runs
// migrations, restores a database or infers that a missing process is settled.
func (p NativeCoreCheckpoint) Quiesce(ctx context.Context, j CoreJournal) (NativeCoreCheckpointRecord, error) {
	current, err := (CoreManager{Root: p.Root}).Read()
	if err != nil || current.RequestID != j.RequestID || current.ManifestSHA256 != j.ManifestSHA256 || current.Phase != "applying" || (current.RestartRequired && !current.ActivationRequested) {
		return NativeCoreCheckpointRecord{}, fmt.Errorf("native checkpoint requires the coordinator's active activation step")
	}
	j = current
	checkpointStarted := false
	for _, s := range current.Steps {
		if s.Name == "checkpoint" && s.State == "started" {
			checkpointStarted = true
		}
	}
	if !checkpointStarted {
		return NativeCoreCheckpointRecord{}, fmt.Errorf("coordinator checkpoint action is not active")
	}
	record, err := p.Read(j)
	if errors.Is(err, os.ErrNotExist) {
		inventory, err := p.Inspect(ctx, j)
		if err != nil {
			return record, err
		}
		record = NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Inventory: inventory, Phase: "prepared"}
		if err := p.saveRecord(record); err != nil {
			return record, err
		}
	} else if err != nil {
		return record, err
	}
	if record.Phase != "prepared" && record.Phase != "quiescing" && record.Phase != "quiesced" {
		return record, fmt.Errorf("checkpoint has advanced beyond writer closure")
	}
	if err := p.verifyReservation(j); err != nil {
		return record, err
	}
	machine, err := p.observeMachine()
	if err != nil || machine != record.Inventory.Machine {
		return record, fmt.Errorf("native machine changed before writer closure")
	}
	if err := p.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return record, err
	}
	_, inventoryDigest, err := p.installedOwners()
	if err != nil || inventoryDigest != record.Inventory.AppInventorySHA256 {
		return record, fmt.Errorf("application ownership changed before checkpoint")
	}
	record.Phase = "quiescing"
	if err := p.saveRecord(record); err != nil {
		return record, err
	}
	if err := p.closeCheckpointWriters(ctx, j, record.Inventory); err != nil {
		return record, err
	}
	databases, err := p.InspectDatabases(ctx)
	if err != nil {
		return record, err
	}
	record.Databases, record.Phase = databases, "quiesced"
	return record, p.saveRecord(record)
}

func (p NativeCoreCheckpoint) verifyReservation(j CoreJournal) error {
	r, err := (CoreLifecycleBarrier{Root: filepath.Join(p.DataRoot, "state", "app-updates")}).Read()
	if err != nil || r.RequestID != j.RequestID || r.ManifestSHA256 != j.ManifestSHA256 {
		return fmt.Errorf("core checkpoint no longer owns lifecycle reservation")
	}
	return nil
}

func (p NativeCoreCheckpoint) containerRunning(ctx context.Context, c CoreCheckpointContainer) (bool, error) {
	raw, err := p.capture(ctx, "incus", "query", "/1.0/instances/"+c.Name)
	if err != nil {
		return false, err
	}
	var actual struct {
		Config map[string]string `json:"config"`
		Status string            `json:"status"`
	}
	if json.Unmarshal(raw, &actual) != nil || actual.Config["volatile.uuid"] != c.UUID || (actual.Status != "Running" && actual.Status != "Stopped") {
		return false, fmt.Errorf("core container identity or state changed")
	}
	return actual.Status == "Running", nil
}

func (p NativeCoreCheckpoint) verifyContainerIdentities(ctx context.Context, inventory CoreCheckpointInventory, stopped bool) error {
	raw, err := p.capture(ctx, "incus", "list", "--format=json")
	if err != nil {
		return err
	}
	var actual []struct {
		Name            string                       `json:"name"`
		Status          string                       `json:"status"`
		Config          map[string]string            `json:"config"`
		ExpandedDevices map[string]map[string]string `json:"expanded_devices"`
	}
	if json.Unmarshal(raw, &actual) != nil || len(actual) != len(inventory.Containers) {
		return fmt.Errorf("native writer inventory changed")
	}
	expected := map[string]CoreCheckpointContainer{}
	for _, c := range inventory.Containers {
		expected[c.Name] = c
	}
	seen := map[string]bool{}
	for _, c := range actual {
		old, ok := expected[c.Name]
		if !ok || seen[c.Name] || c.Config["volatile.uuid"] != old.UUID {
			return fmt.Errorf("native container identity changed")
		}
		seen[c.Name] = true
		if old.RootPool != "" {
			pool, err := coreRootPool(c.ExpandedDevices)
			if err != nil || pool != old.RootPool {
				return fmt.Errorf("native root storage identity changed")
			}
		}
		owner := c.Config["user.youeye.core-request"]
		if owner != "" && owner != inventory.RequestID {
			return fmt.Errorf("native container acquired foreign maintenance")
		}
		if c.Status != "Running" && c.Status != "Stopped" {
			return fmt.Errorf("native container state is unsettled")
		}
		if c.Name == "youeye-postgres" {
			if c.Status != "Running" {
				return fmt.Errorf("shared PostgreSQL is not running")
			}
			continue
		}
		if stopped && (c.Status != "Stopped" || c.Config["boot.autostart"] != "false" || owner != inventory.RequestID) {
			return fmt.Errorf("native writer closure is incomplete")
		}
	}
	return nil
}

func (p NativeCoreCheckpoint) CloseIngress(ctx context.Context, inventory CoreCheckpointInventory) error {
	if !coreRequestPattern.MatchString(inventory.RequestID) || !validSHA256(inventory.ManifestSHA256) || !coreContainerName.MatchString(inventory.Bridge) || len(inventory.IngressPorts) == 0 {
		return fmt.Errorf("exact ingress maintenance scope required")
	}
	raw, err := p.capture(ctx, "nft", "--json", "list", "tables")
	if err != nil {
		return err
	}
	var tables struct {
		NFTables []struct {
			Table *struct {
				Family  string `json:"family"`
				Name    string `json:"name"`
				Comment string `json:"comment"`
			} `json:"table"`
		} `json:"nftables"`
	}
	if json.Unmarshal(raw, &tables) != nil {
		return fmt.Errorf("native ingress ownership is unreadable")
	}
	comment := "youeye-core:" + fmt.Sprintf("%x", sha256.Sum256([]byte(inventory.RequestID)))
	prefix := ""
	for _, item := range tables.NFTables {
		if item.Table != nil && item.Table.Family == "inet" && item.Table.Name == "youeye_core_gate" {
			if item.Table.Comment != comment {
				return fmt.Errorf("foreign ingress maintenance table exists")
			}
			prefix = "delete table inet youeye_core_gate\n"
		}
	}
	ports := []string{}
	for _, port := range inventory.IngressPorts {
		if port == 0 {
			return fmt.Errorf("invalid maintenance ingress port")
		}
		ports = append(ports, strconv.Itoa(int(port)))
	}
	rules := prefix + fmt.Sprintf("table inet youeye_core_gate {\n comment %q\n chain input {\n type filter hook input priority -220; policy accept;\n iifname \"lo\" accept\n iifname %q accept\n tcp dport { %s } drop\n }\n}\n", comment, inventory.Bridge, strings.Join(ports, ", "))
	file := filepath.Join(filepath.Dir(p.recordPath(inventory.RequestID)), "ingress.nft")
	if err := atomicWrite(file, []byte(rules), 0600); err != nil {
		return err
	}
	_, err = p.capture(ctx, "nft", "-f", file)
	return err
}

// The operation-owned condition survives a container/host reboot. Target code
// may be replaced while services remain held. Only the coordinator removes it.
const coreServiceHoldScript = `const fs=require('node:fs');
const [request,digest,role]=process.argv.slice(1);
const record={request_id:request,manifest_sha256:digest};
const file='/etc/youeye/core-update-hold.json';
fs.mkdirSync('/etc/youeye',{recursive:true,mode:0755});
if(!fs.lstatSync('/etc/youeye').isDirectory())process.exit(1);
if(fs.existsSync(file)){
 const st=fs.lstatSync(file);if(!st.isFile()||(st.mode&0777)!==0600)process.exit(1);
 const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.request_id!==request||old.manifest_sha256!==digest)process.exit(1);
}else{const fd=fs.openSync(file,'wx',0600);try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
for(const unit of role==='cp'?['youeye-control','youeye-id']:['youeye-ui']){
 const dir='/etc/systemd/system/'+unit+'.service.d';fs.mkdirSync(dir,{recursive:true,mode:0755});
 if(!fs.lstatSync(dir).isDirectory())process.exit(1);
 const drop=dir+'/90-youeye-core-update.conf';const body='[Unit]\nConditionPathExists=!'+file+'\n';
 if(fs.existsSync(drop)&&(!fs.lstatSync(drop).isFile()||fs.readFileSync(drop,'utf8')!==body))process.exit(1);
 const fd=fs.openSync(drop,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0644);try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const parent=fs.openSync(dir,'r');fs.fsyncSync(parent);fs.closeSync(parent);
}
const fd=fs.openSync('/etc/youeye','r');fs.fsyncSync(fd);fs.closeSync(fd);`

// closeCheckpointWriters is shared by activation and recovery. Callers verify
// coordinator authority, current identities and lifecycle exclusion first.
func (p NativeCoreCheckpoint) closeCheckpointWriters(ctx context.Context, j CoreJournal, inventory CoreCheckpointInventory) error {
	if err := p.CloseIngress(ctx, inventory); err != nil {
		return err
	}
	for _, c := range inventory.Containers {
		if c.Name == "youeye-postgres" {
			continue
		}
		if err := p.verifyReservation(j); err != nil {
			return err
		}
		if _, err := p.capture(ctx, "incus", "config", "set", c.Name, "user.youeye.core-request", j.RequestID); err != nil {
			return err
		}
		if _, err := p.capture(ctx, "incus", "config", "set", c.Name, "boot.autostart", "false"); err != nil {
			return err
		}
		running, err := p.containerRunning(ctx, c)
		if err != nil {
			return err
		}
		if c.Snapshot != "" && running {
			role := "cp"
			if c.Name == "youeye-ui" {
				role = "ui"
			}
			if _, err := p.capture(ctx, "incus", "exec", c.Name, "--mode=non-interactive", "--", "node", "-e", coreServiceHoldScript, j.RequestID, j.ManifestSHA256, role); err != nil {
				return err
			}
			if _, err := p.capture(ctx, "incus", "exec", c.Name, "--", "systemctl", "daemon-reload"); err != nil {
				return err
			}
		}
		// Query before each stop: stopped intent is preserved, not implemented by
		// starting a container just so it can be stopped again.
		if running {
			if _, err := p.capture(ctx, "incus", "stop", c.Name, "--timeout=60"); err != nil {
				return err
			}
		}
	}
	if err := p.verifyContainerIdentities(ctx, inventory, true); err != nil {
		return err
	}
	return nil
}
