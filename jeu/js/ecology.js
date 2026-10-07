// Règles de la forêt : arbres majestueux au cœur des bois, buissons en lisière.
import { TILE } from './map.js';
import { GROW_TIME } from './trees.js';

export const MAJESTIC_NEIGHBORS = 6; // arbres adultes voisins (sur 8) pour devenir majestueux
const MAJESTIC_SPACING = 2; // pas d'autre arbre majestueux à cette distance (cases)
const BUSH_CHANCE = 0.035; // probabilité par case candidate et par tick
const BUSH_MAX_NEIGHBORS = 3; // au-delà, la lisière est déjà assez touffue

const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

const isAdult = (t, now) => t && now - t.plantedAt >= GROW_TIME * 1000;

export function adultNeighbors(map, x, z, now = Date.now()) {
  let n = 0;
  for (const [dx, dz] of N8) if (isAdult(map.trees.get(`${x + dx},${z + dz}`), now)) n++;
  return n;
}

function majesticNearby(map, x, z) {
  for (let dz = -MAJESTIC_SPACING; dz <= MAJESTIC_SPACING; dz++) {
    for (let dx = -MAJESTIC_SPACING; dx <= MAJESTIC_SPACING; dx++) {
      if ((dx || dz) && map.trees.get(`${x + dx},${z + dz}`)?.majesticAt) return true;
    }
  }
  return false;
}

// Applique une étape d'évolution ; renvoie ce qui a changé.
// blocked(x, z) : case à laisser libre (personnage) ; variantOf(x, z) : variété de l'arbre en (x, z).
export function ecologyTick(map, { blocked, variantOf }, now = Date.now(), random = Math.random) {
  const majestic = [], bushes = [];
  for (const t of map.trees.values()) {
    if (t.majesticAt || !isAdult(t, now)) continue;
    if (adultNeighbors(map, t.x, t.z, now) >= MAJESTIC_NEIGHBORS && !majesticNearby(map, t.x, t.z)) {
      t.majesticAt = now;
      majestic.push(t);
    }
  }
  // Cases libres au pied des arbres adultes : la lisière.
  const seen = new Set();
  for (const t of map.trees.values()) {
    if (!isAdult(t, now)) continue;
    for (const [dx, dz] of N8) {
      const x = t.x + dx, z = t.z + dz, key = `${x},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (map.get(x, z) !== TILE.GRASS || map.hasTree(x, z) || map.hasBush(x, z) || map.hasBridge(x, z) || blocked(x, z)) continue;
      const adults = adultNeighbors(map, x, z, now);
      if (adults < 2) continue;
      let bushNear = 0;
      for (const [ex, ez] of N8) if (map.hasBush(x + ex, z + ez)) bushNear++;
      if (bushNear >= BUSH_MAX_NEIGHBORS) continue;
      if (random() > BUSH_CHANCE * Math.min(adults, 4) / 2) continue;
      // Couleur héritée d'un arbre voisin.
      const parents = N8.map(([ex, ez]) => map.trees.get(`${x + ex},${z + ez}`)).filter((p) => isAdult(p, now));
      const parent = parents[Math.floor(random() * parents.length)];
      if (map.addBush(x, z, now, variantOf(parent.x, parent.z))) bushes.push(map.bushes.get(key));
    }
  }
  return { majestic, bushes };
}
