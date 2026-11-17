// Google giả lập (token, JWKS, Sheets API) cho test – không gọi mạng thật.
import crypto from "node:crypto";

/* ---------- Dữ liệu Sheet giả (lấy từ cấu trúc thật) ---------- */
export const R_HEAD = ['mo_route_id', 'mo_id', 'detail_id', 'product_id', 'bom_id', 'bom_line_id', 'line_no', 'part_name', 'level', 'part_kind', 'part_ref', 'cum_ref', 'sp_ref', 'step_no', 'stage', 'stage_group', 'is_first_step', 'is_last_step', 'prev_stage', 'next_stage', 'qty_per_unit', 'mo_qty', 'qty_required', 'prerequisite', 'qty_done', 'status', 'updated_at', 'routing_id', 'created_at'];
export const P = 'LSX-02-1626-01';
const rt = (sfx, bomLine, name, level, kind, ref, cum, no, stage, group, per, req) =>
  [`${ref}-S0${no}`, 'LSX-02-1626', P, 'SP002', 'SP002-V1', bomLine, '', name, level, kind, ref, cum, `${P}-SP`, String(no), stage, group, '', '', '', '', String(per), '608', String(req), '', '0', 'Chưa làm', '', '', ''];
const ROUTING = [
  R_HEAD,
  rt('', 'SP002-V1-SP', 'Zamora Lounge Chair (SP)', 'SP', 'SP', `${P}-SP`, '', 1, 'Ráp thành phẩm', 'Lắp ráp', 1, 608),
  rt('', 'SP002-V1-SP', 'Zamora Lounge Chair (SP)', 'SP', 'SP', `${P}-SP`, '', 2, 'Đóng gói', 'Đóng gói', 1, 608),
  rt('', 'SP002-V1-W001', 'Cụm hông', 'CUM', 'CUM', `${P}-W001`, `${P}-W001`, 1, 'Lắp ráp', 'Lắp ráp', 2, 1216),
  rt('', 'SP002-V1-W001', 'Cụm hông', 'CUM', 'CUM', `${P}-W001`, `${P}-W001`, 2, 'Nhúng dầu', 'Dầu', 2, 1216),
  rt('', 'SP002-V1-W002', 'Tay ghế', 'CT', 'CT thuộc cụm', `${P}-W002`, `${P}-W001`, 1, 'Cắt thô', 'Sơ chế', 2, 1216),
  rt('', 'SP002-V1-W002', 'Tay ghế', 'CT', 'CT thuộc cụm', `${P}-W002`, `${P}-W001`, 2, 'Rong', 'Sơ chế', 2, 1216),
  rt('', 'SP002-V1-W002', 'Tay ghế', 'CT', 'CT thuộc cụm', `${P}-W002`, `${P}-W001`, 3, 'Bào 4 mặt', 'Tinh chế', 2, 1216),
  rt('', 'SP002-V1-W002', 'Tay ghế', 'CT', 'CT thuộc cụm', `${P}-W002`, `${P}-W001`, 4, 'Cắt tinh', 'Tinh chế', 2, 1216),
];

