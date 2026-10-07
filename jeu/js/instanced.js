import * as THREE from 'three';
import { shared } from './terrain.js';

// Rendu instancié des éléments de végétation (arbres, buissons) : une InstancedMesh par forme,
// un seul matériau partagé. Chaque instance porte sa couleur, sa lueur et son balancement :
//   aSwayA = (pivot du feuillage xyz, phase), aSwayB = (point d'attache xyz, phase),
//   aMisc  = (lueur, amplitude du vent, amplitude du balancier).
// Le vent est calculé dans le vertex shader : les arbres immobiles ne coûtent rien au processeur.

const SWAY_GLSL = /* glsl */ `
attribute vec4 aSwayA;
attribute vec4 aSwayB;
attribute vec3 aMisc;
uniform float uTime;
// Rotation autour de z (angle a) puis de x (0.6 a), comme l'ancien canopy.rotation.
vec3 swayRot(vec3 v, float a, float kx) {
  float c = cos(a), s = sin(a);
  v = vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
  float b = a * kx;
  c = cos(b); s = sin(b);
  return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z);
}
vec4 swayWorld(vec3 p) {
  vec4 wp = instanceMatrix * vec4(p, 1.0);
  // Balancier des lanternes autour de leur point d'attache.
  if (aMisc.z != 0.0) {
    float sw = sin(uTime * 1.6 + aSwayB.w) * aMisc.z;
    wp.xyz = aSwayB.xyz + swayRot(wp.xyz - aSwayB.xyz, sw, 0.0);
  }
  // Vent dans le feuillage, autour du haut du tronc.
  if (aMisc.y != 0.0) {
    float a = (sin(uTime * 1.3 + aSwayA.w) * 0.035 + sin(uTime * 2.9 + aSwayA.w * 2.0) * 0.012) * aMisc.y;
    wp.xyz = aSwayA.xyz + swayRot(wp.xyz - aSwayA.xyz, a, 0.6);
  }
  return wp;
}`;

const PROJECT_GLSL = /* glsl */ `
vec4 mvPosition = modelViewMatrix * swayWorld(transformed);
gl_Position = projectionMatrix * mvPosition;`;

function patch(shader, withGlow) {
  shader.uniforms.uTime = shared.uTime;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
${SWAY_GLSL}
${withGlow ? 'varying float vGlow;' : ''}`)
    .replace('#include <project_vertex>', `${withGlow ? 'vGlow = aMisc.x;' : ''}
${PROJECT_GLSL}`);
  if (withGlow) {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vGlow;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vGlow;`);
  }
}

// Matériau unique : couleur par instance (instanceColor), lueur proportionnelle à la couleur.
export const VEG_MATERIAL = new THREE.MeshLambertMaterial({ flatShading: true });
VEG_MATERIAL.onBeforeCompile = (shader) => patch(shader, true);
VEG_MATERIAL.customProgramCacheKey = () => 'vegetation';

// Ombres portées qui suivent aussi le vent.
const DEPTH_MATERIAL = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
DEPTH_MATERIAL.onBeforeCompile = (shader) => patch(shader, false);
DEPTH_MATERIAL.customProgramCacheKey = () => 'vegetation-depth';

const ZERO4 = [0, 0, 0, 0];

// Une partie (instance) appartenant à un arbre ou un buisson. slot = -1 : pas affichée.
export class Part {
  constructor(pool) { this.pool = pool; this.slot = -1; }
}

// Réserve d'instances d'une même géométrie, à capacité croissante (doublée si besoin).
export class InstancePool {
  constructor(group, geometry, { castShadow = false, capacity = 64 } = {}) {
    this.group = group;
    this.base = geometry;
    this.castShadow = castShadow;
    this.count = 0;
    this.owners = [];
    this.alloc(capacity);
  }

