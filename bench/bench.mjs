#!/usr/bin/env node
/**
 * Throughput benchmark: builds a large GLB in memory (no downloads, nothing committed),
 * audits it repeatedly, and writes the median to bench/result.json.
 * Run: node bench/bench.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { audit } from '../src/core.mjs';
import { writeGLB, concatAligned, f32 } from '../tools/glb-writer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = 420;                       // 420 x 420 vertices
const RUNS = 7;

function buildGrid() {
  const verts = N * N;
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const indices = new Uint32Array((N - 1) * (N - 1) * 6);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = (z * N + x) * 3;
      const px = (x / (N - 1) - 0.5) * 10;
      const pz = (z / (N - 1) - 0.5) * 10;
      positions[i] = px;
      positions[i + 1] = Math.sin(px * 1.7) * Math.cos(pz * 1.3) * 0.6;
      positions[i + 2] = pz;
      normals[i] = 0; normals[i + 1] = 1; normals[i + 2] = 0;
    }
  }
  let t = 0;
  for (let z = 0; z < N - 1; z++) {
    for (let x = 0; x < N - 1; x++) {
      const a = z * N + x, b = a + 1, c = a + N, d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }
  return { positions, normals, indices };
}

function bounds(arr) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (arr[i + c] < min[c]) min[c] = arr[i + c];
      if (arr[i + c] > max[c]) max[c] = arr[i + c];
    }
  }
  return { min, max };
}

const { positions, normals, indices } = buildGrid();
const b = bounds(positions);
const { bin, views } = concatAligned([
  { bytes: f32(positions) }, { bytes: f32(normals) }, { bytes: f32(indices) },
]);
const glb = writeGLB({
  asset: { version: '2.0', generator: 'gltf-audit-lab bench' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: b.min, max: b.max },
    { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: views[0].byteOffset, byteLength: views[0].byteLength, target: 34962 },
    { buffer: 0, byteOffset: views[1].byteOffset, byteLength: views[1].byteLength, target: 34962 },
    { buffer: 0, byteOffset: views[2].byteOffset, byteLength: views[2].byteLength, target: 34963 },
  ],
  buffers: [{ byteLength: bin.length }],
}, bin);

const result = audit(glb); // warm-up + correctness check
if (!result.ok || result.stats.triangles !== (N - 1) * (N - 1) * 2) {
  console.error('bench asset failed its own audit:', result.issues);
  process.exit(1);
}

const times = [];
for (let i = 0; i < RUNS; i++) times.push(audit(glb).ms);
const sorted = [...times].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const mb = glb.byteLength / (1024 * 1024);

const out = {
  asset: `procedural ${N}x${N} grid`,
  bytes: glb.byteLength,
  megabytes: Number(mb.toFixed(2)),
  vertices: result.stats.vertices,
  triangles: result.stats.triangles,
  runs: times,
  runsCount: RUNS,
  medianMs: Number(median.toFixed(2)),
  minMs: Number(sorted[0].toFixed(2)),
  maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
  throughputMBs: Number((mb / (median / 1000)).toFixed(1)),
  trianglesPerSecond: Math.round(result.stats.triangles / (median / 1000)),
  findingsOnBenchAsset: result.issues.length,
  generatedAt: new Date().toISOString(),
};
writeFileSync(join(root, 'bench/result.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
