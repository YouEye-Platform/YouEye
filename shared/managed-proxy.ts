import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { Readable } from 'node:stream';

/** Public transport inputs delivered only by the authenticated CP bridge. */
export type ManagedProxyTransport = {
  schema: 'youeye.managed-proxy.v1';
  address: string;
  hostname: string;
  ca: string;
};

export function managedProxyTransport(value: unknown, destination: string): ManagedProxyTransport {
  const candidate = value as Partial<ManagedProxyTransport> | null;
  const url = new URL(destination);
  if (!candidate || candidate.schema !== 'youeye.managed-proxy.v1'
    || typeof candidate.address !== 'string' || isIP(candidate.address) !== 4
    || typeof candidate.hostname !== 'string' || candidate.hostname.length > 253
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(candidate.hostname)
    || url.protocol !== 'https:' || url.hostname !== candidate.hostname
    || url.port || url.username || url.password || url.hash
    || typeof candidate.ca !== 'string' || candidate.ca.length > 32768) {
    throw new Error('Invalid managed proxy transport');
  }
  const [first, second] = candidate.address.split('.').map(Number);
  if (!(first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168))) throw new Error('Managed proxy address must be private');
  const certificate = new X509Certificate(candidate.ca);
  if (!certificate.ca) throw new Error('Managed proxy trust must be a CA certificate');
  return { schema: candidate.schema, address: candidate.address, hostname: candidate.hostname, ca: candidate.ca };
}

/**
 * Dial the managed gateway without public DNS, retaining the original TLS name,
 * Host header and certificate verification. The returned body is raw HTTP bytes;
 * callers must preserve its Content-Encoding and Content-Length headers.
 */
export function requestManagedProxy(
  destination: string,
  transport: unknown,
  init: { method: string; headers: Headers; body?: ArrayBuffer; signal?: AbortSignal },
  request = httpsRequest,
): Promise<Response> {
  const selected = managedProxyTransport(transport, destination);
  const url = new URL(destination);
  const headers = Object.fromEntries(init.headers.entries());
  headers.host = selected.hostname;
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: selected.address, port: 443, servername: selected.hostname,
      path: `${url.pathname}${url.search}`, method: init.method, headers,
      ca: [...rootCertificates, selected.ca], rejectUnauthorized: true,
      agent: false, signal: init.signal,
    }, incoming => {
      const responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      const status = incoming.statusCode ?? 502;
      const noBody = init.method === 'HEAD' || [204, 205, 304].includes(status);
      if (noBody) incoming.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status, headers: responseHeaders,
      }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error('Managed proxy transport timed out')));
    outgoing.end(init.body ? Buffer.from(init.body) : undefined);
  });
}
