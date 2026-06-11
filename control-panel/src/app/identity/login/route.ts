import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { getIdentityConfig } from '@/lib/identity/config';
import { getClient, verifyUser } from '@/lib/identity/store';
import { createIdentityToken } from '@/lib/identity/tokens';
import { setIdentityCookie } from '@/lib/identity/http';
import { getIdentityProviderConfig } from '@/lib/identity/provider';
import { settingsService } from '@/lib/settings';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { CHARACTER_SHAPE_PRESETS, DEFAULT_STYLE, type SiteNameStyle } from '@/lib/wordart-presets';

const TOKEN_FILE_PATH = '/etc/youeye/ui-bridge-token';
const UI_BASE = `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;
const CORE_CLIENT_IDS = new Set(['youeye-ui', 'youeye-control']);

let cachedBridgeToken: string | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeCss(value: unknown, fallback = ''): string {
  return typeof value === 'string' && !/[;{}<>]/.test(value) ? value : fallback;
}

function bridgeToken(): string | null {
  if (cachedBridgeToken) return cachedBridgeToken;
  try {
    cachedBridgeToken = readFileSync(TOKEN_FILE_PATH, 'utf-8').trim();
    return cachedBridgeToken || null;
  } catch (err) {
    console.warn('[identity-login] UI bridge token unavailable; falling back to Control Panel branding settings.', err);
    return null;
  }
}

const FONT_CSS_MAP: Record<string, string> = {
  Montserrat: '/fonts/montserrat.css',
  'Playfair Display': '/fonts/playfair-display.css',
  Inter: '/fonts/inter.css',
  Poppins: '/fonts/poppins.css',
  'Space Grotesk': '/fonts/space-grotesk.css',
  'JetBrains Mono': '/fonts/jetbrains-mono.css',
  Raleway: '/fonts/raleway.css',
  Caveat: '/fonts/caveat.css',
  Outfit: '/fonts/outfit.css',
  'Plus Jakarta Sans': '/fonts/plus-jakarta-sans.css',
  Lobster: '/fonts/lobster.css',
  'Permanent Marker': '/fonts/permanent-marker.css',
  Orbitron: '/fonts/orbitron.css',
  'Abril Fatface': '/fonts/abril-fatface.css',
  Pacifico: '/fonts/pacifico.css',
  Bungee: '/fonts/bungee.css',
  'Russo One': '/fonts/russo-one.css',
  Fredoka: '/fonts/fredoka.css',
  Satisfy: '/fonts/satisfy.css',
  Righteous: '/fonts/righteous.css',
  Bangers: '/fonts/bangers.css',
  'Bebas Neue': '/fonts/bebas-neue.css',
  'Dancing Script': '/fonts/dancing-script.css',
  Comfortaa: '/fonts/comfortaa.css',
  Oswald: '/fonts/oswald.css',
  'Titan One': '/fonts/titan-one.css',
  'Black Ops One': '/fonts/black-ops-one.css',
  Creepster: '/fonts/creepster.css',
  Monoton: '/fonts/monoton.css',
  'Press Start 2P': '/fonts/press-start-2p.css',
  Audiowide: '/fonts/audiowide.css',
  Cinzel: '/fonts/cinzel.css',
  'Great Vibes': '/fonts/great-vibes.css',
  Quicksand: '/fonts/quicksand.css',
  'Archivo Black': '/fonts/archivo-black.css',
};

function normalizeWordArt(value: unknown): SiteNameStyle {
  const style = value && typeof value === 'object'
    ? value as Partial<SiteNameStyle>
    : {};
  const gradient = style.gradient && typeof style.gradient === 'object'
    ? {
        enabled: Boolean(style.gradient.enabled),
        from: style.gradient.from || DEFAULT_STYLE.gradient?.from || '#111111',
        to: style.gradient.to || DEFAULT_STYLE.gradient?.to || '#111111',
        direction: style.gradient.direction || DEFAULT_STYLE.gradient?.direction || '135deg',
      }
    : style.gradient === null
      ? null
      : DEFAULT_STYLE.gradient;

  return {
    ...DEFAULT_STYLE,
    ...style,
    gradient,
  };
}

type IdentityBranding = {
  siteName: string;
  siteNameStyle: SiteNameStyle;
};

async function controlPanelBrandingFallback(): Promise<IdentityBranding> {
  const raw = await settingsService.getRaw();
  return {
    siteName: typeof raw.site_name === 'string' && raw.site_name.trim() ? raw.site_name.trim() : 'YouEye',
    siteNameStyle: normalizeWordArt(raw.site_name_style),
  };
}

async function identityBranding(): Promise<IdentityBranding> {
  const token = bridgeToken();
  if (!token) return controlPanelBrandingFallback();

  try {
    const res = await fetch(`${UI_BASE}/api/ui-bridge/branding`, {
      headers: { 'X-UI-Bridge-Token': token },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[identity-login] UI branding bridge returned ${res.status}; falling back to Control Panel branding settings.`);
      return controlPanelBrandingFallback();
    }

    const branding = await res.json() as { site_name?: unknown; site_name_style?: unknown };
    return {
      siteName: typeof branding.site_name === 'string' && branding.site_name.trim()
        ? branding.site_name.trim()
        : (await controlPanelBrandingFallback()).siteName,
      siteNameStyle: normalizeWordArt(branding.site_name_style),
    };
  } catch (err) {
    console.warn('[identity-login] UI branding bridge unreachable; falling back to Control Panel branding settings.', err);
    return controlPanelBrandingFallback();
  }
}

