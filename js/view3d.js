// 3D 表示。器具を手前右の 1/4 だけ切り取った形で描く（計算は対称な半分。残りは鏡映し）。
// 空気以外のセルのうち、表に出ているもの（空気・外気に接するか、切り口にあるもの）を立方体で並べる。
// three.js は 3D 表示を選んだときにだけ読み込む（index.html の importmap）。
import { M, MATERIALS } from './data.js';
import { GRID, D, cellX, cellY, cellZ, iyOf } from './geometry.js';
import { LUT } from './render.js';

let THREE = null, Controls = null;
const view = { renderer: null, scene: null, camera: null, controls: null, mesh: null, cells: null, sim: null, ver: -1, canvas: null };

export async function init3d(canvas) {
  if (!THREE) {
    THREE = await import('three');
    Controls = (await import('three/addons/controls/OrbitControls.js')).OrbitControls;
  }
  if (view.canvas === canvas) return;
  view.canvas = canvas;
  view.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  view.renderer.setPixelRatio(window.devicePixelRatio || 1);
  view.scene = new THREE.Scene();
  view.scene.background = new THREE.Color(0x0d0f16);
  view.camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
  view.camera.position.set(130, 95, 150);
  view.controls = new Controls(view.camera, canvas);
  view.controls.target.set(0, 0, 0);
  view.controls.enableDamping = true;
  view.controls.update();
  // 面ごとに明るさが変わるよう、環境光は弱めにして斜め上から主光源を当てる
  view.scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 0.9));
  const dl = new THREE.DirectionalLight(0xffffff, 2.4);
  dl.position.set(-70, 150, 110);
  view.scene.add(dl);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(120, 40, 60);
  view.scene.add(fill);
}

// 計算している y>=0 の半分に加えて、鏡に映した y<0 側の x<0 の部分も並べる。
// 手前右の 1/4（x>0, y<0）だけを切り取った形になり、丸い外側と中の様子が同時に見える。
function buildMesh(sim) {
  const { NX, NY, NZ, SY, SZ } = GRID;
  const mat = sim.mat;
  const src = [], pos = [];
  const open = (m) => m === M.AIR || m === M.AMBIENT;
  const exposed = (i) => {
    const nb = [i + 1, i - 1, i + SY, i + SZ, i - SZ];
    for (const j of nb) if (open(mat[j])) return true;
    return iyOf(i) > 1 && open(mat[i - SY]);
  };
  for (let iz = 1; iz < NZ - 1; iz++) for (let iy = 1; iy < NY - 1; iy++) for (let ix = 1; ix < NX - 1; ix++) {
    const i = ix + NX * (iy + NY * iz), m = mat[i];
    if (open(m)) continue;
    const x = cellX(ix), y = cellY(iy), z = cellZ(iz), ex = exposed(i);
    // 奥側（y>=0）: 外に面したセルと、右半分の切り口（y=0 の面）
    if (ex || (iy === 1 && x > 0)) { src.push(i); pos.push(x, z, -y); }
    // 手前側（y<0、鏡映し）: 左半分だけ。外に面したセルと、x=0 の切り口
    if (x < 0 && (ex || x > -D)) { src.push(i); pos.push(x, z, y); }
  }
  if (view.mesh) { view.scene.remove(view.mesh); view.mesh.geometry.dispose(); view.mesh.material.dispose(); }
  const geo = new THREE.BoxGeometry(D, D, D);
  const mtl = new THREE.MeshLambertMaterial();
  const mesh = new THREE.InstancedMesh(geo, mtl, src.length);
  const m4 = new THREE.Matrix4();
  for (let n = 0; n < src.length; n++) { m4.makeTranslation(pos[n * 3], pos[n * 3 + 1], pos[n * 3 + 2]); mesh.setMatrixAt(n, m4); }
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(src.length * 3), 3);
  view.scene.add(mesh);
  view.mesh = mesh; view.cells = src; view.sim = sim; view.ver = sim.geomVersion;
}

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const MAT_RGB = MATERIALS.map((m) => hex(m.color));

export function draw3d(sim, opt) {
  if (!view.renderer) return;
  const canvas = view.canvas;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * (window.devicePixelRatio || 1))) {
    view.renderer.setSize(w, h, false);
    view.camera.aspect = w / h;
    view.camera.updateProjectionMatrix();
  }
  if (view.sim !== sim || view.ver !== sim.geomVersion) buildMesh(sim);
  const col = view.mesh.instanceColor.array;
  const span = opt.tmax - 20;
  view.cells.forEach((i, n) => {
    const m = sim.mat[i];
    let r, g, b;
    if (opt.mode === 'temp') {
      let u = (sim.T[i] - 20) / span;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const q = Math.round(u * 255) * 3;
      r = LUT[q] / 255; g = LUT[q + 1] / 255; b = LUT[q + 2] / 255;
    } else [r, g, b] = MAT_RGB[m];
    if (m === M.COAL) {
      // 灰の殻が厚いほど灰色に寄せる
      const c = sim.coals[sim.coalId[i]];
      const f = Math.min(0.75, c.a / 2.5);
      r = r * (1 - f) + 0.6 * f; g = g * (1 - f) + 0.58 * f; b = b * (1 - f) + 0.55 * f;
    }
    col[n * 3] = r; col[n * 3 + 1] = g; col[n * 3 + 2] = b;
  });
  view.mesh.instanceColor.needsUpdate = true;
  view.controls.update();
  view.renderer.render(view.scene, view.camera);
}
