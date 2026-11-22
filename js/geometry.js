// ボウル・HMD・炭の配置から 1 mm 格子の縦断面を組み立てる。
import { M } from './data.js';

export const GRID = { W: 100, H: 110, zTop: 64 }; // x: -50..50 mm, z: +64..-46 mm

const lerp = (a, b, t) => a + (b - a) * t;

function bowlMaterial(b, r, z) {
  // z <= 0。戻り値: 材質 ID（葉・空気・ボウル素材・外気）
  const floorZ = -b.depth;
  const botZ = floorZ - b.tb;
  const neckR = 15, taperH = 22;
  // 外形
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

  // turkish / killer
  const h = b.holes;
  const inHole = (h.center && r < h.d / 2) || Math.abs(r - h.ringR) < h.d / 2;
  if (z > floorZ) {
    const ri = lerp(b.RiBot, b.RiTop, (z - floorZ) / b.depth);
    if (r < ri) {
      if (b.dome && r < b.dome.r && z < floorZ + b.dome.h * (1 - (r / b.dome.r) ** 2)) return b.mat;
      return z <= -gap ? M.TOBACCO : M.AIR;
    }
    return b.mat;
  }
  if (z > botZ) return inHole ? M.AIR : b.mat;
  // 底板の下: 穴が合流する空洞 → 煙道
  const bore = 6, plenumR = h.ringR + h.d / 2 + 1, plenumH = 12;
  const cav = z > botZ - plenumH ? lerp(plenumR, bore, (botZ - z) / plenumH) : bore;
  return r < cav ? M.AIR : b.mat;
}

function hmdMaterial(h, x, z) {
  // z >= 0。戻り値: 材質 ID または -1（HMD の外）
  const r = Math.abs(x);
  const floorTop = h.floorT;
  const perf = h.mat === M.ALU ? M.ALU_PERF : M.STEEL_PERF;
  if (z < h.flangeT && r >= h.Rin && r < h.flangeR) return h.mat;
  if (r >= h.Rin && r < h.Rin + h.wall && z < h.height) {
    if (h.slits && z >= h.slits.z0 && z < h.slits.z1) return perf;
    return h.mat;
  }
  if (r < h.Rin && z < h.height) {
    if (z < floorTop) {
      for (const hx of h.floorHoles.xs) if (Math.abs(r - hx) < h.floorHoles.w / 2) return perf;
      return h.mat;
    }
    if (h.ribs && z < floorTop + h.ribs.h) {
      for (const rx of h.ribs.xs) if (Math.abs(r - rx) < h.ribs.w / 2) return h.mat;
    }
    return M.AIR;
  }
  return -1;
}

