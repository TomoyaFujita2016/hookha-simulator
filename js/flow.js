// 吸引時の気流。開いた空間・穴あき金属・葉を通気抵抗の違う多孔質とみなし、
// Darcy 型の圧力場を前処理つき共役勾配法で解く。流量は吸う強さに比例させる。
import { M, MATERIALS } from './data.js';
import { GRID } from './geometry.js';

const R_GAS = 8.314, P_ATM = 101325;

export function solveFlow(mat, pS, outlet, prevP, TA) {
  const { NX, NZ, N, SY, SZ } = GRID;
  const K = new Float32Array(N);
  for (let i = 0; i < N; i++) K[i] = MATERIALS[mat[i]].perm * pS[i];
  // ゴースト行（iy=0）は切り離す
  for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) K[ix + SZ * iz] = 0;
  const fixed = new Uint8Array(N);
  const p = new Float64Array(N);
  for (let i = 0; i < N; i++) if (mat[i] === M.AMBIENT && K[i] > 0) fixed[i] = 1;
  const isOutlet = new Uint8Array(N);
  for (const o of outlet) { fixed[o] = 1; p[o] = -1; isOutlet[o] = 1; }
  const hm = (a, b) => (a > 0 && b > 0 ? (2 * a * b) / (a + b) : 0);
  // 面の係数: Cx[i] は i と i+1、Cy[i] は i と i+SY、Cz[i] は i と i+SZ の間
  const Cx = new Float32Array(N), Cy = new Float32Array(N), Cz = new Float32Array(N);
  for (let i = 0; i < N - SZ; i++) {
    if (K[i] === 0) continue;
    Cx[i] = hm(K[i], K[i + 1]);
    Cy[i] = hm(K[i], K[i + SY]);
    Cz[i] = hm(K[i], K[i + SZ]);
  }
  for (let i = N - SZ; i < N - 1; i++) Cx[i] = hm(K[i], K[i + 1]);
  // 外気どうしの面は流れに関係しないので切る
  for (let i = 0; i < N - SZ; i++) if (fixed[i]) {
    if (fixed[i + 1]) Cx[i] = 0;
    if (fixed[i + SY]) Cy[i] = 0;
    if (fixed[i + SZ]) Cz[i] = 0;
  }
  const unk = [];
  for (let i = SZ; i < N - SZ; i++) if (!fixed[i] && K[i] > 0) unk.push(i);
  const U = Int32Array.from(unk);
  const diag = new Float64Array(N), b = new Float64Array(N);
  for (const i of U) {
    const c = [Cx[i], Cx[i - 1], Cy[i], Cy[i - SY], Cz[i], Cz[i - SZ]];
    const nb = [i + 1, i - 1, i + SY, i - SY, i + SZ, i - SZ];
    let d = 0;
    for (let q = 0; q < 6; q++) { d += c[q]; if (fixed[nb[q]]) b[i] += c[q] * p[nb[q]]; }
    diag[i] = d;
  }
  const Av = (v, out) => {
    for (let n = 0; n < U.length; n++) {
      const i = U[n];
      out[i] = diag[i] * v[i] - (Cx[i] * v[i + 1] + Cx[i - 1] * v[i - 1] + Cy[i] * v[i + SY] + Cy[i - SY] * v[i - SY] + Cz[i] * v[i + SZ] + Cz[i - SZ] * v[i - SZ]);
    }
  };
  // 未知数だけのベクトル（固定セルは 0）
  const x = new Float64Array(N);
  if (prevP) for (const i of U) x[i] = prevP[i];
  const r = new Float64Array(N), z = new Float64Array(N), d = new Float64Array(N), q = new Float64Array(N);
  Av(x, q);
  let bn = 0;
  for (const i of U) { r[i] = b[i] - q[i]; z[i] = diag[i] > 0 ? r[i] / diag[i] : 0; d[i] = z[i]; bn += b[i] * b[i]; }
  bn = Math.sqrt(bn) || 1;
  let rz = 0;
  for (const i of U) rz += r[i] * z[i];
  let it = 0;
  for (; it < 4000; it++) {
    Av(d, q);
    let dq = 0;
    for (const i of U) dq += d[i] * q[i];
    if (dq === 0) break;
    const alpha = rz / dq;
    let rn = 0;
    for (const i of U) { x[i] += alpha * d[i]; r[i] -= alpha * q[i]; rn += r[i] * r[i]; }
    if (Math.sqrt(rn) / bn < 1e-8) break;
    let rz2 = 0;
    for (const i of U) { z[i] = diag[i] > 0 ? r[i] / diag[i] : 0; rz2 += r[i] * z[i]; }
    const beta = rz2 / rz;
    rz = rz2;
    for (const i of U) d[i] = z[i] + beta * d[i];
  }
  for (const i of U) p[i] = x[i];

  // 上流リスト（圧力の高い順に処理する）と各セルの通過流束
  const cells = Array.from(U).concat(outlet).sort((a, bb) => p[bb] - p[a]);
  const upStart = new Int32Array(cells.length + 1);
  const upIdx = [], upF = [];
  const through = new Float32Array(N), vx = new Float32Array(N), vz = new Float32Array(N);
  let fout = 0;
  cells.forEach((i, n) => {
    const c = [Cx[i], Cx[i - 1], Cy[i], Cy[i - SY], Cz[i], Cz[i - SZ]];
    const nb = [i + 1, i - 1, i + SY, i - SY, i + SZ, i - SZ];
    for (let k = 0; k < 6; k++) {
      if (c[k] === 0) continue;
      const f = c[k] * (p[nb[k]] - p[i]); // 正: nb から i へ流れ込む
      if (k === 0) vx[i] -= f / 2; else if (k === 1) vx[i] += f / 2;
      else if (k === 4) vz[i] -= f / 2; else if (k === 5) vz[i] += f / 2; // vz: 下向き正
      if (f > 1e-14) {
        upIdx.push(nb[k]); upF.push(f);
        through[i] += f;
        if (isOutlet[i]) fout += f;
      }
    }
    upStart[n + 1] = upIdx.length;
  });
  // 半分の領域なので、出口を通る量は吸引流量の半分
  const molPerLpm = fout > 0 ? ((1e-3 / 60) * P_ATM) / (R_GAS * TA) / 2 / fout : 0;
  return {
    p, cells: Int32Array.from(cells), upStart, upIdx: Int32Array.from(upIdx), upF: Float32Array.from(upF),
    through, vx, vz, isOutlet, molPerLpm, iterations: it,
  };
}
