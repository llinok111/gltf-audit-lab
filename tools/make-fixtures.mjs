#!/usr/bin/env node
/**
 * Builds the two committed fixtures from scratch (no external downloads):
 *   assets/good.glb   — a clean, spec-compliant (2,3) torus-knot mesh
 *   assets/broken.glb — the same mesh with 10 errors + 4 warnings + 1 info injected
 *
 * Run: node tools/make-fixtures.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeGLB, concatAligned, f32 } from './glb-writer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------- geometry */

const P = 2, Q = 3, R = 1.0, A = 0.35, TUBE = 0.16, SU = 240, SV = 16;

function curve(u) {
  const r = R + A * Math.cos(Q * u);
  return [r * Math.cos(P * u), r * Math.sin(P * u), A * Math.sin(Q * u)];
}

function buildKnot() {
  const positions = new Float32Array(SU * SV * 3);
  const normals = new Float32Array(SU * SV * 3);
  const indices = new Uint16Array(SU * SV * 6);
  const eps = 1e-4;

  for (let i = 0; i < SU; i++) {
    const u = (i / SU) * Math.PI * 2;
    const c = curve(u);
    const c1 = curve(u + eps);
    const c0 = curve(u - eps);
    let tx = c1[0] - c0[0], ty = c1[1] - c0[1], tz = c1[2] - c0[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    let rx = 0, ry = 0, rz = 1;
    if (Math.abs(tz) > 0.9) { rx = 1; ry = 0; rz = 0; }
    let nx = ty * rz - tz * ry, ny = tz * rx - tx * rz, nz = tx * ry - ty * rx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    for (let j = 0; j < SV; j++) {
      const v = (j / SV) * Math.PI * 2;
      const cv = Math.cos(v), sv = Math.sin(v);
      const k = (i * SV + j) * 3;
      positions[k] = c[0] + TUBE * (cv * nx + sv * bx);
      positions[k + 1] = c[1] + TUBE * (cv * ny + sv * by);
      positions[k + 2] = c[2] + TUBE * (cv * nz + sv * bz);
    }
  }

  let t = 0;
  for (let i = 0; i < SU; i++) {
    const i1 = (i + 1) % SU;
    for (let j = 0; j < SV; j++) {
      const j1 = (j + 1) % SV;
      const a = i * SV + j, b = i1 * SV + j, c = i1 * SV + j1, d = i * SV + j1;
      indices[t++] = a; indices[t++] = b; indices[t++] = d;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }

  // Area-weighted vertex normals, then normalise -> exactly unit length.
  for (let k = 0; k < indices.length; k += 3) {
    const ia = indices[k] * 3, ib = indices[k + 1] * 3, ic = indices[k + 2] * 3;
    const e1x = positions[ib] - positions[ia], e1y = positions[ib + 1] - positions[ia + 1], e1z = positions[ib + 2] - positions[ia + 2];
    const e2x = positions[ic] - positions[ia], e2y = positions[ic + 1] - positions[ia + 1], e2z = positions[ic + 2] - positions[ia + 2];
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    for (const base of [ia, ib, ic]) {
      normals[base] += fx; normals[base + 1] += fy; normals[base + 2] += fz;
    }
  }
  for (let k = 0; k < normals.length; k += 3) {
    const l = Math.hypot(normals[k], normals[k + 1], normals[k + 2]) || 1;
    normals[k] /= l; normals[k + 1] /= l; normals[k + 2] /= l;
  }
  return { positions, normals, indices };
}

function bounds(arr) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (arr[i + c] < min[c]) min[c] = arr[i + c];
      if (arr[i + c] > max[c]) max[c] = arr[i + c];
    }
  }
  return { min, max };
}

/* ---------------------------------------------------------------- GLB write */

/* ---------------------------------------------------------------- fixtures */

