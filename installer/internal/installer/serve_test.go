package installer

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"golang.org/x/crypto/ssh"
)

func TestServeListenIsLoopbackOnly(t *testing.T) {
	for _, listen := range []string{"127.0.0.1:8090", "[::1]:8090", "localhost:8090", "127.0.0.1:1"} {
		if _, err := validateServeListen(listen); err != nil {
			t.Errorf("%s refused: %v", listen, err)
		}
	}
	for _, listen := range []string{"0.0.0.0:8090", ":8090", "192.168.1.20:8090", "[::]:8090", "example.com:8090", "127.0.0.1:0", "127.0.0.1:http", "127.0.0.1"} {
		if _, err := validateServeListen(listen); err == nil {
			t.Errorf("%s accepted", listen)
		}
	}
}

func TestParseOptionsServe(t *testing.T) {
	opts, err := ParseOptions([]string{"serve"}, nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	mode, err := SelectedInstallerMode(opts)
	if err != nil || mode != InstallerModeServe || opts.Listen != "127.0.0.1:8090" {
		t.Fatalf("serve = mode %q listen %q err %v", mode, opts.Listen, err)
	}
	opts, err = ParseOptions([]string{"serve", "--listen", "127.0.0.1:9000"}, nil, io.Discard)
	if err != nil || opts.Listen != "127.0.0.1:9000" {
		t.Fatalf("--listen = %q err %v", opts.Listen, err)
	}
	if err := RunInstallerServe(CLIOptions{Listen: "0.0.0.0:8090"}); err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("serve on all interfaces = %v", err)
	}
}

type serveHarness struct {
	t       *testing.T
	server  *installerServer
	http    *httptest.Server
	base    string
	engine  chan engineMsg
	started chan installConfig
}

func newServeHarness(t *testing.T) *serveHarness {
	t.Helper()
	stubWizardAdapters(t)
	bundle := writeTestApplianceBundle(t)
	cfg := installConfig{}
	bundle.apply(&cfg)
	h := &serveHarness{t: t, engine: make(chan engineMsg, 10), started: make(chan installConfig, 1)}
	h.server = newInstallerServer(cfg, &applianceExecutionRunner{}, io.Discard)
	h.server.answerPath = filepath.Join(t.TempDir(), "answer.json")
	h.server.start = func(config installConfig) <-chan engineMsg {
		h.started <- config
		return h.engine
	}
	h.server.load()
	h.http = httptest.NewServer(h.server.handler())
	t.Cleanup(h.http.Close)
	parsed, err := url.Parse(h.http.URL)
	if err != nil {
		t.Fatal(err)
	}
	h.server.port = parsed.Port()
	h.base = h.http.URL
	return h
}

func stubWizardAdapters(t *testing.T) {
	t.Helper()
	previous := listNetworkInterfaces
	listNetworkInterfaces = func() ([]net.Interface, error) {
		return []net.Interface{
			{Name: "enp1s0", HardwareAddr: net.HardwareAddr{0x02, 0, 0, 0, 0, 1}},
			{Name: "enp2s0", HardwareAddr: net.HardwareAddr{0x02, 0, 0, 0, 0, 2}},
		}, nil
	}
	t.Cleanup(func() { listNetworkInterfaces = previous })
}

func (h *serveHarness) post(path string, body any) (int, map[string]any) {
	h.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		h.t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, h.base+path, bytes.NewReader(raw))
	if err != nil {
		h.t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", h.base)
	return h.do(request)
}

func (h *serveHarness) get(path string) (int, map[string]any) {
	h.t.Helper()
	request, err := http.NewRequest(http.MethodGet, h.base+path, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	return h.do(request)
}

func (h *serveHarness) do(request *http.Request) (int, map[string]any) {
	h.t.Helper()
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

func testPublicSSHKey(t *testing.T) string {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))) + " owner@laptop"
}

