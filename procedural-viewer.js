/**
 * Property Viewer — procedural viewer *controller* (DOM + WebGL).
 *
 * Wraps procedural-scene.js with a Three.js renderer and two ways to explore a
 * "concept model": a dollhouse orbit view (with roof toggle + floor filter) and
 * a first-person walkthrough (WASD + mouse-lock on desktop, joystick + drag on
 * touch) with wall collision. Adds room hotspot labels, a live minimap, WebXR
 * when available, and GLB export for managers.
 *
 * Loaded lazily by viewer.js (dynamic import) so viewer.js stays DOM-only.
 */

import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/addons/OrbitControls.js';
import { buildProceduralScene, setStoreyVisibility, disposeObject, minimapRooms } from './procedural-scene.js';
import { collisionSegments, resolveMove, storeyBounds, DEFAULTS } from './floorplan.js';

const EYE_HEIGHT = 1.62;
const WALK_SPEED = 3.1;
const RUN_SPEED = 5.0;
const LOOK_SENS = 0.0025;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const ROOM_FILL = {
  living: '#e7dfd2', dining: '#e2d6c4', kitchen: '#cfd3d6', bathroom: '#c9d6dd',
  bedroom: '#e9e4dc', hall: '#dcdcdc', garage: '#b9bcbf', stairs: '#c9c9c9',
  utility: '#c9c9c9', study: '#ded6c6', balcony: '#cddcc9', closet: '#d6d6d6', other: '#dcdcdc',
};

function ensureProcStyles() {
  if (typeof document === 'undefined' || document.getElementById('pv-proc-styles')) return;
  const s = document.createElement('style');
  s.id = 'pv-proc-styles';
  s.textContent = `
  .pv-proc-ui{position:absolute;inset:0;z-index:3;pointer-events:none}
  .pv-proc-bar{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);display:flex;gap:8px;
    align-items:center;pointer-events:auto;background:rgba(14,17,21,.74);backdrop-filter:blur(10px);
    border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:6px 8px;box-shadow:0 10px 30px rgba(0,0,0,.5);
    max-width:calc(100% - 24px);overflow:auto}
  .pv-seg{display:flex;gap:2px;background:rgba(255,255,255,.08);border-radius:999px;padding:2px;flex:0 0 auto}
  .pv-seg-btn{appearance:none;border:0;background:transparent;color:inherit;border-radius:999px;padding:7px 15px;
    font:inherit;font-weight:600;letter-spacing:.2px;cursor:pointer;white-space:nowrap}
  .pv-seg-btn:hover{background:rgba(255,255,255,.1)}
  .pv-seg-btn.is-on{background:#eaf2f8;color:#0d1216}
  .pv-ctl{appearance:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;
    border-radius:999px;padding:7px 12px;font:inherit;cursor:pointer;white-space:nowrap}
  .pv-ctl:hover{background:rgba(255,255,255,.14)}
  .pv-ctl.is-on{background:rgba(108,204,255,.26);border-color:rgba(108,204,255,.55)}
  .pv-proc-bar select{appearance:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);
    color:inherit;border-radius:999px;padding:7px 12px;font:inherit;cursor:pointer;white-space:nowrap}
  .pv-proc-bar select option{color:#111}
  .pv-proc-help{position:absolute;right:16px;bottom:22px;pointer-events:none;font-size:12px;opacity:.62;
    text-shadow:0 1px 3px rgba(0,0,0,.9)}
  .pv-minimap{position:absolute;left:16px;bottom:18px;pointer-events:none;background:rgba(10,12,15,.66);
    border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:6px;backdrop-filter:blur(6px)}
  .pv-minimap canvas{display:block;border-radius:8px}
  .pv-hotspot-label{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;
    background:rgba(20,24,30,.82);color:#eef4f9;border:1px solid rgba(255,255,255,.35);border-radius:999px;
    padding:3px 10px;font:11.5px/1.3 system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.5);
    backdrop-filter:blur(4px)}
  .pv-hotspot-label:hover{background:rgba(108,204,255,.9);color:#06202f}
  .pv-joystick{position:absolute;left:20px;bottom:20px;width:112px;height:112px;border-radius:50%;
    border:2px solid rgba(255,255,255,.3);background:rgba(255,255,255,.06);pointer-events:auto;touch-action:none}
  .pv-joystick .pv-knob{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;
    border-radius:50%;background:rgba(255,255,255,.5)}
  @media (max-width:640px){ .pv-minimap{display:none} .pv-proc-help{display:none} }
  `;
  document.head.appendChild(s);
}

function mkEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class ProceduralController {
  constructor(stage, sceneDesc, opts = {}) {
    ensureProcStyles();
    this.stage = stage;
    this.sceneDesc = sceneDesc;
    this.opts = opts;
    this.disposed = false;

    this.built = buildProceduralScene(sceneDesc, { textures: opts.textures !== false });
    this.scene = new THREE.Scene();
    const sky = (sceneDesc.exterior && sceneDesc.exterior.sky) || '#cdd6e0';
    this.scene.background = new THREE.Color(sky);
    this.scene.add(this.built.root);

    const span = this.built.span;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    stage.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.05, span * 40);
    this.camera.rotation.order = 'YXZ';

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 0.9;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.mode = 'dollhouse';
    this.storey = null;              // null = all storeys (dollhouse)
    this.yaw = 0;
    this.pitch = 0;
    this.player = { x: 0, z: 0 };
    this.radius = DEFAULTS.playerRadius;
    this.keys = Object.create(null);
    this.joystick = { x: 0, z: 0, active: false, id: null };
    this._listeners = [];

    this._buildUi();
    this._bindEvents();
    this.setMode(opts.initialMode === 'walk' ? 'walk' : 'dollhouse', { silent: true });
    this.resize();
    this._last = performance.now();
    this._frame = requestAnimationFrame(this._tick);
    if (typeof opts.onReady === 'function') opts.onReady(this);
  }

  /* ------------------------------ UI ------------------------------ */

  _buildUi() {
    this.ui = mkEl('div', 'pv-proc-ui');
    this.bar = mkEl('div', 'pv-proc-bar');

    this.seg = mkEl('div', 'pv-seg');
    this.btnInside = mkEl('button', 'pv-seg-btn', 'Inside');
    this.btnDoll = mkEl('button', 'pv-seg-btn', 'Dollhouse');
    this.btnInside.type = this.btnDoll.type = 'button';
    this.btnInside.addEventListener('click', () => this.setMode('walk'));
    this.btnDoll.addEventListener('click', () => this.setMode('dollhouse'));
    this.seg.append(this.btnInside, this.btnDoll);

    this.floorSel = document.createElement('select');
    this.floorSel.title = 'Floor';
    this.floorSel.addEventListener('change', () => {
      const v = this.floorSel.value;
      this.setStorey(v === '' ? null : Number(v));
    });

    this.btnLabels = mkEl('button', 'pv-ctl', 'Labels');
    this.btnLabels.type = 'button';
    this.btnLabels.addEventListener('click', () => this.toggleLabels());

    this.btnRoof = mkEl('button', 'pv-ctl', 'Roof');
    this.btnRoof.type = 'button';
    this.btnRoof.addEventListener('click', () => this.toggleRoof());

    this.bar.append(this.seg, this.floorSel, this.btnLabels, this.btnRoof);

    this.help = mkEl('div', 'pv-proc-help', '');
    this.ui.append(this.bar, this.help);

    if (this.opts.minimap !== false) {
      this.minimapWrap = mkEl('div', 'pv-minimap');
      this.minimap = document.createElement('canvas');
      this.minimap.width = 150;
      this.minimap.height = 150;
      this.minimap.style.width = '150px';
      this.minimap.style.height = '150px';
      this.minimapWrap.appendChild(this.minimap);
      this.mctx = this.minimap.getContext('2d');
      this.ui.appendChild(this.minimapWrap);
    }

    this.labels = mkEl('div', 'pv-proc-labels');
    this.ui.appendChild(this.labels);

    this._buildJoystick();
    this.stage.appendChild(this.ui);
    this.labelsOn = this.opts.labels !== false;
    this._refreshFloorOptions();
  }

  _buildJoystick() {
    this.stick = mkEl('div', 'pv-joystick');
    this.knob = mkEl('div', 'pv-knob');
    this.stick.appendChild(this.knob);
    this.stick.hidden = true;
    this.ui.appendChild(this.stick);
  }

  _refreshFloorOptions() {
    const prev = this.floorSel.value;
    this.floorSel.textContent = '';
    if (this.mode === 'dollhouse') {
      const all = document.createElement('option');
      all.value = '';
      all.textContent = 'All floors';
      this.floorSel.appendChild(all);
    }
    this.sceneDesc.storeys.forEach((st) => {
      const o = document.createElement('option');
      o.value = String(st.index);
      o.textContent = st.name || `Floor ${st.index + 1}`;
      this.floorSel.appendChild(o);
    });
    if (this.mode === 'walk' && this.storey == null) this.floorSel.value = '0';
    else this.floorSel.value = prev && [...this.floorSel.options].some((o) => o.value === prev) ? prev : (this.mode === 'walk' ? '0' : '');
  }

  _setActiveButtons() {
    this.btnInside.classList.toggle('is-on', this.mode === 'walk');
    this.btnDoll.classList.toggle('is-on', this.mode === 'dollhouse');
    this.btnRoof.hidden = this.mode !== 'dollhouse';
    this.btnRoof.textContent = this.built.roofGroup.visible ? 'Roof' : 'Roof off';
    this.btnRoof.classList.toggle('is-on', !this.built.roofGroup.visible);
    this.btnLabels.classList.toggle('is-on', this.labelsOn);
  }

  toggleLabels(force) {
    this.labelsOn = force != null ? !!force : !this.labelsOn;
    if (!this.labelsOn) this.labels.textContent = '';
    this._setActiveButtons();
  }

  /* ---------------------------- modes ---------------------------- */

  setMode(mode, { silent = false } = {}) {
    if (mode !== 'walk' && mode !== 'dollhouse') return;
    this.mode = mode;
    this._refreshFloorOptions();
    if (mode === 'dollhouse') {
      this.controls.enabled = true;
      this.stick.hidden = true;
      this._exitPointerLock();
      setStoreyVisibility(this.built.storeyGroups, this.storey);
      this._fitDollhouse();
      this.help.textContent = 'Drag to orbit · scroll to zoom';
      if (this.built.roofGroup) this.built.roofGroup.visible = this._roofPreferred ?? true;
    } else {
      this.controls.enabled = false;
      this._exitPointerLock();
      const idx = this.storey == null ? 0 : this.storey;
      this.storey = idx;
      this._refreshFloorOptions();
      this.floorSel.value = String(idx);
      setStoreyVisibility(this.built.storeyGroups, idx);
      this._spawnInStorey(idx);
      this._updateMobileUi();
      this.help.textContent = 'Click to look · WASD to move';
      if (this.built.roofGroup) this.built.roofGroup.visible = false;
    }
    this._setActiveButtons();
    if (!silent && typeof this.opts.onMode === 'function') this.opts.onMode(mode);
  }

  setStorey(index) {
    if (index != null) index = clamp(Math.round(index), 0, this.sceneDesc.storeys.length - 1);
    this.storey = index;
    if (this.mode === 'dollhouse') {
      setStoreyVisibility(this.built.storeyGroups, index);
    } else {
      const idx = index == null ? 0 : index;
      this.storey = idx;
      setStoreyVisibility(this.built.storeyGroups, idx);
      this._spawnInStorey(idx);
      this.floorSel.value = String(idx);
    }
  }

  toggleRoof(force) {
    const next = force != null ? !!force : !this.built.roofGroup.visible;
    this._roofPreferred = next;
    this.built.roofGroup.visible = next;
    this._setActiveButtons();
  }

  /* --------------------------- dollhouse --------------------------- */

  _fitDollhouse() {
    const b = this.built.bounds;
    const top = b.top || 3;
    const span = this.built.span;
    const dist = Math.max(span, top) * 1.9;
    this.camera.position.set(b.minX + span * 1.15, top * 1.15 + span * 0.75, b.maxZ + span * 1.15);
    this.controls.target.set((b.minX + b.maxX) / 2, top * 0.35, (b.minZ + b.maxZ) / 2);
    this.controls.minDistance = span * 0.12;
    this.controls.maxDistance = span * 8;
    this.controls.update();
  }

  /* ---------------------------- walkthrough ---------------------------- */

  _spawnInStorey(index) {
    const st = this.sceneDesc.storeys[index];
    if (!st) return;
    const room = st.rooms.slice().sort((a, b) => b.width * b.depth - a.width * a.depth)[0];
    this.player.x = room ? room.cx : 0;
    this.player.z = room ? room.cz : 0;
    this._segments = collisionSegments(this.sceneDesc, index);
    this._walkBounds = storeyBounds(this.sceneDesc, index);
    this.yaw = -Math.PI / 2;
    this.pitch = -0.05;
  }

  _updateMobileUi() {
    const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    this.stick.hidden = !(this.mode === 'walk' && touch);
  }

  /* ---------------------------- events ---------------------------- */

  _bindEvents() {
    const add = (t, e, fn, o) => { t.addEventListener(e, fn, o); this._listeners.push([t, e, fn, o]); };

    add(window, 'keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
      if (this.mode === 'walk' && ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
    });
    add(window, 'keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });

    add(this.canvas, 'pointerdown', (e) => {
      if (this.mode !== 'walk' || e.pointerType === 'touch') return;
      if (document.pointerLockElement !== this.canvas && this.canvas.requestPointerLock) this.canvas.requestPointerLock();
    });
    add(document, 'pointerlockchange', () => {
      if (document.pointerLockElement !== this.canvas && this.mode === 'walk') this.help.textContent = 'Click the view to capture the mouse • WASD to move';
    });
    add(document, 'mousemove', (e) => {
      if (this.mode !== 'walk' || document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * LOOK_SENS;
      this.pitch = clamp(this.pitch - e.movementY * LOOK_SENS, -1.2, 1.2);
    });

    // touch look on the canvas
    this._touchLook = null;
    add(this.canvas, 'touchstart', (e) => {
      if (this.mode !== 'walk') return;
      const t = e.changedTouches[0];
      if (t) this._touchLook = { id: t.identifier, x: t.clientX, y: t.clientY };
    }, { passive: true });
    add(this.canvas, 'touchmove', (e) => {
      if (this.mode !== 'walk' || !this._touchLook) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== this._touchLook.id) continue;
        this.yaw -= (t.clientX - this._touchLook.x) * 0.005;
        this.pitch = clamp(this.pitch - (t.clientY - this._touchLook.y) * 0.005, -1.2, 1.2);
        this._touchLook = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
    }, { passive: true });
    add(this.canvas, 'touchend', () => { this._touchLook = null; }, { passive: true });

    this._bindJoystick(add);
    add(window, 'resize', () => this.resize());
    add(document, 'fullscreenchange', () => this.resize());

    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    if (this._ro) this._ro.observe(this.stage);
  }

  _bindJoystick(add) {
    const rectOf = () => this.stick.getBoundingClientRect();
    const setKnob = (dx, dy) => { this.knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const handle = (t) => {
      const r = rectOf();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = t.clientX - cx, dy = t.clientY - cy;
      const max = r.width / 2 - 8;
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, max / len);
      dx *= k; dy *= k;
      setKnob(dx, dy);
      this.joystick.x = dx / max;
      this.joystick.z = -dy / max;
    };
    add(this.stick, 'touchstart', (e) => { this.joystick.active = true; this.joystick.id = e.changedTouches[0].identifier; handle(e.changedTouches[0]); e.preventDefault(); }, { passive: false });
    add(this.stick, 'touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === this.joystick.id) { handle(t); e.preventDefault(); }
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) if (t.identifier === this.joystick.id) {
        this.joystick = { x: 0, z: 0, active: false, id: null };
        setKnob(0, 0);
      }
    };
    add(this.stick, 'touchend', end, { passive: true });
    add(this.stick, 'touchcancel', end, { passive: true });
  }

  _exitPointerLock() {
    if (document.pointerLockElement === this.canvas && document.exitPointerLock) document.exitPointerLock();
  }

  /* ---------------------------- frame loop ---------------------------- */

  _tick = (now) => {
    if (this.disposed) return;
    const dt = Math.min(0.05, (now - this._last) / 1000 || 0);
    this._last = now;
    if (this.mode === 'dollhouse') {
      this.controls.update();
    } else {
      this._stepWalk(dt);
    }
    this.renderer.render(this.scene, this.camera);
    this._updateLabels();
    this._drawMinimap();
    this._frame = requestAnimationFrame(this._tick);
  };

  _stepWalk(dt) {
    const k = this.keys;
    let f = (k['w'] || k['arrowup'] ? 1 : 0) - (k['s'] || k['arrowdown'] ? 1 : 0);
    let s = (k['d'] || k['arrowright'] ? 1 : 0) - (k['a'] || k['arrowleft'] ? 1 : 0);
    f += this.joystick.z;
    s += this.joystick.x;
    if (f === 0 && s === 0) { this._applyCamera(); return; }
    const len = Math.hypot(f, s) || 1;
    f /= len; s /= len;
    const speed = (k['shift'] ? RUN_SPEED : WALK_SPEED) * dt;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const dx = (-sin * f + cos * s) * speed;
    const dz = (-cos * f - sin * s) * speed;
    const moved = resolveMove(this._segments || [], this.player, { x: this.player.x + dx, z: this.player.z + dz }, this.radius);
    const b = this._walkBounds || { minX: -999, maxX: 999, minZ: -999, maxZ: 999 };
    this.player.x = clamp(moved.x, b.minX + this.radius, b.maxX - this.radius);
    this.player.z = clamp(moved.z, b.minZ + this.radius, b.maxZ - this.radius);
    this._applyCamera();
  }

  _applyCamera() {
    const st = this.sceneDesc.storeys[this.storey == null ? 0 : this.storey];
    const floorY = st ? st.floorY : 0;
    this.camera.position.set(this.player.x, floorY + EYE_HEIGHT, this.player.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  /* ---------------------------- hotspots ---------------------------- */

  _updateLabels() {
    if (this.opts.hotspots === false || this.labelsOn === false) return;
    const w = this.stage.clientWidth || 1;
    const h = this.stage.clientHeight || 1;
    const vec = new THREE.Vector3();
    const activeStorey = this.mode === 'walk' ? (this.storey == null ? 0 : this.storey) : this.storey;
    const walkSt = this.sceneDesc.storeys[activeStorey];
    for (const anchor of this.built.hotspotObjects) {
      let el = anchor.userData._label;
      const onStorey = activeStorey == null || anchor.userData.storey === activeStorey;
      let show = onStorey;
      if (show && this.mode === 'walk' && walkSt) {
        const dist = Math.hypot(anchor.position.x - this.player.x, anchor.position.z - this.player.z);
        show = dist < 9;
      }
      if (!show) { if (el) el.style.display = 'none'; continue; }
      if (!el) {
        el = mkEl('div', 'pv-hotspot-label', anchor.userData.label);
        anchor.userData._label = el;
        el.addEventListener('click', () => this.focusRoom(anchor.userData.room));
        this.labels.appendChild(el);
      }
      vec.copy(anchor.position).project(this.camera);
      if (vec.z > 1) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.left = `${(vec.x * 0.5 + 0.5) * w}px`;
      el.style.top = `${(-vec.y * 0.5 + 0.5) * h}px`;
    }
  }

  focusRoom(name) {
    const anchor = this.built.hotspotObjects.find((a) => a.userData.room === name);
    if (!anchor) return;
    if (this.mode === 'dollhouse') {
      this.controls.target.lerp(new THREE.Vector3(anchor.position.x, anchor.position.y * 0.6, anchor.position.z), 1);
      this.controls.update();
    } else {
      if (this.storey !== anchor.userData.storey) this.setStorey(anchor.userData.storey);
      this.player.x = anchor.position.x;
      this.player.z = anchor.position.z;
      this._applyCamera();
    }
    if (typeof this.opts.onRoom === 'function') this.opts.onRoom(name);
  }

  /* ---------------------------- minimap ---------------------------- */

  _drawMinimap() {
    if (!this.mctx) return;
    const st = this.mode === 'walk' ? (this.storey == null ? 0 : this.storey) : (this.storey == null ? 0 : this.storey);
    const rooms = minimapRooms(this.sceneDesc, st);
    const S = this.minimap.width;
    const g = this.mctx;
    g.clearRect(0, 0, S, S);
    if (!rooms.length) return;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const r of rooms) { minX = Math.min(minX, r.x); minZ = Math.min(minZ, r.z); maxX = Math.max(maxX, r.x + r.w); maxZ = Math.max(maxZ, r.z + r.d); }
    const pad = 10;
    const scale = Math.min((S - pad * 2) / (maxX - minX), (S - pad * 2) / (maxZ - minZ));
    const ox = pad + (S - pad * 2 - (maxX - minX) * scale) / 2;
    const oy = pad + (S - pad * 2 - (maxZ - minZ) * scale) / 2;
    const X = (x) => ox + (x - minX) * scale;
    const Z = (z) => oy + (z - minZ) * scale;
    for (const r of rooms) {
      g.fillStyle = ROOM_FILL[r.type] || '#dcdcdc';
      g.fillRect(X(r.x), Z(r.z), r.w * scale, r.d * scale);
      g.strokeStyle = 'rgba(30,34,40,.6)';
      g.lineWidth = 1;
      g.strokeRect(X(r.x), Z(r.z), r.w * scale, r.d * scale);
    }
    if (this.mode === 'walk') {
      const px = X(this.player.x), pz = Z(this.player.z);
      g.fillStyle = '#1478dc';
      g.beginPath();
      g.arc(px, pz, 4, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#1478dc';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, pz);
      g.lineTo(px + Math.sin(this.yaw) * -12, pz + Math.cos(this.yaw) * -12);
      g.stroke();
    }
  }

  /* ---------------------------- misc ---------------------------- */

  resize() {
    const w = this.stage.clientWidth || 640;
    const h = this.stage.clientHeight || 360;
    if (!w || !h || this.disposed) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async captureGlb() {
    const { GLTFExporter } = await import('./vendor/addons/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const hidden = this.built.hotspotObjects.filter((o) => !o.visible);
    this.built.hotspotObjects.forEach((o) => { o.visible = true; });
    try {
      return await new Promise((resolve, reject) => {
        exporter.parse(this.built.root, (glb) => resolve(glb), (err) => reject(err), { binary: true, onlyVisible: true });
      });
    } finally {
      hidden.forEach((o) => { o.visible = false; });
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this._frame);
    for (const [t, e, fn, o] of this._listeners) t.removeEventListener(e, fn, o);
    this._listeners = [];
    if (this._ro) this._ro.disconnect();
    this._exitPointerLock();
    try { this.controls.dispose(); } catch { /* ignore */ }
    disposeObject(this.built.root);
    this.renderer.dispose();
    if (this.renderer.xr) this.renderer.setAnimationLoop(null);
    this.canvas.remove();
    this.ui.remove();
  }
}

export function createProceduralController(stage, sceneDesc, opts) {
  return new ProceduralController(stage, sceneDesc, opts);
}

export default createProceduralController;
