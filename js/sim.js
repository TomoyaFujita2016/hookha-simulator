// 断面 2D の熱・気流・気化シミュレーション。
// 熱: 1 mm 格子の陽解法（伝導 + すき間の放射を等価熱伝導率で近似 + 外気への対流・放射）
// 気流: 吸引時の流れを Darcy 型のポテンシャル流れとして一度だけ解き、流量に比例させる
// 気化: 通過する空気が各セルで気液平衡に近づく（Raoult 則 + Clausius-Clapeyron）
import { M, MATERIALS, COMPOUNDS, AMBIENT_C } from './data.js';
import { buildGeometry } from './geometry.js';

const DX = 1e-3;
const SIGMA = 5.67e-8;
const R_GAS = 8.314;
const P_ATM = 101325;
const TA = AMBIENT_C + 273.15;
const CP_AIR = 29.1; // J/mol K
const ALPHA_CAP = 2.5e-5; // 空気セルの熱拡散率上限（時間刻み確保のため）
const TICK = 0.2; // 気流・気化・係数更新の間隔 [s]

// 調整係数（文献の実測レンジに合わせた較正値）
export const TUNE = {
  radEps: 0.8, // すき間をはさむ2面間の実効放射率
  coalCoupling: 1.3, // 炭と周囲の熱のやり取りの較正係数（各炭の重み coalWeight に掛ける）
  coalSideView: 0.35, // HMD 内の炭の前後面から外が見える割合
  coalStartC: 650, // 着火済みの炭を載せた時点の温度
  coalPower: 6.0e6, // 炭の発熱密度 [W/m3]（25 mm キューブ1個で約90 W）
  coalDraft: 0.6, // 12 L/分で吸ったときの発熱の増加率
  coalMaxC: 900,
  rimContactH: 150, // HMD とボウルのリムの接触熱伝達率 [W/m2K]
  coalContactH: 60, // 炭と器具の接触熱伝達率 [W/m2K]
  coalLifeMin: 75, // 炭の基準燃焼時間
  hWall: 30, // 空気と壁の熱伝達率 [W/m2K]
  bedEff: 0.9, // 葉セル1つを通過する空気の熱交換効率
  evapEff: 0.08, // 葉セル1つで気液平衡に近づく割合
  surfEff: 0.05, // 葉面に接する空気セルが拾う割合
  depAroma: 0.08, // 過飽和分が葉に戻る割合（残りはミストとして通過）
  depWater: 0.3,
  idleLpm: 0.15, // 吸っていない間の自然な通気
  bulkDensity: 480, // 葉の充填密度 [kg/m3]
};

const CP = { leaf: 1500, sugar: 1250, water: 4180, glycerol: 2400 };