function wordmarkStyle(style: SiteNameStyle): string {
  const gradientCss = style.gradient?.enabled
    ? [
        `color: transparent`,
        `background-image: linear-gradient(${safeCss(style.gradient.direction, '135deg')}, ${safeCss(style.gradient.from)}, ${safeCss(style.gradient.to)})`,
        `-webkit-background-clip: text`,
        `background-clip: text`,
        `-webkit-text-fill-color: transparent`,
      ].join('; ')
    : [
        `color: ${safeCss(style.color, '#15171a')}`,
        `background-image: none`,
        `-webkit-background-clip: initial`,
        `background-clip: initial`,
        `-webkit-text-fill-color: ${safeCss(style.color, '#15171a')}`,
      ].join('; ');

  return [
    `font-family: "${safeCss(style.fontFamily, 'Montserrat')}", system-ui, sans-serif`,
    `font-size: clamp(2.15rem, 9vw, 4.4rem)`,
    `font-weight: ${Number(style.fontWeight) || DEFAULT_STYLE.fontWeight}`,
    `letter-spacing: ${safeCss(style.letterSpacing, DEFAULT_STYLE.letterSpacing)}`,
    `text-transform: ${safeCss(style.textTransform, DEFAULT_STYLE.textTransform)}`,
    style.textShadow && style.textShadow !== 'none' ? `text-shadow: ${safeCss(style.textShadow)}` : '',
    style.textStroke ? `-webkit-text-stroke: ${safeCss(style.textStroke)}` : '',
    style.transform ? `transform: ${safeCss(style.transform)}` : '',
    `display: inline-block`,
    `line-height: .98`,
    `backface-visibility: hidden`,
    gradientCss,
  ].filter(Boolean).join('; ');
}

function renderWordmark(name: string, style: SiteNameStyle): string {
  const css = wordmarkStyle(style);
  const charShape = style.charShapeId
    ? CHARACTER_SHAPE_PRESETS.find((preset) => preset.id === style.charShapeId) ?? null
    : null;
  if (!charShape) {
    return `<span class="wordmark" style="${escapeHtml(css)}">${escapeHtml(name)}</span>`;
  }

  const intensity = style.charShapeIntensity ?? 1;
  const chars = name.split('').map((ch, index) => {
    const transform = safeCss(charShape.charTransform(index, name.length, intensity));
    const text = ch === ' ' ? '&nbsp;' : escapeHtml(ch);
    return `<span style="display:inline-block; transform:${escapeHtml(transform)}">${text}</span>`;
  }).join('');
  return `<span class="wordmark wordmark-shaped" style="${escapeHtml(css)}">${chars}</span>`;
}

function wordmarkMarkup(providerName: string, style: SiteNameStyle): { fontLink: string; html: string } {
  const fontHref = FONT_CSS_MAP[style.fontFamily];
  return {
    fontLink: fontHref ? `<link rel="stylesheet" href="${escapeHtml(fontHref)}" />` : '',
    html: renderWordmark(providerName, style),
  };
}

function titleCase(value: string): string {
  return value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function appNameFromClientId(clientId: string): string | null {
  const appId = clientId
    .replace(/^youeye-app-/, '')
    .replace(/^ye-/, '')
    .trim();
  return appId && appId !== clientId ? titleCase(appId) : null;
}

function appNameFromHost(hostname: string): string | null {
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 3) return null;
  const subdomain = labels[0];
  if (['auth', 'control', 'dns', 'id', 'www'].includes(subdomain)) return null;
  return titleCase(subdomain);
}

async function resolveLoginContext(returnTo: string, serverName: string): Promise<string | null> {
  try {
    const url = new URL(returnTo);
    const isAuthorize = url.pathname === '/application/o/authorize' || url.pathname === '/oauth/authorize';
    if (isAuthorize) {
      const clientId = url.searchParams.get('client_id') || '';
      if (clientId) {
        if (CORE_CLIENT_IDS.has(clientId)) return serverName;
        const client = await getClient(clientId).catch(() => null);
        const name = client?.name?.trim() || appNameFromClientId(clientId);
        return name || null;
      }
    }
    return appNameFromHost(url.hostname);
  } catch {
    return null;
  }
}

