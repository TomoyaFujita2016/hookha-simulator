// 断面図・グラフの描画
import { M, MATERIALS, COMPOUNDS, AMBIENT_C } from './data.js';
import { equilibriumCurve } from './sim.js';
import { GRID, D, deviceMaterial, coalPart, cellX, cellZ, ixOf, iyOf, izOf } from './geometry.js';

const STOPS = [
  [0.0, [14, 18, 48]], [0.15, [52, 34, 120]], [0.35, [140, 40, 110]], [0.55, [214, 76, 52]],
  [0.75, [246, 160, 32]], [0.9, [252, 226, 110]], [1.0, [255, 250, 225]],
];
const LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const u = i / 255;
  let a = STOPS[0], b = STOPS[STOPS.length - 1];
  for (let s = 0; s < STOPS.length - 1; s++) if (u >= STOPS[s][0] && u <= STOPS[s + 1][0]) { a = STOPS[s]; b = STOPS[s + 1]; break; }
  const t = (u - a[0]) / (b[0] - a[0] || 1);
  for (let c = 0; c < 3; c++) LUT[i * 3 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * t);
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const MAT_RGB = MATERIALS.map((m) => hex(m.color));
const BG = [13, 15, 22];

const groupOf = (m) => (m === M.AMBIENT ? 0 : m === M.AIR ? 1 : m === M.CLAY || m === M.STONEWARE ? 2 : m === M.TOBACCO ? 4 : m === M.COAL ? 5 : 3);
const ASH_RGB = [150, 146, 140];

// 断面図は y=0（中心を通る縦断面）を 1 mm の解像度で描く。形は器具の式から直接求め、温度は 3D 格子の
// 中心の面（iy=1）から同じ材質のセルどうしで補間する。
const DW = 100, DH = 110;
const pxX = (i) => i - DW / 2 + 0.5, pxZ = (j) => GRID.zTop - j - 0.5;
let disp = null;
function displayMap(sim) {
  if (disp && disp.sim === sim) return disp;
  const mat = new Uint8Array(DW * DH);
  for (let j = 0; j < DH; j++) for (let i = 0; i < DW; i++) {
    mat[j * DW + i] = i === 0 || i === DW - 1 || j === 0 ? M.AMBIENT : deviceMaterial(sim.bowl, sim.hmd, pxX(i), 0.5, pxZ(j));
  }
  // 層（3D 側の葉セルの z 範囲で 3 等分）
  const lb = sim.st.layerBounds;
  disp = { sim, mat, cur: new Uint8Array(DW * DH), part: new Uint8Array(DW * DH), cid: new Int8Array(DW * DH), lb };
  return disp;
}
// 炭の重ね描き（毎フレーム）
function overlayDisplay(sim, d) {
  d.cur.set(d.mat); d.part.fill(0); d.cid.fill(-1);
  sim.coals.forEach((c, id) => {
    if (c.dead) return;
    for (let j = 1; j < DH; j++) for (let i = 1; i < DW - 1; i++) {
      const k = j * DW + i, m = d.cur[k];
      if (m !== M.AIR && m !== M.AMBIENT) continue;
      const p = coalPart(c, pxX(i), 0.5, pxZ(j));
      if (p) { d.cur[k] = M.COAL; d.part[k] = p; d.cid[k] = id; }
    }
  });
}
const cellOf = (x, z) => {
  const ix = Math.max(0, Math.min(GRID.NX - 1, Math.floor((x - GRID.x0) / D)));
  const iz = Math.max(0, Math.min(GRID.NZ - 1, Math.floor((GRID.zTop - z) / D)));
  return ix + GRID.NX * (1 + GRID.NY * iz);
};
function pixelT(sim, d, k) {
  const m = d.cur[k];
  if (m === M.COAL) { const c = sim.coals[d.cid[k]]; return d.part[k] === 2 ? c.Tc : c.Ts; }
  const i = k % DW, j = (k / DW) | 0;
  const x = pxX(i), z = pxZ(j);
  const gx = (x - GRID.x0) / D - 0.5, gz = (GRID.zTop - z) / D - 0.5;
  const ix0 = Math.floor(gx), iz0 = Math.floor(gz), fx = gx - ix0, fz = gz - iz0;
  const g = groupOf(m);
  let sw = 0, st = 0;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
    const ix = ix0 + a, iz = iz0 + b;
    if (ix < 0 || ix >= GRID.NX || iz < 0 || iz >= GRID.NZ) continue;
    const ci = ix + GRID.NX * (1 + GRID.NY * iz);
    if (groupOf(sim.mat[ci]) !== g) continue;
    const w = (a ? fx : 1 - fx) * (b ? fz : 1 - fz) + 1e-6;
    sw += w; st += w * sim.T[ci];
  }
  return sw > 0 ? st / sw : sim.T[cellOf(x, z)];
}

