/** Minimal GLB writer shared by the fixture generator and the benchmark. */
export function pad4(n) { return (4 - (n % 4)) % 4; }

export function f32(arr) { return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); }

export function concatAligned(parts) {
  let total = 0;
  for (const p of parts) total += p.bytes.length + pad4(p.bytes.length);
  const out = new Uint8Array(total);
  let o = 0;
  const views = [];
  for (const p of parts) {
    out.set(p.bytes, o);
    views.push({ byteOffset: o, byteLength: p.bytes.length });
    o += p.bytes.length + pad4(p.bytes.length);
  }
  return { bin: out, views };
}

export function writeGLB(json, bin, { lieAboutLength = false } = {}) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = jsonBytes.length + pad4(jsonBytes.length);
  const binLen = bin.length + pad4(bin.length);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, lieAboutLength ? total + 4 : total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  const o = 20 + jsonLen;
  dv.setUint32(o, binLen, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  out.set(bin, o + 8);
  return out;
}
