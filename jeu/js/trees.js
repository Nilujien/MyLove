import * as THREE from 'three';
import { LAND_TOP } from './terrain.js';
import { InstancePool, Part } from './instanced.js';

// Durée (s) pour qu'une graine devienne un arbre adulte. La croissance suit le temps réel,
// elle continue donc même quand le jeu est fermé.
export const GROW_TIME = 90;

// Étapes affichées dans l'interface.
export const STAGES = [
  { from: 0, name: 'Graine' },
  { from: 0.12, name: 'Pousse' },
  { from: 0.35, name: 'Jeune arbre' },
  { from: 0.75, name: 'Arbre' },
  { from: 1, name: 'Arbre en fleurs' },
];
// Rondins obtenus en coupant un arbre, selon sa croissance (0 : trop jeune).
export function logsFor(g, majestic = false) {
  if (majestic) return 6;
  if (g < 0.35) return 0;
  if (g < 0.75) return 1;
  return g < 1 ? 2 : 3;
}

export function stageOf(g) {
  let s = STAGES[0];
  for (const st of STAGES) if (g >= st.from) s = st;
  return s;
}

export const VARIANTS = [
  { leaves: [0x7fd6a4, 0x9fe6b8, 0x6cc495], blossom: 0xfff4c8 }, // menthe
  { leaves: [0x6fc7c9, 0x8fdcd8, 0x5ab3ba], blossom: 0xe6f2ff }, // turquoise
  { leaves: [0xf2b6d2, 0xf8cfe2, 0xe9a3c4], blossom: 0xffffff }, // cerisier
  { leaves: [0xbfaef0, 0xd4c8f7, 0xa999e4], blossom: 0xfff0fb }, // lavande
];

// Couleurs partagées (espace de travail linéaire, comme les anciens matériaux).
const colors = new Map();
function col(hex) {
  if (!colors.has(hex)) colors.set(hex, new THREE.Color(hex));
  return colors.get(hex);
}

const GEO = {
  trunk: new THREE.CylinderGeometry(0.045, 0.085, 0.6, 6).translate(0, 0.3, 0),
  blob: new THREE.IcosahedronGeometry(1, 1),
  seed: new THREE.SphereGeometry(0.06, 8, 6).scale(1, 0.7, 1),
  mound: new THREE.SphereGeometry(0.2, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.3, 1),
  stem: new THREE.CylinderGeometry(0.012, 0.018, 0.22, 5).translate(0, 0.11, 0),
  leaf: new THREE.SphereGeometry(1, 8, 6).scale(0.08, 0.015, 0.04),
  blossom: new THREE.IcosahedronGeometry(0.045, 0),
  root: new THREE.ConeGeometry(0.05, 0.3, 5).rotateZ(Math.PI / 2).translate(0.15, 0, 0),
  strand: new THREE.CylinderGeometry(0.004, 0.004, 1, 3).translate(0, -0.5, 0),
  lantern: new THREE.IcosahedronGeometry(0.04, 1),
};

// Durée (ms) de la métamorphose d'un arbre en arbre majestueux.
const MAJESTIC_GROW = 8000;
const MAX_HEIGHT_K = 1.25; // hauteur relative maximale (atteinte par les arbres majestueux)

function rand(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

// Matrices de travail réutilisées (aucune allocation par image).
const _root = new THREE.Matrix4(), _grp = new THREE.Matrix4(), _tm = new THREE.Matrix4(), _cm = new THREE.Matrix4();
const _mm = new THREE.Matrix4(), _lg = new THREE.Matrix4(), _m = new THREE.Matrix4(), _w = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1), _pivot = new THREE.Vector3(), _attach = new THREE.Vector3();
const _e = new THREE.Euler();

// Partie d'arbre : une instance d'une forme, avec sa matrice locale, sa couleur et sa lueur.
function part(pool, color, glow, local = new THREE.Matrix4()) {
  const p = new Part(pool);
  p.color = col(color);
  p.glow = glow;
  p.local = local;
  return p;
}
const trs = (x, y, z, rx, ry, rz, s) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
  new THREE.Quaternion().setFromEuler(_e.set(rx, ry, rz)), new THREE.Vector3(s, s, s));

