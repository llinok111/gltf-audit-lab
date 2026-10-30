/**
 * glTF/GLB integrity auditor — pure ES module, zero dependencies, runs in Node and in the browser.
 *
 * It parses the GLB container itself (no GLTFLoader), decodes accessors (including byteStride and
 * sparse substitution), then cross-checks binary payloads against the JSON declarations.
 *
 * Every finding is { code, severity, where, message, count }.
 * `ok` is true when no finding has severity === "error".
 */

export const SEVERITY = { error: 'error', warning: 'warning', info: 'info' };

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_TYPES = {
  5120: { Array: Int8Array, size: 1, norm: 127 },
  5121: { Array: Uint8Array, size: 1, norm: 255 },
  5122: { Array: Int16Array, size: 2, norm: 32767 },
  5123: { Array: Uint16Array, size: 2, norm: 65535 },
  5125: { Array: Uint32Array, size: 4, norm: 4294967295 },
  5126: { Array: Float32Array, size: 4, norm: 1 },
};
const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

class AuditError extends Error {}

/* ------------------------------------------------------------------ container */

/** Parse a GLB container. Structural problems are returned, not thrown. */
export function parseGLB(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const issues = [];
  if (u8.byteLength < 12) throw new AuditError('file is shorter than the 12-byte GLB header');
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) throw new AuditError('not a GLB file (bad magic)');
  const version = view.getUint32(4, true);
  const declared = view.getUint32(8, true);
  if (version !== 2) issues.push(issue('GLB-VERSION', 'error', 'header', `GLB version ${version}, expected 2`));
  if (declared !== u8.byteLength) {
    issues.push(issue('GLB-LENGTH', 'error', 'header',
      `header declares ${declared} bytes but file is ${u8.byteLength} bytes`, Math.abs(declared - u8.byteLength)));
  }

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= u8.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > u8.byteLength) {
      issues.push(issue('GLB-CHUNK-TRUNCATED', 'error', `chunk@${offset}`,
        `chunk of ${chunkLength} bytes runs past end of file`, end - u8.byteLength));
      break;
    }
    if (chunkType === CHUNK_JSON && json === null) {
      const text = new TextDecoder().decode(u8.subarray(start, end)).replace(/\u0000+$/g, '').trim();
      try {
        json = JSON.parse(text);
      } catch (err) {
        throw new AuditError(`JSON chunk is not valid JSON: ${err.message}`);
      }
    } else if (chunkType === CHUNK_BIN && bin === null) {
      bin = u8.subarray(start, end);
    }
    offset = end + ((4 - (chunkLength % 4)) % 4);
  }
  if (!json) throw new AuditError('GLB has no JSON chunk');
  return { json, bin, issues, bytes: u8 };
}

/** Accepts a GLB, or a .gltf JSON file (external buffers cannot be resolved and are reported). */
export function parseAsset(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength >= 4) {
    const magic = u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24);
    if ((magic >>> 0) === GLB_MAGIC) return parseGLB(u8);
  }
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(u8));
  } catch {
    throw new AuditError('not a GLB and not a JSON glTF file');
  }
  return { json, bin: null, issues: [], bytes: u8, isGltf: true };
}

/* ------------------------------------------------------------------ accessors */

function bufferBytes(gltf, bin, index, issues) {
  const buffer = gltf.buffers?.[index];
  if (!buffer) throw new AuditError(`buffers[${index}] does not exist`);
  if (buffer.uri) {
    issues.push(issue('BUFFER-EXTERNAL', 'warning', `buffers[${index}]`,
      'external buffer URI is not resolved by this auditor; its data is skipped'));
    return null;
  }
  if (!bin) return null;
  if (buffer.byteLength > bin.byteLength) {
    issues.push(issue('BUFFER-BIN-SIZE', 'error', `buffers[${index}]`,
      `buffer declares ${buffer.byteLength} bytes but the BIN chunk holds ${bin.byteLength}`, buffer.byteLength - bin.byteLength));
  }
  return bin;
}

