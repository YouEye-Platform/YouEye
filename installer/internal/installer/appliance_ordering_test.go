package installer

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFullEraseTargetCheckAllowsAnyExistingReleaseIdentity(t *testing.T) {
	selected := applianceDisk{Path: "/dev/vda", Serial: "TARGET", SizeBytes: 128 * applianceGiB, Signatures: []string{"label:YE-STATE"}}
	current := selected
	current.Signatures = []string{"label:FOREIGN", "partition:old-system"}
	if err := verifyApplianceTargetUnchanged(selected, current); err != nil {
		t.Fatalf("confirmed full erase was incorrectly coupled to existing contents: %v", err)
	}
}

func TestFullEraseTargetCheckRejectsIdentityAndSafetyDrift(t *testing.T) {
	selected := applianceDisk{Path: "/dev/vda", Serial: "TARGET", SizeBytes: 128 * applianceGiB}
	for name, current := range map[string]applianceDisk{
		"path":    {Path: "/dev/vdb", Serial: "TARGET", SizeBytes: 128 * applianceGiB},
		"serial":  {Path: "/dev/vda", Serial: "OTHER", SizeBytes: 128 * applianceGiB},
		"size":    {Path: "/dev/vda", Serial: "TARGET", SizeBytes: 127 * applianceGiB},
		"mounted": {Path: "/dev/vda", Serial: "TARGET", SizeBytes: 128 * applianceGiB, Mounted: true},
	} {
		t.Run(name, func(t *testing.T) {
			if err := verifyApplianceTargetUnchanged(selected, current); err == nil {
				t.Fatal("expected target drift rejection")
			}
		})
	}
}

func TestInstalledIdentityShowsTheRecordedReleaseNeverTheImage(t *testing.T) {
	manifest := base64.StdEncoding.EncodeToString([]byte(`{"schema":"` + applianceBundleSchema + `","image_version":"0.6.13-dev.4"}`))
	for name, test := range map[string]struct{ out, release, installed, existing string }{
		"committed release": {manifest + "\n0.6.13\n", "0.6.13", "Installed YouEye: 0.6.13", "YouEye 0.6.13"},
		"dev release":       {manifest + "\n0.6.13-dev.4\n", "0.6.13-dev.4", "Installed YouEye: 0.6.13-dev.4", "YouEye 0.6.13-dev.4"},
		"no release":        {manifest + "\n\n", "", "Installed YouEye", "YouEye"},
		"old output":        {manifest + "\n", "", "Installed YouEye", "YouEye"},
		"not a release":     {manifest + "\n\x1b[31m0.6.13; rm\n", "", "Installed YouEye", "YouEye"},
	} {
		t.Run(name, func(t *testing.T) {
			identity, err := parseInstalledApplianceIdentity(test.out)
			if err != nil || identity == nil {
				t.Fatalf("identity = %v, %v", identity, err)
			}
			if identity.ImageVersion != "0.6.13-dev.4" || identity.ReleaseVersion != test.release {
				t.Fatalf("identity = %+v", identity)
			}
			if got := identity.label("Installed YouEye", ": "); got != test.installed {
				t.Fatalf("disk line = %q", got)
			}
			if got := identity.label("YouEye", " "); got != test.existing {
				t.Fatalf("review line = %q", got)
			}
		})
	}
	if identity, err := parseInstalledApplianceIdentity(" \n"); identity != nil || err != nil {
		t.Fatalf("blank State = %v, %v", identity, err)
	}
	if _, err := parseInstalledApplianceIdentity("!!\n0.6.13\n"); err == nil {
		t.Fatal("an undecodable manifest was accepted")
	}
}

// The image's own version is internal: no installer screen prints it, and the
// preserve choice's refusal does not quote it.
func TestInstallerScreensNeverShowTheImageVersion(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	cfg := installConfig{}
	bundle.apply(&cfg)
	wizard := newApplianceWizardModel(cfg, &applianceExecutionRunner{})
	loaded, ok := wizard.Init()().(applianceWizardLoadedMsg)
	if !ok || loaded.err != nil {
		t.Fatalf("load = %v %v", ok, loaded.err)
	}
	image := loaded.bundle.Manifest.ImageVersion
	if image == "" || len(loaded.disks) == 0 {
		t.Fatalf("fixture: image %q, disks %d", image, len(loaded.disks))
	}
	// An existing installation of the same image: preserve is refused.
	loaded.installed = map[string]installedApplianceIdentity{loaded.disks[0].Path: {ImageVersion: image, ReleaseVersion: "0.6.13"}}
	wizard, _ = wizard.Update(loaded)
	preserve := wizard.preserveEligibility()
	if preserve == nil {
		t.Fatal("preserve reinstall of the same image was offered")
	}
	disks, review := wizard.diskListView(0), wizard.reviewView()
	for name, text := range map[string]string{"disk list": disks, "review": review, "preserve refusal": preserve.Error()} {
		if strings.Contains(text, image) || strings.Contains(text, "Image:") {
			t.Fatalf("%s shows the image version: %s", name, text)
		}
	}
	if !strings.Contains(disks, "Installed YouEye: 0.6.13") || !strings.Contains(review, "Existing: YouEye 0.6.13") {
		t.Fatalf("the recorded release is not shown:\n%s\n%s", disks, review)
	}

	server := newInstallerServer(cfg, &applianceExecutionRunner{}, io.Discard)
	server.inventory, server.loaded = wizard, true
	recorder := httptest.NewRecorder()
	server.handleState(recorder, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	body := recorder.Body.String()
	if strings.Contains(body, image) || strings.Contains(body, "image_version") {
		t.Fatalf("/api/state carries the image version: %s", body)
	}
	if !strings.Contains(body, `"installed":true`) || !strings.Contains(body, `"installed_release":"0.6.13"`) {
		t.Fatalf("/api/state does not name the recorded release: %s", body)
	}
	script, err := installerWebFiles.ReadFile("web/installer.js")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(script), "image_version") || !strings.Contains(string(script), "disk.installed_release") {
		t.Fatal("installer.js must show the recorded release, never the image version")
	}
}
