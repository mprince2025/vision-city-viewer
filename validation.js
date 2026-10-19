/**
 * Property Viewer — shared (isomorphic) validation + rules.
 *
 * Used by BOTH the browser component (viewer.js) and the server routes so the
 * exact same allow-list / format rules are enforced in one place. No DOM, no
 * Node-only APIs, no dependencies — importable from a browser ES module and
 * from `node --test`.
 */

export const VIEWER_TYPES = Object.freeze(['embed', 'tour360', 'model3d', 'pointcloud', 'procedural', 'none']);

// Who may create/update viewer configuration. Buyers are read-only.
export const WRITE_ROLES = Object.freeze(['manager', 'advisor', 'admin']);
export const READ_ROLES = Object.freeze(['manager', 'advisor', 'admin', 'buyer', 'agent']);

// Root registrable domains we trust for iframe embeds. Sub-domains match
// automatically (e.g. "matterport.com" also allows "my.matterport.com").
export const DEFAULT_EMBED_HOSTS = Object.freeze([
  'matterport.com',
  'kuula.co',
  '3dvista.com',
  'ricoh360.com',
  'theta360.com',
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'sketchfab.com',
]);

export const VIEWER_TYPE_LABELS = Object.freeze({
  embed: 'Embedded tour (iframe)',
  tour360: '360° tour (panorama set)',
  model3d: '3D model (.glb / .gltf / .obj / .stl)',
  pointcloud: 'Point cloud scan (.xyz / .ply)',
  procedural: 'Concept model (procedural 3D)',
  none: 'No viewer (gallery / floor plan)',
});

// The viewer "kinds" a typology can render, plus the failure path.
export const RENDERERS = Object.freeze(['embed', 'tour360', 'model3d', 'pointcloud', 'procedural', 'fallback']);

// Room types understood by the procedural generator (unknown -> 'other').
export const ROOM_TYPES = Object.freeze([
  'living', 'bedroom', 'kitchen', 'bathroom', 'dining', 'hall', 'balcony',
  'garage', 'closet', 'study', 'utility', 'stairs', 'other',
]);

export const WALLS = Object.freeze(['north', 'south', 'east', 'west']);

/* ------------------------------------------------------------------ */
/* Roles                                                              */
/* ------------------------------------------------------------------ */

export function canEditViewer(role) {
  return WRITE_ROLES.includes(String(role || '').toLowerCase());
}

export function canViewViewer(role) {
  return READ_ROLES.includes(String(role || '').toLowerCase());
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                        */
/* ------------------------------------------------------------------ */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

function isLocalHost(hostname) {
  return LOCAL_HOSTS.includes(String(hostname || '').toLowerCase());
}

/**
 * Parse an absolute URL. Returns a URL object or null (never throws).
 * Relative paths ("tour/real/entry") intentionally return null here and are
 * handled by validateAssetUrl.
 */
export function parseAbsoluteUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null; // needs scheme://
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function hostMatchesAllowList(hostname, allowList = DEFAULT_EMBED_HOSTS) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return (allowList || []).some((entry) => {
    const e = String(entry || '').toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
    if (!e) return false;
    return host === e || host.endsWith('.' + e);
  });
}

