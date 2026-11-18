// Chuyển chi tiết đã làm từ LSX này sang LSX khác (cùng BOM: cùng bom_line_id → cùng chi tiết, cùng routing).
// GET  /api/transfer?ref=<part_ref>  → chi tiết nguồn, SL đã ghi từng công đoạn, các LSX đích hợp lệ, lịch sử chuyển
// POST /api/transfer { from, to, qty, up_to, reason, confirm }
//   Ghi 1 dòng tab Transfer + cặp dòng Pallet Log cho mỗi công đoạn 1..up_to: −qty ở nguồn, +qty ở đích,
//   ghi chú "CHUYỂN <id> …". Báo cáo sản lượng ngày bỏ qua các dòng này. Hoàn tác = chuyển ngược lại.
import { handler, send, readBody, HttpError, newId, vnNow, textCell, num } from './_lib/util.js';
import { load, appendObjects, canTransfer } from './_lib/data.js';
import { requireUser } from './_lib/session.js';
import { model, TRANSFER_PREFIX } from './_lib/flow.js';

const TABLES = ['mo_routing', 'mo', 'mo_detail', 'bom_wood', 'pallet_log'];
const MAX_QTY = 100_000;

/** SL đã ghi trong Pallet Log theo công đoạn (chỉ tính số thật đã ghi, không suy diễn). */
function logged(t) {
  const s = new Map();
  for (const l of t.pallet_log.rows) if (l.mo_route_id) s.set(l.mo_route_id, (s.get(l.mo_route_id) || 0) + num(l.qty));
  return s;
}

const partView = (p, sums) => ({
  ref: p.ref, name: p.name, level: p.level, moNo: p.moNo, lsxStt: p.lsxStt, product: p.product, bomLine: p.bomLine,
  required: p.required,
  steps: p.steps.map((s) => ({ no: s.no, stage: s.stage, team: s.team, required: s.required, logged: sums.get(s.id) || 0 })),
});

function findPart(m, ref) {
  const p = m.parts.get(String(ref || '').trim().toUpperCase()) || [...m.parts.values()].find((x) => x.ref.toUpperCase() === String(ref || '').trim().toUpperCase());
  if (!p) throw new HttpError(404, `Không tìm thấy "${ref}" trong MO Routing`);
  return p;
}

async function history(t0) {
  try {
    const t = await load(['transfer']);
    return t.transfer.rows.slice(-30).reverse();
  } catch { return null; } // chưa có tab Transfer
}

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://x');
    const { acc, t } = await requireUser(req, TABLES);
    if (!canTransfer(acc)) throw new HttpError(403, 'Chỉ thống kê hoặc quản lý được chuyển LSX');
    const m = model(t);
    const sums = logged(t);
    const ref = url.searchParams.get('ref');
    if (!ref) return send(res, 200, { history: await history(t) });
    const p = findPart(m, ref);
    const candidates = [...m.parts.values()]
      .filter((x) => x.bomLine === p.bomLine && x.ref !== p.ref)
      .sort((a, b) => a.ref.localeCompare(b.ref))
      .map((x) => partView(x, sums));
    send(res, 200, { part: partView(p, sums), candidates, allowed: p.level === 'CT' });
  },

  async POST(req, res) {
    const body = await readBody(req);
    const { acc, t } = await requireUser(req, TABLES, ['pallet_log']);
    if (!canTransfer(acc)) throw new HttpError(403, 'Chỉ thống kê hoặc quản lý được chuyển LSX');
    const m = model(t);
    const src = findPart(m, body.from);
    const dst = findPart(m, body.to);
    if (src.ref === dst.ref) throw new HttpError(400, 'LSX nguồn và đích trùng nhau');
    if (src.level !== 'CT' || dst.level !== 'CT') throw new HttpError(400, 'Giai đoạn này chỉ chuyển được chi tiết (không chuyển cụm/SP)');
    if (!src.bomLine || src.bomLine !== dst.bomLine) throw new HttpError(400, 'Chỉ chuyển được giữa 2 LSX có cùng BOM (bom_line_id)');

    const qty = Number(body.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, 'SL chuyển phải là số nguyên ≥ 1');
    const upTo = Number(body.up_to);
    const steps = src.steps.filter((s) => s.no <= upTo);
    if (!steps.length || !src.steps.some((s) => s.no === upTo)) throw new HttpError(400, 'Chọn công đoạn chuyển đến');
    const reason = String(body.reason || '').trim();
    if (reason.length < 3) throw new HttpError(400, 'Nhập lý do chuyển');

    const sums = logged(t);
    const pairs = [];
    const warnings = [];
    for (const s of steps) {
      const d = dst.steps.find((x) => x.no === s.no);
      if (!d || d.stage !== s.stage) throw new HttpError(400, `Routing 2 LSX khác nhau ở công đoạn ${s.no}. ${s.stage}`);
      const have = sums.get(s.id) || 0;
      if (have < qty) throw new HttpError(400, `${s.stage}: LSX nguồn mới ghi ${have}, không đủ ${qty} để chuyển`);
      const after = (sums.get(d.id) || 0) + qty;
      if (d.required && after > d.required) warnings.push(`${s.stage}: LSX đích sau khi nhận ${after} > SL yêu cầu ${d.required}`);
      pairs.push([s, d]);
    }
    if (warnings.length && body.confirm !== true) return send(res, 409, { error: 'Cần xác nhận', warnings });

    // Kiểm tra tab Transfer có sẵn TRƯỚC khi ghi Pallet Log
    let tt;
    try { tt = await load(['transfer'], ['transfer']); } catch { throw new HttpError(500, 'Sheet chưa có tab "Transfer" – liên hệ quản trị'); }

    const id = newId();
    const { stamp, date } = vnNow();
    const row = (s, q, note) => ({
      log_id: newId(), pallet_id: '', mo_route_id: s.id, work_date: date, start_time: '', end_time: '',
      worker: '', qty: q, qty_ng: '', note: textCell(note, 300), created_by: acc.email, created_at: stamp,
    });
    await appendObjects('pallet_log', t.pallet_log.header, pairs.flatMap(([s, d]) => [
      row(s, -qty, `${TRANSFER_PREFIX}${id} → ${dst.moNo} (${dst.ref}) – ${reason}`),
      row(d, qty, `${TRANSFER_PREFIX}${id} ← ${src.moNo} (${src.ref}) – ${reason}`),
    ]));
    await appendObjects('transfer', tt.transfer.header, [{
      transfer_id: id, from_part_ref: src.ref, to_part_ref: dst.ref, bom_line_id: src.bomLine,
      up_to_step: upTo, qty, reason: textCell(reason, 300), created_by: acc.email, created_at: stamp,
    }]);
    send(res, 200, { ok: true, transfer_id: id, message: `Đã chuyển ${qty} ${src.name} sang ${dst.moNo}` });
  },
});
