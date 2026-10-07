import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAND_TOP } from './terrain.js';

const WOOD = [0xc79a6e, 0xb88a5f, 0xd2a87c].map((c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
const DARK = new THREE.MeshLambertMaterial({ color: 0x7d5a45, flatShading: true });
const PLANK = new THREE.BoxGeometry(0.17, 0.05, 0.96);
const BEAM = new THREE.BoxGeometry(1.0, 0.06, 0.07);
const POST = new THREE.CylinderGeometry(0.035, 0.04, 1, 6).translate(0, 0.5, 0);
const RAIL = new THREE.BoxGeometry(1.0, 0.03, 0.03);
// Pont terminé : toutes les pièces fusionnées en un seul maillage, couleurs par sommet.
const MERGED = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const DECK = LAND_TOP - 0.025; // centre des planches : le dessus affleure la terre

function hash(x, z, k) {
  const s = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

// Pont de bois sur une case d'eau ; axis = sens de la traversée.
class Bridge {
  constructor(data, animate) {
    this.data = data;
    this.root = new THREE.Group();
    this.root.position.set(data.x + 0.5, 0, data.z + 0.5);
    // Construit dans le repère « traversée selon x », puis tourné si besoin.
    if (data.axis === 'z') this.root.rotation.y = Math.PI / 2;
    this.planks = [];
    for (let i = 0; i < 5; i++) {
      const p = new THREE.Mesh(PLANK, WOOD[Math.floor(hash(data.x, data.z, i) * 3)]);
      p.position.set(-0.4 + i * 0.2, DECK + (hash(data.x, data.z, i + 9) - 0.5) * 0.01, (hash(data.x, data.z, i + 5) - 0.5) * 0.04);
      p.rotation.y = (hash(data.x, data.z, i + 3) - 0.5) * 0.06;
      p.castShadow = p.receiveShadow = true;
      p.userData.y = p.position.y;
      p.userData.delay = 0.08 * i;
      this.root.add(p);
      this.planks.push(p);
    }
    this.frame = new THREE.Group();
    for (const side of [-1, 1]) {
      const beam = new THREE.Mesh(BEAM, DARK);
      beam.position.set(0, DECK - 0.055, side * 0.4);
      const rail = new THREE.Mesh(RAIL, DARK);
      rail.position.set(0, LAND_TOP + 0.24, side * 0.45);
      this.frame.add(beam, rail);
      for (const end of [-1, 1]) {
        const post = new THREE.Mesh(POST, DARK);
        post.position.set(end * 0.45, 0, side * 0.45);
        post.scale.y = LAND_TOP + 0.27;
        post.castShadow = true;
        this.frame.add(post);
      }
    }
    this.root.add(this.frame);
    this.t = animate ? 0 : 10;
    this.merged = null;
    if (animate) this.update(0);
    else this.merge();
  }

  // Remplace les pièces séparées (utiles pour l'animation) par un maillage unique.
  merge() {
    this.frame.scale.set(1, 1, 1);
    for (const p of this.planks) { p.visible = true; p.position.y = p.userData.y; }
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const m = new THREE.Matrix4();
    const parts = [];
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
      const c = o.material.color, n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(g);
    });
    const geometry = mergeGeometries(parts);
    for (const g of parts) g.dispose();
    this.root.clear();
    this.merged = new THREE.Mesh(geometry, MERGED);
    this.merged.castShadow = this.merged.receiveShadow = true;
    this.root.add(this.merged);
    this.planks = []; this.frame = null;
  }

  dispose() { this.merged?.geometry.dispose(); }

  // Animation de construction : les poteaux montent, puis les planches tombent une à une.
  update(dt) {
    if (this.t >= 10) return;
    this.t += dt;
    const f = Math.min(1, this.t / 0.3);
    this.frame.scale.set(1, Math.max(0.001, f * f * (3 - 2 * f)), 1);
    for (const p of this.planks) {
      const k = Math.min(1, Math.max(0, (this.t - 0.25 - p.userData.delay) / 0.22));
      p.visible = k > 0;
      p.position.y = p.userData.y + (1 - k * k) * 0.6;
    }
    if (this.t > 1.2) { this.t = 10; this.merge(); }
  }
}

export class Bridges {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.items = new Map();
  }

  // animateKey : clé "x,z" du pont tout juste construit (pour l'animer).
  // Comparaison par valeur (case + sens) : annuler ou importer ne recrée pas les ponts inchangés.
  sync(map, animateKey = null) {
    for (const [key, b] of this.items) {
      const d = map.bridges.get(key);
      if (d && d.axis === b.data.axis) { b.data = d; continue; }
      this.group.remove(b.root);
      b.dispose();
      this.items.delete(key);
    }
    for (const [key, data] of map.bridges) {
      if (this.items.has(key)) continue;
      const b = new Bridge(data, key === animateKey);
      this.items.set(key, b);
      this.group.add(b.root);
    }
  }

  update(dt) { for (const b of this.items.values()) b.update(dt); }
}
