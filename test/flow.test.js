// Test luồng v2: tổ trưởng chỉ xem + giao/nhận, trả lại, trên chuyền, sản lượng, chuyển LSX.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { SHEETS, P, R_HEAD, installFakeFetch, setupEnv, idToken } from './fake-google.js';

/* ---------- Dữ liệu riêng cho file này ---------- */
// Tổ trưởng: SC = lead.sc, TC = lead.tc, LR = lead.lr. Thống kê SC = tk.sc, thống kê TC = tk.tc.
SHEETS.To = [['team_id', 'team_name', 'manager_email', 'note', 'thong_ke_emails'],
  ['T-SC', 'Tổ Sơ chế', 'lead.sc@ns.vn', '', 'tk.sc@ns.vn'], ['T-TC', 'Tổ Tinh chế', 'lead.tc@ns.vn', '', 'tk.tc@ns.vn'],
  ['T-LR', 'Tổ Lắp ráp', 'lead.lr@ns.vn'], ['T-DM', 'Tổ Dầu màu', ''], ['T-DG', 'Tổ Đóng gói', '']];
SHEETS.Users = [['email', 'full_name', 'role', 'active', 'note'],
  ['admin@ns.vn', 'Sự', 'Kỹ thuật', 'TRUE'],
  ['tk.sc@ns.vn', 'TK SC', 'Thống kê', 'TRUE'], ['tk.tc@ns.vn', 'TK TC', 'Thống kê', 'TRUE'],
  ['lead.sc@ns.vn', 'TT SC', 'Tổ trưởng', 'TRUE'], ['lead.tc@ns.vn', 'TT TC', 'Tổ trưởng', 'TRUE'], ['lead.lr@ns.vn', 'TT LR', 'Tổ trưởng', 'TRUE']];
// LSX thứ 2 cùng BOM (cùng bom_line_id) để test chuyển LSX
const P2 = 'LSX-02-1826-01';
const copy = SHEETS['MO Routing'].slice(1).map((r) => r.map((v) => String(v).replaceAll(P, P2).replace('LSX-02-1626', 'LSX-02-1826')));
SHEETS['MO Routing'].push(...copy);
SHEETS['MO Detail'].push([P2, 'LSX-02-1826', '1', 'SP002', '107-900-0003', 'Zamora Lounge Chair (Bohus)', 'Cái', '608', '2026-12-25']);
SHEETS['BOM Wood'][0].push('m3_finish', 'qty_per_unit');
SHEETS['BOM Wood'][1].push('0,0024', '2'); // 0,0012 m³ / 1 tay ghế
SHEETS.Transfer = [['transfer_id', 'from_part_ref', 'to_part_ref', 'bom_line_id', 'up_to_step', 'qty', 'reason', 'created_by', 'created_at']];

let h;
before(async () => {
  installFakeFetch();
  setupEnv();
  h = {};
  for (const n of ['auth', 'scan', 'output', 'pallet', 'handover', 'wip', 'report', 'transfer']) h[n] = (await import(`../api/${n}.js`)).default;
});

async function call(name, { method = 'GET', url = '/', body, cookie } = {}) {
  const req = { method, url, headers: { host: 'app.test', origin: 'https://app.test', cookie: cookie || '' }, body };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await h[name](req, res);
  return { status: res.statusCode, json: JSON.parse(res.body) };
}
const cookies = {};
async function as(email) {
  if (cookies[email]) return cookies[email];
  const req = { method: 'POST', url: '/', headers: { host: 'app.test', origin: 'https://app.test' }, body: { credential: idToken(email) } };
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await h.auth(req, res);
  assert.equal(res.statusCode, 200, res.body);
  return (cookies[email] = res.headers['set-cookie'].split(';')[0]);
}
const W2 = `${P}-W002`;

