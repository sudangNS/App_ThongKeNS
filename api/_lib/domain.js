// Nghiệp vụ: giải mã QR, dựng thông tin chi tiết / cụm / sản phẩm, sản lượng theo công đoạn.
import { HttpError, norm, num, parseDay, vnNow } from './util.js';
import { teamCoder, teamList, teamIdToCode, canWrite, canLead } from './data.js';
import { CANCEL_PREFIX, isTransferNote, model, palletFlow, palletBrief } from './flow.js';

export { CANCEL_PREFIX };
export const SCAN_TABLES = ['mo_routing', 'mo', 'mo_detail', 'product', 'bom_wood', 'pallet', 'pallet_log'];

// Pallet "đóng" = không nhận thêm sản lượng (kể cả đang chờ tổ sau nhận). "Trả lại" = mở lại tại tổ giao.
const CLOSED = ['da xong', 'da nhan', 'cho nhan', 'dong', 'da dong', 'closed', 'hoan thanh', 'huy'];
export const isClosed = (status) => CLOSED.includes(norm(status));

/** "LSX-02-1626-01-W004-TC" → { partRef, team }. Không có hậu tố tổ → team = ''. */
export function parseCode(raw, t) {
  const code = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) throw new HttpError(400, 'Chưa có mã QR');
  if (code.length > 80) throw new HttpError(400, 'Mã QR quá dài');
  // Cấu trúc QR = part_ref + "-" + team_id (lấy đúng từ tab To, vd "…-W003-T-TC").
  // team_id dài nhất được thử trước để không cắt nhầm.
  const ids = t.to.rows.map((r) => String(r.team_id || '').trim().toUpperCase()).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const id of ids) {
    if (code.endsWith(`-${id}`) && code.length > id.length + 1) {
      return { code, partRef: code.slice(0, -(id.length + 1)), team: teamIdToCode(id) };
    }
  }
  // Dự phòng: mã tổ ngắn "…-W003-TC"
  const codes = new Set(teamList(t).map((x) => x.code));
  const m = /^(.+)-([A-Z]{2,3})$/.exec(code);
  if (m && codes.has(m[2])) return { code, partRef: m[1], team: m[2] };
  // Phiếu cũ in mã công đoạn (mo_route_id, vd "…-W002-S06") → chi tiết + tổ của công đoạn đó
  const step = t.mo_routing?.rows.find((r) => String(r.mo_route_id).toUpperCase() === code);
  if (step) {
    const team = teamCoder(t)(step);
    const partRef = String(step.part_ref).toUpperCase();
    return { code: team ? `${partRef}-${team}` : partRef, partRef, team };
  }
  return { code, partRef: code, team: '' };
}

/** Tổng Pallet Log theo mo_route_id: qty đạt, qty_ng. */
function logSums(t) {
  const sums = new Map();
  for (const l of t.pallet_log.rows) {
    const id = l.mo_route_id;
    if (!id) continue;
    const s = sums.get(id) || { qty: 0, ng: 0 };
    s.qty += num(l.qty);
    s.ng += num(l.qty_ng);
    sums.set(id, s);
  }
  return sums;
}

const bySteps = (a, b) => num(a.step_no) - num(b.step_no);

/**
 * Dựng toàn bộ dữ liệu cho màn hình sau khi quét.
 * @returns object gửi về trình duyệt (cũng dùng để kiểm tra khi ghi).
 */
