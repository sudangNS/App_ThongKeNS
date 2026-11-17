// Test tích hợp các API với Google giả lập (không gọi mạng thật).
// Chạy: node --test test/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { SHEETS, P, installFakeFetch, setupEnv, idToken } from './fake-google.js';

/* ---------- Gọi handler như Vercel ---------- */
let handlers;
before(async () => {
  installFakeFetch();
  setupEnv();
  handlers = {
    auth: (await import('../api/auth.js')).default,
    scan: (await import('../api/scan.js')).default,
    output: (await import('../api/output.js')).default,
    pallet: (await import('../api/pallet.js')).default,
  };
});

async function call(name, { method = 'GET', url = '/', body, cookie } = {}) {
  const req = { method, url, headers: { host: 'app.test', origin: 'https://app.test', cookie: cookie || '' }, body };
  const res = {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b; },
  };
  await handlers[name](req, res);
  return { status: res.statusCode, json: JSON.parse(res.body), headers: res.headers };
}

async function login(email) {
  const r = await call('auth', { method: 'POST', body: { credential: idToken(email) } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.headers['set-cookie'].split(';')[0];
}

const W2 = `${P}-W002`;

/* ---------- Test ---------- */

test('đăng nhập: chặn email ngoài Users, khoá, token sai aud', async () => {
  assert.equal((await call('auth', { method: 'POST', body: { credential: idToken('la@ns.vn') } })).status, 403);
  assert.equal((await call('auth', { method: 'POST', body: { credential: idToken('off@ns.vn') } })).status, 403);
  assert.equal((await call('auth', { method: 'POST', body: { credential: idToken('admin@ns.vn', { aud: 'khac' }) } })).status, 401);
  const tampered = idToken('tk.lr@ns.vn').replace(/\.[^.]+\./, `.${Buffer.from(JSON.stringify({ email: 'admin@ns.vn' })).toString('base64url')}.`);
  assert.equal((await call('auth', { method: 'POST', body: { credential: tampered } })).status, 401);
  assert.equal((await call('scan', { url: `/api/scan?code=${W2}-SC` })).status, 401);
});

test('GET /api/auth trả quyền theo tab To', async () => {
  const r = await call('auth', { cookie: await login('tk.sc@ns.vn') });
  assert.deepEqual(r.json.user.teams, ['SC']);
  assert.equal(r.json.user.admin, false);
  const a = await call('auth', { cookie: await login('admin@ns.vn') });
  assert.equal(a.json.user.admin, true);
});

test('quét QR: thông tin chi tiết, cụm, sản phẩm và công đoạn đúng tổ', async () => {
  const cookie = await login('tk.sc@ns.vn');
  const r = await call('scan', { url: `/api/scan?code=${W2.toLowerCase()}-sc&log=1`, cookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c = r.json;
  assert.equal(c.team.code, 'SC');
  assert.equal(c.team.name, 'Tổ Sơ chế');
  assert.deepEqual(c.teamSteps.map((s) => s.stage), ['Cắt thô', 'Rong']);
  assert.equal(c.part.code, '165698559-C3S-01-01');
  assert.equal(c.part.size, '30 × 60 × 700 mm');
  assert.equal(c.cum.name, 'Cụm hông');
  assert.equal(c.cum.children.length, 1);
  assert.equal(c.product.name, 'Zamora Lounge Chair (Bohus)');
  assert.equal(c.product.customer, '2 CONNECT / BOHUS');
  assert.equal(c.canWrite, true);
  assert.equal(SHEETS.Scan.length, 2);
  assert.equal(SHEETS.Scan[1][1], `${W2}-S01`);

  const tc = await call('scan', { url: `/api/scan?code=${W2}-TC`, cookie });
  assert.deepEqual(tc.json.teamSteps.map((s) => s.stage), ['Bào 4 mặt', 'Cắt tinh']);
  assert.equal(tc.json.canWrite, false);
  assert.equal(tc.json.teamSteps[0].prevStage, 'Rong');

  const lr = await call('scan', { url: `/api/scan?code=${W2}-LR`, cookie });
  assert.equal(lr.status, 404);
  assert.deepEqual(lr.json.groups.map((g) => g.code), ['SC', 'TC']);
  assert.equal(lr.json.partRef, W2);

  const none = await call('scan', { url: `/api/scan?code=${W2}`, cookie });
  assert.equal(none.json.team, null);
  assert.equal(none.json.groups.length, 2);

  const dm = await call('scan', { url: `/api/scan?code=${P}-W001-DM`, cookie: await login('admin@ns.vn') });
  assert.deepEqual(dm.json.teamSteps.map((s) => s.stage), ['Nhúng dầu']);
});

test('nhập nhiều công đoạn cùng lúc với pallet mới', async () => {
  const cookie = await login('tk.sc@ns.vn');
  const r = await call('output', {
    method: 'POST', cookie,
    body: {
      action: 'add', code: `${W2}-SC`, new_pallet: { no: '1/3', lot_go: '=HACK()' }, worker: 'Tổ A', note: 'ca sáng',
      entries: [{ id: `${W2}-S01`, qty: 100 }, { id: `${W2}-S02`, qty: 100 }],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(SHEETS.Pallet.length, 2);
  const pal = SHEETS.Pallet[1];
  assert.equal(pal[2], '1/3');           // số pallet giữ dạng chữ
  assert.equal(pal[3], '=HACK()');      // được ghi dạng chữ (có ' phía trước), không chạy công thức
  assert.equal(pal[5], 'Đang làm');
  assert.equal(SHEETS['Pallet Log'].length, 3);
  const log = SHEETS['Pallet Log'][1];
  assert.equal(log[1], pal[0]);
  assert.match(log[3], /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(log[7], '100');
  const ctx = r.json.context;
  assert.deepEqual(ctx.teamSteps.map((s) => s.done), [100, 100]);
  assert.equal(ctx.pallets[0].qty, 200);
});

test('cảnh báo vượt công đoạn trước cần xác nhận; chặn công đoạn của tổ khác', async () => {
  const cookie = await login('tk.sc@ns.vn');
  const scan = await call('scan', { url: `/api/scan?code=${W2}-SC`, cookie });
  // Mã in trên phiếu dùng team_id: "…-T-SC" phải ra cùng chi tiết + tổ
  const printed = await call('scan', { url: `/api/scan?code=${W2}-T-SC`, cookie });
  assert.equal(printed.status, 200, JSON.stringify(printed.json));
  assert.equal(printed.json.team.code, 'SC');
  assert.deepEqual(printed.json.teamSteps.map((s) => s.id), scan.json.teamSteps.map((s) => s.id));
  const pallet = scan.json.pallets[0].id;
  const body = { action: 'add', code: `${W2}-SC`, pallet_id: pallet, entries: [{ id: `${W2}-S02`, qty: 50 }] };
  const w = await call('output', { method: 'POST', cookie, body });
  assert.equal(w.status, 409);
  assert.match(w.json.warnings[0], /Cắt thô/);
  assert.equal(SHEETS['Pallet Log'].length, 3);
  const ok = await call('output', { method: 'POST', cookie, body: { ...body, confirm: true } });
  assert.equal(ok.status, 200);
  assert.equal(SHEETS['Pallet Log'].length, 4);

  const cross = await call('output', { method: 'POST', cookie, body: { ...body, entries: [{ id: `${W2}-S03`, qty: 5 }] } });
  assert.equal(cross.status, 400);
  const neg = await call('output', { method: 'POST', cookie, body: { ...body, entries: [{ id: `${W2}-S01`, qty: -5 }] } });
  assert.equal(neg.status, 400);
  const future = await call('output', { method: 'POST', cookie, body: { ...body, work_date: '2099-01-01', confirm: true } });
  assert.equal(future.status, 400);
  const dup = await call('output', { method: 'POST', cookie, body: { ...body, pallet_id: undefined, new_pallet: { no: '1/3' } } });
  assert.equal(dup.status, 400);
});

test('không có quyền tổ → không được nhập', async () => {
  const cookie = await login('tk.lr@ns.vn');
  const r = await call('output', { method: 'POST', cookie, body: { action: 'add', code: `${W2}-SC`, new_pallet: { no: '9' }, entries: [{ id: `${W2}-S01`, qty: 1 }] } });
  assert.equal(r.status, 403);
});

test('huỷ dòng: ghi dòng âm, không huỷ 2 lần; đóng pallet chặn nhập thêm', async () => {
  const cookie = await login('tk.sc@ns.vn');
  const scan = await call('scan', { url: `/api/scan?code=${W2}-SC`, cookie });
  const target = scan.json.logs.find((l) => l.canCancel);
  const c = await call('output', { method: 'POST', cookie, body: { action: 'cancel', code: `${W2}-SC`, log_id: target.id } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const last = SHEETS['Pallet Log'].at(-1);
  assert.equal(Number(last[7]), -target.qty);
  assert.ok(last[8].startsWith(`HUỶ ${target.id}`));
  assert.ok(c.json.context.logs.find((l) => l.id === target.id).cancelled);
  const again = await call('output', { method: 'POST', cookie, body: { action: 'cancel', code: `${W2}-SC`, log_id: target.id } });
  assert.equal(again.status, 400);

  const pid = c.json.context.pallets[0].id;
  const cl = await call('pallet', { method: 'POST', cookie, body: { code: `${W2}-SC`, pallet_id: pid, action: 'close' } });
  assert.equal(cl.status, 200, JSON.stringify(cl.json));
  assert.equal(SHEETS.Pallet[1][5], 'Đã xong');
  assert.equal(SHEETS.Pallet[1][12], 'tk.sc@ns.vn');
  const add = await call('output', { method: 'POST', cookie, body: { action: 'add', code: `${W2}-SC`, pallet_id: pid, entries: [{ id: `${W2}-S01`, qty: 1 }] } });
  assert.equal(add.status, 400);
  const re = await call('pallet', { method: 'POST', cookie, body: { code: `${W2}-SC`, pallet_id: pid, action: 'reopen' } });
  assert.equal(re.status, 403);
});

test('chặn request ghi từ trang khác (CSRF)', async () => {
  const cookie = await login('tk.sc@ns.vn');
  const req = { method: 'POST', url: '/', headers: { host: 'app.test', origin: 'https://evil.test', cookie }, body: {} };
  const res = { statusCode: 0, setHeader() {}, end(b) { this.body = b; } };
  await handlers.output(req, res);
  assert.equal(res.statusCode, 403);
});
