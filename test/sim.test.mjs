import test from 'node:test';
import assert from 'node:assert/strict';
import { BOWLS, HMDS, LAYOUTS, FLAVORS, COAL_SIZES, PUFF, M } from '../js/data.js';
import { Sim } from '../js/sim.js';

const run = (sim, minutes, warm = 180) => {
  for (let t = 0; t < minutes * 60; t += 0.2) {
    const ph = (t - warm) % PUFF.autoPeriod;
    sim.advance(0.2, t >= warm && ph < PUFF.autoOn ? PUFF.autoLpm : 0);
  }
  return sim.stats;
};

test('全ての器具・配置・炭サイズで断面と気流が組み立てられる', () => {
  for (const b of Object.values(BOWLS)) for (const h of Object.values(HMDS)) for (const l of Object.values(LAYOUTS)) for (const cs of [22, 28]) {
    const s = new Sim(b, h, l, FLAVORS.afTwoApples, cs);
    const name = `${b.name}/${h.name}/${l.name}/${cs}`;
    assert.ok(s.g.tob.length > 200, name + ' 葉セル');
    assert.ok(s.g.outlet.length > 0, name + ' 出口');
    assert.ok(s.flow.scalePerLpm > 0 && Number.isFinite(s.flow.scalePerLpm), name + ' 気流');
    assert.equal(s.g.nCoals, 1 + l.diag + l.pyramid, name + ' 炭の数');
    for (let c = 0; c < s.g.nCoals; c++) assert.ok(s.g.coalId.includes(c), name + ` 炭${c}が断面にある`);
    assert.ok(s.dtMax > 0.002, name + ' 時間刻み');
  }
  assert.deepEqual(COAL_SIZES, [22, 25, 26, 27, 28]);
});

test('温度は有限で、上層 > 中層 > 下層になり、成分量は負にならない', () => {
  for (const f of Object.values(FLAVORS)) {
    const s = new Sim(BOWLS.cosmoTurkish, HMDS.onmo, LAYOUTS.l2d2, f);
    const st = run(s, 6);
    assert.ok(s.T.every(Number.isFinite), f.name);
    assert.ok(st.layerT[0] > st.layerT[1] && st.layerT[1] > st.layerT[2], f.name + ' 層の順序');
    assert.ok(st.layerT[0] > 70 && st.layerT[0] < 320, f.name + ` 上層 ${st.layerT[0]}`);
    assert.ok(s.c.every((v) => v >= 0), f.name + ' 成分量');
    assert.ok(s.delivered[0] > 0, f.name + ' 水が出ている');
  }
});

test('炭が多い配置ほど葉が熱くなる', () => {
  const top = (l) => run(new Sim(BOWLS.cosmoTurkish, HMDS.onmo, LAYOUTS[l], FLAVORS.afTwoApples), 8).layerT[0];
  const l1d2 = top('l1d2'), l2 = top('l2'), l2d1 = top('l2d1'), l2d2 = top('l2d2');
  assert.ok(l2d2 > l2d1 && l2d1 > l2, `l2 ${l2} < l2d1 ${l2d1} < l2d2 ${l2d2}`);
  assert.ok(l2d2 > l1d2, `l1d2 ${l1d2} < l2d2 ${l2d2}`);
});

test('沸点の低い香料ほど先に減る', () => {
  const s = new Sim(BOWLS.cosmoTurkish, HMDS.onmo, LAYOUTS.l2d2, FLAVORS.afTwoApples);
  const st = run(s, 12);
  const r = Object.fromEntries(s.compKeys.map((k, i) => [k, st.remain[i]]));
  assert.ok(r.ethyl2MB < r.hexylAcetate && r.hexylAcetate < r.anethole && r.anethole < r.vanillin, JSON.stringify(r));
  assert.ok(r.glycerol > r.water);
});
