export function identityFaviconLinks(): string {
  return [
    '<link rel="icon" type="image/png" sizes="32x32" href="/api/branding/favicon?size=32" />',
    '<link rel="icon" type="image/png" sizes="16x16" href="/api/branding/favicon?size=16" />',
    '<link rel="apple-touch-icon" sizes="180x180" href="/api/branding/favicon?size=180" />',
  ].join('\n  ');
}
