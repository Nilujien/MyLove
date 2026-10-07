import * as THREE from 'three';
import { TILE } from './map.js';
import { NOISE_GLSL } from './noise.glsl.js';

// Hauteurs (en unités de tuile).
export const LAND_TOP = 0.6;
export const WATER_LEVEL = 0.3;
const FLOOR = 0;
const BASE = -1;
const LIP = 0.08; // épaisseur de la couche d'herbe visible sur les falaises
const CHAMFER = 0.3; // arrondi des coins extérieurs
const INNER = 0.55; // taille du cœur uni de chaque tuile
const WATER_RES = 3; // sommets d'eau par tuile
const SHORE_MAX = 3; // distance (en tuiles) au-delà de laquelle l'eau est « profonde »

// Types de surface, transmis au shader du terrain.
const K_TOP = 0, K_LIP = 1, K_WALL = 2, K_FLOOR = 3;

const WALL_TOP = new THREE.Color(0x9a6a48);
const WALL_BOTTOM = new THREE.Color(0x4a2e2a);

// Horloge et soleil partagés par tous les shaders.
export const shared = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
  uHero: { value: new THREE.Vector3() },
};

// Constructeur de géométrie non indexée (facettes plates), dans des tableaux typés réutilisés.
// Les sommets sont d'abord posés dans des « registres » (set), puis assemblés en triangles (tri/quad) :
// aucune allocation par sommet ni par triangle.
const REG = 8; // x, y, z, r, g, b, herbe, type
class GeoBuilder {
  constructor() {
    this.reg = new Float32Array(32 * REG);
    this.cap = 0; this.n = 0;
    this.grow(8192);
  }
  grow(cap) {
    const pos = new Float32Array(cap * 3), nor = new Float32Array(cap * 3);
    const col = new Float32Array(cap * 3), surf = new Float32Array(cap * 2);
    if (this.cap) { pos.set(this.pos); nor.set(this.nor); col.set(this.col); surf.set(this.surf); }
    this.pos = pos; this.nor = nor; this.col = col; this.surf = surf; this.cap = cap;
  }
  reset() { this.n = 0; }
  // Registre i : position, herbe (0..1), type de surface, couleur (murs).
  set(i, x, y, z, g, k, c = WALL_TOP) {
    const r = this.reg, o = i * REG;
    r[o] = x; r[o + 1] = y; r[o + 2] = z;
    r[o + 3] = c.r; r[o + 4] = c.g; r[o + 5] = c.b;
    r[o + 6] = g; r[o + 7] = k;
  }
  tri(a, b, c) {
    if (this.n + 3 > this.cap) this.grow(this.cap * 2);
    const r = this.reg, ao = a * REG, bo = b * REG, co = c * REG;
    // Normale de face, calculée comme computeVertexNormals() sur une géométrie non indexée.
    const cbx = r[co] - r[bo], cby = r[co + 1] - r[bo + 1], cbz = r[co + 2] - r[bo + 2];
    const abx = r[ao] - r[bo], aby = r[ao + 1] - r[bo + 1], abz = r[ao + 2] - r[bo + 2];
    let nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const { pos, nor, col, surf } = this;
    for (let s = 0; s < 3; s++) {
      const o = (s === 0 ? ao : s === 1 ? bo : co), v = this.n++;
      const v3 = v * 3, v2 = v * 2;
      pos[v3] = r[o]; pos[v3 + 1] = r[o + 1]; pos[v3 + 2] = r[o + 2];
      nor[v3] = nx; nor[v3 + 1] = ny; nor[v3 + 2] = nz;
      col[v3] = r[o + 3]; col[v3 + 1] = r[o + 4]; col[v3 + 2] = r[o + 5];
      surf[v2] = r[o + 6]; surf[v2 + 1] = r[o + 7];
    }
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  build() {
    const g = new THREE.BufferGeometry(), n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3));
    g.setAttribute('surf', new THREE.BufferAttribute(this.surf.slice(0, n * 2), 2));
    return g;
  }
}

// Directions des 4 bords d'une tuile, dans l'ordre des coins c0..c3
// (c0=(x,z) c1=(x,z+1) c2=(x+1,z+1) c3=(x+1,z)) : ouest, sud, est, nord.
export const EDGE_DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]];
export const CORNERS = [[0, 0], [0, 1], [1, 1], [1, 0]];

const EXPOSE_NONE = 0, EXPOSE_WATER = 1, EXPOSE_VOID = 2;