function decodeSparse(gltf, bin, acc, out, ncomp, issues) {
  const sparse = acc.sparse;
  if (!sparse) return out;
  const idxInfo = sparse.indices;
  const valInfo = sparse.values;
  const idxAcc = { ...gltf.accessors?.[0], ...idxInfo, bufferView: idxInfo.bufferView, byteOffset: idxInfo.byteOffset || 0, count: sparse.count, componentType: idxInfo.componentType, type: 'SCALAR' };
  const src = readRaw(gltf, bin, idxAcc, 1, issues, `accessors[${acc.__index}].sparse.indices`);
  if (!src) return out;
  const valAcc = {
    bufferView: valInfo.bufferView, byteOffset: valInfo.byteOffset || 0, count: sparse.count,
    componentType: acc.componentType, type: acc.type, normalized: acc.normalized,
  };
  const vals = readRaw(gltf, bin, valAcc, ncomp, issues, `accessors[${acc.__index}].sparse.values`);
  if (!vals) return out;
  for (let i = 0; i < sparse.count; i++) {
    const target = src[i];
    for (let c = 0; c < ncomp; c++) out[target * ncomp + c] = vals[i * ncomp + c];
  }
  return out;
}

function readRaw(gltf, bin, acc, ncomp, issues, where) {
  const ct = COMPONENT_TYPES[acc.componentType];
  if (!ct) {
    issues.push(issue('ACCESSOR-TYPE', 'error', where, `unknown componentType ${acc.componentType}`));
    return null;
  }
  const bv = gltf.bufferViews?.[acc.bufferView];
  if (!bv) return null;
  const bytes = bufferBytes(gltf, bin, bv.buffer ?? 0, issues);
  if (!bytes) return null;
  const elemSize = ct.size * ncomp;
  const stride = bv.byteStride && bv.byteStride > 0 ? bv.byteStride : elemSize;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const count = acc.count | 0;
  if (count < 0 || base < 0) {
    issues.push(issue('ACCESSOR-OFFSET', 'error', where, 'negative accessor count or byteOffset'));
    return null;
  }

  // Fast path: tightly packed, aligned float data can be viewed without copying.
  const absBase = bytes.byteOffset + base;
  if (acc.componentType === 5126 && stride === elemSize && absBase % 4 === 0 && base + count * stride <= bytes.byteLength) {
    return new Float32Array(bytes.buffer, absBase, count * ncomp);
  }
  if (acc.componentType === 5123 && stride === elemSize && absBase % 2 === 0 && base + count * stride <= bytes.byteLength) {
    return new Uint16Array(bytes.buffer, absBase, count * ncomp);
  }

  const out = new Float64Array(count * ncomp);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxIndex = Math.floor((bytes.byteLength - base - elemSize) / stride);
  const safeCount = Math.max(0, Math.min(count, maxIndex + 1));
  for (let i = 0; i < safeCount; i++) {
    const p = base + i * stride;
    for (let c = 0; c < ncomp; c++) {
      const o = p + c * ct.size;
      let v;
      switch (acc.componentType) {
        case 5120: v = dv.getInt8(o); break;
        case 5121: v = dv.getUint8(o); break;
        case 5122: v = dv.getInt16(o, true); break;
        case 5123: v = dv.getUint16(o, true); break;
        case 5125: v = dv.getUint32(o, true); break;
        default: v = dv.getFloat32(o, true);
      }
      if (acc.normalized && acc.componentType !== 5126) v = Math.max(v / ct.norm, -1);
      out[i * ncomp + c] = v;
    }
  }
  return out;
}

const accessorCache = new WeakMap();

