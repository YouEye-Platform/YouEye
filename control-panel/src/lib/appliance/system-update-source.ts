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

export function normalizeRepositoryURL(raw: string): string {
  const parsed = new URL(raw);
  const parts = parsed.pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || /[%\\]/.test(parsed.pathname) ||
      parts.length !== 3 || parts[0] !== '' || parts.slice(1).some((part) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) || part.endsWith('.'))) {
    throw new Error('Enter an HTTPS repository URL with an owner and repository, without credentials, query or fragment.');
  }
  parsed.pathname = `/${parts[1]}/${parts[2]}`;
  return parsed.toString();
}

function officialSelection(channel: ApplianceSystemUpdateSelection['channel'] = 'stable'): ApplianceSystemUpdateSelection {
  return { repository_url: OFFICIAL_REPOSITORY, channel };
}

export function deriveSystemUpdateSelection(runtime: SpineRuntimeStatus): ApplianceSystemUpdateSelection {
  if (runtime.release_source) {
    try {
      return { repository_url: normalizeRepositoryURL(runtime.release_source), channel: runtime.release_branch === 'main' ? 'stable' : 'development' };
    } catch { /* No usable sealed repository identity. */ }
  }
  return officialSelection(runtime.artifact_kind === 'production' || runtime.artifact_kind === 'stable' ? 'stable' : 'development');
}

export function normalizeSystemUpdateSelection(value: unknown): ApplianceSystemUpdateSelection {
  if (!value || typeof value !== 'object') throw new Error('System update source is invalid.');
  const raw = value as Record<string, unknown>;
  const repository = typeof raw.repository_url === 'string' ? raw.repository_url.trim() : '';
  const channel = typeof raw.channel === 'string' ? raw.channel.trim().toLowerCase() : '';
  if (!repository) throw new Error('A repository URL is required.');
  if (!['stable', 'development', 'branch', 'exact'].includes(channel)) throw new Error('System update channel is invalid.');

  const selection: ApplianceSystemUpdateSelection = {
    repository_url: normalizeRepositoryURL(repository),
    channel: channel as ApplianceSystemUpdateSelection['channel'],
  };

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
