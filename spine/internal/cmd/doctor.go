package cmd

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

type doctorStatus string

const (
	doctorOK      doctorStatus = "ok"
	doctorWarn    doctorStatus = "warning"
	doctorFail    doctorStatus = "failure"
	doctorUnknown doctorStatus = "unknown"
)

type doctorCheck struct {
	Section string       `json:"section"`
	Name    string       `json:"name"`
	Status  doctorStatus `json:"status"`
	Summary string       `json:"summary"`
	Detail  string       `json:"detail,omitempty"`
}

type doctorReport struct {
	GeneratedAt string        `json:"generated_at"`
	Checks      []doctorCheck `json:"checks"`
	Failures    int           `json:"failures"`
	Warnings    int           `json:"warnings"`
}

var doctorJSON bool
var doctorVerbose bool
var doctorFix bool
var doctorReadFile = os.ReadFile
var doctorRunCommand = commandOutput
var doctorRunCommandWithInput = commandOutputWithInput
var doctorDNSDialContext = (&net.Dialer{Timeout: 5 * time.Second}).DialContext

var doctorCmd = &cobra.Command{
	Use:   "doctor [section]",
	Short: "Run read-only recovery diagnostics",
	Long: `Run CP-down-safe diagnostics for host, Incus, platform services, apps, storage, backup, hardware, and network.

By default doctor is read-only and prints one line per check. Use --json for
agent/UI consumption and -v for drilldown. --fix is opt-in and currently only
prints the safe repair plan exposed by the same checks.`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		section := "all"
		if len(args) == 1 {
			section = strings.ToLower(args[0])
		}
		report := runDoctor(section)
		if doctorFix {
			report.Checks = append(report.Checks, doctorCheck{
				Section: "fix",
				Name:    "repair plan",
				Status:  doctorWarn,
				Summary: "--fix is safe-only; current build reports the plan and does not mutate host state",
				Detail:  "Use issue-registry Fix actions in Control Panel for CP-owned repairs, or rerun specific recovery commands printed by failed checks.",
			})
			report.Warnings++
		}
		if doctorJSON {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			if err := enc.Encode(report); err != nil {
				return err
			}
		} else {
			printDoctor(report)
		}
		if report.Failures > 0 {
			return fmt.Errorf("doctor found %d failing check(s)", report.Failures)
		}
		return nil
	},
}

func init() {
	doctorCmd.Flags().BoolVar(&doctorJSON, "json", false, "output JSON")
	doctorCmd.Flags().BoolVarP(&doctorVerbose, "verbose", "v", false, "show drilldown details")
	doctorCmd.Flags().BoolVar(&doctorFix, "fix", false, "print safe repair plan")
}

func runDoctor(section string) doctorReport {
	validSections := map[string]bool{
		"all": true, "host": true, "incus": true, "platform": true,
		"apps": true, "storage": true, "backup": true, "hardware": true,
		"network": true,
	}
	if !validSections[section] {
		return doctorReport{
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
			Checks: []doctorCheck{{
				Section: section,
				Name:    "section",
				Status:  doctorFail,
				Summary: "unknown doctor section",
				Detail:  "Valid sections: host, incus, platform, apps, storage, backup, hardware, network.",
			}},
			Failures: 1,
		}
	}

	var checks []doctorCheck
	add := func(items ...doctorCheck) {
		for _, c := range items {
			if section == "all" || c.Section == section {
				checks = append(checks, c)
			}
		}
	}
	add(doctorHostChecks()...)
	add(doctorIncusChecks()...)
	add(doctorPlatformChecks()...)
	add(doctorAppChecks()...)
	add(doctorDeferred("storage", "storage section", "Storage-specific checks are not implemented in this build."))
	add(doctorDeferred("backup", "backup section", "Backup-specific checks are not implemented in this build."))
	add(doctorDeferred("hardware", "hardware section", "Hardware-specific checks are not implemented in this build."))
	add(doctorNetworkChecks()...)

	report := doctorReport{GeneratedAt: time.Now().UTC().Format(time.RFC3339), Checks: checks}
	for _, c := range checks {
		switch c.Status {
		case doctorFail:
			report.Failures++
		case doctorWarn, doctorUnknown:
			report.Warnings++
		}
	}
	return report
}

