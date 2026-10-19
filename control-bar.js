/**
 * Property Viewer — Vision City control chrome (Matterport-style).
 *
 * Minimal overlay built from our own inline SVG icons and the Vision City
 * palette (navy #003A6B, green #7AB93F, white). No third-party branding or
 * libraries. It mounts as an absolutely positioned layer inside the viewer's
 * stage and never touches the renderers, the minimap, tour nav or the pitch
 * limited walk-through.
 *
 *   top-left     logo + property name (white text, soft shadow, no background)
 *   top-right    small green "Book a visit" pill (optional, on by default)
 *   bottom-left  view-mode pill: dollhouse / floor plan / walkthrough / measure
 *   bottom-right share button + three-dots menu (details, book, fullscreen,
 *                VR, help, low-bandwidth)
 *
 * Controls fade out after a few idle seconds and return on move/tap; the title
 * always stays. Everything is opt-out per typology via `viewer_config.ui`:
 *
 *   ui: {
 *     controls: { mode, share, menu, book },   // per-cluster on/off
 *     modes: { walk, dollhouse, plan, measure }, // per-mode on/off
 *     title, subtitle, bookLabel,
 *     property: { price, bedrooms, bathrooms, size, status, project, unit },
 *   }
 *
 * A mode only appears if it is both enabled and has data (`modes[id].available`);
 * anything else hides cleanly — no dead buttons.
 */

const ICON = {
  logo: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="#003A6B"/><path d="M7 16.5 12 6l5 10.5" fill="none" stroke="#7AB93F" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.4 12.6h5.2" fill="none" stroke="#7AB93F" stroke-width="2.2" stroke-linecap="round"/></svg>',
  walk: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4.3" r="1.8"/><path d="M11 21l1.6-5.2-2.4-2.3.8-4.3 3 1.6 2.4 1.1"/><path d="M9.4 12.2 8 15l-2.6 1.7"/><path d="M13 15.8l2 2.3.6 2.9"/></svg>',
  dollhouse: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.6 3 7v10l9 4.4L21 17V7z"/><path d="M3 7l9 4.4L21 7"/><path d="M12 11.4V21.4"/></svg>',
  plan: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V9l8-5 8 5v11"/><path d="M4 20h16"/><path d="M9 20v-5h6v5"/><path d="M9 12h.01M15 12h.01"/></svg>',
  measure: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 14.5 14.5 3.5l6 6L9.5 20.5z"/><path d="M7 11l1.5 1.5M9.5 8.5 11 10M12 6l1.5 1.5M14.5 3.5 16 5"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5V4"/><path d="m8 7.6 4-3.6 4 3.6"/><path d="M5.5 12.5v6A2 2 0 0 0 7.5 20.5h9a2 2 0 0 0 2-2v-6"/></svg>',
  dots: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="12" cy="5.5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18.5" r="1.7"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4.5A.5.5 0 0 1 4.5 4H9"/><path d="M20 9V4.5a.5.5 0 0 0-.5-.5H15"/><path d="M4 15v4.5a.5.5 0 0 0 .5.5H9"/><path d="M20 15v4.5a.5.5 0 0 1-.5.5H15"/></svg>',
  exitFullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v4.5a.5.5 0 0 1-.5.5H4"/><path d="M15 4v4.5a.5.5 0 0 0 .5.5H20"/><path d="M9 20v-4.5a.5.5 0 0 0-.5-.5H4"/><path d="M15 20v-4.5a.5.5 0 0 1 .5-.5H20"/></svg>',
  vr: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="19" height="10" rx="3"/><path d="M8.5 12h.01M15.5 12h.01"/><path d="M10 17l-1.5 2M14 17l1.5 2"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 9.5h17"/><path d="M8 3.2v3.4"/><path d="M16 3.2v3.4"/></svg>',
  help: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 2-2.4 3.6"/><path d="M12 17.2h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11.2v5"/><path d="M12 7.6h.01"/></svg>',
  lowbw: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20a8 8 0 1 0-8-8"/><path d="M12 20a8 8 0 0 0 8-8"/><path d="M12 12h8"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6.5 6.5 11 11"/><path d="m17.5 6.5-11 11"/></svg>',
};

