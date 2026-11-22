// 3D（2 mm 格子・y>=0 の半分）の熱・気流・炭の燃焼・気化シミュレーション。
// 熱: 陽解法の熱伝導 + 面どうしの放射（radiation.js）+ 外気への対流・放射 + 吸引時の空気による熱の運搬
// 炭: 塊ごとに「芯の温度・質量・灰の殻の厚さ」を持つ。燃焼速度は表面への酸素の拡散（灰の殻を通る分を含む）で決まり、
//     発熱は消費酸素量から求める。吸うと表面の流れが速くなって酸素が多く届き、炭が熱くなる。
// 気流: Darcy 型の圧力場（flow.js）。流量は吸う強さに比例させる
// 気化: 通過する空気が各セルで気液平衡に近づく。空気側の物質移動は熱移動と同じ速さ（Chilton–Colburn）とし、
//       シロップ側の拡散抵抗を直列に足す。水の活量は Norrish 式。
import { M, MATERIALS, COMPOUNDS, AMBIENT_C, COAL, NORRISH } from './data.js';
import { GRID, D, buildStatic, slotsOf, placeCoals, overlayCoals, isMetal, isPerf, izOf, iyOf } from './geometry.js';
import { solveFlow } from './flow.js';
import { buildRadiation, radiosity, SIGMA } from './radiation.js';

const DX = D * 1e-3;
const AF = DX * DX; // 面の面積 [m2]
const VOL = DX * DX * DX;
const R_GAS = 8.314;
const P_ATM = 101325;
const TA = AMBIENT_C + 273.15;
const CP_AIR = 29.1; // J/mol K
const CP_AIR_KG = 1100; // J/kg K（高温の空気）
const TICK = 0.2; // 気流・気化・炭・放射の更新間隔 [s]

// 調整係数。公表値・文献値がないもので、実測例に合わせて決める（README の「較正」参照）。
export const TUNE = {
  hNat: 8, // 器具の面と、器具内の空気の自然対流 [W/m2K]
  hNatCoal: 12, // 炭の面の自然対流 [W/m2K]（高温の立方体まわりの層流自然対流の目安）
  // 吸引時の強制対流 h = hForced·√u [W/m2K, u は m/s]。平板層流の相関式（600 K の空気、代表長 25 mm）では 23 だが、
  // それでは吸った瞬間に上層が温まってしまい、実測（吸うと上層が下がる）と逆になる。実測に合わせて 8 にした。
  hForced: 8,
  plumeRate: 5, // 上が開いた空気セルが浮力で外気と入れ替わる速さ [1/s]
  hOut: 8, // 器具の外面の自然対流 [W/m2K]
  rimContactH: 150, // HMD とボウルのリムの接触熱伝達率 [W/m2K]
  coalContactH: 20, // 炭と器具・炭どうしの接触熱伝達率 [W/m2K]（灰をはさんだ点接触）
  perfNTU: 0.2, // 穴あき金属セルを通る空気の熱交換の伝熱単位数
  bedEff: 0.9, // 葉セル1つ（2 mm）を通る空気の熱交換効率
  liqRes: 0.15, // シロップ側の拡散抵抗の大きさ（空気側との比。150℃基準）
  liqE: 40e3, // シロップ中の拡散の活性化エネルギー [J/mol]（粘度の温度依存の目安）
  depAroma: 0.08, // 過飽和分が葉に戻る割合（残りはミストとして通過）
  depWater: 0.3,
  idleLpm: 0.1, // 吸っていない間の自然な通気
  bulkDensity: 480, // 葉の充填密度 [kg/m3]
  o2Mult: 1.0, // 炭の燃焼速度の較正係数
  ashVolRatio: 0.35, // 燃えた炭の体積に対する灰の殻の体積の比
  ashDiff: 0.5, // 灰の殻の中の酸素の通りやすさ（空隙率/屈曲度）
  kAsh: 0.25, // 灰の殻の熱伝導率 [W/mK]
  ashResidual: 0.2, // 灰を落としたあとに残る殻の厚さ [mm]
  kinA: 8.6e5, // 炭の表面反応の頻度因子 [kg/m2s]
  kinE: 130e3, // 炭の表面反応の活性化エネルギー [J/mol]
  coalStartC: 800, // 着火済みの炭を載せた時点の芯の温度
  coalStartAsh: 0.3, // 着火で付いている灰の殻 [mm]
};

const CP = { leaf: 1500, sugar: 1250, water: 4180, glycerol: 2400 };
const DIR6 = [1, -1, GRID.SY, -GRID.SY, GRID.SZ, -GRID.SZ];

