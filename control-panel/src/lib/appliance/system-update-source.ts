import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  spineClient,
  type ApplianceSystemUpdateSelection,
  type SpineRuntimeStatus,
} from '@/lib/spine/client';

const SOURCE_PATH = process.env.YOUEYE_SYSTEM_UPDATE_SOURCE_PATH
  || '/var/lib/youeye/system-update-source.json';
const OFFICIAL_REPOSITORY = 'https://github.com/YouEye-Platform/YouEye';
const PAGINATION_PARAMETERS = new Set(['limit', 'per_page', 'page']);

function safeReleaseBranch(value: string): boolean {
  return value.length > 0 && value.length <= 96 && value.split('/').every((part) =>
    part !== '.' && part !== '..' && !part.startsWith('.') && !part.endsWith('.') &&
    !part.endsWith('.lock') && /^[a-z0-9._-]+$/.test(part));
}

function safeApplianceReleaseTag(value: string): boolean {
  if (value.length === 0 || value.length > 180 || !value.startsWith('appliance-') || /[\\%\0]/.test(value)) return false;
  if (/^appliance-v\d+(?:\.\d+)+$/.test(value) || /^appliance-dev-v\d+(?:\.\d+)+$/.test(value)) return true;
  const marker = value.lastIndexOf('-v');
  if (marker <= 'appliance-'.length || !/^\d+(?:\.\d+)+$/.test(value.slice(marker + 2))) return false;
  return safeReleaseBranch(value.slice('appliance-'.length, marker));
}

function validateReleasesAPI(raw: string, provider: ApplianceSystemUpdateSelection['provider']): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('System update releases API must use HTTPS without credentials or a fragment.');
  }
  for (const key of parsed.searchParams.keys()) {
    if (!PAGINATION_PARAMETERS.has(key)) throw new Error(`System update releases API contains unsupported query parameter ${key}.`);
  }
  if (provider === 'github') {
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parsed.hostname.toLowerCase() !== 'api.github.com' || parts.length !== 4 || parts[0] !== 'repos' || parts[3] !== 'releases') {
      throw new Error('GitHub releases API must identify one api.github.com repository.');
    }
  }
  return parsed.toString();
}

function officialSelection(channel: ApplianceSystemUpdateSelection['channel'] = 'stable'): ApplianceSystemUpdateSelection {
  return { provider: 'github', channel };
}

function releaseAPIFromRepository(raw: string): Pick<ApplianceSystemUpdateSelection, 'provider' | 'releases_api'> | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (parsed.hostname.toLowerCase() === 'github.com') {
    const official = parsed.toString().replace(/\/$/, '') === OFFICIAL_REPOSITORY;
    return {
      provider: 'github',
      ...(official ? {} : { releases_api: `https://api.github.com/repos/${parts[0]}/${parts[1]}/releases` }),
    };
  }
  return {
    provider: 'forgejo',
    releases_api: `${parsed.protocol}//${parsed.host}/api/v1/repos/${parts[0]}/${parts[1]}/releases`,
  };
}

export function deriveSystemUpdateSelection(runtime: SpineRuntimeStatus): ApplianceSystemUpdateSelection {
  if (runtime.artifact_kind === 'production') return officialSelection('stable');
  const derived = runtime.release_source ? releaseAPIFromRepository(runtime.release_source) : null;
  if (derived) return { ...derived, channel: 'development' };
  return officialSelection('development');
}

export function normalizeSystemUpdateSelection(value: unknown): ApplianceSystemUpdateSelection {
  if (!value || typeof value !== 'object') throw new Error('System update source is invalid.');
  const raw = value as Record<string, unknown>;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : '';
  const channel = typeof raw.channel === 'string' ? raw.channel.trim().toLowerCase() : '';
  if (!['github', 'forgejo', 'custom'].includes(provider)) throw new Error('System update provider is invalid.');
  if (!['stable', 'development', 'branch', 'exact'].includes(channel)) throw new Error('System update channel is invalid.');

  const selection: ApplianceSystemUpdateSelection = {
    provider: provider as ApplianceSystemUpdateSelection['provider'],
    channel: channel as ApplianceSystemUpdateSelection['channel'],
  };
  const releasesAPI = typeof raw.releases_api === 'string' ? raw.releases_api.trim() : '';
  if (provider === 'github') {
    if (releasesAPI) {
      selection.releases_api = validateReleasesAPI(releasesAPI, 'github');
    }
  } else {
    if (!releasesAPI) throw new Error('Forgejo and Custom HTTPS require a releases API URL.');
    selection.releases_api = validateReleasesAPI(releasesAPI, provider as 'forgejo' | 'custom');
  }

  const exactTag = typeof raw.exact_tag === 'string' ? raw.exact_tag.trim() : '';
  const manifestSHA256 = typeof raw.manifest_sha256 === 'string' ? raw.manifest_sha256.trim().toLowerCase() : '';
  const branch = typeof raw.branch === 'string' ? raw.branch.trim() : '';
  if (channel === 'branch') {
    if (!safeReleaseBranch(branch)) {
      throw new Error('Branch track requires a safe signed release branch.');
    }
    selection.branch = branch;
  } else if (branch) {
    throw new Error('Only the branch-associated release track can include a branch.');
  }
  if (channel === 'exact') {
    if (!safeApplianceReleaseTag(exactTag) || !/^[0-9a-f]{64}$/.test(manifestSHA256)) {
      throw new Error('Exact selection requires a release tag and lowercase manifest SHA-256.');
    }
    selection.exact_tag = exactTag;
    selection.manifest_sha256 = manifestSHA256;
  } else if (exactTag || manifestSHA256) {
    throw new Error('Tracking selections cannot include exact release fields.');
  }
  return selection;
}

export async function getSystemUpdateSelection(): Promise<ApplianceSystemUpdateSelection> {
  if (existsSync(SOURCE_PATH)) {
    try {
      return normalizeSystemUpdateSelection(JSON.parse(await readFile(SOURCE_PATH, 'utf8')));
    } catch (error) {
      console.error('[system-update-source] Persisted source is invalid; using the sealed image source:', error);
    }
  }
  try {
    const status = await spineClient.status();
    return deriveSystemUpdateSelection(status.runtime);
  } catch {
    return officialSelection('stable');
  }
}

export async function saveSystemUpdateSelection(value: unknown): Promise<ApplianceSystemUpdateSelection> {
  const selection = normalizeSystemUpdateSelection(value);
  const directory = path.dirname(SOURCE_PATH);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${SOURCE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, SOURCE_PATH);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return selection;
}
