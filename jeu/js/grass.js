import * as THREE from 'three';
import { TILE } from './map.js';
import { LAND_TOP, shared, cornerGrassiness, chamferedCorners, CHAMFER, CORNERS } from './terrain.js';

const BLADES_PER_TILE = 48;

// Brin d'herbe effilé : 2 segments, base en y=0, pointe en y=1.
function bladeGeometry() {
  const w = 0.5;
  const pos = [
    -w, 0, 0, w, 0, 0, w * 0.7, 0.5, 0,
    -w, 0, 0, w * 0.7, 0.5, 0, -w * 0.7, 0.5, 0,
    -w * 0.7, 0.5, 0, w * 0.7, 0.5, 0, 0, 1, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Normales vers le ciel : éclairage doux et homogène, comme un tapis.
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3));
  return g;
}

function bladeMaterial() {
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uHero = shared.uHero;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform vec3 uHero;
varying float vH;`)
      .replace('#include <project_vertex>', `
vH = position.y;
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec2 root = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
#else
  vec2 root = vec2(0.0);
#endif
float bend = vH * vH;
// Vent : rafales lentes qui traversent la prairie.
float gust = sin(uTime * 1.3 + root.x * 0.55 + root.y * 0.35) * 0.5 + 0.5;
float flutter = sin(uTime * 4.7 + root.x * 7.0 + root.y * 5.0);
vec2 wind = vec2(0.8, 0.45) * (gust * 0.07 + flutter * 0.012);
// Le personnage écarte les brins sur son passage.
vec2 away = root - uHero.xz;
float d = length(away);
float push = (1.0 - smoothstep(0.08, 0.5, d)) * 0.16;
wind += away / max(d, 0.001) * push;
mvPosition.xz += wind * bend;
mvPosition.y -= (push * 0.6 + gust * 0.015) * bend;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vH;`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
normal = normalize(vNormal); // pas d'inversion sur la face arrière`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= mix(vec3(0.62, 0.75, 0.6), vec3(1.3, 1.25, 1.05), vH);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.55, 0.75, 0.45) * pow(vH, 3.0) * 0.18;`);
  };
  return mat;
}

function rand(x, z, i, k) {
  const s = Math.sin(x * 127.1 + z * 311.7 + i * 74.7 + k * 19.3) * 43758.5453;
  return s - Math.floor(s);
}

const PALETTE = [0x7cc27a, 0x92d08a, 0xa8dc96, 0x6fb67a, 0xb9e6a2].map((c) => new THREE.Color(c));

// Prairie de brins instanciés, recalculée quand la carte change.
export class GrassField {
  constructor(scene) {
    this.scene = scene;
    this.geometry = bladeGeometry();
    this.material = bladeMaterial();
    this.mesh = null;
  }

  rebuild(map) {
    const matrices = [], colors = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let z = 0; z < map.height; z++) for (let x = 0; x < map.width; x++) {
      const t = map.get(x, z);
      if (t === TILE.WATER) continue;
      const g = [cornerGrassiness(map, x, z), cornerGrassiness(map, x, z + 1), cornerGrassiness(map, x + 1, z + 1), cornerGrassiness(map, x + 1, z)];
      if (t === TILE.DIRT && Math.max(...g) === 0) continue;
      const cut = chamferedCorners(map, x, z);
      for (let i = 0; i < BLADES_PER_TILE; i++) {
        const u = 0.04 + rand(x, z, i, 1) * 0.92, v = 0.04 + rand(x, z, i, 2) * 0.92;
        // Pas de brins dans les coins arrondis.
        if (cut.some((c, ci) => c && Math.abs(u - CORNERS[ci][0]) + Math.abs(v - CORNERS[ci][1]) < CHAMFER + 0.06)) continue;
        // Densité : interpolation de la proportion d'herbe des coins, cœur à la valeur de la tuile.
        const corners = (g[0] * (1 - u) + g[3] * u) * (1 - v) + (g[1] * (1 - u) + g[2] * u) * v;
        const core = 1 - Math.min(1, Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2 / 0.55) ** 2;
        const own = t === TILE.GRASS ? 1 : 0;
        const density = own * core + corners * (1 - core);
        if (rand(x, z, i, 3) > density * 1.1 - 0.05) continue;
        const h = 0.08 + rand(x, z, i, 4) * 0.11;
        q.setFromAxisAngle(up, rand(x, z, i, 5) * Math.PI);
        s.set(0.045 + rand(x, z, i, 6) * 0.03, h, 1);
        p.set(x + u, LAND_TOP, z + v);
        m.compose(p, q, s);
        matrices.push(m.clone());
        colors.push(PALETTE[Math.floor(rand(x, z, i, 7) * PALETTE.length)]);
      }
    }
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); }
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, matrices.length));
    this.mesh.count = matrices.length;
    matrices.forEach((mat, i) => { this.mesh.setMatrixAt(i, mat); this.mesh.setColorAt(i, colors[i]); });
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
    this.scene.add(this.mesh);
  }
}