export class Sim {
  constructor(bowl, hmd, layout, flavor, coalMm = 25) {
    this.bowl = bowl; this.hmd = hmd; this.layout = layout; this.flavor = flavor; this.coalMm = coalMm;
    const st = (this.st = buildStatic(bowl, hmd));
    const { N } = GRID;
    this.g = st; // 互換: g.tob, g.layer, g.outlet, g.hmdFloor, g.layerBounds
    this.T = new Float32Array(N).fill(AMBIENT_C);
    this.T2 = new Float32Array(N);
    this.maxT = new Float32Array(N).fill(AMBIENT_C);
    this.Gx = new Float32Array(N); this.Gy = new Float32Array(N); this.Gz = new Float32Array(N);
    this.C = new Float32Array(N);
    this.S = new Float32Array(N); // 放射の正味の受熱 [W]
    this.L = new Float32Array(N); // 外気への放熱係数 [W/K]（浮力による入れ替わり）

    // 成分
    const fl = flavor;
    this.compKeys = ['water', 'glycerol', ...Object.keys(fl.aroma)];
    this.nc = this.compKeys.length;
    this.comp = this.compKeys.map((k) => COMPOUNDS[k]);
    this.sc = this.comp.map((c) => 0.6 * Math.sqrt(c.mw / 18)); // シュミット数（分子量から概算）
    const nt = st.tob.length;
    this.tobIndex = new Int32Array(N).fill(-1);
    st.tob.forEach((idx, t) => (this.tobIndex[idx] = t));
    this.c = new Float32Array(nt * this.nc); // mol/m3
    const rho = TUNE.bulkDensity;
    this.c0 = this.compKeys.map((k) => {
      const massFrac = k === 'water' ? fl.frac.water : k === 'glycerol' ? fl.frac.glycerol : fl.aroma[k] / 1000;
      return (rho * massFrac * 1000) / COMPOUNDS[k].mw;
    });
    for (let t = 0; t < nt; t++) for (let k = 0; k < this.nc; k++) this.c[t * this.nc + k] = this.c0[k];
    this.sugarMol = (rho * fl.frac.sugar * 1000) / 180.16;
    this.dryRhoc = rho * (fl.frac.leaf * CP.leaf + fl.frac.sugar * CP.sugar);
    this.evap = new Float32Array(nt * this.nc);

    // 炭
    this.coals = slotsOf(layout).map((sl) => this.freshCoal(sl));
    this.geomVersion = 0;
    this.rebuild();

    this.Tg = new Float32Array(N);
    this.Y = new Float32Array(N * this.nc);
    this.time = 0;
    this.tickAcc = 0;
    this.lpmNow = 0;
    this.emit = new Float32Array(this.nc); // 口元側へ出る量 mg/s（平滑化）
    this.delivered = new Float32Array(this.nc); // 累積 mg
    this.events = [];
    this.stats = {};
    this.history = [];
    this.lastHist = -1e9;
    this.updateCoefficients();
    this.updateRadiation();
    this.solveCoals(0);
    this.computeStats(0);
  }

  freshCoal(slot) {
    const s = this.coalMm - 2 * TUNE.coalStartAsh; // 着火で表面が灰になった分だけ芯が小さい
    const m = COAL.density * (s * 1e-3) ** 3;
    const o = this.coalMm;
    const ashVol = o ** 3 - s ** 3; // mm3
    return { ...slot, s, a: TUNE.coalStartAsh, m, m0: COAL.density * (this.coalMm * 1e-3) ** 3, ashVol, Tc: TUNE.coalStartC, Ts: TUNE.coalStartC - 50, q: 0, qOut: 0, dead: false, Gf: 0, GfT: 0, vox: null };
  }

  // ---- 炭の配置が変わったときの組み直し ----
  rebuild() {
    const st = this.st;
    placeCoals(this.hmd, this.coals);
    const { mat, coalId } = overlayCoals(st, this.coals);
    const prev = this.mat;
    this.mat = mat; this.coalId = coalId;
    this.coalVoxKey = this.voxKey();
    if (prev) {
      // 炭が抜けたセルは周りの空気の温度へ
      for (let i = 0; i < GRID.N; i++) if (prev[i] === M.COAL && mat[i] !== M.COAL) this.T[i] = (this.T[i] + AMBIENT_C) / 2;
    }
    // 上が開いた空気セル（真上に空気だけが続いて外気に抜ける）。浮力で外気と入れ替わるとみなす。
    const { NX, NY, NZ } = GRID;
    this.open = new Uint8Array(GRID.N);
    for (let iy = 1; iy < NY - 1; iy++) for (let ix = 1; ix < NX - 1; ix++) {
      let z = 1;
      for (; z < NZ; z++) if (mat[ix + NX * (iy + NY * z)] !== M.AMBIENT) break;
      for (; z < NZ; z++) { const i = ix + NX * (iy + NY * z); if (mat[i] !== M.AIR) break; this.open[i] = 1; }
    }
    this.flow = solveFlow(mat, st.pS, st.outlet, this.flow ? this.flow.p : null, TA);
    this.rad = buildRadiation(mat, 40, 7);
    // 面ごとの放射率と面積（斜めの炭は階段状になって面積が増えるので割り戻す）
    const rad = this.rad;
    this.fEps = new Float64Array(rad.nf);
    this.fArea = new Float64Array(rad.nf);
    for (let f = 0; f < rad.nf; f++) {
      const i = rad.fCell[f], m = mat[i];
      this.fEps[f] = isMetal(m) || isPerf(m) ? this.hmd.eps : MATERIALS[m].eps;
      this.fArea[f] = AF;
    }
    // 炭ごとの境界面の一覧
    this.coals.forEach((c) => { c.faces = []; c.radFaces = []; c.cells = []; });
    for (let i = 0; i < GRID.N; i++) {
      if (mat[i] !== M.COAL) continue;
      const c = this.coals[coalId[i]];
      c.cells.push(i);
      for (let d = 0; d < 6; d++) {
        if (d === 3 && iyOf(i) === 1) continue; // 鏡の面（相手の炭と接していて熱の出入りはない）
        const j = i + DIR6[d];
        if (mat[j] === M.COAL && coalId[j] === coalId[i]) continue;
        c.faces.push({ i, j, d });
      }
    }
    this.coals.forEach((c, id) => {
      if (c.dead) return;
      // 実寸の表面積（計算領域内）に合わせる係数
      const o = (c.s + 2 * c.a) * 1e-3;
      const exposed = (c.frac === 1 ? 5 : 3) * o * o;
      c.areaK = c.faces.length ? exposed / (c.faces.length * AF) : 1;
      c.areaDom = exposed;
      for (let f = 0; f < rad.nf; f++) if (coalId[rad.fCell[f]] === id) { this.fArea[f] = AF * c.areaK; c.radFaces.push(f); }
    });
    this.activeList();
    this.buildFaces();
    this.geomVersion++;
  }