class Tree {
  constructor(data, pools) {
    this.data = data;
    const r = rand(data.x * 73856093 ^ data.z * 19349663 ^ (data.plantedAt | 0));
    this.variantIndex = Math.floor(r() * VARIANTS.length);
    this.variant = VARIANTS[this.variantIndex];
    this.phase = r() * Math.PI * 2;
    // Hauteur : de ~60 % à 100 % du maximum, les petits arbres étant un peu plus fréquents.
    this.heightK = MAX_HEIGHT_K - r() ** 0.8 * 0.5;
    this.sizeK = 1.45 - r() * 0.4;
    // Plus de graphe de scène : seule la position de la base reste exposée (étincelles).
    this.root = { position: new THREE.Vector3(data.x + 0.5, LAND_TOP, data.z + 0.5), userData: { cell: [data.x, data.z] } };
    this.rotY = r() * Math.PI * 2;
    this.fallen = null; // { q, s } pendant l'abattage
    this.settled = false; // forme définitive écrite : plus rien à faire à chaque image
    this.parts = [];

    // Graine et monticule de terre.
    this.mound = part(pools.mound, 0x8a6a55, 0);
    this.seed = part(pools.seed, 0xd8b88a, 0.2, new THREE.Matrix4().makeTranslation(0, 0.06, 0));
    // Pousse : tige et deux feuilles.
    this.stem = part(pools.stem, 0x7dbb6a, 0);
    this.leaves = [-1, 1].map((side) => part(pools.leaf, this.variant.leaves[0], 0.15, trs(side * 0.075, 0.23, 0, 0, 0, side * 0.5, 1)));

    // Arbre : tronc et feuillage en boules.
    this.trunk = part(pools.trunk, 0x8b6b6e, 0);
    const blobs = [[0, 0.25, 0, 0.32], [0.17, 0.12, 0.08, 0.23], [-0.15, 0.14, -0.06, 0.22], [0.02, 0.42, -0.04, 0.2], [-0.05, 0.08, 0.17, 0.18]];
    const blobPositions = [];
    this.blobs = blobs.map(([x, y, z, s], i) => {
      const sc = s * (0.9 + r() * 0.2);
      const p = part(pools.blob, this.variant.leaves[i % 3], 0.12, trs(x, y, z, r() * 3, r() * 3, r() * 3, sc));
      blobPositions.push([new THREE.Vector3(x, y, z), sc]);
      return p;
    });

    // Fleurs lumineuses, qui éclosent quand l'arbre est adulte.
    this.blossoms = [];
    for (let i = 0; i < 12; i++) {
      const [c, s] = blobPositions[Math.floor(r() * blobPositions.length)];
      const dir = new THREE.Vector3(r() - 0.5, r() * 0.8 + 0.1, r() - 0.5).normalize();
      const b = part(pools.blossom, this.variant.blossom, 0.9);
      b.pos = c.clone().addScaledVector(dir, s * 0.98);
      b.delay = r() * 0.6;
      this.blossoms.push(b);
    }
    this.buildMajestic(r, pools);
    this.matured = this.growth() >= 1;
  }

