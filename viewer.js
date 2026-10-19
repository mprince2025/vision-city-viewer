/**
 * Property Viewer — single component that renders one of the viewer kinds
 * (embed / tour360 / model3d / pointcloud / procedural) with a graceful
 * fallback. Phase 1: standalone.
 *
 * Usage:
 *   import { createPropertyViewer } from './viewer.js';
 *   const pv = createPropertyViewer(document.getElementById('host'), {
 *     assetBase: '',            // optional prefix for relative asset paths
 *     allowList: DEFAULT_EMBED_HOSTS, // iframe host allow-list
 *     lowBandwidth: false,      // show a poster instead of loading 3D/tour
 *     fallbackImages: [],       // extra gallery images if config has no fallback
 *     onReady: (kind) => {},    // called once a renderer mounts
 *     onError: (err) => {},     // called when a renderer fails + falls back
 *   });
 *   pv.render(typologyRow);     // typologyRow can be a DB row or normalised
 *   pv.destroy();
 *
 * No CDN: Pannellum + Three.js are loaded lazily from ./vendor/ (relative to
 * this module) only when the corresponding renderer is needed.
 */

import {
  embedSandbox, embedAllow, normalizeTypology, selectViewer, VIEWER_TYPES,
} from './validation.js';
import { buildPannellumConfig } from './pannellum-config.js';
import { getTemplate } from './seed-templates.js';
import { generateFloorPlan } from './floorplan.js';
import { detectPointCloudFormat, parseXYZ, subsample, computeBounds, robustBounds, colorByHeight } from './pointcloud.js';
import { createControlBar } from './control-bar.js';

export const PROPERTY_VIEWER_VERSION = '1.0.0-phase1';

const DEFAULT_LIB_BASE = new URL('./vendor/', import.meta.url).href;
const XR_ALLOWED = typeof navigator !== 'undefined' && 'xr' in navigator;