const MODE_ORDER = ['dollhouse', 'plan', 'walk', 'measure'];
const MODE_LABEL = { dollhouse: 'Dollhouse', plan: 'Floor plan', walk: 'Walkthrough', measure: 'Measure' };
const MODE_TIP = {
  dollhouse: '3D overview of the whole property',
  plan: 'Top-down floor plan with sweep positions',
  walk: 'Walk through the 360° scenes',
  measure: 'Measure real distances',
};

function ensureControlStyles() {
  if (typeof document === 'undefined' || document.getElementById('pv-ctrl-styles')) return;
  const css = `
  .pv-ctrl-layer{position:absolute;inset:0;z-index:6;pointer-events:none;
    font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#fff}
  .pv-ctrl-layer[hidden]{display:none}
  .pv-ctrl-fade{transition:opacity .35s ease,transform .35s ease}
  .pv-ctrl-layer.is-idle .pv-ctrl-fade{opacity:0;pointer-events:none}
  .pv-ctrl-layer.is-idle .pv-ctrl-pill{transform:translateY(16px)}
  .pv-ctrl-layer.is-idle .pv-ctrl-right{transform:translateY(16px)}

  .pv-ctrl-titlewrap{position:absolute;top:14px;left:16px;max-width:52%;pointer-events:none;
    display:flex;align-items:center;gap:10px;text-shadow:0 1px 3px rgba(0,0,0,.6),0 2px 10px rgba(0,0,0,.4)}
  .pv-ctrl-logo{width:30px;height:30px;flex:0 0 auto;display:block;border-radius:8px;
    box-shadow:0 2px 8px rgba(0,0,0,.4)}
  .pv-ctrl-titles{display:flex;flex-direction:column;min-width:0;line-height:1.25}
  .pv-ctrl-title{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pv-ctrl-sub{font-size:11.5px;opacity:.82;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pv-ctrl-sub:empty{display:none}

  .pv-ctrl-book{position:absolute;top:14px;right:16px;pointer-events:auto;
    display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 14px;
    color:#062313;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap;
    background:#7AB93F;border:1px solid #8ecc4f;border-radius:999px;
    box-shadow:0 4px 16px rgba(122,185,63,.4);transition:background .15s,transform .06s}
  .pv-ctrl-book svg{width:16px;height:16px}
  .pv-ctrl-book:hover{background:#8ac74d}
  .pv-ctrl-book:active{transform:translateY(1px)}
  .pv-ctrl-book:focus-visible{outline:2px solid #fff;outline-offset:2px}
  .pv-ctrl-book[hidden]{display:none}

  .pv-ctrl-pill{position:absolute;left:16px;bottom:16px;pointer-events:auto;
    display:flex;align-items:center;gap:4px;padding:5px;
    background:rgba(12,20,30,.62);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);
    border:1px solid rgba(255,255,255,.14);border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
  .pv-ctrl-pill[hidden]{display:none}
  .pv-ctrl-mode{appearance:none;position:relative;display:inline-flex;align-items:center;justify-content:center;
    width:44px;height:44px;border-radius:999px;cursor:pointer;color:#fff;
    background:transparent;border:1.5px solid rgba(255,255,255,.55);transition:background .18s,color .18s,border-color .18s,transform .06s}
  .pv-ctrl-mode svg{width:22px;height:22px;display:block;pointer-events:none}
  .pv-ctrl-mode:hover{background:rgba(255,255,255,.14)}
  .pv-ctrl-mode:active{transform:scale(.94)}
  .pv-ctrl-mode:focus-visible{outline:2px solid #7AB93F;outline-offset:2px}
  .pv-ctrl-mode.on{background:#fff;color:#0c141e;border-color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.35)}

  .pv-ctrl-right{position:absolute;right:16px;bottom:16px;pointer-events:auto;display:flex;align-items:center;gap:8px}
  .pv-ctrl-rbtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;
    width:44px;height:44px;border-radius:999px;cursor:pointer;color:#fff;
    background:rgba(12,20,30,.62);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);
    border:1px solid rgba(255,255,255,.16);box-shadow:0 8px 24px rgba(0,0,0,.4);transition:background .15s,transform .06s}
  .pv-ctrl-rbtn svg{width:21px;height:21px;display:block}
  .pv-ctrl-rbtn:hover{background:rgba(30,44,60,.72)}
  .pv-ctrl-rbtn:active{transform:scale(.94)}
  .pv-ctrl-rbtn:focus-visible{outline:2px solid #7AB93F;outline-offset:2px}
  .pv-ctrl-rbtn[hidden]{display:none}
  .pv-ctrl-rbtn.on{background:#7AB93F;color:#062313;border-color:#8ecc4f}

  .pv-ctrl-toast{position:absolute;left:50%;bottom:76px;transform:translate(-50%,8px);pointer-events:none;
    background:rgba(122,185,63,.96);color:#062313;font-weight:700;font-size:12.5px;
    padding:8px 14px;border-radius:10px;box-shadow:0 8px 22px rgba(0,0,0,.4);
    opacity:0;transition:opacity .2s,transform .2s}
  .pv-ctrl-toast.show{opacity:1;transform:translate(-50%,0)}

  .pv-ctrl-pop{position:absolute;right:16px;bottom:70px;width:250px;pointer-events:auto;
    background:rgba(9,26,44,.94);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
    border:1px solid rgba(255,255,255,.16);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.55);
    overflow:hidden;animation:pv-pop .16s ease;padding:6px}
  @keyframes pv-pop{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  .pv-ctrl-pop[hidden]{display:none}
  .pv-ctrl-mi{display:flex;align-items:center;gap:11px;width:100%;padding:10px 11px;
    color:#eef4fb;background:transparent;border:0;border-radius:10px;font:inherit;font-size:13.5px;
    text-align:left;cursor:pointer}
  .pv-ctrl-mi:hover{background:rgba(255,255,255,.1)}
  .pv-ctrl-mi:focus-visible{outline:2px solid #7AB93F;outline-offset:-2px}
  .pv-ctrl-mi svg{width:19px;height:19px;flex:0 0 auto;opacity:.85}
  .pv-ctrl-mi .rt{margin-left:auto;font-size:11.5px;opacity:.6}
  .pv-ctrl-msep{height:1px;margin:5px 8px;background:rgba(255,255,255,.12)}
  .pv-ctrl-mhead{padding:10px 12px 5px;font-size:11px;font-weight:700;opacity:.6}
  .pv-ctrl-rows{padding:2px 12px 10px}
  .pv-ctrl-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:6px 0;
    border-bottom:1px solid rgba(255,255,255,.07)}
  .pv-ctrl-row:last-child{border-bottom:0}
  .pv-ctrl-row .k{font-size:11.5px;opacity:.66;white-space:nowrap}
  .pv-ctrl-row .v{font-weight:600;text-align:right}
  .pv-ctrl-row .v.price{color:#9ed65a;font-size:15px}
  .pv-ctrl-status{display:inline-block;padding:1px 9px;border-radius:999px;font-size:11px;font-weight:700;
    background:rgba(122,185,63,.2);color:#b6ea72;border:1px solid rgba(122,185,63,.4)}
  .pv-ctrl-status.sold{background:rgba(185,28,28,.2);color:#ff9a9a;border-color:rgba(185,28,28,.45)}
  .pv-ctrl-status.reserved{background:rgba(180,83,9,.2);color:#ffca8a;border-color:rgba(180,83,9,.45)}
  .pv-ctrl-empty{padding:14px 12px;font-size:12.5px;opacity:.7}

  .pv-ctrl-help{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:22px;
    pointer-events:auto;background:rgba(4,12,22,.6);backdrop-filter:blur(3px);animation:pv-fade .18s ease}
  @keyframes pv-fade{from{opacity:0}to{opacity:1}}
  .pv-ctrl-help[hidden]{display:none}
  .pv-ctrl-help-card{max-width:380px;width:100%;background:rgba(9,26,44,.96);border:1px solid rgba(255,255,255,.16);
    border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.55);overflow:hidden}
  .pv-ctrl-hhead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;
    border-bottom:1px solid rgba(255,255,255,.12)}
  .pv-ctrl-hhead h3{margin:0;font-size:13.5px;font-weight:700}
  .pv-ctrl-x{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
    color:#cfe0f2;background:transparent;border:0;border-radius:8px;cursor:pointer}
  .pv-ctrl-x:hover{background:rgba(255,255,255,.12)}
  .pv-ctrl-x:focus-visible{outline:2px solid #7AB93F;outline-offset:2px}
  .pv-ctrl-x svg{width:18px;height:18px}
  .pv-ctrl-hlist{padding:6px 16px 16px;margin:0;list-style:none}
  .pv-ctrl-hlist li{display:flex;align-items:center;gap:12px;padding:9px 0;font-size:13px;
    border-bottom:1px solid rgba(255,255,255,.07)}
  .pv-ctrl-hlist li:last-child{border-bottom:0}
  .pv-ctrl-key{flex:0 0 auto;min-width:74px;text-align:center;padding:4px 8px;font-size:11.5px;font-weight:700;
    background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);border-radius:7px}

  @media (max-width:640px){
    .pv-ctrl-titlewrap{top:10px;left:10px;max-width:60%}
    .pv-ctrl-logo{width:26px;height:26px}
    .pv-ctrl-title{font-size:13.5px}
    .pv-ctrl-sub{display:none}
    .pv-ctrl-book{top:10px;right:10px;height:34px;padding:0 12px;font-size:12px}
    .pv-ctrl-pill{left:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));padding:4px}
    .pv-ctrl-mode{width:46px;height:46px}
    .pv-ctrl-right{right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px))}
    .pv-ctrl-rbtn{width:46px;height:46px}
    .pv-ctrl-pop{left:8px;right:8px;width:auto;bottom:64px}
    .pv-ctrl-toast{bottom:120px}
  }
  `;
  const s = document.createElement('style');
  s.id = 'pv-ctrl-styles';
  s.textContent = css;
  document.head.appendChild(s);
}