  // Parure de l'arbre majestueux : couronne lumineuse, lanternes suspendues, racines.
  // Les instances ne sont allouées que lorsque l'arbre devient majestueux.
  buildMajestic(r, pools) {
    this.crown = [];
    const crownBlobs = [[0, 0.62, 0, 0.3], [0.22, 0.45, -0.12, 0.24], [-0.2, 0.5, 0.14, 0.24], [0.05, 0.85, 0.02, 0.19], [-0.26, 0.28, -0.15, 0.2], [0.26, 0.26, 0.2, 0.2]];
    crownBlobs.forEach(([x, y, z, sc], i) => {
      const s = sc * (0.9 + r() * 0.2);
      this.crown.push(part(pools.blob, this.variant.leaves[(i + 1) % 3], 0.32, trs(x, y, z, r() * 3, r() * 3, r() * 3, s)));
    });
    // Fleurs dorées sur la couronne.
    for (let i = 0; i < 10; i++) {
      const [x, y, z, sc] = crownBlobs[Math.floor(r() * crownBlobs.length)];
      const dir = new THREE.Vector3(r() - 0.5, r() * 0.8 + 0.2, r() - 0.5).normalize();
      const p = new THREE.Vector3(x, y, z).addScaledVector(dir, sc * 0.95);
      this.crown.push(part(pools.blossom, 0xffe7a8, 1.2, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)));
    }
    // Lanternes de lumière suspendues sous le feuillage.
    this.lanterns = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + r() * 0.5;
      const rad = 0.26 + r() * 0.1, len = 0.12 + r() * 0.16;
      const at = new THREE.Matrix4().makeTranslation(Math.cos(a) * rad, 0.08 + r() * 0.08, Math.sin(a) * rad);
      this.lanterns.push({
        at,
        strand: part(pools.strand, 0xd8c8b0, 0.3, new THREE.Matrix4().makeScale(1, len, 1)),
        lantern: part(pools.lantern, this.variant.blossom, 1.6, new THREE.Matrix4().makeTranslation(0, -len, 0)),
        phase: r() * 6,
      });
    }
    // Racines apparentes.
    this.roots = [];
    for (let i = 0; i < 5; i++) {
      this.roots.push(part(pools.root, 0x7d5e62, 0, trs(0, 0.02, 0, 0, (i / 5) * Math.PI * 2 + r() * 0.4, -0.25, 1)));
    }
  }

  get majestic() { return !!this.data.majesticAt; }

  majesty(now = Date.now()) {
    if (!this.data.majesticAt) return 0;
    return smooth(0, 1, (now - this.data.majesticAt) / MAJESTIC_GROW);
  }

  growth(now = Date.now()) {
    return Math.min(1, Math.max(0, (now - this.data.plantedAt) / (GROW_TIME * 1000)));
  }

  *allParts() {
    yield this.mound; yield this.seed; yield this.stem; yield* this.leaves; yield this.trunk;
    yield* this.blobs; yield* this.blossoms; yield* this.crown; yield* this.roots;
    for (const l of this.lanterns) { yield l.strand; yield l.lantern; }
  }

  // Libère toutes les instances de l'arbre.
  dispose() { for (const p of this.allParts()) p.pool.remove(p); }

  // Écrit la forme selon la croissance ; renvoie true au moment où l'arbre devient adulte.
  // Le vent est appliqué par le shader : on ne réécrit rien tant que la forme ne change pas.
  update(now) {
    const g = this.growth(now);
    const mjAt = this.data.majesticAt;
    const mj = this.majesty(now);
    const bloom = g >= 1 ? Math.min(1, (now - this.data.plantedAt - GROW_TIME * 1000) / 2500) : 0;
    const sway = !this.fallen; // pas de vent pendant la chute
    const phase = this.phase;
    const put = (p, m, amp = 0, pivot = null, swing = 0, attach = null, swingPhase = 0) =>
      p.pool.write(p, m, p.color, p.glow, amp, sway ? pivot : null, phase, swing, sway ? attach : null, swingPhase);
    const hide = (p) => p.pool.remove(p);

    // Matrice de la base : position, chute éventuelle, orientation propre.
    if (this.fallen) _root.compose(this.root.position, this.fallen.q, this.fallen.s);
    else _root.makeTranslation(this.root.position.x, this.root.position.y, this.root.position.z);
    _root.multiply(_m.makeRotationY(this.rotY));

    // Graine -> pousse -> arbre, avec de petits « pops » à chaque transition.
    const seedS = 1 - smooth(0.32, 0.45, g);
    if (seedS > 0.001) {
      _grp.copy(_root).scale(_one.set(seedS, seedS, seedS));
      put(this.mound, _grp);
      if (g < 0.12) put(this.seed, _w.multiplyMatrices(_grp, this.seed.local)); // la graine disparaît quand la pousse sort
      else hide(this.seed);
    } else { hide(this.mound); hide(this.seed); }

    const sproutIn = easeOutBack(smooth(0.08, 0.18, g));
    const sproutOut = 1 - smooth(0.3, 0.42, g);
    const sproutS = sproutIn * sproutOut * (1 + smooth(0.12, 0.3, g) * 0.6);
    if (sproutS > 0.001) {
      _grp.copy(_root).scale(_one.set(sproutS, sproutS, sproutS));
      _pivot.setFromMatrixPosition(_grp);
      put(this.stem, _grp, 3, _pivot);
      for (const l of this.leaves) put(l, _w.multiplyMatrices(_grp, l.local), 3, _pivot);
    } else { hide(this.stem); for (const l of this.leaves) hide(l); }

    const treeS = g < 0.3 ? 0 : 0.25 + 0.75 * smooth(0.3, 1, g);
    const pop = easeOutBack(smooth(0.3, 0.4, g));
    if (treeS > 0) {
      const k = treeS * pop * this.sizeK * (1 + 0.55 * mj);
      const hk = this.heightK + (MAX_HEIGHT_K - this.heightK) * mj;
      _tm.copy(_root).scale(_one.set(k, k * hk * (1 + 0.15 * mj), k));
      put(this.trunk, _w.copy(_tm).scale(_one.set(1 + 0.45 * mj, 1, 1 + 0.45 * mj)));
      _cm.multiplyMatrices(_tm, _m.makeTranslation(0, 0.55, 0));
      _pivot.setFromMatrixPosition(_cm);
      for (const b of this.blobs) put(b, _w.multiplyMatrices(_cm, b.local), 1, _pivot);
      for (const b of this.blossoms) {
        const kb = easeOutBack(smooth(b.delay * 0.6, b.delay * 0.6 + 0.4, bloom));
        if (kb > 0.001) put(b, _w.multiplyMatrices(_cm, _m.makeScale(kb, kb, kb).setPosition(b.pos)), 1, _pivot);
        else hide(b);
      }
      if (mj > 0.001) {
        const e = Math.max(0.001, easeOutBack(mj));
        _mm.copy(_cm).scale(_one.set(e, e, e));
        for (const c of this.crown) put(c, _w.multiplyMatrices(_mm, c.local), 1, _pivot);
        for (const l of this.lanterns) {
          _lg.multiplyMatrices(_mm, l.at);
          _attach.setFromMatrixPosition(_lg);
          put(l.strand, _w.multiplyMatrices(_lg, l.strand.local), 1, _pivot, 0.18, _attach, l.phase);
          put(l.lantern, _w.multiplyMatrices(_lg, l.lantern.local), 1, _pivot, 0.18, _attach, l.phase);
        }
        _grp.copy(_tm).scale(_one.set(e, e, e));
        for (const p of this.roots) put(p, _w.multiplyMatrices(_grp, p.local));
      } else this.hideMajestic();
    } else {
      hide(this.trunk);
      for (const b of this.blobs) hide(b);
      for (const b of this.blossoms) hide(b);
      this.hideMajestic();
    }

    this.mjAt = mjAt;
    this.settled = !this.fallen && g >= 1 && bloom >= 1 && (!mjAt || mj >= 1);
    if (g >= 1 && !this.matured) { this.matured = true; return true; }
    return false;
  }

  hideMajestic() {
    for (const p of this.crown) p.pool.remove(p);
    for (const p of this.roots) p.pool.remove(p);
    for (const l of this.lanterns) { l.strand.pool.remove(l.strand); l.lantern.pool.remove(l.lantern); }
  }
}

