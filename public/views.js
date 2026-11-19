'use strict';
/* Các tab: Việc của tôi (giao nhận) · Trên chuyền · Sản lượng · Thêm · Chuyển LSX.
   Dùng chung tiện ích trong app.js ($, esc, fmt, api, ask, toast, show, goTab, …). */

const fmt3 = (n) => (Number(n) || 0).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const loading = (v) => { v.innerHTML = '<div class="center"><div class="spinner" aria-label="Đang tải"></div></div>'; };
const failBox = (e) => `<div class="card"><p class="msg">${esc(e.message)}</p></div>`;
const levelName = { CT: 'chi tiết', CUM: 'cụm', SP: 'SP' };

/* ---------------- Pallet (dùng chung) ---------------- */

/** 1 dòng pallet. opts: { deliver, receive } → hiện nút. */
function palletItem(f, opts = {}) {
  const age = f.ageDays >= 3 ? `<span class="badge warn">${f.ageDays} ngày</span>` : f.ageDays ? `<span class="small muted">${f.ageDays} ngày</span>` : '';
  return `<li class="pal">
    <button class="item" data-open="${esc(f.code)}">
      <div class="row gap">${lvTag(f.level)}<b class="grow">Pallet ${esc(f.no)} · ${esc(f.partName)}</b>${age}</div>
      <div class="small muted">${esc(f.moNo)}${f.lsxStt ? ` · dòng ${esc(f.lsxStt)}` : ''} · ${esc(f.product)}</div>
      <div class="small">${esc(f.teamName)} · ${esc(f.state === 'waiting' ? f.exitStage : f.stage)}
        ${f.dest ? ` → <b>${esc(f.dest.teamName)}</b>${f.dest.kind === 'parent' ? ` (${esc(f.dest.partName)})` : ''}` : ''}</div>
      <div class="small"><b>${fmt(f.state === 'waiting' ? f.qtyOut : f.pieces)}</b> ${levelName[f.level] || ''} · ${fmt3(f.m3)} m³
        ${f.state === 'waiting' ? ` · giao ${esc(f.delivered_at)}` : ''}</div>
      ${f.returned ? `<div class="notice small" style="margin-top:4px">${esc(f.note)}</div>` : ''}
    </button>
    ${opts.receive || opts.deliver ? `<div class="row gap wrap" style="margin-top:8px">
      ${opts.receive ? `<button class="btn sm primary" data-receive="${esc(f.id)}" data-q="${f.qtyOut}">Nhận đủ ${fmt(f.qtyOut)}</button>
        <button class="btn sm danger" data-return="${esc(f.id)}">Trả lại</button>` : ''}
      ${opts.deliver ? `<button class="btn sm primary" data-deliver="${esc(f.id)}" data-q="${f.qtyOut}" data-to="${esc(f.dest?.teamName || '')}">Giao ${fmt(f.qtyOut)} cho ${esc(f.dest?.teamName || '')}</button>` : ''}
    </div>` : ''}
  </li>`;
}

/** Gắn nút Giao / Nhận / Trả lại / mở mã trong `root`; `after(r)` chạy sau khi thao tác thành công. */
function bindHandover(root, after) {
  $$('[data-open]', root).forEach((b) => b.addEventListener('click', () => go(b.dataset.open, false)));
  $$('[data-deliver]', root).forEach((b) => b.addEventListener('click', async () => {
    const to = b.dataset.to || b.textContent.replace(/^.* cho /, '');
    if (!await ask('Giao pallet?', `<p>Giao <b>${fmt(b.dataset.q || '')}</b> cho <b>${esc(to)}</b>. Pallet sẽ khoá nhập cho tới khi tổ sau nhận hoặc trả lại.</p>`, 'Giao')) return;
    handover(b.dataset.deliver, 'deliver', '', after);
  }));
  $$('[data-receive]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!await ask('Nhận đủ pallet?', `<p>Xác nhận đã nhận đủ <b>${fmt(b.dataset.q)}</b>. Thiếu hoặc lỗi thì bấm <b>Trả lại</b>.</p>`, 'Nhận đủ')) return;
    handover(b.dataset.receive, 'receive', '', after);
  }));
  $$('[data-return]', root).forEach((b) => b.addEventListener('click', async () => {
    const ok = await ask('Trả lại pallet', `<p>Pallet về lại tổ giao để thống kê sửa số rồi giao lại.</p>
      <label class="field">Lý do (bắt buộc)<input id="ret-reason" maxlength="200" placeholder="VD: thiếu 5 cây, lỗi kích thước"></label>`, 'Trả lại');
    if (!ok) return;
    const reason = $('#ret-reason')?.value.trim() || '';
    if (reason.length < 3) return toast('Cần nhập lý do trả lại', true);
    handover(b.dataset.return, 'return', reason, after);
  }));
}

