// POST /api/pallet { code, pallet_id, action: "close" | "reopen" }
// Đóng pallet khi đã làm xong tại tổ (không nhận thêm sản lượng); mở lại chỉ dành cho quản lý.
import { handler, send, readBody, HttpError, vnNow, colLetter } from './_lib/util.js';
import { load, invalidate } from './_lib/data.js';
import { updateCells } from './_lib/google.js';
import { requireUser } from './_lib/session.js';
import { buildContext, SCAN_TABLES } from './_lib/domain.js';

export default handler({
  async POST(req, res) {
    const body = await readBody(req);
    const { acc, t } = await requireUser(req, SCAN_TABLES, ['pallet', 'pallet_log']);
    const ctx = buildContext(t, acc, body.code);
    if (!ctx.team || !ctx.canWrite) throw new HttpError(403, 'Bạn không có quyền với pallet của tổ này');

    const p = ctx.pallets.find((x) => x.id === body.pallet_id);
    const row = t.pallet.rows.find((r) => r.pallet_id === body.pallet_id);
    if (!p || !row) throw new HttpError(404, 'Không tìm thấy pallet');

    const h = t.pallet.header;
    const cell = (name, value) => {
      const i = h.indexOf(name);
      return i < 0 ? null : { range: `${colLetter(i)}${row._row}`, value };
    };
    let data;
    if (body.action === 'close') {
      if (p.closed) throw new HttpError(400, `Pallet đã ở trạng thái "${p.status}"`);
      data = [cell('status', 'Đã xong'), cell('closed_at', vnNow().stamp), cell('closed_by', acc.email)];
    } else if (body.action === 'reopen') {
      if (!acc.admin) throw new HttpError(403, 'Chỉ quản lý được mở lại pallet');
      if (!p.closed) throw new HttpError(400, 'Pallet đang mở');
      data = [cell('status', 'Đang làm'), cell('closed_at', ''), cell('closed_by', '')];
    } else throw new HttpError(400, 'action không hợp lệ');

    await updateCells('Pallet', data.filter(Boolean));
    invalidate('pallet');
    const t2 = await load([...SCAN_TABLES, 'users', 'to', 'works'], ['pallet']);
    send(res, 200, { ok: true, context: buildContext(t2, acc, body.code) });
  },
});