export function buildContext(t, acc, raw) {
  const { code, partRef, team } = parseCode(raw, t);
  const coder = teamCoder(t);
  const teams = teamList(t);
  const teamName = (c) => teams.find((x) => x.code === c)?.name || c;

  const refN = partRef.toUpperCase();
  const steps = t.mo_routing.rows.filter((r) => String(r.part_ref).toUpperCase() === refN).sort(bySteps);
  if (!steps.length) throw new HttpError(404, `Không tìm thấy chi tiết "${partRef}" trong MO Routing`);
  const head = steps[0];

  const sums = logSums(t);
  const doneOf = (r) => Math.max(num(r.qty_done), sums.get(r.mo_route_id)?.qty || 0);
  const ngOf = (r) => sums.get(r.mo_route_id)?.ng || 0;
  const stepView = (r) => ({
    id: r.mo_route_id,
    no: num(r.step_no),
    stage: r.stage,
    group: r.stage_group,
    team: coder(r),
    required: num(r.qty_required),
    done: doneOf(r),
    ng: ngOf(r),
    status: r.status,
  });

  // ----- Sản phẩm / LSX -----
  const detail = t.mo_detail.rows.find((r) => r.detail_id === head.detail_id) || {};
  const mo = t.mo.rows.find((r) => r.mo_id === head.mo_id) || {};
  const product = t.product.rows.find((r) => r.product_id === (detail.product_id || head.product_id)) || {};
  const spSteps = t.mo_routing.rows.filter((r) => r.part_ref === head.sp_ref).sort(bySteps);
  const productView = {
    mo_id: head.mo_id,
    mo_no: mo.mo_no || head.mo_id,
    lsx_stt: detail.lsx_stt || '',
    customer: [mo.customer, mo.end_customer].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / '),
    order_type: mo.order_type || '',
    detail_id: head.detail_id,
    name: detail.product_name || product.product_name || '',
    name_vi: product.product_name_vi || '',
    code: detail.product_code || product.product_code || '',
    bom_code: product.bom_product_code || '',
    qty: num(detail.qty || head.mo_qty),
    unit: detail.unit || product.unit || '',
    size: product.size || '',
    wood: product.wood_type || '',
    color: product.color_code || '',
    due_date: detail.due_date || mo.due_date || '',
    ref: head.sp_ref,
    steps: spSteps.map(stepView),
  };

  // ----- Chi tiết -----
  const bom = t.bom_wood.rows.find((r) => r.bom_line_id === head.bom_line_id) || {};
  const dims = [bom.thick_mm, bom.width_mm, bom.length_mm].filter((v) => String(v ?? '').trim());
  const isSP = norm(head.level) === 'sp';
  const partView = {
    ref: head.part_ref,
    name: head.part_name,
    level: head.level,
    kind: head.part_kind,
    code: bom.part_code || (isSP ? productView.bom_code || productView.code : ''),
    size: dims.length === 3 ? `${dims.join(' × ')} mm` : (isSP ? productView.size : ''),
    material: bom.material || productView.wood,
    feature: bom.feature || '',
    glue: bom.glue || '',
    qty_per_unit: num(head.qty_per_unit),
    qty_required: num(head.qty_required),
    cum_ref: head.cum_ref,
    steps: steps.map(stepView),
  };

  // ----- Cụm (chi tiết thuộc cụm → cụm cha; bản thân là cụm → chính nó) -----
  const progressOf = (ref) => {
    const ss = t.mo_routing.rows.filter((r) => r.part_ref === ref).sort(bySteps);
    if (!ss.length) return null;
    const last = ss[ss.length - 1];
    return {
      ref, name: ss[0].part_name, kind: ss[0].part_kind, level: ss[0].level,
      required: num(last.qty_required), done: doneOf(last), lastStage: last.stage,
    };
  };
  const childrenOf = (pred) => {
    const refs = [...new Set(t.mo_routing.rows.filter(pred).map((r) => r.part_ref))];
    return refs.map(progressOf).filter(Boolean);
  };

  let cumView = null;
  const cumRef = norm(head.level) === 'cum' ? head.part_ref : head.cum_ref;
  if (cumRef) {
    const cs = t.mo_routing.rows.filter((r) => r.part_ref === cumRef).sort(bySteps);
    if (cs.length) {
      const cb = t.bom_wood.rows.find((r) => r.bom_line_id === cs[0].bom_line_id) || {};
      cumView = {
        ref: cumRef,
        name: cs[0].part_name,
        code: cb.part_code || '',
        qty_per_unit: num(cs[0].qty_per_unit),
        qty_required: num(cs[0].qty_required),
        steps: cs.map(stepView),
        children: childrenOf((r) => r.cum_ref === cumRef && r.part_ref !== cumRef),
      };
    }
  }
  // Thành phẩm: liệt kê cụm + chi tiết rời thuộc SP
  const spChildren = isSP
    ? childrenOf((r) => r.sp_ref === head.part_ref && r.part_ref !== head.part_ref && (norm(r.level) === 'cum' || !r.cum_ref))
    : [];

  // ----- Tổ -----
  const groups = [];
  for (const s of steps) {
    const c = coder(s);
    if (c && !groups.some((g) => g.code === c)) groups.push({ code: c, name: teamName(c), group: s.stage_group });
  }
  const out = {
    code, partRef: head.part_ref, team: null, groups,
    product: productView, part: partView, cum: cumView, spChildren,
    canWrite: false, canLead: false, hasNg: t.pallet_log.header.includes('qty_ng'),
    teamSteps: [], pallets: [], incoming: [], logs: [], today: vnNow().iso,
  };
  if (!team) return out;
  if (!groups.some((g) => g.code === team)) {
    throw new HttpError(404, `${head.part_name} không đi qua ${teamName(team)} (mã ${team})`, { groups, partRef: head.part_ref });
  }

  out.team = { code: team, name: teamName(team) };
  out.canWrite = canWrite(acc, team);
  out.canLead = canLead(acc, team);

  const idx = (r) => steps.indexOf(r);
  const tSteps = steps.filter((s) => coder(s) === team);
  out.teamSteps = tSteps.map((s) => {
    const prev = steps[idx(s) - 1];
    return {
      ...stepView(s),
      prevId: prev?.mo_route_id || '',
      prevStage: prev?.stage || '',
      prevDone: prev ? doneOf(prev) : null,
    };
  });

  // ----- Pallet & nhật ký của tổ cho chi tiết này -----
  const ids = new Set(tSteps.map((s) => s.mo_route_id));
  const stageOf = new Map(tSteps.map((s) => [s.mo_route_id, s.stage]));
  const teamLogs = t.pallet_log.rows.filter((l) => ids.has(l.mo_route_id));
  const palletIds = new Set(teamLogs.map((l) => l.pallet_id));
  const pallets = t.pallet.rows.filter((p) => ids.has(p.mo_route_id) || palletIds.has(p.pallet_id));
  const palletNo = new Map(pallets.map((p) => [p.pallet_id, p.pallet_no]));

  const m = model(t);
  const flow = palletFlow(t, m);
  const flowById = new Map(flow.map((f) => [f.id, f]));
  out.pallets = pallets.map((p) => {
    const perStep = {};
    let qty = 0;
    for (const l of teamLogs) {
      if (l.pallet_id !== p.pallet_id) continue;
      perStep[l.mo_route_id] = (perStep[l.mo_route_id] || 0) + num(l.qty);
      qty += num(l.qty);
    }
    const f = flowById.get(p.pallet_id);
    return {
      id: p.pallet_id, no: p.pallet_no, lot_go: p.lot_go, lot_dau: p.lot_dau,
      status: p.status || '', closed: isClosed(p.status), note: p.note,
      created_by: p.created_by, created_at: p.created_at, perStep, qty,
      state: f?.state || 'done', returned: !!f?.returned, qtyOut: f?.qtyOut || 0, exitStage: f?.exitStage || '',
      dest: f?.dest || null, from: f?.from || '', qtyIn: f?.qtyIn || 0,
      delivered_at: f?.delivered_at || '', received_at: f?.received_at || '',
      canDeliver: !!f && out.canLead && f.state === 'open' && !!f.dest && f.qtyOut > 0,
      canFinish: !!f && (out.canLead || out.canWrite) && f.state === 'open' && !f.dest,
    };
  }).sort((a, b) => Number(a.closed) - Number(b.closed) || (parseStamp(b.created_at) > parseStamp(a.created_at) ? 1 : -1));

  // Pallet tổ trước đã giao, đang chờ tổ này nhận (chi tiết này, hoặc chi tiết con khi đây là cụm/SP)
  out.incoming = flow
    .filter((f) => f.state === 'waiting' && f.dest && ids.has(f.dest.stepId))
    .map((f) => ({ ...palletBrief(f), canReceive: canLead(acc, f.dest.team) }));

  const cancelled = new Set(teamLogs
    .filter((l) => String(l.note).startsWith(CANCEL_PREFIX))
    .map((l) => String(l.note).slice(CANCEL_PREFIX.length).split(/\s/)[0]));
  const today = vnNow().iso;
  out.logs = teamLogs.slice(-30).reverse().map((l) => {
    const reversal = String(l.note).startsWith(CANCEL_PREFIX);
    const transfer = isTransferNote(l.note);
    const mine = String(l.created_by).toLowerCase() === acc.email;
    return {
      id: l.log_id, pallet_id: l.pallet_id, pallet_no: palletNo.get(l.pallet_id) || '',
      step: l.mo_route_id, stage: stageOf.get(l.mo_route_id) || '',
      date: l.work_date, qty: num(l.qty), ng: num(l.qty_ng), worker: l.worker, note: l.note,
      by: l.created_by, at: l.created_at,
      reversal, transfer, cancelled: cancelled.has(l.log_id),
      canCancel: out.canWrite && !reversal && !transfer && !cancelled.has(l.log_id) && !!l.log_id
        && (acc.admin || (mine && parseDay(l.created_at) === today)),
    };
  });
  return out;
}

const parseStamp = (s) => {
  const d = parseDay(s);
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s || '');
  return `${d} ${m ? m.slice(1).map((x) => String(x || 0).padStart(2, '0')).join(':') : ''}`;
};
