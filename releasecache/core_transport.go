package releasecache

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// CoreBlobTransportURL separates delivery from the original identity. A
// promoted release mirrors original members at hash-named assets on that exact
// selected release. The caller must accept the release digest first; every
// downloaded blob still requires its exact sha256 and size.
func CoreBlobTransportURL(r CoreRelease, b CoreBlob) (string, error) {
	if err := r.Validate(); err != nil {
		return "", err
	}
	found := false
	for _, m := range r.Members {
		blobs := m.Blobs()
		for _, candidate := range blobs {
			if candidate == b {
				found = true
			}
		}
	}
	if !found {
		return "", fmt.Errorf("transport blob is outside the authenticated assembly")
	}
	if !strings.HasPrefix(b.URL, r.Source+"/releases/download/") {
		return r.Source + "/releases/download/" + r.Tag + "/blob-" + b.SHA256, nil
	}
	return b.URL, nil
}

// CoreTransport preserves canonical request identity at the cache boundary.
// Requests outside release membership are unchanged. Only the explicit private
// mirror hop strips origin credentials; normal redirect policy remains active.
func CoreTransport(base http.RoundTripper, r CoreRelease) (http.RoundTripper, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	urls := map[string]string{}
	mirrors := map[string]string{}
	for _, m := range r.Members {
		blobs := m.Blobs()
		for _, b := range blobs {
			transport, err := CoreBlobTransportURL(r, b)
			if err != nil {
				return nil, err
			}
			urls[b.URL] = transport
			// Public wrappers can carry public-ready bytes before their original
			// build tag is published. The hash remains the authority;
			// this alternate delivery never changes membership or provenance.
			mirrors[b.URL] = r.Source + "/releases/download/" + r.Tag + "/blob-" + b.SHA256
		}
	}
	if base == nil {
		base = http.DefaultTransport
	}
	return coreTransport{base: base, urls: urls, mirrors: mirrors}, nil
}

type coreTransport struct {
	base    http.RoundTripper
	urls    map[string]string
	mirrors map[string]string
}

func (t coreTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	destination, ok := t.urls[request.URL.String()]
	if !ok {
		return t.base.RoundTrip(request)
	}
	if destination == request.URL.String() {
		response, err := t.base.RoundTrip(request)
		if err != nil || response.StatusCode != http.StatusNotFound || (request.Method != http.MethodGet && request.Method != http.MethodHead) {
			return response, err
		}
		response.Body.Close()
		destination = t.mirrors[request.URL.String()]
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		return nil, fmt.Errorf("core transport only permits reads")
	}
	u, err := url.Parse(destination)
	if err != nil {
		return nil, err
	}
	forwarded := request.Clone(request.Context())
	forwarded.URL = u
	forwarded.Host = ""
	forwarded.Header.Del("Authorization")
	forwarded.Header.Del("Proxy-Authorization")
	forwarded.Header.Del("Cookie")
	client := &http.Client{Transport: t.base, CheckRedirect: func(next *http.Request, via []*http.Request) error {
		if len(via) >= 5 || validateCoreMirrorResponseURL(next.URL, u) != nil {
			return fmt.Errorf("core mirror redirected outside its source")
		}
		next.Header.Del("Authorization")
		next.Header.Del("Proxy-Authorization")
		next.Header.Del("Cookie")
		return nil
	}}
	response, err := client.Do(forwarded)
	if err != nil {
		// A CDN's signed query is transport state, including on failed hops.
		// Do not include that URL in an error returned to the native journal.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			return nil, urlErr.Err
		}
		return nil, err
	}
	if response.Request == nil || validateCoreMirrorResponseURL(response.Request.URL, u) != nil {
		response.Body.Close()
		return nil, fmt.Errorf("core mirror returned an untrusted response URL")
	}
	// The inner client has checked every delivery hop against the authenticated
	// mirror, including GitHub's CDN query. Preserve the original request identity
	// for the outer native downloader rather than presenting the CDN as a new
	// source. Exact size and hash remain mandatory.
	response.Request = request
	return response, nil
}

func validateCoreMirrorResponseURL(target, origin *url.URL) error {
	if target == nil || target.Scheme != "https" || target.User != nil || target.Fragment != "" || target.Opaque != "" {
		return fmt.Errorf("invalid core mirror URL")
	}
	githubAsset := origin.Host == "github.com" && (target.Host == "release-assets.githubusercontent.com" || target.Host == "objects.githubusercontent.com")
	if target.Host != origin.Host && !githubAsset || target.RawQuery != "" && !githubAsset {
		return fmt.Errorf("core mirror URL differs from its admitted delivery source")
	}
	return nil
}

// Blobs lists every digest-bound blob of a member.
func (m CoreMember) Blobs() []CoreBlob {
	blobs := []CoreBlob{m.Artifact}
	if m.BuildInputs != nil {
		blobs = append(blobs, *m.BuildInputs)
	}
	return blobs
}
