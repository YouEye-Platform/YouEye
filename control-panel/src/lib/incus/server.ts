/**
 * Server-side Incus Client
 * 
 * This module provides direct Unix socket communication with Incus daemon.
 * Used by API routes to proxy requests from the browser client.
 */

import { Socket } from 'net';
import { connect as tlsConnect, type TLSSocket } from 'tls';
import { readFileSync } from 'fs';

// ─── Incus transport ────────────────────────────────────────
// Default: Unix socket (forwarded into this container by the incus-socket proxy
// device). If INCUS_HTTPS_URL is set, connect to the Incus HTTPS API directly
// with a client certificate instead — this removes the userspace forkproxy that
// copies every API byte and can grow without a useful bound.
// Backward-compatible: with no HTTPS env set, behaviour is identical.
function incusEndpoint(): { tls: true; host: string; port: number } | { tls: false; socketPath: string } {
  const httpsUrl = process.env.INCUS_HTTPS_URL;
  if (httpsUrl) {
    const cleaned = httpsUrl.replace(/^https?:\/\//, '');
    const [host, portStr] = cleaned.split(':');
    return { tls: true, host, port: parseInt(portStr || '8443', 10) };
  }
  return { tls: false, socketPath: process.env.INCUS_SOCKET || '/var/lib/incus/unix.socket' };
}

let cachedCert: Buffer | undefined;
let cachedKey: Buffer | undefined;
function clientCreds(): { cert?: Buffer; key?: Buffer } {
  if (!cachedCert && process.env.INCUS_CLIENT_CERT) cachedCert = readFileSync(process.env.INCUS_CLIENT_CERT);
  if (!cachedKey && process.env.INCUS_CLIENT_KEY) cachedKey = readFileSync(process.env.INCUS_CLIENT_KEY);
  return { cert: cachedCert, key: cachedKey };
}

/** Open a connection to Incus (Unix socket or HTTPS) and invoke onReady once connected. */
function openIncus(onReady: () => void, socketPathOverride?: string): Socket | TLSSocket {
  const ep = incusEndpoint();
  if (ep.tls) {
    const { cert, key } = clientCreds();
    // rejectUnauthorized:false — the endpoint is the local incusd over the core
    // bridge; authentication is via the trusted client cert, not server CN.
    return tlsConnect({ host: ep.host, port: ep.port, cert, key, rejectUnauthorized: false }, onReady);
  }
  const s = new Socket();
  s.connect(socketPathOverride || ep.socketPath, onReady);
  return s;
}

interface IncusResponse<T = unknown> {
  type: 'sync' | 'async' | 'error';
  status: string;
  status_code: number;
  operation: string;
  error_code: number;
  error: string;
  metadata: T;
}

/**
 * Parse chunked transfer encoding body
 * Chunks are formatted as: <size in hex>\r\n<chunk data>\r\n
 * Ends with: 0\r\n\r\n
 */
function parseChunkedBuffer(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const sizeEnd = body.indexOf('\r\n', offset);
    if (sizeEnd === -1) break;
    const chunkSize = parseInt(body.subarray(offset, sizeEnd).toString('ascii').split(';', 1)[0], 16);
    if (!Number.isFinite(chunkSize)) break;
    if (chunkSize === 0) break;
    const chunkStart = sizeEnd + 2;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > body.length) break;
    chunks.push(body.subarray(chunkStart, chunkEnd));
    offset = chunkEnd + 2;
  }
  return Buffer.concat(chunks);
}

function parseChunkedBody(body: string): string {
  return parseChunkedBuffer(Buffer.from(body, 'utf8')).toString('utf8');
}


/**
 * Make a raw GET request to Incus API via Unix socket (returns non-JSON body as string)
 * Used for downloading log files from exec operations.
 */
interface IncusRawResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

