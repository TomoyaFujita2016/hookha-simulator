// 面どうしの放射。空気に面した固体の面（2 mm 角）を放射面とし、各面から余弦分布で光線を飛ばして
// どの面（または外の空）が見えるかを数える（モンテカルロ法の形態係数）。
// 鏡の面 y=0 に当たった光線は反射させる（対称な半分の領域で全体を表すため）。
// 毎ステップ、放射率つきの射度（radiosity）の連立式を反復で解き、各面の正味の受熱を求める。
import { M } from './data.js';
import { GRID } from './geometry.js';

export const SIGMA = 5.67e-8;
const DIRS = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]; // 格子の (ix, iy, iz) 方向

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const opaque = (m) => m !== M.AIR && m !== M.AMBIENT;

export function buildRadiation(mat, nRays = 40, seed = 1) {
  const { NX, NY, NZ, N, SY, SZ } = GRID;
  const step = [1, 1, SY, SY, SZ, SZ].map((s, d) => (d % 2 ? s : -s));
  const faceOf = new Int32Array(N * 6).fill(-1);
  const fCell = [], fDir = [];
  for (let iz = 1; iz < NZ; iz++) for (let iy = 1; iy < NY - 1; iy++) for (let ix = 1; ix < NX - 1; ix++) {
    const i = ix + NX * (iy + NY * iz);
    if (!opaque(mat[i])) continue;
    for (let d = 0; d < 6; d++) {
      if (d === 2 && iy === 1) continue; // 鏡の面
      if (d === 5 && iz === NZ - 1) continue;
      const j = i + step[d];
      if (mat[j] !== M.AIR) continue;
      faceOf[i * 6 + d] = fCell.length;
      fCell.push(i); fDir.push(d);
    }
  }
  const nf = fCell.length;
  const rand = rng(seed);
  const tgtStart = new Int32Array(nf + 1);
  const tgt = [], w = [];
  const skyW = new Float32Array(nf);
  const hits = new Map();
  for (let f = 0; f < nf; f++) {
    const i = fCell[f], d = fDir[f];
    const n = DIRS[d];
    const ix = i % NX, iy = Math.floor(i / NX) % NY, iz = Math.floor(i / SZ);
    // 面の中心（格子座標。セル ix は [ix, ix+1) を占める）から空気側へ少し出した点
    const o = [ix + 0.5 + n[0] * 0.501, iy + 0.5 + n[1] * 0.501, iz + 0.5 + n[2] * 0.501];
    // 面の法線を軸にした直交基底
    const a = Math.abs(n[0]) > 0 ? [0, 1, 0] : [1, 0, 0];
    const t1 = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
    const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
    hits.clear();
    let sky = 0;
    const side = Math.ceil(Math.sqrt(nRays));
    for (let k = 0; k < nRays; k++) {
      // 層化した余弦分布
      const u1 = ((k % side) + rand()) / side, u2 = (Math.floor(k / side) % side + rand()) / side;
      const rr = Math.sqrt(u1), ph = 2 * Math.PI * u2, cz = Math.sqrt(Math.max(0, 1 - u1));
      const dir = [0, 1, 2].map((c) => t1[c] * rr * Math.cos(ph) + t2[c] * rr * Math.sin(ph) + n[c] * cz);
      // 面上の位置もばらつかせる
      const ox = [0, 1, 2].map((c) => o[c] + (t1[c] * (rand() - 0.5) + t2[c] * (rand() - 0.5)) * 0.98);
      const res = march(mat, ox, dir, faceOf);
      if (res < 0) sky++;
      else hits.set(res, (hits.get(res) || 0) + 1);
    }
    skyW[f] = sky / nRays;
    for (const [t, c] of hits) { tgt.push(t); w.push(c / nRays); }
    tgtStart[f + 1] = tgt.length;
  }
  return {
    nf, fCell: Int32Array.from(fCell), fDir: Int8Array.from(fDir), faceOf,
    tgtStart, tgt: Int32Array.from(tgt), w: Float32Array.from(w), skyW,
    J: new Float64Array(nf), H: new Float64Array(nf),
  };
}

// DDA で格子をたどる。戻り値: 当たった面の番号、空に抜けたら -1
function march(mat, o, dir, faceOf) {
  const { NX, NY, NZ } = GRID;
  let ix = Math.floor(o[0]), iy = Math.floor(o[1]), iz = Math.floor(o[2]);
  const dx = dir[0], dy = dir[1], dz = dir[2];
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  let sy = dy > 0 ? 1 : -1;
  const tdx = Math.abs(1 / (dx || 1e-12)), tdy = Math.abs(1 / (dy || 1e-12)), tdz = Math.abs(1 / (dz || 1e-12));
  let tmx = (sx > 0 ? ix + 1 - o[0] : o[0] - ix) * tdx;
  let tmy = (sy > 0 ? iy + 1 - o[1] : o[1] - iy) * tdy;
  let tmz = (sz > 0 ? iz + 1 - o[2] : o[2] - iz) * tdz;
  for (let s = 0; s < 600; s++) {
    let d;
    if (tmx < tmy && tmx < tmz) { ix += sx; tmx += tdx; d = sx > 0 ? 0 : 1; }
    else if (tmy < tmz) {
      if (iy + sy < 1) { sy = 1; tmy += tdy; continue; } // 鏡の面で反射
      iy += sy; tmy += tdy; d = sy > 0 ? 2 : 3;
    } else { iz += sz; tmz += tdz; d = sz > 0 ? 4 : 5; }
    if (ix < 0 || ix >= NX || iy >= NY || iz < 0 || iz >= NZ) return -1;
    const i = ix + NX * (iy + NY * iz);
    const m = mat[i];
    if (m === M.AIR) continue;
    if (m === M.AMBIENT) return -1;
    // d は当たった面の向き（入ってきた側の面）
    return faceOf[i * 6 + d] >= 0 ? faceOf[i * 6 + d] : -1;
  }
  return -1;
}

// 射度の反復。T は各セルの温度[℃]、eps は面ごとの放射率、Ta は外気温[℃]。
// 戻り値は面ごとの吸収放射照度 H [W/m2]（rad.H に入る）。
export function radiosity(rad, T, eps, Ta, iters = 4) {
  const { nf, fCell, tgtStart, tgt, w, skyW, J, H } = rad;
  const ebA = SIGMA * (Ta + 273.15) ** 4;
  const eb = new Float64Array(nf);
  for (let f = 0; f < nf; f++) { const tk = T[fCell[f]] + 273.15; eb[f] = SIGMA * tk * tk * tk * tk; }
  if (!rad.init) { for (let f = 0; f < nf; f++) J[f] = eb[f]; rad.init = true; }
  for (let it = 0; it < iters; it++) {
    for (let f = 0; f < nf; f++) {
      let h = skyW[f] * ebA;
      for (let q = tgtStart[f]; q < tgtStart[f + 1]; q++) h += w[q] * J[tgt[q]];
      H[f] = h;
    }
    for (let f = 0; f < nf; f++) J[f] = eps[f] * eb[f] + (1 - eps[f]) * H[f];
  }
  return eb;
}
