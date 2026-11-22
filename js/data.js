// 器具・炭配置・フレーバー・物性データ。
// 「src」は公表値、「assumed」は公表値がなくこのシミュレーター側で置いた仮定を示す。

export const AMBIENT_C = 24;

// 材質 ID
export const M = {
  AMBIENT: 0, AIR: 1, CLAY: 2, STONEWARE: 3, ALU: 4, STEEL: 5,
  TOBACCO: 6, COAL: 7, ALU_PERF: 8, STEEL_PERF: 9,
};

// k: 熱伝導率 W/mK, rhoc: 体積熱容量 J/m3K, perm: 通気のしやすさ(相対), eps: 放射率
// アルミは陽解法の時間刻みを確保するため熱伝導率を 100 W/mK に抑えている（6061 合金の実物は約 167）。
// perm は開いた空間を 1 とした相対値。詰めた葉は開いた空間より桁違いに通気抵抗が大きいので 1/500 にしている。
// 炭は塊ごとに1つの温度で扱う（sim.js）。格子上の炭セルの値は表示と周囲との境界条件にだけ使う。
export const MATERIALS = [
  { name: '外気', k: 0.03, rhoc: 1200, perm: 1, eps: 1, color: '#12141c' },
  { name: '空気(器具内)', k: 0.03, rhoc: 1200, perm: 1, eps: 0, color: '#27304a' },
  { name: '陶器(クレイ)', k: 1.0, rhoc: 1.9e6, perm: 0, eps: 0.9, color: '#a8623f' },
  { name: '炻器(ストーンウェア)', k: 1.4, rhoc: 2.1e6, perm: 0, eps: 0.9, color: '#6f6a66' },
  { name: 'アルミ', k: 100, rhoc: 2.43e6, perm: 0, eps: 0.8, color: '#b9c0c9' },
  { name: 'ステンレス', k: 16, rhoc: 3.9e6, perm: 0, eps: 0.5, color: '#8d97a6' },
  { name: '葉(フレーバー)', k: 0.2, rhoc: 1.1e6, perm: 0.002, eps: 0.9, color: '#5d7a2c' },
  { name: '炭', k: 0.8, rhoc: 1.16e6, perm: 0, eps: 0.85, color: '#e2531f' },
  // 穴・スリットのある部分: 断面では穴に見えるが、実物は穴の周りで金属がつながっているので
  // 「熱を伝え、空気も通す」セルとして扱う。
  { name: 'アルミ(穴・スリット)', k: 50, rhoc: 1.4e6, perm: 0.1, eps: 0.8, color: '#59616e' },
  { name: 'ステンレス(穴)', k: 8, rhoc: 2.2e6, perm: 0.1, eps: 0.5, color: '#4d5561' },
];

// ---- 炭（ココナッツキューブ）の物性 ----
// 公表値が揃っていないので、販売単位と一般的な文献値から置いた値。
export const COAL = {
  density: 890, // kg/m3。25 mm キューブが 1 kg あたり72個前後で売られていることからの換算（仮定）
  hhv: 29e6, // J/kg。ココナッツ殻炭ブリケットの高位発熱量 28〜30 MJ/kg の中央（一般的な文献値）
  cp: 1300, // J/kgK。高温の炭（チャー）の比熱
  kChar: 0.8, // W/mK。炭の芯の有効熱伝導率（仮定）
  o2Heat: 13.1e6, // J/kg-O2。消費した酸素あたりの発熱量（Thornton 則。有機物の燃焼でほぼ一定）
  yO2: 0.233, // 空気中の酸素の質量分率
  src: '発熱量はココナッツ殻炭の文献値 28〜30 MJ/kg。燃焼速度は表面への酸素の拡散で決まるとし、発熱は消費酸素量から Thornton 則（13.1 MJ/kg-O2）で求める。',
  assumed: '密度・灰の体積・灰の熱伝導率と酸素の通りやすさは仮定（sim.js の TUNE）。',
};

// 水の活量（Norrish 式）: ln aw = ln xw − (Σ √K_i x_i)²。K は溶質ごとの定数。
// グリセリン 1.16、ブドウ糖・果糖 2.25（Norrish 1966、食品の水分活性の標準的な値）。シーシャの糖は転化糖として扱う。
export const NORRISH = { glycerol: 1.16, sugar: 2.25 };

