// 較正用: node test/run.mjs [bowl] [hmd] [layout] [flavor] [minutes]
import { BOWLS, HMDS, LAYOUTS, FLAVORS, PUFF } from '../js/data.js';
import { Sim } from '../js/sim.js';
const [b = 'cosmoTurkish', h = 'onmo', l = 'l2p1', f = 'afTwoApples', mins = '12', cs = '25'] = process.argv.slice(2);
const t0 = Date.now();
const s = new Sim(BOWLS[b], HMDS[h], LAYOUTS[l], FLAVORS[f], +cs);
console.log('build ms', Date.now() - t0, 'dtMax', s.dtMax.toFixed(4), 'tob cells', s.g.tob.length, 'coals', s.g.nCoals);
const warm = 300;
for (let t = 0; t < +mins * 60; t += 0.2) {
  const ph = (t - warm) % PUFF.autoPeriod;
  const lpm = t >= warm && ph < PUFF.autoOn ? PUFF.autoLpm : 0;
  s.advance(0.2, lpm);
  if (Math.abs((t % 60) - 59.8) < 0.1 || (t>warm && Math.abs(ph-2.4)<0.1 && Math.floor(t/60)%3===0 && ph<3 && (t%60)<20)) {
    const st = s.stats;
    console.log((t / 60).toFixed(2).padStart(6), 'top/mid/bot', st.layerT.map((v) => v.toFixed(0)).join('/'), 'max', st.maxTob.toFixed(0), 'hmd', st.hmdFloorT.toFixed(0), 'coal', st.coalT.toFixed(0),
      'gly mg/s', s.emit[1].toFixed(2), 'h2o', s.emit[0].toFixed(2), 'aroma ug/s', Array.from(s.emit).slice(2).map((v) => (v * 1000).toFixed(1)).join(','));
  }
}
console.log('remain', s.compKeys.map((k, i) => k + ':' + (s.stats.remain[i] * 100).toFixed(0)).join(' '));
console.log('delivered mg', s.compKeys.map((k, i) => k + ':' + s.delivered[i].toFixed(1)).join(' '));
console.log('wall ms', Date.now() - t0);