func doctorHostChecks() []doctorCheck {
	return []doctorCheck{
		checkDiskUsage(),
		checkMemPressure(),
		checkSwap(),
		checkCommand("host", "ZFS module", "modprobe", []string{"-n", "zfs"}, "zfs module is available", "zfs module is missing or cannot be loaded"),
		checkKernelHeaders(),
		checkIPv6Policy(),
		checkTimeSync(),
	}
}

func doctorIncusChecks() []doctorCheck {
	checks := []doctorCheck{
		checkCommand("incus", "daemon ready", "incus", []string{"info"}, "Incus daemon is reachable", "Incus daemon is not reachable"),
		checkSystemd("incus", "incus-startup", "incus-startup.service"),
		checkCommand("incus", "pool default", "zpool", []string{"status", "-x", "default"}, "default pool is healthy", "default pool is not healthy"),
		checkCommand("incus", "bridge network", "incus", []string{"network", "show", GetConfig().Deployment.Incus.Network}, "Incus bridge exists", "Incus bridge is missing"),
	}
	if out, err := commandOutput("incus", "list", "--format", "csv", "-c", "ns"); err == nil {
		if strings.Contains(strings.ToUpper(out), "ERROR") {
			checks = append(checks, doctorCheck{Section: "incus", Name: "instances", Status: doctorFail, Summary: "one or more instances are in ERROR", Detail: out})
		} else {
			checks = append(checks, doctorCheck{Section: "incus", Name: "instances", Status: doctorOK, Summary: "no ERROR instances"})
		}
	} else {
		checks = append(checks, doctorCheck{Section: "incus", Name: "instances", Status: doctorUnknown, Summary: "could not list instances", Detail: err.Error()})
	}
	return checks
}

func doctorPlatformChecks() []doctorCheck {
	checks := []doctorCheck{
		checkContainer("platform", "control panel container", "youeye-control"),
		checkContainer("platform", "YouEye UI container", "youeye-ui"),
		checkContainer("platform", "postgres container", "youeye-postgres"),
		checkContainer("platform", "caddy container", "youeye-caddy"),
		checkContainer("platform", "pihole container", "youeye-pihole"),
		checkContainerSystemd("platform", "youeye-control service", "youeye-control", "youeye-control.service"),
		checkContainerSystemd("platform", "youeye-id service", "youeye-control", "youeye-id.service"),
		checkContainerSystemd("platform", "YouEye UI service", "youeye-ui", "youeye-ui.service"),
		checkHostIPFiles(),
		checkCaddyAdminInContainer("youeye-caddy"),
		checkPostgresCredentialed(),
		checkBridgeToken("/var/lib/youeye/control/.bridge_token", "youeye-control", "youeye-ui"),
	}
	if controlClient != nil && controlClient.Available() {
		checks = append(checks, doctorCheck{Section: "platform", Name: "control panel API", Status: doctorOK, Summary: "Control Panel API is reachable"})
	} else {
		checks = append(checks, doctorCheck{Section: "platform", Name: "control panel API", Status: doctorWarn, Summary: "Control Panel API is unreachable; doctor is continuing in recovery mode", Detail: "Run `youeye services restart control` or inspect `youeye logs control`."})
	}
	return checks
}

func doctorAppChecks() []doctorCheck {
	if controlClient != nil && controlClient.Available() && controlClient.HasToken() {
		data, err := controlClient.Get("/api/apps/unified")
		if err == nil {
			apps, _ := data["apps"].([]interface{})
			if len(apps) == 0 {
				return []doctorCheck{{Section: "apps", Name: "installed apps", Status: doctorOK, Summary: "no installed apps reported"}}
			}
			checks := make([]doctorCheck, 0, len(apps))
			for _, raw := range apps {
				app, _ := raw.(map[string]interface{})
				c := doctorReportedAppCheck(app)
				checks = append(checks, c)
			}
			return checks
		}
	}
	out, err := commandOutput("incus", "list", "app-", "--format", "csv", "-c", "ns")
	if err != nil {
		return []doctorCheck{{Section: "apps", Name: "app facts", Status: doctorUnknown, Summary: "Control Panel app facts unavailable and Incus app scan failed", Detail: err.Error()}}
	}
	return []doctorCheck{{Section: "apps", Name: "app facts", Status: doctorWarn, Summary: "Control Panel app facts unavailable; degraded to Incus app scan", Detail: out}}
}

