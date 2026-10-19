/**
 * Seed floor plans for the project's existing typologies, keyed by
 * `typology + bedrooms` (not by property row) so any property can reuse them.
 * Style/palette follows the reference images in public/images/.
 *
 * Each template is plain floor-plan JSON (what a manager would edit), built here
 * with small helpers to keep coordinates tidy.
 */

const rm = (name, type, x, z, width, depth, extra = {}) => ({ name, type, x, z, width, depth, ...extra });
const dr = (wall, position, width = 0.9, height = 2.05) => ({ wall, position, width, height });
const win = (wall, position, width = 1.4, height = 1.3, sill = 0.9) => ({ wall, position, width, height, sill });

const EXTERIOR_LIGHT = { wallColor: '#F0F0F0', roofType: 'pitched', roofColor: '#303030', garden: true, fence: '#909090', driveway: true };
const EXTERIOR_WARM = { wallColor: '#EFEBE4', roofType: 'pitched', roofColor: '#6B4A34', garden: true, fence: false, driveway: true };
const EXTERIOR_URBAN = { wallColor: '#DEDAD4', roofType: 'flat', roofColor: '#303030', garden: false, fence: false, driveway: false };

export const TEMPLATES = {
  /* ---------------------------------------------------------------- */
  'apartment-3': {
    id: 'apartment-3', typology: 'apartment', beds: 3, name: '3-bedroom apartment',
    plan: {
      name: 'Apartment — 3 bedroom', units: 'm',
      exterior: EXTERIOR_URBAN,
      storeys: [{
        name: 'Apartment',
        rooms: [
          rm('Living / Dining', 'living', 0, 0, 6, 6, { doors: [dr('west', 3.2)], windows: [win('south', 1.8, 2.0), win('west', 2.0, 1.8)] }),
          rm('Kitchen', 'kitchen', 6, 0, 3, 3, { doors: [dr('south', 1.0)], windows: [win('north', 1.2, 1.2)] }),
          rm('Bathroom', 'bathroom', 9, 0, 4, 4, { doors: [dr('west', 0.6, 0.8, 2.05)], windows: [win('north', 1.6, 0.8, 0.8, 1.3)] }),
          rm('Hall', 'hall', 6, 3, 3, 3, { doors: [dr('north', 1.0)] }),
          rm('Bedroom 1 (Main)', 'bedroom', 0, 6, 4, 5, { doors: [dr('north', 1.4)], windows: [win('south', 1.0, 1.6)] }),
          rm('Bedroom 2', 'bedroom', 4, 6, 5, 5, { doors: [dr('north', 2.0)], windows: [win('south', 1.8, 1.6)] }),
          rm('Bedroom 3', 'bedroom', 9, 4, 4, 4, { doors: [dr('west', 2.0)], windows: [win('east', 1.2, 1.6)] }),
          rm('Bathroom 2', 'bathroom', 9, 8, 4, 3, { doors: [dr('west', 1.2, 0.8, 2.05)], windows: [win('south', 1.4, 1.0, 0.8, 1.3)] }),
        ],
      }],
    },
  },

  /* ---------------------------------------------------------------- */
  'townhouse-3': {
    id: 'townhouse-3', typology: 'townhouse', beds: 3, name: '3-bedroom townhouse',
    plan: {
      name: 'Townhouse — 3 bedroom', units: 'm',
      exterior: EXTERIOR_WARM,
      storeys: [
        {
          name: 'Ground floor',
          rooms: [
            rm('Living Room', 'living', 0, 0, 4, 5, { doors: [dr('east', 2.0)], windows: [win('west', 1.6, 1.8)] }),
            rm('Stairs', 'stairs', 4, 0, 2, 3, {}),
            rm('Guest WC', 'bathroom', 4, 3, 2, 2, { doors: [dr('south', 0.5, 0.75, 2.05)] }),
            rm('Kitchen', 'kitchen', 0, 5, 3, 4, { doors: [dr('north', 1.0)], windows: [win('west', 1.6, 1.4)] }),
            rm('Dining', 'dining', 3, 5, 3, 4, { doors: [dr('north', 1.2)], windows: [win('east', 1.6, 1.6)] }),
          ],
          stairs: [{ x: 4.2, z: 0.6, width: 1.4, depth: 2.4, direction: 'up', to: 1 }],
        },
        {
          name: 'First floor',
          rooms: [
            rm('Bedroom 1 (Main)', 'bedroom', 0, 0, 6, 4, { doors: [dr('south', 2.6)], windows: [win('north', 2.0, 1.8)] }),
            rm('Bedroom 2', 'bedroom', 0, 4, 3, 2.5, { doors: [dr('east', 1.0)], windows: [win('west', 0.8, 1.3)] }),
            rm('Bedroom 3', 'bedroom', 3, 4, 3, 2.5, { doors: [dr('west', 1.0)], windows: [win('east', 0.8, 1.3)] }),
            rm('Bathroom', 'bathroom', 0, 6.5, 3, 2.5, { doors: [dr('east', 1.0, 0.8, 2.05)], windows: [win('west', 1.0, 0.8, 0.8, 1.3)] }),
            rm('Landing', 'hall', 3, 6.5, 3, 2.5, { doors: [dr('north', 1.0)] }),
          ],
        },
        {
          name: 'Top floor',
          rooms: [
            rm('Study', 'study', 0, 0, 3.5, 6, { doors: [dr('east', 2.0)], windows: [win('west', 2.0, 1.6)] }),
            rm('Landing', 'hall', 3.5, 0, 2.5, 6, {}),
            rm('Balcony', 'balcony', 0, 6, 6, 3, { doors: [dr('north', 2.5)] }),
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- */
  'rowhouse-2': {
    id: 'rowhouse-2', typology: 'rowhouse', beds: 2, name: '2-bedroom row house',
    plan: {
      name: 'Row house — 2 bedroom', units: 'm',
      exterior: EXTERIOR_URBAN,
      storeys: [
        {
          name: 'Ground floor',
          rooms: [
            rm('Living', 'living', 0, 0, 5.5, 5, { doors: [dr('south', 2.4)], windows: [win('north', 2.0, 1.8)] }),
            rm('Kitchen', 'kitchen', 0, 5, 3, 4, { doors: [dr('north', 1.0)], windows: [win('west', 1.6, 1.4)] }),
            rm('Dining', 'dining', 3, 5, 2.5, 4, { doors: [dr('north', 0.8)], windows: [win('east', 1.2, 1.4)] }),
          ],
          stairs: [{ x: 4.3, z: 0.6, width: 1.0, depth: 2.2, direction: 'up', to: 1 }],
        },
        {
          name: 'First floor',
          rooms: [
            rm('Bedroom 1 (Main)', 'bedroom', 0, 0, 5.5, 4.5, { doors: [dr('south', 2.6)], windows: [win('north', 2.2, 1.8)] }),
            rm('Bedroom 2', 'bedroom', 0, 4.5, 2.75, 4.5, { doors: [dr('east', 1.0)], windows: [win('west', 1.0, 1.3)] }),
            rm('Bathroom', 'bathroom', 2.75, 4.5, 2.75, 4.5, { doors: [dr('west', 1.0, 0.8, 2.05)], windows: [win('east', 1.0, 0.8, 0.8, 1.3)] }),
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- */
  'villa-4': {
    id: 'villa-4', typology: 'villa', beds: 4, name: '4-bedroom villa',
    plan: {
      name: 'Villa — 4 bedroom', units: 'm',
      exterior: EXTERIOR_WARM,
      storeys: [
        {
          name: 'Ground floor',
          rooms: [
            rm('Living', 'living', 0, 0, 6, 5, { doors: [dr('east', 2.4)], windows: [win('west', 2.0, 1.8)] }),
            rm('Kitchen', 'kitchen', 6, 0, 3, 3, { doors: [dr('south', 1.0)], windows: [win('north', 1.2, 1.2)] }),
            rm('Dining', 'dining', 9, 0, 3, 3, { doors: [dr('south', 1.0, 0.9)], windows: [win('north', 1.2, 1.2)] }),
            rm('Hall', 'hall', 6, 3, 3, 2, { doors: [dr('west', 0.6)] }),
            rm('Bathroom', 'bathroom', 9, 3, 3, 2, { doors: [dr('west', 1.0, 0.8, 2.05)] }),
            rm('Garage', 'garage', 0, 5, 5, 5, { doors: [dr('north', 1.2, 2.6, 2.3)] }),
            rm('Study', 'study', 5, 5, 3.5, 5, { doors: [dr('north', 1.0)], windows: [win('south', 1.4, 1.6)] }),
            rm('Utility', 'utility', 8.5, 5, 3.5, 5, { doors: [dr('north', 1.0, 0.85)], windows: [win('south', 1.2, 1.0)] }),
          ],
          stairs: [{ x: 6.4, z: 3.2, width: 1.2, depth: 1.6, direction: 'up', to: 1 }],
        },
        {
          name: 'First floor',
          rooms: [
            rm('Bedroom 1 (Main)', 'bedroom', 0, 0, 6, 5, { doors: [dr('east', 2.6)], windows: [win('west', 2.2, 1.8)] }),
            rm('Bedroom 2', 'bedroom', 6, 0, 6, 5, { doors: [dr('south', 3.0)], windows: [win('north', 2.2, 1.8)] }),
            rm('Bedroom 3', 'bedroom', 0, 5, 6, 5, { doors: [dr('east', 2.6)], windows: [win('west', 2.2, 1.8)] }),
            rm('Bedroom 4', 'bedroom', 6, 5, 3, 3, { doors: [dr('south', 1.0)], windows: [win('north', 1.2, 1.3)] }),
            rm('Bathroom', 'bathroom', 9, 5, 3, 3, { doors: [dr('south', 1.0, 0.8, 2.05)], windows: [win('east', 1.0, 0.8, 0.8, 1.3)] }),
            rm('Landing', 'hall', 6, 8, 6, 2, { doors: [dr('north', 1.0)] }),
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- */
  'villa-5': {
    id: 'villa-5', typology: 'villa', beds: 5, name: '5-bedroom villa',
    plan: {
      name: 'Villa — 5 bedroom', units: 'm',
      exterior: EXTERIOR_LIGHT,
      storeys: [
        {
          name: 'Ground floor',
          rooms: [
            rm('Living', 'living', 0, 0, 7, 6, { doors: [dr('east', 3.0)], windows: [win('west', 2.4, 2.0)] }),
            rm('Dining', 'dining', 7, 0, 4, 4, { doors: [dr('south', 1.4)], windows: [win('north', 1.6, 1.6)] }),
            rm('Kitchen', 'kitchen', 11, 0, 3, 4, { doors: [dr('west', 1.0)], windows: [win('north', 1.2, 1.2)] }),
            rm('Hall', 'hall', 7, 4, 4, 2, { doors: [dr('north', 1.0)] }),
            rm('Bathroom', 'bathroom', 11, 4, 3, 2, { doors: [dr('west', 1.0, 0.8, 2.05)] }),
            rm('Garage', 'garage', 0, 6, 5, 5, { doors: [dr('north', 1.2, 2.6, 2.3)] }),
            rm('Bedroom 1 (Main)', 'bedroom', 5, 6, 4.5, 5, { doors: [dr('north', 1.2)], windows: [win('south', 2.0, 1.8)] }),
            rm('Bedroom 2', 'bedroom', 9.5, 6, 4.5, 5, { doors: [dr('north', 1.2)], windows: [win('south', 2.0, 1.8)] }),
          ],
          stairs: [{ x: 7.6, z: 4.2, width: 1.4, depth: 1.6, direction: 'up', to: 1 }],
        },
        {
          name: 'First floor',
          rooms: [
            rm('Bedroom 3 (Master)', 'bedroom', 0, 0, 7, 5, { doors: [dr('east', 3.0)], windows: [win('west', 2.4, 1.8)] }),
            rm('Bedroom 4', 'bedroom', 7, 0, 3.5, 5, { doors: [dr('south', 1.2)], windows: [win('north', 1.6, 1.6)] }),
            rm('Bedroom 5', 'bedroom', 10.5, 0, 3.5, 5, { doors: [dr('south', 1.2)], windows: [win('north', 1.6, 1.6)] }),
            rm('Family Lounge', 'living', 0, 5, 4.5, 6, { doors: [dr('east', 2.0)], windows: [win('west', 1.8, 1.6)] }),
            rm('Study', 'study', 4.5, 5, 4.5, 6, { doors: [dr('east', 2.0)], windows: [win('south', 1.8, 1.6)] }),
            rm('Bathroom 1', 'bathroom', 9, 5, 2.5, 3, { doors: [dr('south', 1.0, 0.8, 2.05)], windows: [] }),
            rm('Bathroom 2', 'bathroom', 9, 8, 2.5, 3, { doors: [dr('north', 1.0, 0.8, 2.05)], windows: [win('east', 1.0, 0.8, 0.8, 1.3)] }),
            rm('Landing', 'hall', 11.5, 5, 2.5, 6, { doors: [dr('west', 2.0)] }),
          ],
        },
      ],
    },
  },
};

export function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({ id: t.id, typology: t.typology, beds: t.beds, name: t.name }));
}

/** Resolve a template by typology + bedroom count (falls back to typology only). */
export function getTemplate(typology, beds) {
  const key = `${String(typology || '').toLowerCase()}-${Number(beds)}`;
  if (TEMPLATES[key]) return TEMPLATES[key];
  const byType = Object.values(TEMPLATES).filter((t) => t.typology === String(typology || '').toLowerCase());
  if (byType.length) {
    byType.sort((a, b) => Math.abs(a.beds - Number(beds)) - Math.abs(b.beds - Number(beds)));
    return byType[0];
  }
  return null;
}

/** A deep copy of a template's plan (safe to edit / mutate). */
export function templatePlan(id) {
  const t = TEMPLATES[id];
  return t ? JSON.parse(JSON.stringify(t.plan)) : null;
}