  voxKey() {
    // 炭の格子が変わるかどうかの判定用（外寸と位置を 0.5 セル単位で丸める）
    return this.coals.map((c) => (c.dead ? 'x' : [c.cx, c.cy, c.cz, c.s + 2 * c.a].map((v) => Math.round(v / (D / 2))).join(','))).join('|');
  }

  activeList() {
    const act = [];
    const { N } = GRID;
    for (let i = GRID.SZ; i < N - GRID.SZ; i++) {
      const m = this.mat[i];
      if (m === M.AMBIENT || m === M.COAL) continue;
      if (iyOf(i) === 0) continue;
      act.push(i);
    }
    this.active = Int32Array.from(act);
  }

  // ---- 係数更新（温度依存）----
  // 面の熱コンダクタンス [W/K]
  faceG(i, j) {
    const { mat, T, st, coalId } = this;
    const kOf = (q) => {
      const m = mat[q];
      if (m === M.AIR || m === M.AMBIENT) return 0.026 * Math.pow((T[q] + 273.15) / 300, 0.8);
      return MATERIALS[m].k * st.kS[q];
    };
    const mi = mat[i], mj = mat[j];
    const ai = mi === M.AMBIENT, aj = mj === M.AMBIENT;
    if (ai && aj) return 0;
    const airI = mi === M.AIR, airJ = mj === M.AIR;
    if (ai || aj) {
      const s = ai ? j : i;
      if (mat[s] === M.AIR) return (kOf(s) * AF) / (DX / 2);
      const tk = T[s] + 273.15, m = mat[s];
      const eps = isMetal(m) || isPerf(m) ? this.hmd.eps : MATERIALS[m].eps;
      const g = (TUNE.hOut + eps * SIGMA * (tk * tk + TA * TA) * (tk + TA)) * AF;
      return m === M.COAL ? g * this.coals[coalId[s]].areaK : g;
    }
    if (airI && airJ) { const a = kOf(i), b = kOf(j); return ((2 * a * b) / (a + b)) * AF / DX; }
    if (airI || airJ) {
      const s = airI ? j : i;
      if (mat[s] === M.COAL) return TUNE.hNatCoal * AF * this.coals[coalId[s]].areaK;
      return TUNE.hNat * AF;
    }
    const ci = mi === M.COAL, cj = mj === M.COAL;
    if (ci && cj) return coalId[i] === coalId[j] ? 0 : TUNE.coalContactH * AF * this.coals[coalId[i]].areaK;
    if (ci || cj) return TUNE.coalContactH * AF * this.coals[coalId[ci ? i : j]].areaK;
    const metI = isMetal(mi) || isPerf(mi), metJ = isMetal(mj) || isPerf(mj);
    const bowlI = mi === M.CLAY || mi === M.STONEWARE, bowlJ = mj === M.CLAY || mj === M.STONEWARE;
    if ((metI && bowlJ) || (metJ && bowlI)) return TUNE.rimContactH * AF * Math.min(st.kS[i], st.kS[j]);
    const a = kOf(i), b = kOf(j);
    return a > 0 && b > 0 ? ((2 * a * b) / (a + b)) * AF / DX : 0;
  }

  // 形が変わったときに全部の面を計算し、温度で変わる面（空気・外気に接する面）を一覧にしておく
  buildFaces() {
    const { N, SY, SZ, NY } = GRID;
    const { mat, Gx, Gy, Gz } = this;
    Gx.fill(0); Gy.fill(0); Gz.fill(0);
    const dyn = [];
    const G = [Gx, Gy, Gz], off = [1, SY, SZ];
    for (let i = SZ; i < N - 1; i++) {
      const iy = iyOf(i);
      if (iy === 0) continue;
      for (let k = 0; k < 3; k++) {
        if (k === 1 && iy >= NY - 1) continue;
        if (k === 2 && i >= N - SZ) continue;
        const j = i + off[k];
        const mi = mat[i], mj = mat[j];
        if (mi === M.AMBIENT && mj === M.AMBIENT) continue;
        G[k][i] = this.faceG(i, j);
        const dynamic = mi === M.AIR || mj === M.AIR || ((mi === M.AMBIENT) !== (mj === M.AMBIENT));
        if (dynamic) dyn.push(i * 3 + k);
      }
    }
    this.dynFaces = Int32Array.from(dyn);
  }

