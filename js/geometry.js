// ボウル・HMD・炭から 2 mm 格子の 3D 形状を組み立てる。
// 器具も炭の並びも y=0 の面について対称なので、y >= 0 の半分だけを計算する（y=0 は鏡の面）。
// 添字: i = ix + NX * (iy + NY * iz)。iz=0 が最上段。iy=0 は鏡の面の外側に置いた使わない行（ゴースト）。
import { M } from './data.js';

export const D = 2; // セルの一辺 [mm]
export const GRID = { NX: 50, NY: 27, NZ: 55, x0: -50, zTop: 64 };
GRID.N = GRID.NX * GRID.NY * GRID.NZ;
GRID.SY = GRID.NX;
GRID.SZ = GRID.NX * GRID.NY;

export const cellX = (ix) => GRID.x0 + D * ix + D / 2;
export const cellY = (iy) => D * (iy - 1) + D / 2;
export const cellZ = (iz) => GRID.zTop - D * iz - D / 2;
export const ixOf = (i) => i % GRID.NX;
export const iyOf = (i) => Math.floor(i / GRID.NX) % GRID.NY;
export const izOf = (i) => Math.floor(i / GRID.SZ);

const lerp = (a, b, t) => a + (b - a) * t;
export const isMetal = (m) => m === M.ALU || m === M.STEEL;
export const isPerf = (m) => m === M.ALU_PERF || m === M.STEEL_PERF;

// ---- 器具の材質（座標は mm）----
export function bowlMaterial(b, x, y, z) {
  const r = Math.hypot(x, y);
  const floorZ = -b.depth;
  const botZ = floorZ - b.tb;
  const neckR = 15, taperH = 22;
  let outer;
  if (z >= botZ) outer = b.Ro;
  else if (z >= botZ - taperH) outer = lerp(b.Ro, neckR, (botZ - z) / taperH);
  else outer = neckR;
  if (r > outer) return M.AMBIENT;

  const gap = 3; // リムから葉面までの隙間
  if (b.type === 'phunnel') {
    const s = b.spire;
    if (r < s.bore) return M.AIR; // 中央の煙道
    const spireTop = -s.topBelowRim;
    if (z > floorZ) {
      const t = (z - floorZ) / (spireTop - floorZ);
      const rs = lerp(s.rBase, s.rTop, Math.min(1, t));
      if (r < rs && z <= spireTop) return b.mat;
      const ri = lerp(b.RiBot, b.RiTop, (z - floorZ) / b.depth);
      if (r < ri) return z <= spireTop - 1 ? M.TOBACCO : M.AIR;
    }
    return b.mat;
  }

  // turkish / killer: 中央穴（あれば）と、半径 ringR の円周上に n 個の穴
  const h = b.holes;
  if (z > floorZ) {
    const ri = lerp(b.RiBot, b.RiTop, (z - floorZ) / b.depth);
    if (r < ri) {
      if (b.dome && r < b.dome.r && z < floorZ + b.dome.h * (1 - (r / b.dome.r) ** 2)) return b.mat;
      return z <= -gap ? M.TOBACCO : M.AIR;
    }
    return b.mat;
  }
  if (z > botZ) {
    if (h.center && r < h.d / 2) return M.AIR;
    for (let k = 0; k < h.n; k++) {
      const a = (2 * Math.PI * k) / h.n;
      if (Math.hypot(x - h.ringR * Math.cos(a), y - h.ringR * Math.sin(a)) < h.d / 2) return M.AIR;
    }
    return b.mat;
  }
  // 底板の下: 穴が合流する空洞 → 煙道
  const bore = 6, plenumR = h.ringR + h.d / 2 + 1, plenumH = 12;
  const cav = z > botZ - plenumH ? lerp(plenumR, bore, (botZ - z) / plenumH) : bore;
  return r < cav ? M.AIR : b.mat;
}

// 戻り値: 材質 ID、または -1（HMD の外）
export function hmdMaterial(h, x, y, z) {
  const r = Math.hypot(x, y);
  const perf = h.mat === M.ALU ? M.ALU_PERF : M.STEEL_PERF;
  if (z < h.flangeT && r >= h.Rin && r < h.flangeR) return h.mat;
  if (r >= h.Rin && r < h.Rin + h.wall && z < h.height) {
    if (h.slits && z >= h.slits.z0 && z < h.slits.z1) {
      const step = (2 * Math.PI) / h.slits.n;
      let a = Math.atan2(y, x) % step;
      if (a < 0) a += step;
      if (Math.min(a, step - a) * r < h.slits.w / 2) return perf;
    }
    return h.mat;
  }
  if (r < h.Rin && z < h.height) {
    if (z < h.floorT) {
      const fh = h.floorHoles;
      if (fh.type === 'slots') {
        for (const hx of fh.xs) if (Math.abs(Math.abs(x) - hx) < fh.w / 2) return perf;
      } else {
        for (let q = 0; q < fh.rs.length; q++) {
          const n = fh.ns[q], rr = fh.rs[q];
          for (let k = 0; k < n; k++) {
            const a = (2 * Math.PI * k) / n;
            if (Math.hypot(x - rr * Math.cos(a), y - rr * Math.sin(a)) < fh.d / 2) return perf;
          }
        }
      }
      return h.mat;
    }
    if (h.ribs && z < h.floorT + h.ribs.h) {
      for (const rx of h.ribs.xs) if (Math.abs(Math.abs(x) - rx) < h.ribs.w / 2) return h.mat;
    }
    return M.AIR;
  }
  return -1;
}

