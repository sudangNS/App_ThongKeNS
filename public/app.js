'use strict';
/* Thống kê NS – quét QR phiếu pallet & nhập sản lượng theo tổ. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number(n) || 0).toLocaleString('vi-VN');
const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || ''); };
const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* bỏ qua */ } },
};

/* ---------------- Giao diện sáng / tối ---------------- */
const THEMES = [['auto', 'Theo máy'], ['light', 'Sáng'], ['dark', 'Tối']];
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(t = store.get('theme', 'auto')) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && darkMq.matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#18201c' : '#0f5132');
}
function setTheme(t) { store.set('theme', t); applyTheme(t); }
darkMq.addEventListener?.('change', () => applyTheme());
applyTheme();

const state = { user: null, clientId: '', ctx: null, scanner: null, busy: false, pallet: null };

/* ---------------- API ---------------- */

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({ error: `Lỗi kết nối (HTTP ${r.status})` }));
  if (r.status === 401 && path !== '/api/auth') { state.user = null; showLogin('Phiên đăng nhập đã hết, hãy đăng nhập lại'); }
  if (!r.ok && r.status !== 409) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, data: j });
  return { status: r.status, ...j };
}

/* ---------------- Màn hình ---------------- */

const VIEWS = ['v-loading', 'v-login', 'v-scan', 'v-item', 'v-work', 'v-wip', 'v-report', 'v-more', 'v-transfer'];
const TAB_OF = { 'v-scan': 'scan', 'v-item': 'scan', 'v-work': 'work', 'v-wip': 'wip', 'v-report': 'report', 'v-more': 'more', 'v-transfer': 'more' };
function show(id) {
  if (id !== 'v-scan' && id !== 'v-item') stopCamera();
  for (const v of VIEWS) $(`#${v}`).hidden = v !== id;
  $$('#tabbar [data-tab]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === TAB_OF[id])));
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, bad ? 5000 : 2500);
}

function ask(title, html, okText = 'Đồng ý') {
  const d = $('#dlg');
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = html;
  $('#dlg-ok').textContent = okText;
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.returnValue = '';
    d.showModal();
  });
}

/* ---------------- Đăng nhập ---------------- */

function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Không tải được Google Sign-In, kiểm tra mạng'));
    document.head.appendChild(s);
  });
}

