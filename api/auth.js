// GET  /api/auth  → { clientId, user | null }
// POST /api/auth  { credential } → đăng nhập bằng ID token Google
// DELETE /api/auth → đăng xuất
import { handler, send, readBody, HttpError, env } from './_lib/util.js';
import { load, accessOf, teamList } from './_lib/data.js';
import { verifyGoogleIdToken, sessionCookie, clearCookie, sessionOf } from './_lib/session.js';

const view = (acc, t, picture) => ({ ...acc, picture: picture || '', teamList: teamList(t) });

export default handler({
  async GET(req, res) {
    const clientId = env('GOOGLE_CLIENT_ID');
    const s = sessionOf(req);
    if (!s) return send(res, 200, { clientId, user: null });
    const t = await load(['users', 'to', 'works']);
    const acc = accessOf(s.email, t);
    if (!acc) {
      return send(res, 200, { clientId, user: null, error: 'Tài khoản đã bị khoá hoặc chưa được cấp quyền' }, { 'Set-Cookie': clearCookie() });
    }
    send(res, 200, { clientId, user: view(acc, t, s.picture) });
  },

  async POST(req, res) {
    const { credential } = await readBody(req);
    const g = await verifyGoogleIdToken(credential);
    const t = await load(['users', 'to', 'works'], ['users']);
    const acc = accessOf(g.email, t);
    if (!acc) throw new HttpError(403, `Email ${g.email} chưa có trong tab Users hoặc chưa được kích hoạt (active = TRUE). Liên hệ quản trị.`);
    send(res, 200, { user: view(acc, t, g.picture) }, { 'Set-Cookie': sessionCookie({ ...g, name: acc.name }) });
  },

  async DELETE(req, res) {
    send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  },
});
