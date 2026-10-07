// Données de la carte : une grille stricte de tuiles.
export const TILE = { GRASS: 0, DIRT: 1, WATER: 2 };
export const TILE_NAMES = { [TILE.GRASS]: 'Herbe', [TILE.DIRT]: 'Terre', [TILE.WATER]: 'Eau' };

export class GameMap {
  constructor(width, height, fill = TILE.GRASS) {
    this.width = width;
    this.height = height;
    this.tiles = new Uint8Array(width * height).fill(fill);
    this.trees = new Map(); // "x,z" -> { x, z, plantedAt } (horodatage en ms)
    this.bridges = new Map(); // "x,z" -> { x, z, axis } (axis : 'x' ou 'z', sens de la traversée)
    this.bushes = new Map(); // "x,z" -> { x, z, bornAt, variant } (buissons de lisière, traversables)
    // Grilles d'occupation (1 octet par case), tenues à jour avec les Maps : tests rapides sans chaîne.
    this.treeGrid = new Uint8Array(width * height);
    this.bushGrid = new Uint8Array(width * height);
    this.bridgeGrid = new Uint8Array(width * height);
  }

  hasBush(x, z) { return this.inBounds(x, z) && this.bushGrid[z * this.width + x] === 1; }

  addBush(x, z, bornAt = Date.now(), variant = 0) {
    if (!this.isLand(x, z) || this.hasTree(x, z) || this.hasBush(x, z)) return false;
    this.bushes.set(`${x},${z}`, { x, z, bornAt, variant });
    this.bushGrid[z * this.width + x] = 1;
    return true;
  }

  removeBush(x, z) {
    if (!this.hasBush(x, z)) return false;
    this.bushGrid[z * this.width + x] = 0;
    return this.bushes.delete(`${x},${z}`);
  }

  inBounds(x, z) {
    return x >= 0 && z >= 0 && x < this.width && z < this.height;
  }

  get(x, z) {
    return this.inBounds(x, z) ? this.tiles[z * this.width + x] : -1;
  }

  set(x, z, type) {
    if (!this.inBounds(x, z)) return false;
    const i = z * this.width + x;
    if (this.tiles[i] === type) return false;
    this.tiles[i] = type;
    return true;
  }

  isLand(x, z) {
    const t = this.get(x, z);
    return t === TILE.GRASS || t === TILE.DIRT;
  }

  isWalkable(x, z) {
    if (x < 0 || z < 0 || x >= this.width || z >= this.height) return false;
    const i = z * this.width + x;
    if (this.bridgeGrid[i]) return true;
    const t = this.tiles[i];
    return (t === TILE.GRASS || t === TILE.DIRT) && !this.treeGrid[i];
  }

  hasBridge(x, z) { return this.inBounds(x, z) && this.bridgeGrid[z * this.width + x] === 1; }

  canBuildBridge(x, z) { return this.get(x, z) === TILE.WATER && !this.hasBridge(x, z); }

  buildBridge(x, z, axis) {
    if (!this.canBuildBridge(x, z)) return false;
    this.bridges.set(`${x},${z}`, { x, z, axis });
    this.bridgeGrid[z * this.width + x] = 1;
    return true;
  }

  removeBridge(x, z) {
    if (!this.hasBridge(x, z)) return false;
    this.bridgeGrid[z * this.width + x] = 0;
    return this.bridges.delete(`${x},${z}`);
  }

  hasTree(x, z) { return this.inBounds(x, z) && this.treeGrid[z * this.width + x] === 1; }

  canPlant(x, z) { return this.isLand(x, z) && !this.hasTree(x, z); }

  // Une graine plantée sur un buisson le remplace.
  plant(x, z, plantedAt = Date.now(), majesticAt = 0) {
    if (!this.canPlant(x, z)) return false;
    this.removeBush(x, z);
    this.trees.set(`${x},${z}`, { x, z, plantedAt, majesticAt });
    this.treeGrid[z * this.width + x] = 1;
    return true;
  }

  removeTree(x, z) {
    if (!this.hasTree(x, z)) return false;
    this.treeGrid[z * this.width + x] = 0;
    return this.trees.delete(`${x},${z}`);
  }

  // Case marchable, par indice (sans contrôle des bornes).
  walkableAt(i) {
    if (this.bridgeGrid[i]) return true;
    const t = this.tiles[i];
    return (t === TILE.GRASS || t === TILE.DIRT) && !this.treeGrid[i];
  }

