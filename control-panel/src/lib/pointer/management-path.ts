const PERSONAL_PREFIXES = [
  '/api/providers',
  '/api/provider-accounts',
  '/api/catalog',
  '/api/groups',
  '/api/instances',
  '/api/keys',
  '/api/stats',
  '/api/test-model',
  '/api/connections',
  '/api/sources',
  '/api/codex-auth',
  '/api/admin',
];

export function allowedPointerManagementPath(path: string) {
  if (!path.startsWith('/api/') || /[\\#]/.test(path) || /%2e|%2f|%5c/i.test(path)
    || path.split('?')[0].split('/').some(value => value === '.' || value === '..')) return false;
  let pathname: string;
  try {
    pathname = new URL(path, 'http://pointer.internal').pathname;
  } catch {
    return false;
  }
  return PERSONAL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