async function handover(id, action, reason, after) {
  try {
    const r = await api('/api/handover', { method: 'POST', body: { action, pallet_id: id, reason } });
    toast(r.message);
    setBadge(r.inboxCount);
    after?.(r);
  } catch (e) { if (e.status !== 401) toast(e.message, true); }
}

/* ---------------- Việc của tôi ---------------- */

async function showWork(data) {
  show('v-work');
  const v = $('#v-work');
  if (!data) {
    loading(v);
    try { data = await api('/api/handover'); } catch (e) { if (e.status !== 401) v.innerHTML = failBox(e); return; }
  }
  setBadge(data.inboxCount);
  const sec = (title, list, opts, empty) => `<div class="card${opts.attn && list.length ? ' attn' : ''}">
    <h2>${title} <span class="badge${list.length ? '' : ' off'}">${list.length}</span></h2>
    ${list.length ? `<ul class="list">${list.map((f) => palletItem(f, opts)).join('')}</ul>` : `<p class="muted small">${empty}</p>`}</div>`;
  const u = state.user;
  const parts = [];
  if (isLead()) {
    parts.push(sec('Cần nhận', data.inbox, { receive: true, attn: true }, 'Không có pallet nào chờ tổ bạn nhận.'));
    parts.push(sec('Cần giao', data.toDeliver, { deliver: true }, 'Chưa có pallet nào xong công đoạn ra tổ.'));
    parts.push(sec('Đã giao, chờ tổ sau nhận', data.sent, {}, 'Không có.'));
  }
  if (data.returned.length) parts.push(sec('Bị trả lại', data.returned, {}, ''));
  if (u.statTeams?.length && !u.admin) parts.push(sec('Pallet đang mở của tổ', data.open, {}, 'Không có pallet đang mở.'));
  if (!parts.length) parts.push('<div class="card"><p class="muted">Bạn không phụ trách tổ nào. Quyền tổ trưởng/thống kê cấp trong tab <b>To</b> của Sheet.</p></div>');
  v.innerHTML = `<h1 class="page-title">Việc của tôi</h1>${parts.join('')}`;
  bindHandover(v, (r) => showWork(r));
}

/* ---------------- Trên chuyền ---------------- */

const wipState = { team: store.get('wipTeam', ''), data: null };

const fmtQ = (n) => fmt(Math.round(Number(n) || 0));

function tiles(sum, pallets) {
  return `<div class="tiles">
    <div class="tile"><b>${fmt3(sum.m3)}</b><span>m³ gỗ tồn</span></div>
    <div class="tile"><b>${fmtQ(sum.ct)}</b><span>chi tiết</span></div>
    <div class="tile"><b>${fmtQ(sum.cum)}</b><span>cụm</span></div>
    <div class="tile"><b>${fmtQ(sum.sp)}</b><span>SP</span></div>
    <div class="tile"><b>${fmt(pallets)}</b><span>pallet mở</span></div>
  </div>`;
}

function wipItem(x) {
  const age = x.ageDays >= 3 ? `<span class="badge warn">${x.ageDays} ngày</span>` : x.ageDays ? `<span class="small muted">${x.ageDays} ngày</span>` : '';
  return `<li><button class="item" data-open="${esc(x.code)}">
    <div class="row gap">${lvTag(x.level)}<b class="grow">${esc(x.partName)}</b>${age}</div>
    <div class="small muted">${esc(x.moNo)}${x.lsxStt ? ` · dòng ${esc(x.lsxStt)}` : ''} · ${esc(x.product)}</div>
    <div class="small"><b>${fmtQ(x.qty)}</b> ${levelName[x.level] || ''} · ${fmt3(x.m3)} m³</div>
  </button></li>`;
}

