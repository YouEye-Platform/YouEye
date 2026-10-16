package releasecache

import (
	"fmt"
	"net/http"
	"net/url"
)

// CoreBlobTransportURL separates delivery from the original signed identity.
// A private assembly may mirror public-ready members at hash-named assets on
// that exact private release. The caller must authenticate the assembly first;
// every downloaded blob still requires its original hash and scoped signature.
// Public assemblies always retain their original public URLs.
func CoreBlobTransportURL(r CoreRelease, b CoreBlob) (string, error) {
	if err := r.Validate(); err != nil {
		return "", err
	}
	found := false
	for _, m := range r.Members {
		blobs := []CoreBlob{m.Artifact, m.Checksums, m.Signature, m.Provenance, m.SBOM}
		if m.DocumentSignature != nil {
			blobs = append(blobs, *m.DocumentSignature)
		}
		if m.ReleaseLock != nil {
			blobs = append(blobs, *m.ReleaseLock)
		}
		for _, candidate := range blobs {
			if candidate == b {
				found = true
			}
		}
	}
	if !found {
		return "", fmt.Errorf("transport blob is outside the authenticated assembly")
	}
	origin, _ := url.Parse(r.Source)
	artifact, _ := url.Parse(b.URL)
	if origin.Host != "github.com" && artifact.Host == "github.com" {
		return r.Source + "/releases/download/" + r.Tag + "/blob-" + b.SHA256, nil
	}
	return b.URL, nil
}

// CoreTransport preserves canonical request identity at the cache boundary.
// Requests outside signed membership are unchanged. Only the explicit private
// mirror hop strips origin credentials; normal redirect policy remains active.
func CoreTransport(base http.RoundTripper, r CoreRelease) (http.RoundTripper, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	urls := map[string]string{}
	mirrors := map[string]string{}
	for _, m := range r.Members {
		blobs := []CoreBlob{m.Artifact, m.Checksums, m.Signature, m.Provenance, m.SBOM}
		if m.DocumentSignature != nil {
			blobs = append(blobs, *m.DocumentSignature)
		}
		if m.ReleaseLock != nil {
			blobs = append(blobs, *m.ReleaseLock)
		}
		for _, b := range blobs {
			transport, err := CoreBlobTransportURL(r, b)
			if err != nil {
				return nil, err
			}
			urls[b.URL] = transport
			// Public wrappers can carry public-ready bytes before their original
			// build tag is published. The hash remains the signed authority;
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
		githubAsset := u.Host == "github.com" && next.URL.Host == "release-assets.githubusercontent.com"
		if len(via) >= 5 || next.URL.Scheme != "https" || (next.URL.Host != u.Host && !githubAsset) || next.URL.User != nil || next.URL.Fragment != "" {
			return fmt.Errorf("core mirror redirected outside its source")
		}
		next.Header.Del("Authorization")
		next.Header.Del("Proxy-Authorization")
		next.Header.Del("Cookie")
		return nil
	}}
	return client.Do(forwarded)
}
