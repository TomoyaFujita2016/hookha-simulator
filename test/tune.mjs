// 較正値の探索: node test/tune.mjs key=value ... -- bowl hmd layout flavor mins
import { BOWLS, HMDS, LAYOUTS, FLAVORS, PUFF } from '../js/data.js';
import { Sim, TUNE } from '../js/sim.js';
const args = process.argv.slice(2);
const cases = [];
for (const a of args) { if (a.includes('=')) { const [k, v] = a.split('='); TUNE[k] = +v; } else cases.push(a); }
const mins = 30;
for (const cs of cases) {
  const [b, h, l, f = 'afTwoApples'] = cs.split(',');
  const s = new Sim(BOWLS[b], HMDS[h], LAYOUTS[l], FLAVORS[f]);
  let out = cs.padEnd(34);
  for (let t = 0; t < mins * 60; t += 0.2) {
    const ph = (t - 300) % PUFF.autoPeriod;
    s.advance(0.2, t >= 300 && ph < PUFF.autoOn ? PUFF.autoLpm : 0);
    if ([299.8, 899.8, 1799.8].some((x) => Math.abs(t - x) < 0.05)) {
      const st = s.stats;
      out += ` | ${Math.round(t / 60)}m ${st.layerT.map((v) => v.toFixed(0)).join('/')} hmd ${st.hmdFloorT.toFixed(0)} coal ${st.coalT.toFixed(0)}`;
    }
  }
  out += ` | gly残${(s.stats.remain[1] * 100).toFixed(0)}% 主香残${(s.stats.remain[2] * 100).toFixed(0)}% gly ${(s.delivered[1] / 1000).toFixed(2)}g`;
  console.log(out);
}