func doctorReportedAppCheck(app map[string]interface{}) doctorCheck {
	id := firstOf(app, "id", "appId", "name")
	health := firstOf(app, "healthStatus")
	runtime := firstOf(app, "status")
	check := doctorCheck{Section: "apps", Name: id, Status: doctorUnknown, Summary: "application readiness is not reported"}
	if id == "pointer" && runtime == "running" {
		out, err := doctorRunCommand("incus", "exec", "youeye-pointer", "--", "curl", "--silent", "--show-error", "--fail", "--max-time", "5", "http://127.0.0.1:4001/readyz")
		var readiness struct {
			Status string `json:"status"`
		}
		if err != nil || json.Unmarshal([]byte(out), &readiness) != nil || readiness.Status == "" {
			check.Status = doctorFail
			check.Summary = "Pointer application readiness probe failed"
		} else if readiness.Status == "ok" {
			check.Status = doctorOK
			check.Summary = "Pointer application readiness passed"
		} else {
			check.Status = doctorWarn
			check.Summary = "Pointer application readiness is " + readiness.Status
		}
		return check
	}
	if health == "healthy" {
		check.Status = doctorOK
		check.Summary = "Control Panel reports application healthy"
	} else if health != "" {
		check.Status = doctorWarn
		check.Summary = "app health is " + health
	} else if runtime == "running" {
		check.Summary = "runtime is running; application readiness is not reported"
	} else if runtime != "" {
		check.Status = doctorWarn
		check.Summary = "app runtime is " + runtime
	}
	return check
}

func doctorDeferred(section, name, detail string) doctorCheck {
	return doctorCheck{Section: section, Name: name, Status: doctorUnknown, Summary: "checks are not yet implemented", Detail: detail}
}

func doctorNetworkChecks() []doctorCheck {
	type siteConfig struct {
		Domain string `yaml:"domain"`
	}

	checks := []doctorCheck{
		checkCommand(
			"network", "outbound HTTPS", "curl",
			[]string{"-fsS", "-o", "/dev/null", "--connect-timeout", "5", "--max-time", "15", "https://example.com"},
			"outbound HTTPS is reachable", "outbound HTTPS is not reachable",
		),
	}

	data, err := doctorReadFile("/var/lib/youeye/config/youeye.yaml")
	if err != nil {
		return append(checks, doctorCheck{Section: "network", Name: "site DNS", Status: doctorFail, Summary: "site configuration is not readable", Detail: err.Error()})
	}
	var cfg siteConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil || strings.TrimSpace(cfg.Domain) == "" {
		detail := "domain is missing from site configuration"
		if err != nil {
			detail = err.Error()
		}
		return append(checks, doctorCheck{Section: "network", Name: "site DNS", Status: doctorFail, Summary: "site domain is not configured", Detail: detail})
	}
	domain := strings.TrimSpace(cfg.Domain)
	liveIP := firstNonLoopbackIPv4()
	if liveIP == "" {
		checks = append(checks, doctorCheck{Section: "network", Name: "host address", Status: doctorFail, Summary: "no live non-loopback IPv4 address was found"})
	} else {
		checks = append(checks, doctorHostDNSCheck(domain, liveIP))
	}

	piholeOut, piholeErr := doctorRunCommand("incus", "list", "youeye-pihole", "--format", "csv", "-c", "4")
	piholeIP := firstIPv4InText(piholeOut)
	if piholeErr != nil || piholeIP == "" {
		return append(checks, doctorCheck{Section: "network", Name: "Pi-hole address", Status: doctorFail, Summary: "could not discover the Pi-hole IPv4 address", Detail: strings.TrimSpace(piholeOut)})
	}

	localOut, localErr := doctorIPv4Lookup(domain, piholeIP)
	if localErr != nil || liveIP == "" || !outputContainsIP(localOut, liveIP) {
		checks = append(checks, doctorCheck{Section: "network", Name: "Pi-hole local DNS", Status: doctorFail, Summary: "Pi-hole does not resolve the site domain to the live host address", Detail: strings.TrimSpace(localOut)})
	} else {
		checks = append(checks, doctorCheck{Section: "network", Name: "Pi-hole local DNS", Status: doctorOK, Summary: "Pi-hole resolves the site domain to the live host address"})
	}

	upstreamOut, upstreamErr := doctorIPv4Lookup("example.com", piholeIP)
	if upstreamErr != nil || firstIPv4InText(upstreamOut) == "" {
		checks = append(checks, doctorCheck{Section: "network", Name: "Pi-hole upstream DNS", Status: doctorFail, Summary: "Pi-hole cannot resolve an upstream domain", Detail: strings.TrimSpace(upstreamOut)})
	} else {
		checks = append(checks, doctorCheck{Section: "network", Name: "Pi-hole upstream DNS", Status: doctorOK, Summary: "Pi-hole resolves upstream domains"})
	}

	return checks
}