// Ensemble des arbres de la carte : une InstancedMesh par forme, quel que soit le nombre d'arbres.
export class Forest {
  constructor(scene, sparkles) {
    this.scene = scene;
    this.sparkles = sparkles;
    this.trees = new Map();
    this.falling = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    const pool = (geo, castShadow = false) => new InstancePool(this.group, geo, { castShadow });
    this.pools = {
      mound: pool(GEO.mound), seed: pool(GEO.seed), stem: pool(GEO.stem), leaf: pool(GEO.leaf),
      trunk: pool(GEO.trunk, true), blob: pool(GEO.blob, true), blossom: pool(GEO.blossom),
      root: pool(GEO.root), strand: pool(GEO.strand), lantern: pool(GEO.lantern),
    };
  }

  flush() { for (const p of Object.values(this.pools)) p.flush(); }

  // Abat un arbre (déjà retiré de la carte) : il tremble, bascule à l'opposé de (dx, dz) puis disparaît.
  fell(x, z, dx, dz) {
    const key = `${x},${z}`;
    const tree = this.trees.get(key);
    if (!tree) return;
    this.trees.delete(key);
    tree.fallen = { q: new THREE.Quaternion(), s: new THREE.Vector3(1, 1, 1) };
    this.falling.push({ tree, t: 0, axis: new THREE.Vector3(dz, 0, -dx).normalize() });
  }

