// Gọi Google Sheets API bằng Service Account (không dùng thư viện ngoài).
import crypto from 'node:crypto';
import { HttpError, env } from './util.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const sheetId = () => env('SHEET_ID') || '1VVW7Zrdw-KmO2HLIh1nchKE8DRGWDtd2hCrS-e_aKUU';

function credentials() {
  if (env('GOOGLE_SERVICE_ACCOUNT_JSON')) {
    try {
      const j = JSON.parse(env('GOOGLE_SERVICE_ACCOUNT_JSON'));
      return { email: j.client_email, key: j.private_key };
    } catch {
      throw new HttpError(500, 'GOOGLE_SERVICE_ACCOUNT_JSON không phải JSON hợp lệ');
    }
  }
  const email = env('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  const key = env('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n');
  if (!email || !key) throw new HttpError(500, 'Chưa cấu hình Service Account (xem README)');
  return { email, key };
}

let token = null; // { value, exp }

async function accessToken() {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const { email, key } = credentials();
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Không lấy được token Google: ${j.error_description || j.error || r.status}`);
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function call(path, init = {}) {
  const r = await fetch(`${API}/${sheetId()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || `HTTP ${r.status}`;
    if (r.status === 403) throw new HttpError(502, `Service Account chưa được chia sẻ quyền Sheet: ${msg}`);
    if (r.status === 429) throw new HttpError(503, 'Google Sheets đang giới hạn tần suất, thử lại sau ít giây');
    throw new HttpError(502, `Google Sheets lỗi: ${msg}`);
  }
  return j;
}

const q = (sheet) => `'${sheet.replace(/'/g, "''")}'`;

/** Đọc nhiều tab trong 1 lần gọi → [[row...], ...] theo thứ tự tên tab. */
export async function batchGet(sheets) {
  const params = new URLSearchParams({ valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' });
  for (const s of sheets) params.append('ranges', q(s));
  const j = await call(`/values:batchGet?${params}`);
  return (j.valueRanges || []).map((v) => v.values || []);
}

/** Thêm dòng vào cuối tab. */
export async function append(sheet, rows) {
  const params = new URLSearchParams({ valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
  return call(`/values/${encodeURIComponent(`${q(sheet)}!A1`)}:append?${params}`, {
    method: 'POST',
    body: JSON.stringify({ values: rows }),
  });
}

/** Ghi nhiều ô: data = [{ range: "A1 notation (không gồm tên tab)", value }]. */
export async function updateCells(sheet, data) {
  return call('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: data.map((d) => ({ range: `${q(sheet)}!${d.range}`, values: [[d.value]] })),
    }),
  });
}
