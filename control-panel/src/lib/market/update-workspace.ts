import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_BYTES = 128 * 1024 * 1024;
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export function updateDigest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Persistent, encrypted recovery payloads. Journals contain only references and hashes. */
export class AppUpdateWorkspace {
  readonly directory: string;
  private readonly key: Buffer;
  private readonly directories = new Map<string, { dev: number; ino: number }>();
  constructor(readonly root = '/var/lib/youeye/state/app-updates', operation = '') {
    if (!/^[a-f0-9-]{36}$/.test(operation)) throw new Error('Invalid update workspace identity');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.checkDirectory(root);
    const keyFile = path.join(root, 'recovery.key');
    const payloadRoot = path.join(root, 'payloads');
    if (!existsSync(keyFile) && existsSync(payloadRoot) && readdirSync(payloadRoot).length) {
      throw new Error('Recovery key is missing for retained payloads');
    }
    try {
      const fd = openSync(keyFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
      this.sync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.key = this.readPrivate(keyFile, 32);
    if (this.key.length !== 32) throw new Error('Invalid recovery key');
    mkdirSync(payloadRoot, { mode: 0o700, recursive: true });
    this.checkDirectory(payloadRoot);
    this.directory = path.join(payloadRoot, operation);
    mkdirSync(this.directory, { mode: 0o700, recursive: true });
    this.checkDirectory(this.directory);
    this.sync(payloadRoot);
  }
  private checkDirectory(directory: string) {
    const s = lstatSync(directory);
    if (!s.isDirectory() || s.uid !== process.geteuid?.() || (s.mode & 0o777) !== 0o700) {
      throw new Error('Insecure recovery workspace');
    }
    const expected = this.directories.get(directory);
    if (expected && (expected.dev !== s.dev || expected.ino !== s.ino)) throw new Error('Recovery workspace directory changed');
    this.directories.set(directory, { dev: s.dev, ino: s.ino });
  }
  private checkWorkspace() {
    for (const directory of this.directories.keys()) this.checkDirectory(directory);
  }
  private sync(directory: string) {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private readPrivate(file: string, limit = MAX_BYTES): Buffer {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.uid !== process.geteuid?.() || (s.mode & 0o777) !== 0o600 || s.size > limit) {
        throw new Error('Insecure or oversized recovery payload');
      }
      const parts: Buffer[] = [];
      let total = 0;
      while (true) {
        const part = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
        const count = readSync(fd, part, 0, part.length, null);
        if (!count) break;
        total += count;
        if (total > limit) throw new Error('Oversized recovery payload');
        parts.push(part.subarray(0, count));
      }
      return Buffer.concat(parts, total);
    } finally { closeSync(fd); }
  }
  put(name: string, plaintext: Buffer): string {
    this.checkWorkspace();
    if (!safeName.test(name) || plaintext.length > MAX_BYTES - 64) throw new Error('Invalid recovery payload');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${path.basename(this.directory)}:${name}`));
    const encrypted = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const temporary = path.join(this.directory, `.pending-${randomUUID()}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, encrypted); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path.join(this.directory, name));
    this.sync(this.directory);
    return updateDigest(encrypted);
  }
  get(name: string, sha256?: string): Buffer {
    this.checkWorkspace();
    if (!safeName.test(name)) throw new Error('Invalid recovery payload');
    const encrypted = this.readPrivate(path.join(this.directory, name));
    if (encrypted.length < 28 || (sha256 && updateDigest(encrypted) !== sha256)) throw new Error('Recovery payload digest mismatch');
    const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${path.basename(this.directory)}:${name}`));
    decipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
  }
  remove(): void {
    this.checkWorkspace();
    rmSync(this.directory, { recursive: true, force: false });
    this.sync(path.dirname(this.directory));
  }
}