export function deviceMaterial(bowl, hmd, x, y, z) {
  if (z < 0) return bowlMaterial(bowl, x, y, z);
  const m = hmdMaterial(hmd, x, y, z);
  return m < 0 ? M.AMBIENT : m;
}

// ---- 静的な形状（器具と葉）----
// 1セルを 3×3×3 点で調べ、金属が少しでも入るセルは金属セルにして、熱容量と熱伝導を占有率で割り引く。
// 薄い壁（1.5〜3 mm）を 2 mm 格子で表しても、壁の熱容量と壁に沿った熱の伝わり方が保たれる。
export function buildStatic(bowl, hmd) {
  const { NX, NY, NZ, N } = GRID;
  const mat = new Uint8Array(N);
  const kS = new Float32Array(N).fill(1); // 熱伝導・熱容量の倍率（金属セルの占有率）
  const pS = new Float32Array(N).fill(1); // 通気の倍率（穴あきセルの穴の割合）
  const sub = [-2 / 3, 0, 2 / 3];
  const cnt = new Int32Array(16);
  for (let iz = 0; iz < NZ; iz++) for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
    const i = ix + NX * (iy + NY * iz);
    if (ix === 0 || ix === NX - 1 || iy === 0 || iy === NY - 1 || iz === 0) { mat[i] = M.AMBIENT; continue; }
    const x = cellX(ix), y = cellY(iy), z = cellZ(iz);
    cnt.fill(0);
    for (const a of sub) for (const b of sub) for (const c of sub) cnt[deviceMaterial(bowl, hmd, x + a, y + b, z + c)]++;
    const metal = cnt[M.ALU] + cnt[M.STEEL], perf = cnt[M.ALU_PERF] + cnt[M.STEEL_PERF];
    if (metal + perf >= 3) {
      const isP = perf > 0 && perf * 2 >= metal;
      mat[i] = isP ? (hmd.mat === M.ALU ? M.ALU_PERF : M.STEEL_PERF) : hmd.mat;
      kS[i] = Math.max(0.2, (metal + perf) / 27);
      if (isP) pS[i] = perf / (metal + perf);
      continue;
    }
    let best = M.AMBIENT, bc = -1;
    for (const m of [M.AMBIENT, M.AIR, M.CLAY, M.STONEWARE, M.TOBACCO]) if (cnt[m] > bc) { bc = cnt[m]; best = m; }
    mat[i] = best;
  }
  // 鏡の面の外側（iy=0）は使わない。材質は外気にしておき、面の係数を 0 にして切り離す。

  // 葉セルと層（上・中・下の3等分）
  const tob = [];
  const layer = new Int8Array(N).fill(-1);
  let zMax = -Infinity, zMin = Infinity;
  for (let i = 0; i < N; i++) if (mat[i] === M.TOBACCO) {
    const z = cellZ(izOf(i));
    zMax = Math.max(zMax, z); zMin = Math.min(zMin, z);
    tob.push(i);
  }
  const span = zMax - zMin + D;
  for (const i of tob) layer[i] = Math.min(2, Math.floor(((zMax + D / 2 - cellZ(izOf(i))) / span) * 3));

  // 出口: 最下段の空気セル（煙道）
  const outlet = [];
  for (let iy = 1; iy < NY - 1; iy++) for (let ix = 1; ix < NX - 1; ix++) {
    const i = ix + NX * (iy + NY * (NZ - 1));
    if (mat[i] === M.AIR) outlet.push(i);
  }
  // HMD 床セル（温度表示用）
  const hmdFloor = [];
  for (let i = 0; i < N; i++) {
    const z = cellZ(izOf(i));
    if (z < 0 || z > hmd.floorT + 0.5) continue;
    if ((isMetal(mat[i]) || isPerf(mat[i])) && Math.hypot(cellX(ixOf(i)), cellY(iyOf(i))) < hmd.Rin - 1) hmdFloor.push(i);
  }
  return {
    ...GRID, D, mat, kS, pS, tob: Int32Array.from(tob), layer, outlet, hmdFloor,
    bedR: (bowl.RiTop + bowl.RiBot) / 2,
    layerBounds: [zMax + D / 2, zMax + D / 2 - span / 3, zMax + D / 2 - (2 * span) / 3, zMin - D / 2],
  };
}

