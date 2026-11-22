import test from 'node:test';
import assert from 'node:assert/strict';
import { BOWLS, HMDS, LAYOUTS, FLAVORS, COAL_SIZES, PUFF } from '../js/data.js';
import { Sim } from '../js/sim.js';

const run = (sim, minutes, warm = 180) => {
  const t0 = sim.time;
  for (let t = 0; t < minutes * 60; t += 0.2) {
    const ph = (t0 + t - warm) % PUFF.autoPeriod;
    sim.advance(0.2, t0 + t >= warm && ph < PUFF.autoOn ? PUFF.autoLpm : 0);
  }
  return sim.stats;
};

test('全ての器具・配置で 3D 形状・気流・放射が組み立てられる', () => {
  for (const b of Object.values(BOWLS)) for (const h of Object.values(HMDS)) for (const l of Object.values(LAYOUTS)) {
    const s = new Sim(b, h, l, FLAVORS.afTwoApples, 25);
    const name = `${b.name}/${h.name}/${l.name}`;
    assert.ok(s.st.tob.length > 200, name + ' 葉セル');
    assert.ok(s.st.outlet.length > 0, name + ' 出口');
    assert.ok(s.flow.molPerLpm > 0 && Number.isFinite(s.flow.molPerLpm), name + ' 気流');
    assert.equal(s.coals.length, 1 + l.diag + l.pyramid, name + ' 炭の数');
    s.coals.forEach((_, id) => assert.ok(s.coalId.includes(id), name + ` 炭${id}が格子にある`));
    assert.ok(s.rad.nf > 500, name + ' 放射面');
    assert.ok(s.dtMax > 0.003, name + ' 時間刻み');
  }
  for (const cs of [22, 28]) assert.ok(new Sim(BOWLS.cosmoTurkish, HMDS.onmo, LAYOUTS.l2d2, FLAVORS.afTwoApples, cs).coals[0].s > cs - 1);
  assert.deepEqual(COAL_SIZES, [22, 25, 26, 27, 28]);
});

test('温度は有限で、上層 > 中層 > 下層になり、成分量は負にならない', () => {
  const s = new Sim(BOWLS.cosmoTurkish, HMDS.onmo, LAYOUTS.l2d2, FLAVORS.afTwoApples);
  const st = run(s, 8);
  assert.ok(s.T.every(Number.isFinite));
  assert.ok(st.layerT[0] > st.layerT[1] && st.layerT[1] > st.layerT[2], `層の順序 ${st.layerT}`);
  assert.ok(st.layerT[0] > 100 && st.layerT[0] < 320, `上層 ${st.layerT[0]}`);
  assert.ok(s.c.every((v) => v >= 0), '成分量');
  assert.ok(s.delivered[0] > 0 && s.delivered[1] > 0, '水とグリセリンが出ている');
  for (const c of st.coals) assert.ok(c.Tc > 500 && c.Tc < 1100 && c.Ts < c.Tc, `炭 ${c.Tc} ${c.Ts}`);
});

test('吸うと上層は下がり、炭の発熱は増える（実測の傾向）', () => {
  const s = new Sim(BOWLS.cosmoTurkish, HMDS.onmo, LAYOUTS.l2d2, FLAVORS.afTwoApples, 26);
  for (let t = 0; t < 600; t += 0.2) s.advance(0.2, 0);
  const top0 = s.stats.layerT[0], p0 = s.stats.power;
  for (let t = 0; t < 4; t += 0.2) s.advance(0.2, 12);
  assert.ok(s.stats.layerT[0] < top0, `上層 ${top0} → ${s.stats.layerT[0]}`);
  assert.ok(s.stats.power > p0, `発熱 ${p0} → ${s.stats.power}`);
});

test('灰を落とすと炭の発熱が戻る。炭は燃えて小さくなる', () => {
  const s = new Sim(BOWLS.cosmoTurkish, HMDS.onmo, LAYOUTS.l2d1, FLAVORS.afTwoApples, 25);
  run(s, 15, 0);
  const c = s.coals[0];
  assert.ok(c.s < 25 - 1, `芯 ${c.s}`);
  assert.ok(c.a > 0.4, `灰 ${c.a}`);
  const p0 = s.stats.power;
  s.knockAsh();
  run(s, 0.4, 1e9);
  assert.ok(s.coals[0].a < 0.3);
  assert.ok(s.stats.power > p0 * 1.03, `発熱 ${p0} → ${s.stats.power}`);
});

test('途中で配置を変えても炭の状態を引き継ぐ。入れ替えもできる', () => {
  const s = new Sim(BOWLS.cosmoTurkish, HMDS.onmo, LAYOUTS.l2d1, FLAVORS.afTwoApples, 25);
  run(s, 3, 1e9);
  const lowerS = s.coals[0].s, upperTc = s.coals[1].Tc;
  s.setLayout(LAYOUTS.l2d2);
  assert.equal(s.coals.length, 3);
  assert.equal(s.coals[0].s, lowerS);
  assert.equal(s.coals[1].Tc, upperTc);
  assert.ok(s.coals[2].Tc > 700, '足した炭は新しい');
  assert.ok(s.swapCoals());
  assert.equal(s.coals[1].s, lowerS);
  run(s, 0.5, 1e9);
  assert.ok(s.T.every(Number.isFinite));
  s.setLayout(LAYOUTS.l2);
  assert.equal(s.coals.length, 1);
});

test('沸点の低い香料ほど先に減る', () => {
  const s = new Sim(BOWLS.cosmoTurkish, HMDS.onmo, LAYOUTS.l2d2, FLAVORS.afTwoApples);
  const st = run(s, 12);
  const r = Object.fromEntries(s.compKeys.map((k, i) => [k, st.remain[i]]));
  assert.ok(r.ethyl2MB < r.hexylAcetate && r.hexylAcetate < r.anethole && r.anethole < r.vanillin, JSON.stringify(r));
  assert.ok(r.glycerol > r.water);
});
