# Property Viewer (Phase 1 — standalone)

One component that previews a property unit in whichever way the data allows,
always degrading to something rather than breaking:

```
real view   →   procedural "concept model"   →   image gallery
(embed/tour360/model3d)   (generated from a floor plan)     (fallback image)
```

- **No CDN.** Pannellum and Three.js (+ addons, Draco, meshopt) are vendored in
  `vendor/` and loaded lazily from `./vendor/` only when needed.
- **Isomorphic core.** `validation.js`, `pannellum-config.js`, `floorplan.js`,
  `seed-templates.js`, `procedural-scene.js`, `scanzip.js` and `cubemap-solve.js`
  are DOM-free and unit-tested in `node --test`. Only `viewer.js` /
  `procedural-viewer.js` / `scanzip-browser.js` touch the DOM/WebGL.
- **Phase 1 = standalone.** Nothing is wired into the app yet (see Phase 2).

## Run the demo

Serve this folder over HTTP (ES modules + `fetch` need an origin), then open
`showcase.html` for the clean, full-bleed viewer:

```bash
# from this directory
npx http-server . -o /showcase.html      # or: python -m http.server
```

- **`showcase.html`** — the landing page: a full-bleed **upload-first** page. It
  opens on an empty state ("Drop a 3D or VR file"), with an **Upload file**
  button and drag-and-drop. The chosen file is read locally (object URL, no
  server round-trip), its type is detected, and the matching renderer opens with
  the file name + type badge in the header. Unsupported files are refused with a
  toast instead of rendering. A raw iPhone LiDAR scan archive (`.zip`) is decoded
  in the browser too — see [iPhone LiDAR scans](#iphone-lidar-scans-zip). No
  preset units are shipped any more.
- **`demo.html`** — the developer harness: every viewer kind plus intentional
  *BROKEN* cases that must land on the fallback screen, and a **Manager tools**
  panel with a floor-plan JSON editor, live preview, reset-to-template and a
  **Download .glb** button.

A convenience server is kept on **http://localhost:5050/** that serves *only*
the upload page and its module graph — `demo.html`, `samples/` and everything
else return **404** from that port (the test runners use their own server, so
they are unaffected).

## Viewer types

| `viewer_type` | Renders | Config |
| --- | --- | --- |
| `embed` | sandboxed `<iframe>` (allow-listed hosts only, https) | `{ url, title?, aspect? }` |
| `tour360` | Pannellum cubemap or equirect, multi-scene + hotspots | `{ format, scenes[], startScene? }` |
| `model3d` | glTF/GLB, OBJ and STL via Three.js (Draco + meshopt, AR button) | `{ url, format?, usdz?, scale?, autoRotate?, draco?, xr? }` |
| `pointcloud` | point-cloud scan as `THREE.Points` (decimated) | `{ url, format?, pointSize?, maxPoints?, colorMode?, background? }` |
| `procedural` | generated 3D "concept model" from a floor plan | floor plan JSON (see below) |
| `none` | image gallery / fallback | `fallback_image_url` |

Selection is expressed by `selectViewer(row)` → an ordered candidate chain,
`firstValidViewer(row)` picks the first valid one. A broken real viewer falls
through to the procedural template, then the image.

## Procedural concept models

A manager supplies plain floor-plan JSON (validated by `validateFloorPlan`):

```json
{
  "name": "Apartment — 3 bedroom", "units": "m",
  "exterior": { "wallColor": "#F0F0F0", "roofType": "pitched", "roofColor": "#303030" },
  "storeys": [{
    "name": "Apartment",
    "rooms": [
      { "name": "Living", "type": "living", "x": 0, "z": 0, "width": 6, "depth": 6,
        "doors":   [ { "wall": "west", "position": 3.2, "width": 0.9, "height": 2.05 } ],
        "windows": [ { "wall": "south", "position": 1.8, "width": 2.0, "height": 1.3, "sill": 0.9 } ] }
    ],
    "stairs": [ { "x": 4, "z": 0.6, "width": 1.4, "depth": 2.4, "direction": "up", "to": 1 } ]
  }]
}
```

`floorplan.js` turns that into a render-agnostic scene (walls split around real
door/window openings, floors, ceilings, roof, stairs, furniture by room type,
hotspots) plus a **collision model** (walls block movement only up to waist
height; doors are walkable gaps). `procedural-scene.js` builds merged Three.js
meshes from it; `procedural-viewer.js` adds the interaction.

Features of the concept model:

- **Inside** and **Dollhouse** modes in a single bottom control bar, plus a
  floor selector, a room-**Labels** toggle and (in Dollhouse) a roof toggle.
- **Inside** mode: WASD + mouse-lock (desktop), joystick + drag (touch),
  wall collision, eye height 1.62 m, per-floor switching.
- **Dollhouse** mode: orbit/zoom, hide-roof toggle, per-floor filter.
- Room hotspot labels, a live **minimap**, and **Download .glb** (via the
  vendored `GLTFExporter`).
- Labelled "Concept model" in the toolbar — it is a placeholder, not a survey.

### Seed templates (`seed-templates.js`)

Keyed by **typology + bedrooms**, reusable by any property:
`apartment-3`, `townhouse-3`, `rowhouse-2`, `villa-4`, `villa-5`.
`getTemplate(typology, beds)` returns the closest template; `templatePlan(id)`
returns a deep copy safe to edit.

## Upload any 3D / VR file

`showcase.html` is upload-first: an **Upload file** button in the header, plus
drag-and-drop anywhere onto the page. The file is read **entirely in the browser**
via an object URL — nothing is sent to a server in Phase 1. Its extension picks
the renderer, and an unsupported extension is refused with a toast:

| Extension | Renderer |
| --- | --- |
| `.glb`, `.gltf` | `model3d` (glTF, Draco + meshopt) |
| `.obj` | `model3d` via the vendored `OBJLoader` (single-file; no `.mtl`/textures yet) |
| `.stl` | `model3d` via the vendored `STLLoader`, flat-shaded `MeshStandardMaterial` |
| `.ply` (binary or ASCII) | `pointcloud` via the vendored `PLYLoader` |
| `.xyz`, `.asc`, `.pts`, `.txt`, `.csv` | `pointcloud` |
| `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif` | `tour360` as a single equirectangular scene |
| `.zip` (iPhone LiDAR scan) | `pointcloud` **and** `tour360` — see below |

Swap a file and the previous viewer is disposed first, so repeated uploads in
one tab stay lean (object URLs are revoked). `demo.html` still hosts the
developer samples (including the decimated MatterPak house).

### iPhone LiDAR scans (`.zip`)

A capture app (e.g. an iPhone Pro LiDAR scan) exports a zipped project folder:
one **point cloud per sweep** (`*_sweep_cloud.pb`), a **six-face skybox per sweep**
(`*_skybox0..5.jpg`) and a pile of raw frames (`*.swl`, `*.mmp`, …) the browser
cannot use. Dropping that **`.zip`** on `showcase.html` decodes it **entirely in
the browser** and offers two views, toggled in the header:

- **Point cloud** — every sweep's `.pb` is a small protobuf; the clouds are
  already aligned into one shared world frame, so they are merged, baked
  Z-up → Y-up ((x,y,z) → (x,z,−y)), trimmed and packed into an in-memory binary
  PLY served from a `blob:` URL. The existing `pointcloud` renderer draws it with
  no changes (a blob URL is just another asset URL). Decoding runs sweep by
  sweep with a progress readout — the **first sweep is drawn immediately** as a
  preview so the screen is never blank, and the remaining sweeps stream in. The
  PLY is **sampled evenly across the whole cloud** (a first-N cut would drop the
  later sweeps and leave holes), and the camera is **framed on percentile
  ("robust") bounds** rather than min/max, so a scan's stray far returns cannot
  pull the camera back and shrink the real geometry to a blob amid scattered
  dots.
- **360° tour** — one sweep's six skybox faces. The app does not say which face
  is front/right/back/left/up/down, nor how each is rotated, so the assembly is
  **solved from the pixels** (`cubemap-solve.js`): faces that meet along a cube
  edge must carry the same luminance profile. The winners are rotated — with the
  same `rotateRgba` the solver assumes — into six JPEG blobs in Pannellum order
  and fed to the `tour360` cubemap renderer.

The whole archive is read by range (`File.slice`), deflated with the platform
`DecompressionStream('deflate-raw')`, and nothing is uploaded — a 962 MB scan
reads only ~43 MB of its bytes. A percentage/progress badge tracks the sweeps as
they decode; if the file has no cloud and no solvable skybox, it is refused with
a readable toast instead of a blank screen.

**Pre-decoding from the command line (optional).** The same `scanzip.js` decoder
powers a zero-dependency CLI to produce web assets ahead of time:

```bash
npm run scanzip -- "3 Bed apt.zip" samples/pointcloud/apt-3bed.ply --faces samples/tour/apt-3bed
#   --max-points N   target point count (default 400000)
#   --stride N       keep every Nth point
#   --up y|z         source up-axis (default z)
#   --clip PERCENT   drop far point tails (default 0.1% per side)
#   --faces DIR      export one sweep's six cubemap faces + tour.json
#   --manifest FILE  write a JSON summary
#   --list           just print what the archive contains
```

On a real 962 MB archive this reads 43.2 MB in ~4 s and writes a 4 MB, 278 K-point
`apt-3bed.ply` plus the six faces. The committed demo assets
(`samples/pointcloud/apt-3bed.ply`, `samples/tour/apt-3bed/`) were made this way.

`pointcloud.js` parses the text layout `x y z [r g b]` (also `x y z intensity`,
and `x y z nx ny nz r g b`), normalises 0-255 colours, **decimates to
`maxPoints`** (default 1.5 M) so a big scan stays interactive, and colours by RGB
or by height. `colorMode` is `rgb`, `height` or `uniform`; `pointSize` defaults
to a size relative to the scan's bounding box.

**Not directly supported:** RVT/DWG/DXF (BIM/CAD), E57, FBX, USDZ and MatterPak
point clouds are authoring/scan formats no browser renders as-is. Export them to
a web format first — `.glb` for a mesh, or `.ply`/`.xyz` for a point cloud
(MatterPak's XYZ part loads directly). Multi-file formats (`.gltf` + external
`.bin`, `.obj` + `.mtl`) need their sidecar files, so pack to `.glb` for now.
Server-side conversion, texture-aware OBJ and stored uploads are Phase 2.

### Pre-converting a huge scan

Raw scanner clouds are often far too big for a browser tab — a Matterport
**MatterPak `cloud.xyz` is ~2 GB**. `scripts/pointcloud-decimate.js` streams such
a file and writes a small web-ready copy (zero dependencies, constant memory):

```bash
npm run decimate -- big-cloud.xyz output.ply --max-points 300000 --up z
#   --max-points N   target point count (default 500000)
#   --stride N       keep every Nth row (skip the counting pass)
#   --format ply|xyz override output format (else from the extension)
#   --up y|z         'z' bakes Z-up -> Y-up (MatterPak / E57 / most scanners)
```

Output `.ply` is binary little-endian (fast, compact — ~15 bytes/point); `.xyz`
is plain text. The committed `samples/pointcloud/matterpak-house.ply` was made
from a MatterPak sample this way: 52.2 M points → stride 175 → 298 K points →
4.3 MB, listed in the unit picker as **Point cloud — scanned house**.

## API

```js
import { createPropertyViewer } from './viewer.js';
const pv = createPropertyViewer(host, {
  assetBase: '',                 // prefix for relative asset paths
  allowList: DEFAULT_EMBED_HOSTS, // iframe host allow-list
  lowBandwidth: false,           // poster instead of loading 3D/tour
  chrome: true,                  // false hides the built-in toolbar (host shows its own)
  proceduralMode: 'walk',        // 'walk' (Inside) | 'dollhouse' — concept-model start
  minimap: true,                 // concept-model minimap
  labels: true,                  // concept-model room labels
  resolveTemplate: (vm) => plan, // override the procedural fallback plan
  onReady: (kind) => {},
  onError: (err) => {},
  onRoom: (name) => {},          // procedural room hotspot clicked
  onMode: (mode) => {},          // 'dollhouse' | 'walk'
});
pv.render(typologyRow);          // DB row (snake_case) or normalised object
pv.toggleFullscreen();
pv.destroy();
```

## Tests

```bash
npm test          # node --test — 96 unit tests (validation, floor plan, selection, point clouds, scans, cubemap solver, decimate CLI, scene graph, pages)
```

Unit tests cover validation/roles, the Pannellum config mapping, floor-plan
validation, seed-template integrity, scene generation, the collision model, the
fallback chain, the generated Three.js object graph, the scan-archive decoder
(`scanzip.js`) and the cubemap orientation solver (`cubemap-solve.js`).

The browser smoke test (rubric for the full component, incl. headless WebGL) is
a separate CDP harness run during review: it drives `demo.html` in headless Edge
and asserts every viewer kind, procedural controls, roof toggle, walkthrough
movement, `.glb` export, and all broken-input fallbacks.

A second headless check drives `showcase.html` itself: empty state on load, no
preset canvas, the accept list, an unsupported file being rejected, then real
uploads of an `.xyz` point cloud, a `.glb`, an `.obj`, a `.stl` and an equirect
JPEG, each asserting the active kind, canvas, file name and type badge.

A third headless check drives a scan `.zip` end-to-end: it drops a small
synthetic archive (one `*_sweep_cloud.pb` + six `*_skybox*.jpg`) on the page and
asserts the point cloud renders, the cubemap solver succeeds, the
point-cloud/360 toggle appears and both views mount.

## Not done yet (Phase 2)

- `typologies` table + migration, linking `properties.typology`.
- `routes/viewers.js` API, dependency-free upload endpoint.
- Embedding into the booking flow and the manager **Viewer Setup** tab.
- Real assets per unit (Matterport links, panoramas, `.glb`); the procedural
  model is the stand-in until those exist.
