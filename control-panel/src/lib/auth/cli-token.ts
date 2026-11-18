/**
 * The `youeye` CLI's credential: Spine writes a random token to /etc/youeye/cli-token at deploy, and the CLI sends
 * it as `X-CLI-Token`. Used by the proxy (every /api request that carries the header) and by getSession().
 */
import { readFileSync } from 'fs';

const CLI_TOKEN_PATH = '/etc/youeye/cli-token';
const CLI_FILE_CACHE_TTL = 60_000;
let cliTokenFileCache: { value: string; ts: number } | null = null;

export function isValidCLIToken(token: string): boolean {
  const now = Date.now();
  if (!cliTokenFileCache || now - cliTokenFileCache.ts > CLI_FILE_CACHE_TTL) {
    try {
      cliTokenFileCache = { value: readFileSync(CLI_TOKEN_PATH, 'utf-8').trim(), ts: now };
    } catch {
      return false;
    }
  }
  const expected = cliTokenFileCache.value;
  if (!expected || token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}