function svgIcon(name) {
  const tpl = document.createElement('template');
  tpl.innerHTML = ICON[name] || '';
  return tpl.content.firstElementChild;
}

function node(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'hidden') n.hidden = !!v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

function resolveUi(viewerConfig, viewer, kind) {
  const ui = (viewerConfig && viewerConfig.ui) || {};
  const controls = { mode: true, share: true, menu: true, book: true, ...(ui.controls || {}) };
  const modeToggles = { walk: true, dollhouse: true, plan: true, measure: true, ...(ui.modes || {}) };
  const prop = { ...((viewer && viewer.property) || {}), ...((ui.property) || {}) };

  const beds = prop.bedrooms != null ? prop.bedrooms : viewer && viewer.beds;
  const typology = (viewer && viewer.typology) || '';
  const typeName = (viewer && viewer.typeName) || '';

  let title = ui.title || typeName || '';
  if (!title && (beds != null || typology)) {
    title = `${beds != null ? beds + '-Bedroom ' : ''}${typology || 'Property'}`.trim();
  }
  if (!title && kind) title = { tour360: '360° tour', model3d: '3D model', pointcloud: 'Point cloud', procedural: 'Concept model', embed: 'Property tour' }[kind] || 'Property preview';

  let subtitle = ui.subtitle || '';
  if (!subtitle) {
    const bits = [prop.project, prop.unit].filter((b) => b != null && String(b).trim() !== '');
    subtitle = bits.join(' · ');
  }

  return { ui, controls, modeToggles, prop, title, subtitle, price: prop.price != null ? prop.price : (viewer && viewer.price) };
}

