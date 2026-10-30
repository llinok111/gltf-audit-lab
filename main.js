/**
 * glTF Audit Lab — viewer.
 * Rendering only: every number on screen comes from src/core.mjs, the same module bench/verify.mjs tests.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { audit, parseAsset, readAccessor } from './src/core.mjs';

const viewport = document.getElementById('viewport');
const boot = document.getElementById('boot');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
} catch (err) {
  boot.style.display = 'grid';
  boot.textContent = 'WebGL is not available in this browser: ' + err.message;
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
viewport.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d12);
scene.fog = new THREE.Fog(0x0a0d12, 14, 46);

const camera = new THREE.PerspectiveCamera(45, viewport.clientWidth / viewport.clientHeight, 0.01, 2000);
camera.position.set(3.4, 2.6, 4.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);

scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x101820, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(4, 7, 5);
scene.add(key);
const rim = new THREE.DirectionalLight(0x4fd1c5, 1.35);
rim.position.set(-6, 2, -5);
scene.add(rim);
const fill = new THREE.DirectionalLight(0x8aa8ff, 0.6);
fill.position.set(-3, -4, 4);
scene.add(fill);

const modelRoot = new THREE.Group();
scene.add(modelRoot);

let grid = null;
let degenerateOverlays = [];
let selectedMesh = -1;
let wireframe = false;
let current = null; // { name, bytes, parsed, result }
const meshObjects = new Map();

/* ---------------------------------------------------------------- scene build */

function buildModel(parsed, result) {
  const { json, bin } = parsed;
  const root = new THREE.Group();
  meshObjects.clear();
  degenerateOverlays = [];
  const visited = new Set();

  const degeneratePoints = [];

  function materialFor(prim) {
    const mat = prim.material !== undefined ? json.materials?.[prim.material] : null;
    const pbr = mat?.pbrMetallicRoughness || {};
    const f = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : [0.72, 0.76, 0.82, 1];
    const color = new THREE.Color().setRGB(
      clamp01(f[0]), clamp01(f[1]), clamp01(f[2]), THREE.LinearSRGBColorSpace,
    );
    return new THREE.MeshStandardMaterial({
      color,
      metalness: typeof pbr.metallicFactor === 'number' ? clamp01(pbr.metallicFactor) : 0.2,
      roughness: typeof pbr.roughnessFactor === 'number' ? clamp01(pbr.roughnessFactor) : 0.55,
      side: THREE.DoubleSide,
      wireframe,
    });
  }

  function primitiveMesh(prim, mi, pi) {
    if (prim.mode !== undefined && prim.mode !== 4) return null;
    const posAcc = json.accessors?.[prim.attributes?.POSITION];
    if (!posAcc) return null;
    const pos = readAccessor(json, bin, prim.attributes.POSITION, []);
    if (!pos) return null;
    const posCount = Math.min(posAcc.count, Math.floor(pos.length / 3));
    const positions = new Float32Array(posCount * 3);
    for (let i = 0; i < posCount * 3; i++) positions[i] = pos[i];

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    let indices = null;
    let rawIndices = null;
    if (prim.indices !== undefined) {
      const idx = readAccessor(json, bin, prim.indices, []);
      const idxAcc = json.accessors?.[prim.indices];
      if (idx && idxAcc) {
        rawIndices = idx;
        const n = Math.min(idxAcc.count, idx.length);
        indices = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
          const v = idx[i];
          indices[i] = v < posCount ? v : 0; // keep the GPU happy; the defect is reported, not hidden
        }
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      }
    }

    if (prim.attributes.NORMAL !== undefined) {
      const nAcc = json.accessors?.[prim.attributes.NORMAL];
      const normals = readAccessor(json, bin, prim.attributes.NORMAL, []);
      if (normals && nAcc && nAcc.count === posAcc.count) {
        const arr = new Float32Array(posCount * 3);
        for (let i = 0; i < posCount * 3; i++) arr[i] = normals[i];
        geometry.setAttribute('normal', new THREE.BufferAttribute(arr, 3));
      } else {
        geometry.computeVertexNormals();
      }
    } else {
      geometry.computeVertexNormals();
    }

    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, materialFor(prim));
    mesh.userData = { meshIndex: mi, primIndex: pi };
    if (!meshObjects.has(mi)) meshObjects.set(mi, []);
    meshObjects.get(mi).push(mesh);

    // collect zero-area triangles for the red overlay
    if (rawIndices) {
      for (let t = 0; t + 2 < rawIndices.length; t += 3) {
        const a = rawIndices[t], b = rawIndices[t + 1], c = rawIndices[t + 2];
        if (a >= posCount || b >= posCount || c >= posCount) continue; // reported as INDEX-RANGE
        const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
        const e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az;
        const e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az;
        const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
        if (a === b || b === c || a === c || cx * cx + cy * cy + cz * cz === 0) {
          degeneratePoints.push(ax, ay, az, positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
            positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]);
        }
      }
    }
    return mesh;
  }

  function meshGroup(mi) {
    const g = new THREE.Group();
    const mesh = json.meshes?.[mi];
    if (!mesh) return g;
    (mesh.primitives || []).forEach((prim, pi) => {
      const m = primitiveMesh(prim, mi, pi);
      if (m) g.add(m);
    });
    return g;
  }

  function nodeObject(index, depth) {
    if (index === undefined || index === null || !json.nodes?.[index]) return new THREE.Group();
    if (visited.has(index) || depth > 64) return new THREE.Group(); // cycles are reported by core, never rendered
    visited.add(index);
    const node = json.nodes[index];
    const g = new THREE.Group();
    if (Array.isArray(node.matrix) && node.matrix.length === 16) {
      const m = new THREE.Matrix4().fromArray(node.matrix);
      m.decompose(g.position, g.quaternion, g.scale);
    } else {
      if (node.translation) g.position.fromArray(node.translation);
      if (node.rotation) g.quaternion.fromArray(node.rotation);
      if (node.scale) g.scale.fromArray(node.scale);
    }
    if (node.mesh !== undefined) g.add(meshGroup(node.mesh));
    (node.children || []).forEach((c) => g.add(nodeObject(c, depth + 1)));
    return g;
  }

  const sceneIndex = json.scene ?? 0;
  const roots = json.scenes?.[sceneIndex]?.nodes || [];
  roots.forEach((n) => root.add(nodeObject(n, 0)));
  if (!roots.length) {
    // no usable scene graph: still show the geometry so the report is not a blank page
    (json.meshes || []).forEach((_, mi) => root.add(meshGroup(mi)));
  }

  if (degeneratePoints.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(degeneratePoints), 3));
    geo.computeVertexNormals();
    const overlay = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xff3b4e, side: THREE.DoubleSide, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    overlay.renderOrder = 3;
    overlay.userData.overlay = true;
    root.add(overlay);
    degenerateOverlays.push(overlay);
  }

  modelRoot.clear();
  modelRoot.add(root);
  return result;
}