  alloc(capacity) {
    const old = this.mesh;
    const geo = this.base.clone();
    const mk = (n) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.swayA = mk(4); this.swayB = mk(4); this.misc = mk(3);
    geo.setAttribute('aSwayA', this.swayA);
    geo.setAttribute('aSwayB', this.swayB);
    geo.setAttribute('aMisc', this.misc);
    const mesh = new THREE.InstancedMesh(geo, VEG_MATERIAL, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = mk(3);
    mesh.castShadow = this.castShadow;
    if (this.castShadow) mesh.customDepthMaterial = DEPTH_MATERIAL;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    if (old) {
      // Recopie des instances existantes.
      const n = this.count;
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, n * 16));
      mesh.instanceColor.array.set(old.instanceColor.array.subarray(0, n * 3));
      for (const k of ['aSwayA', 'aSwayB', 'aMisc']) {
        const a = old.geometry.getAttribute(k);
        geo.getAttribute(k).array.set(a.array.subarray(0, n * a.itemSize));
      }
      this.group.remove(old);
      old.geometry.dispose();
      old.dispose();
    }
    this.mesh = mesh;
    this.capacity = capacity;
    mesh.count = this.count;
    mesh.visible = this.count > 0;
    this.lo = 0; this.hi = this.count; // tout est à envoyer
    this.group.add(mesh);
  }

  touch(i) {
    if (i < this.lo) this.lo = i;
    if (i + 1 > this.hi) this.hi = i + 1;
  }

  // Écrit une instance (l'alloue au besoin). m : Matrix4 monde ; color : THREE.Color.
  write(part, m, color, glow, swayAmp = 0, pivot = null, phase = 0, swing = 0, attach = null, swingPhase = 0) {
    if (part.slot < 0) {
      if (this.count === this.capacity) this.alloc(this.capacity * 2);
      part.slot = this.count++;
      this.owners[part.slot] = part;
    }
    const i = part.slot;
    m.toArray(this.mesh.instanceMatrix.array, i * 16);
    const c = this.mesh.instanceColor.array;
    c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b;
    const a = this.swayA.array, b = this.swayB.array, x = this.misc.array;
    if (pivot) { a[i * 4] = pivot.x; a[i * 4 + 1] = pivot.y; a[i * 4 + 2] = pivot.z; a[i * 4 + 3] = phase; } else a.set(ZERO4, i * 4);
    if (attach) { b[i * 4] = attach.x; b[i * 4 + 1] = attach.y; b[i * 4 + 2] = attach.z; b[i * 4 + 3] = swingPhase; } else b.set(ZERO4, i * 4);
    x[i * 3] = glow; x[i * 3 + 1] = pivot ? swayAmp : 0; x[i * 3 + 2] = attach ? swing : 0;
    this.touch(i);
  }

  // Retire une instance : la dernière prend sa place.
  remove(part) {
    const i = part.slot;
    if (i < 0) return;
    part.slot = -1;
    const last = --this.count;
    if (i !== last) {
      const moved = this.owners[last];
      moved.slot = i;
      this.owners[i] = moved;
      const im = this.mesh.instanceMatrix.array;
      im.copyWithin(i * 16, last * 16, last * 16 + 16);
      const c = this.mesh.instanceColor.array;
      c.copyWithin(i * 3, last * 3, last * 3 + 3);
      for (const attr of [this.swayA, this.swayB, this.misc]) {
        const s = attr.itemSize;
        attr.array.copyWithin(i * s, last * s, last * s + s);
      }
      this.touch(i);
    }
    this.owners[last] = undefined;
  }

  // Envoie au GPU la plage modifiée depuis la dernière image.
  flush() {
    const mesh = this.mesh;
    mesh.count = this.count;
    mesh.visible = this.count > 0;
    if (this.hi <= this.lo) return;
    const lo = this.lo, n = Math.min(this.hi, this.count) - lo;
    if (n > 0) {
      for (const attr of [mesh.instanceMatrix, mesh.instanceColor, this.swayA, this.swayB, this.misc]) {
        const s = attr.itemSize;
        attr.clearUpdateRanges();
        attr.addUpdateRange(lo * s, n * s);
        attr.needsUpdate = true;
      }
    }
    this.lo = Infinity; this.hi = 0;
  }
}
