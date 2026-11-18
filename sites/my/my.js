// my.youeye.me: "Add to YouEye" links that open the visitor's own YouEye.
//
// Links:  /add?market=<https market address>   /add?app=<https manifest URL>   /app?id=<official app id>
//
// - The visitor's YouEye is kept only in this browser (localStorage), as an https origin. It is
//   never taken from a link and never sent anywhere; this page makes no requests at all.
// - A link is checked here; anything else shows "This link is not valid" and goes nowhere.
// - Every link shows what it does and the full address, then waits for a click on
//   "Open my YouEye". The only places it can lead are <your YouEye>/market/add?market=…,
//   <your YouEye>/market/add?app=… and <your YouEye>/market/<id>. Your YouEye then shows what would
//   be added and asks again; a link alone never changes anything.
// - Only https: a YouEye serves its Market on its https name after setup (not on youeye.local
//   and not over plain http), so an http address would never work and would not be private.
//
// The functions are exported so that control-panel/tests/my-site.spec.ts can test them in Node;
// the page part runs only in a browser. Loaded as <script type="module">; no build step.

export const MAX_LENGTH = 1500;
// A YouEye keeps the link across sign-in as the path /market/add?<kind>=<encoded address>, at most 2,048
// characters (MAX_SIGN_IN_RETURN_PATH in the Control Panel); a longer one would be refused there.
export const MAX_BOX_PATH = 2048;
export const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const MY_SITE = 'https://my.youeye.me';
export const STORAGE_KEY = 'youeye.my.box';
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\\]/;

/**
 * An https URL from a link: no credentials, at most 1,500 characters and short enough once encoded for a
 * YouEye to keep it across sign-in, no control characters, backslashes or spaces. A market address also has no
 * query or fragment.
 * Returns { ok: true, url } with the URL in its parsed form, or { ok: false, reason }.
 */
export function checkURL(value, kind) {
  const what = kind === 'market' ? 'The market address' : 'The app address';
  if (typeof value !== 'string' || value === '') return { ok: false, reason: `${what} is missing.` };
  if (value.length > MAX_LENGTH) return { ok: false, reason: `${what} is longer than ${MAX_LENGTH} characters.` };
  if (UNSAFE.test(value)) return { ok: false, reason: `${what} contains control characters or a backslash.` };
  if (/\s/.test(value)) return { ok: false, reason: `${what} contains spaces.` };
  let url;
  try { url = new URL(value); } catch { return { ok: false, reason: `${what} is not a URL.` }; }
  if (url.protocol !== 'https:') return { ok: false, reason: `${what} must start with https://.` };
  if (url.username || url.password) return { ok: false, reason: `${what} must not contain a user name or password.` };
  if (!url.hostname) return { ok: false, reason: `${what} has no host.` };
  if (kind === 'market' && (url.search || url.hash)) return { ok: false, reason: `${what} must not contain a query or a fragment.` };
  if (url.href.length > MAX_LENGTH) return { ok: false, reason: `${what} is longer than ${MAX_LENGTH} characters.` };
  if (`/market/add?${kind}=${encodeURIComponent(url.href)}`.length > MAX_BOX_PATH) {
    return { ok: false, reason: `${what} is too long once encoded: a YouEye could not keep it while you sign in.` };
  }
  return { ok: true, url: url.href };
}

/**
 * What a link asks for. `page` is "add" or "app"; `search` is location.search.
 * Returns { ok: true, kind: 'market' | 'app' | 'id', value } or { ok: false, reason }.
 */
export function parseLink(page, search) {
  let params;
  try { params = new URLSearchParams(search); } catch { return { ok: false, reason: 'The link cannot be read.' }; }
  if (page === 'add') {
    const markets = params.getAll('market');
    const apps = params.getAll('app');
    if (markets.length + apps.length === 0) return { ok: false, reason: 'The link names no market and no app.' };
    if (markets.length + apps.length > 1) return { ok: false, reason: 'The link must name exactly one market or one app.' };
    const kind = markets.length ? 'market' : 'app';
    const checked = checkURL(markets.length ? markets[0] : apps[0], kind);
    return checked.ok ? { ok: true, kind, value: checked.url } : checked;
  }
  if (page === 'app') {
    const ids = params.getAll('id');
    if (ids.length !== 1) return { ok: false, reason: 'The link must name exactly one app.' };
    if (!APP_ID.test(ids[0])) return { ok: false, reason: 'The app name in the link is not valid.' };
    return { ok: true, kind: 'id', value: ids[0] };
  }
  return { ok: false, reason: 'This page does not take links.' };
}

