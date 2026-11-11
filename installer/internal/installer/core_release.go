package installer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

func coreManifestDigest(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func validCoreTag(tag string) bool {
	return strings.HasPrefix(tag, "youeye-v") && releasecache.ValidCoreVersion(strings.TrimPrefix(tag, "youeye-v"))
}

var coreTagVersion = regexp.MustCompile(`^youeye-v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([a-z][a-z0-9-]*)\.([0-9]+))?$`)

// compareCoreTags orders youeye-v tags by version. A release sorts after its
// own prereleases; prereleases compare by label, then by number.
func compareCoreTags(a, b string) int {
	ma, mb := coreTagVersion.FindStringSubmatch(a), coreTagVersion.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		return strings.Compare(a, b)
	}
	number := func(v string) uint64 { n, _ := strconv.ParseUint(v, 10, 64); return n }
	for i := 1; i <= 3; i++ {
		if x, y := number(ma[i]), number(mb[i]); x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	switch {
	case ma[4] == "" && mb[4] == "":
		return 0
	case ma[4] == "":
		return 1
	case mb[4] == "":
		return -1
	}
	if c := strings.Compare(ma[4], mb[4]); c != 0 {
		return c
	}
	if x, y := number(ma[5]), number(mb[5]); x != y {
		if x < y {
			return -1
		}
		return 1
	}
	return 0
}

func readCoreAsset(ctx context.Context, client *http.Client, asset applianceReleaseAsset, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "youeye-installer/"+InstallerVersion)
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > limit || asset.Size > limit {
		return nil, fmt.Errorf("core release document unavailable or oversized")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(raw)) > limit || asset.Size > 0 && int64(len(raw)) != asset.Size {
		return nil, fmt.Errorf("core release document size mismatch")
	}
	return raw, nil
}
