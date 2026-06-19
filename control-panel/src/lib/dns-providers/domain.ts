import dns from 'dns';
import net from 'net';

const BLOCKED_HOSTS = new Set(['localhost']);

export function normalizeDomainInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Domain is required');
  if (trimmed.includes('*')) throw new Error('Enter the domain without a wildcard');

  let hostname = trimmed;
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    hostname = parsed.hostname;
  } catch {
    throw new Error('Enter a valid domain or URL');
  }

  hostname = hostname.toLowerCase().replace(/\.+$/, '');
  if (!hostname || BLOCKED_HOSTS.has(hostname)) throw new Error('Enter a real domain name');
  if (net.isIP(hostname)) throw new Error('Enter a domain name, not an IP address');

  const labels = hostname.split('.');
  if (labels.length < 2) throw new Error('Enter a domain with at least two labels');
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new Error('Domain contains an invalid label');
    }
  }
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) {
    throw new Error('Domain top-level label is invalid');
  }

  return hostname;
}

export function managedAddressNames(domain: string): string[] {
  return [domain, `*.${domain}`];
}

export function acmeTxtName(identifier: string): string {
  return `_acme-challenge.${identifier.replace(/^\*\./, '')}`;
}

export function candidateZonesForDomain(domain: string): string[] {
  const labels = domain.split('.');
  const candidates: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1) {
    candidates.push(labels.slice(i).join('.'));
  }
  return candidates;
}

export async function hasPublicNsAtName(name: string): Promise<string[]> {
  try {
    return await dns.promises.resolveNs(name);
  } catch {
    return [];
  }
}

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