function buildGood() {
  const { positions, normals, indices } = buildKnot();
  const b = bounds(positions);
  const { bin, views } = concatAligned([
    { bytes: f32(positions) }, { bytes: f32(normals) }, { bytes: f32(indices) },
  ]);
  const json = {
    asset: { version: '2.0', generator: 'gltf-audit-lab fixture generator' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'torus-knot' }],
    meshes: [{
      name: 'knot',
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4,
      }],
    }],
    materials: [{
      name: 'cobalt',
      pbrMetallicRoughness: { baseColorFactor: [0.32, 0.55, 0.92, 1], metallicFactor: 0.15, roughnessFactor: 0.45 },
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: b.min, max: b.max },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: views[0].byteOffset, byteLength: views[0].byteLength, target: 34962 },
      { buffer: 0, byteOffset: views[1].byteOffset, byteLength: views[1].byteLength, target: 34962 },
      { buffer: 0, byteOffset: views[2].byteOffset, byteLength: views[2].byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  return writeGLB(json, bin);
}

function buildBroken() {
  const { positions, normals, indices } = buildKnot();
  const b = bounds(positions);
  const posCount = positions.length / 3;

  // 1. one index points past the end of POSITION
  indices[30] = posCount + 7;
  // 2. one zero-area triangle (three identical corners)
  indices[60] = indices[61] = indices[62] = 5;
  // 3. ten normals scaled to length 2
  for (let i = 0; i < 10; i++) { normals[i * 3] *= 2; normals[i * 3 + 1] *= 2; normals[i * 3 + 2] *= 2; }

  // a 3-vertex triangle primitive without NORMAL
  const lone = new Float32Array([0, 1.6, 0, -0.4, 1.2, 0.2, 0.4, 1.2, -0.2]);

  const { bin, views } = concatAligned([
    { bytes: f32(positions) }, { bytes: f32(normals) }, { bytes: f32(indices) }, { bytes: f32(lone) },
  ]);

  const badMin = [b.min[0] - 1.5, b.min[1], b.min[2]]; // declared min does not match payload

  const json = {
    asset: { version: '2.0', generator: 'gltf-audit-lab fixture generator' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        mesh: 0, name: 'broken-knot',
        rotation: [-0.7071068, 0, 0, 0.7071068], // Z-up export
        scale: [1000, 1000, 1000],               // millimetres authored as metres
        children: [1, 999],                      // 999 does not exist
      },
      { name: 'loop', children: [1] },           // self-cycle
    ],
    meshes: [{
      name: 'knot',
      primitives: [
        { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 },
        { attributes: { POSITION: 3 }, mode: 4 },
      ],
    }],
    materials: [{
      name: 'broken',
      pbrMetallicRoughness: {
        baseColorFactor: [2.5, -0.2, 0.5, 1],
        baseColorTexture: { index: 5 },
      },
    }],
    textures: [],
    accessors: [
      { bufferView: 0, componentType: 5126, count: posCount, type: 'VEC3', min: badMin, max: b.max },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3', min: [-0.4, 1.2, -0.2], max: [0.4, 1.6, 0.2] },
      // count far beyond its bufferView: 4 bytes past the end of the view
      { bufferView: 0, componentType: 5126, count: posCount + 1000, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: views[0].byteOffset, byteLength: views[0].byteLength, target: 34962 },
      { buffer: 0, byteOffset: views[1].byteOffset, byteLength: views[1].byteLength, target: 34962 },
      { buffer: 0, byteOffset: views[2].byteOffset, byteLength: views[2].byteLength, target: 34963 },
      { buffer: 0, byteOffset: views[3].byteOffset, byteLength: views[3].byteLength, target: 34962 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  return writeGLB(json, bin, { lieAboutLength: true });
}

mkdirSync(join(root, 'assets'), { recursive: true });
const good = buildGood();
const broken = buildBroken();
writeFileSync(join(root, 'assets/good.glb'), good);
writeFileSync(join(root, 'assets/broken.glb'), broken);
console.log(`assets/good.glb   ${good.byteLength} bytes`);
console.log(`assets/broken.glb ${broken.byteLength} bytes`);
