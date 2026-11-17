// POST /api/output
//   { action: "add", code, pallet_id | new_pallet:{no, lot_go, lot_dau}, work_date:"YYYY-MM-DD",
//     worker, note, entries:[{ id: mo_route_id, qty, ng }], confirm }
//   { action: "cancel", code, log_id }
// Ghi vào tab Pallet Log (và Pallet khi tạo pallet mới). Chỉ nhận công đoạn của chi tiết
// thuộc đúng tổ trong mã QR → không thể nhập lẫn nhiều tổ trong 1 lần.
import { handler, send, readBody, HttpError, newId, vnNow, textCell, norm, num, parseDay, isoToVn, daysBetween } from './_lib/util.js';
import { load, appendObjects } from './_lib/data.js';
import { requireUser } from './_lib/session.js';
import { buildContext, SCAN_TABLES, CANCEL_PREFIX } from './_lib/domain.js';

const MAX_QTY = 100_000;
const BACKDATE = () => Number(process.env.MAX_BACKDATE_DAYS ?? 7);

export default handler({
  async POST(req, res) {
    const body = await readBody(req);
    const { acc, t } = await requireUser(req, SCAN_TABLES, ['pallet', 'pallet_log']);
    const ctx = buildContext(t, acc, body.code);
    if (!ctx.team) throw new HttpError(400, 'Mã QR thiếu mã tổ, không thể nhập sản lượng');
    if (!ctx.canWrite) throw new HttpError(403, `Bạn không có quyền nhập sản lượng cho ${ctx.team.name}`);

    if (body.action === 'cancel') await cancel(body, ctx, acc, t);
    else if (body.action === 'add') {
      const r = await add(body, ctx, acc, t);
      if (r) return send(res, 409, r); // cần xác nhận cảnh báo
    } else throw new HttpError(400, 'action không hợp lệ');

    const t2 = await load([...SCAN_TABLES, 'users', 'to', 'works'], ['pallet', 'pallet_log']);
    send(res, 200, { ok: true, context: buildContext(t2, acc, body.code) });
  },
});

function toInt(v, label) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_QTY) throw new HttpError(400, `${label}: số lượng phải là số nguyên từ 0 đến ${MAX_QTY}`);
  return n;
}

