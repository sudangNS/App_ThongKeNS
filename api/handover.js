// Giao nhận pallet giữa các tổ.
// GET  /api/handover            → việc của tôi: cần nhận / cần giao / đã giao chờ nhận / pallet bị trả lại / pallet đang mở (thống kê)
// GET  /api/handover?count=1    → chỉ số pallet chờ tôi nhận (cho nút chuông)
// POST /api/handover { action: "deliver" | "receive" | "return", pallet_id, reason }
//   deliver: tổ trưởng tổ đang giữ pallet → "Chờ nhận"
//   receive: tổ trưởng tổ nhận → "Đã nhận" (+ tạo pallet mới tại tổ nhận nếu là công đoạn kế của cùng chi tiết)
//   return : tổ trưởng tổ nhận trả lại (bắt buộc lý do) → "Trả lại", pallet về lại tổ giao
// Chỉ nhận đủ SL hoặc trả lại (không sửa SL khi nhận).
import { handler, send, readBody, HttpError, newId, vnNow, textCell, colLetter } from './_lib/util.js';
import { load, appendObjects, invalidate, canLead } from './_lib/data.js';
import { updateCells } from './_lib/google.js';
import { requireUser } from './_lib/session.js';
import { model, palletFlow, palletBrief, ST } from './_lib/flow.js';

const FLOW_TABLES = ['mo_routing', 'mo', 'mo_detail', 'bom_wood', 'pallet', 'pallet_log'];

function lists(acc, flow) {
  const view = (f) => palletBrief(f);
  const lead = new Set(acc.leadTeams);
  const stat = new Set(acc.statTeams);
  const inbox = flow.filter((f) => f.state === 'waiting' && f.dest && lead.has(f.dest.team));
  const toDeliver = flow.filter((f) => f.state === 'open' && f.dest && f.qtyOut > 0 && lead.has(f.team));
  const sent = flow.filter((f) => f.state === 'waiting' && lead.has(f.team));
  const returned = flow.filter((f) => f.state === 'open' && f.returned && (lead.has(f.team) || stat.has(f.team)));
  const open = flow.filter((f) => f.state === 'open' && stat.has(f.team));
  const byAge = (a, b) => b.ageDays - a.ageDays;
  return {
    inbox: inbox.sort(byAge).map(view),
    toDeliver: toDeliver.sort(byAge).map(view),
    sent: sent.sort(byAge).map(view),
    returned: returned.map(view),
    open: open.sort(byAge).slice(0, 200).map(view),
  };
}

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://x');
    const { acc, t } = await requireUser(req, FLOW_TABLES);
    const flow = palletFlow(t, model(t));
    const lead = new Set(acc.leadTeams);
    const inboxCount = flow.filter((f) => f.state === 'waiting' && f.dest && lead.has(f.dest.team)).length;
    if (url.searchParams.get('count') === '1') return send(res, 200, { inbox: inboxCount });
    send(res, 200, { inboxCount, ...lists(acc, flow) });
  },

  async POST(req, res) {
    const body = await readBody(req);
    // Luôn đọc mới Pallet + Pallet Log trước khi ghi để tránh 2 người cùng thao tác 1 pallet
    const { acc, t } = await requireUser(req, FLOW_TABLES, ['pallet', 'pallet_log']);
    const m = model(t);
    const f = palletFlow(t, m).find((x) => x.id === body.pallet_id);
    const row = t.pallet.rows.find((r) => r.pallet_id === body.pallet_id);
    if (!f || !row) throw new HttpError(404, 'Không tìm thấy pallet');

    const h = t.pallet.header;
    const cell = (name, value) => {
      const i = h.indexOf(name);
      return i < 0 ? null : { range: `${colLetter(i)}${row._row}`, value };
    };
    const now = vnNow().stamp;
    let msg;

    if (body.action === 'deliver') {
      if (!canLead(acc, f.team)) throw new HttpError(403, `Chỉ tổ trưởng ${f.teamName} được giao pallet này`);
      if (f.state !== 'open') throw new HttpError(400, `Pallet đang ở trạng thái "${f.status}"`);
      if (!f.dest) throw new HttpError(400, 'Chi tiết đã xong công đoạn cuối, không cần giao – dùng "Hoàn thành"');
      if (!(f.qtyOut > 0)) throw new HttpError(400, `Pallet chưa có SL ở công đoạn ra tổ "${f.exitStage}"`);
      await updateCells('Pallet', [cell('status', ST.WAIT), cell('closed_at', now), cell('closed_by', acc.email)].filter(Boolean));
      msg = `Đã giao ${f.qtyOut} cho ${f.dest.teamName}`;
    } else if (body.action === 'receive') {
      if (f.state !== 'waiting' || !f.dest) throw new HttpError(400, `Pallet đang ở trạng thái "${f.status}", không ở chờ nhận`);
      if (!canLead(acc, f.dest.team)) throw new HttpError(403, `Chỉ tổ trưởng ${f.dest.teamName} được nhận pallet này`);
      await updateCells('Pallet', [cell('status', ST.RECEIVED), cell('received_at', now), cell('received_by', acc.email)].filter(Boolean));
      // Cùng chi tiết đi tiếp sang tổ sau → pallet mới tại tổ nhận, nối với pallet giao (from_pallet_id, qty_in)
      if (f.dest.kind === 'next') {
        await appendObjects('pallet', h, [{
          pallet_id: newId(), mo_route_id: f.dest.stepId, pallet_no: textCell(f.no, 30),
          lot_go: textCell(f.lot_go, 50), lot_dau: textCell(f.lot_dau, 50), status: ST.OPEN, note: '',
          created_by: acc.email, created_at: now, from_pallet_id: f.id, qty_in: f.qtyOut,
        }]);
      }
      msg = `Đã nhận ${f.qtyOut} từ ${f.teamName}`;
    } else if (body.action === 'return') {
      if (f.state !== 'waiting' || !f.dest) throw new HttpError(400, `Pallet đang ở trạng thái "${f.status}", không ở chờ nhận`);
      if (!canLead(acc, f.dest.team)) throw new HttpError(403, `Chỉ tổ trưởng ${f.dest.teamName} được trả lại pallet này`);
      const reason = String(body.reason || '').trim();
      if (reason.length < 3) throw new HttpError(400, 'Nhập lý do trả lại');
      const note = [String(row.note || '').trim(), `TRẢ LẠI ${now.slice(0, 16)} – ${acc.name}: ${reason}`].filter(Boolean).join(' | ');
      await updateCells('Pallet', [cell('status', ST.RETURNED), cell('closed_at', ''), cell('closed_by', ''), cell('note', textCell(note, 500))].filter(Boolean));
      msg = `Đã trả lại pallet cho ${f.teamName}`;
    } else throw new HttpError(400, 'action không hợp lệ');

    invalidate('pallet');
    const t2 = await load(['users', 'to', 'works', ...FLOW_TABLES], ['pallet']);
    const flow = palletFlow(t2, model(t2));
    const inboxCount = flow.filter((x) => x.state === 'waiting' && x.dest && acc.leadTeams.includes(x.dest.team)).length;
    send(res, 200, { ok: true, message: msg, inboxCount, ...lists(acc, flow) });
  },
});
