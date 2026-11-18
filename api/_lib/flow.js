// Mô hình luồng sản xuất dựng từ Sheet gốc (chỉ đọc):
//  - Cây chi tiết → cụm → SP theo MO Routing (part_kind, cum_ref, sp_ref), m³ theo BOM Wood.
//  - Pallet: đang ở tổ nào, bước "ra tổ", SL giao, giao tới tổ nào (công đoạn kế hoặc bước đầu cụm/SP cha).
//  - Sản lượng: quy tắc suy diễn giống app Thong_Ke_NSCN (public/production.js) để số liệu 2 app khớp nhau.
import { norm, num, parseDay, vnNow, daysBetween } from './util.js';
import { teamCoder, teamList } from './data.js';

export const CANCEL_PREFIX = 'HUỶ ';
export const TRANSFER_PREFIX = 'CHUYỂN ';
export const isTransferNote = (note) => String(note || '').startsWith(TRANSFER_PREFIX);

// Trạng thái pallet (cột Pallet.status)
export const ST = { OPEN: 'Đang làm', WAIT: 'Chờ nhận', RECEIVED: 'Đã nhận', DONE: 'Đã xong', RETURNED: 'Trả lại' };
/** open = đang ở tổ (nhập được, giao được) · waiting = đã giao, chờ tổ sau nhận · received / done = ra khỏi chuyền */
export function palletState(status) {
  const s = norm(status);
  if (!s || s === 'dang lam' || s === 'tra lai') return 'open';
  if (s === 'cho nhan') return 'waiting';
  if (s === 'da nhan') return 'received';
  return 'done';
}

const levelOf = (r) => {
  const l = norm(r.level);
  return l === 'sp' ? 'SP' : l === 'cum' ? 'CUM' : 'CT';
};

/* ---------------- Cây chi tiết (cache theo bảng nguồn) ---------------- */

let cached = null;

export function model(t) {
  const src = [t.mo_routing, t.bom_wood, t.works, t.to, t.mo_detail, t.mo];
  if (cached && cached.src.every((x, i) => x === src[i])) return cached.m;

  const coder = teamCoder(t);
  const teams = teamList(t);
  const teamName = (c) => teams.find((x) => x.code === c)?.name || c;
  const bom = new Map(t.bom_wood.rows.map((r) => [r.bom_line_id, r]));
  const detail = new Map(t.mo_detail.rows.map((r) => [r.detail_id, r]));
  const mo = new Map(t.mo.rows.map((r) => [r.mo_id, r]));

  const parts = new Map();
  const steps = new Map();
  for (const r of t.mo_routing.rows) {
    const ref = String(r.part_ref || '').trim();
    if (!ref || !r.mo_route_id) continue;
    let p = parts.get(ref);
    if (!p) {
      const d = detail.get(r.detail_id) || {};
      const b = bom.get(r.bom_line_id) || {};
      p = {
        ref, name: r.part_name, level: levelOf(r), kind: r.part_kind,
        moId: r.mo_id, moNo: mo.get(r.mo_id)?.mo_no || r.mo_id, detailId: r.detail_id,
        product: d.product_name || '', lsxStt: d.lsx_stt || '',
        bomLine: r.bom_line_id, cumRef: r.cum_ref, spRef: r.sp_ref,
        qtyPer: num(r.qty_per_unit), required: num(r.qty_required),
        m3Line: num(b.m3_finish), m3RoughLine: num(b.m3_rough), bomQty: num(b.qty_per_unit),
        m3Pcs: num(d.m3_per_pcs), steps: [], children: [], parent: null, ratio: 0,
      };
      parts.set(ref, p);
    }
    const s = {
      id: r.mo_route_id, no: num(r.step_no), stage: r.stage, group: r.stage_group, team: coder(r),
      required: num(r.qty_required), qtyDone: num(r.qty_done), part: p,
    };
    p.steps.push(s);
    steps.set(s.id, s);
  }
  for (const p of parts.values()) {
    p.steps.sort((a, b) => a.no - b.no);
    p.steps.forEach((s, i) => {
      s.idx = i;
      s.exit = i === p.steps.length - 1 || p.steps[i + 1].team !== s.team; // bước cuối của tổ trên chi tiết này
    });
  }
  // Cha – con: CT thuộc cụm → cụm; cụm và CT rời → SP
  for (const p of parts.values()) {
    if (p.level === 'SP') continue;
    let parent = null;
    if (p.level === 'CT' && p.cumRef && p.cumRef !== p.ref) parent = parts.get(p.cumRef) || null;
    if (!parent && p.spRef && p.spRef !== p.ref) parent = parts.get(p.spRef) || null;
    p.parent = parent;
    if (parent) { parent.children.push(p); p.ratio = p.qtyPer / (parent.qtyPer || 1); }
  }
  // m³ / 1 đơn vị: chi tiết theo BOM; cụm/SP = tổng gỗ các thành phần
  const m3 = (p, rough) => {
    if (p.children.length) return p.children.reduce((s, c) => s + m3(c, rough) * c.ratio, 0);
    const line = rough ? p.m3RoughLine || p.m3Line : p.m3Line;
    if (line) return line / (p.bomQty || p.qtyPer || 1);
    return p.level === 'SP' ? p.m3Pcs : 0;
  };
  for (const p of parts.values()) { p.m3f = m3(p, false); p.m3r = m3(p, true); }

  const m = { parts, steps, teams, teamName };
  cached = { src, m };
  return m;
}