export class Sim {
  constructor(bowl, hmd, layout, flavor, coalMm = 25) {
    this.bowl = bowl; this.hmd = hmd; this.layout = layout; this.flavor = flavor;
    const g = (this.g = buildGeometry(bowl, hmd, layout, coalMm));
    const { N, W, H } = g;
    this.T = new Float32Array(N).fill(AMBIENT_C);
    this.T2 = new Float32Array(N);
    this.kx = new Float32Array(N);
    this.kz = new Float32Array(N);
    this.invC = new Float32Array(N);
    this.kCell = new Float32Array(N);
    this.maxT = new Float32Array(N).fill(AMBIENT_C);
    this.loss = new Float32Array(N); // 断面外への放熱係数 [1/s]
    // 熱計算の対象セル
    const act = [];
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      const idx = j * W + i;
      if (g.mat[idx] !== M.AMBIENT) act.push(idx);
    }
    this.active = Int32Array.from(act);
    this.coalSize = g.coalSize;
    // 空気セルごとのすき間幅 [m]（縦・横の連続長の短い方、上限 10 mm）。放射の等価熱伝導率に使う。
    this.gapLen = new Float32Array(N);
    const run = (idx, step) => {
      let n = 1;
      for (let q = idx + step; g.mat[q] === M.AIR && n < 12; q += step) n++;
      for (let q = idx - step; g.mat[q] === M.AIR && n < 12; q -= step) n++;
      return n;
    };
    for (const idx of act) if (g.mat[idx] === M.AIR) this.gapLen[idx] = Math.min(10, run(idx, 1), run(idx, W)) * 1e-3;
    this.cupTopRow = g.zTop - Math.round(hmd.height); // HMD の縁の行
    // 開口の見え方: 真上に遮るものがない空気セルについて 幅/(幅+2×深さ)。
    // すき間を横切る間に逃げる割合がこの値になるよう、セルあたりの係数は幅の2乗で割る。
    this.skyView = new Float32Array(N);
    // 上段の炭は実物では開口の一部（円周の3割弱）しか塞がないので、その下も 7 割は空が見えるとする。
    const through = new Float32Array(N);
    for (let i = 1; i < W - 1; i++) {
      let depth = 0, tr = 1;
      for (let j = 1; j < H - 1; j++) {
        const idx = j * W + i, m = g.mat[idx];
        if (m === M.AMBIENT) continue;
        if (m === M.COAL && g.coalId[idx] > 0) { tr = 0.7; continue; }
        if (m !== M.AIR) break;
        depth++;
        this.skyView[idx] = depth; // いったん深さを入れる
        through[idx] = tr;
      }
    }
    for (let j = 1; j < H - 1; j++) {
      let i = 1;
      while (i < W - 1) {
        if (this.skyView[j * W + i] === 0) { i++; continue; }
        let e = i;
        while (e < W - 1 && this.skyView[j * W + e] > 0) e++;
        const w = e - i;
        for (let q = i; q < e; q++) { const d = this.skyView[j * W + q]; this.skyView[j * W + q] = (through[j * W + q] * (w / (w + 2 * d)) * 2) / (w * w); }
        i = e;
      }
    }
    this.coalCells = this.active.filter((i) => g.mat[i] === M.COAL);
    for (const i of this.coalCells) this.T[i] = TUNE.coalStartC;
    this.lowerCoalCells = this.coalCells.filter((i) => g.coalId[i] === 0);
    this.fuel = new Float32Array(g.nCoals).fill(1);
    this.rhocBase = new Float32Array(N);
    for (let i = 0; i < N; i++) this.rhocBase[i] = MATERIALS[g.mat[i]].rhoc;

    // 成分
    const fl = flavor;
    this.compKeys = ['water', 'glycerol', ...Object.keys(fl.aroma)];
    this.nc = this.compKeys.length;
    this.comp = this.compKeys.map((k) => COMPOUNDS[k]);
    const nt = g.tob.length;
    this.tobIndex = new Int32Array(N).fill(-1);
    g.tob.forEach((idx, t) => (this.tobIndex[idx] = t));
    this.c = new Float32Array(nt * this.nc); // mol/m3
    const rho = TUNE.bulkDensity;
    this.c0 = this.compKeys.map((k) => {
      const massFrac = k === 'water' ? fl.frac.water : k === 'glycerol' ? fl.frac.glycerol : fl.aroma[k] / 1000;
      return (rho * massFrac * 1000) / COMPOUNDS[k].mw;
    });
    for (let t = 0; t < nt; t++) for (let k = 0; k < this.nc; k++) this.c[t * this.nc + k] = this.c0[k];
    this.sugarMol = (rho * fl.frac.sugar * 1000) / 180.16;
    this.dryRhoc = rho * (fl.frac.leaf * CP.leaf + fl.frac.sugar * CP.sugar);

    this.solveFlow();
    this.Tg = new Float32Array(N);
    this.Y = new Float32Array(N * this.nc);
    this.evap = new Float32Array(nt * this.nc); // 直近の吸引で各葉セルから気化した量 [mol/s]（粒子表示用）