  // Réconciliation par valeur : un arbre identique (même case, même date de plantation)
  // adopte le nouvel objet de données au lieu d'être recréé (annulation, import, rechargement).
  sync(map) {
    for (const [key, tree] of this.trees) {
      const data = map.trees.get(key);
      if (!data || data.plantedAt !== tree.data.plantedAt) { tree.dispose(); this.trees.delete(key); }
      else if (data !== tree.data) { tree.data = data; tree.settled = false; }
    }
    const now = Date.now();
    for (const [key, data] of map.trees) {
      if (this.trees.has(key)) continue;
      const tree = new Tree(data, this.pools);
      this.trees.set(key, tree);
      tree.update(now);
    }
    this.flush();
  }

  get(x, z) { return this.trees.get(`${x},${z}`); }

  update(dt = 0) {
    const now = Date.now();
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      const shake = f.t < 0.3 ? Math.sin(f.t * 60) * 0.06 * (1 - f.t / 0.3) : 0;
      const k = Math.min(1, Math.max(0, (f.t - 0.3) / 0.55));
      f.tree.fallen.q.setFromAxisAngle(f.axis, k * k * 1.45 + shake);
      if (f.t > 0.95) f.tree.fallen.s.setScalar(Math.max(0.001, 1 - (f.t - 0.95) / 0.35));
      if (f.t > 1.3) {
        const p = f.tree.root.position;
        this.sparkles.burst(p.x, p.y + 0.15, p.z, 30, { spread: 0.7, up: 0.7, life: 1, size: 8, colors: this.sparkles.woodColors });
        f.tree.dispose();
        this.falling.splice(i, 1);
      } else f.tree.update(now);
    }
    for (const tree of this.trees.values()) {
      const mjAt = tree.data.majesticAt;
      // Aura des arbres majestueux : poussières dorées qui s'élèvent du feuillage.
      if (mjAt && Math.random() < dt * 2.5 * tree.majesty(now)) {
        const p = tree.root.position, a = Math.random() * Math.PI * 2, r = 0.2 + Math.random() * 0.5;
        this.sparkles.burst(p.x + Math.cos(a) * r, p.y + 0.9 + Math.random() * 0.9, p.z + Math.sin(a) * r, 1,
          { spread: 0.05, up: 0.35, life: 2.2, size: 7, colors: this.sparkles.goldColors });
      }
      if (tree.settled && tree.mjAt === mjAt) continue; // arbre immobile : rien à recalculer
      if (tree.update(now)) {
        const p = tree.root.position;
        this.sparkles.burst(p.x, p.y + 0.8, p.z, 45, { spread: 0.6, up: 0.9, life: 1.8, size: 10 });
      }
    }
    this.flush();
  }
}
