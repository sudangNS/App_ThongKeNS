// GET /api/health → kiểm tra cấu hình (chỉ trả có/không, không lộ giá trị) và quyền đọc Sheet.
import { handler, send, env } from './_lib/util.js';
import { load } from './_lib/data.js';

export default handler({
  async GET(req, res) {
    const config = {
      GOOGLE_CLIENT_ID: !!env('GOOGLE_CLIENT_ID'),
      SERVICE_ACCOUNT: !!(env('GOOGLE_SERVICE_ACCOUNT_JSON') || (env('GOOGLE_SERVICE_ACCOUNT_EMAIL') && env('GOOGLE_PRIVATE_KEY'))),
      SESSION_SECRET: env('SESSION_SECRET').length >= 32,
      ALLOWED_DOMAIN: env('ALLOWED_DOMAIN') || null,
    };
    let sheet = 'chưa kiểm tra (thiếu Service Account)';
    if (config.SERVICE_ACCOUNT) {
      try {
        const t = await load(['users', 'to']);
        sheet = `OK – Users: ${t.users.rows.length} dòng, To: ${t.to.rows.length} dòng`;
      } catch (err) { sheet = `LỖI – ${err.message}`; }
    }
    const ok = config.GOOGLE_CLIENT_ID && config.SERVICE_ACCOUNT && config.SESSION_SECRET && sheet.startsWith('OK');
    send(res, 200, { ok, config, sheet, region: process.env.VERCEL_REGION || null });
  },
});