function clamp01(v) { return Math.min(1, Math.max(0, typeof v === 'number' ? v : 0)); }

/* ---------------------------------------------------------------- camera */

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.001);
  const dir = new THREE.Vector3(0.62, 0.48, 0.75).normalize();
  camera.position.copy(center).addScaledVector(dir, radius * 2.1);
  camera.near = Math.max(radius / 500, 0.0001);
  camera.far = Math.max(radius * 200, 100);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = radius * 0.05;
  controls.maxDistance = radius * 40;
  controls.update();
  scene.fog.near = radius * 4;
  scene.fog.far = radius * 30;

  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  const span = radius * 6;
  grid = new THREE.GridHelper(span, 24, 0x2b3a4d, 0x18222e);
  grid.position.set(center.x, box.min.y, center.z);
  scene.add(grid);
}

/* ---------------------------------------------------------------- UI */

const els = {
  assetLine: document.getElementById('assetLine'),
  verdict: document.getElementById('verdict'),
  stats: document.getElementById('stats'),
  issues: document.getElementById('issues'),
  counts: document.getElementById('counts'),
  fps: document.getElementById('fps'),
  tabGood: document.getElementById('tabGood'),
  tabBroken: document.getElementById('tabBroken'),
  btnWire: document.getElementById('btnWire'),
  btnDeg: document.getElementById('btnDeg'),
  btnFrame: document.getElementById('btnFrame'),
  btnOpen: document.getElementById('btnOpen'),
  file: document.getElementById('file'),
  drop: document.getElementById('drop'),
};

