// GET /api/wip → pallet đang trên chuyền (Đang làm / Trả lại / Chờ nhận), nhóm theo tổ → công đoạn.
// Pallet "Chờ nhận" vẫn tính ở tổ giao cho tới khi tổ sau bấm Nhận.
// Tổng: số pallet, SL chi tiết / cụm / SP, m³ gỗ tinh (BOM Wood.m3_finish quy về 1 đơn vị).
import { handler, send } from './_lib/util.js';
import { requireUser } from './_lib/session.js';
import { model, palletFlow, palletBrief } from './_lib/flow.js';

const AGE_WARN = 3;

const blank = () => ({ pallets: 0, ct: 0, cum: 0, sp: 0, m3: 0, old: 0 });
function add(sum, f) {
  sum.pallets++;
  sum[f.level === 'SP' ? 'sp' : f.level === 'CUM' ? 'cum' : 'ct'] += f.pieces;
  sum.m3 += f.m3;
  if (f.ageDays >= AGE_WARN) sum.old++;
}

export default handler({
  async GET(req, res) {
    const { t } = await requireUser(req, ['mo_routing', 'mo', 'mo_detail', 'bom_wood', 'pallet', 'pallet_log']);
    const m = model(t);
    const flow = palletFlow(t, m).filter((f) => f.state === 'open' || f.state === 'waiting');

    const total = blank();
    const teams = m.teams.map((x) => ({ code: x.code, name: x.name, sum: blank(), stages: new Map() }));
    const byCode = new Map(teams.map((x) => [x.code, x]));
    for (const f of flow) {
      let tm = byCode.get(f.team);
      if (!tm) { tm = { code: f.team, name: f.teamName, sum: blank(), stages: new Map() }; teams.push(tm); byCode.set(f.team, tm); }
      const key = f.state === 'waiting' ? `Chờ ${f.dest?.teamName || 'tổ sau'} nhận` : f.stage;
      let st = tm.stages.get(key);
      if (!st) tm.stages.set(key, (st = { stage: key, waiting: f.state === 'waiting', sum: blank(), pallets: [] }));
      add(total, f); add(tm.sum, f); add(st.sum, f);
      st.pallets.push(palletBrief(f));
    }
    send(res, 200, {
      ageWarn: AGE_WARN,
      total,
      teams: teams.map((x) => ({
        code: x.code, name: x.name, sum: x.sum,
        stages: [...x.stages.values()]
          .sort((a, b) => Number(a.waiting) - Number(b.waiting) || b.sum.m3 - a.sum.m3)
          .map((s) => ({ ...s, pallets: s.pallets.sort((a, b) => b.ageDays - a.ageDays) })),
      })),
    });
  },
});