// The web UI and the text wizard must write the same answer for the same
// choices: the transaction ID is the only difference.
func TestServeAndTextWizardWriteIdenticalAnswers(t *testing.T) {
	sshKey := testPublicSSHKey(t)
	cases := []struct {
		name    string
		keys    func(press func(...tea.KeyMsg), typeText func(string))
		choices applianceChoices
	}{
		{
			name: "defaults",
			keys: func(press func(...tea.KeyMsg), _ func(string)) {
				for range 5 { // disk, network, software, SSH, console access
					press(tea.KeyMsg{Type: tea.KeyEnter})
				}
			},
			choices: applianceChoices{Disk: "/dev/vda", AdapterMAC: "02:00:00:00:00:01", Network: "dhcp", Channel: "stable"},
		},
		{
			name: "static network, dev channel, custom repository, SSH key",
			keys: func(press func(...tea.KeyMsg), typeText func(string)) {
				press(tea.KeyMsg{Type: tea.KeyEnter})                                                    // disk
				press(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")}, tea.KeyMsg{Type: tea.KeyDown}) // second adapter, static
				typeText("192.0.2.10/24")
				press(tea.KeyMsg{Type: tea.KeyTab})
				typeText("192.0.2.1")
				press(tea.KeyMsg{Type: tea.KeyTab})
				typeText("192.0.2.53")
				press(tea.KeyMsg{Type: tea.KeyEnter})
				press(tea.KeyMsg{Type: tea.KeyUp}, tea.KeyMsg{Type: tea.KeyRight}, tea.KeyMsg{Type: tea.KeyTab}) // dev, custom source
				typeText("https://Forge.example.test/owner/YouEye.git")
				press(tea.KeyMsg{Type: tea.KeyEnter})
				press(tea.KeyMsg{Type: tea.KeyDown})
				typeText(sshKey)
				press(tea.KeyMsg{Type: tea.KeyEnter})
				press(tea.KeyMsg{Type: tea.KeyEnter}) // console access: keep root locked
			},
			choices: applianceChoices{
				Disk: "/dev/vda", AdapterMAC: "02:00:00:00:00:02", Network: "static",
				Address: "192.0.2.10/24", Gateway: "192.0.2.1", DNS: "192.0.2.53", Channel: "dev",
				Repository: "https://Forge.example.test/owner/YouEye.git", SSHKey: sshKey,
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newServeHarness(t)

			wizard := newApplianceWizardModel(h.server.config, &applianceExecutionRunner{})
			wizard.answerPath = filepath.Join(t.TempDir(), "answer.json")
			wizard, _ = wizard.Update(wizard.Init()())
			press := func(keys ...tea.KeyMsg) {
				for _, key := range keys {
					wizard, _ = wizard.Update(key)
				}
			}
			typeText := func(text string) {
				for _, character := range text {
					press(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{character}})
				}
			}
			tc.keys(press, typeText)
			if wizard.stage != applianceWizardReview {
				t.Fatalf("text wizard stage = %v, want review: %s", wizard.stage, wizard.inputErr)
			}
			press(tea.KeyMsg{Type: tea.KeyEnter}, tea.KeyMsg{Type: tea.KeyDown}, tea.KeyMsg{Type: tea.KeyEnter})
			if !wizard.done {
				t.Fatalf("text wizard did not finish: %s", wizard.inputErr)
			}

			if status, body := h.post("/api/check", tc.choices); status != http.StatusOK {
				t.Fatalf("check = %d %v", status, body)
			}
			if status, body := h.post("/api/console", serveConsoleRequest{}); status != http.StatusOK {
				t.Fatalf("console = %d %v", status, body)
			}
			if status, body := h.post("/api/install", serveInstallRequest{Choices: tc.choices, EraseConfirmed: true}); status != http.StatusAccepted {
				t.Fatalf("install = %d %v", status, body)
			}
			started := <-h.started
			if started.ApplianceAnswerPath != h.server.answerPath {
				t.Fatalf("engine answer path = %q", started.ApplianceAnswerPath)
			}

			text, web := readAnswerJSON(t, wizard.answerPath), readAnswerJSON(t, h.server.answerPath)
			for _, answer := range []map[string]any{text, web} {
				if id, _ := answer["transaction_id"].(string); !validApplianceTransactionID(id) {
					t.Fatalf("transaction id = %v", answer["transaction_id"])
				}
				delete(answer, "transaction_id")
			}
			if !reflect.DeepEqual(text, web) {
				t.Fatalf("answers differ:\ntext %v\nweb  %v", text, web)
			}
		})
	}
}

func readAnswerJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseApplianceAnswer(raw); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestServeRefusesForeignHostsOriginsAndForms(t *testing.T) {
	h := newServeHarness(t)

	request, _ := http.NewRequest(http.MethodGet, h.base+"/api/state", nil)
	request.Host = "attacker.example:" + h.server.port
	if status, _ := h.do(request); status != http.StatusMisdirectedRequest {
		t.Fatalf("rebound host = %d", status)
	}
	request, _ = http.NewRequest(http.MethodGet, h.base+"/", nil)
	request.Host = "127.0.0.1:1"
	if status, _ := h.do(request); status != http.StatusMisdirectedRequest {
		t.Fatalf("other port = %d", status)
	}

	body := `{"disk":"/dev/vda","network":"dhcp","channel":"stable"}`
	request, _ = http.NewRequest(http.MethodPost, h.base+"/api/check", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://attacker.example")
	if status, _ := h.do(request); status != http.StatusForbidden {
		t.Fatalf("cross-origin write = %d", status)
	}
	request, _ = http.NewRequest(http.MethodPost, h.base+"/api/install", strings.NewReader(body))
	request.Header.Set("Content-Type", "text/plain")
	if status, _ := h.do(request); status != http.StatusUnsupportedMediaType {
		t.Fatalf("form-style write = %d", status)
	}

	response, err := http.Get(h.base + "/")
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(response.Body)
	response.Body.Close()
	csp := response.Header.Get("Content-Security-Policy")
	if response.StatusCode != http.StatusOK || !strings.Contains(string(page), "/installer.js") || !strings.Contains(csp, "default-src 'self'") || !strings.Contains(csp, "form-action 'none'") {
		t.Fatalf("index = %d csp %q", response.StatusCode, csp)
	}
	for _, asset := range []string{"/installer.js", "/installer.css", "/youeye-symbol.svg"} {
		response, err := http.Get(h.base + asset)
		if err != nil {
			t.Fatal(err)
		}
		content, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || len(content) == 0 {
			t.Fatalf("%s = %d", asset, response.StatusCode)
		}
	}
	for _, name := range []string{"index.html", "installer.css"} {
		raw, err := installerWebFiles.ReadFile("web/" + name)
		if err != nil {
			t.Fatal(err)
		}
		for _, external := range []string{"http://", "https://", "<a ", "style=\"", "<script>"} {
			if bytes.Contains(raw, []byte(external)) {
				t.Fatalf("%s contains %q", name, external)
			}
		}
	}
	// The script only talks to its own origin and never navigates.
	script, err := installerWebFiles.ReadFile("web/installer.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"http://", "location", "innerHTML", "eval(", "fetch('http", "EventSource('http"} {
		if bytes.Contains(script, []byte(forbidden)) {
			t.Fatalf("installer.js contains %q", forbidden)
		}
	}
}

func TestServeStateDescribesDrivesAndAdapters(t *testing.T) {
	h := newServeHarness(t)
	status, state := h.get("/api/state")
	if status != http.StatusOK || state["phase"] != "choose" || state["default_disk"] != "/dev/vda" {
		t.Fatalf("state = %d %v", status, state)
	}
	disks, _ := state["disks"].([]any)
	adapters, _ := state["adapters"].([]any)
	if len(disks) != 1 || len(adapters) != 2 {
		t.Fatalf("disks %v adapters %v", disks, adapters)
	}
	if disk := disks[0].(map[string]any); disk["size"] != "128 GiB" || disk["serial"] != "TARGET" {
		t.Fatalf("disk = %v", disk)
	}
	if status, body := h.post("/api/check", applianceChoices{Disk: "/dev/sdz", Network: "dhcp", Channel: "stable"}); status != http.StatusUnprocessableEntity || body["error"] == nil {
		t.Fatalf("unknown disk = %d %v", status, body)
	}
	if status, body := h.post("/api/check", applianceChoices{Disk: "/dev/vda", Network: "static", Address: "nope", Channel: "stable"}); status != http.StatusUnprocessableEntity || !strings.Contains(body["error"].(string), "static address") {
		t.Fatalf("bad static address = %d %v", status, body)
	}
	if status, _ := h.post("/api/install", serveInstallRequest{Choices: applianceChoices{Disk: "/dev/vda", Network: "dhcp", Channel: "stable"}}); status != http.StatusUnprocessableEntity {
		t.Fatalf("install without confirmation = %d", status)
	}
	if _, err := os.Stat(h.server.answerPath); !os.IsNotExist(err) {
		t.Fatalf("an unconfirmed install wrote an answer: %v", err)
	}
}

func TestServeConsoleAccessHashesTheRootPassword(t *testing.T) {
	h := newServeHarness(t)
	if status, body := h.post("/api/console", serveConsoleRequest{RootPassword: true, Password: "one", Confirm: "two"}); status != http.StatusUnprocessableEntity || !strings.Contains(body["error"].(string), "do not match") {
		t.Fatalf("mismatch = %d %v", status, body)
	}
	status, body := h.post("/api/console", serveConsoleRequest{RootPassword: true, PasswordSSH: true, Password: "emergency pass", Confirm: "emergency pass"})
	if status != http.StatusOK || !strings.Contains(body["console"].(string), "password SSH") {
		t.Fatalf("console = %d %v", status, body)
	}
	// Blank fields keep the password chosen before, as in the text wizard.
	if status, body := h.post("/api/console", serveConsoleRequest{RootPassword: true}); status != http.StatusOK || body["root_password_set"] != true {
		t.Fatalf("keep = %d %v", status, body)
	}
	if status, body := h.post("/api/install", serveInstallRequest{Choices: applianceChoices{Disk: "/dev/vda", Network: "dhcp", Channel: "stable"}, EraseConfirmed: true}); status != http.StatusAccepted {
		t.Fatalf("install = %d %v", status, body)
	}
	raw, err := os.ReadFile(h.server.answerPath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("emergency pass")) {
		t.Fatal("the root password was written in plain text")
	}
	answer, err := parseApplianceAnswer(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !validYescryptHash(answer.ConsoleAccess.RootPasswordHash) || answer.ConsoleAccess.PasswordSSH {
		t.Fatalf("console access = %+v", answer.ConsoleAccess)
	}
}

func TestServeStreamsProgressOneSessionThenPowersOff(t *testing.T) {
	h := newServeHarness(t)
	choices := applianceChoices{Disk: "/dev/vda", Network: "dhcp", Channel: "stable"}
	if status, body := h.post("/api/install", serveInstallRequest{Choices: choices, EraseConfirmed: true}); status != http.StatusAccepted {
		t.Fatalf("install = %d %v", status, body)
	}
	<-h.started
	if status, _ := h.post("/api/install", serveInstallRequest{Choices: choices, EraseConfirmed: true}); status != http.StatusConflict {
		t.Fatalf("second install = %d", status)
	}
	if status, _ := h.post("/api/check", choices); status != http.StatusConflict {
		t.Fatalf("choices after start = %d", status)
	}
	if status, _ := h.post("/api/poweroff", map[string]any{}); status != http.StatusConflict {
		t.Fatalf("power-off while writing = %d", status)
	}

	response, err := http.Get(h.base + "/api/progress")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("progress content type = %q", response.Header.Get("Content-Type"))
	}
	h.engine <- engineMsg{StepName: "Write System A", LogLine: "system-root.img", Percent: 0.4}
	h.engine <- engineMsg{StepName: "Verify", Percent: 0.3}
	h.engine <- engineMsg{Done: true, Percent: 1}

	var events []serveProgress
	scanner := bufio.NewScanner(response.Body)
	deadline := time.AfterFunc(5*time.Second, func() { response.Body.Close() })
	defer deadline.Stop()
	for scanner.Scan() {
		if data, ok := strings.CutPrefix(scanner.Text(), "data: "); ok {
			var event serveProgress
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				t.Fatal(err)
			}
			events = append(events, event)
		}
	}
	if len(events) != 4 || events[1].Stage != "Write System A" || events[2].Percent != 0.4 || !events[3].Done || events[3].Error != "" {
		t.Fatalf("events = %+v", events)
	}
	if status, state := h.get("/api/state"); status != http.StatusOK || state["phase"] != "complete" {
		t.Fatalf("state after install = %v", state)
	}
	if status, _ := h.post("/api/poweroff", map[string]any{}); status != http.StatusAccepted {
		t.Fatalf("power-off = %d", status)
	}
	select {
	case <-h.server.finished:
	case <-time.After(time.Second):
		t.Fatal("power-off did not end the session")
	}
}

