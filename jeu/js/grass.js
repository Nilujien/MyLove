import * as THREE from 'three';
import { TILE } from './map.js';
import { LAND_TOP, shared, cornerGrassiness, chamferedCorners, CHAMFER, CORNERS, CHUNK, chunksAround } from './terrain.js';

const BLADES_PER_TILE = 22;
const MAX_PER_CHUNK = CHUNK * CHUNK * BLADES_PER_TILE;
// Débordement maximal d'un brin hors de sa case : hauteur, vent et poussée du personnage.
const BLADE_REACH = 0.45;

// Brin d'herbe effilé : 2 segments, base en y=0, pointe en y=1 (5 sommets indexés, 3 triangles).
function bladeGeometry() {
  const w = 0.5;
  const pos = [-w, 0, 0, w, 0, 0, w * 0.7, 0.5, 0, -w * 0.7, 0.5, 0, 0, 1, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Normales vers le ciel : éclairage doux et homogène, comme un tapis.
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 3, 2, 4]);
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

// Tampons partagés pour construire un bloc.
const S_MAT = new Float32Array(MAX_PER_CHUNK * 16);
const S_COL = new Float32Array(MAX_PER_CHUNK * 3);
const S_OWNER = new Uint8Array(MAX_PER_CHUNK);
const T_G = new Float32Array(CHUNK * CHUNK * 4); // proportion d'herbe des 4 coins de chaque case
const T_CUT = new Uint8Array(CHUNK * CHUNK * 4); // coins chanfreinés
const T_OK = new Int8Array(CHUNK * CHUNK); // -1 : pas d'herbe ; sinon 1 (herbe) ou 0 (terre)
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Prairie de brins instanciés, découpée en blocs de CHUNK × CHUNK cases (un InstancedMesh par bloc,
// avec sa sphère englobante : les blocs hors champ ne sont pas dessinés).
// Dans un bloc, les brins sont rangés « par rang » (le brin n° i de chaque case, puis le n° i+1…) :
// n'en dessiner que les premiers (setDensity) clairsème la prairie uniformément.
export class GrassField {
  constructor(scene) {
    this.scene = scene;
    this.geometry = bladeGeometry();
    this.material = bladeMaterial();
    this.group = new THREE.Group();
    scene.add(this.group);
    this.chunks = []; this.ncx = 0; this.ncz = 0;
    this.density = 1;
  }

  // Reconstruction complète.
  rebuild(map) {
    this.map = map;
    this.layout(map);
    for (let i = 0; i < this.chunks.length; i++) this.buildChunk(map, i);
  }

  // Reconstruction des seuls blocs touchant les cases modifiées (± 1 case : coins et chanfreins).
  rebuildCells(map, cells) {
    if (map !== this.map || this.w !== map.width || this.h !== map.height) { this.rebuild(map); return; }
    for (const ci of chunksAround(map, cells, this.ncx)) this.buildChunk(map, ci);
  }

  layout(map) {
    if (this.w === map.width && this.h === map.height) return;
    for (const c of this.chunks) if (c.mesh) { this.group.remove(c.mesh); c.mesh.dispose(); }
    this.w = map.width; this.h = map.height;
    this.ncx = Math.ceil(map.width / CHUNK); this.ncz = Math.ceil(map.height / CHUNK);
    this.chunks = [];
    for (let cz = 0; cz < this.ncz; cz++) for (let cx = 0; cx < this.ncx; cx++) {
      const x0 = cx * CHUNK, z0 = cz * CHUNK;
      const x1 = Math.min(map.width, x0 + CHUNK), z1 = Math.min(map.height, z0 + CHUNK);
      const sphere = new THREE.Sphere(
        new THREE.Vector3((x0 + x1) / 2, LAND_TOP + 0.1, (z0 + z1) / 2),
        Math.hypot((x1 - x0) / 2, (z1 - z0) / 2, 0.1) + BLADE_REACH,
      );
      this.chunks.push({ x0, z0, x1, z1, sphere, mesh: null, n: 0, base: null, owner: null, hidden: new Uint8Array(CHUNK * CHUNK) });
    }
  }

  buildChunk(map, ci) {
    const c = this.chunks[ci], { x0, z0, x1, z1 } = c;
    const cw = x1 - x0;
    // Données de chaque case du bloc.
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const l = (z - z0) * cw + (x - x0);
      const t = map.get(x, z);
      c.hidden[l] = map.hasTree(x, z) ? 1 : 0;
      T_OK[l] = -1;
      if (t === TILE.WATER) continue;
      const g0 = cornerGrassiness(map, x, z), g1 = cornerGrassiness(map, x, z + 1);
      const g2 = cornerGrassiness(map, x + 1, z + 1), g3 = cornerGrassiness(map, x + 1, z);
      if (t === TILE.DIRT && Math.max(g0, g1, g2, g3) === 0) continue;
      T_G[l * 4] = g0; T_G[l * 4 + 1] = g1; T_G[l * 4 + 2] = g2; T_G[l * 4 + 3] = g3;
      const cut = chamferedCorners(map, x, z);
      for (let k = 0; k < 4; k++) T_CUT[l * 4 + k] = cut[k] ? 1 : 0;
      T_OK[l] = t === TILE.GRASS ? 1 : 0;
    }
    let n = 0;
    for (let i = 0; i < BLADES_PER_TILE; i++) {
      for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const l = (z - z0) * cw + (x - x0);
        const own = T_OK[l];
        if (own < 0) continue;
        const u = 0.04 + rand(x, z, i, 1) * 0.92, v = 0.04 + rand(x, z, i, 2) * 0.92;
        // Pas de brins dans les coins arrondis.
        let inCut = false;
        for (let k = 0; k < 4; k++) {
          if (T_CUT[l * 4 + k] && Math.abs(u - CORNERS[k][0]) + Math.abs(v - CORNERS[k][1]) < CHAMFER + 0.06) { inCut = true; break; }
        }
        if (inCut) continue;
        // Densité : interpolation de la proportion d'herbe des coins, cœur à la valeur de la tuile.
        const g = l * 4;
        const corners = (T_G[g] * (1 - u) + T_G[g + 3] * u) * (1 - v) + (T_G[g + 1] * (1 - u) + T_G[g + 2] * u) * v;
        const core = 1 - Math.min(1, Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2 / 0.55) ** 2;
        const density = own * core + corners * (1 - core);
        if (rand(x, z, i, 3) > density * 1.1 - 0.05) continue;
        const h = 0.08 + rand(x, z, i, 4) * 0.11;
        _q.setFromAxisAngle(UP, rand(x, z, i, 5) * Math.PI);
        _s.set(0.05 + rand(x, z, i, 6) * 0.035, h, 1);
        _p.set(x + u, LAND_TOP, z + v);
        _m.compose(_p, _q, _s);
        _m.toArray(S_MAT, n * 16);
        PALETTE[Math.floor(rand(x, z, i, 7) * PALETTE.length)].toArray(S_COL, n * 3);
        S_OWNER[n++] = l;
      }
    }
    c.n = n;
    c.base = S_MAT.slice(0, n * 16);
    c.owner = S_OWNER.slice(0, n);
    // InstancedMesh réutilisé tant que sa capacité suffit.
    if (!c.mesh || c.mesh.userData.capacity < n) {
      if (c.mesh) { this.group.remove(c.mesh); c.mesh.dispose(); }
      const cap = Math.min(MAX_PER_CHUNK, Math.max(1, n + 64));
      const mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.userData.capacity = cap;
      mesh.boundingSphere = c.sphere;
      mesh.receiveShadow = false;
      mesh.raycast = () => {};
      this.group.add(mesh);
      c.mesh = mesh;
    }
    const mesh = c.mesh;
    const arr = mesh.instanceMatrix.array;
    arr.set(c.base);
    mesh.instanceColor.array.set(S_COL.subarray(0, n * 3));
    // Brins masqués sous les arbres.
    for (let k = 0; k < n; k++) if (c.hidden[c.owner[k]]) arr.fill(0, k * 16, k * 16 + 16);
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.clearUpdateRanges();
    mesh.instanceColor.addUpdateRange(0, n * 3);
    mesh.instanceColor.needsUpdate = true;
    this.applyCount(c);
  }

  applyCount(c) {
    c.mesh.count = Math.ceil(c.n * this.density);
    c.mesh.visible = c.mesh.count > 0;
  }

  // Proportion des brins dessinés (0..1), pour alléger la prairie vue de loin.
  setDensity(f) {
    f = Math.min(1, Math.max(0, f));
    if (f === this.density) return;
    this.density = f;
    for (const c of this.chunks) if (c.mesh) this.applyCount(c);
  }

  // Densité selon le zoom de la caméra : complète de près, clairsemée en vue d'ensemble.
  setZoom(zoom) {
    const f = zoom >= 0.6 ? 1 : Math.max(0.3, (zoom / 0.6) ** 1.5);
    this.setDensity(Math.round(f * 20) / 20);
  }

  // Masque (arbre planté) ou restaure (arbre coupé) les brins d'une case, sans tout recalculer.
  setTileHidden(x, z, hidden) {
    if (!this.chunks.length || x < 0 || z < 0 || x >= this.w || z >= this.h) return;
    const c = this.chunks[Math.floor(z / CHUNK) * this.ncx + Math.floor(x / CHUNK)];
    if (!c.mesh) return;
    const l = (z - c.z0) * (c.x1 - c.x0) + (x - c.x0);
    c.hidden[l] = hidden ? 1 : 0;
    const arr = c.mesh.instanceMatrix.array;
    let lo = -1, hi = -1;
    for (let k = 0; k < c.n; k++) {
      if (c.owner[k] !== l) continue;
      if (hidden) arr.fill(0, k * 16, k * 16 + 16);
      else arr.set(c.base.subarray(k * 16, k * 16 + 16), k * 16);
      if (lo < 0) lo = k;
      hi = k;
    }
    if (lo < 0) return;
    c.mesh.instanceMatrix.addUpdateRange(lo * 16, (hi - lo + 1) * 16);
    c.mesh.instanceMatrix.needsUpdate = true;
  }
}