// ---- ボウル（単位 mm。z=0 がリム上面、下向きが負）----
// Ro: リム外半径, RiTop/RiBot: 葉室の内半径(上端/底), depth: 葉室の深さ, tb: 底板の厚さ
export const BOWLS = {
  cosmoTurkish: {
    name: 'Cosmo Bowl Turkish', type: 'turkish', mat: M.CLAY,
    Ro: 34, RiTop: 28, RiBot: 24, depth: 16, tb: 5,
    holes: { center: true, ringR: 11, d: 5, n: 5 },
    capacity: '15〜18 g',
    src: '外径約68 mm・葉室径約56 mm・高さ約85 mm（販売店記載）。中央1穴＋周囲5穴は参考サイトの記載。',
    assumed: '葉室の深さ16 mm、底板厚、穴径は仮定。',
  },
  cosmoPhunnel: {
    name: 'Cosmo Bowl Phunnel', type: 'phunnel', mat: M.CLAY,
    Ro: 37.5, RiTop: 31, RiBot: 27, depth: 14, tb: 6,
    spire: { rBase: 9.5, rTop: 6.5, bore: 3.5, topBelowRim: 3 },
    capacity: '12〜15 g',
    src: '高さ約90 mm・外径約75 mm・容量12〜15 g（販売店記載）。',
    assumed: '葉室の深さ、スパイア径・高さ、中央穴径は仮定。',
  },
  hypeTurkish: {
    name: 'Hype Bowl (Turkish)', type: 'turkish', mat: M.CLAY,
    Ro: 36.5, RiTop: 29, RiBot: 25, depth: 15, tb: 5,
    holes: { center: true, ringR: 10, d: 4.5, n: 5 },
    capacity: '12〜15 g',
    src: '幅約73 mm・高さ約75 mm・デポット約15 mm・容量12〜15 g（EGG SHISHA 記載）。',
    assumed: '穴の数と配置、内径は仮定。',
  },
  hypeKiller: {
    name: 'Hype Killer Light', type: 'killer', mat: M.CLAY,
    Ro: 36.5, RiTop: 29, RiBot: 25, depth: 18, tb: 5,
    holes: { center: false, ringR: 13, d: 6, n: 6 }, dome: { r: 6, h: 4 },
    capacity: '約15〜18 g',
    src: '外径73 mm・深さ18 mm・6穴・重量250 g（販売店記載）。',
    assumed: '穴の配置半径と中央の盛り上がりは「キラー型」の一般形状からの仮定。',
  },
  thiccKiller: {
    name: 'Thicc Bowl Killer', type: 'killer', mat: M.STONEWARE,
    Ro: 37.5, RiTop: 28, RiBot: 25, depth: 18, tb: 7,
    holes: { center: false, ringR: 12, d: 6, n: 6 }, dome: { r: 6, h: 4 },
    capacity: '18〜20 g',
    src: 'BSTD THICC Bowl: 高さ約90 mm・幅約75 mm・容量18〜20 g・炻器（販売店記載）。',
    assumed: 'Killer 版の寸法は公表値が見つからず、THICC Bowl の外寸にキラー型の底形状を当てはめた。',
  },
};

// ---- HMD（単位 mm。z=0 がボウルのリムに載る面）----
export const HMDS = {
  onmo: {
    name: 'ONMO HMD', mat: M.ALU, eps: 0.8, // アルマイト処理のアルミ: 放射率が高い
    Rin: 30, wall: 3, height: 30, floorT: 2.5, flangeR: 37.5, flangeT: 3,
    // 床はバー（格子）形状: 奥行き方向に走るスロットとリブ
    floorHoles: { type: 'slots', xs: [0, 12, 24], w: 3 },
    ribs: { xs: [6, 18], w: 2, h: 1.5 },
    slits: { z0: 10, z1: 22, n: 12, w: 3 },
    src: 'アルミ削り出し・底径75 mm・高さ約30 mm・上部幅約66 mm・27 mmまでの炭2個・内側はバー形状・側面スリット（販売店記載）。',
    assumed: '床のスロットの位置と幅、側面スリットの本数（12本）と幅、壁厚は仮定。蓋は外した状態で計算する。',
  },
  nagrani: {
    name: 'Na Grani V2', mat: M.STEEL, eps: 0.5, // 酸化したステンレス: アルマイトより放射率が低い
    Rin: 28, wall: 1.5, height: 25.5, floorT: 1.5, flangeR: 37, flangeT: 1.5,
    // 丸穴を同心円状に並べる: 半径 [0, 8, 16, 24] mm に [1, 6, 12, 18] 個
    floorHoles: { type: 'rings', rs: [0, 8, 16, 24], ns: [1, 6, 12, 18], d: 2.5 },
    ribs: null, slits: null,
    src: 'ステンレス一体型・底径74 mm・内径56 mm・深さ24 mm・120 g・オープントップ（販売店記載）。',
    assumed: 'V2 固有の寸法は公表値が見つからず Na Grani の公表寸法を使用。床穴の配置と数は仮定。',
  },
};

