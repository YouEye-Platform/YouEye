/**
 * Embed Layout — bare HTML with theming support.
 * Used when CP pages are iframed into YE-UI settings.
 *
 * Reads theme/accent from URL params: ?theme=dark&accent=%233b82f6
 * Reports content height via postMessage for auto-sizing.
 * Sends youeye-embed-ready on load.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "YouEye Embed",
};

const themeCSS = `
  :root, :root[data-theme="dark"] {
    --embed-bg: transparent;
    --embed-text: #e4e4e7;
    --embed-text-muted: #a1a1aa;
    --embed-border: #27272a;
    --embed-card-bg: #18181b;
    --embed-hover: #27272a;
    --embed-primary: var(--embed-accent, #3b82f6);
    --embed-danger: #ef4444;
    --embed-success: #22c55e;
    --embed-warning: #eab308;
    --embed-skeleton: #27272a;
    color-scheme: dark;
  }
  :root[data-theme="light"] {
    --embed-bg: transparent;
    --embed-text: #18181b;
    --embed-text-muted: #71717a;
    --embed-border: #e4e4e7;
    --embed-card-bg: #ffffff;
    --embed-hover: #f4f4f5;
    --embed-primary: var(--embed-accent, #3b82f6);
    --embed-danger: #ef4444;
    --embed-success: #22c55e;
    --embed-warning: #eab308;
    --embed-skeleton: #e4e4e7;
    color-scheme: light;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    color: var(--embed-text);
    background: var(--embed-bg);
    line-height: 1.5;
    min-height: 0 !important;
  }
  .embed-card {
    background: var(--embed-card-bg);
    border: 1px solid var(--embed-border);
    border-radius: 8px;
    padding: 16px;
  }
  .embed-card + .embed-card { margin-top: 12px; }
  .embed-card-title {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .embed-muted { color: var(--embed-text-muted); }
  .embed-label { color: var(--embed-text-muted); font-size: 12px; }
  .embed-value { font-weight: 500; }
  .embed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; }
  .embed-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid var(--embed-border);
  }
  .embed-badge-green { color: var(--embed-success); border-color: color-mix(in srgb, var(--embed-success) 30%, transparent); }
  .embed-badge-amber { color: var(--embed-warning); border-color: color-mix(in srgb, var(--embed-warning) 30%, transparent); }
  .embed-table { width: 100%; border-collapse: collapse; }
  .embed-table th {
    text-align: left;
    font-weight: 500;
    font-size: 12px;
    color: var(--embed-text-muted);
    padding: 8px 12px;
    border-bottom: 1px solid var(--embed-border);
  }
  .embed-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--embed-border);
    font-size: 13px;
  }
  .embed-table tr:last-child td { border-bottom: none; }
  .embed-mono { font-family: "SF Mono", "Fira Code", monospace; font-size: 12px; }
  .embed-progress-track {
    height: 8px;
    border-radius: 4px;
    background: var(--embed-border);
    overflow: hidden;
  }
  .embed-progress-bar {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s ease;
  }
  .embed-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--embed-border);
    background: var(--embed-card-bg);
    color: var(--embed-text);
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .embed-btn:hover { background: var(--embed-hover); }
  .embed-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .embed-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .embed-title { font-size: 16px; font-weight: 600; }
  .embed-subtitle { font-size: 13px; color: var(--embed-text-muted); margin-top: 2px; }
  .embed-skeleton {
    background: var(--embed-skeleton);
    border-radius: 4px;
    animation: embed-pulse 1.5s ease-in-out infinite;
  }
  @keyframes embed-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  @keyframes embed-spin {
    to { transform: rotate(360deg); }
  }
  .embed-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .embed-error {
    padding: 24px;
    text-align: center;
    color: var(--embed-text-muted);
  }
  .embed-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--embed-border);
  }
  .embed-row:last-child { border-bottom: none; }
`;

const embedScript = `
(function() {
  // Read theme from URL params
  var params = new URLSearchParams(window.location.search);
  var theme = params.get('theme') || 'light';
  var accent = params.get('accent');
  document.documentElement.setAttribute('data-theme', theme);
  if (accent) document.documentElement.style.setProperty('--embed-accent', accent);

  // Report height to parent for auto-sizing
  var lastHeight = 0;
  function reportHeight() {
    var h = document.body.scrollHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      window.parent.postMessage({ type: 'youeye-embed-resize', height: h }, '*');
    }
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reportHeight).observe(document.body);
  }
  setInterval(reportHeight, 500);

  // Signal ready
  window.parent.postMessage({ type: 'youeye-embed-ready' }, '*');

  // Read locale from URL params and set cookie for server-side i18n
  var locale = params.get('locale');
  if (locale) {
    document.cookie = 'ye-embed-locale=' + locale + ';path=/;max-age=86400;samesite=lax';
    document.documentElement.setAttribute('lang', locale);
  }

  // Listen for theme and locale changes from parent
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'youeye-embed-theme') {
      document.documentElement.setAttribute('data-theme', e.data.theme || 'light');
      if (e.data.accent) document.documentElement.style.setProperty('--embed-accent', e.data.accent);
    }
    if (e.data && e.data.type === 'youeye-embed-locale' && e.data.locale) {
      document.cookie = 'ye-embed-locale=' + e.data.locale + ';path=/;max-age=86400;samesite=lax';
      document.documentElement.setAttribute('lang', e.data.locale);
    }
  });
})();
`;

export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="light">
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeCSS }} />
      </head>
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: embedScript }} />
      </body>
    </html>
  );
}