let off = null;
export function drawSection(canvas, sim, opt) {
  const d = displayMap(sim);
  overlayDisplay(sim, d);
  const W = DW, H = DH, mat = d.cur;
  const ctx = canvas.getContext('2d');
  const px = canvas.width / W;
  if (!off || off.width !== W || off.height !== H) { off = document.createElement('canvas'); off.width = W; off.height = H; }
  const octx = off.getContext('2d');
  const img = octx.createImageData(W, H);
  const data = img.data;
  const span = opt.tmax - 20;
  for (let k = 0; k < W * H; k++) {
    const m = mat[k];
    let r, gg, b;
    if (m === M.AMBIENT) [r, gg, b] = BG;
    else if (opt.mode === 'temp') {
      let u = (pixelT(sim, d, k) - 20) / span;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const q = Math.round(u * 255) * 3;
      r = LUT[q]; gg = LUT[q + 1]; b = LUT[q + 2];
      if (m === M.COAL && d.part[k] === 1) { r = r * 0.55 + ASH_RGB[0] * 0.45; gg = gg * 0.55 + ASH_RGB[1] * 0.45; b = b * 0.55 + ASH_RGB[2] * 0.45; }
    } else {
      [r, gg, b] = m === M.COAL && d.part[k] === 1 ? ASH_RGB : MAT_RGB[m];
      if (opt.mode === 'flow') { r = r * 0.45; gg = gg * 0.45; b = b * 0.45; }
    }
    data[k * 4] = r; data[k * 4 + 1] = gg; data[k * 4 + 2] = b; data[k * 4 + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

  // 穴・スリット部のハッチ
  ctx.strokeStyle = 'rgba(10,12,18,0.75)';
  ctx.lineWidth = Math.max(1, px * 0.18);
  ctx.beginPath();
  for (let k = 0; k < W * H; k++) if (mat[k] >= M.ALU_PERF) {
    const x = (k % W) * px, y = Math.floor(k / W) * px;
    ctx.moveTo(x + px * 0.5, y); ctx.lineTo(x + px * 0.5, y + px);
  }
  ctx.stroke();

  // 輪郭（炭は1個ずつ、芯と灰も分ける）
  const group = (k) => (mat[k] === M.COAL ? 10 + d.cid[k] * 2 + d.part[k] : groupOf(mat[k]));
  ctx.strokeStyle = opt.mode === 'temp' ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const k = j * W + i, a = group(k);
    if (a !== group(k + 1)) { ctx.moveTo((i + 1) * px, j * px); ctx.lineTo((i + 1) * px, (j + 1) * px); }
    if (a !== group(k + W)) { ctx.moveTo(i * px, (j + 1) * px); ctx.lineTo((i + 1) * px, (j + 1) * px); }
  }
  ctx.stroke();

  // 気流の矢印（3D 格子の中心面の流れ。x と z の成分）
  if (opt.mode === 'flow') {
    const fl = sim.flow;
    let vmax = 0;
    for (const i of sim.st.tob) if (iyOf(i) === 1) vmax = Math.max(vmax, Math.hypot(fl.vx[i], fl.vz[i]));
    const phase = (opt.now / 600) % 1;
    const alpha = opt.lpm > 0 ? 1 : 0.35;
    ctx.lineWidth = Math.max(1, px * 0.16);
    for (let iz = 1; iz < GRID.NZ; iz++) for (let ix = 1; ix < GRID.NX - 1; ix++) {
      const i = ix + GRID.NX * (1 + GRID.NY * iz);
      const vx = fl.vx[i], vz = fl.vz[i], v = Math.hypot(vx, vz);
      if (!(v > vmax * 0.03)) continue;
      const len = px * Math.min(3.2, 0.9 + 1.6 * Math.sqrt(v / vmax));
      const ux = vx / v, uz = vz / v;
      const cx = (cellX(ix) + DW / 2) * px, cy = (GRID.zTop - cellZ(iz)) * px;
      const sh = opt.lpm > 0 ? (phase - 0.5) * px * 1.5 : 0;
      const x0 = cx - ux * len / 2 + ux * sh, y0 = cy - uz * len / 2 + uz * sh;
      const x1 = x0 + ux * len, y1 = y0 + uz * len;
      ctx.strokeStyle = `rgba(140,220,255,${alpha})`;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.lineTo(x1 - ux * px * 0.7 - uz * px * 0.4, y1 - uz * px * 0.7 + ux * px * 0.4);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ux * px * 0.7 + uz * px * 0.4, y1 - uz * px * 0.7 - ux * px * 0.4);
      ctx.stroke();
    }
  }

  if (opt.particles) drawParticles(ctx, sim, opt, px);

  // 層の境界と温度ラベル
  const zy = (z) => (GRID.zTop - z) * px;
  const st = sim.stats;
  const fs = Math.round(px * 2.3);
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  const names = ['上層', '中層', '下層'];
  ctx.setLineDash([px * 0.6, px * 0.6]);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  const xr = (W / 2 + sim.bowl.RiTop) * px;
  for (let l = 1; l < 3; l++) {
    const y = zy(d.lb[l]);
    ctx.beginPath(); ctx.moveTo((W / 2 - sim.bowl.RiTop) * px, y); ctx.lineTo(xr, y); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.textAlign = 'right';
  for (let l = 0; l < 3; l++) {
    const y = zy((d.lb[l] + d.lb[l + 1]) / 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.moveTo(xr - px * 2, y); ctx.lineTo(canvas.width - px * 15.5, y); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(`${names[l]} ${st.layerT[l].toFixed(0)}℃`, canvas.width - px * 0.6, y);
  }
  // HMD・炭
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.fillText(`HMD床 ${st.hmdFloorT.toFixed(0)}℃`, px * 0.8, zy(sim.hmd.floorT / 2));
  ctx.fillText(`下段の炭 ${st.coalT.toFixed(0)}℃（表面 ${st.coalSurfT.toFixed(0)}℃）`, px * 0.8, zy(sim.hmd.floorT + 16));
  const lower = sim.coals.find((c) => c.role === 'lower');
  if (lower && lower.n === 2) { ctx.font = `${Math.round(px * 1.8)}px system-ui, sans-serif`; ctx.fillText('（奥行き方向に2個）', px * 0.8, zy(sim.hmd.floorT + 12.5)); }
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `${Math.round(px * 2)}px system-ui, sans-serif`;
  ctx.fillText(`${sim.hmd.name}`, px * 0.8, px * 2.2);
  ctx.fillText(`${sim.bowl.name}`, px * 0.8, canvas.height - px * 2.2);

  // 凡例
  if (opt.mode === 'temp') {
    const lw = px * 30, lh = px * 1.6, lx = canvas.width - lw - px * 1.5, ly = px * 1.4;
    for (let i = 0; i < lw; i++) {
      const q = Math.round((i / lw) * 255) * 3;
      ctx.fillStyle = `rgb(${LUT[q]},${LUT[q + 1]},${LUT[q + 2]})`;
      ctx.fillRect(lx + i, ly, 1.5, lh);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.textAlign = 'left'; ctx.fillText('20℃', lx, ly + lh + px * 1.4);
    ctx.textAlign = 'right'; ctx.fillText(`${opt.tmax}℃`, lx + lw, ly + lh + px * 1.4);
  }
}

// ---- 気化した成分の粒子 ----
// 吸っている間、各成分が気化している葉セル（中心の面）から粒子を出し、気流に乗せて出口まで流す。
// 出す数は「その成分が30分で尽きる速さ」を基準にした相対量なので、微量の香料も見える。
const parts = [];
let partSim = null, lastNow = 0, colors = [];
function drawParticles(ctx, sim, opt, px) {
  const fl = sim.flow, nc = sim.nc;
  if (partSim !== sim) {
    parts.length = 0; partSim = sim; colors = sim.compKeys.map((k, n) => compColor(k, n));
    sim._slice = []; sim.st.tob.forEach((i, t) => { if (iyOf(i) === 1) sim._slice.push(t); });
  }
  const dt = Math.min(0.05, (opt.now - lastNow) / 1000);
  lastNow = opt.now;
  if (!(dt > 0)) return;
  const sl = sim._slice, nt = sim.st.tob.length;
  if (opt.lpm > 0 && parts.length < 1500) {
    const cellMol = 8e-9;
    for (let k = 0; k < nc; k++) {
      let total = 0, peak = 0;
      for (let t = 0; t < nt; t++) { const e = sim.evap[t * nc + k]; total += e; if (e > peak) peak = e; }
      if (peak <= 0) continue;
      const ref = (sim.c0[k] * cellMol * nt) / 1800; // 30分で尽きる速さ [mol/s]
      let n = 45 * Math.min(2.5, total / ref) * dt;
      n = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
      for (let q = 0; q < n; q++) {
        for (let tries = 0; tries < 10; tries++) {
          const t = sl[Math.floor(Math.random() * sl.length)];
          if (Math.random() * peak > sim.evap[t * nc + k]) continue;
          const idx = sim.st.tob[t];
          parts.push({ x: cellX(ixOf(idx)) + (Math.random() - 0.5) * D, z: cellZ(izOf(idx)) + (Math.random() - 0.5) * D, k, age: 0 });
          break;
        }
      }
    }
  }
  let vref = 0;
  for (const t of sl) { const i = sim.st.tob[t]; vref = Math.max(vref, Math.hypot(fl.vx[i], fl.vz[i])); }
  const speed = (opt.lpm > 0 ? opt.lpm / 12 : 0.15) * 14 / (vref || 1);
  const r = Math.max(1.5, px * 0.28);
  for (let p = parts.length - 1; p >= 0; p--) {
    const a = parts[p];
    const i = cellOf(a.x, a.z);
    const vx = fl.vx[i], vz = fl.vz[i], v = Math.hypot(vx, vz);
    a.age += dt;
    if (a.z < GRID.zTop - GRID.NZ * D + 1 || a.age > 5 || sim.mat[i] === M.AMBIENT || v === 0) { parts.splice(p, 1); continue; }
    const s = Math.min(60, v * speed) / v;
    a.x += vx * s * dt + (Math.random() - 0.5) * 0.15;
    a.z -= vz * s * dt;
    ctx.globalAlpha = Math.min(1, 1.2 - a.age / 5);
    ctx.fillStyle = colors[a.k];
    ctx.beginPath(); ctx.arc((a.x + DW / 2) * px, (GRID.zTop - a.z) * px, a.k === 1 ? r * 1.25 : r, 0, 6.283); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---- 折れ線グラフ共通 ----
function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function drawHistory(canvas, sim) {
  const { ctx, w, h } = setup(canvas);
  const pad = { l: 38, r: 58, t: 10, b: 24 };
  const hist = sim.history;
  const tEnd = Math.max(600, sim.time), tStart = Math.max(0, tEnd - 1800);
  let ymax = 250;
  for (const p of hist) if (p.t >= tStart) ymax = Math.max(ymax, p.top + 20, p.hmd + 20);
  ymax = Math.ceil(ymax / 50) * 50;
  const X = (t) => pad.l + ((t - tStart) / (tEnd - tStart)) * (w - pad.l - pad.r);
  const Y = (v) => h - pad.b - (v / ymax) * (h - pad.t - pad.b);
  ctx.font = '11px system-ui, sans-serif';
  ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--muted'); ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= ymax; v += ymax > 400 ? 100 : 50) {
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
    ctx.fillText(v + '℃', pad.l - 4, Y(v));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const stepMin = 5;
  for (let m = Math.ceil(tStart / 60 / stepMin) * stepMin; m * 60 <= tEnd; m += stepMin) ctx.fillText(m + '分', X(m * 60), h - pad.b + 5);
  // 焦げの目安
  const sc = sim.flavor.scorchC;
  if (sc < ymax) {
    ctx.strokeStyle = css('--warn'); ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.l, Y(sc)); ctx.lineTo(w - pad.r, Y(sc)); ctx.stroke(); ctx.setLineDash([]);
  }
  // 炭の操作の印
  const EV = { ash: '灰', swap: '入替', layout: '配置', replace: '新炭' };
  ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const e of sim.events || []) {
    if (e.t < tStart) continue;
    ctx.strokeStyle = css('--muted'); ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(X(e.t), pad.t); ctx.lineTo(X(e.t), h - pad.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = css('--muted'); ctx.fillText(EV[e.kind] || e.kind, X(e.t), pad.t);
  }
  ctx.font = '11px system-ui, sans-serif';
  const series = [['hmd', 'HMD床', css('--s4')], ['top', '上層', css('--s1')], ['mid', '中層', css('--s2')], ['bot', '下層', css('--s3')]];
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const ends = [];
  for (const [key, label, color] of series) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    let first = true, last = null;
    for (const p of hist) {
      if (p.t < tStart) continue;
      const x = X(p.t), y = Y(Math.min(ymax, p[key]));
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      last = y;
    }
    ctx.stroke();
    if (last !== null) ends.push({ y: last, label, color });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
  for (const e of ends) { ctx.fillStyle = e.color; ctx.fillText(e.label, w - pad.r + 5, e.y); }
}

const CURVE_COLORS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
// 成分の色（表・グラフ・粒子で共通）。n は sim.compKeys での順番。
export function compColor(key, n) {
  return key === 'water' ? css('--water') : key === 'glycerol' ? css('--fg') : css(CURVE_COLORS[(n - 2) % CURVE_COLORS.length]);
}
export function drawVolatility(canvas, sim) {
  const { ctx, w, h } = setup(canvas);
  const pad = { l: 46, r: 150, t: 10, b: 26 };
  const t0 = 40, t1 = 300, lo = -4, hi = 3; // log10(mg/L)
  const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const Y = (lg) => h - pad.b - ((lg - lo) / (hi - lo)) * (h - pad.t - pad.b);
  ctx.font = '11px system-ui, sans-serif';
  ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--muted'); ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let lg = lo; lg <= hi; lg++) {
    ctx.beginPath(); ctx.moveTo(pad.l, Y(lg)); ctx.lineTo(w - pad.r, Y(lg)); ctx.stroke();
    ctx.fillText(lg >= 0 ? String(10 ** lg) : (10 ** lg).toFixed(-lg), pad.l - 4, Y(lg));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = 50; t <= t1; t += 50) ctx.fillText(t + '℃', X(t), h - pad.b + 5);
  // 各層の現在温度
  const lt = sim.stats.layerT, names = ['上', '中', '下'];
  ctx.textBaseline = 'top';
  for (let l = 0; l < 3; l++) {
    const t = Math.min(t1, Math.max(t0, lt[l]));
    ctx.strokeStyle = css('--fg'); ctx.globalAlpha = 0.45; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(t), pad.t); ctx.lineTo(X(t), h - pad.b); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = css('--fg'); ctx.fillText(names[l], X(t), pad.t);
  }
  const ends = [];
  sim.compKeys.forEach((key, n) => {
    const color = compColor(key, n);
    ctx.strokeStyle = color; ctx.lineWidth = key === 'glycerol' ? 2.5 : 1.6;
    if (key === 'water') ctx.setLineDash([5, 3]);
    ctx.beginPath();
    let y = 0;
    for (let t = t0; t <= t1; t += 4) {
      const lg = Math.min(hi, Math.max(lo, Math.log10(equilibriumCurve(sim.flavor, key, t))));
      y = Y(lg);
      if (t === t0) ctx.moveTo(X(t), y); else ctx.lineTo(X(t), y);
    }
    ctx.stroke(); ctx.setLineDash([]);
    ends.push({ y, label: `${COMPOUNDS[key].name} (${COMPOUNDS[key].bp}℃)`, color });
  });
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
  const over = ends.length ? ends[ends.length - 1].y - (h - 6) : 0;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const e of ends) { ctx.fillStyle = e.color; ctx.fillText(e.label, w - pad.r + 6, e.y - Math.max(0, over)); }
}

export { AMBIENT_C, LUT };
