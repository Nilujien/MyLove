import * as THREE from 'three';
import { LAND_TOP, shared } from './terrain.js';

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

const mats = new Map();
function mat(color, glow = 0) {
  const key = `${color}-${glow}`;
  if (!mats.has(key)) {
    const c = new THREE.Color(color);
    mats.set(key, new THREE.MeshLambertMaterial({ color: c, flatShading: true, emissive: c.clone().multiplyScalar(glow) }));
  }
  return mats.get(key);
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

class Tree {
  constructor(data) {
    this.data = data;
    const r = rand(data.x * 73856093 ^ data.z * 19349663 ^ (data.plantedAt | 0));
    this.variantIndex = Math.floor(r() * VARIANTS.length);
    this.variant = VARIANTS[this.variantIndex];
    this.phase = r() * Math.PI * 2;
    this.heightK = 0.9 + r() * 0.35;
    this.sizeK = 1.2 + r() * 0.25;
    this.root = new THREE.Group();
    this.root.position.set(data.x + 0.5, LAND_TOP, data.z + 0.5);
    this.root.userData.cell = [data.x, data.z];
    this.root.rotation.y = r() * Math.PI * 2;

    // Graine et monticule de terre.
    this.seedGroup = new THREE.Group();
    const mound = new THREE.Mesh(GEO.mound, mat(0x8a6a55));
    const seed = new THREE.Mesh(GEO.seed, mat(0xd8b88a, 0.2));
    seed.position.y = 0.06;
    this.seedGroup.add(mound, seed);

    // Pousse : tige et deux feuilles.
    this.sprout = new THREE.Group();
    const leafMat = mat(this.variant.leaves[0], 0.15);
    this.sprout.add(new THREE.Mesh(GEO.stem, mat(0x7dbb6a)));
    for (const side of [-1, 1]) {
      const leaf = new THREE.Mesh(GEO.leaf, leafMat);
      leaf.position.set(side * 0.075, 0.23, 0);
      leaf.rotation.z = side * 0.5;
      this.sprout.add(leaf);
    }

    // Arbre : tronc et feuillage en boules.
    this.tree = new THREE.Group();
    const trunk = new THREE.Mesh(GEO.trunk, mat(0x8b6b6e));
    trunk.castShadow = true;
    this.trunk = trunk;
    this.tree.add(trunk);
    this.canopy = new THREE.Group();
    this.canopy.position.y = 0.55;
    const blobs = [[0, 0.25, 0, 0.32], [0.17, 0.12, 0.08, 0.23], [-0.15, 0.14, -0.06, 0.22], [0.02, 0.42, -0.04, 0.2], [-0.05, 0.08, 0.17, 0.18]];
    const blobPositions = [];
    blobs.forEach(([x, y, z, s], i) => {
      const m = new THREE.Mesh(GEO.blob, mat(this.variant.leaves[i % 3], 0.12));
      m.position.set(x, y, z);
      m.scale.setScalar(s * (0.9 + r() * 0.2));
      m.rotation.set(r() * 3, r() * 3, r() * 3);
      m.castShadow = true;
      this.canopy.add(m);
      blobPositions.push([m.position, m.scale.x]);
    });
    this.tree.add(this.canopy);

    // Fleurs lumineuses, qui éclosent quand l'arbre est adulte.
    this.blossoms = [];
    const bMat = mat(this.variant.blossom, 0.9);
    for (let i = 0; i < 12; i++) {
      const [c, s] = blobPositions[Math.floor(r() * blobPositions.length)];
      const dir = new THREE.Vector3(r() - 0.5, r() * 0.8 + 0.1, r() - 0.5).normalize();
      const b = new THREE.Mesh(GEO.blossom, bMat);
      b.position.copy(c).addScaledVector(dir, s * 0.98);
      b.userData.delay = r() * 0.6;
      this.canopy.add(b);
      this.blossoms.push(b);
    }
    this.buildMajestic(r, blobPositions);
    this.root.add(this.seedGroup, this.sprout, this.tree);
    this.matured = this.growth() >= 1;
  }

  // Parure de l'arbre majestueux : couronne lumineuse, lanternes suspendues, racines.
  buildMajestic(r, blobPositions) {
    this.crown = new THREE.Group();
    const glow = (c) => mat(c, 0.32);
    const crownBlobs = [[0, 0.62, 0, 0.3], [0.22, 0.45, -0.12, 0.24], [-0.2, 0.5, 0.14, 0.24], [0.05, 0.85, 0.02, 0.19], [-0.26, 0.28, -0.15, 0.2], [0.26, 0.26, 0.2, 0.2]];
    crownBlobs.forEach(([x, y, z, sc], i) => {
      const m = new THREE.Mesh(GEO.blob, glow(this.variant.leaves[(i + 1) % 3]));
      m.position.set(x, y, z);
      m.scale.setScalar(sc * (0.9 + r() * 0.2));
      m.rotation.set(r() * 3, r() * 3, r() * 3);
      m.castShadow = true;
      this.crown.add(m);
    });
    // Fleurs dorées sur la couronne.
    const gold = mat(0xffe7a8, 1.2);
    for (let i = 0; i < 10; i++) {
      const [x, y, z, sc] = crownBlobs[Math.floor(r() * crownBlobs.length)];
      const dir = new THREE.Vector3(r() - 0.5, r() * 0.8 + 0.2, r() - 0.5).normalize();
      const b = new THREE.Mesh(GEO.blossom, gold);
      b.position.set(x, y, z).addScaledVector(dir, sc * 0.95);
      this.crown.add(b);
    }
    this.canopy.add(this.crown);
    // Lanternes de lumière suspendues sous le feuillage.
    this.lanterns = new THREE.Group();
    const lanternMat = mat(this.variant.blossom, 1.6);
    const strandMat = mat(0xd8c8b0, 0.3);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + r() * 0.5;
      const rad = 0.26 + r() * 0.1, len = 0.12 + r() * 0.16;
      const g = new THREE.Group();
      g.position.set(Math.cos(a) * rad, 0.08 + r() * 0.08, Math.sin(a) * rad);
      const strand = new THREE.Mesh(GEO.strand, strandMat);
      strand.scale.y = len;
      const lantern = new THREE.Mesh(GEO.lantern, lanternMat);
      lantern.position.y = -len;
      g.add(strand, lantern);
      g.userData.phase = r() * 6;
      this.lanterns.add(g);
    }
    this.canopy.add(this.lanterns);
    // Racines apparentes.
    this.roots = new THREE.Group();
    const rootMat = mat(0x7d5e62);
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(GEO.root, rootMat);
      m.rotation.y = (i / 5) * Math.PI * 2 + r() * 0.4;
      m.rotation.z = -0.25;
      m.position.y = 0.02;
      this.roots.add(m);
    }
    this.tree.add(this.roots);
    for (const g of [this.crown, this.lanterns, this.roots]) g.visible = false;
  }

  get majestic() { return !!this.data.majesticAt; }

  majesty(now = Date.now()) {
    if (!this.data.majesticAt) return 0;
    return smooth(0, 1, (now - this.data.majesticAt) / MAJESTIC_GROW);
  }

  growth(now = Date.now()) {
    return Math.min(1, Math.max(0, (now - this.data.plantedAt) / (GROW_TIME * 1000)));
  }

  // Met à jour la forme selon la croissance ; renvoie true au moment où l'arbre devient adulte.
  update(now, t) {
    const g = this.growth(now);
    // Graine -> pousse -> arbre, avec de petits « pops » à chaque transition.
    const seedS = 1 - smooth(0.32, 0.45, g);
    this.seedGroup.scale.setScalar(Math.max(0.001, seedS));
    this.seedGroup.visible = seedS > 0.001;
    this.seedGroup.children[1].visible = g < 0.12; // la graine disparaît quand la pousse sort
    const sproutIn = easeOutBack(smooth(0.08, 0.18, g));
    const sproutOut = 1 - smooth(0.3, 0.42, g);
    const sproutS = sproutIn * sproutOut * (1 + smooth(0.12, 0.3, g) * 0.6);
    this.sprout.visible = sproutS > 0.001;
    this.sprout.scale.setScalar(Math.max(0.001, sproutS));
    const treeS = g < 0.3 ? 0 : 0.25 + 0.75 * smooth(0.3, 1, g);
    const pop = easeOutBack(smooth(0.3, 0.4, g));
    this.tree.visible = treeS > 0;
    const mj = this.majesty(now);
    const k = treeS * pop * this.sizeK * (1 + 0.55 * mj);
    this.tree.scale.set(k, k * this.heightK * (1 + 0.15 * mj), k);
    this.trunk.scale.set(1 + 0.45 * mj, 1, 1 + 0.45 * mj);
    for (const g of [this.crown, this.lanterns, this.roots]) {
      g.visible = mj > 0.001;
      g.scale.setScalar(Math.max(0.001, easeOutBack(mj)));
    }
    if (mj > 0) {
      for (const l of this.lanterns.children) l.rotation.z = Math.sin(t * 1.6 + l.userData.phase) * 0.18;
    }
    const bloom = g >= 1 ? Math.min(1, (now - this.data.plantedAt - GROW_TIME * 1000) / 2500) : 0;
    for (const b of this.blossoms) {
      const k = easeOutBack(smooth(b.userData.delay * 0.6, b.userData.delay * 0.6 + 0.4, bloom));
      b.visible = k > 0.001;
      b.scale.setScalar(Math.max(0.001, k));
    }
    // Balancement dans le vent.
    const sway = Math.sin(t * 1.3 + this.phase) * 0.035 + Math.sin(t * 2.9 + this.phase * 2) * 0.012;
    this.canopy.rotation.z = sway;
    this.canopy.rotation.x = sway * 0.6;
    this.sprout.rotation.z = sway * 3;
    if (g >= 1 && !this.matured) { this.matured = true; return true; }
    return false;
  }
}

