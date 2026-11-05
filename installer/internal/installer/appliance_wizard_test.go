package installer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestApplianceWizardCreatesValidatedAnswerFromKeyboardJourney(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	cfg := installConfig{}
	bundle.apply(&cfg)
	wizard := newApplianceWizardModel(cfg, &applianceExecutionRunner{})
	wizard.answerPath = filepath.Join(t.TempDir(), "answer.json")

	loaded, ok := wizard.Init()().(applianceWizardLoadedMsg)
	if !ok {
		t.Fatal("appliance wizard did not return its load result")
	}
	wizard, _ = wizard.Update(loaded)
	if wizard.err != nil || wizard.stage != applianceWizardTarget {
		t.Fatalf("load result = stage %v err %v", wizard.stage, wizard.err)
	}

	for _, expected := range []applianceWizardStage{
		applianceWizardNetwork,
		applianceWizardRelease,
		applianceWizardSSH,
		applianceWizardDevelopment,
	} {
		wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
		if wizard.stage != expected {
			t.Fatalf("stage = %v, want %v", wizard.stage, expected)
		}
	}
	for index := range wizard.developmentInputs {
		wizard.developmentInputs[index].SetValue("x")
	}
	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if wizard.stage != applianceWizardReview {
		t.Fatalf("stage = %v, want %v: %s", wizard.stage, applianceWizardReview, wizard.inputErr)
	}
	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if wizard.stage != applianceWizardErase || wizard.done {
		t.Fatalf("blank target bypassed erase confirmation: stage=%v done=%v", wizard.stage, wizard.done)
	}
	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyDown})
	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !wizard.done {
		t.Fatalf("wizard did not finish: %s", wizard.inputErr)
	}

	raw, err := os.ReadFile(wizard.answerPath)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := parseApplianceAnswer(raw)
	if err != nil {
		t.Fatal(err)
	}
	if answer.TargetSerial != "TARGET" || !validApplianceTransactionID(answer.TransactionID) || answer.Network.Mode != "dhcp" {
		t.Fatalf("unexpected answer: %+v", answer)
	}
	if answer.Operation != "erase-install" || !answer.EraseConfirmed {
		t.Fatalf("erase authorization missing: %+v", answer)
	}
	info, err := os.Stat(wizard.answerPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("answer mode = %o, want 600", info.Mode().Perm())
	}
}

func TestApplianceWizardDefaultsToNoForUsedTargets(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	cfg := installConfig{}
	bundle.apply(&cfg)
	runner := &wizardInventoryRunner{inventory: `{"blockdevices":[
		  {"name":"vda","path":"/dev/vda","type":"disk","size":137438953472,"model":"appliance","serial":"TARGET","rm":false,"ro":false,"mountpoints":[],"fstype":"ext4","label":"OLD-YOUEYE"}
    ]}`}
	wizard := newApplianceWizardModel(cfg, runner)
	wizard.answerPath = filepath.Join(t.TempDir(), "answer.json")
	wizard, _ = wizard.Update(wizard.Init()())
	for range 4 {
		wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
	}
	for index := range wizard.developmentInputs {
		wizard.developmentInputs[index].SetValue("x")
	}
	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if wizard.stage != applianceWizardReview {
		t.Fatalf("stage = %v, want review", wizard.stage)
	}
	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if wizard.stage != applianceWizardErase || wizard.done {
		t.Fatalf("used target bypassed erase confirmation: stage=%v done=%v", wizard.stage, wizard.done)
	}
	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if wizard.done || wizard.stage != applianceWizardReview || !strings.Contains(wizard.inputErr, "cancelled") {
		t.Fatalf("default No changed a disk: stage=%v done=%v err=%q", wizard.stage, wizard.done, wizard.inputErr)
	}

	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyDown})
	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !wizard.done {
		t.Fatalf("explicit Yes was rejected: %s", wizard.inputErr)
	}
	raw, err := os.ReadFile(wizard.answerPath)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := parseApplianceAnswer(raw)
	if err != nil {
		t.Fatal(err)
	}
	if answer.Operation != "erase-install" || !answer.EraseConfirmed {
		t.Fatalf("used-disk authorization missing: %+v", answer)
	}
}

func TestApplianceWizardRejectsDuplicateDiskIdentity(t *testing.T) {
	wizard := applianceWizardModel{disks: []applianceDisk{
		{Path: "/dev/vda", Serial: "DUPLICATE", SizeBytes: 64 * applianceGiB},
		{Path: "/dev/vdb", Serial: "duplicate", SizeBytes: 128 * applianceGiB},
	}}
	if err := wizard.diskCandidateError(0); err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("expected duplicate identity rejection, got %v", err)
	}
}

func TestTopLevelInstallerStartsInstallerMediaWizard(t *testing.T) {
	model := NewWithOptions(CLIOptions{Mode: "install"})
	if model.phase != phaseInstallerWizard {
		t.Fatalf("phase = %v, want installer media wizard", model.phase)
	}
}

func TestApplianceCompleteViewPromptsForMediaRemoval(t *testing.T) {
	view := newCompleteModel().View()
	for _, text := range []string{"YouEye installed", "Remove the installer media", "System A"} {
		if !strings.Contains(view, text) {
			t.Fatalf("complete view missing %q: %s", text, view)
		}
	}
}

func TestApplianceWizardNetworkSnapshotsAreDeterministicAndAdapterBound(t *testing.T) {
	wizard := newApplianceWizardModel(installConfig{}, &applianceExecutionRunner{})
	wizard.stage = applianceWizardNetwork
	wizard.disks = []applianceDisk{{Path: "/dev/vda", Serial: "TARGET", SizeBytes: 64 * applianceGiB}}
	wizard.adapters = []applianceNetworkAdapter{
		{Name: "enp1s0", MAC: "02:00:00:00:00:01"},
		{Name: "enp2s0", MAC: "02:00:00:00:00:02"},
	}

	for _, size := range []tea.WindowSizeMsg{{Width: 120, Height: 40}, {Width: 72, Height: 22}, {Width: 48, Height: 14}} {
		resized, _ := wizard.Update(size)
		first, second := resized.View(), resized.View()
		if first != second || !strings.Contains(first, "Wired adapter") || !strings.Contains(first, "enp1s0") {
			t.Fatalf("direct Installer %dx%d network snapshot is unstable or incomplete", size.Width, size.Height)
		}
	}

	wizard, _ = wizard.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	if answer := wizard.networkAnswer(); answer.AdapterMAC != "02:00:00:00:00:02" {
		t.Fatalf("adapter selection was not bound into the answer: %+v", answer)
	}
}

type wizardInventoryRunner struct {
	inventory string
}

func (r *wizardInventoryRunner) Run(name string, args ...string) (string, error) {
	if name == "lsblk" {
		return r.inventory, nil
	}
	return "", nil
}