const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderPanel(result, name) {
  const s = result.stats;
  const sum = result.summary || { errors: 0, warnings: 0, infos: 0, total: result.issues.length };

  els.verdict.className = 'verdict ' + (result.ok ? 'good' : 'bad');
  els.verdict.innerHTML = result.fatal
    ? `<div class="big">Unreadable</div><div class="sub">${esc(result.fatal)}</div>`
    : result.ok
      ? `<div class="big">Clean asset</div><div class="sub">0 errors · 0 warnings · audited in ${result.ms} ms</div>`
      : `<div class="big">${sum.errors} error${sum.errors === 1 ? '' : 's'}</div>
         <div class="sub">${sum.warnings} warnings · ${sum.infos} info · audited in ${result.ms} ms</div>`;

  const cells = [
    ['Triangles', fmt(s.triangles ?? 0)],
    ['Vertices', fmt(s.vertices ?? 0)],
    ['Primitives', fmt(s.primitives ?? 0)],
    ['Nodes', fmt(s.nodes ?? 0)],
    ['BBox diagonal', s.bbox ? `${s.bbox.diagonal.toFixed(2)} u` : '—'],
    ['Up axis', s.upAxis ?? '—'],
    ['Units guess', s.units ?? '—'],
    ['File size', `${((s.bytes ?? 0) / 1024).toFixed(0)} KB`],
  ];
  els.stats.innerHTML = cells.map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${k}</span></div>`).join('');

  els.counts.textContent = `${sum.errors}E / ${sum.warnings}W / ${sum.infos}I`;
  if (!result.issues.length) {
    els.issues.innerHTML = '<li class="empty">No findings. Every declared byte matches the payload, every index is in range, every normal is unit length.</li>';
  } else {
    const order = { error: 0, warning: 1, info: 2 };
    const sorted = [...result.issues].sort((a, b) => order[a.severity] - order[b.severity]);
    els.issues.innerHTML = sorted.map((i, k) => `
      <li data-k="${k}" data-where="${esc(i.where)}">
        <span class="dot ${i.severity}"></span>
        <div>
          <div class="code">${esc(i.code)}${i.count ? `<em>×${i.count}</em>` : ''}</div>
          <div class="msg">${esc(i.message)}</div>
          <div class="where">${esc(i.where)}</div>
        </div>
      </li>`).join('');
    [...els.issues.querySelectorAll('li[data-k]')].forEach((li) => {
      li.addEventListener('click', () => {
        [...els.issues.children].forEach((c) => c.classList.remove('sel'));
        li.classList.add('sel');
        selectWhere(li.dataset.where);
      });
    });
  }
  els.assetLine.textContent = `${name} · ${((s.bytes ?? 0) / 1024).toFixed(0)} KB · ${fmt(s.triangles ?? 0)} triangles`;
}

function selectWhere(where) {
  const m = /meshes\[(\d+)\]/.exec(where || '');
  const mi = m ? Number(m[1]) : -1;
  selectedMesh = mi;
  for (const [index, meshes] of meshObjects) {
    for (const mesh of meshes) {
      const sel = index === mi;
      mesh.material.emissive.setHex(sel ? 0x1f4a3f : 0x000000);
      mesh.material.emissiveIntensity = sel ? 1 : 0;
    }
  }
  if (mi >= 0 && meshObjects.has(mi)) {
    frameObject(meshObjects.get(mi)[0].parent || modelRoot);
  }
}

function applyWireframe() {
  for (const meshes of meshObjects.values()) {
    for (const mesh of meshes) mesh.material.wireframe = wireframe;
  }
}

/* ---------------------------------------------------------------- loading */

async function loadBytes(bytes, name) {
  const result = audit(bytes);
  if (result.fatal) {
    current = { name, bytes, parsed: null, result };
    renderPanel(result, name);
    return;
  }
  const parsed = parseAsset(bytes);
  current = { name, bytes, parsed, result };
  buildModel(parsed, result);
  els.btnDeg.classList.toggle('active', degenerateOverlays.length > 0);
  els.btnDeg.disabled = degenerateOverlays.length === 0;
  applyWireframe();
  frameObject(modelRoot);
  renderPanel(result, name);
}

async function loadAsset(name) {
  els.assetLine.textContent = `loading ${name}…`;
  try {
    const res = await fetch(`assets/${name}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    await loadBytes(new Uint8Array(buf), name);
    els.tabGood.classList.toggle('active', name === 'good.glb');
    els.tabBroken.classList.toggle('active', name === 'broken.glb');
  } catch (err) {
    boot.style.display = 'grid';
    boot.textContent = `Could not load assets/${name}: ${err.message}. Serve the folder over HTTP (python3 -m http.server 4173).`;
  }
}

els.tabGood.addEventListener('click', () => loadAsset('good.glb'));
els.tabBroken.addEventListener('click', () => loadAsset('broken.glb'));
els.btnWire.addEventListener('click', () => {
  wireframe = !wireframe;
  els.btnWire.classList.toggle('active', wireframe);
  applyWireframe();
});
els.btnDeg.addEventListener('click', () => {
  if (!degenerateOverlays.length) return;
  const on = !degenerateOverlays[0].visible;
  degenerateOverlays.forEach((o) => { o.visible = on; });
  els.btnDeg.classList.toggle('active', on);
});
els.btnFrame.addEventListener('click', () => {
  const target = selectedMesh >= 0 && meshObjects.has(selectedMesh)
    ? meshObjects.get(selectedMesh)[0].parent : modelRoot;
  frameObject(target);
});
els.btnOpen.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', async () => {
  const f = els.file.files?.[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  await loadBytes(new Uint8Array(buf), f.name);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; els.drop.classList.add('on'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; els.drop.classList.remove('on'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.drop.classList.remove('on');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  await loadBytes(new Uint8Array(buf), f.name);
});

/* ---------------------------------------------------------------- loop */

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
new ResizeObserver(resize).observe(viewport);
window.addEventListener('resize', resize);

let frames = 0;
let last = performance.now();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  frames++;
  const t = performance.now();
  if (t - last > 500) {
    els.fps.textContent = `${Math.round((frames * 1000) / (t - last))} fps · ${fmt(current?.result?.stats?.triangles ?? 0)} tris`;
    frames = 0;
    last = t;
  }
});

loadAsset('broken.glb');
