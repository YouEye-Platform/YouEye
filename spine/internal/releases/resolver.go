package releases

import (
	"fmt"
	"os"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/version"
)

// Candidate is the resolved release for a component channel.
type Candidate struct {
	Tag            string // full release tag, e.g. "spine-f-x-v0.5.11.0.0.0.1"
	Version        string // version number only (canonical, may carry trailing zeros)
	Branch         string // the branch whose tag was selected (own branch or a fallback)
	Source         string // the source repo URL the release was fetched from
	ArtifactSHA256 string // optional exact digest required before mutation
}

// resolveSource turns a channel source URL into a normalized ReleaseRepo.
// Empty source falls back to the config's core release repo.
func resolveSource(cfg *config.Config, source string) config.ReleaseRepo {
	if source != "" {
		if repo, err := config.ParseReleaseRepoURL(source); err == nil {
			return repo
		}
	}
	return cfg.CoreReleaseRepo()
}

// versionForBranch extracts the version from a stripped tag for a branch,
// returning ("", false) when the tag does not belong to that branch.
func versionForBranch(strippedTag, branch string) (string, bool) {
	if branch == "" || branch == "main" {
		if IsMainTag(strippedTag) {
			return strings.TrimPrefix(strippedTag, "v"), true
		}
		return "", false
	}
	p := branch + "-v"
	if strings.HasPrefix(strippedTag, p) {
		return strings.TrimPrefix(strippedTag, p), true
	}
	return "", false
}

// ResolveComponent resolves the newest release for a component honoring its
// configured channel: it fetches releases from the channel source, considers
// the channel branch plus each configured fallback branch in order, skips tags
// whose version exceeds the maximum segment depth (logged to stderr), and picks
// the highest version. Ties resolve to the earlier branch in the chain (own
// branch first), matching the historical union/newest-wins behavior.
func ResolveComponent(cfg *config.Config, component, repo, tagPrefix string) (Candidate, error) {
	chCfg, err := channels.Load()
	if err != nil {
		return Candidate{}, fmt.Errorf("load channels: %w", err)
	}
	eff := chCfg.Effective(component, cfg)
	return resolveWithChannel(cfg, eff, repo, tagPrefix)
}

// resolveWithChannel is the channel-driven core, separated so callers with an
// already-resolved channel (and tests) can drive it directly.
func resolveWithChannel(cfg *config.Config, eff channels.Channel, repo, tagPrefix string) (Candidate, error) {
	src := resolveSource(cfg, eff.Source)

	rels, err := fetchReleasesFromSource(cfg, src, repo)
	if err != nil {
		return Candidate{}, err
	}
	if len(rels) == 0 {
		return Candidate{}, fmt.Errorf("no releases found")
	}
	if eff.Tag != "" {
		for _, release := range rels {
			if release.TagName != eff.Tag {
				continue
			}
			stripped, ok := stripTagPrefix(release.TagName, tagPrefix)
			if !ok {
				return Candidate{}, fmt.Errorf("exact release tag %q does not match component prefix %q", eff.Tag, tagPrefix)
			}
			ver, ok := versionForBranch(stripped, eff.Branch)
			if !ok {
				return Candidate{}, fmt.Errorf("exact release tag %q does not belong to branch %q", eff.Tag, eff.Branch)
			}
			if _, err := version.ParseVersionStrict(ver); err != nil {
				return Candidate{}, fmt.Errorf("exact release tag %q: %w", eff.Tag, err)
			}
			return Candidate{Tag: eff.Tag, Version: ver, Branch: eff.Branch, Source: src.RepoURL, ArtifactSHA256: eff.ArtifactSHA256}, nil
		}
		return Candidate{}, fmt.Errorf("exact release tag %q was not found", eff.Tag)
	}

	// Ordered branch chain: own branch first, then fallbacks (deduped).
	chain := []string{eff.Branch}
	seen := map[string]bool{normalizeBranchKey(eff.Branch): true}
	for _, fb := range eff.Fallback {
		key := normalizeBranchKey(fb)
		if seen[key] {
			continue
		}
		seen[key] = true
		chain = append(chain, fb)
	}

	type match struct {
		tag    string
		ver    string
		branch string
		order  int // position in the branch chain
	}

	var best *match
	for order, branch := range chain {
		for _, r := range rels {
			stripped, ok := stripTagPrefix(r.TagName, tagPrefix)
			if !ok {
				continue
			}
			ver, ok := versionForBranch(stripped, branch)
			if !ok {
				continue
			}
			// Skip pathologically deep tags — they are not valid YouEye versions.
			if _, err := version.ParseVersionStrict(ver); err != nil {
				fmt.Fprintf(os.Stderr, "channels: skipping tag %q: %v\n", r.TagName, err)
				continue
			}
			cand := match{tag: r.TagName, ver: ver, branch: branch, order: order}
			if best == nil {
				best = &cand
				continue
			}
			cmp := version.CompareVersions(cand.ver, best.ver)
			// Higher version wins; on a tie the earlier chain position wins.
			if cmp > 0 || (cmp == 0 && cand.order < best.order) {
				best = &cand
			}
		}
	}

	if best == nil {
		return Candidate{}, fmt.Errorf("no releases matched branch chain %v for prefix %q", chain, tagPrefix)
	}

	return Candidate{
		Tag:            best.tag,
		Version:        best.ver,
		Branch:         best.branch,
		Source:         src.RepoURL,
		ArtifactSHA256: eff.ArtifactSHA256,
	}, nil
}

// BuildCandidateDownloadURL constructs the download URL for an asset of a
// resolved candidate, honoring the candidate's source repo (channel-aware).
func BuildCandidateDownloadURL(cfg *config.Config, cand Candidate, repo, assetName string) string {
	src := resolveSource(cfg, cand.Source)
	return buildDownloadURLFromSource(src, repo, cand.Tag, assetName)
}

func normalizeBranchKey(branch string) string {
	if branch == "" {
		return "main"
	}
	return strings.ToLower(branch)
}