// ---- 炭（キューブ）と配置 ----
export const COAL_SIZES = [22, 25, 26, 27, 28];
// lower: 下段の個数（2個は奥行き方向に並ぶ）, diag: 縁に斜めがけする個数, pyramid: 下段の上に載せる個数
export const LAYOUTS = {
  l2d2: { name: '下2・上斜めがけ2', lower: 2, diag: 2, pyramid: 0 },
  l2d1: { name: '下2・上斜めがけ1', lower: 2, diag: 1, pyramid: 0 },
  l2p1: { name: '下2・上ピラミッド1', lower: 2, diag: 0, pyramid: 1 },
  l1d2: { name: '下1・上斜めがけ2', lower: 1, diag: 2, pyramid: 0 },
  l2: { name: '下2', lower: 2, diag: 0, pyramid: 0 },
};

// ---- 成分の物性 ----
// bp: 沸点(℃, 1 atm), mw: 分子量, dH: 蒸発エンタルピー(kJ/mol), gamma: シロップ中の活量係数(仮定)
// 沸点・分子量は PubChem 等に載る一般的な文献値。dH は文献値または Trouton 則の 1.2 倍による推定。
export const COMPOUNDS = {
  water: { name: '水', bp: 100, mw: 18.02, dH: 40.7, gamma: 1, kind: 'base', note: '' },
  glycerol: { name: 'グリセリン', bp: 290, mw: 92.09, dH: 76, gamma: 1, kind: 'base', note: '煙(ミスト)の主成分' },
  nicotine: { name: 'ニコチン', bp: 247, mw: 162.23, dH: 52, gamma: 0.3, kind: 'base', note: '' },
  ethylButanoate: { name: '酪酸エチル', bp: 121, mw: 116.16, dH: 42, gamma: 5, kind: 'aroma', note: 'フルーティ・パイン様' },
  ethyl2MB: { name: '2-メチル酪酸エチル', bp: 133, mw: 130.18, dH: 43, gamma: 5, kind: 'aroma', note: '青りんご・フルーティ' },
  isoamylAcetate: { name: '酢酸イソアミル', bp: 142, mw: 130.19, dH: 44, gamma: 5, kind: 'aroma', note: 'バナナ・洋梨様' },
  hexylAcetate: { name: '酢酸ヘキシル', bp: 171.5, mw: 144.21, dH: 47, gamma: 5, kind: 'aroma', note: 'りんご・洋梨様' },
  eucalyptol: { name: '1,8-シネオール', bp: 176, mw: 154.25, dH: 47, gamma: 2, kind: 'aroma', note: '清涼・ユーカリ' },
  fenchone: { name: 'フェンコン', bp: 193, mw: 152.23, dH: 49, gamma: 2, kind: 'aroma', note: 'フェンネル・ハーブ' },
  linalool: { name: 'リナロール', bp: 198, mw: 154.25, dH: 51, gamma: 2, kind: 'aroma', note: 'フローラル' },
  benzylAlcohol: { name: 'ベンジルアルコール', bp: 205, mw: 108.14, dH: 53, gamma: 2, kind: 'aroma', note: '弱い甘い香り・溶剤' },
  menthone: { name: 'メントン', bp: 207, mw: 154.25, dH: 50, gamma: 2, kind: 'aroma', note: 'ミント' },
  menthol: { name: 'メントール', bp: 214, mw: 156.27, dH: 56, gamma: 2, kind: 'aroma', note: '清涼感' },
  estragole: { name: 'エストラゴール', bp: 216, mw: 148.2, dH: 51, gamma: 2, kind: 'aroma', note: 'アニス・タラゴン' },
  carvone: { name: 'L-カルボン', bp: 231, mw: 150.22, dH: 53, gamma: 2, kind: 'aroma', note: 'スペアミント' },
  anethole: { name: 'trans-アネトール', bp: 234, mw: 148.2, dH: 53, gamma: 2, kind: 'aroma', note: 'アニス(ダブルアップルの主香)' },
  methylAnthranilate: { name: 'アントラニル酸メチル', bp: 256, mw: 151.16, dH: 56, gamma: 5, kind: 'aroma', note: 'コンコードグレープ' },
  damascenone: { name: 'β-ダマセノン', bp: 274, mw: 190.28, dH: 58, gamma: 2, kind: 'aroma', note: '煮たりんご・ドライフルーツ' },
  vanillin: { name: 'バニリン', bp: 285, mw: 152.15, dH: 62, gamma: 2, kind: 'aroma', note: '甘いバニラ' },
  ethylMaltol: { name: 'エチルマルトール', bp: 290, mw: 140.14, dH: 62, gamma: 2, kind: 'aroma', note: '綿菓子様の甘さ' },
};

