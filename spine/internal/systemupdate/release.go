package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/youeye-platform/YouEye/releasecache"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

const (
	DefaultReleaseProvider    = "github"
	DefaultReleasesAPI        = "https://api.github.com/repos/YouEye-Platform/YouEye/releases"
	releaseGitHubPageSize     = 100
	releaseCompatiblePageSize = 50
	releaseMaxPages           = 200
)

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type release struct {
	TagName     string         `json:"tag_name"`
	Body        string         `json:"body"`
	Draft       bool           `json:"draft"`
	Prerelease  bool           `json:"prerelease"`
	PublishedAt time.Time      `json:"published_at"`
	Assets      []releaseAsset `json:"assets"`
}

func ReleaseHTTPClient() *http.Client {
	return &http.Client{
		Transport: releasecache.Wrap(nil),
		Timeout:   30 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many release API redirects")
			}
			if err := requireHTTPS(request.URL.String()); err != nil {
				return err
			}
			if len(via) > 0 && !strings.EqualFold(request.URL.Host, via[0].URL.Host) {
				return errors.New("release API redirected across origins")
			}
			return nil
		},
	}
}

func normalizeReleaseSource(provider, raw string) (string, *url.URL, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		provider = DefaultReleaseProvider
	}
	if provider != "github" && provider != "custom" {
		return "", nil, errors.New("release provider must be a supported repository URL")
	}
	raw = strings.TrimSpace(raw)
	if raw == "" && provider == DefaultReleaseProvider {
		raw = DefaultReleasesAPI
	}
	if raw == "" {
		return "", nil, fmt.Errorf("%s release provider requires an explicit HTTPS releases API", provider)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return "", nil, errors.New("appliance releases API must be an HTTPS URL without credentials or a fragment")
	}
	for key := range parsed.Query() {
		if key != "limit" && key != "per_page" && key != "page" {
			return "", nil, fmt.Errorf("appliance releases API contains unsupported query parameter %q", key)
		}
	}
	if provider == DefaultReleaseProvider {
		parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		if !strings.EqualFold(parsed.Hostname(), "api.github.com") || len(parts) != 4 || parts[0] != "repos" || parts[3] != "releases" {
			return "", nil, errors.New("GitHub release provider requires an api.github.com repository releases URL")
		}
	}
	return provider, parsed, nil
}

func fetchReleases(ctx context.Context, client *http.Client, provider string, apiURL *url.URL) ([]release, error) {
	pageSize, pageSizeKey := releaseCompatiblePageSize, "limit"
	if provider == DefaultReleaseProvider {
		pageSize, pageSizeKey = releaseGitHubPageSize, "per_page"
	}
	var releases []release
	seenTags := make(map[string]struct{})
	for pageNumber := 1; pageNumber <= releaseMaxPages; pageNumber++ {
		pageURL := *apiURL
		query := pageURL.Query()
		query.Del("limit")
		query.Del("per_page")
		query.Del("page")
		query.Set(pageSizeKey, fmt.Sprint(pageSize))
		query.Set("page", fmt.Sprint(pageNumber))
		pageURL.RawQuery = query.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL.String(), nil)
		if err != nil {
			return nil, fmt.Errorf("create appliance releases request: %w", err)
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("User-Agent", "youeye-spine/system-update")
		if provider == DefaultReleaseProvider {
			request.Header.Set("Accept", "application/vnd.github+json")
			request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, fmt.Errorf("query appliance releases page %d: %w", pageNumber, err)
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return nil, fmt.Errorf("appliance releases API page %d returned %s", pageNumber, response.Status)
		}
		var releasePage []release
		decodeErr := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&releasePage)
		closeErr := response.Body.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("decode appliance releases page %d: %w", pageNumber, decodeErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close appliance releases page %d: %w", pageNumber, closeErr)
		}
		if len(releasePage) == 0 {
			return releases, nil
		}
		for _, candidate := range releasePage {
			if _, exists := seenTags[candidate.TagName]; exists {
				return nil, fmt.Errorf("appliance releases API returned duplicate tag %q", candidate.TagName)
			}
			seenTags[candidate.TagName] = struct{}{}
			releases = append(releases, candidate)
		}
		if pageNumber == releaseMaxPages {
			return nil, fmt.Errorf("appliance release discovery exceeded %d pages; select an exact tag", releaseMaxPages)
		}
	}
	return nil, errors.New("appliance release discovery did not terminate")
}

func validReleaseBranch(branch string) bool {
	if branch == "" || len(branch) > 96 || strings.ContainsAny(branch, "\\%\x00") {
		return false
	}
	for _, component := range strings.Split(branch, "/") {
		if component == "" || component == "." || component == ".." || strings.HasPrefix(component, ".") || strings.HasSuffix(component, ".") || strings.HasSuffix(component, ".lock") {
			return false
		}
		for _, char := range component {
			if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && !strings.ContainsRune("._-", char) {
				return false
			}
		}
	}
	return true
}

func releaseAssetURL(provider string, apiURL *url.URL, selected release, name string) (string, error) {
	var found string
	for _, asset := range selected.Assets {
		if asset.Name != name {
			continue
		}
		if found != "" {
			return "", fmt.Errorf("appliance release %s has duplicate %s", selected.TagName, name)
		}
		if err := validateReleaseAssetURL(provider, apiURL, selected.TagName, name, asset.BrowserDownloadURL); err != nil {
			return "", fmt.Errorf("appliance release %s %s: %w", selected.TagName, name, err)
		}
		found = asset.BrowserDownloadURL
	}
	if found == "" {
		return "", fmt.Errorf("appliance release %s is missing %s", selected.TagName, name)
	}
	return found, nil
}

func validateReleaseAssetURL(provider string, apiURL *url.URL, tag, name, raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("download URL must use HTTPS without credentials, query, or fragment")
	}
	escapedPath := parsed.EscapedPath()
	lowerPath := strings.ToLower(escapedPath)
	escapedName := path.Base(escapedPath)
	if strings.Contains(strings.ToLower(escapedName), "%2f") || strings.Contains(lowerPath, "%5c") || strings.Contains(escapedPath, "//") {
		return errors.New("download URL contains an unsafe encoded or nested path")
	}
	decodedName, err := url.PathUnescape(escapedName)
	if err != nil || decodedName != name || path.Base(decodedName) != decodedName || decodedName == "." || decodedName == ".." {
		return fmt.Errorf("download URL asset identity does not match %q", name)
	}
	decodedPath, err := url.PathUnescape(escapedPath)
	if err != nil || !strings.HasSuffix(decodedPath, "/releases/download/"+tag+"/"+name) {
		return errors.New("download URL is not scoped to the selected release")
	}
	if provider == DefaultReleaseProvider {
		parts := strings.Split(strings.Trim(apiURL.Path, "/"), "/")
		if !strings.EqualFold(parsed.Hostname(), "github.com") || len(parts) != 4 || !strings.HasPrefix(decodedPath, "/"+parts[1]+"/"+parts[2]+"/") {
			return errors.New("GitHub asset URL does not match the configured repository")
		}
	} else if !strings.EqualFold(parsed.Host, apiURL.Host) {
		return errors.New("asset origin does not match the configured release API")
	}
	return nil
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