func doctorHostDNSCheck(domain, liveIP string) doctorCheck {
	out, err := doctorRunCommand("getent", "ahostsv4", domain)
	if err != nil || !outputContainsIP(out, liveIP) {
		return doctorCheck{
			Section: "network",
			Name:    "host DNS",
			Status:  doctorWarn,
			Summary: "host resolver does not resolve the site domain to the live host address; authoritative Pi-hole checks determine appliance DNS health",
			Detail:  strings.TrimSpace(out),
		}
	}
	return doctorCheck{Section: "network", Name: "host DNS", Status: doctorOK, Summary: "site domain resolves to the live host address"}
}

func doctorIPv4Lookup(domain, server string) (string, error) {
	serverIP := net.ParseIP(strings.TrimSpace(server))
	if serverIP == nil || serverIP.To4() == nil {
		return "", fmt.Errorf("invalid IPv4 DNS server %q", server)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return doctorDNSDialContext(ctx, network, net.JoinHostPort(serverIP.String(), "53"))
		},
	}
	addresses, err := resolver.LookupIP(ctx, "ip4", strings.TrimSpace(domain))
	if err != nil {
		return "", err
	}
	result := make([]string, 0, len(addresses))
	for _, address := range addresses {
		if ipv4 := address.To4(); ipv4 != nil {
			result = append(result, ipv4.String())
		}
	}
	if len(result) == 0 {
		return "", fmt.Errorf("DNS response for %q contained no IPv4 addresses", domain)
	}
	return strings.Join(result, "\n"), nil
}

func checkDiskUsage() doctorCheck {
	out, err := commandOutput("df", "-P", "/")
	if err != nil {
		return doctorCheck{Section: "host", Name: "disk usage", Status: doctorUnknown, Summary: "could not read root disk usage", Detail: err.Error()}
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 2 {
		return doctorCheck{Section: "host", Name: "disk usage", Status: doctorUnknown, Summary: "unexpected df output", Detail: out}
	}
	fields := strings.Fields(lines[1])
	used := 0
	if len(fields) >= 5 {
		used, _ = strconv.Atoi(strings.TrimSuffix(fields[4], "%"))
	}
	status := doctorOK
	if used >= 90 {
		status = doctorFail
	} else if used >= 80 {
		status = doctorWarn
	}
	return doctorCheck{Section: "host", Name: "disk usage", Status: status, Summary: fmt.Sprintf("root filesystem is %d%% used", used), Detail: lines[1]}
}

func checkMemPressure() doctorCheck {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return doctorCheck{Section: "host", Name: "memory pressure", Status: doctorUnknown, Summary: "could not read meminfo", Detail: err.Error()}
	}
	avail := parseMeminfoKB(string(data), "MemAvailable")
	total := parseMeminfoKB(string(data), "MemTotal")
	if avail == 0 || total == 0 {
		return doctorCheck{Section: "host", Name: "memory pressure", Status: doctorUnknown, Summary: "meminfo lacks MemAvailable/MemTotal"}
	}
	pctAvail := avail * 100 / total
	status := doctorOK
	if pctAvail < 5 {
		status = doctorFail
	} else if pctAvail < 10 {
		status = doctorWarn
	}
	return doctorCheck{Section: "host", Name: "memory pressure", Status: status, Summary: fmt.Sprintf("%d%% memory available", pctAvail)}
}

