package releases

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

// Private installation metadata is signed by the same embedded Development
// authority as the selected private appliance. It is an immutable accepted set,
// not a live public distribution catalog. Component signature checks still run.
var installationTrustLookup = updatetrust.Lookup

func VerifyPrivateInstallation(raw []byte, source string) (*releasecache.InstallationSet, error) {
	key := string(releaseDevelopmentTrust)
	grant, err := installationTrustLookup(source, "main", "appliance")
	if err != nil {
		return nil, err
	}
	if grant != nil {
		key = grant.PublicKey
	}
	set, err := releasecache.VerifyPinnedInstallation(raw, "repository-main", key)
	if err != nil {
		return nil, err
	}
	if set.Source != source {
		return nil, fmt.Errorf("private installation source mismatch")
	}
	return set, nil
}

func PrivateInstallationSnapshot(ctx context.Context, source string) ([]byte, error) {
	repo, err := config.ParseReleaseRepoURL(source)
	if err != nil || repo.Provider == "github" {
		return nil, fmt.Errorf("invalid private installation source")
	}
	rows, err := fetchReleasesFromSource(nil, repo, repo.Repository)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].PublishedAt.After(rows[j].PublishedAt) })
	for _, row := range rows {
		if row.Draft || row.Prerelease || !strings.HasPrefix(row.TagName, "installation-") {
			continue
		}
		expected := source + "/releases/download/" + row.TagName + "/installation.json"
		found := false
		for _, a := range row.Assets {
			if a.Name == "installation.json" && a.BrowserDownloadURL == expected {
				found = true
			}
		}
		if !found {
			return nil, fmt.Errorf("private installation release asset identity mismatch")
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, expected, nil)
		if err != nil {
			return nil, err
		}
		response, err := NewIPv4Client(30 * time.Second).Do(request)
		if err != nil {
			return nil, err
		}
		raw, readErr := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
		response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		if response.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("private installation returned HTTP %d", response.StatusCode)
		}
		if _, err = VerifyPrivateInstallation(raw, source); err != nil {
			return nil, err
		}
		return raw, nil
	}
	return nil, fmt.Errorf("no signed private installation selection is published")
}
