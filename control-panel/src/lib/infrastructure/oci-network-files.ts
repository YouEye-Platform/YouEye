/**
 * OCI images whose /etc/hosts, /etc/resolv.conf or /etc/hostname is a symlink (Collabora CODE's Nix-based image
 * links them into /nix/store) cannot start on Incus 7.0.1: LXC refuses to mount the network files over a link
 * ("open_without_symlink: Too many levels of symbolic links"; lxc/incus#4427, fixed upstream but not in a release).
 * Before an app's OCI container first starts (after it is created, or rebuilt by an update), each of these paths that
 * is a symlink is replaced by an empty regular file, which Incus then mounts its own file over. Regular files,
 * directories and missing paths are left alone. The link is deleted first (it is never written through, so nothing
 * lands in its target), and the new file must read back as a regular file. A failure is an error: the container
 * would not start anyway (YE-215).
 */

import { incusDeleteInstanceFile, incusInspectInstanceFile, incusUploadFile } from '@/lib/incus/server';

export const OCI_NETWORK_FILES = ['/etc/hosts', '/etc/resolv.conf', '/etc/hostname'] as const;

export interface NetworkFileIO {
  inspect(path: string): Promise<'file' | 'directory' | 'symlink' | null>;
  remove(path: string): Promise<void>;
  createEmpty(path: string): Promise<void>;
}

function incusNetworkFileIO(containerName: string): NetworkFileIO {
  return {
    inspect: (path) => incusInspectInstanceFile(containerName, path),
    remove: (path) => incusDeleteInstanceFile(containerName, path),
    createEmpty: (path) => incusUploadFile(containerName, path, Buffer.alloc(0), { mode: '0644' }),
  };
}

const INSPECT_TRIES = 3;

/**
 * The read-only inspection, retried on an error (up to 3 tries, 1 s apart by default): it changes nothing, so a
 * brief Incus file-API hiccup need not fail an install (YE-221). The delete and the upload are never retried: a
 * failure there is an install error, rolled back as before.
 */
async function inspectWithRetry(io: NetworkFileIO, path: string, retryDelayMs: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await io.inspect(path);
    } catch (error) {
      if (attempt >= INSPECT_TRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

/**
 * Replace each symlinked network file of a stopped OCI container with an empty regular file. Returns those replaced.
 * "Stopped" is the callers' contract, not checked here: every caller (a fresh create, an update's rebuild, a retained
 * runtime's adoption) has an instance that has not started yet, and a status call would add one more Incus request
 * to each (YE-221).
 */
export async function replaceSymlinkedNetworkFiles(
  containerName: string,
  io: NetworkFileIO = incusNetworkFileIO(containerName),
  { retryDelayMs = 1000 }: { retryDelayMs?: number } = {},
): Promise<string[]> {
  const replaced: string[] = [];
  for (const path of OCI_NETWORK_FILES) {
    let type: Awaited<ReturnType<NetworkFileIO['inspect']>>;
    try {
      type = await inspectWithRetry(io, path, retryDelayMs);
    } catch (cause) {
      throw new Error(`Could not check ${path} in ${containerName} before its first start`, { cause });
    }
    if (type !== 'symlink') continue;
    try {
      await io.remove(path);
      await io.createEmpty(path);
      if (await inspectWithRetry(io, path, retryDelayMs) !== 'file') throw new Error(`${path} did not read back as a regular file`);
    } catch (cause) {
      throw new Error(`Could not replace the symlinked ${path} in ${containerName} with a regular file`, { cause });
    }
    replaced.push(path);
  }
  if (replaced.length > 0) {
    console.log(`[oci-deployer] ${containerName}: replaced the symlinked ${replaced.join(', ')} with empty files `
      + '(Incus cannot mount its network files over a link, lxc/incus#4427)');
  }
  return replaced;
}