func checkSwap() doctorCheck {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return doctorCheck{Section: "host", Name: "swap", Status: doctorUnknown, Summary: "could not read swap info", Detail: err.Error()}
	}
	total := parseMeminfoKB(string(data), "SwapTotal")
	if total == 0 {
		return doctorCheck{Section: "host", Name: "swap", Status: doctorWarn, Summary: "swap is not configured"}
	}
	return doctorCheck{Section: "host", Name: "swap", Status: doctorOK, Summary: fmt.Sprintf("swap total is %d MiB", total/1024)}
}

func checkKernelHeaders() doctorCheck {
	kernel, err := commandOutput("uname", "-r")
	if err != nil {
		return doctorCheck{Section: "host", Name: "kernel headers", Status: doctorUnknown, Summary: "could not read running kernel", Detail: err.Error()}
	}
	kernel = strings.TrimSpace(kernel)
	if _, err := os.Stat("/lib/modules/" + kernel + "/build"); err != nil {
		return doctorCheck{Section: "host", Name: "kernel headers", Status: doctorFail, Summary: "headers for running kernel are missing", Detail: "Install linux-headers meta package for " + kernel}
	}
	if commandExists("dpkg-query") {
		if _, err := commandOutput("dpkg-query", "-W", "linux-headers-cloud-amd64"); err != nil {
			if _, err2 := commandOutput("dpkg-query", "-W", "linux-headers-amd64"); err2 != nil {
				return doctorCheck{Section: "host", Name: "kernel headers meta", Status: doctorWarn, Summary: "running headers exist but headers meta package is not installed", Detail: "This can break ZFS after unattended kernel upgrades."}
			}
		}
	}
	return doctorCheck{Section: "host", Name: "kernel headers", Status: doctorOK, Summary: "running kernel headers are present"}
}

func checkIPv6Policy() doctorCheck {
	data, err := os.ReadFile("/etc/gai.conf")
	if err != nil {
		return doctorCheck{Section: "host", Name: "IPv6/gai.conf", Status: doctorWarn, Summary: "gai.conf is not readable", Detail: err.Error()}
	}
	if strings.Contains(string(data), "precedence ::ffff:0:0/96") {
		return doctorCheck{Section: "host", Name: "IPv6/gai.conf", Status: doctorOK, Summary: "IPv4 precedence override is configured"}
	}
	return doctorCheck{Section: "host", Name: "IPv6/gai.conf", Status: doctorWarn, Summary: "IPv4 precedence override not found; upstream fetches may prefer broken IPv6"}
}

func checkTimeSync() doctorCheck {
	out, err := commandOutput("timedatectl", "show", "-p", "NTPSynchronized", "--value")
	if err != nil {
		return doctorCheck{Section: "host", Name: "time sync", Status: doctorUnknown, Summary: "could not read time sync state", Detail: err.Error()}
	}
	if strings.TrimSpace(out) == "yes" {
		return doctorCheck{Section: "host", Name: "time sync", Status: doctorOK, Summary: "NTP is synchronized"}
	}
	return doctorCheck{Section: "host", Name: "time sync", Status: doctorWarn, Summary: "NTP is not synchronized"}
}