  // ---- 係数更新（温度依存）----
  updateCoefficients() {
    const { SY, SZ } = GRID;
    const { mat, T, Gx, Gy, Gz, C, L, st } = this;
    const nc = this.nc;
    const G = [Gx, Gy, Gz], off = [1, SY, SZ];
    const dyn = this.dynFaces;
    for (let n = 0; n < dyn.length; n++) {
      const i = (dyn[n] / 3) | 0, k = dyn[n] - i * 3;
      G[k][i] = this.faceG(i, i + off[k]);
    }
    // 熱容量
    let dtMin = Infinity;
    const act = this.active;
    for (let n = 0; n < act.length; n++) {
      const i = act[n], m = mat[i];
      let rhoc;
      if (m === M.TOBACCO) {
        const t = this.tobIndex[i] * nc;
        rhoc = this.dryRhoc + this.c[t] * 0.01802 * CP.water + this.c[t + 1] * 0.09209 * CP.glycerol;
      } else if (m === M.AIR) {
        rhoc = (P_ATM / (287 * (T[i] + 273.15))) * 1030;
      } else rhoc = MATERIALS[m].rhoc * st.kS[i];
      C[i] = rhoc * VOL;
      L[i] = m === M.AIR && this.open[i] ? TUNE.plumeRate * C[i] : 0;
      if (m !== M.AIR) {
        const s = Gx[i] + Gx[i - 1] + Gy[i] + Gy[i - SY] + Gz[i] + Gz[i - SZ];
        if (s > 0) dtMin = Math.min(dtMin, C[i] / s);
      }
    }
    const dt = Math.min(0.05, 0.8 * dtMin);
    // 空気セルは熱容量が小さく時間刻みを縛るので、時間刻みに合わせて熱容量を底上げする（準定常として扱う）
    for (let n = 0; n < act.length; n++) {
      const i = act[n];
      if (mat[i] !== M.AIR) continue;
      const s = Gx[i] + Gx[i - 1] + Gy[i] + Gy[i - SY] + Gz[i] + Gz[i - SZ];
      const need = ((s + L[i]) * dt) / 0.8;
      if (C[i] < need) C[i] = need;
    }
    this.dtMax = dt;
  }

  // ---- 放射 ----
  updateRadiation() {
    const rad = this.rad, S = this.S;
    S.fill(0);
    const eb = radiosity(rad, this.T, this.fEps, AMBIENT_C, 3);
    this.coals.forEach((c) => { c.radAH = 0; c.radAe = 0; });
    for (let f = 0; f < rad.nf; f++) {
      const i = rad.fCell[f];
      if (this.mat[i] === M.COAL) {
        const c = this.coals[this.coalId[i]];
        c.radAH += this.fArea[f] * this.fEps[f] * rad.H[f];
        c.radAe += this.fArea[f] * this.fEps[f];
      } else S[i] += this.fArea[f] * this.fEps[f] * (rad.H[f] - eb[f]);
    }
  }

  // ---- 炭: 表面温度・燃焼・灰 ----
  solveCoals(dt) {
    const { T, mat, coalId, Gx, Gy, Gz } = this;
    const { SY, SZ } = GRID;
    const gOf = (i, d) => (d === 0 ? Gx[i] : d === 1 ? Gx[i - 1] : d === 2 ? Gy[i] : d === 3 ? Gy[i - SY] : d === 4 ? Gz[i] : Gz[i - SZ]);
    const lpm = this.lpmNow;
    const fl = this.flow;
    for (const c of this.coals) {
      if (c.dead) continue;
      // 伝導（接触・自然対流・外気）
      let G = 0, GT = 0;
      for (const f of c.faces) {
        const g = gOf(f.i, f.d);
        G += g;
        GT += g * (mat[f.j] === M.COAL ? this.coals[coalId[f.j]].Ts : T[f.j]);
      }
      // 燃焼: 空気に面した面ごとに、酸素の流れの抵抗（境膜・灰の殻・表面反応）を直列に足す
      const tsK = c.Ts + 273.15, tcK = c.Tc + 273.15;
      const film = (tsK + 300) / 2;
      const rhoD = (P_ATM * 0.029 / (R_GAS * film)) * 1.8e-5 * (film / 273) ** 1.75 * TUNE.ashDiff;
      const bA = c.a > 0 ? rhoD / (c.a * 1e-3) : Infinity;
      const bK = TUNE.kinA * Math.exp(-TUNE.kinE / (R_GAS * tcK));
      let o2 = 0;
      for (const f of c.faces) {
        const m = mat[f.j];
        if (m !== M.AIR && m !== M.AMBIENT) continue;
        let h = TUNE.hNatCoal;
        if (lpm > 0 && m === M.AIR) {
          const n = fl.through[f.j] * fl.molPerLpm * lpm; // mol/s
          const u = n / ((P_ATM / (R_GAS * (T[f.j] + 273.15))) * AF);
          h += TUNE.hForced * Math.sqrt(u);
        }
        const bG = h / CP_AIR_KG;
        o2 += (AF * c.areaK * COAL.yO2) / (1 / bG + 1 / bA + 1 / bK);
      }
      const qComb = o2 * COAL.o2Heat * TUNE.o2Mult; // W（計算領域内）
      // 芯→表面の熱抵抗（芯の中の伝導 + 灰の殻）
      const Ad = c.areaDom;
      const R = (c.s * 1e-3) / 6 / (COAL.kChar * Ad) + (c.a * 1e-3) / (TUNE.kAsh * Ad);
      // 表面の釣り合い: (Tc−Ts)/R = G(Ts) − GT + Gf·Ts − GfT + Aεσ Ts⁴ − AεH をニュートン法で解く
      let ts = c.Ts;
      for (let it = 0; it < 8; it++) {
        const k = ts + 273.15;
        const f = (c.Tc - ts) / R - (G * ts - GT + c.Gf * ts - c.GfT + c.radAe * SIGMA * k ** 4 - c.radAH);
        const df = -1 / R - G - c.Gf - 4 * c.radAe * SIGMA * k ** 3;
        const nts = ts - f / df;
        if (Math.abs(nts - ts) < 0.01) { ts = nts; break; }
        ts = nts;
      }
      c.Ts = Math.max(AMBIENT_C, Math.min(c.Tc, ts));
      const qOut = (c.Tc - c.Ts) / R;
      c.q = qComb / c.frac; c.qOut = qOut / c.frac; // 1個あたり
      if (dt > 0) {
        const Cd = c.m * COAL.cp * c.frac + 1e-6;
        c.Tc += (dt * (qComb - qOut)) / Cd;
        // 燃えた分だけ芯が小さくなり、一部が灰の殻になる
        const dm = (qComb / c.frac / COAL.hhv) * dt;
        c.m = Math.max(0, c.m - dm);
        const sNew = Math.cbrt(c.m / COAL.density) * 1e3;
        c.ashVol += TUNE.ashVolRatio * (c.s ** 3 - sNew ** 3);
        c.s = sNew;
        c.a = (Math.cbrt(c.s ** 3 + c.ashVol) - c.s) / 2;
        c.dead = c.s < 4;
      }
      // 表示用: 芯は芯の温度、表面のセルは表面温度
      for (const i of c.cells) T[i] = c.Tc;
      for (const f of c.faces) T[f.i] = c.Ts;
    }
  }

