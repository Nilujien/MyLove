import * as THREE from 'three';
import { shared, LAND_TOP } from './terrain.js';

// Poussières de lumière qui flottent au-dessus de l'île.
export class Motes {
  constructor(scene, count = 420) {
    this.count = count;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3), seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: shared.uTime,
        uCenter: { value: new THREE.Vector2() },
        uScale: { value: 1 },
        uPixel: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform float uTime, uScale, uPixel;
        uniform vec2 uCenter;
        varying float vAlpha;
        varying vec3 vCol;
        void main() {
          float t = uTime * (0.15 + seed.w * 0.2);
          float rise = fract(seed.z + t * 0.12);
          // Motif fixe dans le monde, répété autour du centre de la vue.
          const float SPAN = 36.0;
          vec2 base = seed.xy * SPAN;
          base += SPAN * floor((uCenter - base) / SPAN + 0.5);
          vec3 p = vec3(base.x, ${LAND_TOP.toFixed(2)} + 0.1 + rise * 2.6, base.y);
          float edge = 1.0 - smoothstep(SPAN * 0.32, SPAN * 0.48, length(base - uCenter));
          p.x += sin(t * 2.0 + seed.z * 20.0) * 0.4;
          p.z += cos(t * 1.7 + seed.x * 20.0) * 0.4;
          float twinkle = 0.55 + 0.45 * sin(uTime * (1.5 + seed.w * 3.0) + seed.x * 40.0);
          vAlpha = twinkle * edge * smoothstep(0.0, 0.15, rise) * (1.0 - smoothstep(0.7, 1.0, rise));
          vCol = mix(vec3(1.0, 0.92, 0.7), seed.w > 0.5 ? vec3(0.75, 0.95, 1.0) : vec3(1.0, 0.8, 0.95), seed.z);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          // Plafonnée : à fort zoom, de très gros points coûtent cher en remplissage.
          gl_PointSize = min((4.0 + seed.w * 7.0) * uScale, 24.0) * uPixel;
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vCol;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float glow = pow(max(1.0 - d, 0.0), 2.2);
          gl_FragColor = vec4(vCol * glow * vAlpha * 1.6, 1.0);
        }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  setCenter(x, z) { this.material.uniforms.uCenter.value.set(x, z); }
  setView(zoom, pixelRatio) {
    this.material.uniforms.uScale.value = zoom;
    this.material.uniforms.uPixel.value = pixelRatio;
  }
}
