#!/usr/bin/env node
/**
 * Node-only acceptance test for src/core.mjs. No browser, no GPU.
 * Asserts exact finding counts on the two committed fixtures plus a false-positive test.
 * Exit code 0 only when every assertion passes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { audit } from '../src/core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const goodBytes = readFileSync(join(root, 'assets/good.glb'));
const brokenBytes = readFileSync(join(root, 'assets/broken.glb'));

let checks = 0;
const failures = [];
function ok(cond, label, detail = '') {
  checks++;
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codes(result) {
  return result.issues.map((i) => i.code).sort();
}
function countOf(result, code) {
  return result.issues.filter((i) => i.code === code).reduce((n, i) => n + (i.count ?? 1), 0);
}

/* ---------------------------------------------------------------- 1. clean asset */
const good = audit(goodBytes);
console.log('\n[1] assets/good.glb — must be completely clean');
eq(good.ok, true, 'clean asset passes');
eq(good.summary.errors, 0, 'zero errors');
eq(good.summary.warnings, 0, 'zero warnings');
eq(good.summary.total, 0, 'zero findings of any severity');
eq(good.stats.triangles, 7680, 'triangle count');
eq(good.stats.vertices, 3840, 'vertex count');
eq(good.stats.primitives, 1, 'primitive count');
ok(Math.abs(good.stats.bbox.diagonal - 4.131283) < 1e-4, 'bbox diagonal matches the payload',
  `${good.stats.bbox.diagonal} m`);
eq(good.stats.upAxis, 'Y', 'up axis is Y');
eq(good.stats.units, 'm', 'units look like metres');

/* ---------------------------------------------------------------- 2. broken asset */
const broken = audit(brokenBytes);
console.log('\n[2] assets/broken.glb — 10 injected errors must all be found');
eq(broken.ok, false, 'broken asset fails');
eq(broken.summary.errors, 10, 'exactly 10 errors');
eq(broken.summary.warnings, 4, 'exactly 4 warnings');
eq(broken.summary.infos, 1, 'exactly 1 info');

const expectedCodes = [
  'ACCESSOR-MINMAX-MISMATCH', 'ACCESSOR-OVERFLOW', 'ACCESSOR-UNUSED', 'GLB-LENGTH',
  'INDEX-RANGE', 'MATERIAL-COLOR-RANGE', 'MATERIAL-TEXTURE-RANGE', 'NODE-CHILD-RANGE',
  'NODE-CYCLE', 'NORMAL-NOT-UNIT', 'PRIM-NORMAL-MISSING', 'PRIM-TEXCOORD-MISSING',
  'TRI-DEGENERATE', 'UNIT-SCALE-SUSPECT', 'UP-AXIS-SUSPECT',
];
eq(codes(broken).join(','), expectedCodes.join(','), 'finding codes are exactly the injected set');
eq(broken.issues.length, 15, 'no duplicate findings');
eq(countOf(broken, 'INDEX-RANGE'), 1, 'one out-of-range index');
eq(countOf(broken, 'TRI-DEGENERATE'), 1, 'one degenerate triangle');
eq(countOf(broken, 'NORMAL-NOT-UNIT'), 10, 'ten non-unit normals');
eq(countOf(broken, 'MATERIAL-COLOR-RANGE'), 2, 'two out-of-range colour components');
eq(countOf(broken, 'NODE-CHILD-RANGE'), 1, 'one bad child index');
eq(countOf(broken, 'NODE-CYCLE'), 1, 'one hierarchy cycle');
eq(countOf(broken, 'ACCESSOR-UNUSED'), 1, 'one unused accessor');
ok(broken.stats.bbox.diagonal > 4000, 'world bbox includes the 1000x node scale',
  `${broken.stats.bbox.diagonal} units`);
eq(broken.stats.upAxis, 'Z', 'root ±90° X rotation is classified as Z-up');

/* ---------------------------------------------------------------- 3. false positives */
console.log('\n[3] one mutation, one finding — no collateral damage');
const mutated = Uint8Array.from(goodBytes);
const mutatedJson = JSON.parse(new TextDecoder().decode(
  mutated.subarray(20, 20 + new DataView(mutated.buffer, mutated.byteOffset).getUint32(12, true)),
).trim());
const binStart = 20 + new DataView(mutated.buffer, mutated.byteOffset).getUint32(12, true) + 8;
const normalView = mutatedJson.bufferViews[1];
const dv = new DataView(mutated.buffer, mutated.byteOffset);
for (let i = 0; i < 5; i++) {
  const o = binStart + normalView.byteOffset + i * 12;
  for (let c = 0; c < 3; c++) dv.setFloat32(o + c * 4, dv.getFloat32(o + c * 4, true) * 1.5, true);
}
const fp = audit(mutated);
eq(fp.summary.total, 1, 'exactly one finding after one mutation');
eq(fp.issues[0]?.code, 'NORMAL-NOT-UNIT', 'the finding is the mutated normals');
eq(countOf(fp, 'NORMAL-NOT-UNIT'), 5, 'five corrupted normals counted');
eq(fp.summary.errors, 1, 'mutation is reported as an error');

/* ---------------------------------------------------------------- 4. hostile input */
console.log('\n[4] malformed input never throws');
const truncated = audit(goodBytes.subarray(0, 5000));
ok(truncated.ok === false && truncated.issues.length > 0, 'truncated GLB is rejected with a finding',
  truncated.issues.map((i) => i.code).join(','));
const garbage = audit(new TextEncoder().encode('this is not a 3D file at all'));
eq(garbage.ok, false, 'garbage bytes are rejected');
eq(garbage.issues[0]?.code, 'PARSE-FAIL', 'garbage is reported as PARSE-FAIL');

/* ---------------------------------------------------------------- 5. performance sanity */
const runs = [];
for (let i = 0; i < 5; i++) runs.push(audit(goodBytes).ms);
runs.sort((a, b) => a - b);
const median = runs[2];
ok(median < 100, 'clean 139 KB asset audits in under 100 ms', `${median.toFixed(1)} ms`);

console.log(`\n${failures.length ? 'FAILED' : 'OK'} — ${checks - failures.length}/${checks} assertions passed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
