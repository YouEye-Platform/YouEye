import { loadSelectedCore, loadSelectedCoreDocument } from './core-release';

/**
 * What a box shows and reports as its YouEye version: the `version` of the
 * System release document Spine accepted (`0.6.13-dev.5` on dev, the same
 * files promoted show `0.6.13-alpha.1`, `0.6.13-beta.1`, `0.6.13`). Never a
 * build name baked into a file. The details line adds the release's git tree.
 */
export type InstalledRelease = { version: string; sourceTree?: string };

/** The accepted release document's version and tree; null when there is none (development, or not an appliance). */
export function selectedRelease(): InstalledRelease | null {
  try {
    const release = loadSelectedCore();
    return { version: release.version, sourceTree: release.source_tree };
  } catch {
    return null;
  }
}

/**
 * The installed release: the accepted document, else what Spine says
 * (`/api/version` `release`, then its own version). Null when neither answers.
 * Spine's `source_tree` is its own binary's tree, not the release's, so the
 * fallback has no details tree.
 */
export async function installedRelease(): Promise<InstalledRelease | null> {
  const selected = selectedRelease();
  if (selected) return selected;
  try {
    const { spineClient } = await import('../spine/client');
    const answer = await spineClient.version();
    if (answer.release) return { version: answer.release };
    if (answer.version) return { version: answer.version };
  } catch { /* Spine cannot be asked */ }
  return null;
}

/** The short git tree shown on the details line (`0.6.13 · b39fe307`). */
export const shortTree = (tree: string) => tree.slice(0, 8);

/** `<release version> · <short tree>`, for the details line and support. */
export function releaseDetails(release: InstalledRelease): string {
  return release.sourceTree ? `${release.version} · ${shortTree(release.sourceTree)}` : release.version;
}

/** The parts that update only with the System release; each shows the installed release's version. */
const RELEASE_PARTS = new Set(['spine', 'control-panel', 'ui']);

/**
 * The version Settings → Apps and the UI's app list show for an app: the
 * installed release's version for Spine, the Control Panel and the UI (never a
 * build name baked into them, as Spine's `/api/status` reports); undefined for
 * anything else.
 */
export function releasePartVersion(appId: string, release: InstalledRelease | null): string | undefined {
  return RELEASE_PARTS.has(appId) ? release?.version : undefined;
}

const UI_CONTAINER = 'youeye-ui';
/** Where the UI reads the installed release (it has no access to State and makes no calls to the Control Panel). */
export const UI_RELEASE_PATH = '/etc/youeye/release.json';

/** What publishing the UI's release file needs; tests replace it. */
export type UIReleaseIO = {
  /** The accepted release document's version, tree and digest; null when there is none. */
  selected(): (InstalledRelease & { manifestSHA256: string }) | null;
  download(container: string, path: string): Promise<Buffer>;
  upload(container: string, path: string, body: Buffer, options: { mode: string }): Promise<void>;
};

const defaultUIReleaseIO: UIReleaseIO = {
  selected() {
    try {
      const document = loadSelectedCoreDocument();
      return { version: document.release.version, sourceTree: document.release.source_tree, manifestSHA256: document.manifestSHA256 };
    } catch {
      return null;
    }
  },
  async download(container, path) {
    return (await import('../incus/server')).incusDownloadFile(container, path);
  },
  async upload(container, path, body, options) {
    return (await import('../incus/server')).incusUploadFile(container, path, body, options);
  },
};

/**
 * The publisher's state, shared by every copy of this module in the process (Next bundles instrumentation and the
 * routes separately): the failures in a row, and the loop.
 */
type UIReleasePublisher = { failures: number; timer: ReturnType<typeof setTimeout> | null };
const PUBLISHER = Symbol.for('youeye.ui-release-publisher');
const publisherHolder = globalThis as typeof globalThis & { [PUBLISHER]?: UIReleasePublisher };
const publisher = publisherHolder[PUBLISHER] ??= { failures: 0, timer: null };

/**
 * Tell the UI which release the box runs, so it reports the release version
 * (platform API, telemetry export). Reads the UI's copy first and writes only
 * when it differs; the UI falls back to its own version.json without it.
 * Throws when the UI cannot be read and written (the caller retries).
 */
export async function publishUIRelease(io: UIReleaseIO = defaultUIReleaseIO): Promise<void> {
  const release = io.selected();
  if (!release) return;
  const body = Buffer.from(JSON.stringify({ version: release.version, source_tree: release.sourceTree }) + '\n');
  let current: Buffer | null = null;
  try { current = await io.download(UI_CONTAINER, UI_RELEASE_PATH); } catch { /* absent or unreadable: written below */ }
  if (!current?.equals(body)) await io.upload(UI_CONTAINER, UI_RELEASE_PATH, body, { mode: '0644' });
}

/** How often the publisher looks at the accepted release document (a small local file). */
export const UI_RELEASE_POLL_MS = 60_000;
const UI_RELEASE_RETRY_MS = 30_000;
const UI_RELEASE_RETRY_MAX_MS = 30 * 60_000;

/** Wait before the next attempt after `failures` failed ones in a row: 30 s, doubling, at most 30 minutes. */
export function uiReleaseRetryDelay(failures: number): number {
  return Math.min(UI_RELEASE_RETRY_MS * 2 ** Math.max(0, failures - 1), UI_RELEASE_RETRY_MAX_MS);
}

/**
 * One pass of the publisher: read the UI's copy and write it when it differs
 * from the accepted release document (a core update, a promotion that only
 * renamed the release, or a UI container replaced after the last write, as
 * `apply-ui` does right after the new Control Panel starts). Returns the delay
 * before the next pass: the poll interval, or a growing one after failures.
 */
export async function syncUIRelease(io: UIReleaseIO = defaultUIReleaseIO): Promise<number> {
  const release = io.selected();
  if (!release) {
    publisher.failures = 0;
    return UI_RELEASE_POLL_MS;
  }
  try {
    await publishUIRelease(io);
    publisher.failures = 0;
    return UI_RELEASE_POLL_MS;
  } catch (error) {
    publisher.failures += 1;
    const delay = uiReleaseRetryDelay(publisher.failures);
    console.warn(`[installed-release] The UI release version was not published; retrying in ${Math.round(delay / 1000)} s:`, error);
    return delay;
  }
}

/** Start publishing the installed release to the UI whenever it changes. Called once, by instrumentation.ts. */
export function startUIReleasePublisher(io: UIReleaseIO = defaultUIReleaseIO): void {
  if (publisher.timer) return;
  const schedule = (delayMs: number) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      const next = (delay: number) => { if (publisher.timer === timer) schedule(delay); };
      void syncUIRelease(io).then(next, () => next(UI_RELEASE_POLL_MS));
    }, delayMs);
    timer.unref?.();
    publisher.timer = timer;
  };
  schedule(5_000);
}

/** Stop the publisher (tests). */
export function stopUIReleasePublisher(): void {
  if (publisher.timer) clearTimeout(publisher.timer);
  publisher.timer = null;
  publisher.failures = 0;
}
