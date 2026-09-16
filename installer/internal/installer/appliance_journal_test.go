package installer

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestParseApplianceInstallJournalIsStrictAndResumable(t *testing.T) {
	journal := applianceInstallJournal{
		Schema: applianceInstallJournalSchema, Operation: "erase-install", ManifestSHA256: validSHA256(),
		TransactionID: "0123456789abcdef0123456789abcdef",
		ImageVersion:  "0.6.0-dev.1", Stage: stageWriteSystemA,
		TargetDisk: "/dev/vda", TargetSerial: "TARGET",
	}
	raw, err := json.Marshal(journal)
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseApplianceInstallJournal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Stage != stageWriteSystemA || got.TargetSerial != "TARGET" {
		t.Fatalf("unexpected journal: %+v", got)
	}
	if _, err := parseApplianceInstallJournal(append(raw[:len(raw)-1], []byte(`,"unknown":true}`)...)); err == nil {
		t.Fatal("unknown journal field was accepted")
	}
	journal.TransactionID = "NOT-A-TRANSACTION"
	raw, _ = json.Marshal(journal)
	if _, err := parseApplianceInstallJournal(raw); err == nil || !strings.Contains(err.Error(), "transaction") {
		t.Fatalf("expected malformed transaction rejection, got %v", err)
	}
	journal.TransactionID = "0123456789abcdef0123456789abcdef"
	journal.Stage = stagePartitionTarget
	raw, _ = json.Marshal(journal)
	if _, err := parseApplianceInstallJournal(raw); err == nil || !strings.Contains(err.Error(), "not resumable") {
		t.Fatalf("expected pre-journal stage rejection, got %v", err)
	}
}

func TestResumeCommandPlanVerifiesCompletedWritesAndSkipsDestructivePrefix(t *testing.T) {
	plan := applianceInstallPlan{
		TargetDiskPath: "/dev/vda", TargetSerial: "TARGET", RootSlotBytes: applianceRootSlotBytes,
	}
	assets := validCommandAssets()
	commands, err := applianceCommandPlan(plan, assets)
	if err != nil {
		t.Fatal(err)
	}
	resume, err := applianceResumeCommandPlan(commands, stageWriteSystemA, plan, assets)
	if err != nil {
		t.Fatal(err)
	}
	joined := commandStrings(resume)
	mkdirAt := strings.Index(joined, "mkdir -p "+systemMount+" "+espMount+" "+stateMount)
	mountAt := strings.Index(joined, "mount /dev/vda5 "+stateMount)
	if mkdirAt < 0 || mountAt < 0 || mkdirAt >= mountAt {
		t.Fatalf("resume plan did not create mountpoints before mounting State:\n%s", joined)
	}
	for _, forbidden := range []string{"sgdisk --zap-all /dev/vda", "youeye-payload-write " + assets.RootPayload.Path + " /dev/vda3"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("resume plan repeated completed destructive work %q:\n%s", forbidden, joined)
		}
	}
	for _, required := range []string{"youeye-payload-readback", "/dev/vda3", "youeye-payload-write", "/dev/vda4"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("resume plan missing %q:\n%s", required, joined)
		}
	}
}

func TestInstallJournalMatchRequiresSameTransactionIdentity(t *testing.T) {
	bundle := verifiedApplianceBundle{
		ManifestSHA256: validSHA256(),
		Manifest:       applianceBundleManifest{ImageVersion: "0.6.0-dev.1"},
	}
	journal := applianceInstallJournal{
		Operation:      "erase-install",
		TransactionID:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestSHA256: bundle.ManifestSHA256,
		ImageVersion:   bundle.Manifest.ImageVersion,
		TargetDisk:     "/dev/vda",
		TargetSerial:   "TARGET",
	}
	target := applianceDisk{Serial: "TARGET"}
	if !journal.matches(bundle, target, journal.TransactionID) {
		t.Fatal("same transaction did not match")
	}
	if journal.matches(bundle, target, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") {
		t.Fatal("different transaction matched the completed journal")
	}
	bundle.Manifest.ImageVersion = "0.6.0-dev.2"
	if journal.matches(bundle, target, journal.TransactionID) {
		t.Fatal("different signed image version matched the completed journal")
	}
}

