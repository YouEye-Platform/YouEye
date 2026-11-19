import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Written by the Control Panel: the installed release's version and git tree (the UI cannot read State). */
const RELEASE_PATH = "/etc/youeye/release.json";

function versionIn(path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    if (typeof value.version === "string" && value.version && value.version.length <= 128) return value.version;
  } catch { /* absent or unreadable */ }
  return null;
}

/**
 * The YouEye version this UI reports (platform API, telemetry export): the
 * installed release's version, which the Control Panel publishes. Before it
 * has, the build's own version.json (next to server.js); a development server
 * has neither and reports "development".
 */
export function youeyeVersion(): string {
  return versionIn(RELEASE_PATH) ?? versionIn(join(process.cwd(), "version.json")) ?? "development";
}