/** Safe relative / same-origin asset path? (no scheme, no traversal, no XSS) */
export function isSafeRelativePath(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false; // any scheme (javascript:, data:, http:)
  if (raw.startsWith('//')) return false; // protocol-relative
  if (raw.includes('..')) return false; // traversal
  if (raw.includes('\\')) return false; // backslash tricks
  return /^[a-z0-9._~!$&'()*+,;=:@%\-/]+$/i.test(raw);
}

/* ------------------------------------------------------------------ */
/* Embed URL                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate an iframe embed URL.
 * Rules: https-only, host must be in the allow-list, must be an absolute URL.
 * @returns {{ok:boolean, url:string|null, host:string|null, error:string|null}}
 */
export function validateEmbedUrl(value, allowList = DEFAULT_EMBED_HOSTS) {
  const fail = (error) => ({ ok: false, url: null, host: null, error });
  const url = parseAbsoluteUrl(value);
  if (!url) return fail('Enter a full URL including https://');
  if (url.protocol !== 'https:') return fail('Embed URLs must use https://');
  if (!hostMatchesAllowList(url.hostname, allowList)) {
    return fail(`Host "${url.hostname}" is not on the allowed embed list`);
  }
  return { ok: true, url: url.toString(), host: url.hostname, error: null };
}

/* ------------------------------------------------------------------ */
/* Asset URL (panoramas / models / fallback images)                   */
/* ------------------------------------------------------------------ */

/**
 * Validate an asset reference used by tour360 / model3d / fallback.
 * Accepts https URLs (any host — assets are fetched by us, not framed) and
 * same-origin relative paths. Rejects http:, javascript:, data:, etc.
 * http://localhost is allowed for local development.
 * @returns {{ok:boolean, url:string|null, kind:'absolute'|'relative'|null, error:string|null}}
 */
export function validateAssetUrl(value) {
  const fail = (error) => ({ ok: false, url: null, kind: null, error });
  if (typeof value !== 'string' || !value.trim()) return fail('Missing asset URL');
  const raw = value.trim();

  // Locally uploaded files are referenced with an in-memory blob: URL. They are
  // same-origin by construction, so they are safe to load.
  if (/^blob:/i.test(raw)) return { ok: true, url: raw, kind: 'blob', error: null };

  const url = parseAbsoluteUrl(raw);
  if (url) {
    if (url.protocol === 'https:') return { ok: true, url: url.toString(), kind: 'absolute', error: null };
    if (url.protocol === 'http:' && isLocalHost(url.hostname)) {
      return { ok: true, url: url.toString(), kind: 'absolute', error: null };
    }
    return fail('Asset URLs must use https:// (http:// only for localhost)');
  }

  if (isSafeRelativePath(raw)) return { ok: true, url: raw, kind: 'relative', error: null };
  return fail('Invalid or unsafe asset path');
}

/* ------------------------------------------------------------------ */
/* Viewer config                                                      */
/* ------------------------------------------------------------------ */

export function emptyViewerConfig(viewerType = 'none') {
  switch (viewerType) {
    case 'embed':
      return { url: '', title: '', aspect: '16 / 9' };
    case 'tour360':
      return { format: 'cubemap', startScene: null, scenes: [] };
    case 'model3d':
      return { url: '', scale: 1, autoRotate: false, xr: true, draco: true, usdz: '' };
    case 'pointcloud':
      return { url: '', format: 'auto', pointSize: 0, maxPoints: 1500000, colorMode: 'rgb', background: '' };
    case 'procedural':
      return { units: 'm', storeys: [], exterior: {} };
    default:
      return {};
  }
}

/**
 * Validate a full viewer config object for a given viewer_type.
 * @returns {{ok:boolean, errors:string[], value:object}}
 */
export function validateViewerConfig(viewerType, config, opts = {}) {
  const allowList = opts.allowList || DEFAULT_EMBED_HOSTS;
  const errors = [];
  const cfg = config && typeof config === 'object' ? config : {};

  if (!VIEWER_TYPES.includes(viewerType)) {
    errors.push(`Unknown viewer type "${viewerType}"`);
    return { ok: false, errors, value: cfg };
  }

  if (viewerType === 'none') return { ok: true, errors, value: {} };

  if (viewerType === 'procedural') {
    const res = validateFloorPlan(cfg);
    return { ok: res.ok, errors: res.errors, value: res.value };
  }

  if (viewerType === 'embed') {
    const res = validateEmbedUrl(cfg.url, allowList);
    if (!res.ok) errors.push(`Embed URL: ${res.error}`);
    if (cfg.aspect != null && typeof cfg.aspect !== 'string') errors.push('aspect must be a string');
    return { ok: errors.length === 0, errors, value: { ...cfg } };
  }

  if (viewerType === 'model3d') {
    const res = validateAssetUrl(cfg.url);
    if (!res.ok) errors.push(`Model URL: ${res.error}`);
    if (cfg.usdz && !validateAssetUrl(cfg.usdz).ok) errors.push('USDZ (iOS AR) URL is invalid');
    if (cfg.scale != null && (!isFinite(cfg.scale) || cfg.scale <= 0)) errors.push('scale must be a positive number');
    if (cfg.autoRotate != null && typeof cfg.autoRotate !== 'boolean') errors.push('autoRotate must be a boolean');
    return { ok: errors.length === 0, errors, value: { ...cfg } };
  }

  if (viewerType === 'pointcloud') {
    const res = validateAssetUrl(cfg.url);
    if (!res.ok) errors.push(`Point-cloud URL: ${res.error}`);
    if (cfg.format != null && !['xyz', 'ply', 'auto'].includes(cfg.format)) errors.push('format must be "xyz", "ply" or "auto"');
    if (cfg.pointSize != null && cfg.pointSize !== 0 && (!isFinite(cfg.pointSize) || cfg.pointSize < 0)) errors.push('pointSize must be a positive number');
    if (cfg.maxPoints != null && (!Number.isInteger(cfg.maxPoints) || cfg.maxPoints <= 0)) errors.push('maxPoints must be a positive integer');
    if (cfg.colorMode != null && !['rgb', 'height', 'uniform'].includes(cfg.colorMode)) errors.push('colorMode must be "rgb", "height" or "uniform"');
    if (cfg.background != null && cfg.background !== '' && !isHexColor(cfg.background)) errors.push('background must be a #rrggbb hex colour');
    return { ok: errors.length === 0, errors, value: { ...cfg } };
  }

  // tour360
  const format = cfg.format === 'equirect' ? 'equirect' : 'cubemap';
  const scenes = Array.isArray(cfg.scenes) ? cfg.scenes : [];
  if (scenes.length === 0) errors.push('Add at least one scene');

  const ids = new Set();
  scenes.forEach((scene, i) => {
    const where = `scene ${i + 1}`;
    if (!scene || typeof scene !== 'object') { errors.push(`${where}: invalid`); return; }
    const id = String(scene.id || '').trim();
    if (!id) errors.push(`${where}: missing id`);
    else if (ids.has(id)) errors.push(`${where}: duplicate id "${id}"`);
    else ids.add(id);

    if (format === 'equirect') {
      const p = validateAssetUrl(scene.panorama);
      if (!p.ok) errors.push(`${where} ("${id}"): panorama ${p.error}`);
    } else {
      const cube = scene.cubeFaces;
      if (Array.isArray(cube)) {
        if (cube.length !== 6) errors.push(`${where} ("${id}"): cubemap needs exactly 6 faces`);
        cube.forEach((f) => { if (!validateAssetUrl(f).ok) errors.push(`${where} ("${id}"): invalid cube face`); });
      } else if (typeof scene.base === 'string') {
        if (!validateAssetUrl(scene.base).ok) errors.push(`${where} ("${id}"): invalid cube base path`);
      } else {
        errors.push(`${where} ("${id}"): provide cubeFaces[6] or a base path`);
      }
    }

    const hotspots = Array.isArray(scene.hotspots) ? scene.hotspots : [];
    hotspots.forEach((h, hIdx) => {
      const target = h && String(h.target || '').trim();
      if (!target) errors.push(`${where}: hotspot ${hIdx + 1} missing target`);
      else if (target === id) errors.push(`${where}: hotspot ${hIdx + 1} points at its own scene`);
    });
  });

  // geographic/entry hotspots must reference a scene declared before them
  scenes.forEach((scene, i) => {
    const hotspots = Array.isArray(scene.hotspots) ? scene.hotspots : [];
    hotspots.forEach((h) => {
      const target = h && String(h.target || '').trim();
      if (target && !ids.has(target)) errors.push(`scene ${i + 1}: hotspot target "${target}" does not exist`);
    });
  });

  if (cfg.startScene && !ids.has(String(cfg.startScene))) errors.push('startScene does not match any scene id');

  return { ok: errors.length === 0, errors, value: { ...cfg, format, scenes } };
}

/* ------------------------------------------------------------------ */
/* Renderer selection                                                 */
/* ------------------------------------------------------------------ */

/**
 * Decide which renderer name to use for a viewer_type. Unknown types and
 * "none" fall through to "fallback" (gallery / floor plan / message).
 */
export function pickRenderer(viewerType) {
  return VIEWER_TYPES.includes(viewerType) && viewerType !== 'none' ? viewerType : 'fallback';
}

/**
 * Sandbox tokens for the embed iframe. Tours generally need scripts +
 * same-origin for their own players; we still deny top navigation & forms.
 */
export function embedSandbox() {
  return 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation allow-fullscreen';
}

export function embedAllow() {
  return 'fullscreen; xr-spatial-tracking; accelerometer; gyroscope; magnetometer; autoplay';
}

/* ------------------------------------------------------------------ */
/* DB row -> viewer view-model                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalise a DB row (typologies joined to properties) into the object the
 * component consumes. Tolerates snake_case DB rows and already-camelCased
 * objects, and parses viewer_config whether it is a JSON string or object.
 */
export function normalizeTypology(row) {
  const r = row && typeof row === 'object' ? row : {};
  let config = r.viewer_config ?? r.viewerConfig ?? null;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { config = null; }
  }
  const viewerType = VIEWER_TYPES.includes(r.viewer_type) ? r.viewer_type
    : VIEWER_TYPES.includes(r.viewerType) ? r.viewerType
    : 'none';
  return {
    typologyId: r.typology_id ?? r.typologyId ?? null,
    propertyId: r.property_id ?? r.propertyId ?? null,
    typeName: r.type_name ?? r.typeName ?? '',
    price: r.price ?? null,
    typology: r.typology ?? null,
    beds: r.beds ?? null,
    viewerType,
    viewerConfig: config && typeof config === 'object' ? config : emptyViewerConfig(viewerType),
    modelUrl: r.model_url ?? r.modelUrl ?? null,
    fallbackImageUrl: r.fallback_image_url ?? r.fallbackImageUrl ?? null,
  };
}

