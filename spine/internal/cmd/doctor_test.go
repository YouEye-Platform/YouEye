package cmd

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

func TestCheckContainerSystemdUsesControlContainer(t *testing.T) {
	oldRun := doctorRunCommand
	t.Cleanup(func() { doctorRunCommand = oldRun })

	var got []string
	doctorRunCommand = func(name string, args ...string) (string, error) {
		got = append([]string{name}, args...)
		return "active\n", nil
	}

	check := checkContainerSystemd("platform", "youeye-control service", "youeye-control", "youeye-control.service")
	if check.Status != doctorOK {
		t.Fatalf("status = %s, want ok", check.Status)
	}
	want := []string{"incus", "exec", "youeye-control", "--", "systemctl", "is-active", "youeye-control.service"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("command = %q, want %q", strings.Join(got, " "), strings.Join(want, " "))
	}
}

func TestCheckCaddyAdminInContainerUsesExecCurl(t *testing.T) {
	oldRun := doctorRunCommand
	t.Cleanup(func() { doctorRunCommand = oldRun })

	var got []string
	doctorRunCommand = func(name string, args ...string) (string, error) {
		got = append([]string{name}, args...)
		return "200", nil
	}

	check := checkCaddyAdminInContainer("youeye-caddy")
	if check.Status != doctorOK {
		t.Fatalf("status = %s, want ok", check.Status)
	}
	if strings.Join(got[:4], " ") != "incus exec youeye-caddy --" {
		t.Fatalf("unexpected command prefix: %q", strings.Join(got, " "))
	}
}

func TestCheckBridgeTokenRequiresHostAndContainerCopies(t *testing.T) {
	oldRead := doctorReadFile
	oldRun := doctorRunCommand
	t.Cleanup(func() {
		doctorReadFile = oldRead
		doctorRunCommand = oldRun
	})

	doctorReadFile = func(path string) ([]byte, error) {
		if path == "/var/lib/youeye/control/.bridge_token" {
			return []byte(strings.Repeat("a", 64)), nil
		}
		return nil, errors.New("unexpected path")
	}
	doctorRunCommand = func(name string, args ...string) (string, error) {
		if name != "incus" {
			t.Fatalf("unexpected command %q", name)
		}
		return strings.Repeat("a", 64), nil
	}

	check := checkBridgeToken("/var/lib/youeye/control/.bridge_token", "youeye-control", "youeye-ui")
	if check.Status != doctorOK {
		t.Fatalf("status = %s, want ok", check.Status)
	}
}

func TestCheckBridgeTokenRejectsMismatchedCopy(t *testing.T) {
	oldRead := doctorReadFile
	oldRun := doctorRunCommand
	t.Cleanup(func() {
		doctorReadFile = oldRead
		doctorRunCommand = oldRun
	})

	doctorReadFile = func(path string) ([]byte, error) {
		return []byte(strings.Repeat("a", 64)), nil
	}
	doctorRunCommand = func(name string, args ...string) (string, error) {
		return strings.Repeat("b", 64), nil
	}

	check := checkBridgeToken("/var/lib/youeye/control/.bridge_token", "youeye-control")
	if check.Status != doctorFail {
		t.Fatalf("status = %s, want failure", check.Status)
	}
}

func TestCheckBridgeTokenFailsWhenContainerCopyMissing(t *testing.T) {
	oldRead := doctorReadFile
	oldRun := doctorRunCommand
	t.Cleanup(func() {
		doctorReadFile = oldRead
		doctorRunCommand = oldRun
	})

	doctorReadFile = func(path string) ([]byte, error) {
		return []byte(strings.Repeat("a", 64)), nil
	}
	doctorRunCommand = func(name string, args ...string) (string, error) {
		return "", errors.New("missing")
	}

	check := checkBridgeToken("/var/lib/youeye/control/.bridge_token", "youeye-control")
	if check.Status != doctorFail {
		t.Fatalf("status = %s, want failure", check.Status)
	}
}

func TestPostgresProbeKeepsPasswordOutOfArguments(t *testing.T) {
	oldRead := doctorReadFile
	oldRun := doctorRunCommandWithInput
	t.Cleanup(func() {
		doctorReadFile = oldRead
		doctorRunCommandWithInput = oldRun
	})

	const password = "sensitive-test-value"
	doctorReadFile = func(path string) ([]byte, error) {
		return []byte(password), nil
	}
	doctorRunCommandWithInput = func(input, name string, args ...string) (string, error) {
		if input != password+"\n" {
			t.Fatalf("stdin was not the password payload")
		}
		if strings.Contains(strings.Join(append([]string{name}, args...), " "), password) {
			t.Fatalf("password leaked into command arguments")
		}
		return "1\n", nil
	}

	check := checkPostgresCredentialed()
	if check.Status != doctorOK {
		t.Fatalf("status = %s, want ok", check.Status)
	}
}

