// Règles de la forêt : arbres majestueux au cœur des bois, buissons en lisière.
import { TILE } from './map.js';
import { GROW_TIME } from './trees.js';

export const MAJESTIC_NEIGHBORS = 6; // arbres adultes voisins (sur 8) pour devenir majestueux
const MAJESTIC_SPACING = 2; // pas d'autre arbre majestueux à cette distance (cases)
const BUSH_CHANCE = 0.035; // probabilité par case candidate et par tick
const BUSH_MAX_NEIGHBORS = 3; // au-delà, la lisière est déjà assez touffue

const N8X = [-1, 0, 1, -1, 1, -1, 0, 1];
const N8Z = [-1, -1, -1, 0, 0, 1, 1, 1];

const isAdult = (t, now) => t && now - t.plantedAt >= GROW_TIME * 1000;

// Données de l'arbre en (x, z) — la chaîne de clé n'est construite que si la case est occupée.
function treeAt(map, x, z) {
  return map.hasTree(x, z) ? map.trees.get(`${x},${z}`) : undefined;
}

// Grille « adulte » de la carte pour le tick courant (réutilisée d'un tick à l'autre).
let adultGrid = new Uint8Array(0);
let seenGrid = new Uint8Array(0);

export function adultNeighbors(map, x, z, now = Date.now()) {
  let n = 0;
  for (let k = 0; k < 8; k++) if (isAdult(treeAt(map, x + N8X[k], z + N8Z[k]), now)) n++;
  return n;
}

// Version rapide pendant un tick : lit la grille des adultes.
function adultCount(w, h, x, z) {
  let n = 0;
  for (let k = 0; k < 8; k++) {
    const nx = x + N8X[k], nz = z + N8Z[k];
    if (nx >= 0 && nz >= 0 && nx < w && nz < h) n += adultGrid[nz * w + nx];
  }
  return n;
}

function majesticNearby(map, x, z) {
  for (let dz = -MAJESTIC_SPACING; dz <= MAJESTIC_SPACING; dz++) {
    for (let dx = -MAJESTIC_SPACING; dx <= MAJESTIC_SPACING; dx++) {
      if ((dx || dz) && treeAt(map, x + dx, z + dz)?.majesticAt) return true;
    }
  }
  return false;
}

// Applique une étape d'évolution ; renvoie ce qui a changé.
// blocked(x, z) : case à laisser libre (personnage) ; variantOf(x, z) : variété de l'arbre en (x, z).
export function ecologyTick(map, { blocked, variantOf }, now = Date.now(), random = Math.random) {
  const majestic = [], bushes = [];
  const w = map.width, h = map.height, n = w * h;
  if (adultGrid.length !== n) { adultGrid = new Uint8Array(n); seenGrid = new Uint8Array(n); }
  adultGrid.fill(0);
  for (const t of map.trees.values()) if (isAdult(t, now) && map.inBounds(t.x, t.z)) adultGrid[t.z * w + t.x] = 1;
  for (const t of map.trees.values()) {
    if (t.majesticAt || !isAdult(t, now)) continue;
    if (adultCount(w, h, t.x, t.z) >= MAJESTIC_NEIGHBORS && !majesticNearby(map, t.x, t.z)) {
      t.majesticAt = now;
      majestic.push(t);
    }
  }
  // Cases libres au pied des arbres adultes : la lisière.
  const seen = seenGrid;
  seen.fill(0);
  for (const t of map.trees.values()) {
    if (!isAdult(t, now)) continue;
    for (let k = 0; k < 8; k++) {
      const x = t.x + N8X[k], z = t.z + N8Z[k];
      if (x < 0 || z < 0 || x >= w || z >= h) continue;
      const i = z * w + x;
      if (seen[i]) continue;
      seen[i] = 1;
      if (map.tiles[i] !== TILE.GRASS || map.treeGrid[i] || map.bushGrid[i] || map.bridgeGrid[i] || blocked(x, z)) continue;
      const adults = adultCount(w, h, x, z);
      if (adults < 2) continue;
      let bushNear = 0;
      for (let e = 0; e < 8; e++) if (map.hasBush(x + N8X[e], z + N8Z[e])) bushNear++;
      if (bushNear >= BUSH_MAX_NEIGHBORS) continue;
      if (random() > BUSH_CHANCE * Math.min(adults, 4) / 2) continue;
      // Couleur héritée d'un arbre voisin adulte (tirage parmi les voisins, dans l'ordre N8).
      let pick = Math.floor(random() * adults), parent = null;
      for (let e = 0; e < 8 && !parent; e++) {
        const px = x + N8X[e], pz = z + N8Z[e];
        if (px < 0 || pz < 0 || px >= w || pz >= h || !adultGrid[pz * w + px]) continue;
        if (pick-- === 0) parent = map.trees.get(`${px},${pz}`);
      }
      if (map.addBush(x, z, now, variantOf(parent.x, parent.z))) bushes.push(map.bushes.get(`${x},${z}`));
    }
  }
  return { majestic, bushes };
}
