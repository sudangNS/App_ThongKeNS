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

function progressList(items) {
  return `<ul class="list">${items.map((c) => `<li>
    <div class="row gap"><span class="grow">${esc(c.name)} <span class="small muted">${esc(c.kind || c.level)}</span></span>
      <span class="small">${fmt(c.done)}/${fmt(c.required)}</span></div>
    <div class="small muted">Công đoạn cuối: ${esc(c.lastStage)}</div>
    <div class="bar"><i style="width:${pct(c.done, c.required)}%"></i></div>
  </li>`).join('')}</ul>`;
}

function infoCard(ctx) {
  const { part, cum, product } = ctx;
  const teamCode = ctx.team?.code;
  const isCum = (part.level || '').toUpperCase() === 'CUM';
  const isSP = (part.level || '').toUpperCase() === 'SP';
  return `<div class="card">
    <div class="sec">
      <div class="sec-label">${isSP ? 'Thành phẩm' : isCum ? 'Cụm' : 'Chi tiết'}</div>
      <p class="title">${esc(part.name)} <span class="badge">${esc(part.kind)}</span></p>
      <div class="code">${esc(part.ref)}</div>
      <dl class="kv">
        ${part.code ? `<dt>Mã</dt><dd>${esc(part.code)}</dd>` : ''}
        ${part.size ? `<dt>Kích thước</dt><dd>${esc(part.size)}</dd>` : ''}
        ${part.material ? `<dt>NVL</dt><dd>${esc(part.material)}${part.glue ? ` · ghép ${esc(part.glue)}` : ''}</dd>` : ''}
        <dt>SL / SP</dt><dd>${fmt(part.qty_per_unit)}</dd>
        <dt>SL cần</dt><dd>${fmt(part.qty_required)}</dd>
      </dl>
      <div class="route">${part.steps.map((s) => stepChip(s, s.team === teamCode)).join('')}</div>
    </div>
    ${cum && !isCum ? `<div class="sec">
      <div class="sec-label">Cụm</div>
      <p class="title" style="font-size:17px">${esc(cum.name)}</p>
      <dl class="kv">
        ${cum.code ? `<dt>Mã</dt><dd>${esc(cum.code)}</dd>` : ''}
        <dt>SL cần</dt><dd>${fmt(cum.qty_required)}</dd>
      </dl>
      <div class="route">${cum.steps.map((s) => stepChip(s, false)).join('')}</div>
      ${cum.children.length ? `<details><summary>${cum.children.length} chi tiết trong cụm</summary>${progressList(cum.children)}</details>` : ''}
    </div>` : ''}
    ${cum && isCum && cum.children.length ? `<div class="sec">
      <details><summary>${cum.children.length} chi tiết trong cụm</summary>${progressList(cum.children)}</details>
    </div>` : ''}
    ${!cum && !isSP ? '<div class="sec"><div class="sec-label">Cụm</div><div class="muted">Chi tiết rời (ráp thẳng vào sản phẩm)</div></div>' : ''}
    <div class="sec">
      <div class="sec-label">Sản phẩm</div>
      <p class="title" style="font-size:17px">${esc(product.name)}</p>
      ${product.name_vi ? `<div class="muted">${esc(product.name_vi)}</div>` : ''}
      <dl class="kv">
        <dt>LSX</dt><dd>${esc(product.mo_no)}${product.lsx_stt ? ` · dòng ${esc(product.lsx_stt)}` : ''}</dd>
        ${product.customer ? `<dt>Khách</dt><dd>${esc(product.customer)}</dd>` : ''}
        ${product.code ? `<dt>Mã SP</dt><dd>${esc(product.code)}${product.bom_code ? ` · ${esc(product.bom_code)}` : ''}</dd>` : ''}
        <dt>SL</dt><dd>${fmt(product.qty)} ${esc(product.unit)}</dd>
        ${product.due_date ? `<dt>Hạn giao</dt><dd>${esc(fmtDate(product.due_date))}</dd>` : ''}
        ${product.wood ? `<dt>Gỗ</dt><dd>${esc(product.wood)}${product.color ? ` · màu ${esc(product.color)}` : ''}</dd>` : ''}
      </dl>
      ${!isSP && product.steps.length ? `<div class="route">${product.steps.map((s) => stepChip(s, false)).join('')}</div>` : ''}
      ${isSP && ctx.spChildren.length ? `<details><summary>${ctx.spChildren.length} cụm / chi tiết rời</summary>${progressList(ctx.spChildren)}</details>` : ''}
    </div>
  </div>`;
}

