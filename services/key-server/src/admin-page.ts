import { createHash } from 'node:crypto';

/**
 * The voucher admin page (`GET /admin`): one self-contained HTML page with inline CSS and JS.
 * It holds no data: everything is fetched from the admin API with the token the owner pastes
 * (or passes in the URL fragment, `#token=…`, which never reaches the server). The token lives
 * in sessionStorage only. All data is rendered with textContent, never as HTML.
 */

const STYLE = `
:root {
  color-scheme: light;
  --bg: #f7f3ef; --surface: #fff; --surface-2: #fcfbf9; --line: #e5e1dc; --line-strong: #d4cec8;
  --fg: #28211d; --muted: #605954; --subtle: #79736e;
  --accent: #b04e35; --accent-hover: #913d2b; --accent-soft: #fef5f0; --accent-line: #fcd0bd;
  --ring: rgba(206, 100, 69, 0.5); --danger: #c52c2a; --danger-hover: #ac1a1c;
  --ok-fg: #0a693c; --ok-bg: #e6faec; --ok-line: #b9e4c6;
  --info-fg: #2158a7; --info-bg: #ecf5ff; --info-line: #c7ddf9;
  --warn-fg: #884d01; --warn-bg: #fff5db; --warn-line: #f4d397;
  --off-fg: #4d5969; --off-bg: #eff3f7; --off-line: #d4dbe5;
  --bad-fg: #b02b27; --bad-bg: #ffefee; --bad-line: #facfca;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
[hidden] { display: none !important; }
header { display: flex; align-items: center; gap: 12px; padding: 16px 24px;
  border-bottom: 1px solid var(--line); background: var(--surface); }
header h1 { font-size: 16px; margin: 0; flex: 1; font-weight: 600; }
header h1 span + span { color: var(--subtle); font-weight: 400; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 64px; display: grid; gap: 20px; }
#app { display: grid; gap: 20px; }
main > *, #app > * { min-width: 0; }
section.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
  padding: 20px; }
h2 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
p.hint { margin: 0 0 16px; color: var(--muted); }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input, select { font: inherit; color: var(--fg); background: var(--surface); height: 36px;
  padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; min-width: 0; }
input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--ring);
  outline-offset: 1px; }
button { font: inherit; height: 36px; padding: 0 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line-strong); background: var(--surface); color: var(--fg); }
button:hover { background: var(--surface-2); }
button:disabled { opacity: 0.6; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
button.primary:hover { background: var(--accent-hover); }
button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
button.danger:hover { background: var(--danger-hover); }
button.small { height: 28px; padding: 0 10px; font-size: 13px; }
button.link { border: 0; background: none; color: var(--accent); padding: 0 4px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  align-items: end; }
.grid .wide { grid-column: span 2; }
.error { margin: 12px 0 0; color: var(--danger); }
.login { max-width: 460px; margin: 48px auto 0; width: 100%; }
.login form { display: grid; gap: 12px; }
.codes { border: 1px solid var(--accent-line); background: var(--accent-soft); }
.warning { font-weight: 600; color: var(--accent-hover); margin: 0 0 4px; }
.codes ul { list-style: none; margin: 0 0 16px; padding: 0; display: grid; gap: 6px;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.codes li { display: flex; align-items: center; gap: 8px; background: var(--surface);
  border: 1px solid var(--line); border-radius: 8px; padding: 6px 6px 6px 12px; }
.codes code { flex: 1; letter-spacing: 0.04em;
  /* Codes have no O, but people copy them by eye, so the zero must not look like one. These
     fonts slash or dot it, by default or with slashed-zero (which must follow the shorthand). */
  font: 600 16px/1 ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Mono", "DejaVu Sans Mono",
    monospace;
  font-variant-numeric: slashed-zero; }
.list-head { display: flex; justify-content: space-between; align-items: end; gap: 12px;
  flex-wrap: wrap; margin-bottom: 16px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line);
  white-space: nowrap; vertical-align: middle; }
th { background: var(--surface-2); color: var(--subtle); font-weight: 500; }
tr:last-child td { border-bottom: 0; }
td.note { white-space: normal; min-width: 160px; max-width: 280px; color: var(--muted); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.muted { color: var(--subtle); }
td.actions { text-align: right; }
.confirm { display: inline-grid; grid-template-columns: auto auto; gap: 4px 6px; }
.confirm span { grid-column: 1 / -1; color: var(--danger); font-weight: 500; text-align: right; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid;
  font-size: 12px; font-weight: 500; }
.badge.active { color: var(--ok-fg); background: var(--ok-bg); border-color: var(--ok-line); }
.badge.redeemed { color: var(--info-fg); background: var(--info-bg); border-color: var(--info-line); }
.badge.expired { color: var(--warn-fg); background: var(--warn-bg); border-color: var(--warn-line); }
.badge.revoked { color: var(--off-fg); background: var(--off-bg); border-color: var(--off-line); }
.empty { padding: 24px; text-align: center; color: var(--subtle); }
.summary { color: var(--subtle); font-size: 13px; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
  background: var(--fg); color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 13px; }
@media (max-width: 640px) { .grid .wide { grid-column: auto; } header { padding: 12px 16px; } }
`;

