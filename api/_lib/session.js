// Đăng nhập Google (ID token từ Google Identity Services) + cookie phiên ký HMAC.
import crypto from 'node:crypto';
import { HttpError } from './util.js';
import { load, accessOf } from './data.js';

const COOKIE = 'tk_sess';
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 12;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError(500, 'Chưa cấu hình SESSION_SECRET (≥ 32 ký tự)');
  return s;
}

/* ---------- Xác thực ID token của Google ---------- */

let jwks = null; // { keys, exp }

async function googleKeys(force) {
  if (!force && jwks && jwks.exp > Date.now()) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new HttpError(502, 'Không tải được khoá xác thực của Google');
  const j = await r.json();
  const age = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  jwks = { keys: j.keys || [], exp: Date.now() + (age ? Number(age[1]) : 3600) * 1000 };
  return jwks.keys;
}

export async function verifyGoogleIdToken(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new HttpError(500, 'Chưa cấu hình GOOGLE_CLIENT_ID');
  const parts = String(credential || '').split('.');
  if (parts.length !== 3) throw new HttpError(400, 'Token đăng nhập không hợp lệ');
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw new HttpError(400, 'Token đăng nhập không hợp lệ'); }
  if (header.alg !== 'RS256') throw new HttpError(400, 'Token đăng nhập không hợp lệ');

  let jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, 'Không tìm thấy khoá ký của token');

  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'),
  );
  const now = Date.now() / 1000;
  if (!ok) throw new HttpError(401, 'Chữ ký token không hợp lệ');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new HttpError(401, 'Token không do Google cấp');
  if (payload.aud !== clientId) throw new HttpError(401, 'Token không dành cho ứng dụng này');
  if (!(payload.exp > now - 60)) throw new HttpError(401, 'Token đã hết hạn, hãy đăng nhập lại');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new HttpError(401, 'Email Google chưa được xác minh');

  const email = String(payload.email || '').toLowerCase();
  const domain = (process.env.ALLOWED_DOMAIN || '').toLowerCase().replace(/^@/, '');
  if (domain && !email.endsWith(`@${domain}`)) throw new HttpError(403, `Chỉ chấp nhận email @${domain}`);
  return { email, name: payload.name || email, picture: payload.picture || '' };
}

/* ---------- Cookie phiên ---------- */

const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

export function sessionCookie(user) {
  const data = Buffer.from(JSON.stringify({
    e: user.email, n: user.name, p: user.picture, x: Date.now() + SESSION_HOURS * 3600_000,
  })).toString('base64url');
  return `${COOKIE}=${data}.${sign(data)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readCookie(req) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}

export function sessionOf(req) {
  const v = readCookie(req);
  const i = v.lastIndexOf('.');
  if (i < 1) return null;
  const data = v.slice(0, i);
  const a = Buffer.from(v.slice(i + 1));
  const b = Buffer.from(sign(data));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!(s.x > Date.now())) return null;
    return { email: s.e, name: s.n, picture: s.p };
  } catch { return null; }
}

/**
 * Bắt buộc đăng nhập + còn hiệu lực trong tab Users (kiểm lại mỗi request,
 * nên khoá tài khoản trong Sheet có tác dụng sau tối đa ~1 phút).
 */
export async function requireUser(req, extraTables = [], fresh = []) {
  const s = sessionOf(req);
  if (!s) throw new HttpError(401, 'Chưa đăng nhập');
  const t = await load(['users', 'to', 'works', ...extraTables], fresh);
  const acc = accessOf(s.email, t);
  if (!acc) throw new HttpError(403, 'Tài khoản chưa được cấp quyền hoặc đã bị khoá trong tab Users');
  return { acc: { ...acc, picture: s.picture }, t };
}
