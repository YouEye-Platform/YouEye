import { randomBytes } from 'crypto';
import { spineClient } from '@/lib/spine/client';
import { getIdentityProviderConfig, createOAuthClient } from './provider';
import { ensureUser } from './store';

function secret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

function httpVariant(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = 'http:';
  return parsed.toString();
}

function controlRedirectUris(controlExternalUrl: string, settingsExternalUrl?: string): string[] {
  const withHttp = (url: string): string[] => [url, httpVariant(url)];
  // The Control Panel host (e.g. https://control.<domain>) needs BOTH callbacks:
  //   /api/auth/callback          — direct CP login
  //   /settings/api/auth/callback — silent settings SSO (added cp-v0.4.15)
  // Registering only /api/auth/callback caused invalid_redirect_uri when a
  // signed-out user hit control.<domain>/ and was bounced through settings SSO.
  const uris = [
    ...withHttp(`${controlExternalUrl}/api/auth/callback`),
    ...withHttp(`${controlExternalUrl}/settings/api/auth/callback`),
  ];
  // settingsExternalUrl already points at the /settings base (e.g.
  // https://<domain>/settings), so its callback is just /api/auth/callback.
  if (settingsExternalUrl) {
    uris.push(...withHttp(`${settingsExternalUrl}/api/auth/callback`));
  }
  return Array.from(new Set(uris));
}

function uiRedirectUris(uiExternalUrl: string): string[] {
  return Array.from(new Set([
    `${uiExternalUrl}/api/auth/callback`,
    httpVariant(`${uiExternalUrl}/api/auth/callback`),
  ]));
}

export async function ensureIdentityAdminUser(params: {
  username: string;
  password: string;
  name: string;
  email: string;
}): Promise<void> {
  await ensureUser({
    username: params.username,
    password: params.password,
    name: params.name || params.username,
    email: params.email,
    groups: ['youeye-users', 'admin'],
    isAdmin: true,
  });
}

export async function configureControlPanelIdentitySSO(params: {
  controlExternalUrl: string;
  settingsExternalUrl?: string;
}): Promise<{ clientId: string; clientSecret: string }> {
  const identity = await getIdentityProviderConfig();
  const client = await createOAuthClient({
    clientId: 'youeye-control',
    name: 'YouEye Control Panel',
    redirectUris: controlRedirectUris(params.controlExternalUrl, params.settingsExternalUrl),
  });

  await spineClient.setControlSSO({
    identity_url: identity.externalUrl,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    internal_url: 'http://127.0.0.1:3001',
    identity_internal_url: 'http://127.0.0.1:3001',
    control_url: params.controlExternalUrl,
  });

  return client;
}

export async function configureUIIdentitySSO(params: {
  uiExternalUrl: string;
  databaseUrl: string;
  jwtSecret?: string;
}): Promise<{ clientId: string; clientSecret: string; jwtSecret: string }> {
  const identity = await getIdentityProviderConfig();
  const client = await createOAuthClient({
    clientId: 'youeye-ui',
    name: 'YouEye UI',
    redirectUris: uiRedirectUris(params.uiExternalUrl),
  });
  const jwtSecret = params.jwtSecret || secret(48);

  await spineClient.setUISSO({
    identity_url: identity.externalUrl,
    identity_internal_url: 'http://localhost:3002',
    client_id: client.clientId,
    client_secret: client.clientSecret,
    jwt_secret: jwtSecret,
    database_url: params.databaseUrl,
    domain: new URL(params.uiExternalUrl).host,
    base_url: params.uiExternalUrl,
  });

  return { ...client, jwtSecret };
}
