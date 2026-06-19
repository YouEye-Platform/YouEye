package installer

import (
	"encoding/base64"
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

func seedMarketSourceInGuest(vmid string, config installConfig) error {
	legacy, multi, err := marketSourceJSON(config.MarketRepoURL)
	if err != nil {
		return err
	}
	legacyB64 := base64.StdEncoding.EncodeToString(legacy)
	multiB64 := base64.StdEncoding.EncodeToString(multi)
	cmd := "set -e; mkdir -p /var/lib/youeye; " +
		"echo " + shellQuote(legacyB64) + " | base64 -d > /var/lib/youeye/market-source.json; " +
		"echo " + shellQuote(multiB64) + " | base64 -d > /var/lib/youeye/market-sources.json; " +
		"chmod 644 /var/lib/youeye/market-source.json /var/lib/youeye/market-sources.json"
	res, err := qmGuestExec(vmid, 30, "bash", "-lc", cmd)
	if err != nil || res.ExitCode != 0 {
		return fmt.Errorf("%v %s", err, clip(res.OutData+res.ErrData, 300))
	}
	return nil
}

func stageBundleInControl(
	vmid string,
	ch chan<- engineMsg,
	progress float64,
	bundlePath string,
	envName string,
	label string,
	dataDir string,
	importFile string,
	successMessage string,
) {
	if bundlePath == "" {
		bundlePath = os.Getenv(envName)
	}
	if bundlePath == "" {
		return
	}

	send(ch, "Deploying YouEye", "Staging "+label+"...", progress)
	if data, err := os.ReadFile(bundlePath); err != nil || len(data) == 0 {
		send(ch, "Deploying YouEye", "Warning: could not read "+label+" "+clip(bundlePath, 80), progress)
	} else {
		b64 := base64.StdEncoding.EncodeToString(data)
		stage := "incus exec youeye-control -- mkdir -p " + shellQuote(dataDir) + " && " +
			"echo '" + b64 + "' | base64 -d | incus exec youeye-control -- tee " + shellQuote(importFile) + " >/dev/null && " +
			"incus exec youeye-control -- chmod 600 " + shellQuote(importFile)
		if res, err := qmGuestExec(vmid, 60, "bash", "-lc", stage); err != nil || res.ExitCode != 0 {
			send(ch, "Deploying YouEye", "Warning: staging "+label+" failed: "+clip(res.ErrData, 120), progress)
		} else {
			send(ch, "Deploying YouEye", successMessage, progress+0.01)
		}
	}
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
		// Serial socket stays (cloud-init + host `qm terminal`), but the
		// display is std VGA so the Proxmox "Console" button is noVNC —
		// reliable typing — rather than the xterm.js serial console, which
		// shows a blank screen until you press Enter and has flaky focus.
		"--serial0", "socket",
		"--vga", "std",
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
	// NOTE: we deliberately do NOT set --cipassword here. That sets the
	// password on the youeye cloud-init user, not root — which is exactly
	// why "log in as root with my password" failed. The password the
	// operator typed is the VM's ROOT password, applied inside the guest
	// after boot (see "Configuring VM" below).
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

	// -- Configure root login + consoles inside the VM (via guest agent) --
	// The password the operator entered is the VM's ROOT password. Set it on
	// root directly; chpasswd -e takes the hash, so no plaintext ever lands
	// on a command line. Then make sure BOTH the graphical console (tty1 →
	// noVNC) and the serial console (ttyS0) have a live login prompt, so the
	// box is always reachable.
	send(ch, "Configuring VM", "Setting root password & console...", 0.40)
	if config.RootPassword != "" {
		hashed, herr := run("openssl", "passwd", "-6", config.RootPassword)
		if herr != nil {
			sendErr(ch, fmt.Errorf("hashing root password: %w", herr))
			return
		}
		if res, err := qmGuestExec(vmid, 30, "bash", "-lc",
			fmt.Sprintf("echo 'root:%s' | chpasswd -e", hashed)); err != nil || res.ExitCode != 0 {
			sendErr(ch, fmt.Errorf("setting root password: %v %s", err, clip(res.OutData+res.ErrData, 200)))
			return
		}
	}
	// Best-effort: ensure a getty on the VGA console (noVNC) and serial, and
	// allow root on ttyS0 if /etc/securetty exists and restricts it.
	qmGuestExec(vmid, 30, "bash", "-lc",
		"systemctl enable --now getty@tty1.service serial-getty@ttyS0.service 2>/dev/null || true; "+
			"{ [ -f /etc/securetty ] && ! grep -qx ttyS0 /etc/securetty && echo ttyS0 >> /etc/securetty; } || true")
	// Debian cloud images install Proxmox --sshkeys on the cloud-init user and
	// also put forced-command guard entries in root's authorized_keys. That is
	// good generic cloud posture, but confusing here: the installer explicitly
	// sets a root password for console recovery, and the cloud-init user already
	// has passwordless sudo. Normalize the same operator-supplied keys so root
	// SSH works for host/debug automation without weakening password login.
	qmGuestExec(vmid, 30, "bash", "-lc", fmt.Sprintf(`
set -e
src=%q
if [ -s "$src" ]; then
  install -d -m 700 -o root -g root /root/.ssh
  tmp="$(mktemp)"
  if [ -f /root/.ssh/authorized_keys ]; then
    awk 'index($0, "Please login as the user") == 0 { print }' /root/.ssh/authorized_keys > "$tmp"
  fi
  cat "$src" >> "$tmp"
  awk 'NF && !seen[$0]++ { print }' "$tmp" > "$tmp.dedup"
  install -m 600 -o root -g root "$tmp.dedup" /root/.ssh/authorized_keys
  rm -f "$tmp" "$tmp.dedup"
fi
`, "/home/"+ciuser+"/.ssh/authorized_keys"))

	// Prefer IPv4 for image pulls (CLAUDE.md pitfall #17). A fresh VM has no
	// IPv6 route, but Docker Hub's DNS returns AAAA records — skopeo (used by
	// incus to pull Caddy & Pi-Hole) then tries IPv6 first and dies with
	// "network is unreachable", silently half-deploying the platform. Disable
	// IPv6 (runtime + persisted) and prefer IPv4 in getaddrinfo.
	send(ch, "Configuring VM", "Preferring IPv4 for image pulls...", 0.41)
	qmGuestExec(vmid, 30, "bash", "-lc",
		"sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true; "+
			"sysctl -w net.ipv6.conf.default.disable_ipv6=1 >/dev/null 2>&1 || true; "+
			"printf 'net.ipv6.conf.all.disable_ipv6=1\\nnet.ipv6.conf.default.disable_ipv6=1\\n' > /etc/sysctl.d/99-youeye-ipv4.conf 2>/dev/null || true; "+
			"grep -q '::ffff:0:0/96' /etc/gai.conf 2>/dev/null || echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf 2>/dev/null || true")

	// -- Install Spine inside the VM (guest agent runs as root) --
	send(ch, "Installing Spine", fmt.Sprintf("Installing Spine (%s channel)...", config.ReleaseChannel), 0.42)
	installCmd, err := spineInstallCommand(config)
	if err != nil {
		sendErr(ch, fmt.Errorf("building Spine install command: %w", err))
		return
	}
	if res, err := qmGuestExec(vmid, 180, "bash", "-lc", installCmd); err != nil || res.ExitCode != 0 {
		sendErr(ch, fmt.Errorf("Spine install failed: %v %s", err, clip(res.OutData+res.ErrData, 400)))
		return
	}
	send(ch, "Installing Spine", "Spine installed", 0.46)

	send(ch, "Configuring Market", "Saving Market source...", 0.48)
	if err := seedMarketSourceInGuest(vmid, config); err != nil {
		sendErr(ch, fmt.Errorf("saving Market source in VM: %w", err))
		return
	}

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
				// `youeye deploy` can exit 0 while individual stages (Caddy,
				// Pi-Hole, ...) failed — it logs them but swallows the error
				// and still prints "Deployment Complete!". So a 0 exit is NOT
				// proof of success: scan the log for the failures it reports
				// and treat them as a hard failure too.
				fails, _ := qmGuestExec(vmid, 20, "bash", "-lc",
					"grep -nE 'deployment failed|Operation failed|network is unreachable' /var/log/youeye-deploy.log | tail -n 12")
				stageFailed := strings.TrimSpace(fails.OutData) != ""
				if code != "0" || stageFailed {
					detail := strings.TrimSpace(fails.OutData)
					if detail == "" {
						tail, _ := qmGuestExec(vmid, 20, "bash", "-lc", "tail -n 30 /var/log/youeye-deploy.log")
						detail = tail.OutData
					}
					// NOTE: we don't suggest re-running `youeye deploy` — it is not
					// idempotent (fails on "Instance already exists" and then skips
					// the remaining stages). A clean reinstall on a fresh VM is the
					// reliable recovery.
					sendErr(ch, fmt.Errorf("youeye deploy did not fully complete (exit %s). The VM (%s) is up — log in as root and check /var/log/youeye-deploy.log; reinstall on a fresh VM to recover:\n%s", code, vmIP, clip(detail, 700)))
					return
				}
				break
			}
		}
		time.Sleep(4 * time.Second)
	}
	send(ch, "Deploying YouEye", "Deployment complete", 0.96)

	// -- Optional: stage a YouEye Names reuse bundle (--names-bundle) --
	// If YOUEYE_NAMES_BUNDLE points at a bundle file, drop it into the Control
	// Panel container so the setup wizard reuses that name + certificate
	// instead of claiming a new one (no Let's Encrypt round-trip).
	stageBundleInControl(
		vmid,
		ch,
		0.97,
		config.NamesBundlePath,
		"YOUEYE_NAMES_BUNDLE",
		"YouEye Names reuse bundle",
		"/opt/youeye-control-data/youeye-names",
		"/opt/youeye-control-data/youeye-names/import-bundle.json",
		"Names bundle staged — setup will reuse the existing address",
	)
	stageBundleInControl(
		vmid,
		ch,
		0.98,
		config.DomainBundlePath,
		"YOUEYE_DOMAIN_BUNDLE",
		"BYO domain reuse bundle",
		"/opt/youeye-control-data/byo-domain",
		"/opt/youeye-control-data/byo-domain/import-bundle.json",
		"Domain bundle staged — setup will reuse the existing domain",
	)

	sendDone(ch, vmIP)
}
