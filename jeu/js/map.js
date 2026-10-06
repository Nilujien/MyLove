// Données de la carte : une grille stricte de tuiles.
export const TILE = { GRASS: 0, DIRT: 1, WATER: 2 };
export const TILE_NAMES = { [TILE.GRASS]: 'Herbe', [TILE.DIRT]: 'Terre', [TILE.WATER]: 'Eau' };

export class GameMap {
  constructor(width, height, fill = TILE.GRASS) {
    this.width = width;
    this.height = height;
    this.tiles = new Uint8Array(width * height).fill(fill);
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

  isWalkable(x, z) {
    const t = this.get(x, z);
    return t === TILE.GRASS || t === TILE.DIRT;
  }

  // Plus court chemin sur la grille (4 directions), BFS.
  findPath(sx, sz, tx, tz) {
    if (!this.isWalkable(tx, tz)) return null;
    const w = this.width;
    const prev = new Int32Array(w * this.height).fill(-2);
    const start = sz * w + sx;
    const goal = tz * w + tx;
    prev[start] = -1;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      if (cur === goal) break;
      const cx = cur % w, cz = (cur / w) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (!this.isWalkable(nx, nz)) continue;
        const ni = nz * w + nx;
        if (prev[ni] !== -2) continue;
        prev[ni] = cur;
        queue.push(ni);
      }
    }
    if (prev[goal] === -2) return null;
    const path = [];
    for (let c = goal; c !== start; c = prev[c]) path.push([c % w, (c / w) | 0]);
    return path.reverse();
  }

  toJSON() {
    return { version: 1, width: this.width, height: this.height, tiles: Array.from(this.tiles) };
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
    return map;
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