function coalList(h, layout, S) {
  // 断面は「下段の炭の列に直交する面」。下段2個は奥行き方向に並ぶので、断面には中央の1個分が写る。
  // 各炭: {cx, cz, ang, n}  n は奥行き方向の個数
  const half = S / 2;
  const base = h.floorT + (h.ribs ? h.ribs.h : 0);
  const zt = base + S;
  const coals = [{ cx: 0, cz: base + half, ang: 0, n: layout.lower }];
  if (layout.pyramid) coals.push({ cx: 0, cz: zt + half, ang: 0, n: 1 });
  // 斜めがけ: 底面を HMD の縁に預け、内側の側面を下段の炭の上の角に当てて約30°傾ける
  const th = (30 * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const R = { x: h.Rin + h.wall / 2, z: h.height }, C = { x: half, z: zt };
  const u = { x: -c, z: -s }, nrm = { x: -s, z: c };
  const t = (C.x - R.x) * u.x + (C.z - R.z) * u.z;
  const Q = { x: R.x + u.x * t, z: R.z + u.z * t };
  const cx = Q.x - u.x * half + nrm.x * half, cz = Q.z - u.z * half + nrm.z * half;
  for (let k = 0; k < layout.diag; k++) {
    const side = k === 0 ? 1 : -1;
    coals.push({ cx: side * cx, cz, ang: side * th, n: 1 });
  }
  return coals;
}

export function buildGeometry(bowl, hmd, layout, coalMm = 25) {
  const COAL_SIZE = coalMm - 0.5; // 点火後に一辺が約0.5 mm縮むと仮定
  const { W, H, zTop } = GRID;
  const N = W * H;
  const mat = new Uint8Array(N);
  const coalId = new Int8Array(N).fill(-1);
  const half = COAL_SIZE / 2;
  const coals = coalList(hmd, layout, COAL_SIZE);

  for (let j = 0; j < H; j++) {
    const z = zTop - j - 0.5;
    for (let i = 0; i < W; i++) {
      const x = i - W / 2 + 0.5;
      const idx = j * W + i;
      // 外周1セルは必ず外気（境界）
      if (i === 0 || i === W - 1 || j === 0) { mat[idx] = M.AMBIENT; continue; }
      let m;
      if (z < 0) m = bowlMaterial(bowl, Math.abs(x), z);
      else {
        m = hmdMaterial(hmd, x, z);
        if (m < 0) m = M.AMBIENT;
      }
      if (m === M.AIR || m === M.AMBIENT) {
        for (let c = 0; c < coals.length; c++) {
          const co = coals[c];
          const dx = x - co.cx, dz = z - co.cz;
          const ca = Math.cos(co.ang), sa = Math.sin(co.ang);
          const u = dx * ca + dz * sa, v = -dx * sa + dz * ca;
          if (Math.abs(u) <= half && Math.abs(v) <= half) { m = M.COAL; coalId[idx] = c; break; }
        }
      }
      mat[idx] = m;
    }
  }

  // 葉セルと層（上・中・下の3等分）
  const tob = [];
  const layer = new Int8Array(N).fill(-1);
  let zMax = -Infinity, zMin = Infinity;
  for (let idx = 0; idx < N; idx++) if (mat[idx] === M.TOBACCO) {
    const z = zTop - Math.floor(idx / W) - 0.5;
    zMax = Math.max(zMax, z); zMin = Math.min(zMin, z);
    tob.push(idx);
  }
  const span = zMax - zMin + 1;
  for (const idx of tob) {
    const z = zTop - Math.floor(idx / W) - 0.5;
    layer[idx] = Math.min(2, Math.floor(((zMax - z) / span) * 3));
  }

  // 出口: 最下行の空気セル（煙道）
  const outlet = [];
  for (let i = 0; i < W; i++) {
    const idx = (H - 1) * W + i;
    if (mat[idx] === M.AIR) outlet.push(idx);
  }
  // HMD 床セル（温度表示用）
  const hmdFloor = [];
  for (let j = 0; j < H; j++) {
    const z = zTop - j - 0.5;
    if (z < 0 || z > hmd.floorT) continue;
    for (let i = 0; i < W; i++) {
      const idx = j * W + i;
      if (mat[idx] !== M.AIR && mat[idx] !== M.AMBIENT && mat[idx] !== M.COAL && Math.abs(i - W / 2 + 0.5) < hmd.Rin) hmdFloor.push(idx);
    }
  }

  return {
    W, H, N, zTop, mat, coalId, coalSize: COAL_SIZE, nCoals: coals.length, coals,
    // 断面スラブに対する各炭の重み（実物で炭が占める面積 ÷ 断面で占める幅）
    coalWeight: coals.map((co) => (2 * co.n * COAL_SIZE) / (Math.PI * hmd.Rin)), tob: Int32Array.from(tob), layer,
    outlet, hmdFloor, bedR: (bowl.RiTop + bowl.RiBot) / 2,
    layerBounds: [zMax + 0.5, zMax + 0.5 - span / 3, zMax + 0.5 - (2 * span) / 3, zMin - 0.5],
  };
}
