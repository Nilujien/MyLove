import * as THREE from 'three';
import { LAND_TOP, shared } from './terrain.js';
import { VARIANTS } from './trees.js';
import { InstancePool, Part } from './instanced.js';

// Durée (s) pour qu'un buisson atteigne sa taille adulte, puis fleurisse.
export const BUSH_GROW_TIME = 45;

const colors = new Map();
function col(color, darken = 1) {
  const key = `${color}-${darken}`;
  if (!colors.has(key)) colors.set(key, new THREE.Color(color).multiplyScalar(darken));
  return colors.get(key);
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

const _body = new THREE.Matrix4(), _m = new THREE.Matrix4(), _w = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const _z = new THREE.Vector3(0, 0, 1), _o = new THREE.Vector3();

// Petit buisson de lisière, aux couleurs de la variété d'arbre voisine.
class Bush {
  constructor(data, pools) {
    this.data = data;
    const r = rand(data.x * 92837111 ^ data.z * 689287499 ^ (data.bornAt | 0));
    const v = VARIANTS[data.variant % VARIANTS.length];
    // Légèrement décentré dans la case, pour un aspect naturel.
    this.pos = new THREE.Vector3(data.x + 0.5 + (r() - 0.5) * 0.3, LAND_TOP, data.z + 0.5 + (r() - 0.5) * 0.3);
    this.rotY = r() * Math.PI * 2;
    const n = 3 + Math.floor(r() * 3);
    const blobs = [];
    this.blobs = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r();
      const d = i === 0 ? 0 : 0.1 + r() * 0.06;
      const s = (i === 0 ? 0.17 : 0.11 + r() * 0.05) * (0.9 + r() * 0.25);
      const p = new THREE.Vector3(Math.cos(a) * d, s * 0.75, Math.sin(a) * d);
      const sc = new THREE.Vector3(s, s * 0.8, s);
      const b = new Part(pools.blob);
      b.color = col(v.leaves[i % 3], 0.85);
      b.glow = 0.1;
      b.local = new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(_e.set(r() * 3, r() * 3, r() * 3)), sc);
      this.blobs.push(b);
      blobs.push({ p, sc });
    }
    this.flowers = [];
    for (let i = 0; i < 7; i++) {
      const b = blobs[Math.floor(r() * blobs.length)];
      const dir = new THREE.Vector3(r() - 0.5, r() * 0.9 + 0.2, r() - 0.5).normalize();
      const f = new Part(pools.flower);
      f.color = col(v.blossom);
      f.glow = 1.1;
      f.pos = b.p.clone().add(dir.multiply(b.sc));
      f.delay = r() * 0.7;
      this.flowers.push(f);
    }
    this.phase = r() * 6;
    this.wiggle = 0;
    this.settled = false;
  }

  dispose() {
    for (const p of this.blobs) p.pool.remove(p);
    for (const p of this.flowers) p.pool.remove(p);
  }

  // Le vent est dans le shader : on ne réécrit le buisson que s'il pousse, fleurit ou est froissé.
  update(now, t, hero, dt) {
    const d = Math.hypot(hero.x - this.pos.x, hero.z - this.pos.z);
    const near = d < 0.45;
    if (this.settled && !near) return;
    const g = bushGrowth(this.data, now);
    const s = (0.25 + 0.75 * smooth(0, 1, g)) * 1.3;
    // Le personnage froisse le buisson en le traversant.
    this.wiggle += ((near ? 1 : 0) - this.wiggle) * Math.min(1, dt * 8);
    if (!near && this.wiggle < 0.002) this.wiggle = 0;
    const sq = 1 - this.wiggle * 0.25;
    const shake = Math.sin(t * 14) * 0.08 * this.wiggle;
    _body.makeRotationY(this.rotY).setPosition(this.pos);
    _body.multiply(_m.compose(_o, _q.setFromAxisAngle(_z, shake),
      _s.set(s * (1 + this.wiggle * 0.12), s * sq, s * (1 + this.wiggle * 0.12))));
    for (const b of this.blobs) b.pool.write(b, _w.multiplyMatrices(_body, b.local), b.color, b.glow, 1.1, this.pos, this.phase);
    const bloom = g >= 1 ? Math.min(1, (now - this.data.bornAt - BUSH_GROW_TIME * 1000) / 3000) : 0;
    for (const f of this.flowers) {
      const k = smooth(f.delay * 0.6, f.delay * 0.6 + 0.4, bloom);
      if (k > 0.001) f.pool.write(f, _w.multiplyMatrices(_body, _m.makeScale(k, k, k).setPosition(f.pos)), f.color, f.glow, 1.1, this.pos, this.phase);
      else f.pool.remove(f);
    }
    this.settled = g >= 1 && bloom >= 1 && this.wiggle === 0;
  }
}

export class Shrubs {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.items = new Map();
    this.pools = {
      blob: new InstancePool(this.group, BLOB, { castShadow: true }),
      flower: new InstancePool(this.group, FLOWER),
    };
  }

  // Réconciliation par valeur : un buisson identique adopte le nouvel objet de données.
  sync(map) {
    for (const [key, b] of this.items) {
      const data = map.bushes.get(key);
      if (!data || data.bornAt !== b.data.bornAt || data.variant !== b.data.variant) { b.dispose(); this.items.delete(key); }
      else if (data !== b.data) { b.data = data; b.settled = false; }
    }
    for (const [key, data] of map.bushes) {
      if (this.items.has(key)) continue;
      this.items.set(key, new Bush(data, this.pools));
    }
  }

  update(dt, hero) {
    const now = Date.now(), t = shared.uTime.value;
    for (const b of this.items.values()) b.update(now, t, hero, dt);
    for (const p of Object.values(this.pools)) p.flush();
  }
}