/* ---------------- Nhập sản lượng ---------------- */

const palletKey = (ctx) => `pallet:${ctx.code}`;

function defaultPallet(ctx) {
  const open = ctx.pallets.filter((p) => !p.closed);
  const last = store.get(palletKey(ctx), '');
  if (open.some((p) => p.id === last)) return last;
  return open[0]?.id || 'new';
}

function formCard(ctx) {
  if (!ctx.team) {
    return `<div class="card"><h2>Chọn tổ để nhập sản lượng</h2>
      <p class="muted small">Mã quét không có hậu tố tổ. Chọn tổ:</p>
      <div class="row gap wrap">${ctx.groups.map((g) => `<button class="btn" data-go="${esc(ctx.partRef)}-${esc(g.code)}">${esc(g.name)}</button>`).join('')}</div></div>`;
  }
  // Tổ trưởng / người xem: chỉ hiện thông tin, không có khung nhập
  if (!ctx.canWrite) return '';
  const sel = state.pallet || defaultPallet(ctx);
  state.pallet = sel;
  const open = ctx.pallets.filter((p) => !p.closed);
  const ng = ctx.hasNg;
  const head = `<div class="step-head${ng ? ' ng' : ''}"><span></span><span>Công đoạn</span><span>SL đạt</span>${ng ? '<span>NG</span>' : ''}</div>`;
  const steps = ctx.teamSteps.map((s) => {
    const remain = Math.max(0, s.required - s.done);
    const over = s.required && s.done > s.required;
    return `<div class="step${ng ? ' ng' : ''}" data-step="${esc(s.id)}">
      <input type="checkbox" class="pick" aria-label="Chọn ${esc(s.stage)}" ${ctx.teamSteps.length === 1 ? 'checked' : ''}>
      <div>
        <div class="name">${s.no}. ${esc(s.stage)}</div>
        <div class="meta">Đã ${fmt(s.done)}/${fmt(s.required)} · còn ${fmt(remain)}${s.ng ? ` · NG ${fmt(s.ng)}` : ''}</div>
        ${s.prevStage ? `<div class="meta">CĐ trước (${esc(s.prevStage)}): ${fmt(s.prevDone)}</div>` : ''}
        <div class="bar${over ? ' over' : ''}"><i style="width:${pct(s.done, s.required)}%"></i></div>
      </div>
      <input type="number" class="qty" inputmode="numeric" min="0" step="1" placeholder="0" aria-label="Số lượng đạt ${esc(s.stage)}">
      ${ng ? `<input type="number" class="ng-in" inputmode="numeric" min="0" step="1" placeholder="0" aria-label="Số lượng NG ${esc(s.stage)}">` : ''}
    </div>`;
  }).join('');
  const nextNo = String(ctx.pallets.length + 1);

  return `<div class="card" id="form-card">
    <h2>Nhập sản lượng · ${esc(ctx.team.name)}</h2>
    <div class="sec-label">Pallet</div>
    <div class="pallets" role="group" aria-label="Chọn pallet">
      ${open.map((p) => `<button type="button" class="pchip" data-pallet="${esc(p.id)}" aria-pressed="${p.id === sel}">
        Pallet ${esc(p.no)}<small>${fmt(p.qty)} đã ghi${p.lot_go ? ` · lô ${esc(p.lot_go)}` : ''}</small></button>`).join('')}
      <button type="button" class="pchip" data-pallet="new" aria-pressed="${sel === 'new'}">+ Pallet mới</button>
    </div>
    <div id="new-pallet" ${sel === 'new' ? '' : 'hidden'}>
      <div class="grid3">
        <label class="field">Số pallet<input id="np-no" value="${esc(nextNo)}" maxlength="30"></label>
        <label class="field">Mã lô gỗ<input id="np-lotgo" maxlength="50"></label>
        <label class="field">Mã lô dầu<input id="np-lotdau" maxlength="50"></label>
      </div>
    </div>

    <div class="grid2">
      <label class="field">Ngày làm<input type="date" id="f-date" value="${esc(ctx.today)}" max="${esc(ctx.today)}"></label>
      <label class="field">Người / nhóm làm<input id="f-worker" maxlength="100" value="${esc(store.get('worker', ''))}" placeholder="Không bắt buộc"></label>
    </div>

    <h3>Công đoạn tại tổ (tick 1 hoặc nhiều)</h3>
    ${ctx.teamSteps.length > 1 ? `<div class="fill">
      <input type="number" id="fill-qty" inputmode="numeric" min="0" placeholder="SL chung" aria-label="Số lượng chung">
      <button type="button" class="btn sm" id="btn-fill">Điền cho CĐ đã tick</button>
      <button type="button" class="btn sm" id="btn-all">Tick tất cả</button>
    </div>` : ''}
    <div class="steps">${head}${steps}</div>

    <label class="field" style="margin-top:10px">Ghi chú<input id="f-note" maxlength="300" placeholder="Không bắt buộc"></label>
    <p id="f-msg" class="msg" role="alert"></p>
    <button type="button" class="btn primary big" id="btn-save" style="margin-top:10px">Lưu sản lượng</button>
  </div>`;
}