/**
 * Full validation of a stored typology row: returns ok only if the declared
 * viewer_type is valid AND its config validates. Otherwise the component
 * should render the fallback.
 */
export function validateTypology(row, opts = {}) {
  const vm = normalizeTypology(row);
  if (vm.viewerType === 'none') return { ok: true, errors: [], viewer: vm };
  const res = validateViewerConfig(vm.viewerType, vm.viewerConfig, opts);
  return { ok: res.ok, errors: res.errors, viewer: vm };
}

/* ------------------------------------------------------------------ */
/* Procedural floor plan                                              */
/* ------------------------------------------------------------------ */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function isHexColor(v) { return typeof v === 'string' && HEX_RE.test(v.trim()); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

export const FLOORPLAN_LIMITS = Object.freeze({
  maxStoreys: 5,
  maxRoomsPerStorey: 40,
  maxRoomsTotal: 120,
  maxDoors: 200,
  maxWindows: 300,
  maxExtent: 60,
  minRoom: 1,
  maxRoom: 40,
  minCeiling: 2.0,
  maxCeiling: 6,
});

const WALL_ALIASES = { n: 'north', s: 'south', e: 'east', w: 'west' };
function normWall(v) {
  const w = String(v || '').toLowerCase();
  return WALL_ALIASES[w] || (WALLS.includes(w) ? w : null);
}

/**
 * Validate + normalise a procedural floor plan (stored as typologies.viewer_config).
 * Returns clear, located error strings. Never throws.
 * @returns {{ok:boolean, errors:string[], value:object}}
 */
export function validateFloorPlan(input) {
  const errors = [];
  const value = {
    units: 'm', name: '', storeys: [],
    exterior: { wallColor: '#F0F0F0', roofType: 'flat', roofColor: '#303030', garden: false, fence: false, driveway: false },
  };
  if (!input || typeof input !== 'object') {
    errors.push('Floor plan must be a JSON object');
    return { ok: false, errors, value };
  }
  if (input.units != null && input.units !== 'm') errors.push('units: only "m" (metres) is supported');
  value.name = typeof input.name === 'string' ? input.name : '';

  const storeys = Array.isArray(input.storeys) ? input.storeys : [];
  if (storeys.length === 0) errors.push('Add at least one storey');
  if (storeys.length > FLOORPLAN_LIMITS.maxStoreys) errors.push(`Too many storeys (max ${FLOORPLAN_LIMITS.maxStoreys})`);

  let roomsTotal = 0, doorsTotal = 0, windowsTotal = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  storeys.forEach((st, si) => {
    const sp = `storey ${si + 1}`;
    if (!st || typeof st !== 'object') { errors.push(`${sp}: must be an object`); return; }
    const out = {
      name: typeof st.name === 'string' && st.name.trim() ? st.name.trim() : `Level ${si + 1}`,
      level: isNum(st.level) ? st.level : si,
      rooms: [], doors: [], windows: [], stairs: [],
    };

    const rooms = Array.isArray(st.rooms) ? st.rooms : [];
    if (rooms.length === 0) errors.push(`${sp}: add at least one room`);
    if (rooms.length > FLOORPLAN_LIMITS.maxRoomsPerStorey) errors.push(`${sp}: too many rooms (max ${FLOORPLAN_LIMITS.maxRoomsPerStorey})`);

    const seenNames = new Set();
    const rects = [];
    rooms.forEach((rm, ri) => {
      const rp = `${sp} room ${ri + 1}`;
      if (!rm || typeof rm !== 'object') { errors.push(`${rp}: must be an object`); return; }
      const name = String(rm.name || '').trim();
      if (!name) errors.push(`${rp}: missing name`);
      else if (seenNames.has(name.toLowerCase())) errors.push(`${rp}: duplicate room name "${name}"`);
      else seenNames.add(name.toLowerCase());

      let type = String(rm.type || 'other').toLowerCase();
      if (!ROOM_TYPES.includes(type)) type = 'other';

      const x = Number(rm.x), z = Number(rm.z), width = Number(rm.width), depth = Number(rm.depth);
      const geomOk = [x, z, width, depth].every(isNum);
      if (!geomOk) errors.push(`${rp} ("${name}"): x, z, width, depth must be numbers`);
      if (isNum(width) && (width < FLOORPLAN_LIMITS.minRoom || width > FLOORPLAN_LIMITS.maxRoom)) errors.push(`${rp} ("${name}"): width must be ${FLOORPLAN_LIMITS.minRoom}-${FLOORPLAN_LIMITS.maxRoom} m`);
      if (isNum(depth) && (depth < FLOORPLAN_LIMITS.minRoom || depth > FLOORPLAN_LIMITS.maxRoom)) errors.push(`${rp} ("${name}"): depth must be ${FLOORPLAN_LIMITS.minRoom}-${FLOORPLAN_LIMITS.maxRoom} m`);

      let ceiling = null;
      if (rm.ceiling != null) {
        ceiling = Number(rm.ceiling);
        if (!isNum(ceiling) || ceiling < FLOORPLAN_LIMITS.minCeiling || ceiling > FLOORPLAN_LIMITS.maxCeiling) {
          errors.push(`${rp} ("${name}"): ceiling must be ${FLOORPLAN_LIMITS.minCeiling}-${FLOORPLAN_LIMITS.maxCeiling} m`);
          ceiling = null;
        }
      }

      const room = { name, type, x: geomOk ? x : 0, z: geomOk ? z : 0, width: geomOk ? width : 1, depth: geomOk ? depth : 1, ceiling };
      out.rooms.push(room);
      roomsTotal++;
      if (geomOk) {
        rects.push(room);
        minX = Math.min(minX, x); minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x + width); maxZ = Math.max(maxZ, z + depth);
      }
    });

    // overlap (touching edges allowed)
    const eps = 0.05;
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        const A = rects[a], B = rects[b];
        if (A.x < B.x + B.width - eps && A.x + A.width > B.x + eps && A.z < B.z + B.depth - eps && A.z + A.depth > B.z + eps) {
          errors.push(`${sp}: rooms "${A.name}" and "${B.name}" overlap`);
        }
      }
    }

    // doors/windows: canonical form is room.doors[]/room.windows[]; a storey-level
    // array with a `room` field is also accepted and merged in.
    const openingsFor = (kind) => {
      const list = [];
      const storeyArr = Array.isArray(st[kind]) ? st[kind] : [];
      storeyArr.forEach((o) => list.push({ o, roomName: o && o.room }));
      rooms.forEach((raw, idx) => {
        const arr = raw && Array.isArray(raw[kind]) ? raw[kind] : [];
        arr.forEach((o) => list.push({ o, roomName: out.rooms[idx] && out.rooms[idx].name }));
      });
      return list;
    };

    for (const kind of ['doors', 'windows']) {
      const isDoor = kind === 'doors';
      openingsFor(kind).forEach(({ o, roomName }, oi) => {
        const op = `${sp} ${isDoor ? 'door' : 'window'} ${oi + 1}`;
        if (!o || typeof o !== 'object') { errors.push(`${op}: must be an object`); return; }
        let room = out.rooms.find((r) => r.name === String(roomName));
        if (!room && roomName != null && roomName !== '' && Number.isInteger(Number(roomName))) room = out.rooms[Number(roomName)];
        if (!room) { errors.push(`${op}: references unknown room "${roomName ?? ''}"`); return; }

        const wall = normWall(o.wall);
        if (!wall) { errors.push(`${op} ("${room.name}"): wall must be north/south/east/west`); return; }

        const position = Number(o.position), width = Number(o.width), height = Number(o.height);
        if (![position, width, height].every(isNum)) { errors.push(`${op} ("${room.name}"): position, width, height must be numbers`); return; }

        const wallLen = (wall === 'north' || wall === 'south') ? room.width : room.depth;
        const minW = isDoor ? 0.6 : 0.3, maxW = isDoor ? 3 : 6;
        const minH = isDoor ? 1.8 : 0.3, maxH = isDoor ? 3 : 4;
        if (width < minW || width > maxW) errors.push(`${op} ("${room.name}"): width must be ${minW}-${maxW} m`);
        if (height < minH || height > maxH) errors.push(`${op} ("${room.name}"): height must be ${minH}-${maxH} m`);
        if (position < 0 || position + width > wallLen + 0.01) errors.push(`${op} ("${room.name}"): does not fit on the ${wall} wall (length ${wallLen.toFixed(2)} m)`);

        const entry = { room: room.name, wall, position, width, height };
        if (isDoor) { doorsTotal++; }
        else {
          const sill = Number(o.sill == null ? 0.9 : o.sill);
          if (!isNum(sill) || sill < 0 || sill > 2.5) errors.push(`${op} ("${room.name}"): sill must be 0-2.5 m`);
          const ceil = room.ceiling == null ? 2.7 : room.ceiling;
          if (sill + height > ceil + 0.01) errors.push(`${op} ("${room.name}"): window top is above the ceiling`);
          entry.sill = isNum(sill) ? sill : 0.9;
          windowsTotal++;
        }
        out[kind].push(entry);
      });
    }

    // stairs
    (Array.isArray(st.stairs) ? st.stairs : []).forEach((sc, ci) => {
      const sp2 = `${sp} stairs ${ci + 1}`;
      if (!sc || typeof sc !== 'object') { errors.push(`${sp2}: must be an object`); return; }
      const x = Number(sc.x), z = Number(sc.z), width = Number(sc.width), depth = Number(sc.depth);
      if (![x, z, width, depth].every(isNum)) { errors.push(`${sp2}: x, z, width, depth must be numbers`); return; }
      if (width < 0.8 || width > 6) errors.push(`${sp2}: width must be 0.8-6 m`);
      if (depth < 0.8 || depth > 6) errors.push(`${sp2}: depth must be 0.8-6 m`);
      out.stairs.push({ x, z, width, depth, direction: sc.direction === 'down' ? 'down' : 'up', ...(isNum(Number(sc.to)) ? { to: Number(sc.to) } : {}) });
    });

    value.storeys.push(out);
  });

  if (roomsTotal > FLOORPLAN_LIMITS.maxRoomsTotal) errors.push(`Too many rooms in total (max ${FLOORPLAN_LIMITS.maxRoomsTotal})`);
  if (doorsTotal > FLOORPLAN_LIMITS.maxDoors) errors.push(`Too many doors (max ${FLOORPLAN_LIMITS.maxDoors})`);
  if (windowsTotal > FLOORPLAN_LIMITS.maxWindows) errors.push(`Too many windows (max ${FLOORPLAN_LIMITS.maxWindows})`);
  if (Number.isFinite(maxX) && (maxX - minX > FLOORPLAN_LIMITS.maxExtent || maxZ - minZ > FLOORPLAN_LIMITS.maxExtent)) {
    errors.push(`Floor plan footprint is too large (max ${FLOORPLAN_LIMITS.maxExtent} x ${FLOORPLAN_LIMITS.maxExtent} m)`);
  }

  const ex = input.exterior && typeof input.exterior === 'object' ? input.exterior : {};
  value.exterior = {
    wallColor: isHexColor(ex.wallColor) ? ex.wallColor : '#F0F0F0',
    roofType: ex.roofType === 'pitched' ? 'pitched' : 'flat',
    roofColor: isHexColor(ex.roofColor) ? ex.roofColor : '#303030',
    garden: !!ex.garden,
    fence: ex.fence === true ? '#909090' : (isHexColor(ex.fence) ? ex.fence : false),
    driveway: !!ex.driveway,
  };

  return { ok: errors.length === 0, errors, value };
}

