export function validatePublicClientRegistration(value: unknown): { name: string; redirectUris: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length < 1 || input.redirectUris.length > 5) return null;
  const redirectUris: string[] = [];
  for (const raw of input.redirectUris) {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    try {
      const url = new URL(raw);
      const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
      if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.hash
        || (url.protocol === 'https:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || !url.hostname.includes('.')))
        || url.href !== raw) return null;
      redirectUris.push(raw);
    } catch { return null; }
  }
  if (new Set(redirectUris).size !== redirectUris.length) return null;
  return { name, redirectUris };
}
