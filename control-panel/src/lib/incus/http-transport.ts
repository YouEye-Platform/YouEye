import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

export type IncusEndpoint =
  | { tls: false; socketPath: string }
  | { tls: true; host: string; port: number; cert?: Buffer; key?: Buffer };

/** Bounded connection reuse. Only a GET reset on a reused socket before its
 * response may retry once. Mutations are never replayed: they may have committed. */
export function createIncusTransport(endpoint: () => IncusEndpoint) {
  // Keep the bounded burst pool across 30-second audits; active requests still
  // retain their independent inactivity/absolute deadlines below.
  const options = { keepAlive: true, maxSockets: 16, maxTotalSockets: 16, maxFreeSockets: 16, timeout: 120_000 };
  const httpAgent = new HttpAgent(options);
  const httpsAgent = new HttpsAgent(options);
  let pending = 0;

  function request<T>(method: string, path: string, body?: unknown, options?: { timeout?: number; deadlineMs?: number }): Promise<T> {
    if (pending >= 256) return Promise.reject(new Error('Incus request queue is full'));
    const ep = endpoint();
    const payload = body === undefined ? '' : JSON.stringify(body);
    pending++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let activeRequest: import('node:http').ClientRequest | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let connectionDeadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        pending--;
        if (deadline) clearTimeout(deadline);
        if (connectionDeadline) clearTimeout(connectionDeadline);
        if (error) reject(error); else resolve(value as T);
      };
      const receive = (response: import('node:http').IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('error', () => finish(new Error('Incus response interrupted')));
        response.on('end', () => {
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
          catch { finish(new Error('Failed to parse Incus response')); }
        });
      };
      const attempt = (retried: boolean) => {
        try {
          let responseStarted = false;
          const common = {
            method, path,
            headers: { Host: 'localhost', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          };
          const req = ep.tls
            // Preserve the existing local Incus client-certificate trust contract.
            ? httpsRequest({ ...common, host: ep.host, port: ep.port, cert: ep.cert, key: ep.key, rejectUnauthorized: false, agent: httpsAgent }, response => { responseStarted = true; receive(response); })
            : httpRequest({ ...common, socketPath: ep.socketPath, agent: httpAgent }, response => { responseStarted = true; receive(response); });
          activeRequest = req;
          req.on('error', (error: NodeJS.ErrnoException) => {
            if (!settled && !retried && !responseStarted && method === 'GET'
              && body === undefined && req.reusedSocket && error.code === 'ECONNRESET') {
              // The peer can close an idle connection between selection and use.
              // Keep the same admission slot, bounded agent and absolute deadline.
              if (connectionDeadline) clearTimeout(connectionDeadline);
              attempt(true);
              return;
            }
            finish(new Error(`Socket error: ${error.message}`));
          });
          req.setTimeout(options?.timeout ?? 30_000, () => req.destroy(new Error('Socket timeout')));
          // Bound waiting for a pooled connection without turning an inactivity
          // timeout into a new absolute limit on long, actively streaming reads.
          connectionDeadline = setTimeout(() => req.destroy(new Error('Socket connection timeout')), options?.timeout ?? 30_000);
          req.once('socket', socket => {
            const connected = () => { if (connectionDeadline) clearTimeout(connectionDeadline); };
            if (!socket.connecting) connected();
            else socket.once(ep.tls ? 'secureConnect' : 'connect', connected);
          });
          req.end(payload);
        } catch (error) { finish(error instanceof Error ? error : new Error('Incus request failed')); }
      };
      if (options?.deadlineMs !== undefined) {
        deadline = setTimeout(() => activeRequest?.destroy(new Error('Socket absolute timeout')), options.deadlineMs);
      }
      attempt(false);
    });
  }
  return { request, close() { httpAgent.destroy(); httpsAgent.destroy(); } };
}