  thermalSteps(span) {
    const n = Math.max(1, Math.ceil(span / this.dtMax));
    const dt = span / n;
    const { active, Gx, Gy, Gz, C, S, L } = this;
    const { SY, SZ } = GRID;
    let T = this.T, T2 = this.T2;
    for (let s = 0; s < n; s++) {
      for (let a = 0; a < active.length; a++) {
        const i = active[a];
        const ti = T[i];
        const q = Gx[i] * (T[i + 1] - ti) + Gx[i - 1] * (T[i - 1] - ti) + Gy[i] * (T[i + SY] - ti) + Gy[i - SY] * (T[i - SY] - ti)
          + Gz[i] * (T[i + SZ] - ti) + Gz[i - SZ] * (T[i - SZ] - ti) + S[i] - L[i] * (ti - AMBIENT_C);
        T2[i] = ti + (dt * q) / C[i];
      }
      for (let a = 0; a < active.length; a++) { const i = active[a]; T[i] = T2[i]; }
    }
  }

  // ---- 気流に沿った熱と成分の輸送 ----
  flowSweep(lpm, dt, toMouth) {
    const { SY, SZ } = GRID;
    const fl = this.flow, nc = this.nc, mat = this.mat, coalId = this.coalId;
    const T = this.T, Tg = this.Tg, Y = this.Y, c = this.c, comp = this.comp, C = this.C;
    const scale = fl.molPerLpm * lpm;
    const yin = new Float64Array(nc), yeq = new Float64Array(nc), mk = new Float64Array(nc);
    const outMol = new Float64Array(nc);
    this.evap.fill(0);
    for (const co of this.coals) { co.Gf = 0; co.GfT = 0; }
    const ntuBed = -Math.log(1 - TUNE.bedEff);

    const equilibrium = (t, tk) => {
      const base = t * nc;
      let liq = this.sugarMol;
      for (let k = 0; k < nc; k++) liq += c[base + k];
      const xg = c[base + 1] / liq, xs = this.sugarMol / liq;
      const lnAw = -((Math.sqrt(NORRISH.glycerol) * xg + Math.sqrt(NORRISH.sugar) * xs) ** 2);
      for (let k = 0; k < nc; k++) {
        const cp = comp[k];
        const x = c[base + k] / liq;
        const a = k === 0 ? x * Math.exp(lnAw) : Math.min(1, cp.gamma * x);
        const ps = Math.exp((-cp.dH * 1000 / R_GAS) * (1 / tk - 1 / (cp.bp + 273.15)));
        yeq[k] = Math.min(0.85, a * ps);
        mk[k] = x > 1e-12 ? (a * ps) / x : 0; // 平衡線の傾き dy*/dx
      }
    };
    // 葉セル idx と通過空気 nmol[mol/s] の間で成分と潜熱をやり取りする。ntu は熱の伝熱単位数。
    const exchange = (idx, nmol, ntu) => {
      const t = this.tobIndex[idx], base = t * nc;
      const tk = T[idx] + 273.15;
      equilibrium(t, tk);
      const liqF = TUNE.liqRes * Math.exp((TUNE.liqE / R_GAS) * (1 / tk - 1 / 423.15));
      let heat = 0;
      for (let k = 0; k < nc; k++) {
        const ntuG = ntu * Math.pow(0.7 / this.sc[k], 2 / 3);
        const eff = 1 - Math.exp(-ntuG / (1 + mk[k] * liqF));
        const d = yeq[k] - yin[k];
        let dy;
        if (d > 0) {
          dy = eff * d;
          const maxMol = c[base + k] * VOL;
          let mol = nmol * dy * dt;
          if (mol > maxMol) { mol = maxMol; dy = mol / (nmol * dt); }
          c[base + k] -= mol / VOL;
          heat -= mol * comp[k].dH * 1000;
          this.evap[base + k] += mol / dt;
        } else {
          dy = d * (k === 0 ? TUNE.depWater : TUNE.depAroma);
          const mol = -nmol * dy * dt;
          c[base + k] += mol / VOL;
          heat += mol * comp[k].dH * 1000;
        }
        yin[k] += dy;
      }
      T[idx] += heat / C[idx];
    };

    const nbs = [0, 0, 0, 0, 0, 0];
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
      if (fin < 1e-14) { Tg[i] = T[i]; for (let k = 0; k < nc; k++) Y[i * nc + k] = 0; continue; }
      tin /= fin;
      for (let k = 0; k < nc; k++) yin[k] /= fin;
      const nmol = fin * scale;
      const hcap = nmol * CP_AIR; // W/K
      let tout = tin;
      const m = mat[i];
      if (fl.isOutlet[i]) {
        for (let k = 0; k < nc; k++) outMol[k] += nmol * yin[k];
      } else if (m === M.TOBACCO) {
        tout = T[i] + (tin - T[i]) * (1 - TUNE.bedEff);
        T[i] += (hcap * (tin - tout) * dt) / C[i];
        exchange(i, nmol, ntuBed);
      } else if (isPerf(m)) {
        const e = 1 - Math.exp(-TUNE.perfNTU);
        tout = tin + (T[i] - tin) * e;
        T[i] -= (hcap * (tout - tin) * dt) / C[i];
      } else {
        // 空気セル: 隣の固体の面と強制対流で熱をやり取りし、葉の面からは成分を拾う
        const u = nmol / ((P_ATM / (R_GAS * (tin + 273.15))) * AF);
        const h = TUNE.hForced * Math.sqrt(u);
        nbs[0] = i + 1; nbs[1] = i - 1; nbs[2] = i + SY; nbs[3] = i - SY; nbs[4] = i + SZ; nbs[5] = i - SZ;
        let ntuSum = 0;
        const ntuF = (h * AF) / hcap;
        for (let q = 0; q < 6; q++) {
          if (q === 3 && iyOf(i) === 1) continue;
          const mm = mat[nbs[q]];
          if (mm === M.AIR || mm === M.AMBIENT) continue;
          ntuSum += mm === M.COAL ? ntuF * this.coals[coalId[nbs[q]]].areaK : ntuF;
        }
        if (ntuSum > 0) {
          const eTot = 1 - Math.exp(-ntuSum);
          for (let q = 0; q < 6; q++) {
            if (q === 3 && iyOf(i) === 1) continue;
            const j = nbs[q], mm = mat[j];
            if (mm === M.AIR || mm === M.AMBIENT) continue;
            const nt = mm === M.COAL ? ntuF * this.coals[coalId[j]].areaK : ntuF;
            const e = (eTot * nt) / ntuSum;
            const dq = e * (T[j] - tin); // 空気の温度上昇
            tout += dq;
            if (mm === M.COAL) { const co = this.coals[coalId[j]]; co.Gf += hcap * e; co.GfT += hcap * e * tin; }
            else T[j] -= (hcap * dq * dt) / C[j];
            if (mm === M.TOBACCO) exchange(j, nmol, nt);
          }
        }
        T[i] = tout;
      }
      Tg[i] = tout;
      const b = i * nc;
      for (let k = 0; k < nc; k++) Y[b + k] = yin[k];
    }
    // 口元側へ出る量 [mg/s]（半分の領域なので2倍）
    for (let k = 0; k < nc; k++) {
      const mg = toMouth ? 2 * outMol[k] * comp[k].mw * 1000 : 0;
      this.emit[k] += (mg - this.emit[k]) * Math.min(1, dt / 0.6);
      this.delivered[k] += mg * dt;
    }
  }

  // ---- 吸っていない間も起きる気化 ----
  // (1) 沸騰: 成分の蒸気圧の合計が 1 気圧を超える温度（沸点）より熱くなった分の熱は、気化に使われる。
  //     シロップの水はここで抜け、上層の温度は沸点のあたりで足踏みする。
  // (2) 表面からの蒸発: 空気に面した葉の面からは、自然対流で蒸気が逃げる。
  // どちらの蒸気も口元には届かない（HMD の穴から上へ抜ける）として扱う。
  passiveEvap(dt) {
    const nc = this.nc, comp = this.comp, c = this.c, T = this.T, C = this.C, mat = this.mat;
    const st = this.st;
    const { SY, SZ } = GRID;
    const ps = new Float64Array(nc), act = new Float64Array(nc);
    const sumP = (tk) => { let s = 0; for (let k = 0; k < nc; k++) s += act[k] * Math.exp((-comp[k].dH * 1000 / R_GAS) * (1 / tk - 1 / (comp[k].bp + 273.15))); return s; };
    const nbs = [1, -1, SY, -SY, SZ, -SZ];
    for (let t = 0; t < st.tob.length; t++) {
      const i = st.tob[t], base = t * nc;
      let liq = this.sugarMol;
      for (let k = 0; k < nc; k++) liq += c[base + k];
      const xg = c[base + 1] / liq, xs = this.sugarMol / liq;
      const lnAw = -((Math.sqrt(NORRISH.glycerol) * xg + Math.sqrt(NORRISH.sugar) * xs) ** 2);
      for (let k = 0; k < nc; k++) { const x = c[base + k] / liq; act[k] = k === 0 ? x * Math.exp(lnAw) : Math.min(1, comp[k].gamma * x); }
      let tk = T[i] + 273.15;
      // (1) 沸騰
      if (sumP(tk) > 1) {
        let lo = 300, hi = tk;
        for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (sumP(mid) > 1) hi = mid; else lo = mid; }
        const tb = (lo + hi) / 2;
        let E = C[i] * (tk - tb);
        let hy = 0;
        for (let k = 0; k < nc; k++) { ps[k] = act[k] * Math.exp((-comp[k].dH * 1000 / R_GAS) * (1 / tb - 1 / (comp[k].bp + 273.15))); hy += ps[k] * comp[k].dH * 1000; }
        const n = E / hy; // 沸騰で出る蒸気 [mol]
        let used = 0;
        for (let k = 0; k < nc; k++) {
          const mol = Math.min(n * ps[k] / sumP(tb), c[base + k] * VOL);
          c[base + k] -= mol / VOL;
          used += mol * comp[k].dH * 1000;
        }
        T[i] -= used / C[i];
        tk = T[i] + 273.15;
      }
      // (2) 表面からの蒸発
      let faces = 0;
      for (let q = 0; q < 6; q++) {
        if (q === 3 && iyOf(i) === 1) continue;
        if (mat[i + nbs[q]] === M.AIR) faces++;
      }
      if (faces) {
        const nAir = (TUNE.hNat * AF * faces) / CP_AIR; // 境膜を通る空気の当量 [mol/s]
        let heat = 0;
        for (let k = 0; k < nc; k++) {
          const y = Math.min(0.85, act[k] * Math.exp((-comp[k].dH * 1000 / R_GAS) * (1 / tk - 1 / (comp[k].bp + 273.15))));
          const mol = Math.min(nAir * Math.pow(0.7 / this.sc[k], 2 / 3) * y * dt, c[base + k] * VOL);
          c[base + k] -= mol / VOL;
          heat += mol * comp[k].dH * 1000;
        }
        T[i] -= heat / C[i];
      }
    }
  }

  tick(lpm) {
    const dt = TICK;
    this.lpmNow = lpm;
    this.updateCoefficients();
    this.updateRadiation();
    this.solveCoals(dt);
    this.thermalSteps(dt);
    this.passiveEvap(dt);
    const sucking = lpm > 0;
    // 吸っていない間の弱い通気は 1 秒ごとにまとめて流す
    this.idleAcc = (this.idleAcc || 0) + dt;
    if (sucking) { this.flowSweep(lpm, dt, true); this.idleAcc = 0; }
    else if (this.idleAcc >= 1 - 1e-9) { this.flowSweep(TUNE.idleLpm, this.idleAcc, false); this.idleAcc = 0; }
    this.time += dt;
    // 炭が縮んで格子上の形が変わったら組み直す
    if (Math.round(this.time / dt) % 25 === 0) {
      placeCoals(this.hmd, this.coals);
      if (this.voxKey() !== this.coalVoxKey) this.rebuild();
    }
    this.computeStats(lpm);
  }

  // 実時間 span 秒ぶん進める
  advance(span, lpm) {
    this.tickAcc += span;
    let n = 0;
    while (this.tickAcc >= TICK - 1e-9) { this.tick(lpm); this.tickAcc -= TICK; n++; }
    return n;
  }

  // ---- 途中の操作 ----
  // 灰を落とす: 灰の殻を薄い層だけ残して取り除く
  knockAsh(which = 'all') {
    for (const c of this.coals) {
      if (c.dead || (which !== 'all' && c.role !== which)) continue;
      const r = TUNE.ashResidual;
      c.ashVol = (c.s + 2 * r) ** 3 - c.s ** 3;
      c.a = r;
    }
    this.events.push({ t: this.time, kind: 'ash' });
    placeCoals(this.hmd, this.coals);
    this.rebuild();
  }

  // 配置を変える。今ある炭の状態（温度・大きさ・灰）を引き継ぐ。足りない分は新しい炭を足し、余った分は外す。
  setLayout(layout) {
    const old = this.coals.filter((c) => !c.dead);
    const lowers = old.filter((c) => c.role === 'lower');
    const uppers = old.filter((c) => c.role !== 'lower').sort((a, b) => b.m - a.m);
    const next = [];
    for (const sl of slotsOf(layout)) {
      let src = null;
      if (sl.role === 'lower') src = lowers.shift() || uppers.shift();
      else src = uppers.shift() || lowers.shift();
      if (!src) { next.push(this.freshCoal(sl)); continue; }
      const c = { ...src, role: sl.role, n: sl.n, side: sl.side };
      if (sl.role === 'lower' && sl.n === 2 && src.n !== 2) {
        // 1個を2個に: 新しい炭を1個足したのと同じ。2個を同じ状態として平均する
        const f = this.freshCoal(sl);
        c.Tc = (c.Tc + f.Tc) / 2; c.m = (c.m + f.m) / 2; c.ashVol = (c.ashVol + f.ashVol) / 2;
        c.s = Math.cbrt(c.m / COAL.density) * 1e3; c.a = (Math.cbrt(c.s ** 3 + c.ashVol) - c.s) / 2;
      }
      next.push(c);
    }
    this.coals = next;
    this.layout = layout;
    this.events.push({ t: this.time, kind: 'layout' });
    this.rebuild();
  }

  // 上段と下段の炭を入れ替える（燃え進んだ下段を上に、元気な上段を下に）
  swapCoals() {
    const lower = this.coals.find((c) => c.role === 'lower' && !c.dead);
    const upper = this.coals.find((c) => c.role !== 'lower' && !c.dead);
    if (!lower || !upper) return false;
    for (const k of ['s', 'a', 'm', 'ashVol', 'Tc', 'Ts']) [lower[k], upper[k]] = [upper[k], lower[k]];
    this.events.push({ t: this.time, kind: 'swap' });
    this.rebuild();
    return true;
  }

  // すべて新しい炭に替える
  replaceCoals() {
    this.coals = slotsOf(this.layout).map((sl) => this.freshCoal(sl));
    this.events.push({ t: this.time, kind: 'replace' });
    this.rebuild();
  }

  computeStats(lpm) {
    const st = this.st, T = this.T, nc = this.nc;
    const sum = [0, 0, 0], cnt = [0, 0, 0], rem = [0, 0, 0];
    let maxTob = 0, hot = 0;
    const remain = new Float64Array(nc);
    for (let t = 0; t < st.tob.length; t++) {
      const idx = st.tob[t], l = st.layer[idx], v = T[idx];
      sum[l] += v; cnt[l]++;
      rem[l] += this.c[t * nc + 1];
      if (v > maxTob) maxTob = v;
      if (v > this.maxT[idx]) this.maxT[idx] = v;
      if (this.maxT[idx] > this.flavor.scorchC) hot++;
      for (let k = 0; k < nc; k++) remain[k] += this.c[t * nc + k];
    }
    let hf = 0;
    for (const i of st.hmdFloor) hf += T[i];
    const live = this.coals.filter((c) => !c.dead);
    const lower = live.find((c) => c.role === 'lower') || live[0];
    let power = 0;
    for (const c of live) power += c.q * (c.role === 'lower' ? c.n : 1);
    this.stats = {
      layerT: sum.map((s, i) => s / cnt[i]),
      layerGly: rem.map((s, i) => s / cnt[i] / this.c0[1]),
      maxTob, scorchFrac: hot / st.tob.length,
      hmdFloorT: hf / Math.max(1, st.hmdFloor.length),
      coalT: lower ? lower.Tc : AMBIENT_C,
      coalSurfT: lower ? lower.Ts : AMBIENT_C,
      power,
      fuel: this.coals.map((c) => (c.dead ? 0 : c.m / c.m0)),
      coals: this.coals.map((c) => ({ role: c.role, n: c.n, side: c.side, dead: c.dead, Tc: c.Tc, Ts: c.Ts, s: c.s, a: c.a, q: c.q, fuel: c.m / c.m0 })),
      lpm,
      remain: Array.from(remain, (r, k) => r / st.tob.length / this.c0[k]),
    };
    if (this.time - this.lastHist >= 2) {
      this.lastHist = this.time;
      this.history.push({ t: this.time, top: this.stats.layerT[0], mid: this.stats.layerT[1], bot: this.stats.layerT[2], gly: this.emit[1], hmd: this.stats.hmdFloorT, coal: this.stats.coalT, power });
      if (this.history.length > 5400) this.history.shift();
    }
  }
}

