// GET /api/wip → hàng tồn trên chuyền theo tổ → công đoạn chờ vào.
// Tính theo SỐ LƯỢNG (giống app Thong_Ke_NSCN, public/production.js → wipAsOf), không phụ thuộc trạng thái pallet:
//  Xét từng khoảng giữa 2 bước liên tiếp của 1 chi tiết/cụm/SP:  tồn = E[bước trước] − E[bước sau]
//   - 2 bước khác tổ  → "Chờ làm" tại ĐẦU VÀO tổ sau (tổ trước đã xong/giao, tổ sau chưa khai báo)
//   - 2 bước cùng tổ  → "Đang làm dở" tại tổ đó
//   - bước cuối của chi tiết/cụm → "Chờ ráp" tại tổ của bước đầu cụm/SP cha: E[cuối] − E[đầu cha] × (SL con/SL cha)
//  Riêng phần nằm trên pallet đang "Chờ nhận" (đã giao, tổ sau chưa bấm Nhận) → vẫn tính ở tổ giao.
//  Hàng chưa vào bước đầu (gỗ ở kho) và SP đã xong bước cuối không tính. E đã suy diễn nên tồn ≥ 0,
//  mỗi món nằm đúng 1 chỗ → m³ cộng được giữa các tổ. Tuổi tồn theo FIFO.
import { handler, send, vnNow, daysBetween } from './_lib/util.js';
import { requireUser } from './_lib/session.js';
import { model, production, palletFlow, palletBrief } from './_lib/flow.js';

const AGE_WARN = 3;
const EPS = 1e-6;
const MAX_ITEMS = 150; // mỗi nhóm công đoạn gửi tối đa n dòng (cũ nhất trước)

const blank = () => ({ lines: 0, ct: 0, cum: 0, sp: 0, m3: 0, old: 0 });
const lv = (level) => (level === 'SP' ? 'sp' : level === 'CUM' ? 'cum' : 'ct');

/** Ngày nhập của đơn vị cũ nhất chưa được bước sau lấy (FIFO). */
function oldestSince(tl, outQty) {
  let cum = 0;
  for (const [d, e] of tl || []) {
    cum += e;
    if (cum > outQty + EPS) return d;
  }
  return '';
}

export default handler({
  async GET(req, res) {
    const { t } = await requireUser(req, ['mo_routing', 'mo', 'mo_detail', 'bom_wood', 'pallet', 'pallet_log']);
    const m = model(t);
    const { eff, tl } = production(t, m);
    const flow = palletFlow(t, m);
    const today = vnNow().iso;
    const E = (s) => eff.get(s.id) || 0;

    // SL trên pallet chưa rời tổ theo bước ra tổ: đã giao chờ nhận / xong nhưng chưa giao (kể cả bị trả lại)
    const waitingAt = new Map();
    const unsentAt = new Map();
    for (const f of flow) {
      if (!f.dest || !f.qtyOut) continue;
      if (f.state === 'waiting') waitingAt.set(f.exitId, (waitingAt.get(f.exitId) || 0) + f.qtyOut);
      else if (f.state === 'open') unsentAt.set(f.exitId, (unsentAt.get(f.exitId) || 0) + f.qtyOut);
    }

    const teams = new Map(m.teams.map((x) => [x.code, { code: x.code, name: x.name, sum: blank(), stages: new Map() }]));
    const total = blank();
    const put = (teamCode, key, order, kind, p, qty, since) => {
      if (qty <= EPS) return;
      let tm = teams.get(teamCode);
      if (!tm) teams.set(teamCode, (tm = { code: teamCode, name: m.teamName(teamCode) || teamCode || 'Chưa rõ tổ', sum: blank(), stages: new Map() }));
      let st = tm.stages.get(key);
      if (!st) tm.stages.set(key, (st = { stage: key, kind, order, sum: blank(), items: [] }));
      const age = since ? Math.max(0, daysBetween(since, today)) : 0;
      const m3 = qty * p.m3f;
      for (const s of [total, tm.sum, st.sum]) {
        s.lines++; s[lv(p.level)] += qty; s.m3 += m3;
        if (age >= AGE_WARN) s.old++;
      }
      st.items.push({
        partRef: p.ref, partName: p.name, level: p.level, moNo: p.moNo, lsxStt: p.lsxStt, product: p.product,
        qty, m3, since, ageDays: age, code: `${p.ref}-${teamCode}`,
      });
    };

    for (const p of m.parts.values()) {
      const n = p.steps.length;
      for (let i = 0; i < n; i++) {
        const s = p.steps[i];
        const up = E(s);
        if (up <= EPS) continue;
        let to; let down; let kind;
        if (i < n - 1) { to = p.steps[i + 1]; down = E(to); kind = to.team === s.team ? 'do' : 'cho'; }
        else if (p.parent?.steps.length) { to = p.parent.steps[0]; down = E(to) * p.ratio; kind = 'rap'; }
        else continue; // SP đã xong bước cuối → ra khỏi chuyền
        let qty = up - down;
        if (qty <= EPS) continue;
        const since = oldestSince(tl.get(s.id), down);
        // Phần chưa được tổ sau nhận → vẫn ở tổ giao
        if (kind !== 'do') {
          const w = Math.min(qty, waitingAt.get(s.id) || 0);
          if (w > EPS) {
            put(s.team, `Đã giao, chờ ${m.teamName(to.team)} nhận`, 900, 'wait', p, w, since);
            qty -= w;
          }
          const u = Math.min(qty, unsentAt.get(s.id) || 0);
          if (u > EPS) {
            put(s.team, `Xong, chờ giao cho ${m.teamName(to.team)}`, 800, 'unsent', p, u, since);
            qty -= u;
          }
        }
        const key = kind === 'do' ? `Đang làm dở · chờ ${to.stage}` : kind === 'rap' ? `Đầu vào chờ ráp · ${to.stage} (đã nhận từ ${m.teamName(s.team)})` : `Đầu vào chờ ${to.stage} (đã nhận từ ${m.teamName(s.team)})`;
        put(to.team, key, kind === 'do' ? 100 + to.idx : kind === 'rap' ? 500 : to.idx, kind, p, qty, since);
      }
    }

    // Pallet đang mở / chờ nhận (luồng giao nhận mới) – để tra cứu theo pallet
    const pallets = flow.filter((f) => f.state === 'open' || f.state === 'waiting').map(palletBrief);

    send(res, 200, {
      ageWarn: AGE_WARN,
      total,
      teams: [...teams.values()].map((x) => ({
        code: x.code, name: x.name, sum: x.sum,
        pallets: pallets.filter((f) => f.team === x.code).length,
        stages: [...x.stages.values()]
          .sort((a, b) => a.order - b.order || b.sum.m3 - a.sum.m3)
          .map((s) => ({ ...s, more: Math.max(0, s.items.length - MAX_ITEMS), items: s.items.sort((a, b) => b.ageDays - a.ageDays || b.m3 - a.m3).slice(0, MAX_ITEMS) })),
      })),
      pallets,
    });
  },
});