// Ensemble des arbres de la carte.
export class Forest {
  constructor(scene, sparkles) {
    this.scene = scene;
    this.sparkles = sparkles;
    this.trees = new Map();
    this.falling = [];
    this.group = new THREE.Group();
    scene.add(this.group);
  }

  // Abat un arbre (déjà retiré de la carte) : il tremble, bascule à l'opposé de (dx, dz) puis disparaît.
  fell(x, z, dx, dz) {
    const key = `${x},${z}`;
    const tree = this.trees.get(key);
    if (!tree) return;
    this.trees.delete(key);
    const pivot = new THREE.Group();
    pivot.position.copy(tree.root.position);
    tree.root.position.set(0, 0, 0);
    pivot.add(tree.root);
    this.group.remove(tree.root);
    this.group.add(pivot);
    this.falling.push({ tree, pivot, t: 0, axis: new THREE.Vector3(dz, 0, -dx).normalize() });
  }

  sync(map) {
    for (const [key, tree] of this.trees) {
      if (map.trees.get(key) !== tree.data) { this.group.remove(tree.root); this.trees.delete(key); }
    }
    for (const [key, data] of map.trees) {
      if (this.trees.has(key)) continue;
      const tree = new Tree(data);
      this.trees.set(key, tree);
      this.group.add(tree.root);
    }
  }

