import { NextResponse } from 'next/server';
import { settingsService } from '@/lib/settings';

// Friendly identity error page (Plan 1 — Workstream B.2). Replaces raw JSON
// (`{"error":"invalid_redirect_uri"}`) on USER-FACING identity routes with the
// error.html mockup: warn glyph, human title, explanation, Go home / Try again,
// collapsed technical details. Built on the shared token values (light + dark via
// prefers-color-scheme), no hand-rolled hex outside this one renderer.
//
// NOTE: the OAuth `token` and `userinfo` endpoints are machine-to-machine and
// MUST keep returning JSON per the OAuth2 spec — they are intentionally NOT routed
// through this renderer.

type ErrorCopy = { title: string; message: string };

const ERROR_COPY: Record<string, ErrorCopy> = {
  invalid_redirect_uri: {
    title: 'That sign-in link didn’t work',
    message:
      'The app sent a sign-in address this server doesn’t recognize. This usually fixes itself after an update — try again, or let your admin know if it keeps happening.',
  },
  invalid_client: {
    title: 'We don’t recognize this app',
    message:
      'The app that sent you here isn’t registered with this server. Try opening it again from your dashboard.',
  },
  unsupported_response_type: {
    title: 'This sign-in request isn’t supported',
    message:
      'The app asked to sign you in a way this server doesn’t support. Try again, or let your admin know if it keeps happening.',
  },
  invalid_request: {
    title: 'Something was missing from that request',
    message: 'Part of the sign-in request was incomplete. Try opening the app again from your dashboard.',
  },
  default: {
    title: 'Something needs attention',
    message: 'Something went wrong completing this request. Try again, or head back home.',
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function brandName(): Promise<string> {
  try {
    const raw = await settingsService.getRaw();
    const name = typeof raw?.site_name === 'string' && raw.site_name.trim() ? raw.site_name.trim() : 'YouEye';
    return name;
  } catch {
    return 'YouEye';
  }
}

/**
 * Render the friendly identity error page as an HTML NextResponse.
 * `code` selects human copy; `technical` is shown only inside <details>.
 */
export async function renderIdentityErrorPage(opts: {
  code: string;
  status?: number;
  technical?: string;
  homeUrl?: string;
  retryUrl?: string;
}): Promise<NextResponse> {
  const copy = ERROR_COPY[opts.code] || ERROR_COPY.default;
  const brand = await brandName();
  const home = opts.homeUrl || '/';
  const retryHref = opts.retryUrl || 'javascript:history.back()';
  const technical = opts.technical
    ? `<details><summary>Technical details</summary><code>${escapeHtml(`${opts.code} — ${opts.technical}`)}</code></details>`
    : `<details><summary>Technical details</summary><code>${escapeHtml(opts.code)}</code></details>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Something needs attention — ${escapeHtml(brand)}</title>
<style>
  :root{
    --bg:#fafafa; --surface:#fff; --border:#e4e4e7; --text:#18181b; --muted:#71717a;
    --faint:#a1a1aa; --accent:#2563eb; --accent-hover:#1d4ed8; --warn:#d97706; --warn-soft:#fef3c7;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#0a0a0a; --surface:#171717; --border:#27272a; --text:#fafafa; --muted:#a1a1aa;
      --faint:#52525b; --accent:#3b82f6; --accent-hover:#60a5fa; --warn:#eab308; --warn-soft:rgba(234,179,8,.15);
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
    font-family:"Geist Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    color:var(--text);
    background:radial-gradient(1100px 500px at 80% -10%, color-mix(in srgb, var(--accent) 10%, transparent) 0%, transparent 60%), var(--bg);
  }
  main{display:grid; justify-items:center; gap:22px; width:min(440px,100%)}
  .brand{font-size:24px; font-weight:700; letter-spacing:-.02em}
  .panel{
    width:100%; padding:28px; display:grid; gap:16px; text-align:center;
    background:var(--surface); border:1px solid var(--border); border-radius:12px;
    box-shadow:0 1px 2px rgba(0,0,0,.05);
  }
  .glyph{
    width:52px;height:52px;border-radius:50%;margin:0 auto;
    background:var(--warn-soft); color:var(--warn);
    display:grid; place-items:center; font-size:24px; font-weight:700;
  }
  h1{font-size:19px; font-weight:600; margin:0}
  p{color:var(--muted); font-size:13.5px; line-height:1.5; margin:0}
  .actions{display:flex; gap:10px; justify-content:center; margin-top:4px}
  .btn{
    font:inherit; font-size:13.5px; font-weight:500; padding:9px 16px; border-radius:8px;
    border:1px solid transparent; cursor:pointer; text-decoration:none; display:inline-block;
  }
  .btn-primary{background:var(--accent); color:#fff}
  .btn-primary:hover{background:var(--accent-hover)}
  .btn-secondary{background:var(--surface); color:var(--text); border-color:var(--border)}
  details{text-align:left; border-top:1px solid var(--border); padding-top:12px; margin-top:4px}
  summary{font-size:13px; color:var(--muted); cursor:pointer}
  details code{font-size:12px; color:var(--faint); display:block; margin-top:6px; word-break:break-all; font-family:ui-monospace,monospace}
</style>
</head>
<body>
<main>
  <div class="brand">${escapeHtml(brand)}</div>
  <section class="panel">
    <div class="glyph">!</div>
    <h1>${escapeHtml(copy.title)}</h1>
    <p>${escapeHtml(copy.message)}</p>
    <div class="actions">
      <a class="btn btn-secondary" href="${escapeHtml(home)}">Go home</a>
      <a class="btn btn-primary" href="${escapeHtml(retryHref)}">Try again</a>
    </div>
    ${technical}
  </section>
</main>
</body>
</html>`;

  return new NextResponse(html, {
    status: opts.status ?? 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