const SCRIPT = `
'use strict';
const T = {
  es: {
    title: 'Vales', lang: 'English', logout: 'Salir',
    loginTitle: 'Entra con el token de administración',
    loginHint: 'Es key_server_admin_token en terraform.tfvars. Se guarda solo en esta pestaña.',
    token: 'Token', enter: 'Entrar', badToken: 'Ese token no vale.',
    createTitle: 'Crear vales', createHint: 'Cada vale da ese saldo en dólares a quien lo canjee.',
    amount: 'Importe (USD)', count: 'Cuántos', note: 'Nota (opcional)', batch: 'Lote (opcional)',
    batchPh: 'Se crea uno solo', expires: 'Caduca (opcional)', create: 'Crear vales',
    creating: 'Creando…',
    codesTitle: (n, b) => (n === 1 ? '1 vale nuevo' : n + ' vales nuevos') + ' · lote ' + b,
    codesWarning: 'Copia los códigos ahora. No se volverán a mostrar.',
    codesAlphabet: 'No llevan O, I, L ni U: lo que se les parezca es un 0 o un 1.',
    copy: 'Copiar', copyAll: 'Copiar todos', copied: 'Copiado', done: 'Ya los he copiado',
    listTitle: 'Vales creados', status: 'Estado', all: 'Todos', refresh: 'Actualizar',
    s_active: 'Activo', s_redeemed: 'Canjeado', s_revoked: 'Revocado', s_expired: 'Caducado',
    f_active: 'Activos', f_redeemed: 'Canjeados', f_revoked: 'Revocados', f_expired: 'Caducados',
    c_status: 'Estado', c_amount: 'Importe', c_note: 'Nota', c_batch: 'Lote', c_created: 'Creado',
    c_redeemed: 'Canjeado', c_expires: 'Caduca',
    empty: 'No hay vales con estos filtros.', loading: 'Cargando…',
    shown: (n, max) => n >= max ? 'Se muestran los ' + n + ' más recientes.' : n + (n === 1 ? ' vale' : ' vales'),
    revoke: 'Revocar', revokeAsk: '¿Revocar este vale?', revokeAskKey: '¿Revocar y cortar su clave?',
    revokeYes: 'Revocar', cancel: 'Cancelar', revoked: 'Vale revocado',
    never: '—', failed: 'Algo ha fallado: ',
  },
  en: {
    title: 'Vouchers', lang: 'Español', logout: 'Sign out',
    loginTitle: 'Sign in with the admin token',
    loginHint: 'It is key_server_admin_token in terraform.tfvars. It is kept in this tab only.',
    token: 'Token', enter: 'Sign in', badToken: 'That token is not valid.',
    createTitle: 'Create vouchers', createHint: 'Each voucher gives that many dollars of credit to whoever redeems it.',
    amount: 'Amount (USD)', count: 'How many', note: 'Note (optional)', batch: 'Batch (optional)',
    batchPh: 'One is made for you', expires: 'Expires (optional)', create: 'Create vouchers',
    creating: 'Creating…',
    codesTitle: (n, b) => (n === 1 ? '1 new voucher' : n + ' new vouchers') + ' · batch ' + b,
    codesWarning: 'Copy the codes now. They will not be shown again.',
    codesAlphabet: 'They have no O, I, L or U: anything that looks like one is a 0 or a 1.',
    copy: 'Copy', copyAll: 'Copy all', copied: 'Copied', done: 'I have copied them',
    listTitle: 'Vouchers', status: 'Status', all: 'All', refresh: 'Refresh',
    s_active: 'Active', s_redeemed: 'Redeemed', s_revoked: 'Revoked', s_expired: 'Expired',
    f_active: 'Active', f_redeemed: 'Redeemed', f_revoked: 'Revoked', f_expired: 'Expired',
    c_status: 'Status', c_amount: 'Amount', c_note: 'Note', c_batch: 'Batch', c_created: 'Created',
    c_redeemed: 'Redeemed', c_expires: 'Expires',
    empty: 'No vouchers match these filters.', loading: 'Loading…',
    shown: (n, max) => n >= max ? 'Showing the ' + n + ' most recent.' : n + (n === 1 ? ' voucher' : ' vouchers'),
    revoke: 'Revoke', revokeAsk: 'Revoke this voucher?', revokeAskKey: 'Revoke and cut off its key?',
    revokeYes: 'Revoke', cancel: 'Cancel', revoked: 'Voucher revoked',
    never: '—', failed: 'Something went wrong: ',
  },
};
const LIMIT = 500;
const TOKEN_KEY = 'sa-admin-token';
const $ = (id) => document.getElementById(id);
const store = {
  get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
  set(area, key, value) { try { window[area].setItem(key, value); } catch {} },
  del(area, key) { try { window[area].removeItem(key); } catch {} },
};

let lang = store.get('localStorage', 'sa-admin-lang') === 'en' ? 'en' : 'es';
let token = store.get('sessionStorage', TOKEN_KEY);
let vouchers = [];
let confirming = null;
let lastCodes = null;

// A token in the URL fragment (#token=…) signs in and is removed from the address bar.
function readFragment() {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (!match) return false;
  token = decodeURIComponent(match[1]);
  store.set('sessionStorage', TOKEN_KEY, token);
  return true;
}
readFragment();

const t = (key) => T[lang][key];

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function applyText() {
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll('[data-t]')) node.textContent = t(node.dataset.t);
  for (const node of document.querySelectorAll('[data-ph]')) node.placeholder = t(node.dataset.ph);
  document.title = t('title') + ' · Spain Assist';
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: Object.assign(
      { authorization: 'Bearer ' + token },
      body ? { 'content-type': 'application/json' } : {},
    ),
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut(t('badToken')); throw new ApiError(401, t('badToken')); }
  if (!res.ok) throw new ApiError(res.status, (data.error && data.error.message) || 'HTTP ' + res.status);
  return data;
}

let toastTimer;
function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 1800);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t('copied')); }
  catch (err) { toast(t('failed') + err.message); }
}

function showSignedIn(on) {
  $('login').hidden = on;
  $('app').hidden = !on;
  $('logout').hidden = !on;
}

function signOut(message) {
  token = null;
  store.del('sessionStorage', TOKEN_KEY);
  vouchers = [];
  lastCodes = null;
  renderCodes();
  showSignedIn(false);
  $('login-error').textContent = message || '';
  $('login-error').hidden = !message;
  $('token').focus();
}

// --- create ---------------------------------------------------------------------------------

function renderCodes() {
  const box = $('codes');
  box.hidden = !lastCodes;
  if (!lastCodes) return;
  $('codes-title').textContent = t('codesTitle')(lastCodes.codes.length, lastCodes.batch);
  const list = $('codes-list');
  list.replaceChildren(
    ...lastCodes.codes.map((code) =>
      el('li', {}, el('code', {}, code),
        el('button', { type: 'button', class: 'small', onclick: () => copy(code) }, t('copy')))),
  );
}

async function onCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('create-error');
  error.hidden = true;
  const body = {
    count: Number(form.count.value),
    amountUsd: Number(form.amount.value),
  };
  const note = form.note.value.trim();
  const batch = form.batch.value.trim();
  if (note) body.note = note;
  if (batch) body.batch = batch;
  if (form.expires.value) {
    // End of the chosen day, local time.
    body.expiresAt = new Date(form.expires.value + 'T23:59:59').toISOString();
  }
  const button = $('create-btn');
  button.disabled = true;
  button.textContent = t('creating');
  try {
    const result = await api('POST', '/admin/vouchers', body);
    lastCodes = { codes: result.codes, batch: result.batch };
    renderCodes();
    form.note.value = '';
    form.batch.value = '';
    $('codes').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await loadList();
  } catch (err) {
    if (err.status !== 401) { error.textContent = t('failed') + err.message; error.hidden = false; }
  } finally {
    button.disabled = false;
    button.textContent = t('create');
  }
}

// --- list -----------------------------------------------------------------------------------

function stateOf(v) {
  return v.status === 'active' && v.expired ? 'expired' : v.status;
}

function fmtDate(iso, withTime = true) {
  if (!iso) return t('never');
  const options = { day: 'numeric', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(options, { hour: '2-digit', minute: '2-digit' });
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-ES' : 'en-GB', options).format(new Date(iso));
}

function fmtUsd(n) {
  return new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US', {
    style: 'currency', currency: 'USD',
  }).format(n);
}

function actionsCell(v) {
  const cell = el('td', { class: 'actions' });
  if (v.status === 'revoked') return cell;
  if (confirming === v.id) {
    const yes = el('button', { type: 'button', class: 'small danger' }, t('revokeYes'));
    yes.addEventListener('click', () => revoke(v.id, yes));
    const no = el('button', {
      type: 'button', class: 'small', onclick: () => { confirming = null; renderList(); },
    }, t('cancel'));
    cell.append(el('span', { class: 'confirm' },
      el('span', {}, v.status === 'redeemed' ? t('revokeAskKey') : t('revokeAsk')), yes, no));
    queueMicrotask(() => no.focus({ preventScroll: true }));
  } else {
    cell.append(el('button', {
      type: 'button', class: 'small', onclick: () => { confirming = v.id; renderList(); },
    }, t('revoke')));
  }
  return cell;
}

function renderList() {
  const body = $('rows');
  $('empty').hidden = vouchers.length > 0;
  $('summary').textContent = vouchers.length ? t('shown')(vouchers.length, LIMIT) : '';
  body.replaceChildren(
    ...vouchers.map((v) => {
      const state = stateOf(v);
      return el('tr', {},
        el('td', {}, el('span', { class: 'badge ' + state }, t('s_' + state))),
        el('td', { class: 'num' }, fmtUsd(v.amountUsd)),
        el('td', { class: 'note' }, v.note || ''),
        el('td', {}, v.batch || ''),
        el('td', { class: 'muted' }, fmtDate(v.createdAt)),
        el('td', { class: 'muted' }, fmtDate(v.redeemedAt)),
        el('td', { class: 'muted' }, fmtDate(v.expiresAt, false)),
        actionsCell(v),
      );
    }),
  );
  const batches = [...new Set(vouchers.map((v) => v.batch).filter(Boolean))];
  const known = new Set([...$('batches').options].map((o) => o.value));
  for (const b of batches) if (!known.has(b)) $('batches').append(el('option', { value: b }));
}

async function loadList() {
  const error = $('list-error');
  error.hidden = true;
  const params = new URLSearchParams({ limit: String(LIMIT) });
  if ($('f-status').value) params.set('status', $('f-status').value);
  if ($('f-batch').value.trim()) params.set('batch', $('f-batch').value.trim());
  try {
    vouchers = (await api('GET', '/admin/vouchers?' + params)).vouchers;
    confirming = null;
    showSignedIn(true);
    renderList();
    return true;
  } catch (err) {
    if (err.status !== 401) { error.textContent = t('failed') + err.message; error.hidden = false; }
    return false;
  }
}

async function revoke(id, button) {
  button.disabled = true;
  try {
    await api('POST', '/admin/vouchers/' + encodeURIComponent(id) + '/revoke');
    toast(t('revoked'));
  } catch (err) {
    if (err.status !== 401) {
      $('list-error').textContent = t('failed') + err.message;
      $('list-error').hidden = false;
    }
  }
  await loadList();
}

// --- wiring ---------------------------------------------------------------------------------

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = $('token').value.trim();
  if (!value) return;
  token = value;
  store.set('sessionStorage', TOKEN_KEY, token);
  $('token').value = '';
  if (!(await loadList()) && token) {
    $('login-error').textContent = t('failed') + $('list-error').textContent;
    $('login-error').hidden = false;
  }
});
$('logout').addEventListener('click', () => signOut());
$('lang').addEventListener('click', () => {
  lang = lang === 'es' ? 'en' : 'es';
  store.set('localStorage', 'sa-admin-lang', lang);
  applyText();
  renderCodes();
  renderList();
});
$('create-form').addEventListener('submit', onCreate);
$('copy-all').addEventListener('click', () => copy(lastCodes.codes.join('\\n')));
$('codes-done').addEventListener('click', () => { lastCodes = null; renderCodes(); });
$('f-status').addEventListener('change', loadList);
$('f-batch').addEventListener('change', loadList);
$('refresh').addEventListener('click', loadList);
window.addEventListener('hashchange', () => { if (readFragment()) loadList(); });

applyText();
if (token) loadList(); else signOut();
`;

