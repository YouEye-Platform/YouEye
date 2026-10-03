package releasecache

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const OfficialRepository = "https://github.com/YouEye-Platform/YouEye"

// RepositorySource derives the supported release API from a repository URL.
// The adapter describes a protocol; it never selects a signing authority.
type RepositorySource struct {
	URL         string
	Adapter     string
	ReleasesAPI string
}

func ParseRepositorySource(raw string) (RepositorySource, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" {
		return RepositorySource{}, fmt.Errorf("repository must be an HTTPS URL without credentials, query or fragment")
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), ".git"), "/")
	safe := regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]*$`)
	if len(parts) != 3 || parts[0] != "" || !safe.MatchString(parts[1]) || !safe.MatchString(parts[2]) || strings.HasSuffix(parts[1], ".") || strings.HasSuffix(parts[2], ".") {
		return RepositorySource{}, fmt.Errorf("repository URL must identify an owner and repository")
	}
	u.Host = strings.ToLower(u.Host)
	u.Path = "/" + parts[1] + "/" + parts[2]
	source := RepositorySource{URL: u.String(), Adapter: "custom", ReleasesAPI: "https://" + u.Host + "/api/v1/repos/" + parts[1] + "/" + parts[2] + "/releases"}
	if u.Host == "github.com" {
		source.Adapter = "github"
		source.ReleasesAPI = "https://api.github.com/repos/" + parts[1] + "/" + parts[2] + "/releases"
	}
	return source, nil
}

func RepositoryURLFromAPI(adapter, raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.RawPath != "" {
		return "", fmt.Errorf("invalid repository releases API")
	}
	u.RawQuery = ""
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if adapter == "github" && u.Host == "api.github.com" && len(parts) == 4 && parts[0] == "repos" && parts[3] == "releases" {
		u.Host, u.Path = "github.com", "/"+parts[1]+"/"+parts[2]
	} else if adapter == "custom" && len(parts) == 6 && strings.Join(parts[:3], "/") == "api/v1/repos" && parts[5] == "releases" {
		u.Path = "/" + parts[3] + "/" + parts[4]
	} else {
		return "", fmt.Errorf("unsupported repository releases API")
	}
	source, err := ParseRepositorySource(u.String())
	return source.URL, err
}
