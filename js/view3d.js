// 3D 表示。計算している y>=0 の半分を、中心の切り口（y=0）が手前に来る向きで描く。
// 空気以外のセルのうち、表に出ているもの（空気・外気に接するか、切り口にあるもの）を小さな立方体で並べる。
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
  view.camera.position.set(95, 70, 170);
  view.controls = new Controls(view.camera, canvas);
  view.controls.target.set(0, 5, -10);
  view.controls.enableDamping = true;
  view.controls.update();
  view.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6);
  dl.position.set(60, 120, 90);
  view.scene.add(dl);
}

function buildMesh(sim) {
  const { NX, NY, NZ, SY, SZ } = GRID;
  const mat = sim.mat;
  const cells = [];
  const exposed = (i) => {
    const nb = [i + 1, i - 1, i + SY, i - SY, i + SZ, i - SZ];
    for (const j of nb) { const m = mat[j]; if (m === M.AIR || m === M.AMBIENT) return true; }
    return false;
  };
  for (let iz = 1; iz < NZ - 1; iz++) for (let iy = 1; iy < NY - 1; iy++) for (let ix = 1; ix < NX - 1; ix++) {
    const i = ix + NX * (iy + NY * iz), m = mat[i];
    if (m === M.AIR || m === M.AMBIENT) continue;
    if (iy === 1 || exposed(i)) cells.push(i);
  }
  if (view.mesh) { view.scene.remove(view.mesh); view.mesh.geometry.dispose(); view.mesh.material.dispose(); }
  const geo = new THREE.BoxGeometry(D * 0.96, D * 0.96, D * 0.96);
  const mtl = new THREE.MeshLambertMaterial();
  const mesh = new THREE.InstancedMesh(geo, mtl, cells.length);
  const m4 = new THREE.Matrix4();
  cells.forEach((i, n) => {
    const ix = i % NX, iy = Math.floor(i / NX) % NY, iz = Math.floor(i / SZ);
    m4.makeTranslation(cellX(ix), cellZ(iz), -cellY(iy));
    mesh.setMatrixAt(n, m4);
  });
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);
  view.scene.add(mesh);
  view.mesh = mesh; view.cells = cells; view.sim = sim; view.ver = sim.geomVersion;
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
    if (opt.mode !== 'temp' && iyOf(i) === 1) { r *= 0.8; g *= 0.8; b *= 0.8; }
    col[n * 3] = r; col[n * 3 + 1] = g; col[n * 3 + 2] = b;
  });
  view.mesh.instanceColor.needsUpdate = true;
  view.controls.update();
  view.renderer.render(view.scene, view.camera);
}
