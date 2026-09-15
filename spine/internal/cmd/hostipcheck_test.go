package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestValidatePiholeAuthResponse(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{
			name:    "valid session",
			body:    `{"session":{"valid":true,"sid":"sid-123","csrf":"csrf-123","validity":1800}}`,
			wantErr: false,
		},
		{
			name:    "invalid session",
			body:    `{"session":{"valid":false,"message":"wrong password"}}`,
			wantErr: true,
		},
		{
			name:    "missing csrf",
			body:    `{"session":{"valid":true,"sid":"sid-123"}}`,
			wantErr: true,
		},
		{
			name:    "missing sid",
			body:    `{"session":{"valid":true,"csrf":"csrf-123"}}`,
			wantErr: true,
		},
		{
			name:    "missing session",
			body:    `{"error":{"message":"not ready"}}`,
			wantErr: true,
		},
		{
			name:    "malformed",
			body:    `not-json`,
			wantErr: true,
		},
		{
			name:    "empty",
			body:    ``,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePiholeAuthResponse([]byte(tt.body))
			if tt.wantErr && err == nil {
				t.Fatalf("expected error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected nil error, got %v", err)
			}
		})
	}
}

func TestControlPanelBootGuaranteeBeforeUnchangedIPReturn(t *testing.T) {
	sourceBytes, err := os.ReadFile("hostipcheck.go")
	if err != nil {
		t.Fatalf("read hostipcheck.go: %v", err)
	}
	source := string(sourceBytes)

	cpBootstrap := strings.Index(source, "if err := ensureControlPanelBootRunning")
	if cpBootstrap < 0 {
		t.Fatalf("host-IP startup path must call ensureControlPanelBootRunning")
	}

	unchangedReturn := strings.Index(source, `host IP unchanged (%s); pihole lifecycle handled`)
	if unchangedReturn < 0 {
		t.Fatalf("host-IP startup path must keep the unchanged-IP fast return")
	}
	if cpBootstrap > unchangedReturn {
		t.Fatalf("control panel boot guarantee must happen before unchanged-IP fast return")
	}
}

// The Incus readiness gate must run before ANY incus mutation in the
// migration. On cloned boots the daemon is socket-activated moments before
// the migration runs; mutating a starting daemon produced the torn
// proxy0/proxy1 state on clone .78 (2026-07-03).
func TestIncusReadinessGateBeforeFirstIncusMutation(t *testing.T) {
	source := readHostIPCheckSource(t)

	gate := strings.Index(source, "if err := waitForIncusReady(")
	if gate < 0 {
		t.Fatalf("runHostIPMigration must gate on waitForIncusReady")
	}
	firstMutation := strings.Index(source, "if err := ensurePiholeAutostartDisabled(")
	if firstMutation < 0 {
		t.Fatalf("expected ensurePiholeAutostartDisabled call (first incus touch)")
	}
	if gate > firstMutation {
		t.Fatalf("waitForIncusReady must be ordered before the first incus mutation")
	}
}

// Boot must be a convergence loop, not a one-shot: a failed startup attempt
// retries with backoff forever (appliance model — nobody is around to try
// again by hand).
func TestStartupIsConvergenceLoop(t *testing.T) {
	source := readHostIPCheckSource(t)

	if !strings.Contains(source, "startup retry %d") {
		t.Fatalf("runHostIPCheck must retry failed startup attempts")
	}
	if !strings.Contains(source, "bootRetryDelay(attempt)") {
		t.Fatalf("startup retries must use the bootRetryDelay backoff schedule")
	}
	if !strings.Contains(source, "runSteadyStateGuard()") {
		t.Fatalf("boot convergence must hand off to the steady-state guard")
	}
}

// The unchanged-IP startup path must report best-effort failures as errors
// so the convergence loop retries them. Silently swallowing them left
// clones with pihole down forever (clone .77, 2026-07-03).
func TestUnchangedPathSurfacesBootIssues(t *testing.T) {
	source := readHostIPCheckSource(t)

	if !strings.Contains(source, `fmt.Errorf("startup issues: %s", strings.Join(bootIssues, "; "))`) {
		t.Fatalf("unchanged-IP path must return collected bootIssues as an error")
	}
	if strings.Count(source, "bootIssues = append(bootIssues,") < 3 {
		t.Fatalf("proxy refresh, pihole start, and CP guarantee failures must all feed bootIssues")
	}
}

