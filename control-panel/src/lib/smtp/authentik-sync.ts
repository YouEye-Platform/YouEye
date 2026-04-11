/**
 * Authentik SMTP Sync
 *
 * Configures Authentik's email backend with SMTP credentials.
 * This enables password reset emails, verification emails, etc.
 */

import { spineClient } from '@/lib/spine/client';
import { getContainerIP } from '@/lib/incus/container-ip';

interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  useTls: boolean;
}

interface AuthentikConfig {
  url: string;
  token: string;
}

async function getAuthentikConfig(): Promise<AuthentikConfig> {
  const creds = await spineClient.getAuthentikCredentials();
  const ip = await getContainerIP('youeye-authentik');
  const url = ip ? `http://${ip}:9000` : creds.internal_url;
  return { url, token: creds.bootstrap_token };
}

async function authentikAPI<T>(
  config: AuthentikConfig,
  path: string,
  method: string = 'GET',
  body?: Record<string, unknown>
): Promise<T> {
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${config.url}/api/v3${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Authentik API ${res.status}: ${text}`);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

/**
 * Configure Authentik's email stage with SMTP credentials.
 * Updates the default authentication email stage and brand email settings.
 */
export async function configureAuthentikSmtp(smtp: SmtpConfig): Promise<void> {
  const config = await getAuthentikConfig();

  // Find the default email stage
  const stages = await authentikAPI<{
    results: Array<{ pk: string; name: string }>;
  }>(config, '/stages/email/?search=default-authentication-email');

  if (!stages.results?.length) {
    throw new Error('No default email stage found in Authentik');
  }

  const stageId = stages.results[0].pk;

  // Patch the email stage with SMTP config
  await authentikAPI(config, `/stages/email/${stageId}/`, 'PATCH', {
    host: smtp.host,
    port: smtp.port,
    username: smtp.username,
    password: smtp.password,
    use_tls: smtp.useTls && smtp.port !== 465,
    use_ssl: smtp.port === 465,
    from_address: smtp.from,
    timeout: 10,
  });

  // Update brand email "from" address
  try {
    const brands = await authentikAPI<{
      results: Array<{ brand_uuid: string; domain: string }>;
    }>(config, '/core/brands/?search=authentik-default');

    if (brands.results?.length) {
      const brandId = brands.results[0].brand_uuid;
      await authentikAPI(config, `/core/brands/${brandId}/`, 'PATCH', {
        branding_email_from: smtp.from,
      });
    }
  } catch {
    // Brand update is best-effort
  }
}