async function incusRawRequest(
  method: string,
  path: string,
  options: { data?: Buffer; headers?: string[]; timeout?: number } = {},
): Promise<IncusRawResponse> {
  const socketPath = process.env.INCUS_SOCKET || '/var/lib/incus/unix.socket';

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const data = options.data ?? Buffer.alloc(0);
    const socket = openIncus(() => {
      const headers = [
        `${method} ${path} HTTP/1.1`,
        'Host: localhost',
        ...(options.headers ?? []),
        `Content-Length: ${data.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      socket.write(headers);
      if (data.length > 0) socket.write(data);
    }, socketPath);

    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => {
      const raw = Buffer.concat(chunks);
      const separator = Buffer.from('\r\n\r\n');
      const bodyStart = raw.indexOf(separator);
      if (bodyStart === -1) {
        reject(new Error('Incus response is missing headers'));
        return;
      }
      const headerLines = raw.subarray(0, bodyStart).toString('ascii').split('\r\n');
      const statusCode = Number(headerLines[0]?.split(' ')[1] ?? 0);
      const headers = Object.fromEntries(headerLines.slice(1).flatMap((line) => {
        const separatorIndex = line.indexOf(':');
        return separatorIndex < 0 ? [] : [[line.slice(0, separatorIndex).toLowerCase(), line.slice(separatorIndex + 1).trim()]];
      }));
      const rawBody = raw.subarray(bodyStart + separator.length);
      const body = headers['transfer-encoding']?.toLowerCase() === 'chunked' ? parseChunkedBuffer(rawBody) : rawBody;
      resolve({ statusCode, headers, body });
    });

    socket.on('error', (error) => reject(new Error(`Socket error: ${error.message}`)));
    socket.setTimeout(options.timeout ?? 10_000);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Socket timeout'));
    });
  });
}

async function incusRawGetBuffer(path: string): Promise<Buffer> {
  return (await incusRawRequest('GET', path)).body;
}

async function incusRawGet(path: string): Promise<string> {
  return (await incusRawGetBuffer(path)).toString('utf8');
}

async function incusDownloadRawFile(path: string, errorMessage: string): Promise<Buffer> {
  const body = await incusRawGetBuffer(path);
  const text = body.toString('utf8');
  if (text.trimStart().startsWith('{')) {
    try {
      const response = JSON.parse(text) as Partial<IncusResponse>;
      if (response.type === 'error' || response.error) throw new Error(errorMessage);
    } catch (error) {
      if (error instanceof Error && error.message === errorMessage) throw error;
    }
  }
  return body;
}

/** Read a text file through the Incus instance files API without creating exec output. */
export async function incusDownloadFile(instanceName: string, remotePath: string): Promise<Buffer> {
  return incusDownloadRawFile(
    `/1.0/instances/${encodeURIComponent(instanceName)}/files?path=${encodeURIComponent(remotePath)}`,
    'Incus file download failed',
  );
}

function incusVolumeFilePath(pool: string, volume: string, remotePath: string): string {
  return `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/files?path=${encodeURIComponent(remotePath)}`;
}

/** Read a file directly from a custom filesystem volume. */
export async function incusDownloadVolumeFile(
  pool: string,
  volume: string,
  remotePath: string,
): Promise<Buffer> {
  return incusDownloadRawFile(
    incusVolumeFilePath(pool, volume, remotePath),
    'Incus volume file download failed',
  );
}

export interface IncusVolumeFileInfo {
  type: 'file' | 'directory' | 'symlink';
  mode: string;
}

/** Inspect exact file type and mode directly on a custom filesystem volume. */
export async function incusInspectVolumeFile(
  pool: string,
  volume: string,
  remotePath: string,
): Promise<IncusVolumeFileInfo | null> {
  const response = await incusRawRequest('HEAD', incusVolumeFilePath(pool, volume, remotePath));
  if (response.statusCode === 404) return null;
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('Incus volume file inspection failed');
  }
  const type = response.headers['x-incus-type'];
  const mode = response.headers['x-incus-mode'];
  if ((type !== 'file' && type !== 'directory' && type !== 'symlink') || !/^0[0-7]{3,4}$/.test(mode ?? '')) {
    throw new Error('Incus volume file metadata is invalid');
  }
  return { type, mode };
}

/** Create one directory on a custom filesystem volume. Parents must exist. */
export async function incusCreateVolumeDirectory(
  pool: string,
  volume: string,
  remotePath: string,
  mode: string,
): Promise<void> {
  const response = await incusRawRequest('POST', incusVolumeFilePath(pool, volume, remotePath), {
    headers: [
      'Content-Type: application/octet-stream',
      'X-Incus-type: directory',
      `X-Incus-mode: ${mode}`,
      'X-Incus-write: overwrite',
    ],
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('Incus volume directory creation failed');
  }
}

/**
 * Make a request to Incus API via Unix socket
 */
export async function incusRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: { timeout?: number }
): Promise<IncusResponse<T>> {
  const socketPath = process.env.INCUS_SOCKET || '/var/lib/incus/unix.socket';
  
  return new Promise((resolve, reject) => {
    let responseData = '';
    let headersReceived = false;
    let contentLength = -1;  // -1 means not specified (chunked)
    let isChunked = false;
    let bodyStartIndex = 0;

    const socket = openIncus(() => {
      // Build HTTP request
      const bodyStr = body ? JSON.stringify(body) : '';
      const headers = [
        `${method} ${path} HTTP/1.1`,
        'Host: localhost',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(bodyStr)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      socket.write(headers);
      if (bodyStr) {
        socket.write(bodyStr);
      }
    }, socketPath);

    socket.on('data', (data) => {
      responseData += data.toString();

      // Parse headers if not done yet
      if (!headersReceived) {
        const headerEndIndex = responseData.indexOf('\r\n\r\n');
        if (headerEndIndex !== -1) {
          headersReceived = true;
          bodyStartIndex = headerEndIndex + 4;
          
          // Extract headers
          const headerSection = responseData.substring(0, headerEndIndex).toLowerCase();
          
          // Check for Content-Length
          const contentLengthMatch = headerSection.match(/content-length: (\d+)/);
          if (contentLengthMatch) {
            contentLength = parseInt(contentLengthMatch[1], 10);
          }
          
          // Check for chunked transfer encoding
          if (headerSection.includes('transfer-encoding: chunked')) {
            isChunked = true;
          }
        }
      }

      // Check if we have the full body (only for Content-Length responses)
      if (headersReceived && contentLength > 0) {
        const currentBodyLength = Buffer.byteLength(responseData.substring(bodyStartIndex));
        if (currentBodyLength >= contentLength) {
          socket.end();
        }
      }
    });

    socket.on('end', () => {
      try {
        // Get the body
        let bodyStr = responseData.substring(bodyStartIndex);
        
        // Handle chunked transfer encoding
        if (isChunked) {
          bodyStr = parseChunkedBody(bodyStr);
        }
        
        const jsonResponse = JSON.parse(bodyStr) as IncusResponse<T>;
        resolve(jsonResponse);
      } catch (error) {
        reject(new Error(`Failed to parse Incus response: ${error}`));
      }
    });

    socket.on('error', (error) => {
      reject(new Error(`Socket error: ${error.message}`));
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Socket timeout'));
    });

    // Set timeout (configurable for long operations like OCI image downloads)
    socket.setTimeout(options?.timeout ?? 30000);
  });
}

/**
 * Upload raw file bytes into a container via the Incus files API.
 * Used when Control Panel must stage artifacts without giving the target
 * container outbound internet access.
 */
async function incusUploadRawFile(
  path: string,
  data: Buffer,
  options?: { timeout?: number; mode?: string; createDirs?: boolean }
): Promise<void> {
  const socketPath = process.env.INCUS_SOCKET || '/var/lib/incus/unix.socket';

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    const socket = openIncus(() => {
      const headers = [
        `POST ${path} HTTP/1.1`,
        'Host: localhost',
        'Content-Type: application/octet-stream',
        ...(options?.mode ? [`X-Incus-mode: ${options.mode}`] : []),
        ...(options?.createDirs ? ['X-Incus-create-dirs: true'] : []),
        'X-Incus-write: overwrite',
        `Content-Length: ${data.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      socket.write(headers);
      socket.write(data);
    }, socketPath);

    socket.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    socket.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        const bodyStart = raw.indexOf('\r\n\r\n');
        const headerSection = bodyStart === -1 ? '' : raw.substring(0, bodyStart).toLowerCase();
        let body = bodyStart === -1 ? raw : raw.substring(bodyStart + 4);
        if (headerSection.includes('transfer-encoding: chunked')) {
          body = parseChunkedBody(body);
        }
        const response = JSON.parse(body) as IncusResponse;
        if (response.type === 'error' || response.error) {
          reject(new Error(response.error || `Incus upload failed with status ${response.status}`));
          return;
        }
        resolve();
      } catch (error) {
        reject(new Error(`Failed to parse Incus upload response: ${error}`));
      }
    });

    socket.on('error', (error) => {
      reject(new Error(`Socket error: ${error.message}`));
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Socket timeout'));
    });

    socket.setTimeout(options?.timeout ?? 300_000);
  });
}