func TestProviderRestartsConfirmedReinstallWhenTransactionDiffers(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	runner := &resumeExecutionRunner{journal: applianceInstallJournal{
		Schema: applianceInstallJournalSchema, Operation: "erase-install", TransactionID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestSHA256: bundle.manifestSHA, ImageVersion: "0.6.0-dev.1", Stage: stageVerifyInstall,
		TargetDisk: "/dev/vda", TargetSerial: "TARGET",
	}}
	answer := applianceAnswer{
		Schema: applianceAnswerSchema, Operation: "erase-install", EraseConfirmed: true,
		TransactionID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", TargetSerial: "TARGET",
		Network: applianceAnswerNetwork{Mode: "dhcp"}, ReleasePolicy: defaultApplianceReleasePolicy(), Development: defaultDevelopmentAccessPolicy(),
	}
	raw, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	answerPath := t.TempDir() + "/appliance-answer.json"
	if err := os.WriteFile(answerPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := installConfig{ApplianceAnswerPath: answerPath}
	bundle.apply(&cfg)
	ch := make(chan engineMsg, 256)
	installApplianceWithRunner(cfg, ch, runner)
	close(ch)
	var final engineMsg
	var restarted bool
	for msg := range ch {
		final = msg
		if msg.StepName == "Restart appliance install" && strings.Contains(msg.LogLine, "confirmed full erase") {
			restarted = true
		}
	}
	if final.Err != nil || !final.Done {
		t.Fatalf("confirmed reinstall did not restart cleanly: %+v", final)
	}
	joined := strings.Join(runner.calls, "\n")
	if !restarted || !strings.Contains(joined, "sgdisk --zap-all /dev/vda") {
		t.Fatalf("different transaction did not take the clean reinstall path:\n%s", joined)
	}
}

func TestResumeCommandPlanVerifiesRecoveryBootBackupsBeforeSkippingBootStage(t *testing.T) {
	plan := applianceInstallPlan{
		TargetDiskPath: "/dev/vda", TargetSerial: "TARGET", RootSlotBytes: applianceRootSlotBytes,
	}
	assets := validCommandAssets()
	commands, err := applianceCommandPlan(plan, assets)
	if err != nil {
		t.Fatal(err)
	}
	resume, err := applianceResumeCommandPlan(commands, stageInstallBootAssets, plan, assets)
	if err != nil {
		t.Fatal(err)
	}
	joined := commandStrings(resume)
	for _, backup := range []string{
		stateBootBackup + "/system-a.efi",
		stateBootBackup + "/system-b.efi",
		stateBootBackup + "/recovery.efi",
	} {
		if !strings.Contains(joined, "cmp -s") || !strings.Contains(joined, backup) {
			t.Fatalf("resume plan did not verify State boot backup %s:\n%s", backup, joined)
		}
	}
	if strings.Contains(joined, "install -m 0644 "+assets.SystemAUKIPath+" "+stateBootBackup) {
		t.Fatalf("resume plan repeated completed boot installation:\n%s", joined)
	}
}

func TestProviderResumesMatchingJournalWithoutRenewedErasePhrase(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	runner := &resumeExecutionRunner{journal: applianceInstallJournal{
		Schema: applianceInstallJournalSchema, Operation: "erase-install", TransactionID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ManifestSHA256: bundle.manifestSHA,
		ImageVersion: "0.6.0-dev.1", Stage: stageWriteSystemA,
		TargetDisk: "/dev/vda", TargetSerial: "TARGET",
	}}
	seed := applianceSeed{Schema: applianceSeedSchema, RigID: "rig", ArtifactID: "artifact", ManifestSHA256: bundle.manifestSHA,
		Operation: "resume", TransactionID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Profile: "profile", ProfileVersion: "v1",
		ProfileDigest: "digest", Scenario: "resume", TargetSerial: "TARGET"}
	raw, err := json.Marshal(seed)
	if err != nil {
		t.Fatal(err)
	}
	seedPath := t.TempDir() + "/seed.json"
	if err := os.WriteFile(seedPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := installConfig{ApplianceSeedPath: seedPath}
	bundle.apply(&cfg)
	ch := make(chan engineMsg, 256)
	installApplianceWithRunner(cfg, ch, runner)
	close(ch)
	var final engineMsg
	for msg := range ch {
		final = msg
	}
	if final.Err != nil || !final.Done {
		t.Fatalf("matching journal did not resume: %+v", final)
	}
	joined := strings.Join(runner.calls, "\n")
	if strings.Contains(joined, "sgdisk --zap-all /dev/vda") {
		t.Fatalf("resume zapped the system disk:\n%s", joined)
	}
	if !strings.Contains(joined, "youeye-payload-readback") || !strings.Contains(joined, "/dev/vda3") {
		t.Fatalf("resume did not verify completed System A:\n%s", joined)
	}
}

func TestProviderResumesPreserveJournalWithoutLayoutOrDataDestruction(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	runner := &resumeExecutionRunner{journal: applianceInstallJournal{
		Schema: applianceInstallJournalSchema, Operation: "preserve-reinstall",
		TransactionID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ManifestSHA256: bundle.manifestSHA,
		ImageVersion: "0.6.0-dev.1", Stage: stageWriteSystemA,
		TargetDisk: "/dev/vda", TargetSerial: "TARGET",
	}}
	seed := applianceSeed{Schema: applianceSeedSchema, RigID: "rig", ArtifactID: "artifact", ManifestSHA256: bundle.manifestSHA,
		Operation: "resume", TransactionID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Profile: "profile", ProfileVersion: "v1",
		ProfileDigest: "digest", Scenario: "resume-preserve", TargetSerial: "TARGET"}
	raw, err := json.Marshal(seed)
	if err != nil {
		t.Fatal(err)
	}
	seedPath := t.TempDir() + "/seed.json"
	if err := os.WriteFile(seedPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := installConfig{ApplianceSeedPath: seedPath}
	bundle.apply(&cfg)
	ch := make(chan engineMsg, 256)
	installApplianceWithRunner(cfg, ch, runner)
	close(ch)
	var final engineMsg
	for msg := range ch {
		final = msg
	}
	if final.Err != nil || !final.Done {
		t.Fatalf("matching preserve journal did not resume: %+v", final)
	}
	joined := strings.Join(runner.calls, "\n")
	for _, forbidden := range []string{"--zap-all", "wipefs", "mkfs.ext4", "mkfs.vfat"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("preserve resume contained destructive operation %q:\n%s", forbidden, joined)
		}
	}
	for _, required := range []string{"youeye-preserve-layout", "youeye-preserve-state", "youeye-payload-readback", "/dev/vda3", "of=/dev/vda4"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("preserve resume missing %q:\n%s", required, joined)
		}
	}
}

type resumeExecutionRunner struct {
	journal applianceInstallJournal
	calls   []string
}

func (r *resumeExecutionRunner) Run(name string, args ...string) (string, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if name == "lsblk" {
		return `{"blockdevices":[
		  {"name":"vda","path":"/dev/vda","type":"disk","size":137438953472,"model":"appliance","serial":"TARGET","rm":false,"ro":false,"mountpoints":[],"fstype":"gpt","label":""}
		]}`, nil
	}
	if name == "sh" && len(args) >= 3 && args[2] == "youeye-read-install-journal" {
		raw, err := json.Marshal(r.journal)
		return string(raw), err
	}
	return "", nil
}