export const SHEETS = {
  'MO Routing': ROUTING,
  MO: [['mo_id', 'mo_no', 'customer', 'end_customer', 'due_date'], ['LSX-02-1626', '02/1626', '2 CONNECT', 'BOHUS', '2026-10-15']],
  'MO Detail': [['detail_id', 'mo_id', 'lsx_stt', 'product_id', 'product_code', 'product_name', 'unit', 'qty', 'due_date'],
    [P, 'LSX-02-1626', '1', 'SP002', '107-900-0003', 'Zamora Lounge Chair (Bohus)', 'Cái', '608', '2026-09-25']],
  Product: [['product_id', 'product_code', 'bom_product_code', 'product_name', 'product_name_vi', 'wood_type', 'size', 'unit'],
    ['SP002', '107-900-0003', '165698559-C3S', 'Zamora Lounge Chair (Bohus)', 'Ghế Zamora 3 chỗ', 'Tràm FSC 100%', '1990x750x780', 'Cái']],
  'BOM Wood': [['bom_line_id', 'part_code', 'part_name', 'thick_mm', 'width_mm', 'length_mm', 'material'],
    ['SP002-V1-W002', '165698559-C3S-01-01', 'Tay ghế', '30', '60', '700', 'Acacia']],
  'Works List': [['work_id', 'work_name', 'stage', 'stage_order', 'note', 'team_id'], ['SC01', 'Cắt thô', 'Sơ chế', '1', '', 'T-SC']],
  To: [['team_id', 'team_name', 'manager_email', 'note', 'thong_ke_emails'],
    ['T-SC', 'Tổ Sơ chế', 'boss@ns.vn', '', 'tk.sc@ns.vn'], ['T-TC', 'Tổ Tinh chế', 'boss@ns.vn'], ['T-LR', 'Tổ Lắp ráp', ''],
    ['T-DM', 'Tổ Dầu màu', ''], ['T-DG', 'Tổ Đóng gói', '']],
  Users: [['email', 'full_name', 'role', 'active', 'note'],
    ['admin@ns.vn', 'Sự', 'Kỹ thuật', 'TRUE'], ['tk.sc@ns.vn', 'TK Sơ chế', 'Thống kê', 'TRUE'],
    ['tk.lr@ns.vn', 'TK Lắp ráp', 'Thống kê', 'TRUE'], ['off@ns.vn', 'Nghỉ', 'Thống kê', 'FALSE']],
  Pallet: [['pallet_id', 'mo_route_id', 'pallet_no', 'lot_go', 'lot_dau', 'status', 'note', 'created_by', 'created_at', 'from_pallet_id', 'closed_at', 'qty_in', 'closed_by', 'received_by', 'received_at']],
  'Pallet Log': [['log_id', 'pallet_id', 'mo_route_id', 'work_date', 'start_time', 'end_time', 'worker', 'qty', 'note', 'created_by', 'created_at']],
  Scan: [['scan_id', 'mo_route_id', 'scanned_by', 'scanned_at']],
};

/* ---------- Google giả ---------- */
const sa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const idp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const CLIENT = 'test-client.apps.googleusercontent.com';
export const calls = [];

function cellValue(v) { // mô phỏng USER_ENTERED: ' → chữ, bỏ dấu '
  const s = String(v);
  return s.startsWith("'") ? s.slice(1) : s;
}
const sheetFromRange = (r) => /^'(.*)'/.exec(decodeURIComponent(r))[1].replace(/''/g, "'");

export function installFakeFetch() {
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return ok({ access_token: 'tok', expires_in: 3600 });
  if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
    return ok({ keys: [{ ...idp.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
  }
  const u = new URL(url);
  calls.push({ method: init.method || 'GET', path: u.pathname });
  if (u.pathname.endsWith('/values:batchGet')) {
    return ok({ valueRanges: u.searchParams.getAll('ranges').map((r) => ({ values: structuredClone(SHEETS[sheetFromRange(r)]) })) });
  }
  if (u.pathname.endsWith(':append')) {
    const sheet = sheetFromRange(u.pathname.split('/values/')[1].replace(/:append$/, ''));
    const { values } = JSON.parse(init.body);
    values.forEach((row) => SHEETS[sheet].push(row.map(cellValue)));
    return ok({});
  }
  if (u.pathname.endsWith('/values:batchUpdate')) {
    for (const d of JSON.parse(init.body).data) {
      const m = /^'(.*)'!([A-Z]+)(\d+)$/.exec(d.range);
      const col = m[2].charCodeAt(0) - 65;
      const rows = SHEETS[m[1]];
      const row = rows[Number(m[3]) - 1];
      while (row.length <= col) row.push('');
      row[col] = cellValue(d.values[0][0]);
    }
    return ok({});
  }
  throw new Error(`fetch không mong đợi: ${url}`);
};

}

export function setupEnv() {
  process.env.GOOGLE_CLIENT_ID = CLIENT;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "sa@test.iam.gserviceaccount.com";
  process.env.GOOGLE_PRIVATE_KEY = sa.privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, '\\n');
  process.env.SESSION_SECRET = "x".repeat(40);
}

export function idToken(email, extra = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc({
    iss: "https://accounts.google.com", aud: CLIENT, email, email_verified: true, name: email, iat: now, exp: now + 600, ...extra,
  })}`;
  return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), idp.privateKey).toString("base64url")}`;
}