// Proportion d'herbe parmi les tuiles de terre qui partagent un coin de la grille.
export function cornerGrassiness(map, cx, cz) {
  let grass = 0, land = 0;
  for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
    const t = map.get(cx + dx, cz + dz);
    if (t === TILE.GRASS) { grass++; land++; } else if (t === TILE.DIRT) land++;
  }
  return land ? grass / land : 1;
}

// Coins chanfreinés d'une tuile de terre (true quand les deux bords voisins donnent sur l'eau).
export function chamferedCorners(map, x, z) {
  const water = EDGE_DIRS.map(([dx, dz]) => map.get(x + dx, z + dz) === TILE.WATER);
  return CORNERS.map((_, i) => water[(i + 3) % 4] && water[i]);
}
export { CHAMFER };

function landMaterial() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 surf;
varying vec2 vSurf;
varying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vSurf = surf;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
varying vec2 vSurf;
varying vec3 vWPos;
${NOISE_GLSL}
vec3 grassColor(vec2 p) {
  float n1 = fbm(p * 0.9);
  float n2 = fbm(p * 5.0 + 7.0);
  vec3 g = mix(vec3(0.30, 0.56, 0.36), vec3(0.56, 0.80, 0.48), smoothstep(0.25, 0.75, n1));
  g = mix(g, vec3(0.80, 0.92, 0.62), smoothstep(0.55, 0.85, n2) * 0.45);
  g *= 0.9 + 0.2 * vnoise(p * 34.0);
  // Petites fleurs pâles, éparses.
  float fl = smoothstep(0.965, 0.99, vnoise(p * 13.0 + 3.1));
  g = mix(g, mix(vec3(0.95, 0.85, 1.0), vec3(1.0, 0.95, 0.75), vnoise(p * 3.0)), fl);
  return lin(g);
}
vec3 dirtColor(vec2 p) {
  vec3 d = mix(vec3(0.58, 0.46, 0.38), vec3(0.78, 0.66, 0.52), fbm(p * 2.5));
  d *= 0.88 + 0.22 * vnoise(p * 24.0);
  d = mix(d, vec3(0.78, 0.70, 0.62), smoothstep(0.82, 0.9, vnoise(p * 11.0)) * 0.7);
  return lin(d);
}
float caustics(vec2 p, float t) {
  float a = vnoise(p * 3.2 + vec2(t * 0.35, t * 0.2));
  float b = vnoise(p * 3.9 - vec2(t * 0.25, -t * 0.3) + 5.0);
  return 1.0 - smoothstep(0.0, 0.07, abs(a - b));
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec2 wp = vWPos.xz;
vec3 extraGlow = vec3(0.0);
if (vSurf.y < 0.5) {
  float edge = vSurf.x + (fbm(wp * 4.0) - 0.5) * 0.7;
  diffuseColor.rgb = mix(dirtColor(wp), grassColor(wp), smoothstep(0.42, 0.58, edge));
} else if (vSurf.y < 1.5) {
  diffuseColor.rgb = grassColor(wp + vWPos.y) * 0.8;
} else if (vSurf.y < 2.5) {
  float strata = 0.82 + 0.22 * sin(vWPos.y * 38.0 + fbm(wp * 3.0 + vWPos.y) * 7.0);
  diffuseColor.rgb = vColor * strata * (0.9 + 0.2 * vnoise(vec2(wp.x + wp.y, vWPos.y) * 18.0));
} else {
  float ripple = 0.5 + 0.5 * sin((wp.x + wp.y) * 9.0 + fbm(wp * 2.0) * 6.0);
  diffuseColor.rgb = lin(mix(vec3(0.62, 0.62, 0.50), vec3(0.76, 0.74, 0.60), ripple * 0.6 + fbm(wp * 6.0) * 0.4));
  extraGlow = vec3(0.45, 0.8, 1.0) * caustics(wp, uTime) * 0.35;
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += extraGlow;`);
  };
  return mat;
}

function waterMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: shared.uTime,
      uSunDir: shared.uSunDir,
      uShallow: { value: new THREE.Color(0x52d6cf) },
      uDeep: { value: new THREE.Color(0x1f6aa0) },
      uSky: { value: new THREE.Color(0xd9d2ff) },
      uFoam: { value: new THREE.Color(0xf4fbff) },
      uSun: { value: new THREE.Color(0xfff0dc) },
    },
    vertexShader: /* glsl */ `
      attribute float shore;
      uniform float uTime;
      varying vec3 vW;
      varying float vShore;
      void main() {
        vec3 p = position;
        p.y += sin(p.x * 1.7 + uTime * 1.6) * 0.016 + cos(p.z * 2.1 - uTime * 1.3) * 0.012;
        vW = (modelMatrix * vec4(p, 1.0)).xyz;
        vShore = shore;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir, uShallow, uDeep, uSky, uFoam, uSun;
      varying vec3 vW;
      varying float vShore;
      ${NOISE_GLSL}
      float height(vec2 p) {
        float t = uTime;
        return sin(p.x * 1.7 + t * 1.6) * 0.016 + cos(p.y * 2.1 - t * 1.3) * 0.012
             + (fbm(p * 2.2 + vec2(t * 0.25, t * 0.18)) - 0.5) * 0.05
             + (vnoise(p * 9.0 - vec2(t * 0.6, -t * 0.4)) - 0.5) * 0.012;
      }
      void main() {
        vec2 p = vW.xz;
        float e = 0.04;
        float h = height(p);
        vec3 n = normalize(vec3(-(height(p + vec2(e, 0.0)) - h) / e, 1.0, -(height(p + vec2(0.0, e)) - h) / e));
        vec3 v = normalize(cameraPosition - vW);
        float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        float depth = smoothstep(0.0, 1.8, vShore);

        vec3 col = mix(uShallow, uDeep, depth);
        col = mix(col, uSky, clamp(fres * 0.9, 0.0, 0.7));
        // Reflet doux et éclats du soleil.
        vec3 r = reflect(-uSunDir, n);
        float rv = max(dot(r, v), 0.0);
        col += uSun * (pow(rv, 140.0) * 3.0 + pow(rv, 14.0) * 0.18);
        float sparkle = smoothstep(0.93, 1.0, vnoise(p * 22.0 + vec2(uTime * 0.9, -uTime * 0.7)))
                      * (0.5 + 0.5 * sin(uTime * 7.0 + p.x * 31.0 + p.y * 17.0));
        col += vec3(1.0, 0.97, 0.9) * sparkle * 1.6 * (0.4 + depth);

        // Écume de contact + vaguelettes qui viennent mourir sur la rive.
        float fn = vnoise(p * 7.0 + uTime * 0.35);
        float contact = (1.0 - smoothstep(0.0, 0.2, vShore)) * smoothstep(0.3, 0.6, fn + 0.3);
        float band = smoothstep(0.88, 1.0, sin(vShore * 13.0 + uTime * 2.2) * 0.5 + 0.5)
                   * (1.0 - smoothstep(0.1, 0.85, vShore)) * smoothstep(0.35, 0.65, fn);
        float foam = clamp(contact + band * 0.8, 0.0, 1.0);
        col = mix(col, uFoam, foam * 0.85);

        float alpha = mix(0.62, 0.92, depth) + fres * 0.2 + foam * 0.5;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// Contour d'une tuile de terre (jusqu'à 8 points avec les chanfreins) : tampons réutilisés.
const PX = new Float64Array(8), PZ = new Float64Array(8), PG = new Float64Array(8), PE = new Uint8Array(8);
const EXP = new Uint8Array(4);
const _ct = new THREE.Color(), _cb = new THREE.Color();
// Registres du GeoBuilder : centre, cœur (1..8), anneau extérieur (9..16), murs et fond (20..23).
const R_CENTER = 0, R_INNER = 1, R_OUTER = 9, R_A = 20, R_B = 21, R_C = 22, R_D = 23;

// Le terrain est découpé en blocs de CHUNK × CHUNK tuiles : un Mesh par bloc (frustum culling,
// reconstruction partielle quand l'éditeur modifie quelques cases).
export const CHUNK = 8;

// Blocs touchés par une liste de cases modifiées (avec une bordure d'une tuile : la géométrie d'une
// tuile dépend de ses 8 voisines). Renvoie les indices de blocs, sans doublon.
export function chunksAround(map, cells, ncx, border = 1) {
  const seen = new Set();
  for (const [x, z] of cells) {
    const x0 = Math.max(0, x - border), x1 = Math.min(map.width - 1, x + border);
    const z0 = Math.max(0, z - border), z1 = Math.min(map.height - 1, z + border);
    for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz++) {
      for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) seen.add(cz * ncx + cx);
    }
  }
  return seen;
}

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    // Groupe des blocs de terrain. Le lancer de rayons rapporte le groupe lui-même comme objet touché
    // (voir makeChunk), comme l'ancien Mesh unique : pickCell n'a pas besoin de connaître les blocs.
    this.landMesh = new THREE.Group();
    this.landMaterial = landMaterial();
    this.chunks = []; this.ncx = 0; this.ncz = 0;
    this.builder = new GeoBuilder();
    this.waterMaterial = waterMaterial();
    this.waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMaterial);
    this.waterMesh.renderOrder = 1;
    this.waterSides = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMaterial);
    this.waterSides.renderOrder = 1;
    scene.add(this.landMesh, this.waterMesh, this.waterSides);
  }

  // Reconstruction complète (nouvelle carte, changement de taille).
  rebuild(map) {
    this.map = map;
    this.layoutChunks(map);
    for (let i = 0; i < this.chunks.length; i++) this.buildChunk(map, i);
    if (this.waterW !== map.width || this.waterH !== map.height) this.buildWaterPlane(map);
    this.computeShore(map);
    this.waterSides.geometry.dispose();
    this.waterSides.geometry = this.buildWaterSides(map);
  }

  // Reconstruction partielle : seuls les blocs qui touchent les cases modifiées (± 1 tuile),
  // l'écume autour d'elles et, si besoin, les faces latérales de l'eau.
  rebuildCells(map, cells) {
    if (map !== this.map || this.waterW !== map.width || this.waterH !== map.height) { this.rebuild(map); return; }
    if (!cells.length) return;
    for (const ci of chunksAround(map, cells, this.ncx)) this.buildChunk(map, ci);
    // Une case modifiée influe sur l'écume jusqu'à SHORE_MAX tuiles autour.
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of cells) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const R = SHORE_MAX + 1;
    this.computeShore(map, x0 - R, z0 - R, x1 + 1 + R, z1 + 1 + R);
    // Faces latérales de l'eau : seulement quand une case du bord de la carte change.
    if (cells.some(([x, z]) => x <= 0 || z <= 0 || x >= map.width - 1 || z >= map.height - 1)) {
      this.waterSides.geometry.dispose();
      this.waterSides.geometry = this.buildWaterSides(map);
    }
  }

  layoutChunks(map) {
    const ncx = Math.ceil(map.width / CHUNK), ncz = Math.ceil(map.height / CHUNK);
    if (ncx === this.ncx && ncz === this.ncz && this.chunkW === map.width && this.chunkH === map.height) return;
    for (const m of this.chunks) { this.landMesh.remove(m); m.geometry.dispose(); }
    this.chunks = [];
    this.ncx = ncx; this.ncz = ncz; this.chunkW = map.width; this.chunkH = map.height;
    for (let cz = 0; cz < ncz; cz++) for (let cx = 0; cx < ncx; cx++) {
      const x0 = cx * CHUNK, z0 = cz * CHUNK;
      this.chunks.push(this.makeChunk(x0, z0, Math.min(map.width, x0 + CHUNK), Math.min(map.height, z0 + CHUNK)));
    }
  }

  makeChunk(x0, z0, x1, z1) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.landMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { x0, z0, x1, z1 };
    // Sphère et boîte englobantes connues d'avance : du socle au dessus des tuiles.
    mesh.userData.box = new THREE.Box3(new THREE.Vector3(x0, BASE, z0), new THREE.Vector3(x1, LAND_TOP, z1));
    mesh.userData.sphere = mesh.userData.box.getBoundingSphere(new THREE.Sphere());
    const group = this.landMesh;
    mesh.raycast = function (raycaster, intersects) {
      const n = intersects.length;
      THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
      for (let i = n; i < intersects.length; i++) intersects[i].object = group;
    };
    this.landMesh.add(mesh);
    return mesh;
  }

  buildChunk(map, ci) {
    const mesh = this.chunks[ci], { x0, z0, x1, z1, box, sphere } = mesh.userData;
    const b = this.builder;
    b.reset();
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const t = map.get(x, z);
        if (t === TILE.WATER) this.buildWaterCell(b, map, x, z);
        else this.buildLandCell(b, map, x, z, t);
      }
    }
    mesh.geometry.dispose();
    const g = b.build();
    g.boundingBox = box.clone();
    g.boundingSphere = sphere.clone();
    mesh.geometry = g;
  }

  exposure(map, x, z) {
    const t = map.get(x, z);
    if (t === -1) return EXPOSE_VOID;
    return t === TILE.WATER ? EXPOSE_WATER : EXPOSE_NONE;
  }

  // Fond sableux sous l'eau (aussi visible sous les coins arrondis des tuiles de terre).
  floor(b, x, z) {
    b.set(R_A, x, FLOOR, z, 0, K_FLOOR);
    b.set(R_B, x, FLOOR, z + 1, 0, K_FLOOR);
    b.set(R_C, x + 1, FLOOR, z + 1, 0, K_FLOOR);
    b.set(R_D, x + 1, FLOOR, z, 0, K_FLOOR);
    b.quad(R_A, R_B, R_C, R_D);
  }

  buildWaterCell(b, map, x, z) {
    this.floor(b, x, z);
    // Bords de carte : la falaise descend jusqu'au socle.
    for (let e = 0; e < 4; e++) {
      const [dx, dz] = EDGE_DIRS[e];
      if (map.get(x + dx, z + dz) !== -1) continue;
      const p = CORNERS[e], q = CORNERS[(e + 1) % 4];
      this.wall(b, x + p[0], z + p[1], x + q[0], z + q[1], FLOOR, BASE, false);
    }
  }

  buildLandCell(b, map, x, z, type) {
    for (let e = 0; e < 4; e++) EXP[e] = this.exposure(map, x + EDGE_DIRS[e][0], z + EDGE_DIRS[e][1]);
    const own = type === TILE.GRASS ? 1 : 0;
    // Contour de la tuile, avec coins chanfreinés quand deux bords voisins donnent sur l'eau.
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const prevE = (i + 3) % 4, nextE = i;
      const c0 = x + CORNERS[i][0], c1 = z + CORNERS[i][1];
      if (EXP[prevE] === EXPOSE_WATER && EXP[nextE] === EXPOSE_WATER) {
        const cp = CORNERS[(i + 3) % 4], cn = CORNERS[(i + 1) % 4];
        PX[n] = c0 + (x + cp[0] - c0) * CHAMFER; PZ[n] = c1 + (z + cp[1] - c1) * CHAMFER; PG[n] = own; PE[n++] = EXPOSE_WATER;
        PX[n] = c0 + (x + cn[0] - c0) * CHAMFER; PZ[n] = c1 + (z + cn[1] - c1) * CHAMFER; PG[n] = own; PE[n++] = EXP[nextE];
      } else {
        PX[n] = c0; PZ[n] = c1; PG[n] = cornerGrassiness(map, c0, c1); PE[n++] = EXP[nextE];
      }
    }
    if (n > 4) this.floor(b, x, z);

    // Dessus : cœur à la valeur de la tuile, anneau extérieur fondu avec les voisines.
    const cx = x + 0.5, cz = z + 0.5;
    b.set(R_CENTER, cx, LAND_TOP, cz, own, K_TOP);
    for (let i = 0; i < n; i++) {
      b.set(R_INNER + i, cx + (PX[i] - cx) * INNER, LAND_TOP, cz + (PZ[i] - cz) * INNER, own, K_TOP);
      b.set(R_OUTER + i, PX[i], LAND_TOP, PZ[i], PG[i], K_TOP);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      b.tri(R_CENTER, R_INNER + i, R_INNER + j);
      b.quad(R_INNER + i, R_OUTER + i, R_OUTER + j, R_INNER + j);
    }
    // Falaises.
    for (let i = 0; i < n; i++) {
      const kind = PE[i];
      if (kind === EXPOSE_NONE) continue;
      const j = (i + 1) % n;
      this.wall(b, PX[i], PZ[i], PX[j], PZ[j], LAND_TOP, kind === EXPOSE_VOID ? BASE : FLOOR, type === TILE.GRASS);
    }
  }

  // Mur vertical orienté vers l'extérieur (le contour tourne dans le sens qui met l'extérieur à gauche).
  wall(b, px, pz, qx, qz, top, bottom, grassLip) {
    let y = top;
    if (grassLip) {
      b.set(R_A, px, y, pz, 0, K_LIP);
      b.set(R_B, px, y - LIP, pz, 0, K_LIP);
      b.set(R_C, qx, y - LIP, qz, 0, K_LIP);
      b.set(R_D, qx, y, qz, 0, K_LIP);
      b.quad(R_A, R_B, R_C, R_D);
      y -= LIP;
    }
    const h = top - BASE;
    _ct.lerpColors(WALL_BOTTOM, WALL_TOP, (y - BASE) / h);
    _cb.lerpColors(WALL_BOTTOM, WALL_TOP, (bottom - BASE) / h);
    b.set(R_A, px, y, pz, 0, K_WALL, _ct);
    b.set(R_B, px, bottom, pz, 0, K_WALL, _cb);
    b.set(R_C, qx, bottom, qz, 0, K_WALL, _cb);
    b.set(R_D, qx, y, qz, 0, K_WALL, _ct);
    b.quad(R_A, R_B, R_C, R_D);
  }

  buildWaterPlane(map) {
    const { width: w, height: h } = map;
    const g = new THREE.PlaneGeometry(w, h, w * WATER_RES, h * WATER_RES);
    g.rotateX(-Math.PI / 2);
    g.translate(w / 2, WATER_LEVEL, h / 2);
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g.setAttribute('shore', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count), 1));
    this.waterW = w; this.waterH = h;
    this.waterMesh.geometry.dispose();
    this.waterMesh.geometry = g;
    this.landMask = new Uint8Array(w * h);
  }

  // Distance de chaque sommet d'eau à la terre la plus proche : profondeur et écume.
  // Sans rectangle : tout le plan ; sinon seulement les sommets du rectangle [x0, x1] × [z0, z1] (en tuiles).
  computeShore(map, x0 = 0, z0 = 0, x1 = map.width, z1 = map.height) {
    const pos = this.waterMesh.geometry.getAttribute('position');
    const shore = this.waterMesh.geometry.getAttribute('shore');
    const R = SHORE_MAX, W = map.width, H = map.height;
    const land = this.landMask, t = map.tiles;
    for (let i = 0; i < W * H; i++) land[i] = t[i] === TILE.GRASS || t[i] === TILE.DIRT ? 1 : 0;
    // Le plan d'eau est une grille de (W·RES+1) × (H·RES+1) sommets, rangée par lignes de z.
    const NX = W * WATER_RES + 1;
    const ix0 = Math.max(0, x0 * WATER_RES), ix1 = Math.min(NX - 1, x1 * WATER_RES);
    const iz0 = Math.max(0, z0 * WATER_RES), iz1 = Math.min(H * WATER_RES, z1 * WATER_RES);
    if (ix0 > ix1 || iz0 > iz1) return;
    const arr = shore.array, P = pos.array;
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const i = iz * NX + ix;
      const px = P[i * 3], pz = P[i * 3 + 2];
      const bx = Math.floor(px), bz = Math.floor(pz);
      let best = R * R;
      for (let z = Math.max(0, bz - R); z <= Math.min(H - 1, bz + R); z++) {
        const dz = Math.max(z - pz, 0, pz - (z + 1));
        if (dz * dz >= best) continue;
        for (let x = Math.max(0, bx - R); x <= Math.min(W - 1, bx + R); x++) {
          if (!land[z * W + x]) continue;
          const dx = Math.max(x - px, 0, px - (x + 1));
          const d = dx * dx + dz * dz;
          if (d < best) best = d;
        }
      }
      arr[i] = Math.sqrt(best);
    }
    const start = iz0 * NX + ix0, end = iz1 * NX + ix1;
    // Plage ajoutée même pour un calcul complet : plusieurs appels dans une même image se cumulent.
    shore.addUpdateRange(start, end - start + 1);
    shore.needsUpdate = true;
  }

  // Faces latérales de l'eau, uniquement là où une case d'eau touche le bord de la carte.
  buildWaterSides(map) {
    const pos = [], shore = [];
    const push = (px, pz, y) => { pos.push(px, y, pz); shore.push(SHORE_MAX); };
    for (let z = 0; z < map.height; z++) for (let x = 0; x < map.width; x++) {
      if (map.get(x, z) !== TILE.WATER) continue;
      for (let e = 0; e < 4; e++) {
        const [dx, dz] = EDGE_DIRS[e];
        if (map.get(x + dx, z + dz) !== -1) continue;
        const px = x + CORNERS[e][0], pz = z + CORNERS[e][1];
        const qx = x + CORNERS[(e + 1) % 4][0], qz = z + CORNERS[(e + 1) % 4][1];
        push(px, pz, WATER_LEVEL); push(px, pz, FLOOR); push(qx, qz, FLOOR);
        push(px, pz, WATER_LEVEL); push(qx, qz, FLOOR); push(qx, qz, WATER_LEVEL);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('shore', new THREE.Float32BufferAttribute(shore, 1));
    return g;
  }

  update(dt) {
    shared.uTime.value += dt;
  }
}
