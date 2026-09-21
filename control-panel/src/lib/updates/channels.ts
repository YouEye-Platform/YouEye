import { releaseCacheFetch } from '../releases/cache';
/**
 * Release channels — Control-Panel side.
 *
 * Mirrors spine/internal/channels (Go): per-component release channels stored in
 * youeye.yaml. Each component (Spine, Control Panel, UI, native apps) selects a
 * repo + branch to install from, with a configurable fallback branch chain.
 *
 * Spine is the SOLE WRITER of youeye.yaml. This module READS the config (via the
 * settings service, which goes through Spine's GET /api/config with a local-file
 * fallback) and resolves the effective channel + candidate release for the
 * components CP itself manages (ui + native apps). All writes go through
 * spineClient.patchConfig — never a direct yaml write.
 *
 * Candidate resolution mirrors spine's GetLatestTagForBranch generalized to a
 * configurable fallback chain:
 *   - branch "main"  → tags matching "{prefix}-v*"        (or "v*" when prefix is null)
 *   - other  branch  → tags matching "{prefix}-{branch}-v*" (or "{branch}-v*")
 *   - each fallback branch contributes its own pattern (deduped)
 *   - skip versions with > 10 numeric segments
 *   - pick max by compareVersions; tie → earlier position in the release list
 */

import { compareVersions, parseVersionStrict } from '@/lib/version';
import { settingsService } from '@/lib/settings';
import type { Channel, ReleaseChannelsConfig } from './channel-types';
import {
  buildMarketReleasesAPIURL,
  parseMarketRepoURL,
  type MarketSource,
} from '@/lib/market/source';

// ─── Types (mirror the youeye.yaml release_channels schema) ────────────────

/**
 * A per-component channel override.
 *
 * `fallback` distinguishes three states, exactly like the Go side:
 *   - undefined     → inherit the effective fallback from the default channel
 *   - []            → fallback disabled (hold on the selected branch)
 *   - ["a", "b"]    → ordered fallback branch chain
 */
export type { Channel, ReleaseChannelsConfig } from './channel-types';

/** A fully-resolved effective channel — every field is populated. */
export interface EffectiveChannel {
  source: string;
  branch: string;
  fallback: string[];
  tag?: string;
  artifact_sha256?: string;
}

export const CORE_COMPONENTS = ['default', 'spine', 'control', 'ui'] as const;
export type CoreComponent = (typeof CORE_COMPONENTS)[number];

/** Component id prefix for native apps: "app:<id>". */
export const APP_PREFIX = 'app:';

/** Default repo the platform ships from when no source is configured anywhere. */
export const DEFAULT_CORE_REPO_URL = 'https://github.com/YouEye-Platform/YouEye';

// ─── Config access ─────────────────────────────────────────────────────────

/**
 * Read the release_channels block from the platform config. Uses the settings
 * service (Spine GET /api/config, local youeye.yaml fallback). Legacy
 * `release_branch` is migrated onto default.branch when release_channels is
 * absent — matching spine's Load() behavior — so an un-migrated box behaves
 * identically to today.
 */
export async function getReleaseChannelsConfig(): Promise<ReleaseChannelsConfig> {
  const raw = await settingsService.getRaw();
  const rc = normalizeReleaseChannels(raw.release_channels);
  if (rc) {
    return rc;
  }

  // Migration path: seed default.branch from the legacy release_branch.
  const legacy = typeof raw.release_branch === 'string' ? raw.release_branch : '';
  if (legacy && legacy !== 'main') {
    return { default: { branch: legacy } };
  }
  return {};
}

/**
 * Normalize the two shapes release_channels arrives in:
 *  - yaml shape (local-file fallback): {default, spine, control, ui, apps:{id: …}}
 *  - Spine API shape (GET /api/config): {effective:{…}, override:{…}} with flat
 *    "app:<id>" keys — the raw overrides live under `override`.
 */
export function normalizeReleaseChannels(rc: unknown): ReleaseChannelsConfig | null {
  if (!rc || typeof rc !== 'object') return null;
  const obj = rc as Record<string, unknown>;

  // Spine API view — take the raw override map and fold app:<id> keys.
  if (obj.effective !== undefined || obj.override !== undefined) {
    const override = (obj.override && typeof obj.override === 'object')
      ? (obj.override as Record<string, unknown>)
      : {};
    const out: ReleaseChannelsConfig = {};
    for (const [key, val] of Object.entries(override)) {
      if (!val || typeof val !== 'object') continue;
      const ch = val as Channel;
      if (key === 'default') out.default = ch;
      else if (key === 'spine') out.spine = ch;
      else if (key === 'control') out.control = ch;
      else if (key === 'ui') out.ui = ch;
      else if (key.startsWith(APP_PREFIX)) {
        out.apps = out.apps ?? {};
        out.apps[key.slice(APP_PREFIX.length)] = ch;
      }
    }
    return out;
  }

  return rc as ReleaseChannelsConfig;
}