async function showWip(reload) {
  show('v-wip');
  const v = $('#v-wip');
  if (!wipState.data || reload) {
    loading(v);
    try { wipState.data = await api('/api/wip'); } catch (e) { if (e.status !== 401) v.innerHTML = failBox(e); return; }
  }
  const d = wipState.data;
  const teams = d.teams.filter((x) => !wipState.team || x.code === wipState.team);
  const sum = wipState.team ? (teams[0]?.sum || d.total) : d.total;
  const pallets = d.pallets.filter((f) => !wipState.team || f.team === wipState.team);
  v.innerHTML = `<div class="row gap"><h1 class="page-title grow">Trên chuyền</h1><button class="btn sm" id="wip-reload">Tải lại</button></div>
    <div class="chips" role="group" aria-label="Lọc tổ">
      <button class="fchip" data-team="" aria-pressed="${!wipState.team}">Tất cả</button>
      ${d.teams.map((x) => `<button class="fchip" data-team="${esc(x.code)}" aria-pressed="${wipState.team === x.code}">${esc(x.name.replace(/^Tổ /, ''))} <small>${fmt3(x.sum.m3)}</small></button>`).join('')}
    </div>
    ${tiles(sum, pallets.length)}
    ${sum.old ? `<p class="notice small">${fmt(sum.old)} dòng hàng tồn ≥ ${d.ageWarn} ngày</p>` : ''}
    ${teams.filter((x) => x.sum.lines).map((x) => `<div class="card">
      <h2>${esc(x.name)} <span class="small muted">· ${fmt3(x.sum.m3)} m³ · ${fmtQ(x.sum.ct)} CT · ${fmtQ(x.sum.cum)} cụm · ${fmtQ(x.sum.sp)} SP</span></h2>
      ${x.stages.map((s) => `<details${s.kind === 'wait' ? ' class="waiting"' : ''}>
        <summary><span class="grow">${esc(s.stage)}</span>
          <span class="small">${fmtQ(s.sum.ct + s.sum.cum + s.sum.sp)} · ${fmt3(s.sum.m3)} m³</span></summary>
        <ul class="list">${s.items.map(wipItem).join('')}</ul>
        ${s.more ? `<p class="small muted">… và ${fmt(s.more)} dòng khác (đã hiện ${s.items.length} dòng tồn lâu nhất)</p>` : ''}
      </details>`).join('')}
    </div>`).join('') || '<div class="card"><p class="muted">Không có hàng tồn trên chuyền.</p></div>'}
    ${pallets.length ? `<div class="card"><h2>Pallet đang mở / chờ nhận <span class="badge">${pallets.length}</span></h2>
      <ul class="list">${pallets.map((f) => palletItem(f)).join('')}</ul></div>` : ''}
    <p class="small muted">Tồn = số công đoạn trước đã xong − số công đoạn sau đã làm (giống báo cáo Thống kê NSCN). Hàng đã nhận nhưng tổ sau chưa khai báo nằm ở “Chờ làm” của tổ sau; hàng đã giao chưa bấm nhận vẫn ở tổ giao.</p>`;
  $$('[data-team]', v).forEach((b) => b.addEventListener('click', () => { wipState.team = b.dataset.team; store.set('wipTeam', wipState.team); showWip(); }));
  $('#wip-reload', v).addEventListener('click', () => showWip(true));
  bindHandover(v);
}

/* ---------------- Sản lượng ---------------- */

const repState = { period: store.get('repPeriod', 'day'), date: '', open: '' };

function shiftDate(iso, period, dir) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (period === 'month') d.setUTCMonth(d.getUTCMonth() + dir, 1);
  else d.setUTCDate(d.getUTCDate() + dir * (period === 'week' ? 7 : 1));
  return d.toISOString().slice(0, 10);
}

function periodLabel(r) {
  if (r.period === 'day') return fmtDate(r.from);
  if (r.period === 'week') return `${fmtDate(r.from).slice(0, 5)} – ${fmtDate(r.to)}`;
  return `Tháng ${r.from.slice(5, 7)}/${r.from.slice(0, 4)}`;
}

function delta(cur, prev) {
  if (!prev && !cur) return '';
  if (!prev) return '<span class="delta up">mới</span>';
  const p = Math.round(((cur - prev) / prev) * 100);
  return `<span class="delta ${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</span>`;
}

/** Cột m³ theo ngày (1 chuỗi, 1 màu, chạm để xem số). */
function bars(series, days) {
  if (days.length < 2) return '';
  const max = Math.max(...series, 0);
  if (!max) return '<p class="small muted">Chưa có sản lượng trong kỳ.</p>';
  return `<div class="bars" role="img" aria-label="m³ theo ngày">
    ${series.map((v, i) => `<button class="b" data-tip="${esc(fmtDate(days[i]))}: ${fmt3(v)} m³" style="--h:${Math.max(v ? 3 : 0, (v / max) * 100)}%"><i></i></button>`).join('')}
  </div><div class="bars-x small muted"><span>${esc(fmtDate(days[0]).slice(0, 5))}</span><span>${esc(fmtDate(days.at(-1)).slice(0, 5))}</span></div>`;
}