/* ---------------- Pallet ---------------- */

/** SL theo pallet × công đoạn (từ Pallet Log). */
function palletQty(t) {
  const map = new Map();
  for (const l of t.pallet_log.rows) {
    if (!l.pallet_id || !l.mo_route_id) continue;
    let m = map.get(l.pallet_id);
    if (!m) map.set(l.pallet_id, (m = {}));
    m[l.mo_route_id] = (m[l.mo_route_id] || 0) + num(l.qty);
  }
  return map;
}

/** Nơi giao tới khi pallet rời tổ ở bước `exit`. null = SP đã xong bước cuối (ra khỏi chuyền). */
export function destOf(exit, m) {
  const p = exit.part;
  const next = p.steps[exit.idx + 1];
  if (next) return { stepId: next.id, team: next.team, teamName: m.teamName(next.team), partRef: p.ref, partName: p.name, stage: next.stage, kind: 'next' };
  const parent = p.parent;
  if (parent?.steps.length) {
    const s = parent.steps[0];
    return { stepId: s.id, team: s.team, teamName: m.teamName(s.team), partRef: parent.ref, partName: parent.name, stage: s.stage, kind: 'parent' };
  }
  return null;
}

/** Tất cả pallet có công đoạn hợp lệ trong MO Routing, kèm trạng thái luồng. */
export function palletFlow(t, m = model(t)) {
  const qty = palletQty(t);
  const today = vnNow().iso;
  const out = [];
  for (const r of t.pallet.rows) {
    const step = m.steps.get(r.mo_route_id);
    if (!r.pallet_id || !step) continue;
    const p = step.part;
    let exit = step;
    while (!exit.exit) exit = p.steps[exit.idx + 1];
    const perStep = qty.get(r.pallet_id) || {};
    const teamStepIds = p.steps.filter((s) => s.team === step.team && s.idx >= step.idx && s.idx <= exit.idx).map((s) => s.id);
    // Công đoạn hiện tại: bước xa nhất đã có SL trên pallet (chưa có thì bước đầu)
    let cur = step;
    for (const id of teamStepIds) if (perStep[id]) cur = m.steps.get(id);
    const qtyIn = num(r.qty_in);
    const pieces = Math.max(qtyIn, ...teamStepIds.map((id) => perStep[id] || 0), 0);
    const state = palletState(r.status);
    const since = parseDay(state === 'waiting' ? r.closed_at : r.created_at);
    out.push({
      id: r.pallet_id, no: r.pallet_no, status: r.status || ST.OPEN, state,
      returned: norm(r.status) === 'tra lai',
      partRef: p.ref, partName: p.name, level: p.level, moNo: p.moNo, lsxStt: p.lsxStt, product: p.product,
      team: step.team, teamName: m.teamName(step.team), stepId: step.id, exitId: exit.id,
      stage: cur.stage, exitStage: exit.stage, teamStepIds, perStep,
      qtyOut: perStep[exit.id] || 0, qtyIn, pieces, m3: pieces * p.m3f,
      dest: destOf(exit, m), from: r.from_pallet_id || '',
      lot_go: r.lot_go, lot_dau: r.lot_dau, note: r.note,
      created_by: r.created_by, created_at: r.created_at,
      delivered_by: r.closed_by, delivered_at: r.closed_at,
      received_by: r.received_by, received_at: r.received_at,
      ageDays: since ? Math.max(0, daysBetween(since, today)) : 0,
      code: `${p.ref}-${step.team}`,
    });
  }
  return out;
}