const BODY = `
<header>
  <h1><span data-t="title"></span> <span>· Spain Assist</span></h1>
  <button type="button" class="link" id="lang" data-t="lang"></button>
  <button type="button" id="logout" class="small" data-t="logout" hidden></button>
</header>
<main>
  <section class="card login" id="login" hidden>
    <h2 data-t="loginTitle"></h2>
    <p class="hint" data-t="loginHint"></p>
    <form id="login-form" autocomplete="off">
      <label><span data-t="token"></span>
        <input id="token" type="password" autocomplete="off" spellcheck="false" required></label>
      <button type="submit" class="primary" data-t="enter"></button>
      <p class="error" id="login-error" role="alert" hidden></p>
    </form>
  </section>

  <div id="app" hidden>
    <section class="card">
      <h2 data-t="createTitle"></h2>
      <p class="hint" data-t="createHint"></p>
      <form id="create-form" class="grid" autocomplete="off">
        <label><span data-t="amount"></span>
          <input name="amount" type="number" min="0.01" max="10000" step="0.01" value="5" required></label>
        <label><span data-t="count"></span>
          <input name="count" type="number" min="1" max="1000" step="1" value="1" required></label>
        <label class="wide"><span data-t="note"></span>
          <input name="note" maxlength="500"></label>
        <label><span data-t="batch"></span>
          <input name="batch" maxlength="100" data-ph="batchPh"></label>
        <label><span data-t="expires"></span>
          <input name="expires" type="date"></label>
        <button type="submit" class="primary" id="create-btn" data-t="create"></button>
      </form>
      <p class="error" id="create-error" role="alert" hidden></p>
    </section>

    <section class="card codes" id="codes" hidden aria-live="polite">
      <h2 id="codes-title"></h2>
      <p class="warning" data-t="codesWarning"></p>
      <p class="hint" data-t="codesAlphabet"></p>
      <ul id="codes-list"></ul>
      <div class="row">
        <button type="button" class="primary" id="copy-all" data-t="copyAll"></button>
        <button type="button" id="codes-done" data-t="done"></button>
      </div>
    </section>

    <section class="card">
      <div class="list-head">
        <div><h2 data-t="listTitle"></h2><span class="summary" id="summary"></span></div>
        <div class="row">
          <label><span data-t="status"></span>
            <select id="f-status">
              <option value="" data-t="all"></option>
              <option value="active" data-t="f_active"></option>
              <option value="redeemed" data-t="f_redeemed"></option>
              <option value="expired" data-t="f_expired"></option>
              <option value="revoked" data-t="f_revoked"></option>
            </select></label>
          <label><span data-t="c_batch"></span>
            <input id="f-batch" list="batches" maxlength="100"></label>
          <button type="button" id="refresh" data-t="refresh"></button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th data-t="c_status"></th><th data-t="c_amount"></th><th data-t="c_note"></th>
            <th data-t="c_batch"></th><th data-t="c_created"></th><th data-t="c_redeemed"></th>
            <th data-t="c_expires"></th><th></th>
          </tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <div class="empty" id="empty" data-t="empty" hidden></div>
      </div>
      <p class="error" id="list-error" role="alert" hidden></p>
      <datalist id="batches"></datalist>
    </section>
  </div>
</main>
<div class="toast" id="toast" role="status" hidden></div>
`;

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

/** The page's HTML; the inline style and script are allowed by hash in {@link ADMIN_PAGE_CSP}. */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Vales · Spain Assist</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>${BODY}<script>${SCRIPT}</script>
</body>
</html>
`;

/** No third-party origins; only this page's own inline style/script and same-origin API calls. */
export const ADMIN_PAGE_CSP = [
  "default-src 'none'",
  `script-src ${sha256(SCRIPT)}`,
  `style-src ${sha256(STYLE)}`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers of the admin page (on top of the app-wide `Cache-Control: no-store`). */
export const ADMIN_PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': ADMIN_PAGE_CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Robots-Tag': 'noindex, nofollow',
};