export async function incusUploadFile(
  instanceName: string,
  remotePath: string,
  data: Buffer,
  options?: { timeout?: number; mode?: string; createDirs?: boolean }
): Promise<void> {
  return incusUploadRawFile(
    `/1.0/instances/${encodeURIComponent(instanceName)}/files?path=${encodeURIComponent(remotePath)}`,
    data,
    options,
  );
}

/** Write raw bytes directly into a custom filesystem volume. */
export async function incusUploadVolumeFile(
  pool: string,
  volume: string,
  remotePath: string,
  data: Buffer,
  options?: { timeout?: number; mode?: string }
): Promise<void> {
  return incusUploadRawFile(
    incusVolumeFilePath(pool, volume, remotePath),
    data,
    options,
  );
}

/**
 * Get server information
 */
export async function getServerInfo() {
  return incusRequest('GET', '/1.0');
}

/**
 * List all instances
 */
export async function listInstances() {
  return incusRequest<string[]>('GET', '/1.0/instances');
}

/**
 * Get instance details
 */
export async function getInstance(name: string) {
  return incusRequest('GET', `/1.0/instances/${encodeURIComponent(name)}`);
}

/**
 * Get instance state
 */
export async function getInstanceState(name: string) {
  return incusRequest('GET', `/1.0/instances/${encodeURIComponent(name)}/state`);
}