async function showReport() {
  show('v-report');
  const v = $('#v-report');
  loading(v);
  let r;
  try {
    r = await api(`/api/report?period=${repState.period}${repState.date ? `&date=${repState.date}` : ''}`);
  } catch (e) { if (e.status !== 401) v.innerHTML = failBox(e); return; }
  repState.date = r.date;
  store.set('repPeriod', r.period);
  const f = r.factory;
  v.innerHTML = `<h1 class="page-title">Sản lượng</h1>
    <div class="seg" role="group" aria-label="Kỳ">
      ${[['day', 'Ngày'], ['week', 'Tuần'], ['month', 'Tháng']].map(([k, n]) => `<button data-period="${k}" aria-pressed="${r.period === k}">${n}</button>`).join('')}
    </div>
    <div class="row gap datebar">
      <button class="btn sm" data-shift="-1" aria-label="Kỳ trước">◀</button>
      <label class="grow center-text"><b>${esc(periodLabel(r))}</b><input type="date" id="rep-date" value="${esc(r.date)}" max="${esc(r.today)}" aria-label="Chọn ngày"></label>
      <button class="btn sm" data-shift="1" aria-label="Kỳ sau" ${r.to >= r.today ? 'disabled' : ''}>▶</button>
    </div>
    <div class="card hero">
      <div class="sec-label">Toàn nhà máy · SP đóng gói</div>
      <div class="row gap"><span class="big">${fmt(f.cur.sp)}</span><span class="muted">SP</span>${delta(f.cur.sp, f.prev.sp)}</div>
      <div class="muted">${fmt3(f.cur.m3)} m³ thành phẩm · kỳ trước ${fmt(f.prev.sp)} SP</div>
      ${bars(f.series, r.days)}
    </div>
    ${r.teams.map((x) => `<div class="card team-card">
      <button class="item" data-open-team="${esc(x.code)}" aria-expanded="${repState.open === x.code}">
        <div class="row gap"><h2 class="grow" style="margin:0">${esc(x.name)}</h2>${delta(x.cur.m3, x.prev.m3)}</div>
        <div class="row gap"><span class="big">${fmt3(x.cur.m3)}</span><span class="muted">m³</span></div>
        <div class="small muted">${fmt(x.cur.ct)} chi tiết · ${fmt(x.cur.cum)} cụm · ${fmt(x.cur.sp)} SP · kỳ trước ${fmt3(x.prev.m3)} m³</div>
      </button>
      ${bars(x.series, r.days)}
      ${repState.open === x.code ? (x.stages.length ? `<table class="tbl"><thead><tr><th>Công đoạn</th><th>SL</th></tr></thead>
        <tbody>${x.stages.map((s) => `<tr><td>${esc(s.stage)}</td><td>${fmt(s.qty)}</td></tr>`).join('')}</tbody></table>` : '<p class="small muted">Không có số liệu.</p>') : ''}
    </div>`).join('')}
    <p class="small muted">SL tổ = số qua công đoạn cuối của tổ trên từng chi tiết; công đoạn bỏ qua được suy ra từ công đoạn sau (giống báo cáo Thống kê NSCN). m³ tinh theo BOM.</p>`;
  $$('[data-period]', v).forEach((b) => b.addEventListener('click', () => { repState.period = b.dataset.period; showReport(); }));
  $$('[data-shift]', v).forEach((b) => b.addEventListener('click', () => { repState.date = shiftDate(repState.date, repState.period, Number(b.dataset.shift)); showReport(); }));
  $('#rep-date', v).addEventListener('change', (e) => { if (e.target.value) { repState.date = e.target.value; showReport(); } });
  $$('[data-open-team]', v).forEach((b) => b.addEventListener('click', () => { repState.open = repState.open === b.dataset.openTeam ? '' : b.dataset.openTeam; showReport(); }));
  $$('.bars .b', v).forEach((b) => b.addEventListener('click', () => toast(b.dataset.tip)));
}

/* ---------------- Thêm ---------------- */