const statusBadge = (status, state) => {
  const cls = state === 'waiting' ? ' warn' : state === 'open' ? '' : ' off';
  return `<span class="badge${cls}">${esc(status || 'Đang làm')}</span>`;
};

function palletCard(ctx) {
  if (!ctx.team || !ctx.pallets.length) return '';
  const stage = new Map(ctx.teamSteps.map((s) => [s.id, s.stage]));
  return `<div class="card"><h2>Pallet của chi tiết tại tổ</h2><ul class="list">
    ${ctx.pallets.map((p) => `<li>
      <div class="row gap">
        <b class="grow">Pallet ${esc(p.no)}</b>
        ${statusBadge(p.status, p.state)}
      </div>
      <div class="small muted">${Object.entries(p.perStep).map(([id, q]) => `${esc(stage.get(id) || id)}: ${fmt(q)}`).join(' · ') || 'Chưa ghi sản lượng'}</div>
      ${p.qtyIn ? `<div class="small muted">Nhận từ tổ trước: ${fmt(p.qtyIn)}</div>` : ''}
      ${p.dest ? `<div class="small">Giao tới: <b>${esc(p.dest.teamName)}</b> · ${esc(p.dest.stage)}${p.dest.kind === 'parent' ? ` (${esc(p.dest.partName)})` : ''} · SL giao ${fmt(p.qtyOut)}</div>` : ''}
      ${p.state === 'waiting' ? `<div class="small muted">Đã giao ${esc(p.delivered_at)}, chờ ${esc(p.dest?.teamName || 'tổ sau')} nhận</div>` : ''}
      ${p.returned ? `<div class="notice small" style="margin-top:6px">${esc(p.note)}</div>` : ''}
      <div class="small muted">${p.lot_go ? `Lô gỗ ${esc(p.lot_go)} · ` : ''}${p.lot_dau ? `Lô dầu ${esc(p.lot_dau)} · ` : ''}Tạo ${esc(p.created_at)}</div>
      <div class="row gap wrap" style="margin-top:6px">
        ${p.canDeliver ? `<button class="btn sm primary" data-deliver="${esc(p.id)}" data-q="${p.qtyOut}" data-to="${esc(p.dest.teamName)}">Giao ${fmt(p.qtyOut)} cho ${esc(p.dest.teamName)}</button>` : ''}
        ${ctx.canLead && p.state === 'open' && p.dest && !p.qtyOut ? `<span class="small muted">Chưa có SL ở “${esc(p.exitStage)}” để giao</span>` : ''}
        ${p.canFinish ? `<button class="btn sm" data-close="${esc(p.id)}">Hoàn thành pallet</button>` : ''}
        ${p.closed && state.user?.admin ? `<button class="btn sm" data-reopen="${esc(p.id)}">Mở lại</button>` : ''}
      </div>
    </li>`).join('')}
  </ul></div>`;
}

