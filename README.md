# glTF Audit Lab

A GLB integrity auditor that runs **in the browser and in Node from the same module** (`src/core.mjs`, zero dependencies, no three.js import). It parses the GLB container itself, decodes accessors (byteStride + sparse), and cross-checks the binary payload against the JSON declarations.

Open it, load `assets/broken.glb`, and the defects are listed with counts and highlighted in red on the model.

```bash
python3 -m http.server 4173     # then open http://localhost:4173
```

No install step, no build step. three.js comes from jsDelivr via an import map.

## What it proves

| Claim | Number |
| --- | --- |
| Full audit of a large asset | **8.06 MB / 351,122 triangles in 22.62 ms** (median of 7, Node 24) |
| Throughput | **356 MB/s**, 15.5M triangles/s |
| Seeded defects found in `assets/broken.glb` | **10 errors, 4 warnings, 1 info — 15/15, no duplicates** |
| False positives on the clean asset | **0 findings** on `assets/good.glb` (139 KB, 7,680 triangles) |
| Single-mutation test | corrupt 5 normals → **exactly 1 finding**, count = 5 |

Raw numbers: [`bench/result.json`](bench/result.json). Assertions: [`bench/verify.mjs`](bench/verify.mjs).

## What it checks

Container and payload:

- `GLB-LENGTH` / `GLB-CHUNK-TRUNCATED` — header length and chunk bounds against the real file size
- `ACCESSOR-OVERFLOW` / `BUFFERVIEW-OVERFLOW` — accessor extent vs its bufferView, bufferView vs the BIN chunk
- `ACCESSOR-MINMAX-MISMATCH` — declared POSITION `min`/`max` vs the actual float payload (the classic cause of broken frustum culling and wrong picking)
- `INDEX-RANGE` — indices pointing past the POSITION accessor
- `TRI-DEGENERATE` — zero-area triangles (repeated or collinear corners)
- `NORMAL-NOT-UNIT` — normals whose length deviates from 1 by more than 1e-3
- `MATERIAL-COLOR-RANGE`, `MATERIAL-TEXTURE-RANGE`, `PRIM-TEXCOORD-MISSING`, `IMAGE-*`

Scene and units:

- `NODE-CYCLE` / `NODE-CHILD-RANGE` — hierarchy cycles and dangling children (traversal is cycle-safe)
- `UP-AXIS-SUSPECT` — a ±90° X rotation on a scene root (or `extras.upAxis = "Z"`): the asset will lie on its side in a Y-up viewer
- `UNIT-SCALE-SUSPECT` — world-space bbox diagonal outside 0.05–500 units, i.e. millimetres authored as metres (node transforms are composed, so a 1000× root scale is caught)
- `ACCESSOR-UNUSED`, `NODE-ORPHAN`, `ACCESSOR-NO-MINMAX` — dead weight, reported as info/warning

World bounds are computed by composing each node's TRS matrix and transforming its mesh's local bounds — not by reading `accessor.min/max`, which may be the thing that is wrong.

## Run the tests

```bash
node bench/verify.mjs     # 33 assertions, exit 0 only if all pass
node bench/bench.mjs      # rebuilds the 8 MB fixture in memory, writes bench/result.json
```

`bench/verify.mjs` needs nothing but Node: it audits both committed fixtures, mutates five normals in a copy of the clean asset to prove there is no collateral damage, and feeds truncated and garbage input to prove the parser never throws.

## Layout

```
src/core.mjs            parser + decoder + all checks (pure ES module, no three.js)
main.js, index.html     three.js viewer: geometry, issue list, red degenerate overlay
assets/good.glb         clean 7,680-triangle torus knot
assets/broken.glb       same mesh + 15 seeded findings
tools/make-fixtures.mjs regenerates both fixtures deterministically
tools/glb-writer.mjs    minimal GLB writer shared by fixtures and benchmark
bench/verify.mjs        Node acceptance test
bench/bench.mjs         throughput benchmark
```

Both fixtures are generated from code (`node tools/make-fixtures.mjs`) — no binary assets are downloaded, and the broken one is reproducible.

## In the viewer

- `good.glb` / `broken.glb` tabs, plus drag-and-drop or **Open…** for any `.glb` on your machine (parsed locally, never uploaded)
- every finding is clickable and selects the mesh it belongs to
- **Degenerate overlay** draws zero-area triangles in red on top of the model
- wireframe toggle, frame-selection, live triangle count and fps

## Limitations

- GLB only for binary data; a `.gltf` with external `.bin`/textures is reported as `BUFFER-EXTERNAL` and its payload is skipped.
- Checks are structural, not artistic: it will not tell you the model is ugly, only that its bytes disagree with its declarations.
- No Draco/KTX2 decoding — compressed primitives are reported, not decompressed.