function showMore() {
  show('v-more');
  const u = state.user;
  const names = (codes) => (codes || []).join(', ') || '—';
  $('#v-more').innerHTML = `<h1 class="page-title">Thêm</h1>
    <div class="card">
      <p class="title" style="font-size:18px">${esc(u.name)}</p>
      <div class="muted">${esc(u.email)}</div>
      <dl class="kv">
        <dt>Vai trò</dt><dd>${esc(u.role || '—')}</dd>
        <dt>Nhập SL tổ</dt><dd>${esc(u.admin ? 'tất cả' : names(u.statTeams))}</dd>
        <dt>Tổ trưởng</dt><dd>${esc(u.admin ? 'tất cả (quản lý)' : names(u.leadTeams))}</dd>
      </dl>
    </div>
    <div class="card">
      <h2>Giao diện</h2>
      <div class="seg" role="group" aria-label="Giao diện sáng tối" id="theme-seg">
        ${THEMES.map(([k, n]) => `<button type="button" data-theme-set="${k}" aria-pressed="${store.get('theme', 'auto') === k}">${n}</button>`).join('')}
      </div>
      <p class="small muted">"Theo máy" tự đổi sáng/tối theo cài đặt của điện thoại.</p>
    </div>
    <div class="card menu">
      ${canTransfer() ? '<button class="item" data-go-tab="transfer">Chuyển chi tiết giữa LSX<span class="small muted">Cùng BOM, có nhật ký</span></button>' : ''}
      <button class="item" data-go-tab="work">Pallet bị trả lại / việc của tôi</button>
      ${installEvt ? '<button class="item" id="more-install">Cài app vào điện thoại</button>' : ''}
      <button class="item danger" id="more-logout">Đăng xuất</button>
    </div>`;
  $$('[data-theme-set]', $('#v-more')).forEach((b) => b.addEventListener('click', () => {
    setTheme(b.dataset.themeSet);
    $$('[data-theme-set]', $('#v-more')).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $$('[data-go-tab]', $('#v-more')).forEach((b) => b.addEventListener('click', () => goTab(b.dataset.goTab)));
  $('#more-install')?.addEventListener('click', () => $('#btn-install').click());
  $('#more-logout').addEventListener('click', logout);
}

/* ---------------- Chuyển LSX ---------------- */

async function showTransfer() {
  show('v-transfer');
  const v = $('#v-transfer');
  const ref = new URLSearchParams(location.search).get('ref') || '';
  if (!canTransfer()) { v.innerHTML = '<div class="card"><p class="muted">Chỉ thống kê hoặc quản lý được chuyển LSX.</p></div>'; return; }
  const head = `<h1 class="page-title">Chuyển chi tiết giữa LSX</h1>
    <form class="card row gap" id="tr-find" autocomplete="off">
      <input id="tr-ref" class="grow" value="${esc(ref)}" placeholder="Mã chi tiết: LSX-…-W002 (hoặc quét mã phiếu)" aria-label="Mã chi tiết">
      <button class="btn" type="submit">Tìm</button>
    </form>`;
  if (!ref) {
    v.innerHTML = `${head}<p class="small muted">Chỉ chuyển được sang LSX có cùng BOM (cùng chi tiết, cùng routing). Hệ thống ghi −SL ở LSX nguồn và +SL ở LSX đích cho từng công đoạn; sản lượng ngày không bị tính thêm. Muốn hoàn tác: chuyển ngược lại.</p><div id="tr-hist"></div>`;
    bindFind(v);
    try {
      const h = await api('/api/transfer');
      $('#tr-hist', v).innerHTML = h.history === null ? '<p class="notice small">Sheet chưa có tab "Transfer".</p>' : historyCard(h.history);
    } catch { /* bỏ qua */ }
    return;
  }
  loading(v);
  let d;
  try { d = await api(`/api/transfer?ref=${encodeURIComponent(ref.replace(/-(T-)?(SC|TC|LR|DM|DG)$/i, ''))}`); } catch (e) {
    if (e.status === 401) return;
    v.innerHTML = head + failBox(e); bindFind(v); return;
  }
  const p = d.part;
  const lastLogged = [...p.steps].reverse().find((s) => s.logged > 0);
  v.innerHTML = `${head}
    <div class="card">
      <div class="sec-label">Từ LSX</div>
      <p class="title" style="font-size:18px">${esc(p.name)}</p>
      <div class="muted">${esc(p.moNo)}${p.lsxStt ? ` · dòng ${esc(p.lsxStt)}` : ''} · ${esc(p.product)}</div>
      <div class="code">${esc(p.ref)}</div>
      <div class="route">${p.steps.map((s) => `<span class="chip"><b>${s.no}. ${esc(s.stage)}</b> ${fmt(s.logged)}/${fmt(s.required)}</span>`).join('')}</div>
    </div>
    ${!d.allowed ? '<div class="card"><p class="notice">Giai đoạn này chỉ chuyển được chi tiết (không chuyển cụm/SP).</p></div>'
    : !d.candidates.length ? '<div class="card"><p class="muted">Không có LSX nào khác dùng cùng BOM chi tiết này.</p></div>'
    : `<div class="card" id="tr-form">
      <div class="sec-label">Sang LSX (cùng BOM)</div>
      <div class="list">${d.candidates.map((c, i) => `<label class="opt"><input type="radio" name="tr-to" value="${esc(c.ref)}" ${i === 0 ? 'checked' : ''}>
        <span><b>${esc(c.moNo)}</b>${c.lsxStt ? ` · dòng ${esc(c.lsxStt)}` : ''} · ${esc(c.product)}
        <span class="small muted" style="display:block">${c.steps.map((s) => `${esc(s.stage)} ${fmt(s.logged)}/${fmt(s.required)}`).join(' · ')}</span></span></label>`).join('')}</div>
      <div class="grid2">
        <label class="field">Đến công đoạn<select id="tr-upto">${p.steps.map((s) => `<option value="${s.no}" ${s === lastLogged ? 'selected' : ''}>${s.no}. ${esc(s.stage)} (đã ghi ${fmt(s.logged)})</option>`).join('')}</select></label>
        <label class="field">SL chuyển<input type="number" id="tr-qty" inputmode="numeric" min="1" step="1"></label>
      </div>
      <label class="field" style="margin-top:8px">Lý do<input id="tr-reason" maxlength="200" placeholder="VD: ưu tiên giao LSX 02/1826"></label>
      <p class="small muted">Chuyển SL ở mọi công đoạn từ 1 đến công đoạn đã chọn.</p>
      <p id="tr-msg" class="msg" role="alert"></p>
      <button class="btn primary big" id="tr-go">Chuyển</button>
    </div>`}`;
  bindFind(v);
  $('#tr-go', v)?.addEventListener('click', () => doTransfer(v, p, false));
}

function bindFind(v) {
  $('#tr-find', v).addEventListener('submit', (e) => {
    e.preventDefault();
    const ref = extractCode($('#tr-ref', v).value).trim();
    if (ref) goTab('transfer', `&ref=${encodeURIComponent(ref)}`);
  });
}

function historyCard(rows) {
  if (!rows.length) return '<div class="card"><h2>Lịch sử chuyển</h2><p class="muted small">Chưa có.</p></div>';
  return `<div class="card"><h2>Lịch sử chuyển</h2><ul class="list">${rows.map((x) => `<li>
    <div><b>${fmt(x.qty)}</b> · ${esc(x.from_part_ref)} → ${esc(x.to_part_ref)}</div>
    <div class="small muted">Đến CĐ ${esc(x.up_to_step)} · ${esc(x.reason)} · ${esc(x.created_by)} · ${esc(x.created_at)}</div></li>`).join('')}</ul></div>`;
}

async function doTransfer(v, p, confirm) {
  const msg = $('#tr-msg', v);
  msg.textContent = '';
  const to = $('input[name="tr-to"]:checked', v)?.value;
  const body = { from: p.ref, to, qty: Number($('#tr-qty', v).value), up_to: Number($('#tr-upto', v).value), reason: $('#tr-reason', v).value, confirm };
  if (!to) { msg.textContent = 'Chọn LSX đích'; return; }
  if (!Number.isInteger(body.qty) || body.qty < 1) { msg.textContent = 'Nhập SL chuyển'; return; }
  if (body.reason.trim().length < 3) { msg.textContent = 'Nhập lý do'; return; }
  if (!confirm && !await ask('Chuyển LSX?', `<p>Chuyển <b>${fmt(body.qty)}</b> ${esc(p.name)} từ <b>${esc(p.moNo)}</b> sang <b>${esc(to)}</b>, công đoạn 1 → ${body.up_to}.</p>`, 'Chuyển')) return;
  const btn = $('#tr-go', v);
  btn.disabled = true;
  try {
    const r = await api('/api/transfer', { method: 'POST', body });
    if (r.status === 409) {
      btn.disabled = false;
      if (await ask('Kiểm tra lại', `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><p>Vẫn chuyển?</p>`, 'Vẫn chuyển')) return doTransfer(v, p, true);
      return;
    }
    toast(r.message);
    showTransfer();
  } catch (e) {
    btn.disabled = false;
    if (e.status !== 401) msg.textContent = e.message;
  }
}
