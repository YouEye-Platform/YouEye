import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The running Control Panel's build version: `version.json` that the build
 * writes next to server.js from env YOUEYE_VERSION. package.json carries a
 * fixed placeholder and is never read for versions. Development servers have
 * no version.json and report "development".
 */
export function controlPanelVersion(): string {
  try {
    const value = JSON.parse(readFileSync(join(process.cwd(), 'version.json'), 'utf8')) as { version?: unknown };
    if (typeof value.version === 'string' && value.version) return value.version;
  } catch { /* not a packaged build */ }
  return 'development';
}
