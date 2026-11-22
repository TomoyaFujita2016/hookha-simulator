import { BOWLS, HMDS, LAYOUTS, FLAVORS, COAL_SIZES, COMPOUNDS, PUFF } from './data.js';
import { Sim } from './sim.js';
import { drawSection, drawHistory, drawVolatility, compColor } from './render.js';
import { Sfx } from './audio.js';
import { init3d, draw3d } from './view3d.js';

const $ = (id) => document.getElementById(id);
const fill = (sel, obj, def) => {
  for (const [k, v] of Object.entries(obj)) sel.add(new Option(v.name, k, k === def, k === def));
};
fill($('selBowl'), BOWLS, 'cosmoTurkish');
fill($('selHmd'), HMDS, 'onmo');
fill($('selLayout'), LAYOUTS, 'l2p1');
fill($('selFlavor'), FLAVORS, 'doppelganger');
for (const s of COAL_SIZES) $('selCoal').add(new Option(`${s} mm キューブ`, s, s === 25, s === 25));

const sfx = new Sfx();
const state = { sim: null, playing: false, mode: 'temp', view: '2d', pressing: false, level: 0, warmUntil: 0, acc: 0, effSpeed: 0 };

function build() {
  const flavor = FLAVORS[$('selFlavor').value];
  state.sim = new Sim(BOWLS[$('selBowl').value], HMDS[$('selHmd').value], LAYOUTS[$('selLayout').value], flavor, +$('selCoal').value);
  state.acc = 0; state.warmUntil = 0;
  $('flavorDesc').textContent = flavor.desc;
  buildTable();
  buildSources();
  refresh(true);
}

function buildTable() {
  const sim = state.sim, tb = $('tblComp').tBodies[0];
  tb.innerHTML = '';
  sim.compKeys.forEach((key, k) => {
    const c = COMPOUNDS[key];
    const tr = tb.insertRow();
    tr.innerHTML = `<td><i class="dot" style="background:${compColor(key, k)}"></i>${c.name}</td><td>${c.note || '—'}</td><td class="num">${c.bp}℃</td><td class="num" id="em${k}">—</td><td><span class="bar"><i id="rb${k}"></i></span><span id="rt${k}"></span></td>`;
  });
  $('layerBars').innerHTML = ['上層', '中層', '下層'].map((n, l) => `<div><span>${n}</span><span class="bar"><i id="lb${l}"></i></span><span id="lt${l}" class="num"></span></div>`).join('');
}

function buildSources() {
  const sim = state.sim;
  const items = [[sim.bowl.name, sim.bowl], [sim.hmd.name, sim.hmd], [sim.flavor.name, sim.flavor]];
  $('srcList').innerHTML = items.map(([n, o]) => `<dt>${n}</dt><dd>公表値: ${o.src}<br>仮定: ${o.assumed}</dd>`).join('');
}