// Proxy device migration must verify writes by reading the device back —
// client-side timeouts are "unknown", not "failed" — and must reconcile
// both devices independently so it repairs split TCP/UDP state.
func TestProxyMigrationVerifiesBothDevices(t *testing.T) {
	source := readHostIPCheckSource(t)

	migStart := strings.Index(source, "func migratePiholeProxyDevice(")
	if migStart < 0 {
		t.Fatalf("migratePiholeProxyDevice must exist")
	}
	migBody := source[migStart:]
	if end := strings.Index(migBody[1:], "\nfunc "); end > 0 {
		migBody = migBody[:end+1]
	}
	if !strings.Contains(migBody, "range piholeProxyDevices") {
		t.Fatalf("migratePiholeProxyDevice must iterate both proxy devices")
	}
	if !strings.Contains(migBody, "waitForProxyListen(") {
		t.Fatalf("migratePiholeProxyDevice must verify each device with waitForProxyListen")
	}
	if !strings.Contains(source, `"incus", "config", "device", "get", "youeye-pihole"`) {
		t.Fatalf("proxy verification must read device state back via incus config device get")
	}
}

// The steady-state guard is Spine's self-healing duty for the two containers
// CP's watchdog explicitly excludes: pihole and the Control Panel.
func TestSteadyStateGuardCoversSpineOwnedContainers(t *testing.T) {
	source := readHostIPCheckSource(t)

	guardStart := strings.Index(source, "func checkSteadyState(")
	if guardStart < 0 {
		t.Fatalf("checkSteadyState must exist")
	}
	guardBody := source[guardStart:]
	if end := strings.Index(guardBody[1:], "\nfunc "); end > 0 {
		guardBody = guardBody[:end+1]
	}
	for _, needle := range []string{"youeye-pihole", "youeye-control", "piholeProxyDevices"} {
		if !strings.Contains(guardBody, needle) {
			t.Fatalf("checkSteadyState must cover %s", needle)
		}
	}
}

func TestBootRetryDelaySchedule(t *testing.T) {
	tests := []struct {
		attempt int
		want    string
	}{
		{1, "5s"},
		{2, "10s"},
		{3, "30s"},
		{4, "1m0s"},
		{15, "1m0s"},
		{16, "5m0s"},
		{100, "5m0s"},
	}
	for _, tt := range tests {
		if got := bootRetryDelay(tt.attempt).String(); got != tt.want {
			t.Fatalf("bootRetryDelay(%d) = %s, want %s", tt.attempt, got, tt.want)
		}
	}
}

func readHostIPCheckSource(t *testing.T) string {
	t.Helper()
	sourceBytes, err := os.ReadFile("hostipcheck.go")
	if err != nil {
		t.Fatalf("read hostipcheck.go: %v", err)
	}
	return string(sourceBytes)
}

// The host-IP migration must cover EVERY CP-container unit that carries an
// Environment=HOST_IP= line — youeye-id was left stale by pre-0.5.7
// migrations (observed two IP generations behind on clone .80, 2026-07-03).
func TestHostIPMigrationCoversIdentityService(t *testing.T) {
	source := readHostIPCheckSource(t)

	if !strings.Contains(source, `cpHostIPServices = []string{"youeye-control", "youeye-id"}`) {
		t.Fatalf("cpHostIPServices must list youeye-control and youeye-id")
	}
	if !strings.Contains(source, `syncUnitHostIP("youeye-id", newIP)`) {
		t.Fatalf("migrateControlHostIPEnv must sync youeye-id's unit HOST_IP")
	}
	if !strings.Contains(source, `syncUnitHostIP("youeye-control", newIP)`) {
		t.Fatalf("migrateControlHostIPEnv must sync youeye-control's unit HOST_IP")
	}
}

// A stale unit HOST_IP can never be repaired by the IP-change path once
// .host_ip matches the live IP, so the unchanged-IP boot path (and the
// steady-state guard through it) must verify and repair the unit files.
func TestUnchangedPathVerifiesUnitHostIP(t *testing.T) {
	source := readHostIPCheckSource(t)

	verify := strings.Index(source, "if err := verifyCPUnitHostIPEnv(current); err != nil")
	if verify < 0 {
		t.Fatalf("unchanged-IP path must call verifyCPUnitHostIPEnv")
	}
	unchangedReturn := strings.Index(source, `host IP unchanged (%s); pihole lifecycle handled`)
	if unchangedReturn < 0 {
		t.Fatalf("expected the unchanged-IP fast return to exist")
	}
	if verify > unchangedReturn {
		t.Fatalf("unit HOST_IP verification must run before the unchanged-IP fast return")
	}

	if !strings.Contains(source, "readUnitHostIP(service)") {
		t.Fatalf("checkSteadyState must probe unit HOST_IP drift via readUnitHostIP")
	}
}