function formatPrice(p) {
  if (p == null || p === '') return null;
  if (typeof p === 'number') return '€' + p.toLocaleString('en-US');
  return String(p);
}

export function createControlBar({
  stage, viewer, viewerConfig, kind, modes = [], activeMode = 'walk',
  onMode, onFullscreen, onBook, onQuality, onVR, isFullscreen,
}) {
  ensureControlStyles();
  const r = resolveUi(viewerConfig, viewer, kind);
  const { controls, modeToggles } = r;

  const layer = node('div', { class: 'pv-ctrl-layer', 'data-pv-controls': 'mp' });
  const disposers = [];
  let openPop = null;
  let toastTimer = null;
  let idleTimer = null;
  let currentMode = activeMode;

  /* ------------------------------- title ------------------------------- */
  const logo = svgIcon('logo');
  logo.classList.add('pv-ctrl-logo');
  logo.setAttribute('role', 'img');
  logo.setAttribute('aria-label', 'Vision City');
  const titles = node('div', { class: 'pv-ctrl-titles' },
    node('span', { class: 'pv-ctrl-title' }, r.title),
    node('span', { class: 'pv-ctrl-sub' }, r.subtitle));
  const titleWrap = node('div', { class: 'pv-ctrl-titlewrap' }, logo, titles);
  layer.append(titleWrap);

  /* ---------------------------- book pill ------------------------------ */
  let bookBtn = null;
  if (controls.book) {
    bookBtn = node('button', { class: 'pv-ctrl-book', type: 'button', 'data-act': 'book' });
    bookBtn.appendChild(svgIcon('book'));
    bookBtn.append(node('span', {}, r.ui.bookLabel || 'Book a visit'));
    layer.append(bookBtn);
  }

  /* ----------------------------- mode pill ----------------------------- */
  const avail = new Map((modes || []).map((m) => [m.id, m]));
  const shownModes = MODE_ORDER.filter((id) => modeToggles[id] && avail.get(id) && avail.get(id).available !== false);
  let pill = null;
  const modeBtns = new Map();
  if (controls.mode && shownModes.length) {
    pill = node('div', { class: 'pv-ctrl-pill pv-ctrl-fade', role: 'group', 'aria-label': 'View mode' });
    for (const id of shownModes) {
      const b = node('button', {
        class: 'pv-ctrl-mode' + (id === currentMode ? ' on' : ''),
        type: 'button', 'data-mode': id, title: MODE_TIP[id],
        'aria-label': MODE_LABEL[id], 'aria-pressed': String(id === currentMode),
      });
      b.appendChild(svgIcon(id));
      modeBtns.set(id, b);
      pill.append(b);
    }
    layer.append(pill);
  }

  /* --------------------------- right controls -------------------------- */
  const shareBtn = node('button', {
    class: 'pv-ctrl-rbtn pv-ctrl-fade', type: 'button', title: 'Share this tour',
    'aria-label': 'Share this tour', 'data-act': 'share', hidden: !controls.share,
  });
  shareBtn.appendChild(svgIcon('share'));

  const menuBtn = node('button', {
    class: 'pv-ctrl-rbtn pv-ctrl-fade', type: 'button', title: 'More options',
    'aria-label': 'More options', 'data-act': 'menu', 'aria-expanded': 'false', hidden: !controls.menu,
  });
  menuBtn.appendChild(svgIcon('dots'));

  const right = node('div', { class: 'pv-ctrl-right' }, shareBtn, menuBtn);
  layer.append(right);

  /* ------------------------------- toast ------------------------------- */
  const toast = node('div', { class: 'pv-ctrl-toast', role: 'status', 'aria-live': 'polite' });
  layer.append(toast);
  const showToast = (msg) => {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
  };
  disposers.push(() => clearTimeout(toastTimer));

  /* --------------------------- property panel -------------------------- */
  const buildDetails = () => {
    const p = r.prop;
    const rows = [];
    const price = formatPrice(r.price);
    if (price) rows.push(['Price', node('span', { class: 'v price' }, price)]);
    const beds = p.bedrooms != null ? p.bedrooms : viewer && viewer.beds;
    if (beds != null) rows.push(['Bedrooms', node('span', { class: 'v' }, String(beds))]);
    if (p.bathrooms != null) rows.push(['Bathrooms', node('span', { class: 'v' }, String(p.bathrooms))]);
    if (p.size != null) rows.push(['Size', node('span', { class: 'v' }, String(p.size))]);
    if (p.status) {
      const st = String(p.status).toLowerCase();
      const cls = st === 'sold' ? 'sold' : st === 'reserved' ? 'reserved' : '';
      rows.push(['Status', node('span', { class: 'pv-ctrl-status ' + cls }, String(p.status))]);
    }
    const wrap = node('div', { class: 'pv-ctrl-pop', role: 'dialog', 'aria-label': 'Property details', hidden: true });
    wrap.append(node('div', { class: 'pv-ctrl-mhead' }, 'Property details'));
    if (rows.length) {
      const rowsEl = node('div', { class: 'pv-ctrl-rows' });
      for (const [k, v] of rows) rowsEl.append(node('div', { class: 'pv-ctrl-row' }, node('span', { class: 'k' }, k), v));
      wrap.append(rowsEl);
    } else {
      wrap.append(node('div', { class: 'pv-ctrl-empty' }, 'No property details were provided for this listing.'));
    }
    return wrap;
  };

  /* ------------------------------- menu -------------------------------- */
  const hasVR = typeof navigator !== 'undefined' && 'xr' in navigator;
  let detailsPop = null;
  let menuPop = null;

  const buildMenu = () => {
    const wrap = node('div', { class: 'pv-ctrl-pop', role: 'menu', 'aria-label': 'More options', hidden: true });
    const item = (icon, label, act, right) => {
      const b = node('button', { class: 'pv-ctrl-mi', type: 'button', role: 'menuitem', 'data-act': act });
      b.append(svgIcon(icon), node('span', {}, label));
      if (right) b.append(node('span', { class: 'rt' }, right));
      return b;
    };
    wrap.append(item('info', 'Property details', 'details'));
    wrap.append(item('book', 'Book a visit', 'book'));
    wrap.append(item('fullscreen', 'Fullscreen', 'fullscreen'));
    if (hasVR && controls.vr !== false) wrap.append(item('vr', 'View in VR', 'vr'));
    wrap.append(item('help', 'Help', 'help'));
    wrap.append(node('div', { class: 'pv-ctrl-msep' }));
    wrap.append(item('lowbw', 'Low-bandwidth mode', 'lowbw', (viewer && viewer._pvLowBandwidth) ? 'On' : 'Off'));
    return wrap;
  };

  /* ------------------------------- help -------------------------------- */
  let helpEl = null;
  const helpItems = () => {
    const isWalk = currentMode === 'walk';
    const base = [
      ['Drag', 'Look around'],
      ['Scroll / Pinch', 'Zoom in and out'],
    ];
    if (isWalk) base.splice(1, 0, ['Tap floor', 'Walk to the next spot']);
    if (currentMode === 'measure') base.splice(1, 0, ['Click points', 'Measure a distance']);
    base.push(['H', 'Show or hide these controls']);
    return base;
  };
  const buildHelp = () => {
    const wrap = node('div', { class: 'pv-ctrl-help', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How to navigate', hidden: true });
    const head = node('div', { class: 'pv-ctrl-hhead' }, node('h3', {}, 'Controls'));
    const x = node('button', { class: 'pv-ctrl-x', type: 'button', 'aria-label': 'Close' });
    x.appendChild(svgIcon('close'));
    x.addEventListener('click', () => closeHelp());
    head.append(x);
    const list = node('ul', { class: 'pv-ctrl-hlist' });
    for (const [k, t] of helpItems()) list.append(node('li', {}, node('span', { class: 'pv-ctrl-key' }, k), node('span', {}, t)));
    wrap.append(node('div', { class: 'pv-ctrl-help-card' }, head, list));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeHelp(); });
    return wrap;
  };
  function openHelp() {
    if (!helpEl) { helpEl = buildHelp(); layer.append(helpEl); }
    else { /* rebuild so the hint list matches the active mode */ helpEl.remove(); helpEl = buildHelp(); layer.append(helpEl); }
    helpEl.hidden = false;
    const c = helpEl.querySelector('.pv-ctrl-x');
    if (c) c.focus();
  }
  function closeHelp() { if (helpEl) helpEl.hidden = true; }

  /* ---------------------------- pop management ------------------------- */
  function closePop() {
    if (detailsPop) detailsPop.hidden = true;
    if (menuPop) menuPop.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    openPop = null;
  }
  function openDetails() {
    if (!detailsPop) { detailsPop = buildDetails(); layer.append(detailsPop); }
    closePop(); detailsPop.hidden = false; openPop = 'details';
  }
  function openMenu() {
    if (menuPop) { menuPop.remove(); menuPop = null; }
    menuPop = buildMenu(); layer.append(menuPop);
    closePop(); menuPop.hidden = false; openPop = 'menu';
    menuBtn.setAttribute('aria-expanded', 'true');
  }

  /* ------------------------------ actions ------------------------------ */
  const share = async () => {
    const url = (typeof location !== 'undefined' && location.href) || '';
    const data = { title: r.title || 'Property tour', text: r.subtitle || '', url };
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share(data); return; } catch { /* dismissed — fall back to copy */ }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); showToast('Link copied'); return; }
    } catch { /* clipboard unavailable */ }
    showToast('Copy this link: ' + url);
  };

  const onAction = (act) => {
    wake();
    if (act === 'share') share();
    else if (act === 'menu') { openPop === 'menu' ? closePop() : openMenu(); }
    else if (act === 'details') openDetails();
    else if (act === 'book') { closePop(); doBook(); }
    else if (act === 'fullscreen') { closePop(); if (onFullscreen) onFullscreen(); }
    else if (act === 'vr') { closePop(); if (onVR) onVR(); }
    else if (act === 'help') { closePop(); openHelp(); }
    else if (act === 'lowbw') {
      const on = !(viewer && viewer._pvLowBandwidth);
      if (onQuality) onQuality(on ? 'low' : 'auto');
      if (menuPop) { menuPop.remove(); menuPop = null; }
      showToast(on ? 'Low-bandwidth on' : 'Low-bandwidth off');
    }
  };

  const doBook = () => {
    if (typeof onBook === 'function') onBook();
    else showToast('Booking opens here');
  };

  const setMode = (id) => {
    if (id === currentMode) return;
    if (!modeBtns.has(id)) return;
    currentMode = id;
    for (const [mid, b] of modeBtns) {
      const on = mid === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (helpEl && !helpEl.hidden) { closeHelp(); openHelp(); }
    if (onMode) onMode(id);
  };

  /* ---------------------------- event wiring --------------------------- */
  const clickHandler = (e) => {
    const modeEl = e.target.closest('[data-mode]');
    if (modeEl && layer.contains(modeEl)) { setMode(modeEl.dataset.mode); return; }
    const actEl = e.target.closest('[data-act]');
    if (actEl && layer.contains(actEl)) onAction(actEl.dataset.act);
  };
  layer.addEventListener('click', clickHandler);

  layer.addEventListener('pointerdown', (e) => {
    wake();
    if (e.target.closest('.pv-ctrl-pop') || e.target.closest('.pv-ctrl-help')) return;
    if (openPop && !e.target.closest('[data-act]')) closePop();
  });

  const keyHandler = (e) => {
    if (e.key === 'Escape') { closePop(); closeHelp(); return; }
    if ((e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      setIdle(!idle);
    }
  };
  document.addEventListener('keydown', keyHandler);
  disposers.push(() => document.removeEventListener('keydown', keyHandler));
  disposers.push(() => layer.removeEventListener('click', clickHandler));

  /* ----------------------------- fullscreen ---------------------------- */
  const syncFullscreen = () => {
    const active = typeof isFullscreen === 'function' ? isFullscreen() : false;
    const el = menuPop && menuPop.querySelector('[data-act=fullscreen] svg');
    if (el) { /* menu rebuilt each open, so just update aria below */ }
    menuBtn.title = 'More options';
  };
  const fsHandler = () => syncFullscreen();
  document.addEventListener('fullscreenchange', fsHandler);
  disposers.push(() => document.removeEventListener('fullscreenchange', fsHandler));

  /* ------------------------------ auto-hide ---------------------------- */
  let idle = false;
  function setIdle(v) {
    idle = !!v;
    layer.classList.toggle('is-idle', idle);
  }
  function wake() {
    setIdle(false);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => setIdle(true), 4000);
  }
  disposers.push(() => clearTimeout(idleTimer));
  const moveHandler = () => wake();
  window.addEventListener('pointermove', moveHandler, { passive: true });
  disposers.push(() => window.removeEventListener('pointermove', moveHandler));
  wake();

  stage.appendChild(layer);

  return {
    el: layer,
    setMode,
    getMode: () => currentMode,
    setModes: (next) => {
      // Rebuild the pill when the host discovers/hides available modes.
      if (!pill) return;
      const list = (next || []).map((m) => m.id);
      for (const [id, b] of modeBtns) if (!list.includes(id)) b.remove();
    },
    showToast,
    updateTitle: (t, s) => {
      const te = titles.querySelector('.pv-ctrl-title');
      const se = titles.querySelector('.pv-ctrl-sub');
      if (te && t != null) te.textContent = t;
      if (se && s != null) se.textContent = s;
    },
    dispose: () => { for (const fn of disposers.reverse()) { try { fn(); } catch { /* ignore */ } } layer.remove(); },
  };
}