/** Gọn cho danh sách (không gửi perStep). */
export const palletBrief = (x) => {
  const { perStep, teamStepIds, ...rest } = x;
  return rest;
};

/* ---------------- Sản lượng (suy diễn như app cũ) ----------------
 *  E[k] = max(R[k], E[k+1]); cụm/SP vào bước đầu n cái → con xong bước cuối n × tỉ lệ.
 *  Sản lượng ngày = phần tăng của E trong ngày. Dòng CHUYỂN LSX không tính là sản lượng ngày. */

let prodCache = null;

export function production(t, m = model(t)) {
  if (prodCache && prodCache.m === m && prodCache.log === t.pallet_log) return prodCache.v;
  const parts = [...m.parts.values()];
  for (const p of parts) { p.R = p.steps.map(() => 0); p.E = p.steps.map(() => 0); p.floor = 0; }

  const recompute = (p, floor, out, force) => {
    const changedFloor = floor !== p.floor;
    p.floor = floor;
    let next = floor;
    for (let i = p.steps.length - 1; i >= 0; i--) {
      const e = Math.max(p.R[i], next);
      if (e !== p.E[i]) { if (out) out(p.steps[i], e - p.E[i]); p.E[i] = e; }
      next = e;
    }
    const head = p.steps.length ? p.E[0] : floor;
    for (const c of p.children) {
      const f = head * c.ratio;
      if (force || f !== c.floor || changedFloor) recompute(c, f, out, force);
    }
  };

  const logs = [];
  t.pallet_log.rows.forEach((l, i) => {
    const st = m.steps.get(String(l.mo_route_id || '').trim());
    const day = parseDay(l.work_date) || parseDay(l.created_at);
    const qty = num(l.qty);
    if (!st || !day || !qty) return;
    const tm = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(l.created_at || '');
    logs.push({ st, day, qty, transfer: isTransferNote(l.note), t: `${parseDay(l.created_at)} ${tm ? tm.slice(1).map((x) => String(x || 0).padStart(2, '0')).join(':') : ''}`, i });
  });
  logs.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0) || a.i - b.i);

  const daily = new Map(); // day -> Map(stepId -> E tăng)
  for (const lg of logs) {
    const p = lg.st.part;
    p.R[lg.st.idx] += lg.qty;
    const out = lg.transfer ? null : (st, d) => {
      let dm = daily.get(lg.day);
      if (!dm) daily.set(lg.day, (dm = new Map()));
      dm.set(st.id, (dm.get(st.id) || 0) + d);
    };
    recompute(p, p.floor, out);
  }
  // Ảnh chụp hiện tại: max(Pallet Log, MO Routing.qty_done) rồi suy diễn lại
  for (const p of parts) p.steps.forEach((s, i) => { p.R[i] = Math.max(p.R[i], s.qtyDone); });
  for (const p of parts) if (!p.parent) recompute(p, 0, null, true);
  const eff = new Map();
  for (const p of parts) p.steps.forEach((s, i) => eff.set(s.id, p.E[i]));
  // Dòng thời gian phần tăng theo từng bước (để tính tuổi tồn FIFO)
  const tl = new Map();
  for (const day of [...daily.keys()].sort()) {
    for (const [id, e] of daily.get(day)) {
      if (!e) continue;
      let a = tl.get(id);
      if (!a) tl.set(id, (a = []));
      a.push([day, e]);
    }
  }

  const v = { daily, eff, tl };
  prodCache = { m, log: t.pallet_log, v };
  return v;
}