/* ------------------------------------------------------------------ */
/* tiny DOM helpers                                                   */
/* ------------------------------------------------------------------ */

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function hasWebGL() {
  if (typeof document === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* styles (injected once)                                             */
/* ------------------------------------------------------------------ */

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('pv-styles')) return;
  const css = `
  .pv-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:320px;
    background:#0d0f12;color:#f4f6f8;border-radius:12px;overflow:hidden;
    font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .pv-root:fullscreen{border-radius:0;min-height:0}
  .pv-toolbar{display:flex;align-items:center;gap:8px;height:44px;padding:0 10px;flex:0 0 auto;
    background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.08);z-index:3}
  .pv-toolbar .pv-label{font-weight:600;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pv-toolbar .pv-badge{font-size:11px;opacity:.7;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:1px 8px}
  .pv-toolbar .pv-spacer{flex:1}
  .pv-btn{appearance:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:inherit;
    border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer;white-space:nowrap}
  .pv-btn:hover{background:rgba(255,255,255,.14)}
  .pv-btn:focus-visible{outline:2px solid #6cf;outline-offset:2px}
  .pv-stage{position:relative;flex:1 1 auto;min-height:0;background:#0d0f12}
  .pv-fill{position:absolute;inset:0;width:100%;height:100%}
  .pv-stage canvas{display:block;width:100%!important;height:100%!important}
  .pv-stage iframe{border:0}
  .pv-status{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:4;max-width:90%;
    background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px 14px;
    font-size:12.5px;display:flex;align-items:center;gap:9px;transition:opacity .25s}
  .pv-status[hidden]{display:none}
  .pv-status.is-error{background:rgba(70,18,18,.82);border-color:rgba(255,120,120,.4)}
  .pv-spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.28);
    border-top-color:#fff;animation:pv-spin .8s linear infinite;flex:0 0 auto}
  @keyframes pv-spin{to{transform:rotate(360deg)}}
  .pv-fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:12px;text-align:center;padding:22px}
  .pv-fallback-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.55}
  .pv-fallback-card{position:relative;z-index:1;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.14);
    border-radius:12px;padding:16px 20px;max-width:420px}
  .pv-fallback-gallery{position:relative;z-index:1;display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
  .pv-fallback-gallery img{width:108px;height:72px;object-fit:cover;border-radius:8px;border:1px solid rgba(255,255,255,.15)}
  .pv-poster{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
  .pv-poster img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.5}
  .pv-poster .pv-btn{position:relative;z-index:2}
  .pv-hotspot{width:30px;height:30px;background-color:rgba(20,120,220,.85);border:2px solid #fff;border-radius:50%;
    box-shadow:0 2px 10px rgba(0,0,0,.55);transition:background-color .15s,box-shadow .15s}
  .pv-hotspot:hover{background-color:rgba(40,160,255,.98);box-shadow:0 0 0 5px rgba(40,160,255,.3),0 2px 10px rgba(0,0,0,.55)}
  .pv-hotspot::after{content:'';position:absolute;left:50%;top:50%;width:0;height:0;
    border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:9px solid #fff;
    transform:translate(-50%,-45%) rotate(90deg)}
  .pv-tour-nav{position:absolute;right:14px;bottom:14px;z-index:4;display:flex;align-items:center;gap:6px;
    background:rgba(10,12,15,.66);border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:4px 6px;
    backdrop-filter:blur(4px)}
  .pv-tour-nav .pv-tour-pos{color:#cfe0f2;font-size:12px;min-width:46px;text-align:center;font-variant-numeric:tabular-nums}
  .pv-tour-nav .pv-btn{padding:4px 9px;font-size:13px;line-height:1}
  .pv-tour-map{position:absolute;left:14px;bottom:14px;z-index:4;background:rgba(10,12,15,.66);
    border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:6px;backdrop-filter:blur(4px);
    pointer-events:none}
  .pv-tour-map canvas{display:block;border-radius:6px;cursor:pointer;pointer-events:auto}
  `;
  const s = document.createElement('style');
  s.id = 'pv-styles';
  s.textContent = css;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* lazy library loading                                               */
/* ------------------------------------------------------------------ */

const libCache = new Map(); // libBase -> Promise<pannellum>

function loadPannellum(libBase) {
  if (libCache.has(libBase)) return libCache.get(libBase);
  const p = new Promise((resolve, reject) => {
    if (window.pannellum) return resolve(window.pannellum);
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('pannellum/pannellum.css', libBase).href;
    document.head.appendChild(css);
    const script = document.createElement('script');
    script.src = new URL('pannellum/pannellum.js', libBase).href;
    script.onload = () => (window.pannellum ? resolve(window.pannellum) : reject(new Error('Pannellum failed to initialise')));
    script.onerror = () => reject(new Error('Could not load Pannellum'));
    document.head.appendChild(script);
  });
  libCache.set(libBase, p);
  return p;
}

async function loadThree(libBase) {
  const [THREE, gltf, orbitMod] = await Promise.all([
    import(new URL('three.module.js', libBase).href),
    import(new URL('addons/GLTFLoader.js', libBase).href),
    import(new URL('addons/OrbitControls.js', libBase).href),
  ]);
  return { THREE, GLTFLoader: gltf.GLTFLoader, OrbitControls: orbitMod.OrbitControls };
}

/** Just the PLY loader (point clouds) from the same vendored addons. */
async function loadPlyLoader(libBase) {
  const m = await import(new URL('addons/PLYLoader.js', libBase).href);
  return m.PLYLoader;
}

/** Which 3D mesh loader to use: 'gltf' (glb/gltf, default), 'obj' or 'stl'. */
function modelFormat(cfg) {
  const f = String((cfg && cfg.format) || '').toLowerCase();
  if (f === 'obj' || f === 'stl' || f === 'gltf' || f === 'glb') return f === 'glb' ? 'gltf' : f;
  const url = String((cfg && cfg.url) || '').toLowerCase().split(/[?#]/)[0];
  if (url.endsWith('.obj')) return 'obj';
  if (url.endsWith('.stl')) return 'stl';
  return 'gltf';
}

/* ------------------------------------------------------------------ */
/* component                                                          */
/* ------------------------------------------------------------------ */

export class PropertyViewer {
  constructor(host, options = {}) {
    if (!host || !host.nodeType) throw new Error('PropertyViewer needs a host element');
    this.host = host;
    this.options = { ...options };
    this.libBase = (options.libBase ? String(options.libBase) : DEFAULT_LIB_BASE);
    if (!/\/$/.test(this.libBase)) this.libBase += '/';
    this.viewer = null;
    this.row = null;
    this.activeKind = null;
    this.lowBandwidth = !!options.lowBandwidth;
    this._disposers = [];
    this._destroyed = false;
    this._root = null;
    this._pannellum = null;
    this._three = null;
    this._tour3d = null;
    this._overview = null;
    this._tourMode = 'walk';
    this._modeDisposers = [];
    this._modeMount = null;
    this._pendingStart = null;
    this._suppressModeCb = false;
  }

  setLowBandwidth(flag) {
    this.lowBandwidth = !!flag;
    if (this.row) this.render(this.row);
  }

  /** Render a typology (DB row or normalised object). */
  render(row) {
    ensureStyles();
    this.destroy();
    this._destroyed = false;
    this.row = row;

    const chain = selectViewer(row, {
      allowList: this.options.allowList,
      resolveTemplate: (vm) => this._resolveTemplate(vm),
    });
    const pick = chain.find((c) => c.valid) || chain[chain.length - 1];
    this.chain = chain;
    this._pick = pick;

    const base = pick.viewer || normalizeTypology(row);
    this.viewer = {
      ...base,
      viewerType: pick.source === 'image' ? 'none' : pick.kind,
      viewerConfig: pick.config || {},
    };
    this._errors = pick.errors || [];
    const invalid = chain.find((c) => !c.valid && c.errors && c.errors.length);
    this._fallbackReason = pick.source === 'image' && invalid ? invalid.errors[0] : this._errors[0] || null;

    this._buildShell(this.viewer);

    const kind = pick.kind;
    if (pick.source === 'image' || !VIEWER_TYPES.includes(kind)) {
      return this._renderFallback(this._fallbackReason);
    }
    if (this.lowBandwidth && kind !== 'embed') {
      return this._renderPoster(kind);
    }
    return this._dispatch(kind);
  }

  _resolveTemplate(vm) {
    const custom = this.options.resolveTemplate;
    if (typeof custom === 'function') return custom(vm) || null;
    if (this.options.template && typeof this.options.template === 'object') return this.options.template;
    if (vm && vm.typology) return getTemplate(vm.typology, vm.beds);
    return null;
  }

  setTypology(row) {
    return this.render(row);
  }

  destroy() {
    this._destroyed = true;
    this._resetMode();
    for (const fn of this._disposers.reverse()) {
      try { fn(); } catch { /* ignore */ }
    }
    this._disposers = [];
    this._pannellum = null;
    this._three = null;
    this._tour3d = null;
    this._overview = null;
    this._tourMode = 'walk';
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
    this._stage = null;
    this._statusEl = null;
    this._toolbar = null;
    this.activeKind = null;
  }

  /* ------------------------------ shell ------------------------------ */

  _buildShell(viewer) {
    this._label = el('span', { class: 'pv-label' }, this._labelText(viewer));
    this._badge = el('span', { class: 'pv-badge' }, this._badgeText(viewer.viewerType));
    const spacer = el('span', { class: 'pv-spacer' });
    const fsBtn = el('button', { class: 'pv-btn', type: 'button', title: 'Toggle fullscreen' }, '⛶ Fullscreen');
    fsBtn.addEventListener('click', () => this._toggleFullscreen());
    this._toolbar = el('div', { class: 'pv-toolbar' }, this._label, this._badge, spacer, fsBtn);
    this._stage = el('div', { class: 'pv-stage' });
    this._statusEl = el('div', { class: 'pv-status', role: 'status', 'aria-live': 'polite', hidden: true });
    const children = [this._stage, this._statusEl];
    this._root = el('div', { class: 'pv-root' }, ...children);
    this.host.appendChild(this._root);
  }

  _labelText(viewer) {
    return viewer.typeName ? `Property ${viewer.typeName}` : 'Property preview';
  }
  _badgeText(t) {
    return {
      embed: 'Live embed', tour360: '360° tour', model3d: '3D model',
      pointcloud: 'Point cloud', procedural: 'Concept model', none: 'Gallery', fallback: 'Gallery',
    }[t] || '';
  }

  _setStatus(msg, { spinner = false, error = false } = {}) {
    if (!this._statusEl) return;
    this._statusEl.hidden = false;
    this._statusEl.classList.toggle('is-error', !!error);
    this._statusEl.textContent = '';
    if (spinner) this._statusEl.appendChild(el('span', { class: 'pv-spin' }));
    this._statusEl.appendChild(document.createTextNode(msg));
  }
  _clearStatus() {
    if (this._statusEl) this._statusEl.hidden = true;
  }

  _assetUrl(p) {
    const s = String(p == null ? '' : p);
    if (!s) return s;
    if (/^blob:/i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('/') || s.startsWith('//')) return s;
    return (this.options.assetBase || '') + s;
  }

  _dispose(fn) {
    this._disposers.push(fn);
  }

  _toggleFullscreen() {
    if (!this._root) return;
    if (document.fullscreenElement === this._root) document.exitFullscreen();
    else if (this._root.requestFullscreen) this._root.requestFullscreen().catch(() => {});
  }

  toggleFullscreen() { this._toggleFullscreen(); }

  /**
   * Which view modes this viewer can offer. Only tour360 walk-throughs (which
   * carry real sweep positions + the merged cloud) expose the mode pill; other
   * viewer kinds return [] so the pill hides and only title/share/menu/book show.
   */
  _availableModes(kind) {
    if (kind !== 'tour360') return [];
    const cfg = (this.viewer && this.viewer.viewerConfig) || {};
    if (!cfg.walk) return [];   // plain Pannellum tour: no dollhouse/plan/measure
    const hasCloud = !!(cfg.cloud && cfg.cloud.url);
    return [
      { id: 'dollhouse', available: hasCloud },
      { id: 'plan', available: hasCloud && ((cfg.minimap && cfg.minimap.length >= 2) || !!(cfg.scenes && cfg.scenes.length)) },
      { id: 'walk', available: true },
      { id: 'measure', available: hasCloud },
    ];
  }

  _activeMode(kind) {
    if (kind !== 'tour360') return null;
    const avail = this._availableModes(kind);
    const want = this._tourMode || 'walk';
    return (avail.find((m) => m.id === want && m.available !== false) || avail.find((m) => m.id === 'walk') || {}).id || 'walk';
  }

  /**
   * Switch view mode (walk / dollhouse / plan / measure) for a tour360
   * walk-through. Unlike a full _dispatch, this tears down ONLY the current
   * mode renderer and mounts the next one, so the control chrome (auto-hide
   * state, menus) survives and we don't leak WebGL contexts across switches.
   */
  _setMode(mode) {
    if (this.activeKind !== 'tour360') return;
    const avail = this._availableModes('tour360');
    const m = avail.find((x) => x.id === mode);
    if (!m || m.available === false) return;
    if (mode === this._tourMode && this._modeMount) return;   // already there
    this._tourMode = mode;
    this._resetMode();
    this._renderTourMode();
    if (this._controls && this._controls.setMode) {
      // Update the pill's active state WITHOUT feeding back into _setMode
      // (the bar calls onMode on host-initiated changes too).
      this._suppressModeCb = true;
      try { this._controls.setMode(mode); } finally { this._suppressModeCb = false; }
    }
  }

  /** Flush mode-scoped disposers and remove the current mode mount. */
  _resetMode() {
    for (const fn of this._modeDisposers.reverse()) { try { fn(); } catch { /* ignore */ } }
    this._modeDisposers = [];
    if (this._modeMount && this._modeMount.parentNode) this._modeMount.parentNode.removeChild(this._modeMount);
    this._modeMount = null;
    this._tour3d = null;
    this._overview = null;
  }

  /** Mode-scoped disposer: flushed on the next mode switch or destroy(). */
  _modeDispose(fn) {
    this._modeDisposers.push(fn);
  }

  /** Render whichever tour360 view mode is currently selected. */
  _renderTourMode() {
    const mode = this._activeMode('tour360');
    if (mode === 'walk') return this._renderTour3D();
    return this._renderOverview(mode);
  }

  /**
   * Dollhouse / floor-plan / measure over the merged metric point cloud.
   * Requires `viewer_config.cloud` (set by the scan decoder); without it the
   * control pill hides these modes, so reaching here means data is present.
   */
  async _renderOverview(mode) {
    const rid = this._rid;
    const cfg = this.viewer.viewerConfig || {};
    if (!cfg.cloud || !cfg.cloud.url) return this._renderFallback('This view needs the scan point cloud');
    if (!hasWebGL()) return this._renderFallback('3D views need WebGL, which this device/browser does not support');
    this._setStatus(`Loading ${mode === 'plan' ? 'floor plan' : mode === 'measure' ? 'measure' : 'dollhouse'}…`, { spinner: true });
    let THREE, PLYLoader;
    try {
      ({ THREE } = await loadThree(this.libBase));
      PLYLoader = await loadPlyLoader(this.libBase);
    } catch (e) {
      if (this._stale(rid)) return;
      return this._fail(e);
    }
    if (this._stale(rid)) return;

    const mount = el('div', { class: 'pv-fill' });
    this._stage.appendChild(mount);
    this._modeMount = mount;

    let ov;
    try {
      const mod = await import('./overview-3d.js');
      if (this._stale(rid)) return;
      ov = await mod.createOverview({
        THREE,
        PLYLoader,
        container: mount,
        cloud: cfg.cloud,
        walk: cfg.walk || {},
        minimap: Array.isArray(cfg.minimap) ? cfg.minimap : [],
        scenes: Array.isArray(cfg.scenes) ? cfg.scenes : [],
        mode,
        resolveUrl: (u) => this._assetUrl(u),
        onJump: (id) => this._jumpToSweep(id),
        onMeasure: (count, dist) => {
          if (this._controls && this._controls.showToast) {
            this._controls.showToast(count < 2 ? 'Tap a second point' : `Distance: ${dist.toFixed(2)} m`);
          }
        },
        onReady: () => { if (this._stale(rid)) return; this._clearStatus(); this._notifyReady('tour360'); },
        onError: (e) => { if (this._stale(rid)) return; this._fail(e); },
      });
    } catch (e) {
      mount.remove();
      if (this._modeMount === mount) this._modeMount = null;
      if (this._stale(rid)) return;
      return this._fail(e);
    }
    if (this._stale(rid)) { try { ov.dispose(); } catch { /* ignore */ } return; }
    this._overview = ov;
    this._modeDispose(() => { this._overview = null; try { ov.dispose(); } catch { /* ignore */ } });
  }

  /** Jump the walk-through to a given sweep (used by the floor-plan dots). */
  _jumpToSweep(id) {
    this._pendingStart = id;
    this._setMode('walk');
    this._pendingStart = null;
  }

  /**
   * Mount the Vision City control chrome (overlay) for the active viewer.
   * Reads `viewer_config.ui` for per-control toggles; anything without data
   * hides itself. Additive — it never touches the renderers.
   */
  _mountControls(kind) {
    if (this.options.controls === false) return;
    const cfg = (this.viewer && this.viewer.viewerConfig) || {};
    if (cfg.ui && cfg.ui.controls === false) return;
    const stage = this._stage;
    const modes = this._availableModes(kind);
    let bar;
    try {
      bar = createControlBar({
        stage,
        viewer: this.viewer,
        viewerConfig: cfg,
        kind,
        modes,
        activeMode: this._activeMode(kind),
        isFullscreen: () => document.fullscreenElement === this._root,
        onMode: (m) => { if (this._suppressModeCb) return; this._setMode(m); },
        onFullscreen: () => this._toggleFullscreen(),
        onVR: () => this._enterVR(),
        onBook: () => {
          if (typeof this.options.onBook === 'function') { this.options.onBook(this.viewer); return; }
          if (this._root) this._root.dispatchEvent(new CustomEvent('pv:book', { detail: { viewer: this.viewer }, bubbles: true }));
          if (this._controls && this._controls.showToast) this._controls.showToast('Booking opens here');
        },
        onQuality: (q) => this.setLowBandwidth(q === 'low'),
      });
    } catch { return; }
    if (!bar) return;
    this._controls = bar;
    this._dispose(() => {
      this._controls = null;
      try { bar.dispose(); } catch { /* ignore */ }
    });
  }

  /** Enter WebXR immersive-vision on the live model renderer, if present. */
  _enterVR() {
    if (this._root) this._root.dispatchEvent(new CustomEvent('pv:vr', { detail: { viewer: this.viewer }, bubbles: true }));
    if (this._controls && this._controls.showToast) this._controls.showToast('Preparing VR…');
  }

  _fail(err) {
    const msg = err && err.message ? err.message : String(err || 'Preview unavailable');
    if (typeof this.options.onError === 'function') this.options.onError(err);
    this._renderFallback(msg);
  }

  /* A render started later reuses this viewer instance: render() flips
     _destroyed back to false, so a load that was still in flight for the
     PREVIOUS file would pass a plain `this._destroyed` check. Callbacks capture
     the render id and drop out when it no longer matches. */
  _stale(rid) {
    return this._destroyed || rid !== this._rid;
  }

  /* --------------------------- dispatchers --------------------------- */

  _dispatch(kind) {
    if (this._destroyed) return;
    this._rid = (this._rid || 0) + 1;
    this._stage.textContent = '';
    this._modeDisposers = [];
    this._modeMount = null;
    this._tourMode = 'walk';
    this.activeKind = kind;
    this._mountControls(kind);
    try {
      if (kind === 'embed') return this._renderEmbed();
      if (kind === 'tour360') return this._renderTour360();
      if (kind === 'model3d') return this._renderModel3d();
      if (kind === 'pointcloud') return this._renderPointCloud();
      if (kind === 'procedural') return this._renderProcedural();
    } catch (e) {
      this._fail(e);
    }
    return this._renderFallback(null);
  }

  _notifyReady(kind) {
    if (typeof this.options.onReady === 'function') this.options.onReady(kind);
  }

  /* ------------------------------ embed ------------------------------ */

  _renderEmbed() {
    const cfg = this.viewer.viewerConfig || {};
    const url = cfg.url;
    if (!url) return this._renderFallback('No embed URL configured');

    this._setStatus('Loading embedded tour…', { spinner: true });
    const iframe = el('iframe', {
      class: 'pv-fill',
      src: url,
      title: cfg.title || 'Property tour',
      loading: 'lazy',
      referrerpolicy: 'no-referrer',
      allow: embedAllow(),
      allowfullscreen: true,
      sandbox: embedSandbox(),
      style: cfg.aspect ? `aspect-ratio:${cfg.aspect}` : '',
    });
    iframe.addEventListener('load', () => this._clearStatus());
    this._stage.appendChild(iframe);
    this._dispose(() => iframe.remove());
    this._notifyReady('embed');
  }

  /* ----------------------------- tour360 ----------------------------- */

  /**
   * Walk-through 360 tour (multi-sweep scans): the Three.js viewer in tour3d.js.
   * Free look, tap-to-walk on the floor and a gliding cross-fade transition.
   */
  async _renderTour3D() {
    const rid = this._rid;
    this._setStatus('Loading 360° walk-through…', { spinner: true });
    let THREE;
    try {
      ({ THREE } = await loadThree(this.libBase));
    } catch (e) {
      if (this._stale(rid)) return;
      return this._fail(e);
    }
    if (this._stale(rid)) return;

    const mount = el('div', { class: 'pv-fill' });
    this._stage.appendChild(mount);
    this._modeMount = mount;

    let tour;
    try {
      const mod = await import('./tour3d.js');
      if (this._stale(rid)) return;
      tour = await mod.createTour3D({
        THREE,
        container: mount,
        config: this.viewer.viewerConfig,
        resolveUrl: (u) => this._assetUrl(u),
        startScene: this._pendingStart,
        onReady: () => { if (this._stale(rid)) return; this._pendingStart = null; this._clearStatus(); this._notifyReady('tour360'); },
        onError: (e) => { if (this._stale(rid)) return; this._fail(e); },
      });
    } catch (e) {
      mount.remove();
      if (this._modeMount === mount) this._modeMount = null;
      if (this._stale(rid)) return;
      return this._fail(e);
    }
    if (this._stale(rid)) { try { tour.dispose(); } catch { /* ignore */ } return; }
    this._tour3d = tour;
    this._modeDispose(() => {
      this._tour3d = null;
      try { tour && tour.dispose(); } catch { /* ignore */ }
    });
  }

  async _renderTour360() {
    const rid = this._rid;
    if (!hasWebGL()) return this._renderFallback('360° tours need WebGL, which this device/browser does not support');
    // Multi-sweep scans carry `walk` data (sweep positions + floor). Those use
    // the Three.js walk viewer: Pannellum cannot glide the camera between
    // panoramas or put markers on the floor. Plain config tours keep Pannellum.
    if (this.viewer.viewerConfig && this.viewer.viewerConfig.walk) return this._renderTourMode();
    const built = buildPannellumConfig(this.viewer, (p) => this._assetUrl(p));
    if (!built.ok) return this._renderFallback(built.error);

    this._setStatus('Loading 360° tour…', { spinner: true });
    let pannellum;
    try {
      pannellum = await loadPannellum(this.libBase);
    } catch (e) {
      if (this._stale(rid)) return;
      return this._fail(e);
    }
    if (this._stale(rid)) return;

    const mount = el('div', { class: 'pv-fill' });
    this._stage.appendChild(mount);
    try {
      this._pannellum = pannellum.viewer(mount, built.config);
      this._pannellum.on('load', () => { if (this._stale(rid)) return; this._clearStatus(); this._notifyReady('tour360'); });
      this._pannellum.on('error', () => { if (this._stale(rid)) return; this._clearStatus(); });
    } catch (e) {
      return this._fail(e);
    }

    // Floor-plan minimap: one dot per sweep; clicking a dot jumps to that scene.
    const sceneList = (this.viewer.viewerConfig && this.viewer.viewerConfig.scenes) || [];
    const order = sceneList.map((s) => String(s.id));
    let navPos = null;
    let mm = null;

    const step = (dir) => {
      if (!this._pannellum || order.length < 2) return;
      let i = order.indexOf(this._pannellum.getScene());
      if (i < 0) i = 0;
      const nextId = order[(i + dir + order.length) % order.length];
      try { this._pannellum.loadScene(nextId); } catch { /* ignore */ }
    };
    const refreshPos = () => {
      if (!this._pannellum || !navPos) return;
      const i = order.indexOf(this._pannellum.getScene());
      navPos.textContent = i >= 0 ? `${i + 1} / ${order.length}` : '';
    };
    const refreshActive = () => {
      if (!this._pannellum) return;
      if (mm) mm.setActive(this._pannellum.getScene());
      refreshPos();
    };
    this._tourStep = step;

    const mapDots = this.viewer.viewerConfig && this.viewer.viewerConfig.minimap;
    if (Array.isArray(mapDots) && mapDots.length >= 2) {
      mm = this._tourMinimap(mapDots, built.config.default.firstScene,
        () => (this._pannellum ? this._pannellum.getYaw() : 0));
      this._stage.appendChild(mm.wrap);
      this._dispose(() => mm.wrap.remove());
    }
    try { this._pannellum.on('scenechange', () => { if (this._stale(rid)) return; refreshActive(); }); } catch { /* older Pannellum */ }

    // Prev/next buttons plus a live "sweep n / N" readout, bottom-right.
    if (order.length >= 2) {
      const nav = el('div', { class: 'pv-tour-nav' });
      const prev = el('button', { class: 'pv-btn', type: 'button', title: 'Previous sweep (←)', 'aria-label': 'Previous sweep' }, '‹');
      const next = el('button', { class: 'pv-btn', type: 'button', title: 'Next sweep (→)', 'aria-label': 'Next sweep' }, '›');
      navPos = el('span', { class: 'pv-tour-pos' });
      prev.addEventListener('click', () => step(-1));
      next.addEventListener('click', () => step(1));
      nav.append(prev, navPos, next);
      this._stage.appendChild(nav);
      this._dispose(() => nav.remove());
    }
    refreshActive();

    // Arrow keys step between sweeps (left/right) and look up/down.
    const onKey = (ev) => {
      if (this._destroyed || !this._pannellum) return;
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
      else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        const d = ev.key === 'ArrowUp' ? 6 : -6;
        this._pannellum.setPitch(Math.max(-90, Math.min(90, this._pannellum.getPitch() + d)), 180);
      }
    };
    document.addEventListener('keydown', onKey);
    this._dispose(() => document.removeEventListener('keydown', onKey));

    // Live view cone on the minimap: a rAF pass that only redraws on movement.
    if (mm) {
      let raf = 0;
      let last = NaN;
      const tick = () => {
        if (this._destroyed || !this._pannellum) return;
        const y = this._pannellum.getYaw();
        if (!(Math.abs(y - last) < 0.5)) { last = y; mm.setView(y); }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      this._dispose(() => cancelAnimationFrame(raf));
    }

    this._dispose(() => {
      this._tourStep = null;
      try { this._pannellum && this._pannellum.destroy(); } catch { /* ignore */ }
      mount.remove();
    });
  }

  /**
   * Build the clickable floor-plan minimap for a multi-sweep tour.
   * `dots` are `{id,name,x,y,heading}` in metres (Z-up; `heading` is the sweep
   * camera's world heading in degrees). Clicking a dot loads its scene; the
   * active dot grows a cone showing where the viewer is currently looking.
   * @param {Array} dots
   * @param {string} startId
   * @param {() => number} [getYaw] live Pannellum yaw (degrees) for the cone
   * @returns {{wrap:HTMLElement, setActive:(id:string)=>void, setView:(yaw:number)=>void}}
   */
  _tourMinimap(dots, startId, getYaw = () => 0) {
    const W = 168;
    const H = 168;
    const pad = 20;
    const wrap = el('div', { class: 'pv-tour-map' });
    const canvas = el('canvas', { width: W, height: H, style: `width:${W}px;height:${H}px` });
    wrap.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const xs = dots.map((d) => Number(d.x) || 0);
    const ys = dots.map((d) => Number(d.y) || 0);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
    // World x -> right, world y -> up (flip the canvas axis).
    const toPx = (d) => [pad + ((Number(d.x) || 0) - minX) * scale, H - pad - ((Number(d.y) || 0) - minY) * scale];

    let active = startId;
    let viewYaw = 0;
    const CONE = 0.55; // half-angle, radians (~31°)
    const CONE_R = 15;

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(10,12,15,.55)';
      ctx.fillRect(0, 0, W, H);
      // The sweeps in manifest order trace the rough path through the property.
      ctx.strokeStyle = 'rgba(140,180,230,.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      dots.forEach((d, i) => { const [px, py] = toPx(d); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke();
      // View cone: the sweep's world heading turned by the viewer's live yaw.
      const act = dots.find((d) => d.id === active);
      if (act) {
        const [px, py] = toPx(act);
        // World heading (CCW from +X) -> canvas angle (y flipped).
        const cAng = -(((Number(act.heading) || 0) + viewYaw) * Math.PI / 180);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.arc(px, py, CONE_R, cAng - CONE, cAng + CONE);
        ctx.closePath();
        ctx.fillStyle = 'rgba(108,204,255,.4)';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + CONE_R * Math.cos(cAng), py + CONE_R * Math.sin(cAng));
        ctx.strokeStyle = 'rgba(108,204,255,.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      for (const d of dots) {
        const [px, py] = toPx(d);
        ctx.beginPath();
        ctx.arc(px, py, d.id === active ? 6.5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = d.id === active ? '#6cf' : 'rgba(255,255,255,.78)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0d0f12';
        ctx.stroke();
      }
    };
    draw();

    canvas.addEventListener('click', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = (ev.clientX - rect.left) * (W / (rect.width || W));
      const my = (ev.clientY - rect.top) * (H / (rect.height || H));
      let best = null;
      let bestD = 20;
      for (const d of dots) {
        const [px, py] = toPx(d);
        const dist = Math.hypot(px - mx, py - my);
        if (dist < bestD) { bestD = dist; best = d; }
      }
      if (best && this._pannellum) {
        active = best.id;
        draw();
        try { this._pannellum.loadScene(best.id); } catch { /* ignore */ }
      }
    });

    return {
      wrap,
      setActive: (id) => { if (id !== active) { active = id; draw(); } },
      setView: (yaw) => {
        const y = Number(yaw);
        if (!Number.isFinite(y)) return;
        viewYaw = y;
        draw();
      },
      getView: getYaw,
    };
  }

  /* ----------------------------- model3d ----------------------------- */

  async _renderModel3d() {
    const rid = this._rid;
    if (!hasWebGL()) return this._renderFallback('3D models need WebGL, which this device/browser does not support');
    const cfg = this.viewer.viewerConfig || {};
    if (!cfg.url) return this._renderFallback('No model URL configured');

    this._setStatus('Loading 3D model…', { spinner: true });
    let THREE, GLTFLoader, OrbitControls;
    try {
      ({ THREE, GLTFLoader, OrbitControls } = await loadThree(this.libBase));
    } catch (e) {
      if (this._stale(rid)) return;
      return this._fail(e);
    }
    if (this._stale(rid)) return;

    const width = this._stage.clientWidth || this.host.clientWidth || 640;
    const height = this._stage.clientHeight || this.host.clientHeight || 360;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0f12);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x33364a, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(3, 6, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.7);
    rim.position.set(-4, 2, -5);
    scene.add(rim);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 5000);
    camera.position.set(2.2, 1.6, 2.6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = !!cfg.autoRotate;
    controls.autoRotateSpeed = 1.4;
    controls.minDistance = 0.05;

    this._stage.appendChild(renderer.domElement);

    let frame = null;
    const onResize = () => {
      const w = this._stage.clientWidth;
      const h = this._stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(this._stage);

    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      if (!XR_ALLOWED) frame = requestAnimationFrame(loop);
    };

    const disposeModel = () => {
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose && o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose && m[k].dispose();
            m.dispose && m.dispose();
          });
        }
      });
      controls.dispose && controls.dispose();
      renderer.dispose && renderer.dispose();
      renderer.domElement.remove();
      if (ro) ro.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
      if (XR_ALLOWED) renderer.setAnimationLoop(null);
    };
    this._dispose(disposeModel);

    const fmt = modelFormat(cfg);
    const assetUrl = this._assetUrl(cfg.url);

    let finish;
    const startLoad = () => {
      const onProgress = (evt) => {
        if (this._stale(rid)) return;
        if (evt && evt.total) {
          const pct = Math.min(100, Math.round((evt.loaded / evt.total) * 100));
          this._setStatus(`Loading 3D model… ${pct}%`, { spinner: true });
        }
      };
      const onError = (err) => {
        if (this._stale(rid)) return;
        this._fail(err instanceof Error ? err : new Error('The 3D model could not be loaded'));
      };
      if (fmt === 'obj') {
        import(new URL('addons/OBJLoader.js', this.libBase).href).then((m) => {
          if (this._stale(rid)) return;
          new m.OBJLoader().load(assetUrl, (obj) => finish(obj), onProgress, onError);
        }).catch(onError);
      } else if (fmt === 'stl') {
        import(new URL('addons/STLLoader.js', this.libBase).href).then((m) => {
          if (this._stale(rid)) return;
          new m.STLLoader().load(assetUrl, (geometry) => {
            if (this._stale(rid)) return;
            if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
            const mat = new THREE.MeshStandardMaterial({ color: 0xc2c8d0, metalness: 0.15, roughness: 0.75 });
            finish(new THREE.Mesh(geometry, mat));
          }, onProgress, onError);
        }).catch(onError);
      } else {
        const loader = new GLTFLoader();
        Promise.resolve()
          .then(async () => {
            if (cfg.draco !== false) {
              try {
                const dracoMod = await import(new URL('addons/DRACOLoader.js', this.libBase).href);
                const draco = new dracoMod.DRACOLoader();
                draco.setDecoderPath(new URL('draco/gltf/', this.libBase).href);
                loader.setDRACOLoader(draco);
                this._dispose(() => draco.dispose && draco.dispose());
              } catch { /* Draco optional */ }
            }
            try {
              const meshoptMod = await import(new URL('meshopt_decoder.module.js', this.libBase).href);
              const meshopt = meshoptMod.MeshoptDecoder || meshoptMod.default;
              if (meshopt) loader.setMeshoptDecoder(meshopt);
            } catch { /* meshopt optional */ }
            if (this._stale(rid)) return;
            loader.load(assetUrl, (gltf) => {
              if (this._stale(rid)) return;   // already disposed by the next render
              finish(gltf.scene || gltf.scenes[0]);
            }, onProgress, onError);
          });
      }
    };

    finish = (model) => {
      if (this._stale(rid)) return;
      if (!model) return this._fail(new Error('The 3D model contained nothing to display'));
      const s = Number(cfg.scale) || 1;
      model.scale.setScalar(s);
      scene.add(model);

      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const fitDist = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360)) || maxDim;
      camera.position.set(fitDist * 0.9, fitDist * 0.55, fitDist * 1.15);
      controls.target.set(0, 0, 0);
      controls.minDistance = maxDim * 0.2;
      controls.maxDistance = maxDim * 8;
      controls.update();

      this._clearStatus();
      this._notifyReady('model3d');

      if (cfg.xr !== false && XR_ALLOWED) {
        renderer.xr.enabled = true;
        import(new URL('addons/VRButton.js', this.libBase).href).then((m) => {
          if (this._stale(rid)) return;
          try {
            const btn = m.VRButton.createButton(renderer);
            btn.classList.add('pv-btn');
            if (this._toolbar) this._toolbar.insertBefore(btn, this._toolbar.lastElementChild);
          } catch { /* xr button optional */ }
        }).catch(() => {});
        renderer.setAnimationLoop(loop);
      } else {
        loop();
      }
    };

    startLoad();
  }

  /* --------------------------- point cloud --------------------------- */

  async _renderPointCloud() {
    const rid = this._rid;
    if (!hasWebGL()) return this._renderFallback('Point clouds need WebGL, which this device/browser does not support');
    const cfg = this.viewer.viewerConfig || {};
    if (!cfg.url) return this._renderFallback('No point-cloud URL configured');

    const format = cfg.format && cfg.format !== 'auto'
      ? cfg.format
      : (detectPointCloudFormat(cfg.url) || detectPointCloudFormat(this.viewer.typeName) || 'xyz');

    this._setStatus('Loading point cloud…', { spinner: true });
    let THREE, OrbitControls, PLYLoader;
    try {
      const t = await loadThree(this.libBase);
      THREE = t.THREE; OrbitControls = t.OrbitControls;
      if (format === 'ply') {
        const m = await import(new URL('addons/PLYLoader.js', this.libBase).href);
        PLYLoader = m.PLYLoader;
      }
    } catch (e) {
      if (this._stale(rid)) return;
      return this._fail(e);
    }
    if (this._stale(rid)) return;

    const width = this._stage.clientWidth || this.host.clientWidth || 640;
    const height = this._stage.clientHeight || this.host.clientHeight || 360;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const bg = typeof cfg.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(cfg.background.trim()) ? cfg.background.trim() : 0x0d0f12;
    scene.background = new THREE.Color(bg);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 100000);
    camera.position.set(4, 3, 5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = !!cfg.autoRotate;
    controls.autoRotateSpeed = 1.2;

    this._stage.appendChild(renderer.domElement);

    let frame = null;
    const onResize = () => {
      const w = this._stage.clientWidth;
      const h = this._stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(this._stage);

    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };

    const disposeCloud = () => {
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose && o.geometry.dispose();
        if (o.material) o.material.dispose && o.material.dispose();
      });
      controls.dispose && controls.dispose();
      renderer.dispose && renderer.dispose();
      renderer.domElement.remove();
      if (ro) ro.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
    };
    this._dispose(disposeCloud);

    const finish = (positions, colors) => {
      if (this._stale(rid)) return;
      if (!positions || positions.length < 3) return this._fail(new Error('The point cloud had no points'));

      // Frame and colour on a percentile box, not min/max: a scan's stray far
      // returns would otherwise inflate the bounding box, pull the camera back
      // and shrink the real geometry to a small blob amid scattered dots.
      const bounds = robustBounds(positions);
      const c = bounds.center;
      const arr = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        arr[i] = positions[i] - c[0];
        arr[i + 1] = positions[i + 1] - c[1];
        arr[i + 2] = positions[i + 2] - c[2];
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));

      let vertexColors = false;
      if (cfg.colorMode === 'height') {
        geom.setAttribute('color', new THREE.BufferAttribute(colorByHeight(arr, bounds), 3));
        vertexColors = true;
      } else if (cfg.colorMode !== 'uniform' && colors && colors.length === positions.length) {
        geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        vertexColors = true;
      }

      const pointSize = cfg.pointSize && cfg.pointSize > 0 ? cfg.pointSize : Math.max(bounds.maxDim / 700, 0.004);
      const mat = new THREE.PointsMaterial({ size: pointSize, sizeAttenuation: true, vertexColors });
      if (!vertexColors) mat.color = new THREE.Color(0xdfe6ee);

      scene.add(new THREE.Points(geom, mat));

      const d = bounds.maxDim || 1;
      const ic = cfg.initialCamera;
      if (ic && Array.isArray(ic.position) && Array.isArray(ic.target)) {
        // Position the camera inside the scan (at the first sweep), looking
        // horizontally. The geometry is already centred on `c`, so subtract it.
        camera.position.set(ic.position[0] - c[0], ic.position[1] - c[1], ic.position[2] - c[2]);
        controls.target.set(ic.target[0] - c[0], ic.target[1] - c[1], ic.target[2] - c[2]);
      } else {
        camera.position.set(d * 0.6, d * 0.45, d * 0.8);
        controls.target.set(0, 0, 0);
      }
      camera.near = d / 1000;
      camera.far = d * 100;
      camera.updateProjectionMatrix();
      controls.minDistance = d * 0.05;
      controls.maxDistance = d * 6;
      controls.update();

      this._clearStatus();
      this._notifyReady('pointcloud');
      loop();
    };

    if (format === 'ply') {
      const loader = new PLYLoader();
      loader.load(
        this._assetUrl(cfg.url),
        (geometry) => {
          if (this._stale(rid)) return;   // already disposed by the next render
          const pos = geometry.getAttribute('position');
          const col = geometry.getAttribute('color');
          const sub = subsample(pos ? pos.array : null, col ? col.array : null, Number(cfg.maxPoints) || 1500000);
          finish(sub.positions, sub.colors);
        },
        undefined,
        (err) => {
          if (this._stale(rid)) return;
          this._fail(err instanceof Error ? err : new Error('The point cloud could not be loaded'));
        }
      );
    } else {
      fetch(this._assetUrl(cfg.url))
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then((text) => {
          if (this._stale(rid)) return;
          const res = parseXYZ(text, { maxPoints: Number(cfg.maxPoints) || 1500000 });
          if (!res.ok) throw new Error(res.error || 'The point cloud could not be parsed');
          finish(res.positions, res.colors);
        })
        .catch((err) => {
          if (this._stale(rid)) return;
          this._fail(err instanceof Error ? err : new Error('The point cloud could not be loaded'));
        });
    }
  }

  /* --------------------------- procedural --------------------------- */

  async _renderProcedural() {
    const rid = this._rid;
    if (!hasWebGL()) {
      return this._renderFallback('The 3D concept model needs WebGL, which this device/browser does not support');
    }
    const gen = generateFloorPlan(this.viewer.viewerConfig || {});
    if (!gen.ok) return this._renderFallback(gen.errors[0] || 'The floor plan could not be generated');

    this._setStatus('Building concept model…', { spinner: true });
    let mod;
    try {
      mod = await import('./procedural-viewer.js');
    } catch (e) {
      if (this._stale(rid)) return;
      return this._fail(e);
    }
    if (this._stale(rid)) return;

    try {
      this._proc = mod.createProceduralController(this._stage, gen.scene, {
        textures: this.options.textures !== false,
        minimap: this.options.minimap !== false,
        hotspots: this.options.hotspots !== false,
        labels: this.options.labels !== false,
        initialMode: this.options.proceduralMode === 'dollhouse' ? 'dollhouse' : 'walk',
        onReady: () => { this._clearStatus(); this._notifyReady('procedural'); },
        onRoom: (name) => { if (typeof this.options.onRoom === 'function') this.options.onRoom(name); },
        onMode: (m) => { if (typeof this.options.onMode === 'function') this.options.onMode(m); },
      });
    } catch (e) {
      return this._fail(e);
    }
    this._dispose(() => {
      try { this._proc && this._proc.dispose(); } catch { /* ignore */ }
      this._proc = null;
    });
    this._addProcControls();
  }

  _addProcControls() {
    const dl = el('button', { class: 'pv-btn', type: 'button', title: 'Download this concept model as .glb' }, '⬇ .glb');
    dl.addEventListener('click', async () => {
      try {
        const glb = await this._proc.captureGlb();
        this._download(glb, `${(this.viewer.typeName || 'concept-model').replace(/\s+/g, '-').toLowerCase()}.glb`);
      } catch {
        this._setStatus('Could not export the .glb', { error: true });
        setTimeout(() => this._clearStatus(), 2500);
      }
    });
    this._toolbar.insertBefore(dl, this._toolbar.lastElementChild);
    this._dispose(() => dl.remove());

    if (XR_ALLOWED && this.options.xr !== false) {
      import(new URL('addons/VRButton.js', this.libBase).href).then((m) => {
        try {
          const btn = m.VRButton.createButton(this._proc.renderer);
          btn.classList.add('pv-btn');
          this._toolbar.insertBefore(btn, this._toolbar.lastElementChild);
          this._dispose(() => btn.remove());
        } catch { /* xr button optional */ }
      }).catch(() => {});
    }
  }

  _download(data, filename) {
    const blob = new Blob([data], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ----------------------------- fallback ---------------------------- */

  _renderFallback(message) {
    if (!this._stage) return;
    this._stage.textContent = '';
    this.activeKind = 'fallback';
    const fb = this.viewer ? this.viewer.fallbackImageUrl : null;
    const wrap = el('div', { class: 'pv-fallback' });
    if (fb) wrap.appendChild(el('img', { class: 'pv-fallback-img', src: this._assetUrl(fb), alt: '' }));
    const card = el('div', { class: 'pv-fallback-card' });
    card.appendChild(el('div', { style: 'font-weight:600;margin-bottom:4px' }, 'Preview unavailable'));
    if (message) card.appendChild(el('div', { style: 'opacity:.8;font-size:12.5px' }, message));
    wrap.appendChild(card);

    const gallery = Array.isArray(this.options.fallbackImages) ? this.options.fallbackImages.filter(Boolean) : [];
    if (gallery.length) {
      const g = el('div', { class: 'pv-fallback-gallery' });
      gallery.forEach((src) => g.appendChild(el('img', { src: this._assetUrl(src), alt: '' })));
      wrap.appendChild(g);
    }
    this._stage.appendChild(wrap);
    this._clearStatus();
    this._notifyReady('fallback');
  }

  _renderPoster(kind) {
    this.activeKind = 'poster';
    const src = this._posterSrc();
    const poster = el('div', { class: 'pv-poster' });
    if (src) poster.appendChild(el('img', { src: this._assetUrl(src), alt: '' }));
    const btn = el('button', { class: 'pv-btn', type: 'button' },
      kind === 'model3d' ? 'Load 3D model' : kind === 'procedural' ? 'Build concept model' : 'Load 360° tour');
    btn.addEventListener('click', () => this._dispatch(kind));
    poster.appendChild(btn);
    this._stage.appendChild(poster);
  }

  _posterSrc() {
    if (this.viewer && this.viewer.fallbackImageUrl) return this.viewer.fallbackImageUrl;
    const cfg = (this.viewer && this.viewer.viewerConfig) || {};
    const first = Array.isArray(cfg.scenes) && cfg.scenes[0] ? cfg.scenes[0] : null;
    if (!first) return null;
    if (cfg.format === 'equirect') return first.panorama || null;
    if (Array.isArray(first.cubeFaces) && first.cubeFaces[0]) return first.cubeFaces[0];
    if (first.base) return `${first.base.replace(/\/+$/, '')}/face0.${(first.ext || 'jpg').replace(/^\./, '')}`;
    return null;
  }
}

export function createPropertyViewer(host, options) {
  return new PropertyViewer(host, options);
}

export default createPropertyViewer;