func checkSystemd(section, name, unit string) doctorCheck {
	out, err := doctorRunCommand("systemctl", "is-active", unit)
	if err != nil {
		return doctorCheck{Section: section, Name: name, Status: doctorWarn, Summary: unit + " is not active", Detail: strings.TrimSpace(out)}
	}
	return doctorCheck{Section: section, Name: name, Status: doctorOK, Summary: unit + " is active"}
}

func checkContainerSystemd(section, name, container, unit string) doctorCheck {
	out, err := doctorRunCommand("incus", "exec", container, "--", "systemctl", "is-active", unit)
	if err != nil {
		return doctorCheck{Section: section, Name: name, Status: doctorWarn, Summary: unit + " is not active in " + container, Detail: strings.TrimSpace(out)}
	}
	return doctorCheck{Section: section, Name: name, Status: doctorOK, Summary: unit + " is active in " + container}
}

func checkContainer(section, name, container string) doctorCheck {
	out, err := doctorRunCommand("incus", "list", container, "--format", "csv", "-c", "s")
	if err != nil {
		return doctorCheck{Section: section, Name: name, Status: doctorUnknown, Summary: "could not inspect " + container, Detail: err.Error()}
	}
	if strings.Contains(strings.ToLower(out), "running") {
		return doctorCheck{Section: section, Name: name, Status: doctorOK, Summary: container + " is RUNNING"}
	}
	return doctorCheck{Section: section, Name: name, Status: doctorFail, Summary: container + " is not RUNNING", Detail: out}
}

func checkHostIPFiles() doctorCheck {
	live := firstNonLoopbackIPv4()
	data, err := doctorReadFile("/var/lib/youeye/.host_ip")
	if err != nil {
		return doctorCheck{Section: "platform", Name: ".host_ip", Status: doctorWarn, Summary: ".host_ip is missing or unreadable", Detail: err.Error()}
	}
	persisted := strings.TrimSpace(string(data))
	if live != "" && persisted != live {
		return doctorCheck{Section: "platform", Name: ".host_ip", Status: doctorFail, Summary: "persisted host IP does not match live IP", Detail: fmt.Sprintf("persisted=%s live=%s", persisted, live)}
	}
	return doctorCheck{Section: "platform", Name: ".host_ip", Status: doctorOK, Summary: ".host_ip matches live IP"}
}

func checkCaddyAdminInContainer(container string) doctorCheck {
	out, err := doctorRunCommand("incus", "exec", container, "--", "sh", "-lc", `curl -s -o /dev/null -w "%{http_code}" http://localhost:2019/config/`)
	if err != nil {
		return doctorCheck{Section: "platform", Name: "Caddy admin", Status: doctorWarn, Summary: "Caddy admin API is not reachable inside " + container, Detail: strings.TrimSpace(out)}
	}
	if strings.TrimSpace(out) != "200" {
		return doctorCheck{Section: "platform", Name: "Caddy admin", Status: doctorWarn, Summary: "Caddy admin API returned unexpected status inside " + container, Detail: strings.TrimSpace(out)}
	}
	return doctorCheck{Section: "platform", Name: "Caddy admin", Status: doctorOK, Summary: "Caddy admin API responds inside " + container}
}

func checkPostgresCredentialed() doctorCheck {
	pass, err := doctorReadFile("/var/lib/youeye/postgres/.pg_password")
	if err != nil {
		return doctorCheck{Section: "platform", Name: "Postgres credentialed probe", Status: doctorWarn, Summary: "Postgres password file is not readable", Detail: err.Error()}
	}
	password := strings.TrimSpace(string(pass))
	if password == "" {
		return doctorCheck{Section: "platform", Name: "Postgres credentialed probe", Status: doctorFail, Summary: "Postgres password file is empty"}
	}
	out, err := doctorRunCommandWithInput(
		password+"\n",
		"incus", "exec", "youeye-postgres", "--", "sh", "-c",
		`IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -h 127.0.0.1 -U youeye -d postgres -tAc "SELECT 1"`,
	)
	if err != nil || strings.TrimSpace(out) != "1" {
		return doctorCheck{Section: "platform", Name: "Postgres credentialed probe", Status: doctorFail, Summary: "credentialed Postgres query failed", Detail: strings.TrimSpace(out)}
	}
	return doctorCheck{Section: "platform", Name: "Postgres credentialed probe", Status: doctorOK, Summary: "credentialed Postgres query succeeded"}
}