// ---- 吸引 ----
const pad = $('pad');
const setLevel = (e) => {
  const r = pad.getBoundingClientRect();
  state.level = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
};
pad.addEventListener('pointerdown', (e) => { sfx.unlock(); pad.setPointerCapture(e.pointerId); state.pressing = true; setLevel(e); if (!state.playing) togglePlay(true); e.preventDefault(); });
pad.addEventListener('pointermove', (e) => { if (state.pressing) setLevel(e); });
const release = () => { state.pressing = false; };
pad.addEventListener('pointerup', release);
pad.addEventListener('pointercancel', release);
pad.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || /SELECT|BUTTON|INPUT/.test(document.activeElement.tagName)) return;
  e.preventDefault();
  sfx.unlock();
  if (!state.pressing) { state.pressing = true; state.level = 0.5; if (!state.playing) togglePlay(true); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') state.pressing = false; });

function currentLpm() {
  if (state.pressing) return PUFF.minLpm + state.level * (PUFF.maxLpm - PUFF.minLpm);
  const sim = state.sim;
  if (sim.time < state.warmUntil) return 0;
  if ($('chkAuto').checked && sim.time % PUFF.autoPeriod < PUFF.autoOn) return PUFF.autoLpm;
  return 0;
}

// ---- ループ ----
function togglePlay(on) {
  state.playing = on ?? !state.playing;
  $('btnPlay').textContent = state.playing ? '一時停止' : '再生';
  last = performance.now();
}
let last = performance.now(), uiT = 0, spT = 0, spSim = 0;
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  const sim = state.sim;
  if (state.playing) {
    const warming = sim.time < state.warmUntil;
    const speed = state.pressing ? 1 : warming ? 200 : +$('selSpeed').value;
    state.acc = Math.min(state.acc + dtReal * speed, 60);
    const t0 = performance.now(), before = sim.time;
    const budget = warming || speed >= 60 ? 40 : 14; // 早送り中は描画を少し犠牲にして計算に回す
    while (state.acc >= 0.2 && performance.now() - t0 < budget) {
      sim.advance(0.2, currentLpm());
      state.acc -= 0.2;
      if (warming && sim.time >= state.warmUntil) { state.acc = 0; break; }
    }
    if (state.acc > 2) state.acc = 2; // 計算が追いつかない分は捨てる
    spSim += sim.time - before;
  }
  spT += dtReal;
  if (spT > 1) { state.effSpeed = spSim / spT; spT = 0; spSim = 0; }
  const lpm = state.playing ? currentLpm() : 0;
  const opt = { mode: state.mode, tmax: +$('selTmax').value, lpm, now, particles: $('chkPart').checked };
  if (state.view === '3d') draw3d(sim, opt); else drawSection($('cv'), sim, opt);
  sfx.update(lpm, $('chkSe').checked, sim.stats.scorchFrac > 0.15);
  pad.classList.toggle('active', lpm > 0);
  $('padFill').style.height = (lpm > 0 ? ((lpm - 0) / PUFF.maxLpm) * 100 : 0) + '%';
  $('padOut').textContent = lpm.toFixed(1) + ' L/分';
  pad.setAttribute('aria-valuenow', lpm.toFixed(1));
  if (now - uiT > 250) { uiT = now; refresh(false); }
  requestAnimationFrame(frame);
}

const fmtRate = (mg) => (mg >= 1 ? mg.toFixed(1) + ' mg/秒' : mg * 1000 >= 0.05 ? (mg * 1000).toFixed(1) + ' µg/秒' : '0');

function refresh(force) {
  const sim = state.sim, st = sim.stats;
  const t = Math.floor(sim.time);
  $('oTime').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  $('oSpeed').textContent = state.playing ? `${state.effSpeed.toFixed(state.effSpeed < 10 ? 1 : 0)} 倍` : '停止中';
  $('oTop').textContent = st.layerT[0].toFixed(0) + ' ℃';
  $('oMid').textContent = st.layerT[1].toFixed(0) + ' ℃';
  $('oBot').textContent = st.layerT[2].toFixed(0) + ' ℃';
  $('oMax').textContent = st.maxTob.toFixed(0) + ' ℃';
  $('oGly').textContent = fmtRate(sim.emit[1]);
  $('oFuel').textContent = (Math.min(...st.fuel.filter((f) => f > 0), 1) * 100).toFixed(0) + ' %';
  $('oPower').textContent = st.power.toFixed(0) + ' W';
  $('oHmd').textContent = st.hmdFloorT.toFixed(0) + ' ℃';
  drawCoals(st);
  for (let l = 0; l < 3; l++) {
    $('lb' + l).style.width = Math.min(100, st.layerGly[l] * 100) + '%';
    $('lt' + l).textContent = (st.layerGly[l] * 100).toFixed(0) + '%';
  }
  sim.compKeys.forEach((key, k) => {
    $('em' + k).textContent = fmtRate(sim.emit[k]);
    $('rb' + k).style.width = Math.min(100, st.remain[k] * 100) + '%';
    $('rt' + k).textContent = (st.remain[k] * 100).toFixed(0) + '%';
  });
  // 状態の説明
  const top = st.layerT[0], sc = sim.flavor.scorchC, el = $('oState');
  let cls = '', msg;
  if (st.scorchFrac > 0.15 || top > sc) { cls = 'warn'; msg = `過熱。葉の ${(st.scorchFrac * 100).toFixed(0)}% が ${sc}℃ を超えた履歴があります。糖の熱分解が進み、焦げた味と刺激が出やすい状態です。炭を減らすか配置を変えてください。`; }
  else if (top < 100) { msg = '立ち上げ中。上層が100℃未満で、出ているのは主に水分と沸点の低いエステル類です。グリセリンはほとんど気化しません。'; }
  else if (top < 150) { cls = 'mid'; msg = '上層が100〜150℃。水分が抜け、軽い香料が出ています。グリセリンの蒸気圧はまだ低く、煙は薄めです。'; }
  else { cls = 'ok'; msg = `上層が150℃以上。グリセリンが気化して煙が出る温度帯です。上層と中層の差は ${(top - st.layerT[1]).toFixed(0)}℃ です。`; }
  if (st.scorchFrac > 0 && cls !== 'warn') msg += ` 葉の ${(st.scorchFrac * 100).toFixed(0)}% は局所的に ${sc}℃ を超えました。`;
  el.className = 'state ' + cls; el.textContent = msg;
  drawHistory($('cvHist'), sim);
  if (force || t % 2 === 0) drawVolatility($('cvVol'), sim);
}