/** Resolve the ultimate default source from the platform config. */
async function defaultSource(): Promise<string> {
  try {
    const raw = await settingsService.getRaw();
    const rs = raw.release_source;
    if (rs && typeof rs === 'object' && typeof rs.repo_url === 'string' && rs.repo_url) {
      return rs.repo_url;
    }
  } catch {
    // fall through to constant
  }
  return DEFAULT_CORE_REPO_URL;
}

function mergeChannel(base: EffectiveChannel, override?: Channel): EffectiveChannel {
  if (!override) return base;
  const out: EffectiveChannel = { ...base };
  if (override.source) out.source = override.source;
  if (override.branch) out.branch = override.branch;
  if (override.tag) out.tag = override.tag;
  if (override.artifact_sha256) out.artifact_sha256 = override.artifact_sha256;
  // fallback: undefined = inherit; defined (even []) = replace.
  if (override.fallback !== undefined) out.fallback = override.fallback;
  return out;
}

function pickOverride(cfg: ReleaseChannelsConfig, component: string): Channel | undefined {
  switch (component) {
    case 'default':
      return cfg.default;
    case 'spine':
      return cfg.spine;
    case 'control':
      return cfg.control;
    case 'ui':
      return cfg.ui;
  }
  if (component.startsWith(APP_PREFIX)) {
    const appId = component.slice(APP_PREFIX.length);
    return cfg.apps?.[appId];
  }
  return undefined;
}

/**
 * Resolve the effective channel for a component by merging its override onto the
 * default channel, then onto the ultimate defaults (source = platform repo,
 * branch "main", fallback ["main"]). Mirrors spine's Config.Effective.
 *
 * For native apps, pass "app:<id>". When the app has no source override, callers
 * should supply the app's manifest repo as `appDefaultSource` (installed apps
 * default their source to their manifest repo, per the design).
 */
export async function effectiveChannel(
  component: string,
  opts: { config?: ReleaseChannelsConfig; appDefaultSource?: string } = {},
): Promise<EffectiveChannel> {
  const cfg = opts.config ?? (await getReleaseChannelsConfig());

  let base: EffectiveChannel = {
    source: await defaultSource(),
    branch: 'main',
    fallback: ['main'],
  };
  base = mergeChannel(base, cfg.default);

  if (component === 'default') return base;

  // Native apps default to their own repo (manifest/install source) — the
  // default channel's source is the CORE platform repo and can never serve an
  // app's bare-tag releases, so it must not leak into the app base even when
  // explicitly configured. An app-specific override still wins below.
  if (component.startsWith(APP_PREFIX) && opts.appDefaultSource) {
    base = { ...base, source: opts.appDefaultSource };
  }

  return mergeChannel(base, pickOverride(cfg, component));
}

// ─── Release listing + candidate resolution ────────────────────────────────

interface Release {
  tag_name?: string;
  tagName?: string;
  draft?: boolean;
}

/**
 * List release tags from a repo URL. Reuses the market provider URL builders so
 * github vs forge (Forgejo/Gitea) is handled the same way as catalog fetches.
 * Returns the raw tag list in the order the provider returned them (needed for
 * the tie-break rule: earlier position wins).
 */