/** Decode accessor `index` into a typed array of `count * ncomp` values. */
export function readAccessor(gltf, bin, index, issues = []) {
  let cache = accessorCache.get(gltf);
  if (!cache) accessorCache.set(gltf, (cache = new Map()));
  if (cache.has(index)) return cache.get(index);
  const acc = gltf.accessors?.[index];
  if (!acc) {
    issues.push(issue('ACCESSOR-MISSING', 'error', `accessors[${index}]`, 'accessor does not exist'));
    return null;
  }
  const ncomp = COMPONENTS[acc.type];
  if (!ncomp) {
    issues.push(issue('ACCESSOR-TYPE', 'error', `accessors[${index}]`, `unknown accessor type ${acc.type}`));
    return null;
  }
  let out = readRaw(gltf, bin, { ...acc, __index: index }, ncomp, issues, `accessors[${index}]`);
  if (out && acc.sparse) out = decodeSparse(gltf, bin, { ...acc, __index: index }, out, ncomp, issues);
  cache.set(index, out);
  return out;
}

/* ------------------------------------------------------------------ helpers */

function issue(code, severity, where, message, count) {
  const it = { code, severity, where, message };
  if (count !== undefined) it.count = count;
  return it;
}

function boundsOf(gltf, bin, accessorIndex, issues, where) {
  const acc = gltf.accessors?.[accessorIndex];
  const data = readAccessor(gltf, bin, accessorIndex, issues);
  if (!acc || !data) return null;
  const n = COMPONENTS[acc.type] || 3;
  if (n < 3) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const count = Math.min(acc.count, Math.floor(data.length / n));
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const v = data[i * n + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  if (!Number.isFinite(min[0])) return null;
  return { min, max, count };
}

/* ------------------------------------------------------------------ mat4 (column-major) */

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function mulMat4(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/* ------------------------------------------------------------------ audit */

/**
 * Audit a GLB / glTF byte buffer.
 * @returns {{ok:boolean, issues:Array, stats:object, fatal?:string}}
 */
export function audit(bytes) {
  const issues = [];
  const t0 = now();
  let parsed;
  try {
    parsed = parseAsset(bytes);
  } catch (err) {
    return {
      ok: false, fatal: err.message, issues: [issue('PARSE-FAIL', 'error', 'file', err.message)],
      stats: { bytes: bytes?.byteLength ?? 0 }, ms: now() - t0,
    };
  }
  const { json: gltf, bin } = parsed;
  issues.push(...parsed.issues);

  const stats = {
    bytes: bytes.byteLength,
    nodes: gltf.nodes?.length ?? 0,
    meshes: gltf.meshes?.length ?? 0,
    materials: gltf.materials?.length ?? 0,
    textures: gltf.textures?.length ?? 0,
    accessors: gltf.accessors?.length ?? 0,
    primitives: 0,
    vertices: 0,
    triangles: 0,
    indices: 0,
    bbox: null,
    upAxis: 'Y',
    units: 'm',
    ms: 0,
  };

  if (!gltf.asset) {
    issues.push(issue('ASSET-MISSING', 'error', 'asset', 'asset object is required'));
  } else if (typeof gltf.asset.version !== 'string' || !gltf.asset.version.startsWith('2.')) {
    issues.push(issue('ASSET-VERSION', 'error', 'asset.version',
      `asset.version is ${JSON.stringify(gltf.asset.version)}, expected 2.x`));
  }

  if (parsed.isGltf) {
    issues.push(issue('GLTF-EXTERNAL', 'warning', 'file', 'JSON .gltf input: binary buffers are not loaded'));
  }

  /* --- buffer views ------------------------------------------------ */
  (gltf.bufferViews || []).forEach((bv, i) => {
    const buffer = gltf.buffers?.[bv.buffer ?? 0];
    if (!buffer) {
      issues.push(issue('BUFFERVIEW-BUFFER', 'error', `bufferViews[${i}]`, `buffer ${bv.buffer ?? 0} does not exist`));
      return;
    }
    if (!buffer.uri && bin && (bv.byteOffset || 0) + bv.byteLength > bin.byteLength) {
      issues.push(issue('BUFFERVIEW-OVERFLOW', 'error', `bufferViews[${i}]`,
        `view ends at ${(bv.byteOffset || 0) + bv.byteLength} but BIN chunk is ${bin.byteLength} bytes`));
    }
  });

  /* --- accessor declarations --------------------------------------- */
  (gltf.accessors || []).forEach((acc, i) => {
    if (acc.bufferView !== undefined) {
      const bv = gltf.bufferViews?.[acc.bufferView];
      const ct = COMPONENT_TYPES[acc.componentType];
      const ncomp = COMPONENTS[acc.type];
      if (!bv) {
        issues.push(issue('ACCESSOR-BUFFERVIEW', 'error', `accessors[${i}]`, `bufferView ${acc.bufferView} does not exist`));
      } else if (ct && ncomp && acc.count > 0) {
        const elemSize = ct.size * ncomp;
        const stride = bv.byteStride && bv.byteStride > 0 ? bv.byteStride : elemSize;
        const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const end = start + stride * (acc.count - 1) + elemSize;
        const viewEnd = (bv.byteOffset || 0) + bv.byteLength;
        if (end > viewEnd) {
          issues.push(issue('ACCESSOR-OVERFLOW', 'error', `accessors[${i}]`,
            `accessor ends at byte ${end} of the buffer but its bufferView ends at ${viewEnd}`, end - viewEnd));
        }
      }
    }
    if (acc.count === undefined || acc.count < 0) {
      issues.push(issue('ACCESSOR-COUNT', 'error', `accessors[${i}]`, 'accessor.count must be a non-negative integer'));
    }
    if (acc.bufferView === undefined && !acc.sparse) {
      issues.push(issue('ACCESSOR-NODATA', 'error', `accessors[${i}]`, 'accessor has neither bufferView nor sparse data'));
    }
    if (acc.type === 'VEC3' && acc.min && acc.max) {
      const okMin = Array.isArray(acc.min) && acc.min.length >= 3;
      const okMax = Array.isArray(acc.max) && acc.max.length >= 3;
      if (!okMin || !okMax) {
        issues.push(issue('ACCESSOR-MINMAX-SHAPE', 'error', `accessors[${i}]`, 'min/max must have 3 components for VEC3'));
      }
    }
  });

  /* --- scene graph -------------------------------------------------- */
  const nodes = gltf.nodes || [];
  const roots = [];
  const scenes = gltf.scenes || [];
  const activeScene = scenes[gltf.scene ?? 0];
  if (!scenes.length) {
    issues.push(issue('SCENE-MISSING', 'error', 'scenes', 'no scenes defined'));
  }
  if (activeScene && Array.isArray(activeScene.nodes)) {
    activeScene.nodes.forEach((n) => {
      if (n >= nodes.length) {
        issues.push(issue('NODE-ROOT-RANGE', 'error', `scenes[${gltf.scene ?? 0}].nodes`, `node ${n} does not exist`));
      } else roots.push(n);
    });
  }
  if (nodes.length && !roots.length) {
    issues.push(issue('SCENE-EMPTY', 'warning', 'scenes', 'active scene has no root nodes'));
  }

  const reachable = new Set();
  const worldMatrices = new Map();
  const color = new Int8Array(nodes.length); // 0 unvisited, 1 in-stack, 2 done
  let cycles = 0;
  const childBad = [];
  const walk = (index, parentMatrix) => {
    if (index >= nodes.length) return;
    if (color[index] === 1) { cycles++; return; }
    if (color[index] === 2) return;
    color[index] = 1;
    reachable.add(index);
    const world = mulMat4(parentMatrix, localMatrix(nodes[index]));
    worldMatrices.set(index, world);
    const children = nodes[index].children || [];
    for (const c of children) {
      if (c >= nodes.length || c < 0) { childBad.push(c); continue; }
      if (c === index || color[c] === 1) { cycles++; continue; }
      walk(c, world);
    }
    color[index] = 2;
  };
  roots.forEach((r) => walk(r, IDENTITY));

  if (cycles) {
    issues.push(issue('NODE-CYCLE', 'error', 'nodes', 'node hierarchy contains a cycle', cycles));
  }
  if (childBad.length) {
    issues.push(issue('NODE-CHILD-RANGE', 'error', 'nodes',
      `child node index out of range: ${[...new Set(childBad)].slice(0, 5).join(', ')}`, childBad.length));
  }
  const orphans = nodes.map((_, i) => i).filter((i) => !reachable.has(i));
  if (orphans.length) {
    issues.push(issue('NODE-ORPHAN', 'info', 'nodes',
      `${orphans.length} node(s) not reachable from the active scene`, orphans.length));
  }

  nodes.forEach((node, i) => {
    if (node.mesh !== undefined && !gltf.meshes?.[node.mesh]) {
      issues.push(issue('NODE-MESH-RANGE', 'error', `nodes[${i}].mesh`, `mesh ${node.mesh} does not exist`));
    }
  });

  /* --- materials ---------------------------------------------------- */
  const texturedMaterials = new Set();
  (gltf.materials || []).forEach((mat, i) => {
    const pbr = mat.pbrMetallicRoughness || {};
    const factors = [pbr.baseColorFactor, pbr.metallicFactor, pbr.roughnessFactor];
    const f = pbr.baseColorFactor;
    if (Array.isArray(f)) {
      const bad = f.filter((v) => typeof v !== 'number' || v < 0 || v > 1);
      if (bad.length) {
        issues.push(issue('MATERIAL-COLOR-RANGE', 'error', `materials[${i}].pbrMetallicRoughness.baseColorFactor`,
          `baseColorFactor has ${bad.length} component(s) outside [0,1]`, bad.length));
      }
    }
    const checkTex = (info, label) => {
      if (!info) return;
      texturedMaterials.add(i);
      if (info.index === undefined || !gltf.textures?.[info.index]) {
        issues.push(issue('MATERIAL-TEXTURE-RANGE', 'error', `materials[${i}].${label}`,
          `texture index ${info.index} does not exist`));
      }
    };
    checkTex(pbr.baseColorTexture, 'pbrMetallicRoughness.baseColorTexture');
    checkTex(pbr.metallicRoughnessTexture, 'pbrMetallicRoughness.metallicRoughnessTexture');
    checkTex(mat.normalTexture, 'normalTexture');
    checkTex(mat.emissiveTexture, 'emissiveTexture');
    checkTex(mat.occlusionTexture, 'occlusionTexture');
    if (Array.isArray(factors)) void factors;
  });

  (gltf.images || []).forEach((img, i) => {
    if (img.bufferView !== undefined && !gltf.bufferViews?.[img.bufferView]) {
      issues.push(issue('IMAGE-BUFFERVIEW', 'error', `images[${i}]`, `bufferView ${img.bufferView} does not exist`));
    }
    if (img.uri === undefined && img.bufferView === undefined) {
      issues.push(issue('IMAGE-SOURCE', 'error', `images[${i}]`, 'image has neither uri nor bufferView'));
    }
  });

  /* --- meshes / geometry -------------------------------------------- */
  const usedAccessors = new Set();
  const allMin = [Infinity, Infinity, Infinity];
  const allMax = [-Infinity, -Infinity, -Infinity];
  const meshBounds = new Map();
  const geomWhere = [];
  let degenerateTotal = 0;
  let badNormalTotal = 0;
  let badIndexTotal = 0;

  (gltf.meshes || []).forEach((mesh, mi) => {
    (mesh.primitives || []).forEach((prim, pi) => {
      const where = `meshes[${mi}].primitives[${pi}]`;
      geomWhere.push(where);
      stats.primitives++;
      const attrs = prim.attributes || {};
      if (attrs.POSITION === undefined) {
        issues.push(issue('PRIM-NO-POSITION', 'error', where, 'primitive has no POSITION attribute'));
        return;
      }
      Object.values(attrs).forEach((a) => usedAccessors.add(a));
      if (prim.indices !== undefined) usedAccessors.add(prim.indices);

      const posAcc = gltf.accessors?.[attrs.POSITION];
      const pos = readAccessor(gltf, bin, attrs.POSITION, issues);
      if (!posAcc || !pos) return;
      const posCount = Math.min(posAcc.count, Math.floor(pos.length / 3));
      stats.vertices += posCount;

      const localMin = [Infinity, Infinity, Infinity];
      const localMax = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < posCount; i++) {
        for (let c = 0; c < 3; c++) {
          const v = pos[i * 3 + c];
          if (v < localMin[c]) localMin[c] = v;
          if (v > localMax[c]) localMax[c] = v;
        }
      }
      if (Number.isFinite(localMin[0])) {
        const mb = meshBounds.get(mi) || { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        for (let c = 0; c < 3; c++) {
          if (localMin[c] < mb.min[c]) mb.min[c] = localMin[c];
          if (localMax[c] > mb.max[c]) mb.max[c] = localMax[c];
        }
        meshBounds.set(mi, mb);
      }

      // declared min/max must match the payload (spec requires min/max on POSITION)
      if (posAcc.min && posAcc.max && posAcc.min.length >= 3) {
        const tol = Math.max(1e-6, (Math.abs(posAcc.min[0]) + Math.abs(posAcc.max[0])) * 1e-6);
        let mismatch = 0;
        for (let c = 0; c < 3; c++) {
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = 0; i < posCount; i++) {
            const v = pos[i * 3 + c];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          if (Math.abs(lo - posAcc.min[c]) > tol || Math.abs(hi - posAcc.max[c]) > tol) mismatch++;
        }
        if (mismatch) {
          issues.push(issue('ACCESSOR-MINMAX-MISMATCH', 'error', `${where}.POSITION`,
            `declared min/max disagree with the payload on ${mismatch} axis/axes`, mismatch));
        }
      } else {
        issues.push(issue('ACCESSOR-NO-MINMAX', 'warning', `${where}.POSITION`,
          'POSITION accessor has no min/max (required by the spec, used for culling/bounds)'));
      }

      const mode = prim.mode === undefined ? 4 : prim.mode;
      const indexed = prim.indices !== undefined;
      let idx = null;
      if (indexed) {
        const idxAcc = gltf.accessors?.[prim.indices];
        if (idxAcc && ![5121, 5123, 5125].includes(idxAcc.componentType)) {
          issues.push(issue('INDEX-TYPE', 'error', `${where}.indices`,
            `index componentType ${idxAcc.componentType} must be unsigned byte/short/int`));
        }
        idx = readAccessor(gltf, bin, prim.indices, issues);
        if (idx && idxAcc) stats.indices += Math.min(idxAcc.count, idx.length);
      }

      const triCount = mode === 4
        ? Math.floor((indexed ? (idx ? idx.length : 0) : posCount) / 3)
        : 0;
      stats.triangles += triCount;

      // index range + degenerate triangles
      if (mode === 4 && triCount > 0) {
        let bad = 0;
        let degenerate = 0;
        const diag = Math.hypot(localMax[0] - localMin[0], localMax[1] - localMin[1], localMax[2] - localMin[2]) || 1;
        const areaEps = (1e-12 * diag) * (1e-12 * diag);
        const get = indexed ? (k) => (idx ? idx[k] : 0) : (k) => k;
        for (let t = 0; t < triCount; t++) {
          const a = get(t * 3), b = get(t * 3 + 1), c = get(t * 3 + 2);
          if (a >= posCount || b >= posCount || c >= posCount) { bad++; continue; }
          if (a === b || b === c || a === c) { degenerate++; continue; }
          const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
          const e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
          const e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
          const cx = e1y * e2z - e1z * e2y;
          const cy = e1z * e2x - e1x * e2z;
          const cz = e1x * e2y - e1y * e2x;
          if (cx * cx + cy * cy + cz * cz <= areaEps) degenerate++;
        }
        if (bad) {
          badIndexTotal += bad;
          issues.push(issue('INDEX-RANGE', 'error', `${where}.indices`,
            `${bad} index/indices reference vertices beyond the ${posCount}-vertex POSITION accessor`, bad));
        }
        if (degenerate) {
          degenerateTotal += degenerate;
          issues.push(issue('TRI-DEGENERATE', 'error', where,
            `${degenerate} triangle(s) have zero area (repeated or collinear vertices)`, degenerate));
        }
      }

      // normals
      if (attrs.NORMAL !== undefined) {
        const nAcc = gltf.accessors?.[attrs.NORMAL];
        const normals = readAccessor(gltf, bin, attrs.NORMAL, issues);
        if (nAcc && normals) {
          if (nAcc.count !== posAcc.count) {
            issues.push(issue('PRIM-ATTR-COUNT', 'error', `${where}.NORMAL`,
              `NORMAL count ${nAcc.count} != POSITION count ${posAcc.count}`));
          }
          const n = Math.min(nAcc.count, Math.floor(normals.length / 3));
          let bad = 0;
          for (let i = 0; i < n; i++) {
            const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2];
            const len = Math.sqrt(x * x + y * y + z * z);
            if (Math.abs(len - 1) > 1e-3) bad++;
          }
          if (bad) {
            badNormalTotal += bad;
            issues.push(issue('NORMAL-NOT-UNIT', 'error', `${where}.NORMAL`,
              `${bad} normal(s) are not unit length (|len-1| > 1e-3)`, bad));
          }
        }
      } else {
        issues.push(issue('PRIM-NORMAL-MISSING', 'warning', where,
          'primitive has no NORMAL attribute; renderers must generate flat normals'));
      }

      if (mode === 4 && texturedMaterials.has(prim.material) && attrs.TEXCOORD_0 === undefined) {
        issues.push(issue('PRIM-TEXCOORD-MISSING', 'warning', where,
          `material ${prim.material} uses a texture but the primitive has no TEXCOORD_0`));
      }
      if (prim.material !== undefined && !gltf.materials?.[prim.material]) {
        issues.push(issue('PRIM-MATERIAL-RANGE', 'error', `${where}.material`, `material ${prim.material} does not exist`));
      }
    });
  });

  if (!stats.primitives) {
    issues.push(issue('SCENE-NO-GEOMETRY', 'error', 'meshes', 'asset contains no mesh primitives'));
  }

  // unused accessors
  (gltf.accessors || []).forEach((acc, i) => {
    if (!usedAccessors.has(i) && !(gltf.skins || []).some((s) => s.inverseBindMatrices === i)) {
      issues.push(issue('ACCESSOR-UNUSED', 'info', `accessors[${i}]`, 'accessor is never referenced', 1));
    }
  });

  /* --- bbox, units, up-axis ----------------------------------------- */
  // world-space bounds: transform each mesh's local bounds by its node's world matrix
  const worldMin = [Infinity, Infinity, Infinity];
  const worldMax = [-Infinity, -Infinity, -Infinity];
  nodes.forEach((node, i) => {
    if (node.mesh === undefined) return;
    const mb = meshBounds.get(node.mesh);
    const wm = worldMatrices.get(i);
    if (!mb || !wm) return;
    for (let k = 0; k < 8; k++) {
      const p = [
        k & 1 ? mb.max[0] : mb.min[0],
        k & 2 ? mb.max[1] : mb.min[1],
        k & 4 ? mb.max[2] : mb.min[2],
      ];
      const w = transformPoint(wm, p);
      for (let c = 0; c < 3; c++) {
        if (w[c] < worldMin[c]) worldMin[c] = w[c];
        if (w[c] > worldMax[c]) worldMax[c] = w[c];
      }
    }
  });
  if (Number.isFinite(worldMin[0])) {
    const size = [worldMax[0] - worldMin[0], worldMax[1] - worldMin[1], worldMax[2] - worldMin[2]];
    stats.bbox = {
      min: worldMin.map(round6), max: worldMax.map(round6), size: size.map(round6),
      diagonal: round6(Math.hypot(size[0], size[1], size[2])),
    };
  } else if (Number.isFinite(allMin[0])) {
    const size = [allMax[0] - allMin[0], allMax[1] - allMin[1], allMax[2] - allMin[2]];
    stats.bbox = {
      min: allMin.map(round6), max: allMax.map(round6), size: size.map(round6),
      diagonal: round6(Math.hypot(size[0], size[1], size[2])),
    };
  }

  const declaredAxis = gltf.asset?.extras?.upAxis || gltf.extras?.upAxis;
  if (declaredAxis === 'Z') stats.upAxis = 'Z';
  let rootRotation = false;
  roots.forEach((r) => {
    const q = nodes[r]?.rotation;
    if (Array.isArray(q) && q.length === 4) {
      const [x, y, z, w] = q;
      if (Math.abs(x) > 0.7070 && Math.abs(w) > 0.7070 && Math.abs(y) < 1e-3 && Math.abs(z) < 1e-3) rootRotation = true;
    }
  });
  if (declaredAxis === 'Z' || rootRotation) {
    stats.upAxis = 'Z';
    issues.push(issue('UP-AXIS-SUSPECT', 'warning', 'scenes[0].nodes',
      'root node carries a ±90° X rotation (or extras.upAxis="Z"); viewers assume Y-up, so the asset will lie on its side'));
  }

  if (stats.bbox) {
    const d = stats.bbox.diagonal;
    if (d > 500) {
      stats.units = 'mm-or-cm';
      issues.push(issue('UNIT-SCALE-SUSPECT', 'warning', 'meshes',
        `scene diagonal is ${d} units; likely millimetres or centimetres authored as metres`));
    } else if (d < 0.05) {
      stats.units = 'km-or-smaller';
      issues.push(issue('UNIT-SCALE-SUSPECT', 'warning', 'meshes',
        `scene diagonal is ${d} units; likely kilometres authored as metres`));
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const infos = issues.filter((i) => i.severity === 'info').length;

  stats.ms = round3(now() - t0);
  return {
    ok: errors === 0,
    issues,
    stats,
    summary: { errors, warnings, infos, total: issues.length },
    ms: stats.ms,
  };
}

/* ------------------------------------------------------------------ misc */

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const round3 = (v) => Math.round(v * 1e3) / 1e3;

export const CODES = {
  'GLB-VERSION': 'GLB container version is not 2',
  'GLB-LENGTH': 'GLB header length does not match the file size',
  'GLB-CHUNK-TRUNCATED': 'a GLB chunk runs past the end of the file',
  'BUFFER-BIN-SIZE': 'buffer.byteLength exceeds the BIN chunk',
  'BUFFER-EXTERNAL': 'external buffer URI cannot be resolved',
  'BUFFERVIEW-BUFFER': 'bufferView points at a missing buffer',
  'BUFFERVIEW-OVERFLOW': 'bufferView runs past its buffer',
  'ACCESSOR-TYPE': 'unknown accessor component/type',
  'ACCESSOR-BUFFERVIEW': 'accessor points at a missing bufferView',
  'ACCESSOR-OVERFLOW': 'accessor runs past its bufferView',
  'ACCESSOR-MINMAX-MISMATCH': 'declared min/max disagree with the binary payload',
  'ACCESSOR-NO-MINMAX': 'POSITION accessor lacks min/max',
  'INDEX-RANGE': 'index buffer references vertices that do not exist',
  'INDEX-TYPE': 'index componentType is not unsigned',
  'TRI-DEGENERATE': 'zero-area triangles',
  'NORMAL-NOT-UNIT': 'normals are not unit length',
  'PRIM-NORMAL-MISSING': 'primitive has no normals',
  'PRIM-NO-POSITION': 'primitive has no POSITION attribute',
  'PRIM-TEXCOORD-MISSING': 'textured primitive has no UVs',
  'PRIM-ATTR-COUNT': 'attribute counts disagree',
  'NODE-CHILD-RANGE': 'node child index out of range',
  'NODE-CYCLE': 'node hierarchy contains a cycle',
  'NODE-ORPHAN': 'nodes unreachable from the scene',
  'NODE-MESH-RANGE': 'node references a missing mesh',
  'MATERIAL-COLOR-RANGE': 'baseColorFactor outside [0,1]',
  'MATERIAL-TEXTURE-RANGE': 'material references a missing texture',
  'UP-AXIS-SUSPECT': 'asset appears to be Z-up',
  'UNIT-SCALE-SUSPECT': 'scene scale looks like the wrong unit',
  'ACCESSOR-UNUSED': 'accessor is never referenced',
};