function incomingCard(ctx) {
  if (!ctx.incoming?.length) return '';
  return `<div class="card attn"><h2>Chờ ${esc(ctx.team.name)} nhận (${ctx.incoming.length})</h2>
    <ul class="list">${ctx.incoming.map((f) => palletItem(f, { receive: f.canReceive })).join('')}</ul></div>`;
}

function logCard(ctx) {
  if (!ctx.team) return '';
  if (!ctx.logs.length) return '<div class="card"><h2>Nhật ký</h2><p class="muted">Chưa có ghi nhận nào cho chi tiết này tại tổ.</p></div>';
  return `<div class="card"><h2>Nhật ký gần đây</h2><ul class="list">
    ${ctx.logs.map((l) => `<li class="log${l.cancelled ? ' cancelled' : ''}${l.reversal ? ' reversal' : ''}">
      <div class="what"><b>${esc(l.stage)}</b> · Pallet ${esc(l.pallet_no || '?')}</div>
      <div class="q">${fmt(l.qty)}${l.ng ? ` <span class="small" style="color:var(--bad)">NG ${fmt(l.ng)}</span>` : ''}</div>
      <div class="small muted">Ngày ${esc(l.date)}${l.worker ? ` · ${esc(l.worker)}` : ''} · ${esc(l.by)} · ${esc(l.at)}${l.note ? `<br>${esc(l.note)}` : ''}${l.cancelled ? '<br><b>Đã huỷ</b>' : ''}</div>
      <div>${l.canCancel ? `<button class="btn sm danger" data-cancel="${esc(l.id)}">Huỷ</button>` : ''}</div>
    </li>`).join('')}
  </ul></div>`;
}

function renderItem() {
  const ctx = state.ctx;
  const v = $('#v-item');
  const transfer = canTransfer() && (ctx.part.level || '').toUpperCase() === 'CT'
    ? `<div class="card"><button class="btn" data-transfer="${esc(ctx.partRef)}">Chuyển chi tiết này sang LSX khác…</button></div>` : '';
  v.innerHTML = backBar(ctx) + incomingCard(ctx) + formCard(ctx) + infoCard(ctx) + palletCard(ctx) + logCard(ctx) + transfer;
  bindCommon(v);
  bindForm(v, ctx);
  bindHandover(v, () => openCode(ctx.code, false));
  $('[data-transfer]', v)?.addEventListener('click', (e) => goTab('transfer', `&ref=${encodeURIComponent(e.currentTarget.dataset.transfer)}`));
}