/* ------------------------------------------------------------------ */
/* Selection order: real asset -> procedural -> image                 */
/* ------------------------------------------------------------------ */

function resolveTemplate(vm, opts) {
  if (typeof opts.resolveTemplate === 'function') {
    try { return opts.resolveTemplate(vm) || null; } catch { return null; }
  }
  return opts.template && typeof opts.template === 'object' ? opts.template : null;
}

/**
 * Build the ordered fallback chain for a typology.
 * Always ends with the static image candidate (never empty, never blank).
 * @returns {Array<{source:'real'|'procedural'|'image', kind:string, viewer:object, config:object, valid:boolean, errors:string[]}>}
 */
export function selectViewer(row, opts = {}) {
  const vm = normalizeTypology(row);
  const declared = vm.viewerType;
  const chain = [];
  const isReal = declared === 'embed' || declared === 'tour360' || declared === 'model3d' || declared === 'pointcloud';

  if (isReal) {
    const res = validateViewerConfig(declared, vm.viewerConfig, { allowList: opts.allowList });
    chain.push({ source: 'real', kind: declared, viewer: vm, config: res.value, valid: res.ok, errors: res.errors });
    const plan = resolveTemplate(vm, opts);
    if (plan) {
      const pres = validateViewerConfig('procedural', plan);
      chain.push({ source: 'procedural', kind: 'procedural', viewer: { ...vm, viewerConfig: pres.value }, config: pres.value, valid: pres.ok, errors: pres.errors, template: true });
    }
  } else if (declared === 'procedural') {
    const res = validateViewerConfig('procedural', vm.viewerConfig);
    chain.push({ source: 'procedural', kind: 'procedural', viewer: vm, config: res.value, valid: res.ok, errors: res.errors });
  }

  chain.push({
    source: 'image', kind: 'fallback', viewer: vm,
    config: vm.fallbackImageUrl ? { url: vm.fallbackImageUrl } : {}, valid: true, errors: [],
  });

  return chain;
}

/** First candidate in the chain that is structurally valid (used to pick the initial render). */
export function firstValidViewer(row, opts = {}) {
  return selectViewer(row, opts).find((c) => c.valid) || null;
}