// 温度ごとの「出やすさ」: 初期配合での気液平衡濃度 [mg/L 空気]
export function equilibriumCurve(flavor, key, tC) {
  const rho = TUNE.bulkDensity;
  const keys = ['water', 'glycerol', ...Object.keys(flavor.aroma)];
  const sugar = (rho * flavor.frac.sugar * 1000) / 180.16;
  let liq = sugar, mine = 0, gly = 0;
  for (const k of keys) {
    const mf = k === 'water' ? flavor.frac.water : k === 'glycerol' ? flavor.frac.glycerol : flavor.aroma[k] / 1000;
    const mol = (rho * mf * 1000) / COMPOUNDS[k].mw;
    liq += mol;
    if (k === key) mine = mol;
    if (k === 'glycerol') gly = mol;
  }
  const cp = COMPOUNDS[key], tk = tC + 273.15;
  const x = mine / liq;
  const a = key === 'water'
    ? x * Math.exp(-((Math.sqrt(NORRISH.glycerol) * gly / liq + Math.sqrt(NORRISH.sugar) * sugar / liq) ** 2))
    : Math.min(1, cp.gamma * x);
  const ps = Math.min(1, a * Math.exp((-cp.dH * 1000 / R_GAS) * (1 / tk - 1 / (cp.bp + 273.15))));
  return (ps * P_ATM) / (R_GAS * tk) * cp.mw; // g/m3 = mg/L
}

export { izOf };