async function html(returnTo: string, error = ''): Promise<Response> {
  const [provider, branding] = await Promise.all([
    getIdentityProviderConfig(),
    identityBranding(),
  ]);
  const wordmark = wordmarkMarkup(provider.name, branding.siteNameStyle);
  const appName = await resolveLoginContext(returnTo, branding.siteName);
  const contextTitle = appName ? `Continue to ${appName}` : `Continue with ${provider.name}`;
  const contextDescription = appName
    ? `Sign in with ${provider.name} to keep going.`
    : `Sign in with your ${provider.name} account.`;
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  ${wordmark.fontLink}
  <title>${escapeHtml(provider.name)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.65), rgba(255,255,255,.86)),
        linear-gradient(135deg, #eaf8f6 0%, #eff7ff 46%, #f8fbff 100%);
      color: #17191c;
    }
    main { width: min(430px, 100%); }
    .panel {
      display: grid;
      gap: 20px;
      border: 1px solid rgba(24, 36, 48, .12);
      border-radius: 8px;
      background: rgba(255, 255, 255, .94);
      box-shadow: 0 22px 54px rgba(28, 52, 70, .14);
      padding: 22px;
    }
    .identity {
      display: grid;
      gap: 10px;
      place-items: center;
      border: 1px solid #dce8f0;
      border-radius: 8px;
      background: linear-gradient(135deg, #f7fcfb 0%, #eef7ff 100%);
      padding: 22px 18px 18px;
      overflow: hidden;
      text-align: center;
    }
    .wordmark {
      max-width: 100%;
      overflow-wrap: anywhere;
      filter: drop-shadow(0 2px 2px rgba(16, 42, 67, .10));
    }
    .wordmark-shaped {
      display: inline-flex !important;
      align-items: baseline;
      justify-content: center;
      flex-wrap: wrap;
    }
    .identity-pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid #d4e5ee;
      border-radius: 999px;
      background: rgba(255,255,255,.78);
      padding: 0 10px;
      color: #536477;
      font-size: 12px;
      font-weight: 700;
    }
    .copy { display: grid; gap: 6px; text-align: center; }
    h1 { font-size: 1.35rem; line-height: 1.2; margin: 0; letter-spacing: 0; }
    p { margin: 0; color: #64717f; line-height: 1.45; }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 7px; font-size: 13px; font-weight: 700; color: #2c3440; }
    input {
      height: 44px;
      padding: 0 12px;
      border: 1px solid #cdd8e2;
      border-radius: 8px;
      background: #fff;
      color: #17191c;
      font: inherit;
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease;
    }
    input:focus { border-color: #1788ff; box-shadow: 0 0 0 3px rgba(23, 136, 255, .14); }
    button {
      height: 44px;
      border: 0;
      border-radius: 8px;
      background: #0b84ff;
      color: #fff;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      transition: background .16s ease, transform .16s ease, opacity .16s ease;
    }
    button:hover { background: #0574e5; }
    button:active { transform: translateY(1px); }
    button[disabled] { cursor: wait; opacity: .82; }
    .error {
      min-height: 18px;
      color: #b42318;
      font-size: 13px;
      line-height: 1.35;
      text-align: center;
    }
    .help { border-top: 1px solid #e6edf3; padding-top: 14px; text-align: center; font-size: 12px; color: #748292; }
    .help a { color: #216db8; text-decoration: none; font-weight: 700; }
    .help a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <section class="panel">
      <header class="identity">
        ${wordmark.html}
        <div class="identity-pill">Private account login</div>
      </header>
      <div class="copy">
        <h1>${escapeHtml(contextTitle)}</h1>
        <p>${escapeHtml(contextDescription)}</p>
      </div>
      <form method="post" id="login-form">
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
        <label for="username">Username
          <input id="username" name="username" autocomplete="username" required autofocus />
        </label>
        <label for="password">Password
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit" id="continue-button" data-loading-text="Continuing...">Continue</button>
        <div class="error">${escapeHtml(error)}</div>
        <div class="help">Need help? Ask the person who runs this server.</div>
      </form>
    </section>
  </main>
  <script>
    const form = document.getElementById('login-form');
    const button = document.getElementById('continue-button');
    form?.addEventListener('submit', () => {
      if (!button) return;
      button.textContent = button.dataset.loadingText || 'Continuing...';
      button.setAttribute('disabled', 'true');
    });
  </script>
</body>
</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function safeReturnTo(value: string | null, fallback: string): string {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

export async function GET(request: NextRequest) {
  const config = await getIdentityConfig();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('return_to'), `${config.externalUrl}/`);
  return html(returnTo);
}

export async function POST(request: NextRequest) {
  const config = await getIdentityConfig();
  const form = await request.formData();
  const returnTo = safeReturnTo(String(form.get('return_to') || ''), `${config.externalUrl}/`);
  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');
  const user = await verifyUser(username, password);

  if (!user) {
    return html(returnTo, 'Invalid username or password.');
  }

  const token = await createIdentityToken(user);
  const response = NextResponse.redirect(returnTo, { status: 303 });
  setIdentityCookie(response, token, config.cookieDomain);
  return response;
}
