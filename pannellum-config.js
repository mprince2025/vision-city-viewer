/**
 * Property Viewer — pure Pannellum config builder.
 *
 * Kept free of DOM so it can be unit-tested in `node --test`. viewer.js is the
 * only consumer and provides the `assetUrl()` resolver (relative -> absolute).
 */

/**
 * Three.js CubeTextureLoader face order is [+X, -X, +Y, -Y, +Z, -Z].
 * Pannellum's cubemap order is [front, right, back, left, up, down], i.e.
 * [+Z, +X, -Z, -X, +Y, -Y]. This array maps each Pannellum slot to the
 * corresponding Three face index so the existing `face0..face5` captures can
 * be reused without re-exporting anything.
 */
export const THREE_TO_PANNELLUM_FACES = Object.freeze([4, 0, 5, 1, 2, 3]);

/**
 * Build the six face URLs for a cubemap scene.
 * @param {string} base e.g. "samples/tour/entry"
 * @param {{order?:'three'|'pannellum', ext?:string}} [opts]
 *   order 'three' (default) means base/face0..5 are in Three's order and are
 *   re-mapped to Pannellum's order; 'pannellum' means face0..5 are already in
 *   Pannellum's [front,right,back,left,up,down] order.
 */
export function cubemapFacesFromBase(base, opts = {}) {
  const clean = String(base || '').replace(/\/+$/, '');
  const ext = String(opts.ext || 'jpg').replace(/^\./, '');
  const slots = opts.order === 'pannellum' ? [0, 1, 2, 3, 4, 5] : THREE_TO_PANNELLUM_FACES;
  return slots.map((i) => `${clean}/face${i}.${ext}`);
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Convert a normalized tour360 typology into a Pannellum multi-scene config.
 * @param {object} typology normalized viewer ({viewerConfig:{format,scenes,startScene}})
 * @param {(p:string)=>string} assetUrl resolver for relative asset paths
 * @returns {{ok:boolean, config?:object, error?:string}}
 */
export function buildPannellumConfig(typology, assetUrl = (p) => p) {
  const cfg = (typology && typology.viewerConfig) || {};
  const format = cfg.format === 'equirect' ? 'equirect' : 'cubemap';
  const list = Array.isArray(cfg.scenes) ? cfg.scenes : [];
  if (!list.length) return { ok: false, error: 'No scenes configured' };

  const scenes = {};
  for (const sc of list) {
    const id = String(sc.id);
    const scene = {
      title: sc.name || id,
      type: format === 'equirect' ? 'equirectangular' : 'cubemap',
    };

    if (format === 'equirect') {
      if (!sc.panorama) return { ok: false, error: `Scene "${id}" has no panorama` };
      scene.panorama = assetUrl(sc.panorama);
    } else if (Array.isArray(sc.cubeFaces) && sc.cubeFaces.length === 6) {
      scene.cubeMap = sc.cubeFaces.map((f) => assetUrl(f));
    } else if (sc.base) {
      scene.cubeMap = cubemapFacesFromBase(sc.base, { order: sc.order, ext: sc.ext }).map(assetUrl);
    } else {
      return { ok: false, error: `Scene "${id}" has no cubemap faces or base path` };
    }

    const hotspots = Array.isArray(sc.hotspots) ? sc.hotspots : [];
    if (hotspots.length) {
      scene.hotSpots = hotspots.map((h) => {
        const spot = {
          type: 'scene',
          sceneId: String(h.target),
          pitch: toNumber(h.pitch),
          yaw: toNumber(h.yaw),
          text: h.label || '',
          cssClass: 'pv-hotspot',
        };
        // Pannellum aims the destination scene along targetYaw/targetPitch when
        // the hotspot is clicked, so arriving always faces the travel direction
        // instead of inheriting the previous scene's heading.
        if (h.id != null) spot.id = String(h.id);
        if (h.targetYaw != null) spot.targetYaw = toNumber(h.targetYaw);
        if (h.targetPitch != null) spot.targetPitch = toNumber(h.targetPitch);
        if (h.targetHfov != null) spot.targetHfov = toNumber(h.targetHfov);
        return spot;
      });
    }

    if (sc.hfov != null) scene.hfov = toNumber(sc.hfov, undefined);
    if (sc.pitch != null) scene.pitch = toNumber(sc.pitch);
    if (sc.yaw != null) scene.yaw = toNumber(sc.yaw);
    if (sc.vaov != null) scene.vaov = toNumber(sc.vaov);
    if (sc.haov != null) scene.haov = toNumber(sc.haov);

    scenes[id] = scene;
  }

  const firstScene = cfg.startScene && scenes[cfg.startScene] ? String(cfg.startScene) : list[0].id;

  return {
    ok: true,
    config: {
      default: {
        firstScene: String(firstScene),
        sceneFadeDuration: 800,
        autoLoad: true,
        showControls: true,
        compass: false,
        showFullscreenCtrl: true,
        mouseZoom: true,
        keyboardZoom: true,
        // The viewer binds the arrow keys itself (left/right step between
        // scenes, up/down look around), so Pannellum's own key panning is off.
        disableKeyboardCtrl: true,
        crossOrigin: 'anonymous',
        backgroundColor: [13, 15, 18],
      },
      scenes,
    },
  };
}
