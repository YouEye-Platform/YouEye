/**
 * Server-side Incus Client
 * 
 * This module provides direct Unix socket communication with Incus daemon.
 * Used by API routes to proxy requests from the browser client.
 */

import { Socket } from 'net';

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
function parseChunkedBody(body: string): string {
  let result = '';
  let remaining = body;
  
  while (remaining.length > 0) {
    // Find the chunk size line
    const sizeEndIndex = remaining.indexOf('\r\n');
    if (sizeEndIndex === -1) break;
    
    const sizeHex = remaining.substring(0, sizeEndIndex);
    const chunkSize = parseInt(sizeHex, 16);
    
    // End of chunks
    if (chunkSize === 0) break;
    
    // Extract the chunk data
    const chunkStart = sizeEndIndex + 2;
    const chunkEnd = chunkStart + chunkSize;
    result += remaining.substring(chunkStart, chunkEnd);
    
    // Move past chunk data and trailing \r\n
    remaining = remaining.substring(chunkEnd + 2);
  }
  
  return result;
}

/**
 * Make a raw GET request to Incus API via Unix socket (returns non-JSON body as string)
 * Used for downloading log files from exec operations.
 */
async function incusRawGet(path: string): Promise<string> {
  const socketPath = process.env.INCUS_SOCKET || '/var/lib/incus/unix.socket';
  
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];

    socket.connect(socketPath, () => {
      const headers = [
        `GET ${path} HTTP/1.1`,
        'Host: localhost',
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      socket.write(headers);
    });

    socket.on('data', (data) => {
      chunks.push(data);
    });

    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      // Find the body after headers
      const bodyStart = raw.indexOf('\r\n\r\n');
      if (bodyStart === -1) {
        resolve('');
        return;
      }
      let body = raw.substring(bodyStart + 4);
      
      // Handle chunked transfer encoding
      const headerSection = raw.substring(0, bodyStart).toLowerCase();
      if (headerSection.includes('transfer-encoding: chunked')) {
        body = parseChunkedBody(body);
      }
      
      resolve(body);
    });

    socket.on('error', (error) => {
      reject(new Error(`Socket error: ${error.message}`));
    });

    socket.setTimeout(10000);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Socket timeout'));
    });
  });
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
    const socket = new Socket();
    let responseData = '';
    let headersReceived = false;
    let contentLength = -1;  // -1 means not specified (chunked)
    let isChunked = false;
    let bodyStartIndex = 0;

    socket.connect(socketPath, () => {
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
    });

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
  
  throw new Error('Unexpected exec response format');
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