  // Plus court chemin sur la grille (4 directions), BFS ; tampons réutilisés d'un appel à l'autre.
  findPath(sx, sz, tx, tz) {
    if (!this.isWalkable(tx, tz) || !this.inBounds(sx, sz)) return null;
    const w = this.width, h = this.height, n = w * h;
    if (!this._prev || this._prev.length !== n) { this._prev = new Int32Array(n); this._queue = new Int32Array(n); }
    const prev = this._prev, queue = this._queue;
    prev.fill(-2);
    const start = sz * w + sx;
    const goal = tz * w + tx;
    prev[start] = -1;
    queue[0] = start;
    let qn = 1;
    for (let qi = 0; qi < qn; qi++) {
      const cur = queue[qi];
      if (cur === goal) break;
      const cx = cur % w, cz = (cur - cx) / w;
      // Voisins dans le même ordre qu'avant : +x, -x, +z, -z.
      let ni = cur + 1;
      if (cx + 1 < w && prev[ni] === -2 && this.walkableAt(ni)) { prev[ni] = cur; queue[qn++] = ni; }
      ni = cur - 1;
      if (cx > 0 && prev[ni] === -2 && this.walkableAt(ni)) { prev[ni] = cur; queue[qn++] = ni; }
      ni = cur + w;
      if (cz + 1 < h && prev[ni] === -2 && this.walkableAt(ni)) { prev[ni] = cur; queue[qn++] = ni; }
      ni = cur - w;
      if (cz > 0 && prev[ni] === -2 && this.walkableAt(ni)) { prev[ni] = cur; queue[qn++] = ni; }
    }
    if (prev[goal] === -2) return null;
    const path = [];
    for (let c = goal; c !== start; c = prev[c]) path.push([c % w, (c / w) | 0]);
    return path.reverse();
  }

  toJSON() {
    return {
      version: 4, width: this.width, height: this.height, tiles: Array.from(this.tiles),
      trees: [...this.trees.values()].map(({ x, z, plantedAt, majesticAt }) => [x, z, plantedAt, majesticAt || 0]),
      bushes: [...this.bushes.values()].map(({ x, z, bornAt, variant }) => [x, z, bornAt, variant]),
      bridges: [...this.bridges.values()].map(({ x, z, axis }) => [x, z, axis]),
    };
  }

  static fromJSON(data) {
    if (!data || !Number.isInteger(data.width) || !Number.isInteger(data.height)) {
      throw new Error('Carte invalide');
    }
    const map = new GameMap(data.width, data.height);
    if (!Array.isArray(data.tiles) || data.tiles.length !== map.tiles.length) {
      throw new Error('Carte invalide : nombre de tuiles incorrect');
    }
    map.tiles.set(data.tiles.map((t) => (t in TILE_NAMES ? t : TILE.GRASS)));
    for (const tree of Array.isArray(data.trees) ? data.trees : []) {
      const [x, z, plantedAt, majesticAt] = tree;
      if (Number.isInteger(x) && Number.isInteger(z) && Number.isFinite(plantedAt)) {
        map.plant(x, z, plantedAt, Number.isFinite(majesticAt) ? majesticAt : 0);
      }
    }
    for (const bush of Array.isArray(data.bushes) ? data.bushes : []) {
      const [x, z, bornAt, variant] = bush;
      if (Number.isInteger(x) && Number.isInteger(z) && Number.isFinite(bornAt)) map.addBush(x, z, bornAt, variant | 0);
    }
    for (const bridge of Array.isArray(data.bridges) ? data.bridges : []) {
      const [x, z, axis] = bridge;
      if (Number.isInteger(x) && Number.isInteger(z)) map.buildBridge(x, z, axis === 'x' ? 'x' : 'z');
    }
    return map;
  }

  // Copie agrandie, contenu centré ; renvoie aussi le décalage appliqué.
  expanded(width, height, fill = TILE.GRASS) {
    const ox = Math.floor((width - this.width) / 2), oz = Math.floor((height - this.height) / 2);
    const m = new GameMap(width, height, fill);
    for (let z = 0; z < this.height; z++) for (let x = 0; x < this.width; x++) m.set(x + ox, z + oz, this.get(x, z));
    for (const t of this.trees.values()) m.plant(t.x + ox, t.z + oz, t.plantedAt, t.majesticAt);
    for (const b of this.bushes.values()) m.addBush(b.x + ox, b.z + oz, b.bornAt, b.variant);
    for (const b of this.bridges.values()) m.buildBridge(b.x + ox, b.z + oz, b.axis);
    return { map: m, ox, oz };
  }

  // Génère des îles avec un bruit de valeur lissé.
  static random(width, height, seed = Math.random() * 1e9) {
    const map = new GameMap(width, height);
    const rand = mulberry32(seed | 0);
    const grid = 6;
    const gw = Math.ceil(width / grid) + 2, gh = Math.ceil(height / grid) + 2;
    const lattice = Array.from({ length: gw * gh }, () => rand());
    const smooth = (t) => t * t * (3 - 2 * t);
    const sample = (x, z) => {
      const fx = x / grid, fz = z / grid;
      const ix = Math.floor(fx), iz = Math.floor(fz);
      const tx = smooth(fx - ix), tz = smooth(fz - iz);
      const v = (a, b) => lattice[b * gw + a];
      const top = v(ix, iz) * (1 - tx) + v(ix + 1, iz) * tx;
      const bot = v(ix, iz + 1) * (1 - tx) + v(ix + 1, iz + 1) * tx;
      return top * (1 - tz) + bot * tz;
    };
    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        const n = sample(x, z);
        let t = TILE.GRASS;
        if (n < 0.33) t = TILE.WATER;
        else if (n > 0.72) t = TILE.DIRT;
        map.set(x, z, t);
      }
    }
    return map;
  }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
