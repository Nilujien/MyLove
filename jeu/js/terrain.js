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

class GeoBuilder {
  constructor() { this.pos = []; this.col = []; this.surf = []; }
  // v = { p:[x,y,z], c:Color, g:herbe 0..1, k:type }
  tri(a, b, c) {
    for (const v of [a, b, c]) {
      this.pos.push(...v.p);
      const col = v.c ?? WALL_TOP;
      this.col.push(col.r, col.g, col.b);
      this.surf.push(v.g ?? 0, v.k);
    }
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(this.surf, 2));
    g.computeVertexNormals();
    g.computeBoundingSphere();
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
  float n2 = fbm3(p * 5.0 + 7.0);
  vec3 g = mix(vec3(0.30, 0.56, 0.36), vec3(0.56, 0.80, 0.48), smoothstep(0.25, 0.75, n1));
  g = mix(g, vec3(0.80, 0.92, 0.62), smoothstep(0.55, 0.85, n2) * 0.45);
  g *= 0.9 + 0.2 * vnoise(p * 34.0);
  // Petites fleurs pâles, éparses (leur teinte n'est calculée que là où il y en a).
  float fl = smoothstep(0.965, 0.99, vnoise(p * 13.0 + 3.1));
  if (fl > 0.0) g = mix(g, mix(vec3(0.95, 0.85, 1.0), vec3(1.0, 0.95, 0.75), vnoise(p * 3.0)), fl);
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
  // Le bruit de bord décale vSurf.x d'au plus [-0.35, +0.31] : hors de cette marge, une seule
  // des deux couleurs est visible, inutile de calculer l'autre (ni le bruit de bord).
  if (vSurf.x >= 0.93) diffuseColor.rgb = grassColor(wp);
  else if (vSurf.x <= 0.11) diffuseColor.rgb = dirtColor(wp);
  else {
    float k = smoothstep(0.42, 0.58, vSurf.x + (fbm(wp * 4.0) - 0.5) * 0.7);
    if (k <= 0.0) diffuseColor.rgb = dirtColor(wp);
    else if (k >= 1.0) diffuseColor.rgb = grassColor(wp);
    else diffuseColor.rgb = mix(dirtColor(wp), grassColor(wp), k);
  }
} else if (vSurf.y < 1.5) {
  diffuseColor.rgb = grassColor(wp + vWPos.y) * 0.8;
} else if (vSurf.y < 2.5) {
  float strata = 0.82 + 0.22 * sin(vWPos.y * 38.0 + fbm(wp * 3.0 + vWPos.y) * 7.0);
  diffuseColor.rgb = vColor * strata * (0.9 + 0.2 * vnoise(vec2(wp.x + wp.y, vWPos.y) * 18.0));
} else {
  float ripple = 0.5 + 0.5 * sin((wp.x + wp.y) * 9.0 + fbm(wp * 2.0) * 6.0);
  diffuseColor.rgb = lin(mix(vec3(0.62, 0.62, 0.50), vec3(0.76, 0.74, 0.60), ripple * 0.6 + fbm3(wp * 6.0) * 0.4));
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
      // Pente (d/dx, d/dz) de la surface : dérivées analytiques, une seule évaluation du bruit.
      vec2 slope(vec2 p) {
        float t = uTime;
        vec2 g = vec2(cos(p.x * 1.7 + t * 1.6) * 0.016 * 1.7, -sin(p.y * 2.1 - t * 1.3) * 0.012 * 2.1);
        g += fbmd(p * 2.2 + vec2(t * 0.25, t * 0.18), 1.0).yz * (0.05 * 2.2);
        g += vnoised(p * 9.0 - vec2(t * 0.6, -t * 0.4)).yz * (0.012 * 9.0);
        return g;
      }
      // x^n pour x proche de 1 (reflets spéculaires) : exp2 seul, sans log.
      float spec(float x, float n) { return exp2((x - 1.0) * n * 1.4427); }
      void main() {
        vec2 p = vW.xz;
        vec2 g = slope(p);
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 v = normalize(cameraPosition - vW);
        float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        float depth = smoothstep(0.0, 1.8, vShore);

        vec3 col = mix(uShallow, uDeep, depth);
        col = mix(col, uSky, clamp(fres * 0.9, 0.0, 0.7));
        // Reflet doux et éclats du soleil.
        vec3 r = reflect(-uSunDir, n);
        float rv = max(dot(r, v), 0.0);
        col += uSun * (spec(rv, 140.0) * 3.0 + spec(rv, 14.0) * 0.18);
        float sparkle = smoothstep(0.93, 1.0, vnoise(p * 22.0 + vec2(uTime * 0.9, -uTime * 0.7)))
                      * (0.5 + 0.5 * sin(uTime * 7.0 + p.x * 31.0 + p.y * 17.0));
        col += vec3(1.0, 0.97, 0.9) * sparkle * 1.6 * (0.4 + depth);

        // Écume de contact + vaguelettes qui viennent mourir sur la rive (nulles au large).
        float foam = 0.0;
        if (vShore < 0.85) {
          float fn = vnoise(p * 7.0 + uTime * 0.35);
          float contact = (1.0 - smoothstep(0.0, 0.2, vShore)) * smoothstep(0.3, 0.6, fn + 0.3);
          float band = smoothstep(0.88, 1.0, sin(vShore * 13.0 + uTime * 2.2) * 0.5 + 0.5)
                     * (1.0 - smoothstep(0.1, 0.85, vShore)) * smoothstep(0.35, 0.65, fn);
          foam = clamp(contact + band * 0.8, 0.0, 1.0);
        }
        col = mix(col, uFoam, foam * 0.85);

        float alpha = mix(0.62, 0.92, depth) + fres * 0.2 + foam * 0.5;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.landMesh = new THREE.Mesh(new THREE.BufferGeometry(), landMaterial());
    this.landMesh.castShadow = true;
    this.landMesh.receiveShadow = true;
    this.waterMaterial = waterMaterial();
    this.waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMaterial);
    this.waterMesh.renderOrder = 1;
    this.waterSides = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMaterial);
    this.waterSides.renderOrder = 1;
    scene.add(this.landMesh, this.waterMesh, this.waterSides);
  }

  rebuild(map) {
    this.map = map;
    this.landMesh.geometry.dispose();
    this.landMesh.geometry = this.buildLand(map);
    if (this.waterW !== map.width || this.waterH !== map.height) this.buildWaterPlane(map);
    this.computeShore(map);
    this.waterSides.geometry.dispose();
    this.waterSides.geometry = this.buildWaterSides(map);
  }

  exposure(map, x, z) {
    const t = map.get(x, z);
    if (t === -1) return EXPOSE_VOID;
    return t === TILE.WATER ? EXPOSE_WATER : EXPOSE_NONE;
  }

  buildLand(map) {
    const b = new GeoBuilder();
    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        const t = map.get(x, z);
        if (t === TILE.WATER) this.buildWaterCell(b, map, x, z);
        else this.buildLandCell(b, map, x, z, t);
      }
    }
    return b.build();
  }

  // Fond sableux sous l'eau (aussi visible sous les coins arrondis des tuiles de terre).
  floor(b, x, z) {
    const v = (px, pz) => ({ p: [px, FLOOR, pz], k: K_FLOOR });
    b.quad(v(x, z), v(x, z + 1), v(x + 1, z + 1), v(x + 1, z));
  }

  buildWaterCell(b, map, x, z) {
    this.floor(b, x, z);
    // Bords de carte : la falaise descend jusqu'au socle.
    for (let e = 0; e < 4; e++) {
      const [dx, dz] = EDGE_DIRS[e];
      if (map.get(x + dx, z + dz) !== -1) continue;
      const p = CORNERS[e], q = CORNERS[(e + 1) % 4];
      this.wall(b, [x + p[0], z + p[1]], [x + q[0], z + q[1]], FLOOR, BASE, false);
    }
  }

  buildLandCell(b, map, x, z, type) {
    const exp = EDGE_DIRS.map(([dx, dz]) => this.exposure(map, x + dx, z + dz));
    const own = type === TILE.GRASS ? 1 : 0;
    // Contour de la tuile, avec coins chanfreinés quand deux bords voisins donnent sur l'eau.
    const pts = []; // { p:[x,z], g, exposedAfter }
    for (let i = 0; i < 4; i++) {
      const prevE = (i + 3) % 4, nextE = i;
      const c = [x + CORNERS[i][0], z + CORNERS[i][1]];
      if (exp[prevE] === EXPOSE_WATER && exp[nextE] === EXPOSE_WATER) {
        const cp = [x + CORNERS[(i + 3) % 4][0], z + CORNERS[(i + 3) % 4][1]];
        const cn = [x + CORNERS[(i + 1) % 4][0], z + CORNERS[(i + 1) % 4][1]];
        pts.push({ p: [c[0] + (cp[0] - c[0]) * CHAMFER, c[1] + (cp[1] - c[1]) * CHAMFER], g: own, exposedAfter: EXPOSE_WATER });
        pts.push({ p: [c[0] + (cn[0] - c[0]) * CHAMFER, c[1] + (cn[1] - c[1]) * CHAMFER], g: own, exposedAfter: exp[nextE] });
      } else {
        pts.push({ p: c, g: cornerGrassiness(map, c[0], c[1]), exposedAfter: exp[nextE] });
      }
    }
    if (pts.length > 4) this.floor(b, x, z);

    // Dessus : cœur à la valeur de la tuile, anneau extérieur fondu avec les voisines.
    const cx = x + 0.5, cz = z + 0.5;
    const top = (p, g) => ({ p: [p[0], LAND_TOP, p[1]], g, k: K_TOP });
    const center = top([cx, cz], own);
    const inner = pts.map((pt) => top([cx + (pt.p[0] - cx) * INNER, cz + (pt.p[1] - cz) * INNER], own));
    const outer = pts.map((pt) => top(pt.p, pt.g));
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      b.tri(center, inner[i], inner[j]);
      b.quad(inner[i], outer[i], outer[j], inner[j]);
    }
    // Falaises.
    for (let i = 0; i < pts.length; i++) {
      const kind = pts[i].exposedAfter;
      if (kind === EXPOSE_NONE) continue;
      const p = pts[i].p, q = pts[(i + 1) % pts.length].p;
      this.wall(b, p, q, LAND_TOP, kind === EXPOSE_VOID ? BASE : FLOOR, type === TILE.GRASS);
    }
  }

  // Mur vertical orienté vers l'extérieur (le contour tourne dans le sens qui met l'extérieur à gauche).
  wall(b, p, q, top, bottom, grassLip) {
    let y = top;
    if (grassLip) {
      const v = (pt, yy) => ({ p: [pt[0], yy, pt[1]], k: K_LIP });
      b.quad(v(p, y), v(p, y - LIP), v(q, y - LIP), v(q, y));
      y -= LIP;
    }
    const h = top - BASE;
    const ct = WALL_BOTTOM.clone().lerp(WALL_TOP, (y - BASE) / h);
    const cb = WALL_BOTTOM.clone().lerp(WALL_TOP, (bottom - BASE) / h);
    const v = (pt, yy, c) => ({ p: [pt[0], yy, pt[1]], c, k: K_WALL });
    b.quad(v(p, y, ct), v(p, bottom, cb), v(q, bottom, cb), v(q, y, ct));
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
  }

  // Distance de chaque sommet d'eau à la terre la plus proche : profondeur et écume.
  computeShore(map) {
    const pos = this.waterMesh.geometry.getAttribute('position');
    const shore = this.waterMesh.geometry.getAttribute('shore');
    const R = SHORE_MAX, W = map.width, H = map.height;
    const land = new Uint8Array(W * H);
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) land[z * W + x] = map.isLand(x, z) ? 1 : 0;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), pz = pos.getZ(i);
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
      shore.setX(i, Math.sqrt(best));
    }
    shore.needsUpdate = true;
  }

  // Faces latérales de l'eau, uniquement là où une case d'eau touche le bord de la carte.
  buildWaterSides(map) {
    const pos = [], shore = [];
    const push = (pt, y) => { pos.push(pt[0], y, pt[1]); shore.push(SHORE_MAX); };
    for (let z = 0; z < map.height; z++) for (let x = 0; x < map.width; x++) {
      if (map.get(x, z) !== TILE.WATER) continue;
      for (let e = 0; e < 4; e++) {
        const [dx, dz] = EDGE_DIRS[e];
        if (map.get(x + dx, z + dz) !== -1) continue;
        const p = [x + CORNERS[e][0], z + CORNERS[e][1]];
        const q = [x + CORNERS[(e + 1) % 4][0], z + CORNERS[(e + 1) % 4][1]];
        push(p, WATER_LEVEL); push(p, FLOOR); push(q, FLOOR);
        push(p, WATER_LEVEL); push(q, FLOOR); push(q, WATER_LEVEL);
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
