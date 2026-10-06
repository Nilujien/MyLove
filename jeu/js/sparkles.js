import * as THREE from 'three';

const MAX = 600;

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
          gl_PointSize = size * uScale;
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
  }

  setScale(s) { this.material.uniforms.uScale.value = s; }

  burst(x, y, z, count = 30, { spread = 0.35, up = 1.2, life = 1.2, size = 9 } = {}) {
    for (let n = 0; n < count; n++) {
      const i = this.next; this.next = (this.next + 1) % MAX;
      const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
      this.pos.set([x + Math.cos(a) * r * 0.4, y + Math.random() * 0.2, z + Math.sin(a) * r * 0.4], i * 3);
      this.vel.set([Math.cos(a) * r * 1.5, up * (0.4 + Math.random() * 0.8), Math.sin(a) * r * 1.5], i * 3);
      this.maxLife[i] = this.life[i] = life * (0.6 + Math.random() * 0.6);
      this.size[i] = size * (0.5 + Math.random());
      this.colors[(Math.random() * this.colors.length) | 0].toArray(this.col, i * 3);
    }
  }

  update(dt) {
    let alive = false;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      alive = true;
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] -= dt * 0.6;
      this.vel[k] *= 1 - dt * 1.5; this.vel[k + 2] *= 1 - dt * 1.5;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      const f = Math.max(0, this.life[i] / this.maxLife[i]);
      this.size[i] *= f > 0.3 ? 1 : 0.92;
    }
    if (!alive && !this.dirty) return;
    this.dirty = alive;
    for (const name of ['position', 'size']) this.geometry.getAttribute(name).needsUpdate = true;
    this.geometry.getAttribute('color').needsUpdate = true;
  }
}