async function add(body, ctx, acc, t) {
  // ----- Công đoạn & số lượng -----
  const stepById = new Map(ctx.teamSteps.map((s) => [s.id, s]));
  const seen = new Set();
  const entries = [];
  for (const e of Array.isArray(body.entries) ? body.entries : []) {
    const s = stepById.get(e?.id);
    if (!s) throw new HttpError(400, `Công đoạn "${e?.id}" không thuộc ${ctx.part.name} tại ${ctx.team.name}`);
    if (seen.has(s.id)) throw new HttpError(400, `Công đoạn ${s.stage} bị lặp`);
    seen.add(s.id);
    const qty = toInt(e.qty, s.stage);
    const ng = toInt(e.ng, `${s.stage} (NG)`);
    if (ng && !ctx.hasNg) throw new HttpError(400, 'Tab Pallet Log chưa có cột qty_ng để ghi hàng NG');
    if (qty || ng) entries.push({ s, qty, ng });
  }
  if (!entries.length) throw new HttpError(400, 'Chưa nhập số lượng cho công đoạn nào');
  entries.sort((a, b) => a.s.no - b.s.no);

  // ----- Ngày làm -----
  const today = vnNow().iso;
  const day = parseDay(body.work_date) || today;
  const back = daysBetween(day, today);
  if (back < 0) throw new HttpError(400, 'Không được nhập cho ngày trong tương lai');
  if (!acc.admin && back > BACKDATE()) throw new HttpError(400, `Chỉ được nhập lùi tối đa ${BACKDATE()} ngày`);

  // ----- Pallet -----
  let pallet = null;
  let newPallet = null;
  if (body.pallet_id) {
    pallet = ctx.pallets.find((p) => p.id === body.pallet_id);
    if (!pallet) throw new HttpError(400, 'Pallet không thuộc chi tiết/tổ này');
    if (pallet.closed) throw new HttpError(400, `Pallet ${pallet.no} đã đóng (${pallet.status})`);
  } else {
    const no = String(body.new_pallet?.no || '').trim();
    if (!no) throw new HttpError(400, 'Chọn pallet hoặc nhập số pallet mới');
    if (no.length > 30) throw new HttpError(400, 'Số pallet tối đa 30 ký tự');
    const dup = ctx.pallets.find((p) => norm(p.no) === norm(no));
    if (dup) throw new HttpError(400, `Pallet "${no}" đã có${dup.closed ? ' (đã đóng)' : ''} – hãy chọn trong danh sách`);
    newPallet = {
      pallet_id: newId(), mo_route_id: entries[0].s.id, pallet_no: textCell(no, 30),
      lot_go: textCell(body.new_pallet?.lot_go, 50), lot_dau: textCell(body.new_pallet?.lot_dau, 50),
      status: 'Đang làm', note: '', created_by: acc.email, created_at: vnNow().stamp,
    };
  }

  // ----- Cảnh báo (cần xác nhận) -----
  const batchQty = new Map(entries.map((e) => [e.s.id, e.qty]));
  const warnings = [];
  for (const { s, qty } of entries) {
    const total = s.done + qty;
    if (s.required && total > s.required) {
      warnings.push(`${s.stage}: tổng sau khi nhập ${total} > SL yêu cầu ${s.required}`);
    }
    if (s.prevId && qty) {
      const avail = (s.prevDone || 0) + (batchQty.get(s.prevId) || 0);
      if (total > avail) warnings.push(`${s.stage}: tổng ${total} > số đã xong ở công đoạn trước "${s.prevStage}" (${avail})`);
    }
  }
  if (warnings.length && body.confirm !== true) return { error: 'Cần xác nhận', warnings };

  // ----- Ghi -----
  const now = vnNow().stamp;
  const palletId = pallet?.id || newPallet.pallet_id;
  if (newPallet) await appendObjects('pallet', t.pallet.header, [newPallet]);
  await appendObjects('pallet_log', t.pallet_log.header, entries.map(({ s, qty, ng }) => ({
    log_id: newId(), pallet_id: palletId, mo_route_id: s.id, work_date: isoToVn(day),
    start_time: '', end_time: '', worker: textCell(body.worker, 100), qty, qty_ng: ng || '',
    // Ghi chú người dùng không được giả dạng dòng huỷ
    note: textCell(String(body.note || '').replace(/^\s*huỷ\s/i, '- '), 300), created_by: acc.email, created_at: now,
  })));
  return null;
}

async function cancel(body, ctx, acc, t) {
  const ids = new Set(ctx.teamSteps.map((s) => s.id));
  const log = t.pallet_log.rows.find((l) => l.log_id && l.log_id === body.log_id && ids.has(l.mo_route_id));
  if (!log) throw new HttpError(404, 'Không tìm thấy dòng nhật ký của chi tiết/tổ này');
  if (String(log.note).startsWith(CANCEL_PREFIX)) throw new HttpError(400, 'Đây là dòng huỷ, không huỷ tiếp được');
  if (t.pallet_log.rows.some((l) => String(l.note).startsWith(`${CANCEL_PREFIX}${log.log_id}`))) {
    throw new HttpError(400, 'Dòng này đã được huỷ trước đó');
  }
  const mine = String(log.created_by).toLowerCase() === acc.email;
  if (!acc.admin && !(mine && parseDay(log.created_at) === vnNow().iso)) {
    throw new HttpError(403, 'Chỉ người nhập được huỷ trong ngày; quá hạn cần quản lý huỷ');
  }
  // Không xoá dòng cũ: ghi 1 dòng âm để giữ lịch sử (báo cáo cộng dồn sẽ tự trừ đúng ngày).
  const day = parseDay(log.work_date);
  await appendObjects('pallet_log', t.pallet_log.header, [{
    log_id: newId(), pallet_id: log.pallet_id, mo_route_id: log.mo_route_id,
    work_date: day ? isoToVn(day) : log.work_date, start_time: '', end_time: '',
    worker: textCell(log.worker, 100), qty: -num(log.qty), qty_ng: num(log.qty_ng) ? -num(log.qty_ng) : '',
    note: textCell(`${CANCEL_PREFIX}${log.log_id} – ${acc.name}`, 300),
    created_by: acc.email, created_at: vnNow().stamp,
  }]);
}
