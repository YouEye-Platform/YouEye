package systemupdate

import (
	"net/http"
	"strings"
)

// CoreArtifactHTTPClient keeps API discovery and artifact transport policies
// separate. Callers may supply an isolated transport without granting it a
// broader redirect policy. Original signed URLs remain the authority.
func CoreArtifactHTTPClient(base *http.Client) *http.Client {
	if base == nil {
		base = DefaultConfig().HTTPClient
	}
	client := *base
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if err := validateSystemUpdateRedirect(request, via); err != nil {
			return err
		}
		if len(via) > 0 && !strings.EqualFold(request.URL.Host, via[0].URL.Host) {
			request.Header.Del("Authorization")
			request.Header.Del("Proxy-Authorization")
			request.Header.Del("Cookie")
		}
		return nil
	}
	return &client
}