func checkBridgeToken(hostPath string, containers ...string) doctorCheck {
	hostData, err := doctorReadFile(hostPath)
	if err != nil || strings.TrimSpace(string(hostData)) == "" {
		return doctorCheck{Section: "platform", Name: "bridge token", Status: doctorFail, Summary: "UI bridge token persistence missing on host", Detail: hostPath}
	}
	for _, container := range containers {
		out, err := doctorRunCommand("incus", "exec", container, "--", "cat", "/etc/youeye/ui-bridge-token")
		if err != nil || strings.TrimSpace(out) == "" {
			return doctorCheck{Section: "platform", Name: "bridge token", Status: doctorFail, Summary: "UI bridge token missing in " + container, Detail: "/etc/youeye/ui-bridge-token"}
		}
		containerToken := strings.TrimSpace(out)
		hostToken := strings.TrimSpace(string(hostData))
		if len(containerToken) != len(hostToken) || subtle.ConstantTimeCompare([]byte(containerToken), []byte(hostToken)) != 1 {
			return doctorCheck{Section: "platform", Name: "bridge token", Status: doctorFail, Summary: "UI bridge token in " + container + " does not match the persisted host token"}
		}
	}
	return doctorCheck{Section: "platform", Name: "bridge token", Status: doctorOK, Summary: "UI bridge token matches across the host and platform containers"}
}

func checkCommand(section, name, bin string, args []string, okSummary, failSummary string) doctorCheck {
	out, err := commandOutput(bin, args...)
	if err != nil {
		return doctorCheck{Section: section, Name: name, Status: doctorFail, Summary: failSummary, Detail: strings.TrimSpace(out + "\n" + err.Error())}
	}
	return doctorCheck{Section: section, Name: name, Status: doctorOK, Summary: okSummary, Detail: strings.TrimSpace(out)}
}

func commandOutput(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func commandOutputWithInput(input, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Stdin = strings.NewReader(input)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func parseMeminfoKB(meminfo, key string) int {
	for _, line := range strings.Split(meminfo, "\n") {
		if strings.HasPrefix(line, key+":") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				n, _ := strconv.Atoi(fields[1])
				return n
			}
		}
	}
	return 0
}

func firstIPv4InText(value string) string {
	for _, field := range strings.FieldsFunc(value, func(r rune) bool {
		return !(r == '.' || r >= '0' && r <= '9')
	}) {
		if ip := net.ParseIP(field); ip != nil && ip.To4() != nil {
			return ip.String()
		}
	}
	return ""
}

func outputContainsIP(output, expected string) bool {
	for _, field := range strings.FieldsFunc(output, func(r rune) bool {
		return !(r == '.' || r >= '0' && r <= '9')
	}) {
		if ip := net.ParseIP(field); ip != nil && ip.To4() != nil && ip.String() == expected {
			return true
		}
	}
	return false
}

func firstNonLoopbackIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ip, _, err := net.ParseCIDR(addr.String())
			if err == nil && ip.To4() != nil {
				return ip.String()
			}
		}
	}
	return ""
}

func printDoctor(report doctorReport) {
	for _, c := range report.Checks {
		icon := "!"
		switch c.Status {
		case doctorOK:
			icon = "✓"
		case doctorFail:
			icon = "✗"
		case doctorUnknown:
			icon = "?"
		}
		fmt.Printf("%s %-10s %-30s %s\n", icon, c.Section, c.Name, c.Summary)
		if doctorVerbose && c.Detail != "" {
			fmt.Printf("  %s\n", strings.ReplaceAll(strings.TrimSpace(c.Detail), "\n", "\n  "))
		}
	}
	if report.Failures > 0 || report.Warnings > 0 {
		fmt.Println()
		fmt.Println("Recovery: use `youeye logs <component>`, `youeye services restart <name>`, and `youeye setup status` before falling back to web UI.")
	}
}
