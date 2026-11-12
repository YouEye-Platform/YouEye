package systemupdate

import (
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

// ReleaseHTTPClient downloads small release files (channel indexes and release
// documents) with the artifact redirect policy. It never calls a
// release-listing API.
func ReleaseHTTPClient() *http.Client {
	base := DefaultConfig().HTTPClient
	client := CoreArtifactHTTPClient(base)
	client.Transport = releasecache.Wrap(client.Transport)
	client.Timeout = 60 * time.Second
	return client
}

func requireHTTPS(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return errors.New("URL must use HTTPS with no embedded credentials")
	}
	return nil
}

func isLowerHex(value string) bool {
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}
