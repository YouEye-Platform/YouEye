package installer

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Proxmox VM provider
//
// Provisions a Debian 13 VM on the Proxmox host with the QEMU guest agent
// PRE-BAKED (virt-customize), then installs YouEye inside it entirely via
// `qm guest exec` (no SSH). This is the proven sequence from
// installer/scripts/proxmox-vm.sh, ported to Go.
// ---------------------------------------------------------------------------

const (
	debian13ImageURL = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2"
	// install.sh comes from the canonical main branch (stable installer logic);
	// the BRANCH + repo below tell it — and the subsequent `youeye deploy` —
	// to use the artem releases from Forgejo instead of the GitHub stable
	// default. install.sh persists both into Spine's config, so `youeye deploy`
	// then pulls cp-artem-* / ui-artem-* from Forgejo automatically.
	spineInstallURL = "https://git.potemk.in/potemsla/YouEye/raw/branch/main/spine/install.sh"
	releaseRepo     = "https://git.potemk.in/potemsla/YouEye"
	releaseBranch   = "artem"
)

// guestExecResult is the JSON `qm guest exec` returns. `qm guest exec` itself
// exits 0 once the agent ran the command; the guest command's status is in
// ExitCode.
type guestExecResult struct {
	OutData  string `json:"out-data"`
	ErrData  string `json:"err-data"`
	ExitCode int    `json:"exitcode"`
	Exited   int    `json:"exited"`
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// qmGuestExec runs a command inside the VM via the guest agent.
func qmGuestExec(vmid string, timeout int, args ...string) (guestExecResult, error) {
	full := append([]string{"guest", "exec", vmid, "--timeout", strconv.Itoa(timeout), "--"}, args...)
	out, err := run("qm", full...)
	var r guestExecResult
	if jerr := json.Unmarshal([]byte(out), &r); jerr != nil {
		return r, fmt.Errorf("guest exec failed: %v (%s)", err, clip(out, 200))
	}
	return r, nil
}

// waitForAgent polls `qm agent <vmid> ping` until it answers or the timeout
// elapses.
func waitForAgent(vmid string, seconds int) bool {
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	for time.Now().Before(deadline) {
		if _, err := run("qm", "agent", vmid, "ping"); err == nil {
			return true
		}
		time.Sleep(3 * time.Second)
	}
	return false
}

// vmIPViaAgent returns the VM's first non-loopback IPv4 from the guest agent.
func vmIPViaAgent(vmid string) string {
	out, err := run("qm", "guest", "cmd", vmid, "network-get-interfaces")
	if err != nil {
		return ""
	}
	return parseVMIP(out)
}

// installVM is the Proxmox VM provider's provisioning routine.
func installVM(config installConfig, ch chan<- engineMsg) {
	os.Setenv("LIBGUESTFS_BACKEND", "direct") // libguestfs on PVE kernels

	vmid := config.ContainerID
	storage := config.StoragePool
	if storage == "" {
		storage = "local-lvm"
	}
	bridge := config.NetworkBridge
	if bridge == "" {
		bridge = "vmbr0"
	}
	cpuType := "kvm64"
	if strings.EqualFold(config.CPUModel, "Host") {
		cpuType = "host"
	}
	const ciuser = "youeye"

	// -- Ensure libguestfs-tools (virt-customize) on the host --
	if _, err := run("bash", "-lc", "command -v virt-customize >/dev/null"); err != nil {
		send(ch, "Preparing host", "Installing libguestfs-tools (one-time)...", 0.02)
		if out, err := run("bash", "-lc", "apt-get update -qq || true; DEBIAN_FRONTEND=noninteractive apt-get install -y libguestfs-tools"); err != nil {
			sendErr(ch, fmt.Errorf("installing libguestfs-tools: %s", clip(out, 300)))
			return
		}
	}

	// -- Download Debian 13 genericcloud (cached) --
	send(ch, "Downloading image", "Fetching Debian 13 cloud image...", 0.05)
	imgDir := "/var/lib/vz/template/iso"
	imgCache := imgDir + "/debian-13-genericcloud-amd64.qcow2"
	run("mkdir", "-p", imgDir)
	if _, err := run("bash", "-lc", fmt.Sprintf("test -s %q && qemu-img info %q >/dev/null 2>&1", imgCache, imgCache)); err != nil {
		if out, err := run("bash", "-lc", fmt.Sprintf("wget -qO %q.part %q && mv %q.part %q", imgCache, debian13ImageURL, imgCache, imgCache)); err != nil {
			sendErr(ch, fmt.Errorf("downloading image: %s", clip(out, 300)))
			return
		}
	}
	send(ch, "Downloading image", "Image ready", 0.10)

	// -- Pre-bake the guest agent into a per-VM working copy --
	send(ch, "Preparing image", "Baking qemu-guest-agent into the image...", 0.12)
	workImg := fmt.Sprintf("%s/youeye-vm-%s.qcow2", imgDir, vmid)
	if out, err := run("cp", "--reflink=auto", imgCache, workImg); err != nil {
		sendErr(ch, fmt.Errorf("copying image: %s", clip(out, 200)))
		return
	}
	if out, err := run("virt-customize", "-a", workImg,
		"--install", "qemu-guest-agent",
		"--run-command", "systemctl enable qemu-guest-agent"); err != nil {
		sendErr(ch, fmt.Errorf("virt-customize: %s", clip(out, 400)))
		return
	}
	run("qemu-img", "resize", workImg, fmt.Sprintf("%dG", config.DiskGB))

	// -- Create the VM (SeaBIOS, serial console, agent enabled) --
	send(ch, "Creating VM", fmt.Sprintf("qm create %s", vmid), 0.16)
	createArgs := []string{
		"create", vmid,
		"--name", config.Hostname,
		"--cores", strconv.Itoa(config.CPUCores),
		"--memory", strconv.Itoa(config.RAMMB),
		"--cpu", cpuType,
		"--net0", fmt.Sprintf("virtio,bridge=%s", bridge),
		"--ostype", "l26",
		"--scsihw", "virtio-scsi-single",
		"--serial0", "socket", "--vga", "serial0",
		"--agent", "enabled=1",
		"--onboot", "1",
		"--tags", "youeye",
	}
	if out, err := run("qm", createArgs...); err != nil {
		sendErr(ch, fmt.Errorf("qm create: %s", clip(out, 300)))
		return
	}

	// -- Import OS disk (PVE one-step; auto qcow2->raw on lvm-thin) --
	send(ch, "Creating VM", "Importing OS disk into "+storage+"...", 0.20)
	if out, err := run("qm", "set", vmid, "--scsi0",
		fmt.Sprintf("%s:0,import-from=%s,discard=on,ssd=1,iothread=1", storage, workImg)); err != nil {
		sendErr(ch, fmt.Errorf("disk import: %s", clip(out, 300)))
		return
	}
	run("qm", "set", vmid, "--ide2", storage+":cloudinit")
	run("qm", "set", vmid, "--boot", "order=scsi0")

	// -- Cloud-init --
	send(ch, "Creating VM", "Configuring cloud-init...", 0.24)
	run("qm", "set", vmid, "--ciuser", ciuser)
	if config.RootPassword != "" {
		if hashed, err := run("openssl", "passwd", "-6", config.RootPassword); err == nil {
			run("qm", "set", vmid, "--cipassword", hashed)
		}
	}
	if _, err := os.Stat("/root/.ssh/authorized_keys"); err == nil {
		run("qm", "set", vmid, "--sshkeys", "/root/.ssh/authorized_keys")
	}
	if config.IPMode == "Static" && config.StaticIP != "" {
		ipcfg := "ip=" + config.StaticIP
		if config.Gateway != "" {
			ipcfg += ",gw=" + config.Gateway
		}
		run("qm", "set", vmid, "--ipconfig0", ipcfg)
	} else {
		run("qm", "set", vmid, "--ipconfig0", "ip=dhcp")
	}
	run("qm", "set", vmid, "--ciupgrade", "0")
	os.Remove(workImg) // data now lives in the imported volume

	// -- Boot + wait for the guest agent --
	send(ch, "Starting VM", "Booting...", 0.28)
	if out, err := run("qm", "start", vmid); err != nil {
		sendErr(ch, fmt.Errorf("qm start: %s", clip(out, 200)))
		return
	}
	send(ch, "Starting VM", "Waiting for guest agent...", 0.32)
	if !waitForAgent(vmid, 300) {
		sendErr(ch, fmt.Errorf("guest agent did not respond within 5 minutes"))
		return
	}
	vmIP := vmIPViaAgent(vmid)
	if vmIP == "" && config.IPMode == "Static" && config.StaticIP != "" {
		vmIP = strings.Split(config.StaticIP, "/")[0]
	}
	send(ch, "Starting VM", fmt.Sprintf("Guest agent up — VM IP: %s", vmIP), 0.38)

	// -- Install Spine inside the VM (guest agent runs as root) --
	send(ch, "Installing Spine", fmt.Sprintf("Installing Spine (%s branch, Forgejo)...", releaseBranch), 0.42)
	installCmd := fmt.Sprintf("curl -fsSL %s | RELEASE_REPO_URL='%s' BRANCH='%s' sh", spineInstallURL, releaseRepo, releaseBranch)
	if res, err := qmGuestExec(vmid, 180, "bash", "-lc", installCmd); err != nil || res.ExitCode != 0 {
		sendErr(ch, fmt.Errorf("Spine install failed: %v %s", err, clip(res.OutData+res.ErrData, 400)))
		return
	}
	send(ch, "Installing Spine", "Spine installed", 0.46)

	// -- Deploy YouEye inside the VM: start in background, poll the log so the
	//    TUI streams progress (qm guest exec is not itself a live stream). --
	send(ch, "Deploying YouEye", "Running youeye deploy (several minutes — enjoy the games!)", 0.50)
	startDeploy := "nohup bash -c 'youeye deploy >/var/log/youeye-deploy.log 2>&1; echo $? >/var/log/youeye-deploy.rc' >/dev/null 2>&1 & echo started"
	if _, err := qmGuestExec(vmid, 20, "bash", "-lc", startDeploy); err != nil {
		sendErr(ch, fmt.Errorf("starting youeye deploy: %w", err))
		return
	}
	seen := 0
	deadline := time.Now().Add(30 * time.Minute)
	for {
		if time.Now().After(deadline) {
			sendErr(ch, fmt.Errorf("youeye deploy timed out after 30 minutes"))
			return
		}
		// Stream any new log lines.
		if res, err := qmGuestExec(vmid, 25, "bash", "-lc", fmt.Sprintf("tail -n +%d /var/log/youeye-deploy.log 2>/dev/null", seen+1)); err == nil && res.OutData != "" {
			for _, line := range strings.Split(strings.TrimRight(res.OutData, "\n"), "\n") {
				seen++
				pct := parseDeployProgress(line)
				if isNoisyLine(line) {
					if pct > 0 {
						ch <- engineMsg{StepName: "Deploying YouEye", Percent: pct}
					}
					continue
				}
				ch <- engineMsg{StepName: "Deploying YouEye", LogLine: line, Percent: pct}
			}
		}
		// Completion? The rc file appears when deploy exits.
		if rc, err := qmGuestExec(vmid, 15, "bash", "-lc", "cat /var/log/youeye-deploy.rc 2>/dev/null"); err == nil {
			if code := strings.TrimSpace(rc.OutData); code != "" {
				if code != "0" {
					tail, _ := qmGuestExec(vmid, 20, "bash", "-lc", "tail -n 30 /var/log/youeye-deploy.log")
					sendErr(ch, fmt.Errorf("youeye deploy failed (exit %s):\n%s", code, clip(tail.OutData, 600)))
					return
				}
				break
			}
		}
		time.Sleep(4 * time.Second)
	}
	send(ch, "Deploying YouEye", "Deployment complete", 0.96)

	sendDone(ch, vmIP)
}