export async function listReleaseTags(repoUrl: string): Promise<string[]> {
  const source: MarketSource = parseMarketRepoURL(repoUrl);
  const url = buildMarketReleasesAPIURL(source, source.repository);
  const res = await releaseCacheFetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Failed to list releases for ${repoUrl}: ${res.status}`);
  }
  const releases = (await res.json()) as Release[];
  if (!Array.isArray(releases)) return [];
  return releases
    .filter((r) => !r.draft)
    .map((r) => r.tag_name ?? r.tagName ?? '')
    .filter((t) => t.length > 0);
}

/**
 * Strip a component tag prefix ("ui", "spine"...) from a tag.
 * prefix null/"" → standalone repo, no prefix. Returns null when the tag does
 * not carry the required prefix.
 */
function stripTagPrefix(tag: string, prefix: string | null): string | null {
  if (!prefix) return tag;
  const p = `${prefix}-`;
  return tag.startsWith(p) ? tag.slice(p.length) : null;
}

/** A "vX.Y.Z" main tag (after prefix strip) is `v` followed by a digit. */
function isMainTag(stripped: string): boolean {
  return stripped.length >= 2 && stripped[0] === 'v' && stripped[1] >= '0' && stripped[1] <= '9';
}

interface Candidate {
  version: string;
  branch: string;
  tag: string;
  index: number;
}

/**
 * Extract a candidate {version, branch} from a single tag for a given target
 * branch, or null if the tag doesn't belong to that branch's pattern.
 *
 * branch "main" → matches `{prefix}-v*`, version = tag minus "v".
 * other branch  → matches `{prefix}-{branch}-v*`, version = tag after "{branch}-v".
 * Versions with > 10 numeric segments are rejected (skipped + null).
 */
function candidateForBranch(
  tag: string,
  branch: string,
  tagPrefix: string | null,
  index: number,
): Candidate | null {
  const stripped = stripTagPrefix(tag, tagPrefix);
  if (stripped === null) return null;

  let version: string | null = null;
  if (branch === '' || branch === 'main') {
    if (isMainTag(stripped)) version = stripped.slice(1);
  } else {
    const bp = `${branch}-v`;
    if (stripped.startsWith(bp)) version = stripped.slice(bp.length);
  }
  if (version === null) return null;

  // Reject > 10 numeric segments (deep-version cap).
  if (parseVersionStrict(version) === null) return null;

  return { version, branch, tag, index };
}

export interface ResolvedCandidate {
  version: string;
  branch: string;
  tag: string;
  artifactSHA256?: string;
}

/**
 * Resolve the best candidate release for a channel from its source repo.
 *
 * Candidate set = the channel branch pattern + each fallback branch pattern.
 * Picks the max by compareVersions; ties are broken by earliest position in the
 * provider's release list (so the channel's own branch, listed first, wins a tie
 * with a fallback of equal version). Returns null when nothing matches.
 *
 * @param channel   the effective channel (source/branch/fallback)
 * @param tagPrefix component prefix ("ui" for the monorepo UI, "spine"/"control"
 *                  for core; null for standalone native-app repos which use bare tags)
 * @param repoUrl   optional override for the source repo (defaults to channel.source)
 */
export async function resolveCandidate(
  channel: EffectiveChannel,
  tagPrefix: string | null,
  repoUrl?: string,
): Promise<ResolvedCandidate | null> {
  // The channel's source always wins — repoUrl is only a fallback for callers
  // that may hold a channel without a resolved source. (Passing a repoUrl used
  // to OVERRIDE an explicit per-app channel source, so a configured app branch
  // on the app's own repo was resolved against the Market catalog instead.)
  const source = channel.source || repoUrl;
  if (!source) return null;

  let tags: string[];
  try {
    tags = await listReleaseTags(source);
  } catch (err) {
    console.warn('[channels] Failed to list releases for', source, err);
    return null;
  }

  if (channel.tag) {
    const index = tags.indexOf(channel.tag);
    if (index < 0) return null;
    const exact = candidateForBranch(channel.tag, channel.branch, tagPrefix, index);
    return exact ? {
      version: exact.version,
      branch: exact.branch,
      tag: exact.tag,
      artifactSHA256: channel.artifact_sha256,
    } : null;
  }

  // Branch order: primary channel branch first, then the fallback chain (deduped).
  const branchOrder: string[] = [];
  const seen = new Set<string>();
  for (const b of [channel.branch, ...(channel.fallback ?? [])]) {
    const norm = b || 'main';
    if (!seen.has(norm)) {
      seen.add(norm);
      branchOrder.push(norm);
    }
  }

  const candidates: Candidate[] = [];
  // priorityIndex encodes branch order (primary=0) so earlier branches win ties.
  branchOrder.forEach((branch, priorityIndex) => {
    tags.forEach((tag, tagIndex) => {
      const cand = candidateForBranch(tag, branch, tagPrefix, priorityIndex * 100000 + tagIndex);
      if (cand) candidates.push(cand);
    });
  });

  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (const cand of candidates.slice(1)) {
    const cmp = compareVersions(cand.version, best.version);
    if (cmp > 0 || (cmp === 0 && cand.index < best.index)) {
      best = cand;
    }
  }

  return { version: best.version, branch: best.branch, tag: best.tag, artifactSHA256: channel.artifact_sha256 };
}
