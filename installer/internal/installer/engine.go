package installer

import (
	"encoding/json"
	"os/exec"
	"strings"
)

type engineMsg struct {
	StepName string
	LogLine  string
	Percent  float64
	Done     bool
	Err      error
	ResultIP string
}

func startEngine(config installConfig) <-chan engineMsg {
	ch := make(chan engineMsg, 200)
	go func() {
		defer close(ch)
		installAppliance(config, ch)
	}()
	return ch
}

func send(ch chan<- engineMsg, step, log string, percent float64) {
	ch <- engineMsg{StepName: step, LogLine: log, Percent: percent}
}

func sendErr(ch chan<- engineMsg, err error) {
	ch <- engineMsg{Err: err, Done: true}
}

func sendDone(ch chan<- engineMsg, result string) {
	ch <- engineMsg{Done: true, ResultIP: result, Percent: 1}
}

func run(name string, args ...string) (string, error) {
	command := exec.Command(name, args...)
	output, err := command.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

// guestExecResult is the JSON payload returned by qm guest exec. The qm
// process can exit successfully even when the command inside the guest fails,
// so callers must inspect ExitCode.
type guestExecResult struct {
	OutData  string `json:"out-data"`
	ErrData  string `json:"err-data"`
	ExitCode int    `json:"exitcode"`
	Exited   int    `json:"exited"`
}

func clip(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) > limit {
		return value[:limit] + "…"
	}
	return value
}

// parseVMIP extracts a routable IPv4 address from the variants returned by
// qm agent network-get-interfaces.
func parseVMIP(output string) string {
	type networkInterface struct {
		Name        string `json:"name"`
		IPAddresses []struct {
			IPAddress string `json:"ip-address"`
			IPType    string `json:"ip-address-type"`
		} `json:"ip-addresses"`
	}

	var interfaces []networkInterface
	if err := json.Unmarshal([]byte(output), &interfaces); err != nil {
		var returned struct {
			Return []networkInterface `json:"return"`
		}
		if err := json.Unmarshal([]byte(output), &returned); err == nil {
			interfaces = returned.Return
		} else {
			var result struct {
				Result []networkInterface `json:"result"`
			}
			if err := json.Unmarshal([]byte(output), &result); err != nil {
				return ""
			}
			interfaces = result.Result
		}
	}

	for _, networkInterface := range interfaces {
		if networkInterface.Name == "lo" {
			continue
		}
		for _, address := range networkInterface.IPAddresses {
			if address.IPType == "ipv4" &&
				!strings.HasPrefix(address.IPAddress, "127.") &&
				!strings.HasPrefix(address.IPAddress, "169.254.") {
				return address.IPAddress
			}
		}
	}
	return ""
}
