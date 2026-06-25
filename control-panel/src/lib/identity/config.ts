import { settingsService } from '@/lib/settings';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';

export interface IdentityConfig {
  domain: string;
  subdomain: string;
  externalUrl: string;
  internalUrl: string;
  containerName: string;
  port: number;
  issuer: string;
  cookieDomain: string;
}

function normalizeSubdomain(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Identity provider subdomain is not configured. Set subdomains.identity in setup or repair config.');
  }
  const subdomain = value.trim().replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    throw new Error(`Invalid identity provider subdomain "${value}". Use a single DNS label.`);
  }
  return subdomain;
}

function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Platform domain is not configured. The identity provider cannot derive its issuer.');
  }
  return value.trim().replace(/\.+$/g, '');
}

export async function getIdentityConfig(): Promise<IdentityConfig> {
  const raw = await settingsService.getRaw();
  const domain = normalizeDomain(raw.domain);
  const subdomain = normalizeSubdomain(raw.subdomains?.identity);
  const host = `${subdomain}.${domain}`;
  const containerName = 'youeye-control';
  const port = 3001;

  return {
    domain,
    subdomain,
    externalUrl: `https://${host}`,
    internalUrl: `http://${containerName}.${CONTAINER_DOMAIN}:${port}`,
    containerName,
    port,
    issuer: `https://${host}`,
    cookieDomain: `.${domain}`,
  };
}
