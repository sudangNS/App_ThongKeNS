// GET /api/report?period=day|week|month&date=YYYY-MM-DD
// Sản lượng theo tổ và toàn nhà máy, cùng quy tắc với app Thong_Ke_NSCN:
//  - SL của tổ = phần tăng (đã suy diễn) ở bước "ra tổ" của từng chi tiết/cụm/SP (bước cuối của tổ trên chi tiết đó).
//  - m³ = SL × m³ tinh / 1 đơn vị (BOM Wood). Toàn nhà máy = SP xong công đoạn cuối (đóng gói).
//  - Dòng CHUYỂN LSX không tính là sản lượng.
import { handler, send, HttpError, vnNow } from './_lib/util.js';
import { requireUser } from './_lib/session.js';
import { model, production } from './_lib/flow.js';

const pad = (n) => String(n).padStart(2, '0');
const toD = (k) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)));
const key = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (k, n) => { const d = toD(k); d.setUTCDate(d.getUTCDate() + n); return key(d); };

/** Kỳ chứa ngày `date` và kỳ liền trước. Tuần bắt đầu thứ Hai. */
export function periodOf(period, date) {
  if (period === 'week') {
    const dow = (toD(date).getUTCDay() + 6) % 7;
    const from = addDays(date, -dow);
    return { from, to: addDays(from, 6), prevFrom: addDays(from, -7), prevTo: addDays(from, -1) };
  }
  if (period === 'month') {
    const d = toD(date);
    const from = key(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
    const to = key(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    const prevFrom = key(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
    return { from, to, prevFrom, prevTo: addDays(from, -1) };
  }
  return { from: date, to: date, prevFrom: addDays(date, -1), prevTo: addDays(date, -1) };
}

function dayList(from, to) {
  const out = [];
  for (let k = from; k <= to && out.length < 62; k = addDays(k, 1)) out.push(k);
  return out;
}

const blank = () => ({ m3: 0, ct: 0, cum: 0, sp: 0 });

export default handler({
  async GET(req, res) {
    const url = new URL(req.url, 'http://x');
    const period = ['day', 'week', 'month'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'day';
    const today = vnNow().iso;
    const date = url.searchParams.get('date') || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Ngày không hợp lệ');

    const { t } = await requireUser(req, ['mo_routing', 'mo', 'mo_detail', 'bom_wood', 'pallet_log']);
    const m = model(t);
    const { daily } = production(t, m);
    const p = periodOf(period, date);
    const days = dayList(p.from, p.to);

    const teamOrder = m.teams.map((x) => x.code);
    const teams = new Map(m.teams.map((x) => [x.code, {
      code: x.code, name: x.name, cur: blank(), prev: blank(), series: days.map(() => 0), stages: new Map(),
    }]));
    const factory = { cur: { sp: 0, m3: 0 }, prev: { sp: 0, m3: 0 }, series: days.map(() => 0) };

    const addTo = (bucket, s, q) => {
      bucket.m3 += q * s.part.m3f;
      bucket[s.part.level === 'SP' ? 'sp' : s.part.level === 'CUM' ? 'cum' : 'ct'] += q;
    };
    for (const [day, dm] of daily) {
      const inCur = day >= p.from && day <= p.to;
      const inPrev = day >= p.prevFrom && day <= p.prevTo;
      if (!inCur && !inPrev) continue;
      const di = inCur ? days.indexOf(day) : -1;
      for (const [id, q] of dm) {
        const s = m.steps.get(id);
        if (!s || !q) continue;
        const tm = teams.get(s.team);
        if (tm && inCur) {
          // Bảng công đoạn của tổ: mọi bước (không chỉ bước ra tổ)
          const st = tm.stages.get(s.stage) || { stage: s.stage, qty: 0, order: s.idx };
          st.qty += q; tm.stages.set(s.stage, st);
        }
        if (tm && s.exit) {
          addTo(inCur ? tm.cur : tm.prev, s, q);
          if (inCur) tm.series[di] += q * s.part.m3f;
        }
        // Toàn nhà máy: SP xong bước cuối
        if (s.part.level === 'SP' && s.idx === s.part.steps.length - 1) {
          const b = inCur ? factory.cur : factory.prev;
          b.sp += q; b.m3 += q * s.part.m3f;
          if (inCur) factory.series[di] += q * s.part.m3f;
        }
      }
    }

    send(res, 200, {
      period, date, today, ...p, days,
      factory,
      teams: [...teams.values()]
        .sort((a, b) => teamOrder.indexOf(a.code) - teamOrder.indexOf(b.code))
        .map((x) => ({ ...x, stages: [...x.stages.values()].filter((s) => s.qty).sort((a, b) => a.order - b.order || b.qty - a.qty) })),
    });
  },
});
