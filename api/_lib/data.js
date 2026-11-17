// Đọc các tab Sheet thành mảng object, có cache trong bộ nhớ function.
import { batchGet, append } from './google.js';
import { HttpError, norm, isTrue } from './util.js';

// ttl (giây): dữ liệu danh mục đổi ít → cache lâu; Pallet/Log đổi liên tục → cache ngắn.
export const TABLES = {
  mo_routing: { sheet: 'MO Routing', ttl: 120 },
  mo:         { sheet: 'MO', ttl: 600 },
  mo_detail:  { sheet: 'MO Detail', ttl: 600 },
  product:    { sheet: 'Product', ttl: 600 },
  bom_wood:   { sheet: 'BOM Wood', ttl: 600 },
  works:      { sheet: 'Works List', ttl: 600 },
  to:         { sheet: 'To', ttl: 120 },
  users:      { sheet: 'Users', ttl: 60 },
  pallet:     { sheet: 'Pallet', ttl: 10 },
  pallet_log: { sheet: 'Pallet Log', ttl: 10 },
  scan:       { sheet: 'Scan', ttl: 3600 }, // chỉ cần header để ghi
};

const cache = new Map();    // name -> { table, at }
const inflight = new Map(); // khoá theo danh sách tên -> Promise

function toTable(values) {
  const header = (values[0] || []).map((h) => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (!v || !v.some((c) => String(c).trim() !== '')) continue;
    const o = { _row: i + 1 };
    header.forEach((h, j) => { if (h) o[h] = v[j] === undefined ? '' : String(v[j]); });
    rows.push(o);
  }
  return { header, rows };
}

/** Lấy các bảng; `fresh` = danh sách bảng bắt buộc đọc lại (trước khi ghi/kiểm tra). */
export async function load(names, fresh = []) {
  const now = Date.now();
  const need = names.filter((n) => {
    const c = cache.get(n);
    return fresh.includes(n) || !c || now - c.at > TABLES[n].ttl * 1000;
  });
  if (need.length) {
    const key = need.slice().sort().join(',');
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        const values = await batchGet(need.map((n) => TABLES[n].sheet));
        need.forEach((n, i) => cache.set(n, { table: toTable(values[i]), at: Date.now() }));
      })().finally(() => inflight.delete(key)));
    }
    await inflight.get(key);
  }
  return Object.fromEntries(names.map((n) => [n, cache.get(n).table]));
}

export function invalidate(...names) { names.forEach((n) => cache.delete(n)); }

/** Ghi các object theo đúng thứ tự cột header hiện có của tab (cột không có trong header bị bỏ qua). */
export async function appendObjects(name, header, objs) {
  if (!header.length) throw new HttpError(500, `Tab "${TABLES[name].sheet}" chưa có dòng tiêu đề`);
  await append(TABLES[name].sheet, objs.map((o) => header.map((h) => (o[h] ?? ''))));
  invalidate(name);
}

/* ---------------- Tổ & phân quyền ---------------- */

// stage_group trong MO Routing → mã tổ in trên QR (giống app Thong_Ke_NSCN)
const GROUP_CODE = {
  'so che': 'SC', 'tinh che': 'TC', 'lap rap': 'LR',
  'dau': 'DM', 'dau mau': 'DM', 'son': 'DM',
  'dong goi': 'DG', 'bao bi': 'DG',
};

export function teamCoder(t) {
  const byWork = new Map(t.works.rows.map((w) => [norm(w.work_name), teamIdToCode(w.team_id)]));
  return (r) => GROUP_CODE[norm(r.stage_group)] || byWork.get(norm(r.stage)) || '';
}

export const teamIdToCode = (id) => String(id || '').trim().replace(/^T-/i, '').toUpperCase();

export function teamList(t) {
  const list = t.to.rows
    .filter((r) => r.team_id)
    .map((r) => ({ code: teamIdToCode(r.team_id), name: r.team_name || r.team_id }));
  for (const code of new Set(Object.values(GROUP_CODE))) {
    if (!list.some((x) => x.code === code)) list.push({ code, name: code });
  }
  return list;
}

const ADMIN_ROLES = ['admin', 'quan tri', 'ky thuat', 'quan doc', 'quan ly', 'giam doc'];
const VIEW_ROLES = ['xem', 'chi xem', 'viewer'];
const splitEmails = (s) => String(s || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);

/**
 * Quyền của 1 email, theo tab Users (email, full_name, role, active[, teams])
 * và tab To (manager_email, thong_ke_emails). null = không được vào app.
 */
export function accessOf(email, t) {
  email = String(email || '').toLowerCase();
  const u = t.users.rows.find((r) => String(r.email).trim().toLowerCase() === email);
  if (!u || !isTrue(u.active)) return null;
  const rn = norm(u.role);
  const admin = ADMIN_ROLES.some((a) => rn === a || rn.startsWith(`${a} `));
  const viewOnly = VIEW_ROLES.includes(rn);
  const teams = new Set();
  if (admin) teamList(t).forEach((x) => teams.add(x.code));
  for (const r of t.to.rows) {
    const emails = [...splitEmails(r.manager_email), ...splitEmails(r.thong_ke_emails)];
    if (emails.includes(email)) teams.add(teamIdToCode(r.team_id));
  }
  // Cột tuỳ chọn "teams" trong Users: VD "SC, TC" hoặc "T-SC"
  String(u.teams || '').split(/[\s,;]+/).filter(Boolean).forEach((c) => teams.add(teamIdToCode(c)));
  return {
    email,
    name: u.full_name || email,
    role: u.role || '',
    admin,
    viewOnly,
    teams: [...teams],
  };
}

export const canWrite = (acc, team) => !!acc && !acc.viewOnly && (acc.admin || acc.teams.includes(team));