func TestUnknownSectionFails(t *testing.T) {
	report := runDoctor("not-a-section")
	if report.Failures != 1 || len(report.Checks) != 1 || report.Checks[0].Status != doctorFail {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestDeferredSectionDoesNotClaimSuccess(t *testing.T) {
	report := runDoctor("storage")
	if len(report.Checks) != 1 || report.Checks[0].Status != doctorUnknown {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestFirstIPv4InText(t *testing.T) {
	if got := firstIPv4InText("10.251.54.14 (eth0)"); got != "10.251.54.14" {
		t.Fatalf("got %q", got)
	}
}

func TestDoctorHostDNSCheckWarnsWhenHostResolverMisses(t *testing.T) {
	oldRun := doctorRunCommand
	t.Cleanup(func() { doctorRunCommand = oldRun })

	doctorRunCommand = func(name string, args ...string) (string, error) {
		if strings.Join(append([]string{name}, args...), " ") != "getent ahostsv4 devvm.test" {
			t.Fatalf("unexpected command: %s", strings.Join(append([]string{name}, args...), " "))
		}
		return "", errors.New("not found")
	}

	check := doctorHostDNSCheck("devvm.test", "192.0.2.10")
	if check.Status != doctorWarn {
		t.Fatalf("status = %s, want warning", check.Status)
	}
	if !strings.Contains(check.Summary, "authoritative Pi-hole checks determine appliance DNS health") {
		t.Fatalf("summary = %q, want authoritative Pi-hole explanation", check.Summary)
	}
}

func TestDoctorHostDNSCheckSucceedsWhenHostResolverMatches(t *testing.T) {
	oldRun := doctorRunCommand
	t.Cleanup(func() { doctorRunCommand = oldRun })

	doctorRunCommand = func(name string, args ...string) (string, error) {
		return "192.0.2.10 STREAM devvm.test\n", nil
	}

	check := doctorHostDNSCheck("devvm.test", "192.0.2.10")
	if check.Status != doctorOK {
		t.Fatalf("status = %s, want ok", check.Status)
	}
}

func TestDoctorIPv4LookupRequestsOnlyARecords(t *testing.T) {
	oldDial := doctorDNSDialContext
	t.Cleanup(func() { doctorDNSDialContext = oldDial })
	wantErr := errors.New("dial stopped for test")
	doctorDNSDialContext = func(_ context.Context, network, address string) (net.Conn, error) {
		if network != "udp" || address != "10.251.54.14:53" {
			t.Fatalf("unexpected DNS dial: %s %s", network, address)
		}
		return nil, wantErr
	}
	if _, err := doctorIPv4Lookup("devvm.test", "10.251.54.14"); err == nil || !strings.Contains(err.Error(), wantErr.Error()) {
		t.Fatalf("doctorIPv4Lookup error = %v, want error containing %q", err, wantErr)
	}
}

func TestDoctorIPv4LookupRejectsInvalidServer(t *testing.T) {
	if _, err := doctorIPv4Lookup("devvm.test", "not-an-ip"); err == nil {
		t.Fatal("doctorIPv4Lookup accepted an invalid DNS server")
	}
}

func TestDoctorDoesNotInferApplicationReadinessFromRunningContainer(t *testing.T) {
	check := doctorReportedAppCheck(map[string]interface{}{"id": "example", "status": "running"})
	if check.Status != doctorUnknown || !strings.Contains(check.Summary, "not reported") {
		t.Fatalf("unverified readiness: %+v", check)
	}
}

func TestDoctorPointerRequiresApplicationReadiness(t *testing.T) {
	oldRun := doctorRunCommand
	t.Cleanup(func() { doctorRunCommand = oldRun })
	for _, tc := range []struct {
		name, body   string
		commandError bool
		want         doctorStatus
	}{
		{"ready", `{"status":"ok"}`, false, doctorOK},
		{"degraded", `{"status":"degraded"}`, false, doctorWarn},
		{"missing-server", "", true, doctorFail},
		{"invalid-body", "not-json", false, doctorFail},
		{"empty-object", `{}`, false, doctorFail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doctorRunCommand = func(name string, args ...string) (string, error) {
				if name != "incus" || !strings.Contains(strings.Join(args, " "), "127.0.0.1:4001/readyz") {
					t.Fatalf("unexpected readiness command: %s %v", name, args)
				}
				if tc.commandError {
					return "", errors.New("connection refused")
				}
				return tc.body, nil
			}
			check := doctorReportedAppCheck(map[string]interface{}{"id": "pointer", "status": "running"})
			if check.Status != tc.want {
				t.Fatalf("check=%+v, want %s", check, tc.want)
			}
		})
	}
}
