// YouEye installer web UI: plain JavaScript, no build step, no external assets.
// It shows the text installer's screens and sends the same choices to
// `youeye-installer serve`, which writes the same answer.
'use strict';

(() => {
  const CHANNELS = [
    { id: 'stable', title: 'Stable', detail: 'Recommended' },
    { id: 'beta', title: 'Beta', detail: 'Next release, tested' },
    { id: 'alpha', title: 'Alpha', detail: 'Early builds' },
    { id: 'dev', title: 'Dev', detail: 'Every build; may break' },
  ];
  const CUSTOM_REPOSITORY_REQUIRED = 'Enter the repository URL, or choose the official source.';
  const ZERO = '00000000000000000000000000000000';

  const ui = {
    server: null,
    screen: 'loading',
    error: '',
    choices: {
      disk: '', preserve: false, adapter_mac: '', network: 'dhcp', address: '', gateway: '', dns: '',
      channel: 'stable', repository: '', ssh_key: '',
    },
    operation: 'erase',
    customSource: false,
    sshPaste: false,
    rootPassword: false,
    passwordSSH: false,
    consoleSummary: '',
    progress: { stage: 'Starting installation...', detail: '', percent: 0 },
    busy: false,
    events: null,
    dialog: null,
    rendered: '',
  };

  const app = document.getElementById('app');
  const hints = document.getElementById('hints');

  // ---- Never leave 127.0.0.1 -------------------------------------------------
  document.addEventListener('click', (event) => {
    if (event.target.closest && event.target.closest('a')) event.preventDefault();
  }, true);
  for (const type of ['dragstart', 'dragover', 'drop']) {
    window.addEventListener(type, (event) => event.preventDefault(), true);
  }
  window.addEventListener('submit', (event) => event.preventDefault(), true);
  window.open = () => null;

  // ---- Pointer only while a mouse is used ------------------------------------
  const root = document.documentElement;
  window.addEventListener('mousemove', (event) => {
    if (event.movementX || event.movementY) root.classList.remove('no-pointer');
  });
  window.addEventListener('keydown', () => root.classList.add('no-pointer'), true);

  // ---- DOM helpers ------------------------------------------------------------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function option(name, value, checked, title, details, onSelect, disabled) {
    const input = el('input', { type: 'radio', name, value, checked, disabled });
    input.addEventListener('change', () => { if (input.checked) { ui.error = ''; onSelect(value); } });
    return el('label', { class: 'option' + (disabled ? ' disabled' : '') }, input,
      el('span', { class: 'option-body' }, el('span', { class: 'option-title', text: title }),
        (details || []).filter(Boolean).map((detail) => typeof detail === 'string'
          ? el('span', { class: 'option-detail', text: detail })
          : el('span', { class: detail.warn ? 'option-warn' : 'option-detail', text: detail.text }))));
  }

  function checkbox(checked, title, detail, onChange) {
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => { ui.error = ''; onChange(input.checked); });
    return el('label', { class: 'option' }, input,
      el('span', { class: 'option-body' }, el('span', { class: 'option-title', text: title }),
        el('span', { class: 'option-detail', text: detail })));
  }

  function textField(id, label, value, placeholder, onInput, type) {
    const input = el('input', {
      id, type: type || 'text', value, placeholder, autocomplete: 'off', spellcheck: 'false',
    });
    input.addEventListener('input', () => { ui.error = ''; showError(); onInput(input.value); });
    return [el('label', { for: id, text: label }), input];
  }

  function hint(text) {
    hints.replaceChildren();
    const keys = new Set(['↑/↓', '←/→', 'Enter', 'Esc', 'Tab', 'Space']);
    text.split(' · ').forEach((part, index) => {
      if (index) hints.append(' · ');
      const [key, ...rest] = part.split(' ');
      if (keys.has(key)) hints.append(el('kbd', { text: key }), ' ' + rest.join(' '));
      else hints.append(part);
    });
  }

  function showError() {
    const node = document.getElementById('error');
    if (node) node.textContent = ui.error;
  }

  function card(step, title, body, actions) {
    return el('section', { class: 'card' },
      step ? el('p', { class: 'step', text: step }) : null,
      el('h1', { text: title }),
      body,
      el('p', { id: 'error', class: 'error', role: 'alert', text: ui.error }),
      actions ? el('div', { class: 'actions' }, actions) : null);
  }

  function navButtons(backLabel, nextLabel, nextClass) {
    return [
      backLabel ? el('button', { type: 'button', id: 'back', onclick: back, text: backLabel }) : el('span'),
      el('div', { class: 'right' },
        el('button', { type: 'button', id: 'next', class: nextClass || 'primary', onclick: next, text: nextLabel || 'Continue' })),
    ];
  }

  // ---- Server ------------------------------------------------------------------
  async function api(path, body) {
    const init = body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    const response = await fetch(path, init);
    let data = {};
    try { data = await response.json(); } catch (_) { /* empty */ }
    if (!response.ok) throw new Error(data.error || `The installer answered ${response.status}.`);
    return data;
  }

  async function refresh() {
    try {
      ui.server = await api('/api/state');
    } catch (error) {
      setTimeout(refresh, 1000);
      return;
    }
    const state = ui.server;
    ui.consoleSummary = state.console;
    if (state.phase === 'loading') {
      setTimeout(refresh, 500);
      return;
    }
    if (state.phase === 'error') return go('preflight');
    if (state.phase === 'installing') {
      if (state.progress) ui.progress = state.progress;
      return go('progress');
    }
    if (state.phase === 'complete') return go('done');
    if (state.phase === 'failed') {
      if (state.progress) ui.progress = state.progress;
      return go('failed');
    }
    if (!ui.choices.disk) ui.choices.disk = state.default_disk || (state.disks[0] && state.disks[0].path) || '';
    if (!ui.choices.adapter_mac && state.adapters.length) ui.choices.adapter_mac = state.adapters[0].mac;
    if (!state.default_disk) ui.error = 'No supported installation drive is available.';
    go('disk');
  }

  function selectedDisk() {
    return (ui.server.disks || []).find((disk) => disk.path === ui.choices.disk);
  }

  function preserving() {
    const disk = selectedDisk();
    return Boolean(disk && disk.installed && ui.operation === 'preserve');
  }

  function choices() {
    const c = { ...ui.choices };
    c.preserve = preserving();
    c.repository = ui.customSource ? c.repository : '';
    c.ssh_key = ui.sshPaste ? c.ssh_key : '';
    if (c.network !== 'static') { c.address = ''; c.gateway = ''; c.dns = ''; }
    return c;
  }

  // ---- Screens -----------------------------------------------------------------
  const ORDER = ['disk', 'operation', 'network', 'software', 'ssh', 'console', 'review', 'erase'];

  function screenAfter(screen) {
    let index = ORDER.indexOf(screen) + 1;
    for (; index < ORDER.length; index++) {
      const candidate = ORDER[index];
      if (candidate === 'operation' && !(selectedDisk() || {}).installed) continue;
      if (candidate === 'console' && preserving()) continue;
      return candidate;
    }
    return null;
  }

  function screenBefore(screen) {
    let index = ORDER.indexOf(screen) - 1;
    for (; index >= 0; index--) {
      const candidate = ORDER[index];
      if (candidate === 'operation' && !(selectedDisk() || {}).installed) continue;
      if (candidate === 'console' && preserving()) continue;
      return candidate;
    }
    return null;
  }

  function go(screen) {
    ui.screen = screen;
    ui.rendered = '';
    render();
  }

  // render redraws the screen; on the same screen the focused control keeps focus.
  function render() {
    const active = document.activeElement;
    const focusKey = active && active !== document.body
      ? (active.name && active.type === 'radio' ? `${active.name}=${active.value}` : active.id) : '';
    const sameScreen = ui.rendered === ui.screen;
    const view = SCREENS[ui.screen]();
    app.replaceChildren(view.node);
    hint(view.hint);
    if (ui.dialog) app.append(ui.dialog.node);
    ui.rendered = ui.screen;
    if (sameScreen && !ui.dialog && focusKey) {
      const [name, value] = focusKey.split('=');
      const again = value !== undefined
        ? [...app.querySelectorAll(`input[name="${name}"]`)].find((input) => input.value === value)
        : document.getElementById(focusKey);
      if (again) {
        again.focus();
        return;
      }
    }
    focusFirst(view.focus);
  }

  function focusFirst(preferred) {
    const scope = ui.dialog ? ui.dialog.node : app;
    const target = (!ui.dialog && preferred && scope.querySelector(preferred))
      || scope.querySelector('[data-focus]')
      || scope.querySelector('input[type="radio"]:checked:not(:disabled)')
      || scope.querySelector('input:not(:disabled)')
      || scope.querySelector('button.primary')
      || scope.querySelector('button');
    if (target) target.focus();
  }

  const SCREENS = {
    loading: () => ({
      node: card('', 'YouEye Installer', el('p', { class: 'muted', text: 'Verifying the release and discovering drives…' })),
      hint: 'Please wait · No drive has been changed',
    }),

    preflight: () => ({
      node: card('', 'Installer preflight failed', [
        el('p', { class: 'notice', text: ui.server.error }),
        el('p', { class: 'muted', text: 'No drive has been changed.' }),
      ], [el('span'), el('div', { class: 'right' }, el('button', { type: 'button', class: 'primary', 'data-focus': true, onclick: powerOff, text: 'Turn off' }))]),
      hint: 'Enter turn off',
    }),

    disk: () => {
      const disks = ui.server.disks || [];
      const list = el('div', { class: 'options', role: 'radiogroup', 'aria-label': 'Installation drive' },
        disks.map((disk) => option('disk', disk.path, disk.path === ui.choices.disk,
          `${disk.model || 'Unknown model'}   ${disk.path}`,
          [
            `${disk.size} · serial ${disk.serial || 'unknown'}`,
            disk.contents.length ? { warn: true, text: `Existing contents: ${disk.contents.join(', ')}` } : 'Blank disk',
            disk.installed ? `Installed YouEye: ${disk.installed}` : '',
            disk.warning ? { warn: true, text: disk.warning } : '',
            disk.unavailable ? { warn: true, text: `Unavailable: ${disk.unavailable}` } : '',
          ],
          (value) => { ui.choices.disk = value; ui.operation = defaultOperation(); },
          Boolean(disk.unavailable))));
      return {
        node: card('Step 1', 'Choose installation drive', [
          el('p', { class: 'muted', text: `Minimum ${ui.server.minimum_size} · Recommended ${ui.server.recommended_size}` }),
          disks.length ? list : el('p', { class: 'notice', text: 'No drives were found.' }),
        ], navButtons('Turn off', 'Continue')),
        hint: '↑/↓ select · Enter continue · Esc turn off',
      };
    },

    operation: () => {
      const disk = selectedDisk();
      const preserveDetail = disk.preserve_unavailable
        || 'Replace System A/B and Recovery; retain settings, identity, SSH keys, apps, and data';
      return {
        node: card('Step 2', 'Choose installation type', el('div', { class: 'options', role: 'radiogroup' },
          option('operation', 'preserve', ui.operation === 'preserve', 'Preserve settings and data', [preserveDetail], (value) => { ui.operation = value; }),
          option('operation', 'erase', ui.operation === 'erase', 'Erase and install from scratch',
            ['Permanently remove the existing system, settings, applications, and data'], (value) => { ui.operation = value; })),
        navButtons('Back', 'Continue')),
        hint: '↑/↓ select · Enter continue · Esc back',
      };
    },

    network: () => {
      const adapters = ui.server.adapters || [];
      let adapterBlock;
      if (adapters.length > 1) {
        adapterBlock = [el('h2', { text: 'Wired adapter' }), el('div', { class: 'options', role: 'radiogroup' },
          adapters.map((adapter) => option('adapter', adapter.mac, adapter.mac === ui.choices.adapter_mac,
            adapter.name, [adapter.mac], (value) => { ui.choices.adapter_mac = value; })))];
      } else {
        const only = adapters[0];
        adapterBlock = el('p', { class: 'muted', text: only ? `Wired adapter: ${only.name} · ${only.mac}` : 'Automatic wired adapter' });
      }
      const staticFields = ui.choices.network === 'static' ? el('div', { class: 'fields' },
        textField('address', 'Address/CIDR', ui.choices.address, '192.0.2.10/24', (value) => { ui.choices.address = value; }),
        textField('gateway', 'Gateway', ui.choices.gateway, '192.0.2.1', (value) => { ui.choices.gateway = value; }),
        textField('dns', 'DNS', ui.choices.dns, '192.0.2.53', (value) => { ui.choices.dns = value; })) : null;
      return {
        node: card('Next step', 'Network', [
          adapterBlock,
          el('h2', { text: 'Address' }),
          el('div', { class: 'options', role: 'radiogroup' },
            option('network', 'dhcp', ui.choices.network === 'dhcp', 'Wired DHCP', ['Recommended; configure automatically'], (value) => { ui.choices.network = value; render(); }),
            option('network', 'static', ui.choices.network === 'static', 'Static IPv4', ['Set address, gateway, and DNS'], (value) => { ui.choices.network = value; render(); })),
          staticFields,
        ], navButtons('Back', 'Continue')),
        hint: '↑/↓ select · Tab next field · Enter continue · Esc back',
      };
    },

    software: () => ({
      node: card('Next step', 'Software', [
        el('h2', { text: 'Channel' }),
        el('div', { class: 'options', role: 'radiogroup' },
          CHANNELS.map((channel) => option('channel', channel.id, ui.choices.channel === channel.id, channel.title, [channel.detail], (value) => { ui.choices.channel = value; }))),
        el('h2', { text: 'Release source' }),
        el('div', { class: 'options', role: 'radiogroup' },
          option('source', 'official', !ui.customSource, 'Official releases', ['The public YouEye repository'], () => { ui.customSource = false; render(); }),
          option('source', 'custom', ui.customSource, 'Repository URL', ['Follow releases from another repository'], () => { ui.customSource = true; render(); })),
        ui.customSource ? el('div', { class: 'fields' },
          textField('repository', 'Repository URL', ui.choices.repository, 'https://forge.example/owner/YouEye', (value) => { ui.choices.repository = value; })) : null,
        el('p', { class: 'muted small', text: 'The installed System comes from this media; first boot may update A/B before installing the Server interface.' }),
      ], navButtons('Back', 'Continue')),
      hint: '↑/↓ select · Tab next group · Enter continue · Esc back',
    }),

    ssh: () => ({
      node: card('Next step', 'SSH access', [
        el('div', { class: 'options', role: 'radiogroup' },
          option('ssh', 'none', !ui.sshPaste, 'No SSH key', ['Public-key SSH remains disabled unless added later'], () => { ui.sshPaste = false; render(); }),
          option('ssh', 'paste', ui.sshPaste, 'Paste public key', ['Authorize one public key for root SSH access'], () => { ui.sshPaste = true; render(); })),
        ui.sshPaste ? el('div', { class: 'fields' },
          textField('ssh-key', 'Public key', ui.choices.ssh_key, 'ssh-ed25519 AAAA...', (value) => { ui.choices.ssh_key = value; })) : null,
      ], navButtons('Back', 'Continue')),
      hint: '↑/↓ select · Tab key field · Enter continue · Esc back',
    }),

    console: () => {
      const rows = [
        el('p', { text: 'The owner and admins sign in on the console (Ctrl+Alt+F2) with their YouEye ID password. Root is locked unless you set a password here.' }),
        el('div', { class: 'options' },
          checkbox(ui.rootPassword, 'Root password', 'Advanced: for emergencies only; most people leave this off', (value) => {
            ui.rootPassword = value;
            if (!value) ui.passwordSSH = false;
            render();
          }),
          ui.rootPassword ? checkbox(ui.passwordSSH, 'Password SSH', 'Allow SSH with a password from the local network', (value) => { ui.passwordSSH = value; }) : null),
      ];
      if (ui.rootPassword) {
        rows.push(el('div', { class: 'fields' },
          textField('password', 'New password', '', '', () => {}, 'password'),
          textField('confirm', 'Confirm password', '', '', () => {}, 'password')));
        rows.push(el('p', { class: 'muted small', text: 'Only a yescrypt hash of the root password is stored. Leave both fields empty to keep a password set before.' }));
      }
      return {
        node: card('Next step', 'Console access', rows, navButtons('Back', 'Continue')),
        hint: 'Tab move · Space toggle · Enter continue · Esc back',
        // Like the text wizard, Continue is selected first: most people keep root locked.
        focus: '#next',
      };
    },

    review: () => {
      const disk = selectedDisk();
      const c = choices();
      const channel = CHANNELS.find((entry) => entry.id === c.channel);
      const adapter = (ui.server.adapters || []).find((entry) => entry.mac === c.adapter_mac);
      const rows = [
        ['Image', ui.server.image_version],
        ['Source tree', ui.server.source_tree],
        ['Drive', `${disk.path}  ${disk.size}  serial ${disk.serial}`],
        ['Layout', '1 GiB ESP · 4 GiB Recovery · 6 GiB A · 6 GiB B · 4 GiB State; YE-DATA uses the rest'],
        ['Network', c.network === 'static' ? `Static IPv4 ${c.address}` : 'Wired DHCP'],
        adapter ? ['Adapter', `${adapter.name} · ${adapter.mac}`] : null,
        ['Software', `${ui.customSource ? 'Repository URL' : 'Official releases'} · ${channel ? channel.title : c.channel}`],
        ui.customSource ? ['Repository', c.repository] : null,
        ['SSH', c.ssh_key ? `Public key ${c.ssh_key.trim().slice(0, 32)}…` : 'No SSH key'],
        ['Console', c.preserve ? 'kept as is (admins, root password, password SSH)' : ui.consoleSummary],
        ['Operation', c.preserve ? 'Preserve settings, identity, SSH keys, applications, and data' : 'Full erase and fresh install'],
        disk.installed ? ['Existing', `YouEye ${disk.installed}`] : (disk.warning ? ['Existing', 'unreadable YouEye metadata'] : null),
      ].filter(Boolean);
      let warning = 'The selected drive will be repartitioned and erased.';
      if (c.preserve) warning = 'System A/B, Recovery, and boot assets will be replaced. State and YE-DATA will remain.';
      else if (disk.contents.length) warning = 'Existing contents were detected. The next step confirms a complete erase.';
      return {
        node: card('Final review', 'Review installation', [
          el('dl', { class: 'review' }, rows.map(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })])),
          el('p', { class: 'notice', text: warning }),
        ], navButtons('Back', 'Continue')),
        hint: 'Enter confirm this plan · Esc back',
      };
    },

    erase: () => {
      const disk = selectedDisk();
      const preserve = preserving();
      const body = preserve ? [
        el('p', { class: 'notice', text: 'This replaces the operating system on the selected installation drive:' }),
        el('p', { class: 'big', text: `${disk.path}  ${disk.model}  serial ${disk.serial}` }),
        el('p', { text: 'Machine identity, network settings, SSH keys, applications, and YE-DATA are preserved.' }),
      ] : [
        el('p', { class: 'notice', text: 'This permanently erases the selected installation drive:' }),
        el('p', { class: 'big', text: `${disk.path}  ${disk.model}  serial ${disk.serial}` }),
        el('p', { class: 'option-warn', text: 'All existing systems, settings, applications, and data on this drive will be lost.' }),
      ];
      return {
        node: card('', preserve ? 'Confirm preserve reinstall' : 'Confirm disk erasure', body, [
          el('button', { type: 'button', id: 'back', 'data-focus': true, onclick: back, text: 'No, go back' }),
          el('div', { class: 'right' }, el('button', {
            type: 'button', id: 'next', class: 'danger', onclick: next,
            text: preserve ? 'Yes, reinstall and preserve data' : 'Yes, erase and install',
          })),
        ]),
        hint: '←/→ choose · Enter confirm · Esc back',
      };
    },

    progress: () => {
      const percent = Math.round((ui.progress.percent || 0) * 100);
      const fill = el('div', { class: 'bar-fill' });
      fill.style.width = `${percent}%`;
      return {
        node: card('', 'Installing YouEye', [
          el('p', { class: 'big', text: ui.progress.stage || 'Working…' }),
          el('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent }, fill),
          el('p', { class: 'percent', text: `${percent}%` }),
          el('p', { class: 'muted', text: ui.progress.detail || 'No disk writes continue until all artifact, target, and confirmation checks pass.' }),
          el('p', { class: 'notice calm', text: 'Keep the machine on until the installation finishes.' }),
        ]),
        hint: 'Please wait',
      };
    },

    done: () => ({
      node: card('', 'YouEye installed', [
        el('p', { text: 'System A is active. System B and Recovery are installed.' }),
        el('p', { text: 'Written images and UEFI boot assets passed readback checks.' }),
        el('p', { class: 'notice calm big', text: 'Remove the USB stick after the machine turns off.' }),
        el('p', { class: 'muted small', text: 'First boot installs the exact platform release set. Web setup appears only after durable health checks pass. The owner and admins sign in on the console (Ctrl+Alt+F2) with their YouEye ID password. Root is for emergencies and stays locked unless you set a root password.' }),
      ], [el('span'), el('div', { class: 'right' }, el('button', { type: 'button', class: 'primary', 'data-focus': true, onclick: powerOff, text: 'Turn off' }))]),
      hint: 'Enter turn off',
    }),

    failed: () => ({
      node: card('', 'Installation failed', [
        el('p', { class: 'notice', text: ui.progress.error || 'The installer stopped.' }),
        el('p', { class: 'muted', text: 'No further disk changes will be attempted.' }),
      ], [el('span'), el('div', { class: 'right' }, el('button', { type: 'button', class: 'primary', 'data-focus': true, onclick: powerOff, text: 'Turn off' }))]),
      hint: 'Enter turn off',
    }),

    off: () => ({
      node: card('', 'Turning off', el('p', { class: 'big', text: 'Remove the USB stick after the machine turns off.' })),
      hint: 'Goodbye',
    }),
  };

  // ---- Moving between screens --------------------------------------------------
  function defaultOperation() {
    const disk = selectedDisk();
    return disk && disk.installed && !disk.preserve_unavailable ? 'preserve' : 'erase';
  }

  async function check() {
    await api('/api/check', choices());
  }

  async function next() {
    if (ui.busy || ui.dialog) return;
    ui.busy = true;
    ui.error = '';
    try {
      switch (ui.screen) {
        case 'disk':
          if (!ui.choices.disk) throw new Error('No disk is selected.');
          await check();
          ui.operation = defaultOperation();
          break;
        case 'operation':
        case 'network':
          await check();
          break;
        case 'software':
          if (ui.customSource && !ui.choices.repository.trim()) throw new Error(CUSTOM_REPOSITORY_REQUIRED);
          await check();
          break;
        case 'ssh':
          if (ui.sshPaste && !ui.choices.ssh_key.trim()) throw new Error('Paste a public SSH key, or select No SSH key.');
          await check();
          break;
        case 'console': {
          const password = document.getElementById('password');
          const confirm = document.getElementById('confirm');
          const result = await api('/api/console', {
            root_password: ui.rootPassword, password_ssh: ui.passwordSSH,
            password: password ? password.value : '', confirm: confirm ? confirm.value : '',
          });
          if (password) password.value = '';
          if (confirm) confirm.value = '';
          ui.consoleSummary = result.console;
          break;
        }
        case 'review':
          await check();
          break;
        case 'erase':
          await api('/api/install', { choices: choices(), erase_confirmed: true });
          ui.progress = { stage: 'Starting installation...', detail: '', percent: 0 };
          ui.busy = false;
          go('progress');
          follow();
          return;
        default:
          return;
      }
      ui.busy = false;
      go(screenAfter(ui.screen));
    } catch (error) {
      ui.busy = false;
      ui.error = error.message;
      showError();
    }
  }

  function back() {
    if (ui.busy) return;
    ui.error = '';
    if (ui.screen === 'disk') return askPowerOff();
    if (ui.screen === 'erase') {
      ui.error = 'Installation cancelled. No disks were changed.';
      return go('review');
    }
    const previous = screenBefore(ui.screen);
    if (previous) go(previous);
  }

  function askPowerOff() {
    const close = () => { ui.dialog = null; render(); };
    const node = el('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' },
      el('section', { class: 'card' },
        el('h1', { text: 'Turn off without installing?' }),
        el('p', { class: 'muted', text: 'No drive has been changed.' }),
        el('div', { class: 'actions' },
          el('button', { type: 'button', 'data-focus': true, onclick: close, text: 'No, go back' }),
          el('div', { class: 'right' }, el('button', { type: 'button', class: 'danger', onclick: powerOff, text: 'Turn off' })))));
    ui.dialog = { node, close };
    render();
  }

  async function powerOff() {
    try {
      await api('/api/poweroff', {});
      ui.dialog = null;
      go('off');
    } catch (error) {
      ui.error = error.message;
      showError();
    }
  }

  function follow() {
    if (ui.events) ui.events.close();
    const events = new EventSource('/api/progress');
    ui.events = events;
    events.addEventListener('progress', (message) => {
      const event = JSON.parse(message.data);
      if (event.percent < ui.progress.percent) event.percent = ui.progress.percent;
      ui.progress = event;
      if (event.done) {
        events.close();
        ui.events = null;
        go(event.error ? 'failed' : 'done');
      } else if (ui.screen === 'progress') {
        render();
      }
    });
    events.onerror = () => {
      if (ui.events === events && events.readyState === EventSource.CLOSED) {
        ui.events = null;
        setTimeout(refresh, 1000);
      }
    };
  }

  // ---- Keyboard ----------------------------------------------------------------
  window.addEventListener('keydown', (event) => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      return;
    }
    const target = event.target;
    const typing = target && target.tagName === 'INPUT' && (target.type === 'text' || target.type === 'password');
    if (event.key === 'Backspace' && !typing) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (ui.dialog) return ui.dialog.close();
      if (ORDER.includes(ui.screen)) back();
      return;
    }
    if (event.key === 'Enter') {
      if (target && target.tagName === 'BUTTON') return; // the button itself acts
      event.preventDefault();
      if (ui.dialog) return;
      if (target && target.type === 'checkbox') {
        target.click();
        return;
      }
      if (ORDER.includes(ui.screen)) next();
      return;
    }
    // Arrow keys move between buttons on the confirmation screens.
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown')
        && target && target.tagName === 'BUTTON') {
      const scope = ui.dialog ? ui.dialog.node : app;
      const buttons = [...scope.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(target);
      if (index >= 0 && buttons.length > 1) {
        event.preventDefault();
        const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        buttons[(index + step + buttons.length) % buttons.length].focus();
      }
    }
  });

  // A reload (or a restarted kiosk) resumes from the installer's own state.
  refresh();
  // Tell the launcher the page really painted; without this it falls back to
  // the text installer.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    api('/api/ui-ready', {}).catch(() => {});
  }));
})();
