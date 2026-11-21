/**
 * Pi-hole's own update check, turned off (owner, 2026-11-21).
 *
 * The pinned image (`SYSTEM_IMAGES.pihole`, 2026.05.0: Core 6.4.2, FTL 6.6.2) has no setting for it: its
 * `start.sh` runs `pihole updatechecker` at every container start and its crontab runs it daily. That script,
 * `/opt/pihole/updatecheck.sh`, records the local versions (which `pihole -v` and the web interface show) and asks
 * GitHub for the latest ones (`api.github.com` and `git ls-remote https://github.com/pi-hole/...`). Pi-hole is
 * updated by a System release only, so the remote half is removed: each line that asks GitHub answers `null`, the
 * value the script already writes when GitHub cannot be reached. The local versions are still recorded.
 *
 * The file is in the container's root file system: it survives restarts and is replaced only when the container is
 * created again, so it is edited before a new container's first start and once at every Control Panel start (a box
 * that updated from a release without this).
 *
 * The edit never fails a deploy or an update, and never leaves a broken script: only whole, simple lines are
 * replaced (no continuation, no shell keyword or brace, balanced quotes), the result must leave no GitHub address
 * and pass `bash -n`, and otherwise the original script is kept and the reason logged. A later pin whose script
 * has another form keeps asking GitHub until this learns the form; DNS is never at stake.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { incusDownloadFile, incusUploadFile } from '@/lib/incus/server';

const SCRIPT = '/opt/pihole/updatecheck.sh';
const REMOTE = /api\.github\.com|git ls-remote/;
const SHELL_WORD = /(?:^|[;&|(]\s*)(?:if|then|else|elif|fi|do|done|while|until|for|case|esac|function|select)\b/;

/** The line with its quoted strings and `${…}` expansions removed; null when its quotes do not close on the line. */
function unquoted(line: string): string | null {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      if (i === line.length - 1) out += ch; // a line continuation
      i++;
      continue;
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length) return null;
      i = j;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out.replace(/\$\{[^{}]*\}/g, '');
}

function continues(line: string): boolean {
  const code = unquoted(line);
  return code === null || /(?:\\|\||&&|\|\|)\s*$/.test(code);
}

/** A line that is one whole simple command, so replacing it keeps the script's structure. */
function wholeSimpleLine(lines: string[], index: number): boolean {
  const code = unquoted(lines[index]);
  if (code === null || continues(lines[index]) || (index > 0 && continues(lines[index - 1]))) return false;
  if (SHELL_WORD.test(code.trim()) || /[{}]|<<|`/.test(code)) return false;
  let depth = 0;
  for (const ch of code) {
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** The update check without its GitHub requests, or null when the script has a form this does not know. */
export function withoutRemoteUpdateCheck(script: string): string | null {
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!REMOTE.test(lines[i])) continue;
    if (!wholeSimpleLine(lines, i)) return null;
    lines[i] = `${lines[i].match(/^\s*/)![0]}echo "null"`;
  }
  const local = lines.join('\n');
  return /github\.com/.test(local) ? null : local;
}

/** `bash -n` on the edited script (here: the Control Panel's bash parses it the same way). */
export async function bashSyntaxOK(script: string): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), 'youeye-pihole-check-'));
  try {
    const file = path.join(dir, 'updatecheck.sh');
    await writeFile(file, script, { mode: 0o600 });
    return await new Promise<boolean>(resolve => {
      execFile('bash', ['-n', file], { timeout: 10_000 }, error => resolve(!error));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type PiholeUpdateCheckEdit = 'changed' | 'unchanged' | 'kept';

/**
 * Edit the container's update check (running or stopped). Never throws: 'kept' means the original script stays
 * (unknown form, failed syntax check, or Incus could not read or write it), with the reason logged.
 */
export async function turnOffPiholeUpdateCheck(container = 'youeye-pihole'): Promise<PiholeUpdateCheckEdit> {
  let current: string;
  try {
    current = (await incusDownloadFile(container, SCRIPT)).toString('utf8');
  } catch (error) {
    console.warn(`[Pi-hole] Update check left as it is: ${SCRIPT} could not be read (${error instanceof Error ? error.message : error})`);
    return 'kept';
  }
  const local = withoutRemoteUpdateCheck(current);
  if (local === null) {
    console.warn(`[Pi-hole] Update check left as it is: ${SCRIPT} has a form YouEye does not know`);
    return 'kept';
  }
  if (local === current) return 'unchanged';
  if (!await bashSyntaxOK(local).catch(() => false)) {
    console.warn(`[Pi-hole] Update check left as it is: the edited ${SCRIPT} does not pass bash -n`);
    return 'kept';
  }
  try {
    await incusUploadFile(container, SCRIPT, Buffer.from(local, 'utf8'), { mode: '0755', timeout: 15_000 });
    if ((await incusDownloadFile(container, SCRIPT)).toString('utf8') === local) return 'changed';
    throw new Error('it did not read back');
  } catch (error) {
    console.warn(`[Pi-hole] Update check left as it is: writing ${SCRIPT} failed (${error instanceof Error ? error.message : error}); putting the original back`);
    await incusUploadFile(container, SCRIPT, Buffer.from(current, 'utf8'), { mode: '0755', timeout: 15_000 })
      .catch(restoreError => console.error(`[Pi-hole] The original ${SCRIPT} could not be put back:`, restoreError));
    return 'kept';
  }
}
