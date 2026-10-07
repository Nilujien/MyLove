import * as THREE from 'three';

const MAX = 600;
const MAX_POINT = 28; // taille maximale d'un point (px, avant l'échelle)
const MAX_PIXELS = 64; // taille maximale affichée (px physiques), quel que soit le zoom
const DEFAULTS = {};

// Gerbes d'étincelles lumineuses (plantation, arbre adulte).
export class Sparkles {
  constructor(scene) {
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX); // vie restante (s)
    this.maxLife = new Float32Array(MAX).fill(1);
    this.col = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.next = 0;
    this.alive = 0; // nombre de particules vivantes (approx. haute : recalculé à chaque image)
    this.colorDirty = false;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute vec3 color;
        uniform float uScale;
        varying vec3 vCol;
        void main() {
          vCol = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(size * uScale, ${MAX_PIXELS.toFixed(1)});
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          gl_FragColor = vec4(vCol * pow(max(1.0 - d, 0.0), 2.0), 1.0);
        }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
    this.colors = [new THREE.Color(0xfff2c4), new THREE.Color(0xc8f7d8), new THREE.Color(0xffd0ec)];
    this.goldColors = [new THREE.Color(0xffe6a0), new THREE.Color(0xfff6d8), new THREE.Color(0xffd27a)];
    this.woodColors = [new THREE.Color(0xe0b080), new THREE.Color(0xfff0c8), new THREE.Color(0xc8f0c8)];
    this.waterColors = [new THREE.Color(0xbff4ff), new THREE.Color(0x8fe0f0), new THREE.Color(0xffffff)];
  }

  setScale(s) { this.material.uniforms.uScale.value = s; }

  burst(x, y, z, count = 30, opts = DEFAULTS) {
    const spread = opts.spread ?? 0.35, up = opts.up ?? 1.2, life = opts.life ?? 1.2;
    // Taille tirée jusqu'à ×1,5 : bornée à MAX_POINT.
    const size = Math.min(opts.size ?? 9, MAX_POINT / 1.5), colors = opts.colors ?? this.colors;
    const pos = this.pos, vel = this.vel, col = this.col;
    for (let n = 0; n < count; n++) {
      const i = this.next; this.next = (this.next + 1) % MAX;
      const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
      const ca = Math.cos(a), sa = Math.sin(a), k = i * 3;
      pos[k] = x + ca * r * 0.4; pos[k + 1] = y + Math.random() * 0.2; pos[k + 2] = z + sa * r * 0.4;
      vel[k] = ca * r * 1.5; vel[k + 1] = up * (0.4 + Math.random() * 0.8); vel[k + 2] = sa * r * 1.5;
      this.maxLife[i] = this.life[i] = life * (0.6 + Math.random() * 0.6);
      this.size[i] = size * (0.5 + Math.random());
      const c = colors[(Math.random() * colors.length) | 0];
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
    }
    this.alive += count;
    this.colorDirty = true; // couleurs envoyées une seule fois, à l'image suivante
  }

  update(dt) {
    if (this.alive <= 0 && !this.dirty) return;
    let alive = 0;
    // Rétrécissement en fin de vie, indépendant de la cadence d'affichage.
    const shrink = Math.pow(0.92, dt * 60);
    const damp = 1 - dt * 1.5, fall = dt * 0.6;
    const pos = this.pos, vel = this.vel, life = this.life, size = this.size;
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) { size[i] = 0; continue; }
      alive++;
      life[i] -= dt;
      const k = i * 3;
      vel[k + 1] -= fall;
      vel[k] *= damp; vel[k + 2] *= damp;
      pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt; pos[k + 2] += vel[k + 2] * dt;
      if (life[i] < 0.3 * this.maxLife[i]) size[i] *= shrink;
      if (life[i] <= 0) size[i] = 0;
    }
    this.alive = alive;
    // Une dernière mise à jour après la mort de la dernière particule (tailles à zéro).
    if (!alive && !this.dirty) return;
    this.dirty = alive > 0;
    const g = this.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('size').needsUpdate = true;
    if (this.colorDirty) { g.getAttribute('color').needsUpdate = true; this.colorDirty = false; }
  }
}