// ---- 炭の一覧 ----
const ROLE = { lower: '下段', pyr: '上（ピラミッド）', diag: '斜めがけ' };
function drawCoals(st) {
  $('coalList').innerHTML = st.coals.map((c) => {
    const name = ROLE[c.role] + (c.role === 'lower' && c.n === 2 ? '×2' : c.role === 'diag' ? (c.side > 0 ? '（右）' : '（左）') : '');
    if (c.dead) return `<tr><td>${name}</td><td colspan="5">燃え尽きた</td></tr>`;
    return `<tr><td>${name}</td><td class="num">${c.Tc.toFixed(0)}/${c.Ts.toFixed(0)}℃</td><td class="num">${c.s.toFixed(1)} mm</td><td class="num">${c.a.toFixed(1)} mm</td><td class="num">${c.q.toFixed(0)} W</td><td class="num">${(c.fuel * 100).toFixed(0)}%</td></tr>`;
  }).join('');
}

// ---- 操作 ----
for (const id of ['selBowl', 'selHmd', 'selCoal', 'selFlavor']) $(id).addEventListener('change', () => { sfx.click(); build(); });
// 配置は途中で変えられる（今ある炭の温度・大きさ・灰を引き継ぐ）
$('selLayout').addEventListener('change', () => {
  sfx.click();
  if (state.sim.time < 1) build(); else { state.sim.setLayout(LAYOUTS[$('selLayout').value]); refresh(true); }
});
$('btnAsh').addEventListener('click', () => { sfx.click(); state.sim.knockAsh(); refresh(true); });
$('btnSwap').addEventListener('click', () => { sfx.click(); if (!state.sim.swapCoals()) alert('上段の炭がない配置では入れ替えられません'); refresh(true); });
$('btnNew').addEventListener('click', () => { sfx.click(); state.sim.replaceCoals(); refresh(true); });
document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', async () => {
  document.querySelectorAll('.views button').forEach((x) => x.classList.toggle('on', x === b));
  state.view = b.dataset.view;
  if (state.view === '3d') {
    try { await init3d($('cv3d')); } catch (e) { $('view3dMsg').textContent = '3D 表示を読み込めませんでした: ' + e.message; }
  }
  $('cv').hidden = state.view === '3d';
  $('cv3d').hidden = state.view !== '3d';
  $('view3dMsg').hidden = state.view !== '3d';
}));
$('btnPlay').addEventListener('click', () => { sfx.unlock(); sfx.click(); togglePlay(); });
$('btnReset').addEventListener('click', () => { sfx.click(); togglePlay(false); build(); });
$('btnWarm').addEventListener('click', () => { sfx.unlock(); sfx.click(); state.warmUntil = state.sim.time + 300; togglePlay(true); });
document.querySelectorAll('.tabs .modes button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs .modes button').forEach((x) => x.classList.toggle('on', x === b));
  state.mode = b.dataset.mode;
}));
window.addEventListener('resize', () => refresh(true));

build();
requestAnimationFrame(frame);
window.__state = state; // デバッグ・テスト用
