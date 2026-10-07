import * as THREE from 'three';
import { LAND_TOP, shared } from './terrain.js';
import { VARIANTS } from './trees.js';

// Durée (s) pour qu'un buisson atteigne sa taille adulte, puis fleurisse.
export const BUSH_GROW_TIME = 45;

const mats = new Map();
function mat(color, glow = 0, darken = 1) {
  const key = `${color}-${glow}-${darken}`;
  if (!mats.has(key)) {
    const c = new THREE.Color(color).multiplyScalar(darken);
    mats.set(key, new THREE.MeshLambertMaterial({ color: c, flatShading: true, emissive: c.clone().multiplyScalar(glow) }));
  }
  return mats.get(key);
}
const BLOB = new THREE.IcosahedronGeometry(1, 1);
const FLOWER = new THREE.IcosahedronGeometry(0.03, 0);

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

export function bushGrowth(data, now = Date.now()) {
  return Math.min(1, Math.max(0, (now - data.bornAt) / (BUSH_GROW_TIME * 1000)));
}

// Petit buisson de lisière, aux couleurs de la variété d'arbre voisine.
class Bush {
  constructor(data) {
    this.data = data;
    const r = rand(data.x * 92837111 ^ data.z * 689287499 ^ (data.bornAt | 0));
    const v = VARIANTS[data.variant % VARIANTS.length];
    this.root = new THREE.Group();
    // Légèrement décentré dans la case, pour un aspect naturel.
    this.root.position.set(data.x + 0.5 + (r() - 0.5) * 0.3, LAND_TOP, data.z + 0.5 + (r() - 0.5) * 0.3);
    this.root.rotation.y = r() * Math.PI * 2;
    this.body = new THREE.Group();
    const n = 3 + Math.floor(r() * 3);
    const blobs = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r();
      const d = i === 0 ? 0 : 0.1 + r() * 0.06;
      const s = (i === 0 ? 0.17 : 0.11 + r() * 0.05) * (0.9 + r() * 0.25);
      const m = new THREE.Mesh(BLOB, mat(v.leaves[i % 3], 0.1, 0.85));
      m.position.set(Math.cos(a) * d, s * 0.75, Math.sin(a) * d);
      m.scale.set(s, s * 0.8, s);
      m.rotation.set(r() * 3, r() * 3, r() * 3);
      m.castShadow = true;
      this.body.add(m);
      blobs.push(m);
    }
    this.flowers = [];
    const fMat = mat(v.blossom, 1.1);
    for (let i = 0; i < 7; i++) {
      const b = blobs[Math.floor(r() * blobs.length)];
      const dir = new THREE.Vector3(r() - 0.5, r() * 0.9 + 0.2, r() - 0.5).normalize();
      const f = new THREE.Mesh(FLOWER, fMat);
      f.position.copy(b.position).add(dir.multiply(b.scale));
      f.userData.delay = r() * 0.7;
      this.body.add(f);
      this.flowers.push(f);
    }
    this.root.add(this.body);
    this.phase = r() * 6;
    this.wiggle = 0;
  }

  update(now, t, hero, dt) {
    const g = bushGrowth(this.data, now);
    const s = (0.25 + 0.75 * smooth(0, 1, g)) * 1.3;
    // Le personnage froisse le buisson en le traversant.
    const d = Math.hypot(hero.x - this.root.position.x, hero.z - this.root.position.z);
    const target = d < 0.45 ? 1 : 0;
    this.wiggle += (target - this.wiggle) * Math.min(1, dt * 8);
    const sq = 1 - this.wiggle * 0.25;
    this.body.scale.set(s * (1 + this.wiggle * 0.12), s * sq, s * (1 + this.wiggle * 0.12));
    this.body.rotation.z = Math.sin(t * 1.4 + this.phase) * 0.04 + Math.sin(t * 14) * 0.08 * this.wiggle;
    const bloom = g >= 1 ? Math.min(1, (now - this.data.bornAt - BUSH_GROW_TIME * 1000) / 3000) : 0;
    for (const f of this.flowers) {
      const k = smooth(f.userData.delay * 0.6, f.userData.delay * 0.6 + 0.4, bloom);
      f.visible = k > 0.001;
      f.scale.setScalar(Math.max(0.001, k));
    }
  }
}

export class Shrubs {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.items = new Map();
  }

  sync(map) {
    for (const [key, b] of this.items) {
      if (map.bushes.get(key) !== b.data) { this.group.remove(b.root); this.items.delete(key); }
    }
    for (const [key, data] of map.bushes) {
      if (this.items.has(key)) continue;
      const b = new Bush(data);
      this.items.set(key, b);
      this.group.add(b.root);
    }
  }

  update(dt, hero) {
    const now = Date.now(), t = shared.uTime.value;
    for (const b of this.items.values()) b.update(now, t, hero, dt);
  }
}