/**
 * The address of the visitor's YouEye, as typed: a host name ("my-box.ui.bingo") or an https URL.
 * Returns { ok: true, origin } (only https://<host>[:port]) or { ok: false, reason }.
 */
export function normalizeBox(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'Enter the name of your YouEye.' };
  const value = input.trim();
  if (!value) return { ok: false, reason: 'Enter the name of your YouEye.' };
  if (value.length > 300) return { ok: false, reason: 'That is too long for the name of a YouEye.' };
  if (UNSAFE.test(value) || /\s/.test(value)) return { ok: false, reason: 'The name contains spaces, control characters or a backslash.' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme && !/^https?:\/\//i.test(value) && !/^[^/]*:\d+(\/|$)/.test(value)) {
    return { ok: false, reason: 'Enter a name such as my-box.ui.bingo, or an address starting with https://.' };
  }
  if (/^http:\/\//i.test(value)) {
    return { ok: false, reason: 'Your YouEye opens its Market over https only. Use its https address, such as https://my-box.ui.bingo.' };
  }
  let url;
  try { url = new URL(/^https:\/\//i.test(value) ? value : `https://${value}`); } catch { return { ok: false, reason: 'That is not a valid name.' }; }
  if (url.protocol !== 'https:' || !url.hostname) return { ok: false, reason: 'That is not a valid name.' };
  if (url.username || url.password) return { ok: false, reason: 'The address must not contain a user name or password.' };
  const host = url.hostname.toLowerCase();
  if (host === 'local' || host.endsWith('.local')) {
    return { ok: false, reason: 'youeye.local does not open the Market after setup. Use the name of your YouEye, for example my-box.ui.bingo.' };
  }
  if (!host.includes('.') && !host.startsWith('[')) return { ok: false, reason: 'Enter the full name, for example my-box.ui.bingo.' };
  return { ok: true, origin: url.origin };
}

/**
 * Where "Open my YouEye" goes: only <origin>/market/add?market=…, <origin>/market/add?app=… or
 * <origin>/market/<id>, with the value percent-encoded. Throws on anything else.
 */
export function targetURL(origin, link) {
  const box = normalizeBox(origin);
  if (!box.ok || box.origin !== origin) throw new Error('not a YouEye address');
  if (link.kind === 'market' || link.kind === 'app') {
    const checked = checkURL(link.value, link.kind);
    if (!checked.ok) throw new Error(checked.reason);
    return `${origin}/market/add?${link.kind}=${encodeURIComponent(checked.url)}`;
  }
  if (link.kind === 'id' && APP_ID.test(link.value)) return `${origin}/market/${link.value}`;
  throw new Error('not a link this page understands');
}

/** One sentence about what the link does. */
export function describe(link) {
  if (link.kind === 'market') return 'This opens your YouEye and asks whether to add the market at this address:';
  if (link.kind === 'app') return 'This opens your YouEye and asks whether to add the app at this address:';
  return `This shows the app “${link.value}” in your YouEye’s Market.`;
}

/** An "Add to YouEye" link for market authors: kind is market, app or id. */
export function buildLink(kind, value) {
  if (kind === 'id') {
    const id = typeof value === 'string' ? value.trim() : '';
    return APP_ID.test(id) ? { ok: true, link: `${MY_SITE}/app?id=${id}` } : { ok: false, reason: 'An app id is 1–32 characters of a–z, 0–9 and -, starting with a letter.' };
  }
  const checked = checkURL(typeof value === 'string' ? value.trim() : value, kind);
  if (!checked.ok) return checked;
  let url = checked.url;
  // A market's address is its folder, with the trailing slash.
  if (kind === 'market') {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/market.json')) parsed.pathname = parsed.pathname.slice(0, -'market.json'.length);
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    url = parsed.href;
  }
  return { ok: true, link: `${MY_SITE}/add?${kind}=${encodeURIComponent(url)}` };
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (char) => ENTITIES[char]);

/** HTML for a market author's page: the badge, linked. */
export function badgeSnippet(link) {
  return `<a href="${escapeHTML(link)}"><img src="${MY_SITE}/badge.svg" alt="Add to YouEye" width="180" height="40"></a>`;
}

// ─── The page ─────────────────────────────────────────────

if (typeof document !== 'undefined') page();

function page() {
  const main = document.getElementById('main');
  const kind = document.body.dataset.page;
  let memory = null;

  const storage = {
    get() {
      let stored = memory;
      try { stored = window.localStorage.getItem(STORAGE_KEY) ?? memory; } catch { /* storage blocked */ }
      const box = stored ? normalizeBox(stored) : null;
      return box && box.ok && box.origin === stored ? stored : null;
    },
    set(origin) {
      memory = origin;
      try { window.localStorage.setItem(STORAGE_KEY, origin); return true; } catch { return false; }
    },
    forget() {
      memory = null;
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ }
    },
  };

  /** el('p', { class: 'x' }, 'text', child…): text is always text, never markup. */
  function el(tag, attributes, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (name === 'text') node.textContent = value;
      else node.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function show(...nodes) {
    main.replaceChildren(...nodes.filter(Boolean));
    const heading = main.querySelector('h1');
    if (heading) document.title = `${heading.textContent} · YouEye`;
  }

  function invalid(reason) {
    show(
      el('h1', { text: 'This link is not valid' }),
      el('p', { text: reason }),
      el('p', { text: 'Nothing was opened and nothing was changed. If you got this link from a website, tell its author.' }),
      el('p', {}, el('a', { href: '../', text: 'What is this site?' })),
    );
  }

  /** The form asking for the visitor's YouEye. `done` runs with the stored origin. */
  function boxForm(done, cancel) {
    const current = storage.get();
    const input = el('input', {
      id: 'box', name: 'box', type: 'text', inputmode: 'url', autocomplete: 'url', spellcheck: 'false', autocapitalize: 'none',
      placeholder: 'my-box.ui.bingo', required: true, 'aria-describedby': 'box-hint box-error', value: current ? current : null,
    });
    const error = el('p', { id: 'box-error', class: 'error', role: 'alert', hidden: true });
    const form = el('form', { class: 'box-form', novalidate: true },
      el('label', { for: 'box', text: 'The address of your YouEye' }),
      el('p', { id: 'box-hint', class: 'hint' }, 'The name of your YouEye, for example ', el('code', { text: 'my-box.ui.bingo' }), '.'),
      el('div', { class: 'row' }, input, el('button', { type: 'submit', class: 'button', text: 'Save' }),
        cancel ? el('button', { type: 'button', class: 'button secondary', text: 'Cancel', 'data-cancel': true }) : null),
      error,
      el('p', { class: 'hint', text: 'It is kept only in this browser and never sent anywhere.' }),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const box = normalizeBox(input.value);
      if (!box.ok) { error.textContent = box.reason; error.hidden = false; input.focus(); return; }
      const kept = storage.set(box.origin);
      done(box.origin, kept);
    });
    if (cancel) form.querySelector('[data-cancel]').addEventListener('click', cancel);
    return { form, input };
  }

  function boxLine(origin, onChange) {
    const change = el('button', { type: 'button', class: 'link', text: 'Change' });
    change.addEventListener('click', onChange);
    return el('p', { class: 'box-line' }, 'Your YouEye: ', el('code', { text: origin }), ' ', change);
  }

  function interstitial(link, note) {
    const origin = storage.get();
    if (!origin) { askBox(link); return; }
    const titles = { market: 'Add a market to your YouEye', app: 'Add an app to your YouEye', id: 'Open an app in your YouEye' };
    const target = targetURL(origin, link);
    const open = el('a', { class: 'button primary', href: target, rel: 'noreferrer', text: 'Open my YouEye' });
    show(
      el('h1', { text: titles[link.kind] }),
      el('p', { text: describe(link) }),
      link.kind === 'id' ? null : el('pre', { class: 'value' }, el('code', { text: link.value })),
      boxLine(origin, () => askBox(link, true)),
      el('p', { text: link.kind === 'id'
        ? 'Nothing is installed until you confirm on your own YouEye.'
        : 'Nothing is added until you confirm on your own YouEye.' }),
      link.kind === 'id' ? null : el('p', { class: 'note', text: 'Markets and apps from other publishers are not checked by YouEye. Add them only if you trust who published them.' }),
      note ? el('p', { class: 'hint', text: note }) : null,
      el('p', { class: 'actions' }, open),
    );
  }

  function askBox(link, changing) {
    const { form, input } = boxForm(
      (_origin, kept) => interstitial(link, kept ? null : 'This browser does not let the page remember your YouEye; you will be asked again next time.'),
      changing ? () => interstitial(link) : null,
    );
    show(
      el('h1', { text: changing ? 'Change your YouEye' : 'Which YouEye is yours?' }),
      el('p', { text: 'This link opens your own YouEye. Tell this page where it is, once.' }),
      form,
    );
    input.focus();
  }

  function home() {
    const boxSection = el('section', { 'aria-labelledby': 'box-title' });
    const renderBox = () => {
      const origin = storage.get();
      if (origin) {
        const change = el('button', { type: 'button', class: 'button secondary', text: 'Change' });
        const forget = el('button', { type: 'button', class: 'button secondary', text: 'Forget' });
        change.addEventListener('click', () => {
          const { form, input } = boxForm(renderBox, renderBox);
          boxSection.replaceChildren(el('h2', { id: 'box-title', text: 'Your YouEye' }), form);
          input.focus();
        });
        forget.addEventListener('click', () => { storage.forget(); renderBox(); });
        boxSection.replaceChildren(
          el('h2', { id: 'box-title', text: 'Your YouEye' }),
          el('p', {}, 'Links open ', el('code', { text: origin }), '.'),
          el('p', { class: 'actions' }, change, ' ', forget),
        );
      } else {
        const { form } = boxForm(renderBox);
        boxSection.replaceChildren(
          el('h2', { id: 'box-title', text: 'Your YouEye' }),
          el('p', { text: 'No YouEye is saved in this browser. You are asked the first time you follow a link, or you can save it now.' }),
          form,
        );
      }
    };
    renderBox();

    const builderError = el('p', { class: 'error', role: 'alert', hidden: true });
    const result = el('div', { class: 'result', hidden: true });
    const value = el('input', { id: 'builder-value', type: 'text', inputmode: 'url', spellcheck: 'false', autocapitalize: 'none', placeholder: 'https://example.org/market/' });
    const radio = (id, kindValue, label, checked) => el('label', { class: 'choice' },
      el('input', { type: 'radio', name: 'kind', value: kindValue, id, checked }), ' ', label);
    const builder = el('form', { class: 'builder', novalidate: true },
      el('fieldset', {},
        el('legend', { text: 'What the link adds' }),
        radio('kind-market', 'market', 'A market (its address)', true),
        radio('kind-app', 'app', 'One app (the https URL of its youeye-app.yaml)', false),
        radio('kind-id', 'id', 'An app of the YouEye Market (its id)', false)),
      el('label', { for: 'builder-value', text: 'Address or id' }),
      el('div', { class: 'row' }, value, el('button', { type: 'submit', class: 'button', text: 'Make the link' })),
      builderError,
    );
    const placeholders = { market: 'https://example.org/market/', app: 'https://example.org/apps/my-app/youeye-app.yaml', id: 'immich' };
    builder.addEventListener('change', () => { value.placeholder = placeholders[builder.elements.kind.value]; });
    const copyButton = (getText, label) => {
      const button = el('button', { type: 'button', class: 'button secondary', text: label });
      button.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(getText()); button.textContent = 'Copied'; } catch { button.textContent = 'Select and copy it'; }
        setTimeout(() => { button.textContent = label; }, 2000);
      });
      return button;
    };
    builder.addEventListener('submit', (event) => {
      event.preventDefault();
      const made = buildLink(builder.elements.kind.value, value.value);
      if (!made.ok) { builderError.textContent = made.reason; builderError.hidden = false; result.hidden = true; return; }
      builderError.hidden = true;
      const snippet = badgeSnippet(made.link);
      result.replaceChildren(
        el('h3', { text: 'The link' }),
        el('pre', { class: 'value' }, el('code', { text: made.link })),
        copyButton(() => made.link, 'Copy the link'),
        el('h3', { text: 'A badge for your page' }),
        el('p', {}, el('img', { src: 'badge.svg', alt: 'Add to YouEye', width: '180', height: '40' })),
        el('pre', { class: 'value' }, el('code', { text: snippet })),
        copyButton(() => snippet, 'Copy the HTML'),
      );
      result.hidden = false;
    });

    show(
      el('h1', { text: 'Add to YouEye' }),
      el('p', { class: 'lead', text: 'This site takes “Add to YouEye” links and opens them on your own YouEye. Your YouEye shows what the link would add and asks you first: a link alone never changes anything.' }),
      el('p', {}, 'YouEye is a personal cloud: a small server at home that runs your own apps. ', el('a', { href: 'https://youeye.me', text: 'Learn about YouEye' })),
      boxSection,
      el('section', { 'aria-labelledby': 'builder-title' },
        el('h2', { id: 'builder-title', text: 'For market authors: make a link' }),
        el('p', {}, 'Put a link or badge on your page so people can add your market or app to their YouEye. A market is a folder of static files; ',
          el('a', { href: 'https://market.youeye.me/make-your-own-market/', text: 'make your own market' }), '.'),
        builder,
        result),
    );
  }

  if (kind === 'home') { home(); return; }
  const link = parseLink(kind, window.location.search);
  if (!link.ok) { invalid(link.reason); return; }
  interstitial(link);
}