/**
 * Update instance state (start, stop, restart)
 */
export async function updateInstanceState(
  name: string,
  action: 'start' | 'stop' | 'restart' | 'freeze' | 'unfreeze',
  force = false
) {
  return incusRequest('PUT', `/1.0/instances/${encodeURIComponent(name)}/state`, {
    action,
    force,
    timeout: 30,
  });
}

/**
 * Create a new instance
 */
export async function createInstance(
  name: string,
  image: string,
  config?: Record<string, string>,
  devices?: Record<string, Record<string, string>>
) {
  return incusRequest('POST', '/1.0/instances', {
    name,
    source: {
      type: 'image',
      alias: image,
    },
    config,
    devices,
  });
}

/**
 * Delete an instance
 */
export async function deleteInstance(name: string) {
  return incusRequest('DELETE', `/1.0/instances/${encodeURIComponent(name)}`);
}

/**
 * Execute a command inside a container
 * Uses the exec endpoint with record-output for synchronous execution
 */
export async function execCommand(
  containerName: string,
  command: string[],
  options?: {
    environment?: Record<string, string>;
    timeout?: number;
    workingDir?: string;
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Create the exec request with record-output for synchronous mode
  const execRequest = {
    command,
    environment: options?.environment || {},
    'wait-for-websocket': false,
    interactive: false,
    'record-output': true,
    'cwd': options?.workingDir || '/',
  };
  
  interface ExecOperationMeta {
    status: string;
    status_code: number;
    metadata?: {
      return?: number;
      output?: {
        '1'?: string;
        '2'?: string;
      };
    };
  }
  
  const response = await incusRequest<ExecOperationMeta>(
    'POST', 
    `/1.0/instances/${encodeURIComponent(containerName)}/exec`, 
    execRequest
  );

  if (response.type === 'error') {
    const reason = response.error?.trim() || response.status?.trim() || 'Incus rejected the exec request';
    throw new Error(`Incus exec request failed for ${containerName}: ${reason}`);
  }
  
  // If async operation, wait for it to complete
  if (response.type === 'async' && response.operation) {
    const timeout = options?.timeout || 30000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      // Use Incus server-side wait with 30s chunks to avoid socket timeouts
      const remainingMs = timeout - (Date.now() - startTime);
      const waitSec = Math.min(30, Math.ceil(remainingMs / 1000));
      
      let opResponse;
      try {
        opResponse = await incusRequest<ExecOperationMeta>(
          'GET', 
          `${response.operation}/wait?timeout=${waitSec}`,
          undefined,
          { timeout: (waitSec + 10) * 1000 }
        );
      } catch {
        // Socket timeout or network error — retry if we still have time
        if (Date.now() - startTime >= timeout) break;
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      if (opResponse.type === 'error') {
        const reason = opResponse.error?.trim() || opResponse.status?.trim() || 'Incus rejected the exec wait request';
        throw new Error(`Incus exec wait failed for ${containerName}: ${reason}`);
      }
      
      if (opResponse.metadata) {
        const meta = opResponse.metadata;
        if (meta.status === 'Success' || meta.status === 'Failure') {
          // The output fields contain log file paths, not content.
          // We need to fetch the actual content from those paths.
          let stdout = '';
          let stderr = '';
          
          const stdoutPath = meta.metadata?.output?.['1'];
          const stderrPath = meta.metadata?.output?.['2'];
          
          if (stdoutPath) {
            try {
              stdout = await incusRawGet(stdoutPath);
            } catch {
              stdout = '';
            }
          }
          
          if (stderrPath) {
            try {
              stderr = await incusRawGet(stderrPath);
            } catch {
              stderr = '';
            }
          }
          
          return {
            exitCode: meta.metadata?.return || 0,
            stdout,
            stderr,
          };
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error('Exec operation timed out');
  }
  
  // Synchronous response
  if (response.metadata) {
    return {
      exitCode: response.metadata.metadata?.return || 0,
      stdout: response.metadata.metadata?.output?.['1'] || '',
      stderr: response.metadata.metadata?.output?.['2'] || '',
    };
  }
  
  throw new Error(`Incus exec response for ${containerName} did not contain operation metadata`);
}

/**
 * Execute a simple shell command inside a container
 * Wraps execCommand with shell execution
 */
export async function execShell(
  containerName: string,
  shellCommand: string,
  options?: {
    environment?: Record<string, string>;
    timeout?: number;
    workingDir?: string;
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execCommand(containerName, ['sh', '-c', shellCommand], options);
}