// ---- フレーバー ----
// frac: 質量分率（葉・グリセリン・糖・水）。aroma: mg/g。
// 各社の配合は非公開のため、香気成分の「種類」は文献・製品説明に基づき、「量」は仮定である。
export const FLAVORS = {
  doppelganger: {
    name: 'Darkside Doppelgänger',
    desc: 'バーレー葉ベース。アニスが強く、ハーブ感とダブルアップルの甘みが続く。',
    frac: { leaf: 0.32, glycerol: 0.40, sugar: 0.16, water: 0.11 },
    aroma: { anethole: 5.0, estragole: 0.8, fenchone: 0.4, hexylAcetate: 0.6, ethyl2MB: 0.5, damascenone: 0.08, vanillin: 0.3, nicotine: 3.0 },
    scorchC: 250,
    src: '味の説明は販売店記載（強いアニス＋ハーブ＋ダブルアップルの甘み）。Darkside は未洗浄バーレー葉。',
    assumed: '配合比・香料量・ニコチン量は仮定。',
  },
  afTwoApples: {
    name: 'Al Fakher Two Apples',
    desc: 'バージニア葉ベース。アニスにりんご様エステルの甘みが重なる。',
    frac: { leaf: 0.20, glycerol: 0.50, sugar: 0.18, water: 0.11 },
    aroma: { anethole: 3.0, ethyl2MB: 0.6, hexylAcetate: 0.8, isoamylAcetate: 0.5, benzylAlcohol: 1.5, vanillin: 0.5, damascenone: 0.05, nicotine: 0.5 },
    scorchC: 225,
    src: '葉15〜30%・グリセリン45〜55%・糖15〜30%（特許文献での Al Fakher double apple の記載例）。アップル系の指標成分がアネトール（Farag 2018）。ベンジルアルコールが多い（Schubert 2013）。',
    assumed: 'エステル類の種類と各香料の量は仮定。',
  },
  afMint: {
    name: 'Al Fakher Mint',
    desc: 'メントール主体の清涼感。',
    frac: { leaf: 0.20, glycerol: 0.50, sugar: 0.18, water: 0.11 },
    aroma: { menthol: 4.0, menthone: 1.2, carvone: 0.8, eucalyptol: 0.4, nicotine: 0.5 },
    scorchC: 225,
    src: 'ミント系はメントール・メントン・カルボンが主香（ミント精油の一般組成）。',
    assumed: '配合比と量は仮定。',
  },
  afGrape: {
    name: 'Al Fakher Grape',
    desc: 'コンコードグレープ様の甘い香り。',
    frac: { leaf: 0.20, glycerol: 0.50, sugar: 0.18, water: 0.11 },
    aroma: { methylAnthranilate: 1.5, ethylButanoate: 1.0, isoamylAcetate: 0.4, linalool: 0.4, ethylMaltol: 0.8, benzylAlcohol: 1.0, nicotine: 0.5 },
    scorchC: 225,
    src: 'グレープ香料の代表成分はアントラニル酸メチル（一般的な香料化学）。',
    assumed: '配合比と量は仮定。',
  },
};

// 吸引（Beirut 法: 1吸い 0.53 L / 2.6 秒 / 17 秒間隔 → 約 12 L/分）
export const PUFF = { minLpm: 4, maxLpm: 20, autoLpm: 12.2, autoOn: 2.6, autoPeriod: 19.6 };
