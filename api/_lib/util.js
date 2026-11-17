// Tiện ích dùng chung cho các API.
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/** Bọc handler: bắt lỗi, trả JSON thống nhất. */
export function handler(methods) {
  return async (req, res) => {
    try {
      const fn = methods[req.method];
      if (!fn) throw new HttpError(405, 'Phương thức không được hỗ trợ');
      if (req.method !== 'GET') checkOrigin(req);
      await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      send(res, status, { error: err.message || 'Lỗi máy chủ', ...(err.extra || {}) });
    }
  };
}

/** Chặn request ghi đến từ trang khác (CSRF). */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Origin không hợp lệ'); }
  const fwd = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (host !== fwd) throw new HttpError(403, 'Request không cùng nguồn');
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length > 100_000) throw new HttpError(413, 'Dữ liệu gửi lên quá lớn');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'JSON không hợp lệ'); }
}

/** Chuẩn hoá để so sánh: bỏ dấu, chữ thường, gộp khoảng trắng. */
export function norm(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Đọc số theo định dạng Sheet vi_VN ("0,030656", "1.216,5"). */
export function num(s) {
  if (typeof s === 'number') return s;
  s = String(s ?? '').trim();
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export const isTrue = (v) => ['true', '1', 'x', 'yes', 'co', 'y'].includes(norm(v));

const pad2 = (n) => String(n).padStart(2, '0');

/** Giờ Việt Nam hiện tại. */
export function vnNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return {
    iso: `${p.year}-${p.month}-${p.day}`,
    date: `${p.day}/${p.month}/${p.year}`,
    stamp: `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`,
  };
}

/** "2026-11-17" | "17/11/2026" | "17/11/2026 08:00:00" → "2026-11-17" ('' nếu sai). */
export function parseDay(s) {
  s = String(s ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  return '';
}

export const isoToVn = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

export function daysBetween(isoA, isoB) {
  return Math.round((Date.parse(isoB + 'T00:00:00Z') - Date.parse(isoA + 'T00:00:00Z')) / 86_400_000);
}

/**
 * Mã 8 ký tự hex như dữ liệu sẵn có. Loại các mã Sheet có thể tự đổi thành số
 * khi ghi USER_ENTERED (VD "12345678", "12e45678").
 */
export function newId() {
  for (;;) {
    const id = crypto.randomBytes(4).toString('hex');
    if (!/^\d*e?\d*$/.test(id)) return id;
  }
}

/** Ô chữ do người dùng nhập: thêm ' để Sheet giữ nguyên dạng chữ và không chạy công thức. */
export function textCell(s, max = 200) {
  const v = String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  return v ? `'${v}` : '';
}

export function colLetter(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