func TestServeReportsEngineFailure(t *testing.T) {
	h := newServeHarness(t)
	log := &lockedBuffer{}
	h.server.log = log
	if status, _ := h.post("/api/install", serveInstallRequest{Choices: applianceChoices{Disk: "/dev/vda", Network: "dhcp", Channel: "stable"}, EraseConfirmed: true}); status != http.StatusAccepted {
		t.Fatal("install refused")
	}
	<-h.started
	h.engine <- engineMsg{StepName: "Partition", Percent: 0.2}
	h.engine <- engineMsg{Err: io.ErrUnexpectedEOF, Done: true}
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, state := h.get("/api/state")
		if state["phase"] == "failed" {
			progress := state["progress"].(map[string]any)
			if !strings.Contains(progress["error"].(string), "unexpected EOF") {
				t.Fatalf("progress = %v", progress)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("state = %v", state)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(log.String(), "[ 20%] Partition") || !strings.Contains(log.String(), "installation failed") {
		t.Fatalf("plain progress text = %q", log.String())
	}
}

type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func TestServeRecordsThatThePagePainted(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "ui-ready")
	t.Setenv("YOUEYE_KIOSK_READY_FILE", ready)
	h := newServeHarness(t)
	if code, _ := h.post("/api/ui-ready", map[string]any{}); code != http.StatusNoContent {
		t.Fatalf("ui-ready = %d", code)
	}
	if _, err := os.Stat(ready); err != nil {
		t.Fatalf("ready file not written: %v", err)
	}
}