  get(x, z) { return this.trees.get(`${x},${z}`); }

  update(dt = 0) {
    const now = Date.now(), t = shared.uTime.value;
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      const shake = f.t < 0.3 ? Math.sin(f.t * 60) * 0.06 * (1 - f.t / 0.3) : 0;
      const k = Math.min(1, Math.max(0, (f.t - 0.3) / 0.55));
      f.pivot.quaternion.setFromAxisAngle(f.axis, k * k * 1.45 + shake);
      if (f.t > 0.95) f.pivot.scale.setScalar(Math.max(0.001, 1 - (f.t - 0.95) / 0.35));
      if (f.t > 1.3) {
        const p = f.pivot.position;
        this.sparkles.burst(p.x, p.y + 0.15, p.z, 30, { spread: 0.7, up: 0.7, life: 1, size: 8, colors: this.sparkles.woodColors });
        this.group.remove(f.pivot);
        this.falling.splice(i, 1);
      }
    }
    for (const tree of this.trees.values()) {
      // Aura des arbres majestueux : poussières dorées qui s'élèvent du feuillage.
      if (tree.majestic && Math.random() < dt * 2.5 * tree.majesty(now)) {
        const p = tree.root.position, a = Math.random() * Math.PI * 2, r = 0.2 + Math.random() * 0.5;
        this.sparkles.burst(p.x + Math.cos(a) * r, p.y + 0.9 + Math.random() * 0.9, p.z + Math.sin(a) * r, 1,
          { spread: 0.05, up: 0.35, life: 2.2, size: 7, colors: this.sparkles.goldColors });
      }
      if (tree.update(now, t)) {
        const p = tree.root.position;
        this.sparkles.burst(p.x, p.y + 0.8, p.z, 45, { spread: 0.6, up: 0.9, life: 1.8, size: 10 });
      }
    }
  }
}