// ---- 炭の置き方 ----
// 炭は「芯（燃え残り）＋灰の殻」の立方体。外寸 o = s + 2a で置き場所を決める。
// 下段2個は奥行き(y)方向に並ぶので、y>=0 側の1個だけを計算し、鏡の面で相手の1個を表す（frac=1）。
// y=0 をまたぐ炭（下段1個、斜めがけ、ピラミッド）は半分だけが計算領域に入る（frac=0.5）。
export function slotsOf(layout) {
  const slots = [{ role: 'lower', n: layout.lower }];
  if (layout.pyramid) slots.push({ role: 'pyr', n: 1 });
  for (let k = 0; k < layout.diag; k++) slots.push({ role: 'diag', side: k === 0 ? 1 : -1, n: 1 });
  return slots;
}

export function placeCoals(hmd, coals) {
  const base = hmd.floorT + (hmd.ribs ? hmd.ribs.h : 0);
  const lower = coals.find((c) => c.role === 'lower');
  const oL = lower ? lower.s + 2 * lower.a : 0;
  const topL = base + oL;
  for (const c of coals) {
    const o = c.s + 2 * c.a, half = o / 2;
    c.frac = c.role === 'lower' && c.n === 2 ? 1 : 0.5;
    if (c.role === 'lower') {
      Object.assign(c, { cx: 0, cy: c.n === 2 ? half : 0, cz: base + half, ang: 0 });
    } else if (c.role === 'pyr') {
      Object.assign(c, { cx: 0, cy: 0, cz: topL + half, ang: 0 });
    } else {
      // 斜めがけ: 底面を HMD の縁に預け、内側の面を下段の炭の上の角に当てて約30°傾ける
      const th = (30 * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
      const R = { x: hmd.Rin + hmd.wall / 2, z: hmd.height }, C = { x: oL / 2, z: topL };
      const u = { x: -co, z: -si }, nrm = { x: -si, z: co };
      const t = (C.x - R.x) * u.x + (C.z - R.z) * u.z;
      const Q = { x: R.x + u.x * t, z: R.z + u.z * t };
      const x = Q.x - u.x * half + nrm.x * half, z = Q.z - u.z * half + nrm.z * half;
      Object.assign(c, { cx: c.side * x, cy: 0, cz: z, ang: c.side * th });
    }
  }
}

// 点が炭 c の中か: 0 = 外, 1 = 灰の殻, 2 = 芯
export function coalPart(c, x, y, z) {
  const dx = x - c.cx, dz = z - c.cz;
  const ca = Math.cos(c.ang), sa = Math.sin(c.ang);
  const u = Math.abs(dx * ca + dz * sa), v = Math.abs(-dx * sa + dz * ca), w = Math.abs(y - c.cy);
  const ho = c.s / 2 + c.a;
  if (u > ho || v > ho || w > ho) return 0;
  const hc = c.s / 2;
  return u <= hc && v <= hc && w <= hc ? 2 : 1;
}

// 静的な材質の上に炭を重ねる。炭は空気・外気のセルにだけ置く。
export function overlayCoals(stat, coals) {
  const { NX, NY, NZ, N } = GRID;
  const mat = stat.mat.slice();
  const coalId = new Int8Array(N).fill(-1);
  coals.forEach((c, id) => {
    if (c.dead) return;
    const ho = (c.s / 2 + c.a) * 1.42;
    const ix0 = Math.max(1, Math.floor((c.cx - ho - GRID.x0) / D)), ix1 = Math.min(NX - 2, Math.ceil((c.cx + ho - GRID.x0) / D));
    const iy0 = 1, iy1 = Math.min(NY - 2, Math.ceil((c.cy + ho) / D) + 1);
    const iz0 = Math.max(1, Math.floor((GRID.zTop - c.cz - ho) / D)), iz1 = Math.min(NZ - 1, Math.ceil((GRID.zTop - c.cz + ho) / D));
    for (let iz = iz0; iz <= iz1; iz++) for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
      const i = ix + NX * (iy + NY * iz);
      if (mat[i] !== M.AIR && mat[i] !== M.AMBIENT) continue;
      if (coalPart(c, cellX(ix), cellY(iy), cellZ(iz))) { mat[i] = M.COAL; coalId[i] = id; }
    }
  });
  return { mat, coalId };
}