async function showLogin(msg = '') {
  stopCamera();
  $('#tabbar').hidden = true;
  $('#btn-bell').hidden = true;
  document.body.classList.remove('has-tabs');
  show('v-login');
  $('#login-msg').textContent = msg;
  if (!state.clientId) { $('#login-msg').textContent = 'Máy chủ chưa cấu hình GOOGLE_CLIENT_ID'; return; }
  try {
    await loadGis();
    google.accounts.id.initialize({ client_id: state.clientId, callback: onCredential, ux_mode: 'popup', auto_select: true });
    $('#gbtn').innerHTML = '';
    google.accounts.id.renderButton($('#gbtn'), { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', locale: 'vi' });
  } catch (e) { $('#login-msg').textContent = e.message; }
}

async function onCredential(resp) {
  $('#login-msg').textContent = '';
  try {
    const r = await api('/api/auth', { method: 'POST', body: { credential: resp.credential } });
    setUser(r.user);
    route();
  } catch (e) { $('#login-msg').textContent = e.message; }
}

const isLead = () => !!state.user?.leadTeams?.length;
const canTransfer = () => !!state.user && !state.user.viewOnly && (state.user.admin || state.user.statTeams?.length > 0);

function setUser(u) {
  state.user = u;
  $('#tabbar').hidden = !u;
  $('#btn-bell').hidden = !u || !isLead();
  document.body.classList.toggle('has-tabs', !!u);
  if (u) refreshBadge();
}

async function logout() {
  try { await api('/api/auth', { method: 'DELETE' }); } catch { /* bỏ qua */ }
  try { google.accounts.id.disableAutoSelect(); } catch { /* bỏ qua */ }
  setUser(null);
  history.replaceState(null, '', '/');
  showLogin();
}

/* ---------------- Điều hướng ---------------- */

const TABS = { scan: () => showScan(), work: () => showWork(), wip: () => showWip(), report: () => showReport(), more: () => showMore(), transfer: () => showTransfer() };

function route() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (code) return openCode(code, false);
  (TABS[q.get('tab')] || TABS.scan)();
}
function goTab(tab, extra = '') {
  history.pushState(null, '', tab === 'scan' ? '/' : `/?tab=${tab}${extra}`);
  route();
}
window.addEventListener('popstate', () => { if (state.user) route(); });
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-nav="home"]');
  if (!a) return;
  e.preventDefault();
  if (!state.user) return;
  goTab('scan');
});
$$('#tabbar [data-tab]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.tab)));
$('#btn-bell').addEventListener('click', () => goTab('work'));

/* ---------------- Chuông: số pallet chờ tôi nhận ---------------- */

function setBadge(n) {
  for (const el of [$('#bell-n'), $('#tab-work-n')]) {
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : String(n || '');
  }
}
async function refreshBadge() {
  if (!state.user || !isLead()) return setBadge(0);
  try { setBadge((await api('/api/handover?count=1')).inbox); } catch { /* bỏ qua */ }
}
setInterval(() => { if (document.visibilityState === 'visible') refreshBadge(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshBadge(); });

function go(code, fromScan) {
  history.pushState(null, '', `/?code=${encodeURIComponent(code)}`);
  openCode(code, fromScan);
}

/** QR có thể là mã trần hoặc 1 đường link có ?code= */
function extractCode(text) {
  const s = String(text || '').trim();
  try { const u = new URL(s); return u.searchParams.get('code') || s; } catch { return s; }
}

/* ---------------- Quét ---------------- */

function showScan() {
  show('v-scan');
  $('#cam-msg').textContent = '';
  renderRecent();
  if (store.get('camOK', false)) startCamera();
}

async function startCamera() {
  if (state.scanner) return;
  $('#cam-msg').textContent = '';
  if (!window.Html5Qrcode) { $('#cam-msg').textContent = 'Chưa tải được thư viện quét QR'; return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('#cam-msg').textContent = 'Trình duyệt này không cho mở camera. Hãy mở bằng Chrome/Safari (không mở trong Zalo/Messenger), hoặc nhập mã bên dưới.';
    return;
  }
  // Khung phải hiện ra TRƯỚC khi start: thư viện lấy chiều rộng khung để tạo video.
  $('#reader').classList.add('on');
  const sc = new Html5Qrcode('reader', { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
  state.scanner = sc;
  $('#btn-cam').textContent = 'Tắt camera';
  try {
    await sc.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
      (text) => {
        if (state.scanner !== sc) return;
        if (navigator.vibrate) navigator.vibrate(80);
        stopCamera();
        go(extractCode(text), true);
      },
      () => {},
    );
    store.set('camOK', true);
  } catch (e) {
    state.scanner = null;
    $('#reader').classList.remove('on');
    $('#reader').innerHTML = '';
    $('#btn-cam').textContent = 'Bật camera quét QR';
    store.set('camOK', false);
    $('#cam-msg').textContent = `Không mở được camera: ${e?.message || e}. Hãy cho phép quyền camera, hoặc nhập mã bên dưới.`;
  }
}

function stopCamera() {
  const sc = state.scanner;
  state.scanner = null;
  $('#btn-cam').textContent = 'Bật camera quét QR';
  $('#reader').classList.remove('on');
  if (sc) sc.stop().then(() => sc.clear()).catch(() => {});
}

$('#btn-cam').addEventListener('click', () => (state.scanner ? stopCamera() : startCamera()));
$('#f-manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = extractCode($('#in-code').value);
  if (!code) return;
  $('#in-code').value = '';
  stopCamera();
  go(code, true);
});

function renderRecent() {
  const list = store.get('recent', []);
  $('#recent').innerHTML = list.length ? `
    <div class="card"><h2>Quét gần đây</h2><ul class="list">
      ${list.map((r) => `<li><button class="item" data-code="${esc(r.code)}">
        <b>${esc(r.name)}</b> ${r.team ? `<span class="badge">${esc(r.team)}</span>` : ''}
        <div class="small muted">${esc(r.product)} · <span class="code">${esc(r.code)}</span></div>
      </button></li>`).join('')}
    </ul></div>` : '';
  $$('#recent [data-code]').forEach((b) => b.addEventListener('click', () => go(b.dataset.code, true)));
}

function addRecent(ctx) {
  const list = store.get('recent', []).filter((r) => r.code !== ctx.code);
  list.unshift({ code: ctx.code, name: ctx.part.name, team: ctx.team?.name || '', product: ctx.product.name });
  store.set('recent', list.slice(0, 8));
}

/* ---------------- Mở mã ---------------- */

async function openCode(code, logScan) {
  stopCamera();
  show('v-item');
  const v = $('#v-item');
  v.innerHTML = '<div class="center"><div class="spinner"></div></div>';
  try {
    const ctx = await api(`/api/scan?code=${encodeURIComponent(code)}${logScan ? '&log=1' : ''}`);
    state.ctx = ctx;
    state.pallet = null;
    addRecent(ctx);
    renderItem();
  } catch (e) {
    if (e.status === 401) return;
    const groups = e.data?.groups || [];
    v.innerHTML = `
      ${backBar()}
      <div class="card"><h2>Không mở được mã</h2>
        <p class="msg">${esc(e.message)}</p>
        <p class="code">${esc(code)}</p>
        ${groups.length ? `<p>Chi tiết này đi qua các tổ:</p><div class="row gap wrap">
          ${groups.map((g) => `<button class="btn" data-go="${esc(e.data.partRef)}-${esc(g.code)}">${esc(g.name)}</button>`).join('')}
        </div>` : ''}
      </div>`;
    bindCommon(v);
  }
}

function backBar(ctx) {
  return `<div class="sticky-head">
    <button class="btn sm" data-nav="home">← Quét mã khác</button>
    ${ctx?.team ? `<span class="team-tag">${esc(ctx.team.name)}</span>` : ''}
    ${ctx ? `<span class="code grow">${esc(ctx.code)}</span>` : ''}
  </div>`;
}

function bindCommon(root) {
  $$('[data-go]', root).forEach((b) => b.addEventListener('click', () => go(b.dataset.go, true)));
}

/* ---------------- Hiển thị thông tin ---------------- */

function stepChip(s, here) {
  const cls = ['chip'];
  if (here) cls.push('here');
  if (s.required && s.done >= s.required) cls.push('done');
  return `<span class="${cls.join(' ')}" title="${esc(s.group)}"><b>${s.no}. ${esc(s.stage)}</b> ${fmt(s.done)}/${fmt(s.required)}</span>`;
}

/* Cấp cha – con: SP (xanh đậm) → Cụm (xanh vừa) → Chi tiết (xanh nhạt) */
const LV = { SP: ['sp', 'Sản phẩm'], CUM: ['cum', 'Cụm'], CT: ['ct', 'Chi tiết'] };
const lvOf = (level) => LV[String(level || '').toUpperCase()] || LV.CT;
const lvTag = (level) => { const [k, n] = lvOf(level); return `<span class="lv-tag lv-${k}">${n}</span>`; };

function progressList(items) {
  return `<ul class="list tree-list">${items.map((c) => `<li>
    <div class="row gap">${lvTag(c.level)}<span class="grow"><b>${esc(c.name)}</b> <span class="small muted">${esc(c.kind || '')}</span></span>
      <span class="small"><b>${fmt(c.done)}</b>/${fmt(c.required)}</span></div>
    <div class="small muted">Công đoạn cuối: ${esc(c.lastStage)}</div>
    <div class="bar"><i style="width:${pct(c.done, c.required)}%"></i></div>
  </li>`).join('')}</ul>`;
}

/** Khối có header theo cấp. `current` = khối của mã đang quét. */
function lvBlock(level, title, sub, body, current, depth) {
  const [k, n] = lvOf(level);
  return `<section class="card blk depth-${depth}${current ? ' current' : ''}">
    <header class="blk-head lv-${k}">
      <span class="blk-lv">${n}</span>
      <span class="blk-title">${esc(title)}</span>
      ${current ? '<span class="blk-now">Đang quét</span>' : ''}
    </header>
    ${sub ? `<div class="code">${esc(sub)}</div>` : ''}
    ${body}
  </section>`;
}

/** Danh sách con sổ ra được, header tô theo cấp của con. */
function childTree(label, items, level) {
  if (!items.length) return '';
  const [k] = lvOf(level);
  return `<details class="tree"><summary class="tree-head lv-${k}"><span class="grow">${label}</span><span class="badge">${items.length}</span></summary>${progressList(items)}</details>`;
}

/* ================= Màn hình chi tiết sau khi quét =================
   Thứ tự: Tổng quan chi tiết → Cụm (thu gọn) → Sản phẩm (thu gọn) → Chờ nhận → Pallet đang làm → Pallet đã giao
           → nút Nhập sản lượng (pop-up 3 bước: chọn pallet → nhập song song → xác nhận) → Nhật ký. */

const LV_NAME = { SP: 'Sản phẩm', CUM: 'Cụm', CT: 'Chi tiết' };

function fact(label, value) {
  return value === '' || value === null || value === undefined ? '' : `<div class="fact"><span>${label}</span><b>${value}</b></div>`;
}

function summaryCard(ctx) {
  const { part, cum, product, stats } = ctx;
  const lvl = (part.level || '').toUpperCase();
  const [k] = lvOf(lvl);
  const teamCode = ctx.team?.code;
  const isSP = lvl === 'SP';
  const isCum = lvl === 'CUM';
  const mat = part.material ? `${esc(part.material)}${part.glue ? ` · ghép ${esc(part.glue)}` : ''}` : '';
  return `<section class="card blk sum current">
    <header class="blk-head lv-${k}">
      <span class="blk-lv">${LV_NAME[lvl] || 'Chi tiết'}</span>
      <span class="blk-title">${esc(part.name)}</span>
      ${ctx.team ? `<span class="blk-now">${esc(ctx.team.name)}</span>` : ''}
    </header>
    <div class="code">${esc(part.ref)}${part.code ? ` · ${esc(part.code)}` : ''}</div>
    <div class="facts">
      ${fact('Lệnh SX', `${esc(product.mo_no)}${product.lsx_stt ? ` · dòng ${esc(product.lsx_stt)}` : ''}`)}
      ${isSP ? '' : fact('Sản phẩm', esc(product.name))}
      ${isSP || isCum ? '' : fact('Cụm', cum ? esc(cum.name) : '<span class="muted">Chi tiết rời</span>')}
      ${fact('Kích thước', part.size ? esc(part.size) : '')}
      ${fact('Nguyên liệu', mat)}
      ${fact('SL / SP', fmt(part.qty_per_unit))}
      ${fact('SL cần', fmt(part.qty_required))}
      ${product.due_date ? fact('Hạn giao', esc(fmtDate(product.due_date))) : ''}
    </div>
    ${stats ? `<div class="flow3">
      <div class="f3"><span>Đã nhận vào</span><b>${fmt(Math.round(stats.inQty))}</b><small>${stats.fromTeam ? `từ ${esc(stats.fromTeam)}` : 'bắt đầu tại tổ'}</small></div>
      <div class="f3 mid"><span>Đang làm</span><b>${fmt(Math.round(stats.wip))}</b><small>tại ${esc(ctx.team.name.replace(/^Tổ /, ''))}</small></div>
      <div class="f3"><span>Đã giao đi</span><b>${fmt(Math.round(stats.outQty))}</b><small>${stats.toTeam ? `→ ${esc(stats.toTeam)}${stats.toPart ? ` (${esc(stats.toPart)})` : ''}` : 'hoàn thành'}</small></div>
    </div>
    <div class="bar" title="Đã giao / SL cần"><i style="width:${pct(stats.outQty, stats.required)}%"></i></div>` : ''}
    <div class="route">${part.steps.map((s) => stepChip(s, s.team === teamCode)).join('')}</div>
    ${isCum ? childTree('Chi tiết trong cụm', cum?.children || [], 'CT') : ''}
    ${isSP ? childTree('Cụm / chi tiết rời', ctx.spChildren, 'CUM') : ''}
  </section>`;
}

/** Khối thu gọn (bấm để sổ ra) cho Cụm và Sản phẩm. */
function foldCard(level, title, line, body) {
  const [k, n] = lvOf(level);
  return `<details class="card blk fold">
    <summary class="blk-head lv-${k}"><span class="blk-lv">${n}</span><span class="blk-title">${esc(title)}</span><span class="chev" aria-hidden="true"></span></summary>
    ${line ? `<div class="fold-line small muted">${line}</div>` : ''}
    <div class="fold-body">${body}</div>
  </details>`;
}

function parentCards(ctx) {
  const { part, cum, product } = ctx;
  const lvl = (part.level || '').toUpperCase();
  let html = '';
  if (cum && lvl === 'CT') {
    html += foldCard('CUM', cum.name, `${esc(cum.ref)} · cần ${fmt(cum.qty_required)}`, `
      <dl class="kv">
        ${cum.code ? `<dt>Mã</dt><dd>${esc(cum.code)}</dd>` : ''}
        <dt>SL / SP</dt><dd>${fmt(cum.qty_per_unit)}</dd>
        <dt>SL cần</dt><dd>${fmt(cum.qty_required)}</dd>
      </dl>
      <div class="route">${cum.steps.map((s) => stepChip(s, false)).join('')}</div>
      ${childTree('Chi tiết trong cụm', cum.children, 'CT')}`);
  }
  if (lvl !== 'SP') {
    html += foldCard('SP', product.name, `${esc(product.mo_no)} · ${fmt(product.qty)} ${esc(product.unit)}${product.customer ? ` · ${esc(product.customer)}` : ''}`, `
      ${product.name_vi ? `<div class="muted">${esc(product.name_vi)}</div>` : ''}
      <dl class="kv">
        <dt>LSX</dt><dd>${esc(product.mo_no)}${product.lsx_stt ? ` · dòng ${esc(product.lsx_stt)}` : ''}</dd>
        ${product.customer ? `<dt>Khách</dt><dd>${esc(product.customer)}</dd>` : ''}
        ${product.code ? `<dt>Mã SP</dt><dd>${esc(product.code)}${product.bom_code ? ` · ${esc(product.bom_code)}` : ''}</dd>` : ''}
        <dt>SL</dt><dd>${fmt(product.qty)} ${esc(product.unit)}</dd>
        ${product.due_date ? `<dt>Hạn giao</dt><dd>${esc(fmtDate(product.due_date))}</dd>` : ''}
        ${product.wood ? `<dt>Gỗ</dt><dd>${esc(product.wood)}${product.color ? ` · màu ${esc(product.color)}` : ''}</dd>` : ''}
      </dl>
      ${product.steps.length ? `<div class="route">${product.steps.map((s) => stepChip(s, false)).join('')}</div>` : ''}`);
  }
  return html;
}

const statusBadge = (status, st) => {
  const cls = st === 'waiting' ? ' warn' : st === 'open' ? '' : ' off';
  return `<span class="badge${cls}">${esc(status || 'Đang làm')}</span>`;
};

function palletRow(ctx, p) {
  const stage = new Map(ctx.teamSteps.map((s) => [s.id, s.stage]));
  return `<li>
    <div class="row gap"><b class="grow">Pallet ${esc(p.no)}</b>${statusBadge(p.status, p.state)}</div>
    <div class="small">${Object.entries(p.perStep).map(([id, q]) => `${esc(stage.get(id) || id)}: <b>${fmt(q)}</b>`).join(' · ') || '<span class="muted">Chưa ghi sản lượng</span>'}</div>
    ${p.qtyIn ? `<div class="small muted">Nhận từ tổ trước: ${fmt(p.qtyIn)}</div>` : ''}
    ${p.dest && p.state !== 'open' ? `<div class="small muted">Giao ${fmt(p.qtyOut)} → ${esc(p.dest.teamName)}${p.delivered_at ? ` · ${esc(p.delivered_at)}` : ''}</div>` : ''}
    ${p.returned ? `<div class="notice small" style="margin-top:6px">${esc(p.note)}</div>` : ''}
    ${p.lot_go || p.lot_dau ? `<div class="small muted">${p.lot_go ? `Lô gỗ ${esc(p.lot_go)} ` : ''}${p.lot_dau ? `· Lô dầu ${esc(p.lot_dau)}` : ''}</div>` : ''}
    <div class="row gap wrap" style="margin-top:6px">
      ${p.canDeliver ? `<button class="btn sm primary" data-deliver="${esc(p.id)}" data-q="${p.qtyOut}" data-to="${esc(p.dest.teamName)}">Giao ${fmt(p.qtyOut)} cho ${esc(p.dest.teamName)}</button>` : ''}
      ${ctx.canLead && p.state === 'open' && p.dest && !p.qtyOut ? `<span class="small muted">Chưa có SL ở “${esc(p.exitStage)}” để giao</span>` : ''}
      ${p.canFinish ? `<button class="btn sm" data-close="${esc(p.id)}">Hoàn thành pallet</button>` : ''}
      ${p.closed && state.user?.admin ? `<button class="btn sm" data-reopen="${esc(p.id)}">Mở lại</button>` : ''}
    </div>
  </li>`;
}

function palletBlocks(ctx) {
  if (!ctx.team) return '';
  const open = ctx.pallets.filter((p) => p.state === 'open');
  const gone = ctx.pallets.filter((p) => p.state !== 'open');
  const SHOW = 10;
  return `<section class="card"><h2>Pallet đang làm <span class="badge">${open.length}</span></h2>
      ${open.length ? `<ul class="list">${open.map((p) => palletRow(ctx, p)).join('')}</ul>` : '<p class="muted small">Chưa có pallet nào đang làm tại tổ.</p>'}
    </section>
    <section class="card"><h2>Pallet đã giao <span class="badge off">${gone.length}</span></h2>
      ${gone.length ? `<ul class="list">${gone.slice(0, SHOW).map((p) => palletRow(ctx, p)).join('')}</ul>
        ${gone.length > SHOW ? `<details><summary class="small">Xem thêm ${gone.length - SHOW} pallet</summary><ul class="list">${gone.slice(SHOW).map((p) => palletRow(ctx, p)).join('')}</ul></details>` : ''}`
        : '<p class="muted small">Chưa giao pallet nào.</p>'}
    </section>`;
}

function incomingCard(ctx) {
  if (!ctx.incoming?.length) return '';
  return `<div class="card attn"><h2>Chờ ${esc(ctx.team.name)} nhận (${ctx.incoming.length})</h2>
    <ul class="list">${ctx.incoming.map((f) => palletItem(f, { receive: f.canReceive })).join('')}</ul></div>`;
}

function logCard(ctx) {
  if (!ctx.team) return '';
  if (!ctx.logs.length) return '<details class="card"><summary><span class="grow">Nhật ký</span><span class="badge off">0</span></summary><p class="muted small">Chưa có ghi nhận nào.</p></details>';
  return `<details class="card"><summary><span class="grow">Nhật ký gần đây</span><span class="badge">${ctx.logs.length}</span></summary><ul class="list">
    ${ctx.logs.map((l) => `<li class="log${l.cancelled ? ' cancelled' : ''}${l.reversal ? ' reversal' : ''}">
      <div class="what"><b>${esc(l.stage)}</b> · Pallet ${esc(l.pallet_no || '–')}</div>
      <div class="q">${fmt(l.qty)}${l.ng ? ` <span class="small" style="color:var(--bad)">NG ${fmt(l.ng)}</span>` : ''}</div>
      <div class="small muted">Ngày ${esc(l.date)}${l.worker ? ` · ${esc(l.worker)}` : ''} · ${esc(l.by)} · ${esc(l.at)}${l.note ? `<br>${esc(l.note)}` : ''}${l.cancelled ? '<br><b>Đã huỷ</b>' : ''}</div>
      <div>${l.canCancel ? `<button class="btn sm danger" data-cancel="${esc(l.id)}">Huỷ</button>` : ''}</div>
    </li>`).join('')}
  </ul></details>`;
}

function teamPicker(ctx) {
  return `<div class="card"><h2>Chọn tổ</h2>
    <p class="muted small">Mã quét không có mã tổ. Chi tiết này đi qua các tổ:</p>
    <div class="row gap wrap">${ctx.groups.map((g) => `<button class="btn" data-go="${esc(ctx.partRef)}-${esc(g.code)}">${esc(g.name)}</button>`).join('')}</div></div>`;
}

function renderItem() {
  const ctx = state.ctx;
  const v = $('#v-item');
  const entry = ctx.team && ctx.canWrite
    ? `<button class="btn primary big entry-btn" id="btn-entry">＋ Nhập sản lượng · ${esc(ctx.team.name)}</button>` : '';
  const transfer = canTransfer() && (ctx.part.level || '').toUpperCase() === 'CT'
    ? `<button class="btn" data-transfer="${esc(ctx.partRef)}" style="width:100%">Chuyển chi tiết này sang LSX khác…</button>` : '';
  v.innerHTML = backBar(ctx)
    + summaryCard(ctx)
    + parentCards(ctx)
    + (ctx.team ? '' : teamPicker(ctx))
    + incomingCard(ctx)
    + palletBlocks(ctx)
    + entry
    + logCard(ctx)
    + transfer;
  bindCommon(v);
  bindHandover(v, () => openCode(ctx.code, false));
  $('#btn-entry', v)?.addEventListener('click', () => openEntry(ctx));
  $$('[data-close]', v).forEach((b) => b.addEventListener('click', () => palletAction(b.dataset.close, 'close')));
  $$('[data-reopen]', v).forEach((b) => b.addEventListener('click', () => palletAction(b.dataset.reopen, 'reopen')));
  $$('[data-cancel]', v).forEach((b) => b.addEventListener('click', () => cancelLog(b.dataset.cancel)));
  $('[data-transfer]', v)?.addEventListener('click', (e) => goTab('transfer', `&ref=${encodeURIComponent(e.currentTarget.dataset.transfer)}`));
}

/* ================= Pop-up nhập sản lượng: 1 Chọn pallet → 2 Nhập → 3 Xác nhận ================= */

const MAX_QTY = 100000;
const palletKey = (ctx) => `pallet:${ctx.code}`;

function openEntry(ctx) {
  const open = ctx.pallets.filter((p) => p.state === 'open');
  const last = store.get(palletKey(ctx), '');
  state.entry = {
    ctx, step: 1,
    pallet: open.some((p) => p.id === last) ? last : (open[0]?.id || 'new'),
    np: { no: String(ctx.pallets.length + 1), lot_go: '', lot_dau: '' },
    date: ctx.today, worker: store.get('worker', ''), note: '',
    vals: {}, serverWarnings: null, busy: false, fill: null,
  };
  renderEntry();
  $('#entry').showModal();
}

function entryHead(title, step) {
  return `<header class="sheet-head">
    <button type="button" class="link sheet-x" data-ex="close" aria-label="Đóng">✕</button>
    <div class="grow"><div class="sheet-title">${title}</div>
      <div class="steps-dots">${[1, 2, 3].map((i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}<span>Bước ${step}/3</span></div></div>
  </header>`;
}

function palletLabel(e) {
  if (e.pallet === 'new') return `Pallet mới ${esc(e.np.no)}`;
  const p = e.ctx.pallets.find((x) => x.id === e.pallet);
  return `Pallet ${esc(p?.no)}`;
}

function renderEntry() {
  const e = state.entry;
  const d = $('#entry');
  const { ctx } = e;
  const s = e.step;
  let body = '';
  let foot = '';
  if (s === 1) {
    const open = ctx.pallets.filter((p) => p.state === 'open');
    body = `<p class="small muted">Chọn pallet đang làm tại ${esc(ctx.team.name)}, hoặc tạo pallet mới.</p>
      <div class="pick-list">
        ${open.map((p) => `<label class="pick${e.pallet === p.id ? ' on' : ''}"><input type="radio" name="ep" value="${esc(p.id)}" ${e.pallet === p.id ? 'checked' : ''}>
          <span><b>Pallet ${esc(p.no)}</b>${p.returned ? ' <span class="badge warn">Bị trả lại</span>' : ''}
          <small>${Object.values(p.perStep).length ? `${fmt(p.qty)} đã ghi` : 'Chưa ghi'}${p.qtyIn ? ` · nhận vào ${fmt(p.qtyIn)}` : ''}${p.lot_go ? ` · lô ${esc(p.lot_go)}` : ''}</small></span></label>`).join('')}
        <label class="pick${e.pallet === 'new' ? ' on' : ''}"><input type="radio" name="ep" value="new" ${e.pallet === 'new' ? 'checked' : ''}>
          <span><b>＋ Pallet mới</b><small>Tạo pallet mới tại tổ</small></span></label>
      </div>
      <div id="ep-new" class="grid3" ${e.pallet === 'new' ? '' : 'hidden'}>
        <label class="field">Số pallet *<input id="np-no" value="${esc(e.np.no)}" maxlength="30"></label>
        <label class="field">Mã lô gỗ<input id="np-lotgo" value="${esc(e.np.lot_go)}" maxlength="50"></label>
        <label class="field">Mã lô dầu<input id="np-lotdau" value="${esc(e.np.lot_dau)}" maxlength="50"></label>
      </div>
      <p class="msg" id="ex-msg" role="alert"></p>`;
    foot = '<button type="button" class="btn" data-ex="close">Huỷ</button><button type="button" class="btn primary grow" data-ex="next1">Tiếp: nhập số lượng →</button>';
  } else if (s === 2) {
    const ng = ctx.hasNg;
    body = `<div class="ex-ctx small"><b>${palletLabel(e)}</b> · ${esc(ctx.part.name)} · ${esc(ctx.team.name)}</div>
      <div class="grid2">
        <label class="field">Ngày làm<input type="date" id="ex-date" value="${esc(e.date)}" max="${esc(ctx.today)}"></label>
        <label class="field">Người / nhóm làm<input id="ex-worker" maxlength="100" value="${esc(e.worker)}" placeholder="Không bắt buộc"></label>
      </div>
      ${ctx.teamSteps.length > 1 ? `<div class="fill"><input type="number" id="ex-fill" inputmode="numeric" min="0" placeholder="Cùng 1 SL cho mọi công đoạn"><button type="button" class="btn sm" data-ex="fill">Điền tất cả</button></div>` : ''}
      <div class="erows${ng ? ' ng' : ''}">
        <div class="erow head"><span>Công đoạn</span><span>SL đạt</span>${ng ? '<span>NG</span>' : ''}</div>
        ${ctx.teamSteps.map((st) => {
          const v = e.vals[st.id] || {};
          const remain = Math.max(0, st.required - st.done);
          return `<div class="erow" data-step="${esc(st.id)}">
            <div class="einfo"><b>${st.no}. ${esc(st.stage)}</b>
              <small>Đã ${fmt(st.done)}/${fmt(st.required)} · còn ${fmt(remain)}</small>
              ${st.prevStage ? `<small>CĐ trước ${esc(st.prevStage)}: ${fmt(st.prevDone)}</small>` : ''}</div>
            <input type="number" class="eq" inputmode="numeric" min="0" step="1" placeholder="0" value="${v.qty ?? ''}" aria-label="SL đạt ${esc(st.stage)}">
            ${ng ? `<input type="number" class="en" inputmode="numeric" min="0" step="1" placeholder="0" value="${v.ng ?? ''}" aria-label="NG ${esc(st.stage)}">` : ''}
          </div>`;
        }).join('')}
      </div>
      <label class="field" style="margin-top:10px">Ghi chú<input id="ex-note" maxlength="300" value="${esc(e.note)}" placeholder="Không bắt buộc"></label>
      <p class="msg" id="ex-msg" role="alert"></p>`;
    foot = '<button type="button" class="btn" data-ex="back">← Pallet</button><button type="button" class="btn primary grow" data-ex="next2">Kiểm tra →</button>';
  } else {
    const own = entryRows(e);
    const skips = skipRows(e, own);
    const rows = e.fill === true ? [...own, ...skips].sort((a, b) => a.st.no - b.st.no) : own;
    const { warnings, errors } = checkEntry(e, rows);
    const all = [...warnings, ...(e.serverWarnings || [])].filter((w, i, a) => a.indexOf(w) === i);
    const needFill = skips.length > 0 && e.fill === null;
    body = `<div class="ex-ctx small"><b>${palletLabel(e)}</b> · ${esc(ctx.part.name)} · ${esc(ctx.team.name)}</div>
      <table class="tbl confirm"><tbody>
        <tr><th>Ngày làm</th><td>${esc(fmtDate(e.date))}${e.date !== ctx.today ? ' <span class="badge warn">nhập lùi</span>' : ''}</td></tr>
        ${e.worker ? `<tr><th>Người làm</th><td>${esc(e.worker)}</td></tr>` : ''}
        ${rows.map((r) => `<tr${r.auto ? ' class="auto"' : ''}><th>${esc(r.st.stage)}</th><td><b>${fmt(r.qty)}</b>${r.ng ? ` · NG ${fmt(r.ng)}` : ''}${r.auto ? ' <span class="badge">bù</span>' : ''} <span class="small muted">→ tổng ${fmt(r.st.done + r.qty)}/${fmt(r.st.required)}</span></td></tr>`).join('')}
        ${e.note ? `<tr><th>Ghi chú</th><td>${esc(e.note)}</td></tr>` : ''}
      </tbody></table>
      ${skips.length ? `<div class="ex-skip">
        <b>⚠ Nhập nhảy cóc – bỏ qua ${skips.length} công đoạn</b>
        <p class="small">Pallet này có công đoạn sau nhiều hơn công đoạn trước chưa nhập:</p>
        <ul>${skips.map((r) => `<li><b>${esc(r.st.stage)}</b>: thiếu ${fmt(r.qty)}</li>`).join('')}</ul>
        <p class="small">Ghi luôn số lượng này cho các công đoạn bị bỏ qua?</p>
        <div class="seg2">
          <label class="pick${e.fill === true ? ' on' : ''}"><input type="radio" name="ex-fill" value="1" ${e.fill === true ? 'checked' : ''}><span><b>Đồng ý ghi bù</b><small>Thêm ${skips.length} dòng, ghi chú "Bù CĐ bỏ qua"</small></span></label>
          <label class="pick${e.fill === false ? ' on' : ''}"><input type="radio" name="ex-fill" value="0" ${e.fill === false ? 'checked' : ''}><span><b>Không</b><small>Chỉ lưu số đã nhập</small></span></label>
        </div>
      </div>` : ''}
      ${errors.length ? `<div class="ex-err"><b>Không lưu được:</b><ul>${errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${all.length ? `<div class="ex-warn"><b>Cảnh báo – kiểm tra lại:</b><ul>${all.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <label class="ack"><input type="checkbox" id="ex-ack"> Tôi đã kiểm tra, số liệu đúng</label></div>`
        : (errors.length ? '' : '<div class="ex-ok">✓ Số liệu hợp lệ</div>')}
      <p class="msg" id="ex-msg" role="alert"></p>`;
    foot = `<button type="button" class="btn" data-ex="back">← Sửa</button>
      <button type="button" class="btn primary grow" data-ex="save" ${errors.length || all.length || needFill ? 'disabled' : ''}>${e.busy ? 'Đang lưu…' : needFill ? 'Chọn ghi bù hay không' : 'Lưu sản lượng'}</button>`;
    e.needAck = all.length > 0;
    e.hasError = errors.length > 0 || needFill;
  }
  const titles = { 1: 'Chọn pallet', 2: 'Nhập số lượng', 3: 'Xác nhận trước khi lưu' };
  d.innerHTML = `<form method="dialog" class="sheet" onsubmit="return false">${entryHead(titles[s], s)}<div class="sheet-body">${body}</div><footer class="sheet-foot">${foot}</footer></form>`;
  bindEntry(d);
}

/** Đọc các ô nhập ở bước 2 vào state. */
function readStep2(d) {
  const e = state.entry;
  e.date = $('#ex-date', d).value;
  e.worker = $('#ex-worker', d).value.trim();
  e.note = $('#ex-note', d).value.trim();
  for (const row of $$('.erow[data-step]', d)) {
    const q = $('.eq', row).value.trim();
    const n = $('.en', row)?.value.trim() ?? '';
    e.vals[row.dataset.step] = { qty: q, ng: n };
  }
}

function entryRows(e) {
  return e.ctx.teamSteps.map((st) => {
    const v = e.vals[st.id] || {};
    return { st, qtyRaw: v.qty ?? '', ngRaw: v.ng ?? '', qty: Number(v.qty || 0), ng: Number(v.ng || 0) };
  }).filter((r) => r.qtyRaw !== '' || r.ngRaw !== '');
}

/**
 * Công đoạn trong tổ bị bỏ trống nằm trước công đoạn có nhập (nhảy cóc) → SL cần ghi bù.
 * Cùng thuật toán với skipFill ở api/output.js (server tính lại khi lưu).
 */
function skipRows(e, rows) {
  const per = e.ctx.pallets.find((p) => p.id === e.pallet)?.perStep || {};
  const got = new Map(rows.filter((r) => r.qty > 0 || r.ng > 0).map((r) => [r.st.id, r.qty]));
  const out = [];
  let need = 0;
  for (const st of [...e.ctx.teamSteps].reverse()) {
    const cur = (per[st.id] || 0) + (got.get(st.id) || 0);
    if (got.has(st.id)) need = Math.max(need, cur);
    else if (need > cur) out.unshift({ st, qty: need - cur, ng: 0, qtyRaw: String(need - cur), ngRaw: '', auto: true });
  }
  return out;
}

/** Lỗi (chặn lưu) và cảnh báo (cần tick xác nhận). Server kiểm tra lại toàn bộ. */
function checkEntry(e, rows) {
  const { ctx } = e;
  const errors = [];
  const warnings = [];
  const isInt = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_QTY;
  for (const r of rows) {
    if (!isInt(r.qty)) errors.push(`${r.st.stage}: SL đạt phải là số nguyên từ 0 đến ${fmt(MAX_QTY)}`);
    if (!isInt(r.ng)) errors.push(`${r.st.stage}: NG phải là số nguyên từ 0 đến ${fmt(MAX_QTY)}`);
  }
  const used = rows.filter((r) => r.qty > 0 || r.ng > 0);
  if (!used.length) errors.push('Chưa nhập số lượng cho công đoạn nào');
  if (!e.date) errors.push('Chọn ngày làm');
  else if (e.date > ctx.today) errors.push('Ngày làm không được ở tương lai');
  else {
    const back = Math.round((new Date(ctx.today) - new Date(e.date)) / 864e5);
    if (back > 7 && !state.user?.admin) errors.push(`Chỉ được nhập lùi tối đa 7 ngày (đang lùi ${back} ngày)`);
    else if (back > 0) warnings.push(`Nhập lùi ${back} ngày (ngày ${fmtDate(e.date)})`);
  }
  if (e.pallet === 'new') {
    const no = e.np.no.trim();
    if (!no) errors.push('Nhập số pallet mới');
    if (ctx.pallets.some((p) => String(p.no).trim().toLowerCase() === no.toLowerCase())) errors.push(`Pallet "${no}" đã có – hãy chọn trong danh sách`);
  }
  const batch = new Map(used.map((r) => [r.st.id, r.qty]));
  const pal = ctx.pallets.find((p) => p.id === e.pallet);
  for (const r of used) {
    const total = r.st.done + r.qty;
    if (r.st.required && total > r.st.required) warnings.push(`${r.st.stage}: tổng sau khi nhập ${fmt(total)} > SL cần ${fmt(r.st.required)}`);
    if (r.st.prevId && r.qty) {
      const avail = (r.st.prevDone || 0) + (batch.get(r.st.prevId) || 0);
      if (total > avail) warnings.push(`${r.st.stage}: tổng ${fmt(total)} > công đoạn trước "${r.st.prevStage}" (${fmt(avail)})`);
    }
    if (pal?.qtyIn && (pal.perStep[r.st.id] || 0) + r.qty > pal.qtyIn) warnings.push(`${r.st.stage}: pallet sẽ có ${fmt((pal.perStep[r.st.id] || 0) + r.qty)} > SL nhận vào pallet ${fmt(pal.qtyIn)}`);
    if (r.ng && r.ng > r.qty) warnings.push(`${r.st.stage}: NG (${fmt(r.ng)}) nhiều hơn SL đạt (${fmt(r.qty)})`);
  }
  // Công đoạn sau nhiều hơn công đoạn trước trong cùng lần nhập (dòng ghi bù chỉ là phần thiếu → không so)
  for (let i = 1; i < used.length; i++) {
    if (used[i].auto || used[i - 1].auto) continue;
    if (used[i].qty > used[i - 1].qty && used[i].st.prevId === used[i - 1].st.id) {
      warnings.push(`${used[i].st.stage} (${fmt(used[i].qty)}) nhiều hơn ${used[i - 1].st.stage} (${fmt(used[i - 1].qty)}) trong cùng lần nhập`);
    }
  }
  return { errors, warnings: [...new Set(warnings)] };
}

function bindEntry(d) {
  const e = state.entry;
  const msg = (t) => { const m = $('#ex-msg', d); if (m) m.textContent = t; };
  $$('input[name="ep"]', d).forEach((r) => r.addEventListener('change', () => {
    e.pallet = r.value;
    $$('.pick', d).forEach((l) => l.classList.toggle('on', $('input', l).checked));
    $('#ep-new', d).hidden = e.pallet !== 'new';
  }));
  $('#ex-ack', d)?.addEventListener('change', (ev) => { $('[data-ex="save"]', d).disabled = !ev.target.checked || e.hasError; });
  $$('input[name="ex-fill"]', d).forEach((r) => r.addEventListener('change', () => {
    e.fill = r.value === '1';
    e.serverWarnings = null;
    renderEntry();
  }));
  $$('[data-ex]', d).forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.ex;
    if (a === 'close') { d.close(); return; }
    if (a === 'next1') {
      if (e.pallet === 'new') {
        e.np = { no: $('#np-no', d).value.trim(), lot_go: $('#np-lotgo', d).value.trim(), lot_dau: $('#np-lotdau', d).value.trim() };
        if (!e.np.no) return msg('Nhập số pallet mới');
        if (e.ctx.pallets.some((p) => String(p.no).trim().toLowerCase() === e.np.no.toLowerCase())) return msg(`Pallet "${e.np.no}" đã có – hãy chọn trong danh sách`);
      }
      e.step = 2; renderEntry(); $('.eq', d)?.focus(); return;
    }
    if (a === 'fill') {
      const q = $('#ex-fill', d).value;
      $$('.eq', d).forEach((i) => { i.value = q; });
      return;
    }
    if (a === 'next2') {
      readStep2(d);
      const rows = entryRows(e);
      const bad = rows.find((r) => !Number.isInteger(r.qty) || r.qty < 0 || !Number.isInteger(r.ng) || r.ng < 0);
      if (bad) return msg(`${bad.st.stage}: số lượng phải là số nguyên ≥ 0`);
      if (!rows.some((r) => r.qty > 0 || r.ng > 0)) return msg('Nhập số lượng cho ít nhất 1 công đoạn');
      e.serverWarnings = null;
      e.fill = null;
      e.step = 3; renderEntry(); return;
    }
    if (a === 'back') { e.step -= 1; renderEntry(); return; }
    if (a === 'save') saveEntry(d);
  }));
}

async function saveEntry(d) {
  const e = state.entry;
  if (e.busy) return;
  const { ctx } = e;
  const rows = entryRows(e).filter((r) => r.qty > 0 || r.ng > 0);
  const body = {
    action: 'add', code: ctx.code, work_date: e.date, worker: e.worker, note: e.note,
    entries: rows.map((r) => ({ id: r.st.id, qty: r.qty, ng: r.ng })),
    confirm: !!e.needAck, // người dùng đã tick "đã kiểm tra" cho các cảnh báo
    fill_skipped: e.fill === true, // đồng ý ghi bù các công đoạn bị bỏ qua (server tự tính lại)
  };
  if (e.pallet === 'new') body.new_pallet = e.np; else body.pallet_id = e.pallet;
  e.busy = true;
  const btn = $('[data-ex="save"]', d);
  btn.disabled = true; btn.textContent = 'Đang lưu…';
  try {
    const r = await api('/api/output', { method: 'POST', body });
    e.busy = false;
    if (r.status === 409) { // server thấy cảnh báo mà máy chưa thấy → bắt xác nhận lại
      e.serverWarnings = r.warnings;
      renderEntry();
      return;
    }
    store.set('worker', e.worker);
    const id = body.pallet_id || r.context.pallets.find((p) => p.no === e.np.no)?.id;
    if (id) store.set(palletKey(r.context), id);
    state.ctx = r.context;
    d.close();
    renderItem();
    const filled = e.fill === true ? skipRows(e, rows).length : 0;
    toast(`Đã lưu ${palletLabel(e).replace(/&[^;]+;/g, '')}: ${rows.map((x) => `${x.st.stage} ${fmt(x.qty)}`).join(', ')}${filled ? ` (+ bù ${filled} CĐ bỏ qua)` : ''}`);
  } catch (err) {
    e.busy = false;
    if (err.status === 401) { d.close(); return; }
    btn.disabled = false; btn.textContent = 'Lưu sản lượng';
    $('#ex-msg', d).textContent = err.message;
  }
}

async function palletAction(id, action) {
  const p = state.ctx.pallets.find((x) => x.id === id);
  const ok = await ask(
    action === 'close' ? 'Hoàn thành pallet?' : 'Mở lại pallet?',
    action === 'close'
      ? `<p>Pallet <b>${esc(p?.no)}</b> đã xong công đoạn cuối, sẽ ra khỏi chuyền.</p>`
      : `<p>Pallet <b>${esc(p?.no)}</b> trở về trạng thái Đang làm tại tổ này.</p>`,
  );
  if (!ok) return;
  try {
    const r = await api('/api/pallet', { method: 'POST', body: { code: state.ctx.code, pallet_id: id, action } });
    state.ctx = r.context;
    state.pallet = null;
    renderItem();
    toast(action === 'close' ? 'Đã hoàn thành pallet' : 'Đã mở lại pallet');
  } catch (e) { if (e.status !== 401) toast(e.message, true); }
}

async function cancelLog(id) {
  const l = state.ctx.logs.find((x) => x.id === id);
  const ok = await ask('Huỷ dòng sản lượng?', `<p><b>${esc(l?.stage)}</b> · ${fmt(l?.qty)} · ngày ${esc(l?.date)}</p>
    <p class="small muted">Hệ thống ghi thêm 1 dòng âm để giữ lịch sử, không xoá dòng cũ.</p>`, 'Huỷ dòng này');
  if (!ok) return;
  try {
    const r = await api('/api/output', { method: 'POST', body: { action: 'cancel', code: state.ctx.code, log_id: id } });
    state.ctx = r.context;
    renderItem();
    toast('Đã huỷ');
  } catch (e) { if (e.status !== 401) toast(e.message, true); }
}

/* ---------------- Khởi động ---------------- */

(async function boot() {
  try {
    const r = await api('/api/auth');
    state.clientId = r.clientId;
    if (r.user) { setUser(r.user); route(); } else showLogin(r.error || '');
  } catch (e) {
    show('v-login');
    $('#login-msg').textContent = `Không kết nối được máy chủ: ${e.message}`;
  }
})();

/* ---------------- Cài app (PWA) ---------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => {});
  installEvt = null;
  $('#btn-install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; });