    this.time = 0;
    this.tickAcc = 0;
    this.flowSm = 0; // 平滑化した吸引流量（炭の燃焼促進用）
    this.emit = new Float32Array(this.nc); // 口元側へ出る量 mg/s（平滑化）
    this.delivered = new Float32Array(this.nc); // 累積 mg
    this.stats = {};
    this.history = [];
    this.lastHist = -1e9;
    this.updateCoefficients();
    this.computeStats(0);
  }

  // ---- 気流（圧力ポテンシャル）----
  solveFlow() {
    const g = this.g, { N, W, H, mat } = g;
    const K = new Float32Array(N);
    for (let i = 0; i < N; i++) K[i] = MATERIALS[mat[i]].perm;
    const p = new Float64Array(N);
    const fixed = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (mat[i] === M.AMBIENT) fixed[i] = 1;
    for (const o of g.outlet) { fixed[o] = 1; p[o] = -1; }
    const fk = (a, b) => (a > 0 && b > 0 ? (2 * a * b) / (a + b) : 0);
    const unknown = [];
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      const idx = j * W + i;
      if (!fixed[idx] && K[idx] > 0) unknown.push(idx);
    }
    const kl = new Float32Array(N), kr = new Float32Array(N), ku = new Float32Array(N), kd = new Float32Array(N);
    for (const i of unknown) {
      kl[i] = fk(K[i], K[i - 1]); kr[i] = fk(K[i], K[i + 1]);
      ku[i] = fk(K[i], K[i - W]); kd[i] = fk(K[i], K[i + W]);
    }
    const omega = 1.9;
    for (let it = 0; it < 8000; it++) {
      let maxd = 0;
      for (let n = 0; n < unknown.length; n++) {
        const i = unknown[n];
        const s = kl[i] + kr[i] + ku[i] + kd[i];
        if (s === 0) continue;
        const v = (kl[i] * p[i - 1] + kr[i] * p[i + 1] + ku[i] * p[i - W] + kd[i] * p[i + W]) / s;
        const d = v - p[i];
        p[i] += omega * d;
        if (d > maxd) maxd = d; else if (-d > maxd) maxd = -d;
      }
      if (maxd < 1e-7) break;
    }
    // 上流リスト（圧力の高い順に処理する）
    const cells = unknown.concat(g.outlet).sort((a, b) => p[b] - p[a]);
    const upStart = new Int32Array(cells.length + 1);
    const upIdx = [], upF = [];
    const vx = new Float32Array(N), vz = new Float32Array(N);
    let fout = 0;
    const isOutlet = new Uint8Array(N);
    for (const o of g.outlet) isOutlet[o] = 1;
    cells.forEach((i, n) => {
      const nb = [i - 1, i + 1, i - W, i + W];
      for (let q = 0; q < 4; q++) {
        const j = nb[q];
        if (j < 0 || j >= N) continue;
        const kf = fk(K[i], K[j]);
        if (kf === 0) continue;
        const f = kf * (p[j] - p[i]);
        if (q === 0) vx[i] += f / 2; else if (q === 1) vx[i] -= f / 2;
        else if (q === 2) vz[i] += f / 2; else vz[i] -= f / 2; // vz: 下向き正
        if (f > 1e-12) {
          upIdx.push(j); upF.push(f);
          if (isOutlet[i]) fout += f;
        }
      }
      upStart[n + 1] = upIdx.length;
    });
    this.flow = {
      cells: Int32Array.from(cells), upStart, upIdx: Int32Array.from(upIdx), upF: Float32Array.from(upF),
      vx, vz, isOutlet, p,
      // 流束の正規化: 葉の断面全体の平均流束密度が Q/(πR²) になるようにする
      scalePerLpm: fout > 0 ? ((((1e-3 / 60) * P_ATM) / (R_GAS * TA) / (Math.PI * (g.bedR * 1e-3) ** 2)) * (2 * g.bedR)) / fout : 0,
      areaRatio: (Math.PI * g.bedR) / 2, // 断面スラブ(厚さ1 mm) → 実ボウルへの換算
    };
  }

  // ---- 係数更新（温度依存の放射・外気への放熱）----
  updateCoefficients() {
    const g = this.g, { W, mat } = g, T = this.T, kCell = this.kCell, invC = this.invC;
    const nc = this.nc;
    for (let n = 0; n < this.active.length; n++) {
      const i = this.active[n];
      const m = mat[i];
      let k = MATERIALS[m].k, rhoc = this.rhocBase[i];
      if (m === M.AIR) {
        const tk = T[i] + 273.15;
        k = 0.026 * Math.pow(tk / 300, 0.8) + 4 * SIGMA * tk * tk * tk * TUNE.radEps * this.hmd.epsRel * this.gapLen[i];
        rhoc = Math.max(1200, k / ALPHA_CAP);
      } else if (m === M.TOBACCO) {
        const t = this.tobIndex[i] * nc;
        rhoc = this.dryRhoc + this.c[t] * 0.01802 * CP.water + this.c[t + 1] * 0.09209 * CP.glycerol;
      }
      kCell[i] = k;
      invC[i] = 1 / (rhoc * DX * DX);
      if (m === M.AIR && this.skyView[i] > 0) {
        // 上が開いた空気セルは、開口の見え方に応じて放射が外へ抜ける
        this.loss[i] = (this.skyView[i] * k) / (DX * DX * rhoc);
      } else if (m === M.COAL) {
        // 断面に写らない前後2面からの放熱（HMD の中にある炭は壁に囲まれて逃げにくい）
        const tk = T[i] + 273.15;
        const h = 8 + 0.9 * SIGMA * (tk * tk + TA * TA) * (tk + TA);
        const vf = i < this.cupTopRow * W ? 1 : TUNE.coalSideView;
        this.loss[i] = (2 * h * vf * TUNE.coalCoupling * g.coalWeight[g.coalId[i]]) / (this.coalSize * 1e-3 * rhoc);
      }
    }
    const face = (i, j) => {
      const mi = mat[i], mj = mat[j];
      const ai = mi === M.AMBIENT, aj = mj === M.AMBIENT;
      if (ai && aj) return 0;
      if (ai || aj) {
        const s = ai ? j : i;
        const ts = T[s] + 273.15;
        const h = 8 + MATERIALS[mat[s]].eps * SIGMA * (ts * ts + TA * TA) * (ts + TA);
        if (mat[s] === M.COAL) return h * DX * TUNE.coalCoupling * g.coalWeight[g.coalId[s]];
        // 外面は半径が大きいほど実物の表面積が増える（断面→軸対称の面積補正）
        const r = Math.abs((s % W) - W / 2 + 0.5);
        return h * DX * Math.min(3, Math.max(0.4, (2 * r) / g.bedR));
      }
      const a = kCell[i] || MATERIALS[mi].k, b = kCell[j] || MATERIALS[mj].k;
      const kf = (2 * a * b) / (a + b);
      // 断面では炭が床幅の大半を占めるが、実物では床面積の4〜5割しか覆わない。その差を補正する。
      // 別々の炭どうしは角や辺で触れるだけなので、熱抵抗がある
      if (mi === M.COAL && mj === M.COAL && g.coalId[i] !== g.coalId[j]) return TUNE.coalContactH * 2 * DX;
      if ((mi === M.COAL) === (mj === M.COAL)) {
        // HMD とボウルのリムは線接触に近く、熱抵抗がある
        const metalI = mi === M.ALU || mi === M.STEEL || mi >= M.ALU_PERF, metalJ = mj === M.ALU || mj === M.STEEL || mj >= M.ALU_PERF;
        const bowlI = mi === M.CLAY || mi === M.STONEWARE, bowlJ = mj === M.CLAY || mj === M.STONEWARE;
        if ((metalI && bowlJ) || (metalJ && bowlI)) return TUNE.rimContactH * DX;
        return kf;
      }
      const other = mi === M.COAL ? mj : mi;
      // 炭と固体の接触は点接触＋灰で熱抵抗が大きい。空気側は放射（等価熱伝導率）で伝わる。
      const id = g.coalId[mi === M.COAL ? i : j];
      const w = TUNE.coalCoupling * g.coalWeight[id];
      // 上段の炭が縁に触れるのは円周のごく一部なので、固体との接触はさらに半分にする
      return other === M.AIR ? kf * w : TUNE.coalContactH * DX * w * (id > 0 ? 0.5 : 1);
    };
    const { kx, kz } = this;
    for (let n = 0; n < this.active.length; n++) {
      const i = this.active[n];
      kx[i] = face(i, i + 1); kz[i] = face(i, i + W);
      // 左・上が非アクティブ（外気や最下行）の場合に備えて相手側の面も埋める
      kx[i - 1] = face(i - 1, i); kz[i - W] = face(i - W, i);
    }
    // 安定な時間刻み
    let worst = 0;
    for (let n = 0; n < this.active.length; n++) {
      const i = this.active[n];
      const s = (kx[i] + kx[i - 1] + kz[i] + kz[i - W]) * invC[i];
      if (s > worst) worst = s;
    }
    this.dtMax = 0.8 / worst;
  }

  thermalSteps(span) {
    const n = Math.max(1, Math.ceil(span / this.dtMax));
    const dt = span / n;
    const { active, kx, kz, invC, loss } = this;
    const W = this.g.W;
    const mat = this.g.mat, coalId = this.g.coalId;
    // 炭は発熱体として扱う。温度は発熱と放熱の釣り合いで決まる。
    const gen = new Float32Array(this.g.nCoals);
    const draft = 1 + TUNE.coalDraft * Math.min(1.3, this.flowSm / 12);
    for (let c = 0; c < this.g.nCoals; c++) {
      // 発熱・放熱・周囲とのやり取りをすべて同じ重みで扱う（炭自身の温度は重みに依らない）
      gen[c] = (TUNE.coalPower * TUNE.coalCoupling * this.g.coalWeight[c] * Math.min(1, this.fuel[c] / 0.35) * draft * dt) / MATERIALS[M.COAL].rhoc;
    }
    let T = this.T, T2 = this.T2;
    for (let s = 0; s < n; s++) {
      for (let a = 0; a < active.length; a++) {
        const i = active[a];
        const ti = T[i];
        let v = ti + dt * invC[i] * (kx[i] * (T[i + 1] - ti) + kx[i - 1] * (T[i - 1] - ti) + kz[i] * (T[i + W] - ti) + kz[i - W] * (T[i - W] - ti));
        if (loss[i] > 0) v -= dt * loss[i] * (v - AMBIENT_C);
        if (mat[i] === M.COAL) {
          v += gen[coalId[i]];
          if (v > TUNE.coalMaxC) v = TUNE.coalMaxC;
        }
        T2[i] = v;
      }
      for (let a = 0; a < active.length; a++) { const i = active[a]; T[i] = T2[i]; }
    }
  }

  // ---- 気流に沿った熱と成分の輸送 ----
  flowSweep(lpm, dt, toMouth) {
    const g = this.g, { W, N, mat } = g, fl = this.flow, nc = this.nc;
    const T = this.T, Tg = this.Tg, Y = this.Y, c = this.c, comp = this.comp;
    const scale = fl.scalePerLpm * lpm * 1e-6; // mol/s per unit flux per mm2
    const yin = new Float64Array(nc), yeq = new Float64Array(nc);
    const outMol = new Float64Array(nc);
    const cellVol = 1e-9;
    this.evap.fill(0);

    const equilibrium = (t, tk) => {
      const base = t * nc;
      let liq = this.sugarMol;
      for (let k = 0; k < nc; k++) liq += c[base + k];
      for (let k = 0; k < nc; k++) {
        const cp = comp[k];
        const a = Math.min(1, (cp.gamma * c[base + k]) / liq);
        const ps = Math.exp((-cp.dH * 1000 / R_GAS) * (1 / tk - 1 / (cp.bp + 273.15)));
        yeq[k] = Math.min(0.85, a * ps);
      }
    };
    // 葉セル idx と通過空気 nmol[mol/s] の間で成分と潜熱をやり取りする。yin を更新する。
    const exchange = (idx, nmol, eff) => {
      const t = this.tobIndex[idx], base = t * nc;
      equilibrium(t, T[idx] + 273.15);
      let heat = 0;
      for (let k = 0; k < nc; k++) {
        const d = yeq[k] - yin[k];
        let dy;
        if (d > 0) {
          dy = eff * d;
          const maxMol = c[base + k] * cellVol;
          let mol = nmol * dy * dt;
          if (mol > maxMol) { mol = maxMol; dy = mol / (nmol * dt); }
          c[base + k] -= mol / cellVol;
          heat -= mol * comp[k].dH * 1000;
          this.evap[base + k] += mol / dt;
        } else {
          dy = d * (k === 0 ? TUNE.depWater : TUNE.depAroma);
          const mol = -nmol * dy * dt;
          c[base + k] += mol / cellVol;
          heat += mol * comp[k].dH * 1000;
        }
        yin[k] += dy;
      }
      T[idx] += heat * this.invC[idx] / DX; // invC = 1/(rhoc dx²) → J を温度へ: /(rhoc dx³)
    };

    for (let n = 0; n < fl.cells.length; n++) {
      const i = fl.cells[n];
      let fin = 0, tin = 0;
      yin.fill(0);
      for (let u = fl.upStart[n]; u < fl.upStart[n + 1]; u++) {
        const j = fl.upIdx[u], f = fl.upF[u];
        fin += f;
        if (mat[j] === M.AMBIENT) tin += f * AMBIENT_C;
        else {
          tin += f * Tg[j];
          const b = j * nc;
          for (let k = 0; k < nc; k++) yin[k] += f * Y[b + k];
        }
      }
      if (fin < 1e-12) { Tg[i] = T[i]; for (let k = 0; k < nc; k++) Y[i * nc + k] = 0; continue; }
      tin /= fin;
      for (let k = 0; k < nc; k++) yin[k] /= fin;
      const nmol = fin * scale;
      const hcap = nmol * CP_AIR; // W/K
      let tout = tin;
      if (fl.isOutlet[i]) {
        for (let k = 0; k < nc; k++) outMol[k] += nmol * yin[k];
      } else if (mat[i] === M.TOBACCO) {
        tout = T[i] + (tin - T[i]) * (1 - TUNE.bedEff);
        T[i] += hcap * (tin - tout) * dt * this.invC[i] / DX;
        exchange(i, nmol, TUNE.evapEff);
      } else {
        // 空気セル・スリット: 隣接する固体と熱交換し、葉面からは成分を拾う
        const ntu = (TUNE.hWall * DX * DX) / hcap;
        const e = 1 - Math.exp(-ntu);
        if (mat[i] === M.ALU_PERF || mat[i] === M.STEEL_PERF) {
          tout = T[i] + (tin - T[i]) * (1 - Math.min(0.9, e * 2));
          T[i] += hcap * (tin - tout) * dt * this.invC[i] / DX;
        } else {
          const nb = [i - 1, i + 1, i - W, i + W];
          let ne = 0;
          for (let q = 0; q < 4; q++) { const m = mat[nb[q]]; if (m !== M.AIR && m !== M.AMBIENT) ne++; }
          const ee = ne > 0 ? Math.min(e, 0.9 / ne) : 0;
          for (let q = 0; q < 4; q++) {
            const j = nb[q], m = mat[j];
            if (m === M.AIR || m === M.AMBIENT || j >= N - W) continue;
            const dq = ee * (T[j] - tin); // 空気の温度上昇
            tout += dq;
            T[j] -= hcap * dq * dt * this.invC[j] / DX;
            if (m === M.TOBACCO) exchange(j, nmol, TUNE.surfEff);
          }
          T[i] = tout;
        }
      }
      Tg[i] = tout;
      const b = i * nc;
      for (let k = 0; k < nc; k++) Y[b + k] = yin[k];
    }
    // 口元側へ出る量 [mg/s]
    const a = fl.areaRatio;
    for (let k = 0; k < nc; k++) {
      const mg = toMouth ? outMol[k] * a * comp[k].mw * 1000 : 0;
      this.emit[k] += (mg - this.emit[k]) * Math.min(1, dt / 0.6);
      this.delivered[k] += mg * dt;
    }
  }

  tick(lpm) {
    const dt = TICK;
    this.flowSm += (lpm - this.flowSm) * Math.min(1, dt / 4);
    // 炭の燃焼
    const life = TUNE.coalLifeMin * 60;
    for (let c = 0; c < this.fuel.length; c++) {
      this.fuel[c] = Math.max(0, this.fuel[c] - (dt / life) * (1 + 0.5 * Math.min(1.5, this.flowSm / 12)));
    }
    this.updateCoefficients();
    this.thermalSteps(dt);
    const sucking = lpm > 0;
    this.flowSweep(sucking ? lpm : TUNE.idleLpm, dt, sucking);
    this.time += dt;
    this.computeStats(lpm);
  }

  // 実時間 span 秒ぶん進める
  advance(span, lpm) {
    this.tickAcc += span;
    let n = 0;
    while (this.tickAcc >= TICK) { this.tick(lpm); this.tickAcc -= TICK; n++; }
    return n;
  }

  computeStats(lpm) {
    const g = this.g, T = this.T, nc = this.nc;
    const sum = [0, 0, 0], cnt = [0, 0, 0], rem = [0, 0, 0];
    let maxTob = 0, hot = 0;
    const remain = new Float64Array(nc);
    for (let t = 0; t < g.tob.length; t++) {
      const idx = g.tob[t], l = g.layer[idx], v = T[idx];
      sum[l] += v; cnt[l]++;
      rem[l] += this.c[t * nc + 1];
      if (v > maxTob) maxTob = v;
      if (v > this.maxT[idx]) this.maxT[idx] = v;
      if (this.maxT[idx] > this.flavor.scorchC) hot++;
      for (let k = 0; k < nc; k++) remain[k] += this.c[t * nc + k];
    }
    let hf = 0;
    for (const i of g.hmdFloor) hf += T[i];
    let ct = 0;
    for (const i of this.lowerCoalCells) ct += T[i];
    this.stats = {
      layerT: sum.map((s, i) => s / cnt[i]),
      layerGly: rem.map((s, i) => s / cnt[i] / this.c0[1]),
      maxTob, scorchFrac: hot / g.tob.length,
      hmdFloorT: hf / Math.max(1, g.hmdFloor.length),
      coalT: ct / Math.max(1, this.lowerCoalCells.length),
      fuel: Array.from(this.fuel),
      lpm,
      remain: Array.from(remain, (r, k) => r / g.tob.length / this.c0[k]),
    };
    if (this.time - this.lastHist >= 2) {
      this.lastHist = this.time;
      this.history.push({ t: this.time, top: this.stats.layerT[0], mid: this.stats.layerT[1], bot: this.stats.layerT[2], gly: this.emit[1], hmd: this.stats.hmdFloorT });
      if (this.history.length > 5400) this.history.shift();
    }
  }
}

// 温度ごとの「出やすさ」: 初期配合での気液平衡濃度 [mg/L 空気]
export function equilibriumCurve(flavor, key, tC) {
  const rho = TUNE.bulkDensity;
  const keys = ['water', 'glycerol', ...Object.keys(flavor.aroma)];
  let liq = (rho * flavor.frac.sugar * 1000) / 180.16, mine = 0;
  for (const k of keys) {
    const mf = k === 'water' ? flavor.frac.water : k === 'glycerol' ? flavor.frac.glycerol : flavor.aroma[k] / 1000;
    const mol = (rho * mf * 1000) / COMPOUNDS[k].mw;
    liq += mol;
    if (k === key) mine = mol;
  }
  const cp = COMPOUNDS[key], tk = tC + 273.15;
  const a = Math.min(1, (cp.gamma * mine) / liq);
  const ps = Math.min(1, a * Math.exp((-cp.dH * 1000 / R_GAS) * (1 / tk - 1 / (cp.bp + 273.15))));
  return (ps * P_ATM) / (R_GAS * tk) * cp.mw; // g/m3 = mg/L
}