function bindForm(v, ctx) {
  $$('[data-pallet]', v).forEach((b) => b.addEventListener('click', () => {
    state.pallet = b.dataset.pallet;
    $$('[data-pallet]', v).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#new-pallet', v).hidden = state.pallet !== 'new';
  }));
  $$('.step', v).forEach((row) => {
    const pick = $('.pick', row);
    $$('input[type="number"]', row).forEach((inp) => inp.addEventListener('input', () => {
      if (Number(inp.value) > 0) pick.checked = true;
    }));
  });
  $('#btn-fill', v)?.addEventListener('click', () => {
    const q = $('#fill-qty', v).value;
    $$('.step', v).forEach((row) => { if ($('.pick', row).checked) $('.qty', row).value = q; });
  });
  $('#btn-all', v)?.addEventListener('click', () => {
    const all = $$('.step .pick', v);
    const target = !all.every((c) => c.checked);
    all.forEach((c) => { c.checked = target; });
  });
  $('#btn-save', v)?.addEventListener('click', () => save(v, ctx, false));
  $$('[data-close]', v).forEach((b) => b.addEventListener('click', () => palletAction(b.dataset.close, 'close')));
  $$('[data-reopen]', v).forEach((b) => b.addEventListener('click', () => palletAction(b.dataset.reopen, 'reopen')));
  $$('[data-cancel]', v).forEach((b) => b.addEventListener('click', () => cancelLog(b.dataset.cancel)));
}

function collect(v, ctx) {
  const entries = [];
  for (const row of $$('.step', v)) {
    if (!$('.pick', row).checked) continue;
    const qtyRaw = $('.qty', row).value.trim();
    const ngRaw = $('.ng-in', row)?.value.trim() || '';
    const qty = qtyRaw === '' ? 0 : Number(qtyRaw);
    const ng = ngRaw === '' ? 0 : Number(ngRaw);
    const s = ctx.teamSteps.find((x) => x.id === row.dataset.step);
    if (!Number.isInteger(qty) || qty < 0 || !Number.isInteger(ng) || ng < 0) throw new Error(`${s.stage}: số lượng phải là số nguyên ≥ 0`);
    if (qty || ng) entries.push({ id: s.id, stage: s.stage, qty, ng });
  }
  if (!entries.length) throw new Error('Tick công đoạn và nhập số lượng');
  const body = {
    action: 'add', code: ctx.code, entries: entries.map(({ id, qty, ng }) => ({ id, qty, ng })),
    work_date: $('#f-date', v).value, worker: $('#f-worker', v).value, note: $('#f-note', v).value,
  };
  if (state.pallet === 'new') {
    body.new_pallet = { no: $('#np-no', v).value, lot_go: $('#np-lotgo', v).value, lot_dau: $('#np-lotdau', v).value };
    if (!body.new_pallet.no.trim()) throw new Error('Nhập số pallet mới');
  } else body.pallet_id = state.pallet;
  return { body, entries };
}

async function save(v, ctx, confirm) {
  if (state.busy) return;
  const msg = $('#f-msg', v);
  msg.textContent = '';
  let req;
  try { req = collect(v, ctx); } catch (e) { msg.textContent = e.message; return; }
  req.body.confirm = confirm;
  const btn = $('#btn-save', v);
  state.busy = true;
  btn.disabled = true;
  btn.textContent = 'Đang lưu…';
  try {
    const r = await api('/api/output', { method: 'POST', body: req.body });
    if (r.status === 409) {
      state.busy = false;
      const ok = await ask('Kiểm tra lại số lượng', `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><p>Vẫn lưu?</p>`, 'Vẫn lưu');
      btn.disabled = false;
      btn.textContent = 'Lưu sản lượng';
      if (ok) return save(v, ctx, true);
      return;
    }
    store.set('worker', req.body.worker || '');
    const keepPallet = req.body.pallet_id;
    state.ctx = r.context;
    // Pallet vừa tạo: chọn lại theo số pallet
    const newId = keepPallet || r.context.pallets.find((p) => p.no === String(req.body.new_pallet?.no || '').trim())?.id;
    if (newId) store.set(palletKey(r.context), newId);
    state.pallet = null;
    renderItem();
    toast(`Đã lưu: ${req.entries.map((e) => `${e.stage} ${fmt(e.qty)}`).join(', ')}`);
  } catch (e) {
    if (e.status === 401) return;
    msg.textContent = e.message;
    btn.disabled = false;
    btn.textContent = 'Lưu sản lượng';
  } finally {
    state.busy = false;
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
