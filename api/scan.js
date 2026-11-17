// GET /api/scan?code=<part_ref>-<mã tổ>[&log=1]
// Trả thông tin chi tiết / cụm / sản phẩm + công đoạn của tổ, pallet, nhật ký.
// log=1: ghi 1 dòng vào tab Scan (chỉ khi thật sự quét, không ghi khi tải lại).
import { handler, send, newId, vnNow } from './_lib/util.js';
import { appendObjects } from './_lib/data.js';
import { requireUser } from './_lib/session.js';
import { buildContext, SCAN_TABLES } from './_lib/domain.js';

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://x');
    const code = url.searchParams.get('code');
    const { acc, t } = await requireUser(req, [...SCAN_TABLES, 'scan']);
    const ctx = buildContext(t, acc, code);

    if (url.searchParams.get('log') === '1' && ctx.teamSteps.length) {
      try {
        await appendObjects('scan', t.scan.header, [{
          scan_id: newId(), mo_route_id: ctx.teamSteps[0].id, scanned_by: acc.email, scanned_at: vnNow().stamp,
        }]);
      } catch (err) { console.error('Ghi Scan lỗi', err); } // không chặn người dùng
    }
    send(res, 200, ctx);
  },
});