test('tổ trưởng: quét chỉ xem (không nhập được), thống kê nhập được', async () => {
  const lead = await call('scan', { url: `/api/scan?code=${W2}-T-SC`, cookie: await as('lead.sc@ns.vn') });
  assert.equal(lead.status, 200);
  assert.equal(lead.json.canWrite, false);
  assert.equal(lead.json.canLead, true);
  const tk = await call('scan', { url: `/api/scan?code=${W2}-T-SC`, cookie: await as('tk.sc@ns.vn') });
  assert.equal(tk.json.canWrite, true);
  assert.equal(tk.json.canLead, false);
  const steps = lead.json.teamSteps;
  const r = await call('output', { method: 'POST', cookie: await as('lead.sc@ns.vn'), body: { action: 'add', code: `${W2}-SC`, new_pallet: { no: 'X' }, entries: [{ id: steps[0].id, qty: 1 }] } });
  assert.equal(r.status, 403);
});

let palletA;
test('giao → chuông tổ sau → nhận đủ → pallet mới tại tổ nhận', async () => {
  const tk = await as('tk.sc@ns.vn');
  const ctx = (await call('scan', { url: `/api/scan?code=${W2}-SC`, cookie: tk })).json;
  const [s1, s2] = ctx.teamSteps; // Cắt thô, Rong (Rong = bước ra tổ SC)
  const a = await call('output', { method: 'POST', cookie: tk, body: { action: 'add', code: `${W2}-SC`, new_pallet: { no: 'P1' }, entries: [{ id: s1.id, qty: 100 }, { id: s2.id, qty: 100 }] } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  palletA = a.json.context.pallets.find((p) => p.no === 'P1');
  assert.equal(palletA.qtyOut, 100);
  assert.equal(palletA.dest.team, 'TC');

  // Thống kê không được giao; tổ trưởng tổ khác không được giao
  assert.equal((await call('handover', { method: 'POST', cookie: tk, body: { action: 'deliver', pallet_id: palletA.id } })).status, 403);
  assert.equal((await call('handover', { method: 'POST', cookie: await as('lead.tc@ns.vn'), body: { action: 'deliver', pallet_id: palletA.id } })).status, 403);

  const leadSc = await as('lead.sc@ns.vn');
  const wl = await call('handover', { cookie: leadSc });
  assert.ok(wl.json.toDeliver.some((x) => x.id === palletA.id));
  const d = await call('handover', { method: 'POST', cookie: leadSc, body: { action: 'deliver', pallet_id: palletA.id } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.ok(d.json.sent.some((x) => x.id === palletA.id));

  // Pallet chờ nhận → không nhập thêm được
  const more = await call('output', { method: 'POST', cookie: tk, body: { action: 'add', code: `${W2}-SC`, pallet_id: palletA.id, entries: [{ id: s1.id, qty: 1 }] } });
  assert.equal(more.status, 400);

  const leadTc = await as('lead.tc@ns.vn');
  assert.equal((await call('handover', { url: '/api/handover?count=1', cookie: leadTc })).json.inbox, 1);
  assert.equal((await call('handover', { url: '/api/handover?count=1', cookie: leadSc })).json.inbox, 0);
  // Mã TC: thấy pallet đang chờ nhận
  const tcCtx = (await call('scan', { url: `/api/scan?code=${W2}-T-TC`, cookie: leadTc })).json;
  assert.ok(tcCtx.incoming.some((x) => x.id === palletA.id && x.canReceive));

  // Tổ trưởng SC không nhận được hàng mình giao
  assert.equal((await call('handover', { method: 'POST', cookie: leadSc, body: { action: 'receive', pallet_id: palletA.id } })).status, 403);
  const rcv = await call('handover', { method: 'POST', cookie: leadTc, body: { action: 'receive', pallet_id: palletA.id } });
  assert.equal(rcv.status, 200, JSON.stringify(rcv.json));
  assert.equal(rcv.json.inboxCount, 0);
  const rowA = SHEETS.Pallet.find((r) => r[0] === palletA.id);
  assert.equal(rowA[5], 'Đã nhận');
  const rowB = SHEETS.Pallet.find((r) => r[9] === palletA.id);
  assert.ok(rowB, 'phải có pallet mới tại tổ TC');
  assert.equal(rowB[1], `${W2}-S03`);
  assert.equal(rowB[2], 'P1');
  assert.equal(String(rowB[11]), '100');
  // Thống kê TC thấy pallet đó để nhập
  const tcStat = (await call('scan', { url: `/api/scan?code=${W2}-TC`, cookie: await as('tk.tc@ns.vn') })).json;
  assert.ok(tcStat.pallets.some((p) => p.no === 'P1' && !p.closed && p.qtyIn === 100));
  // Nhận lần 2 → lỗi
  assert.equal((await call('handover', { method: 'POST', cookie: leadTc, body: { action: 'receive', pallet_id: palletA.id } })).status, 400);
});

test('trả lại: bắt buộc lý do, pallet về tổ giao và giao lại được', async () => {
  const tk = await as('tk.sc@ns.vn');
  const ctx = (await call('scan', { url: `/api/scan?code=${W2}-SC`, cookie: tk })).json;
  const a = await call('output', { method: 'POST', cookie: tk, body: { action: 'add', code: `${W2}-SC`, new_pallet: { no: 'P2' }, entries: [{ id: ctx.teamSteps[1].id, qty: 20 }], confirm: true } });
  const p = a.json.context.pallets.find((x) => x.no === 'P2');
  const leadSc = await as('lead.sc@ns.vn');
  const leadTc = await as('lead.tc@ns.vn');
  await call('handover', { method: 'POST', cookie: leadSc, body: { action: 'deliver', pallet_id: p.id } });
  assert.equal((await call('handover', { method: 'POST', cookie: leadTc, body: { action: 'return', pallet_id: p.id, reason: '' } })).status, 400);
  const r = await call('handover', { method: 'POST', cookie: leadTc, body: { action: 'return', pallet_id: p.id, reason: 'Thiếu 2 cây' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = SHEETS.Pallet.find((x) => x[0] === p.id);
  assert.equal(row[5], 'Trả lại');
  assert.match(row[6], /TRẢ LẠI .* Thiếu 2 cây/);
  const wl = await call('handover', { cookie: leadSc });
  assert.ok(wl.json.returned.some((x) => x.id === p.id));
  assert.ok(wl.json.toDeliver.some((x) => x.id === p.id));
  // Pallet trả lại: thống kê nhập/sửa tiếp được
  const fix = await call('output', { method: 'POST', cookie: tk, body: { action: 'add', code: `${W2}-SC`, pallet_id: p.id, entries: [{ id: ctx.teamSteps[0].id, qty: 20 }] } });
  assert.equal(fix.status, 200, JSON.stringify(fix.json));
});

test('chi tiết xong tổ cuối → giao cho tổ ráp cụm (không tạo pallet mới)', async () => {
  const tkTc = await as('tk.tc@ns.vn');
  const ctx = (await call('scan', { url: `/api/scan?code=${W2}-TC`, cookie: tkTc })).json;
  const pb = ctx.pallets.find((p) => p.no === 'P1');
  const last = ctx.teamSteps.at(-1);
  const a = await call('output', { method: 'POST', cookie: tkTc, body: { action: 'add', code: `${W2}-TC`, pallet_id: pb.id, entries: ctx.teamSteps.map((s) => ({ id: s.id, qty: 50 })), confirm: true } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const p = a.json.context.pallets.find((x) => x.id === pb.id);
  assert.equal(p.exitStage, last.stage);
  assert.equal(p.dest.team, 'LR');
  assert.equal(p.dest.kind, 'parent');
  await call('handover', { method: 'POST', cookie: await as('lead.tc@ns.vn'), body: { action: 'deliver', pallet_id: p.id } });
  const leadLr = await as('lead.lr@ns.vn');
  const cum = (await call('scan', { url: `/api/scan?code=${P}-W001-T-LR`, cookie: leadLr })).json;
  assert.ok(cum.incoming.some((x) => x.id === p.id));
  const n = SHEETS.Pallet.length;
  assert.equal((await call('handover', { method: 'POST', cookie: leadLr, body: { action: 'receive', pallet_id: p.id } })).status, 200);
  assert.equal(SHEETS.Pallet.length, n);
});

test('trên chuyền: tổng pallet, SL chi tiết, m³ theo tổ', async () => {
  const r = await call('wip', { cookie: await as('admin@ns.vn') });
  assert.equal(r.status, 200);
  const sc = r.json.teams.find((x) => x.code === 'SC');
  // P2 (trả lại, 20 cái) đang ở SC
  assert.equal(sc.sum.pallets, 1);
  assert.equal(sc.sum.ct, 20);
  assert.ok(Math.abs(sc.sum.m3 - 20 * 0.0012) < 1e-9);
  assert.equal(r.json.total.pallets, 1);
});

test('sản lượng: tổ tính ở bước ra tổ, suy diễn công đoạn bị bỏ qua', async () => {
  const r = await call('report', { url: '/api/report?period=day', cookie: await as('admin@ns.vn') });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const sc = r.json.teams.find((x) => x.code === 'SC');
  const tc = r.json.teams.find((x) => x.code === 'TC');
  // SC: Rong (bước ra tổ) = 100 + 20 = 120. TC: Cắt tinh (ra tổ) = 50
  assert.equal(sc.cur.ct, 120);
  assert.equal(tc.cur.ct, 50);
  assert.ok(Math.abs(sc.cur.m3 - 120 * 0.0012) < 1e-9);
  const w = await call('report', { url: '/api/report?period=week', cookie: await as('admin@ns.vn') });
  assert.equal(w.json.days.length, 7);
  assert.equal(w.json.teams.find((x) => x.code === 'SC').cur.ct, 120);
});

test('chuyển LSX: cùng BOM, đủ SL, ghi cặp ±, không tính sản lượng ngày', async () => {
  const tk = await as('tk.sc@ns.vn');
  assert.equal((await call('transfer', { url: `/api/transfer?ref=${W2}`, cookie: await as('lead.sc@ns.vn') })).status, 403);
  const g = await call('transfer', { url: `/api/transfer?ref=${W2}`, cookie: tk });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.deepEqual(g.json.candidates.map((c) => c.ref), [`${P2}-W002`]);
  // Không đủ SL
  const bad = await call('transfer', { method: 'POST', cookie: tk, body: { from: W2, to: `${P2}-W002`, qty: 9999, up_to: 2, reason: 'test' } });
  assert.equal(bad.status, 400);
  // Khác BOM (cụm) → chặn
  assert.equal((await call('transfer', { method: 'POST', cookie: tk, body: { from: `${P}-W001`, to: `${P2}-W001`, qty: 1, up_to: 1, reason: 'test' } })).status, 400);
  const before = (await call('report', { url: '/api/report?period=day', cookie: tk })).json.teams.find((x) => x.code === 'SC').cur.ct;
  const n = SHEETS['Pallet Log'].length;
  const ok = await call('transfer', { method: 'POST', cookie: tk, body: { from: W2, to: `${P2}-W002`, qty: 30, up_to: 2, reason: 'Ưu tiên LSX 1826' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(SHEETS['Pallet Log'].length, n + 4);
  assert.equal(SHEETS.Transfer.length, 2);
  const dst = (await call('scan', { url: `/api/scan?code=${P2}-W002-SC`, cookie: tk })).json;
  assert.equal(dst.teamSteps[1].done, 30);
  assert.ok(dst.logs.every((l) => !l.canCancel));
  const after = (await call('report', { url: '/api/report?period=day', cookie: tk })).json.teams.find((x) => x.code === 'SC').cur.ct;
  assert.equal(after, before, 'chuyển LSX không làm thay đổi sản lượng ngày của tổ');
});
