import * as THREE from 'three';
import { TILE } from './map.js';

// Hauteurs (en unités de tuile).
export const LAND_TOP = 0.6;
export const WATER_LEVEL = 0.3;
const FLOOR = 0;
const BASE = -1;
const LIP = 0.08; // épaisseur de la couche d'herbe visible sur les falaises
const CHAMFER = 0.3; // arrondi des coins extérieurs
const INNER = 0.55; // taille du cœur uni de chaque tuile

const C = {
  grass: new THREE.Color(0x7ac553),
  grassAlt: new THREE.Color(0x71bb4c),
  dirtTop: new THREE.Color(0xc29462),
  dirtTopAlt: new THREE.Color(0xb88b5a),
  lip: new THREE.Color(0x5ea43f),
  wallTop: new THREE.Color(0x9a663d),
  wallBottom: new THREE.Color(0x6a4226),
  sand: new THREE.Color(0xd8c08b),
  water: new THREE.Color(0x3d9fd6),
  foam: new THREE.Color(0xdff4ff),
};

// Bruit déterministe par sommet, pour casser l'uniformité des couleurs.
function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

class GeoBuilder {
  constructor() { this.pos = []; this.col = []; }
  tri(a, b, c, ca, cb, cc) {
    this.pos.push(...a, ...b, ...c);
    for (const col of [ca, cb ?? ca, cc ?? ca]) this.col.push(col.r, col.g, col.b);
  }
  quad(a, b, c, d, ca, cb, cc, cd) {
    this.tri(a, b, c, ca, cb, cc);
    this.tri(a, c, d, ca, cc, cd);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// Directions des 4 bords d'une tuile, dans l'ordre des coins c0..c3
// (c0=(x,z) c1=(x,z+1) c2=(x+1,z+1) c3=(x+1,z)) : ouest, sud, est, nord.
const EDGE_DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]];
const CORNERS = [[0, 0], [0, 1], [1, 1], [1, 0]];

const EXPOSE_NONE = 0, EXPOSE_WATER = 1, EXPOSE_VOID = 2;

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.landMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.waterMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, opacity: 0.82, roughness: 0.25, metalness: 0.05,
      flatShading: true, depthWrite: false,
    });
    this.landMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.landMaterial);
    this.landMesh.castShadow = true;
    this.landMesh.receiveShadow = true;
    this.waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMaterial);
    this.waterMesh.receiveShadow = true;
    this.waterMesh.renderOrder = 1;
    this.waterSides = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMaterial);
    this.waterSides.renderOrder = 1;
    scene.add(this.landMesh, this.waterMesh, this.waterSides);
    this.time = 0;
  }

  rebuild(map) {
    this.map = map;
    this.landMesh.geometry.dispose();
    this.landMesh.geometry = this.buildLand(map);
    if (!this.waterBase || this.waterW !== map.width || this.waterH !== map.height) {
      this.buildWaterPlane(map);
    }
    this.colorWater(map);
    this.waterSides.geometry.dispose();
    this.waterSides.geometry = this.buildWaterSides(map);
  }

  // Faces latérales de l'eau, uniquement là où une case d'eau touche le bord de la carte.
  buildWaterSides(map) {
    const b = new GeoBuilder();
    const wc = C.water;
    for (let z = 0; z < map.height; z++) for (let x = 0; x < map.width; x++) {
      if (map.get(x, z) !== TILE.WATER) continue;
      for (let e = 0; e < 4; e++) {
        const [dx, dz] = EDGE_DIRS[e];
        if (map.get(x + dx, z + dz) !== -1) continue;
        const p = [x + CORNERS[e][0], z + CORNERS[e][1]];
        const q = [x + CORNERS[(e + 1) % 4][0], z + CORNERS[(e + 1) % 4][1]];
        b.quad([p[0], WATER_LEVEL, p[1]], [p[0], FLOOR, p[1]], [q[0], FLOOR, q[1]], [q[0], WATER_LEVEL, q[1]], wc, wc, wc, wc);
      }
    }
    return b.build();
  }

  // Couleur d'un coin de tuile : mélange herbe/terre des tuiles qui le partagent,
  // ce qui « connecte » visuellement les tuiles voisines.
  cornerColor(map, cx, cz) {
    let grass = 0, dirt = 0;
    for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const t = map.get(cx + dx, cz + dz);
      if (t === TILE.GRASS) grass++;
      else if (t === TILE.DIRT) dirt++;
    }
    const grassCol = (cx + cz) % 2 ? C.grass : C.grassAlt;
    const dirtCol = (cx + cz) % 2 ? C.dirtTop : C.dirtTopAlt;
    const col = dirtCol.clone().lerp(grassCol, grass / Math.max(1, grass + dirt));
    return jitter(col, cx, cz, 0.05);
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

  buildWaterCell(b, map, x, z) {
    this.floor(b, x, z);
    // Bords de carte : la falaise descend jusqu'au socle.
    for (let e = 0; e < 4; e++) {
      const [dx, dz] = EDGE_DIRS[e];
      if (map.get(x + dx, z + dz) !== -1) continue;
      const p = CORNERS[e], q = CORNERS[(e + 1) % 4];
      this.wall(b, [x + p[0], z + p[1]], [x + q[0], z + q[1]], FLOOR, BASE, null);
    }
  }

  // Fond sableux sous l'eau (aussi visible sous les coins arrondis des tuiles de terre).
  floor(b, x, z) {
    const s = jitter(C.sand.clone(), x, z, 0.04);
    b.quad([x, FLOOR, z], [x, FLOOR, z + 1], [x + 1, FLOOR, z + 1], [x + 1, FLOOR, z], s, s, s, s);
  }

  buildLandCell(b, map, x, z, type) {
    const exp = EDGE_DIRS.map(([dx, dz]) => this.exposure(map, x + dx, z + dz));
    // Contour de la tuile, avec coins chanfreinés quand deux bords voisins donnent sur l'eau.
    const pts = []; // { p:[x,z], col, exposedAfter }
    for (let i = 0; i < 4; i++) {
      const prevE = (i + 3) % 4, nextE = i;
      const c = [x + CORNERS[i][0], z + CORNERS[i][1]];
      if (exp[prevE] === EXPOSE_WATER && exp[nextE] === EXPOSE_WATER) {
        const cp = [x + CORNERS[(i + 3) % 4][0], z + CORNERS[(i + 3) % 4][1]];
        const cn = [x + CORNERS[(i + 1) % 4][0], z + CORNERS[(i + 1) % 4][1]];
        const a = [c[0] + (cp[0] - c[0]) * CHAMFER, c[1] + (cp[1] - c[1]) * CHAMFER];
        const d = [c[0] + (cn[0] - c[0]) * CHAMFER, c[1] + (cn[1] - c[1]) * CHAMFER];
        pts.push({ p: a, exposedAfter: EXPOSE_WATER });
        pts.push({ p: d, exposedAfter: exp[nextE] });
      } else {
        pts.push({ p: c, exposedAfter: exp[nextE] });
      }
    }
    if (pts.length > 4) this.floor(b, x, z);
    const own = type === TILE.GRASS ? C.grass : C.dirtTop;
    for (const pt of pts) {
      const isCorner = Number.isInteger(pt.p[0]) && Number.isInteger(pt.p[1]);
      pt.col = isCorner ? this.cornerColor(map, pt.p[0], pt.p[1]) : jitter(own.clone(), pt.p[0], pt.p[1], 0.05);
    }
    // Dessus : cœur à la couleur de la tuile, anneau extérieur fondu avec les voisines.
    const center = [x + 0.5, LAND_TOP, z + 0.5];
    const cc = jitter(own.clone(), x + 0.5, z + 0.5, 0.04);
    const inner = pts.map((pt) => ({
      p: [center[0] + (pt.p[0] - center[0]) * INNER, center[2] + (pt.p[1] - center[2]) * INNER],
      col: jitter(own.clone(), pt.p[0] * 3.1, pt.p[1] * 2.7, 0.04),
    }));
    const v = (pt) => [pt.p[0], LAND_TOP, pt.p[1]];
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      b.tri(center, v(inner[i]), v(inner[j]), cc, inner[i].col, inner[j].col);
      b.quad(v(inner[i]), v(pts[i]), v(pts[j]), v(inner[j]), inner[i].col, pts[i].col, pts[j].col, inner[j].col);
    }
    // Falaises.
    const lip = type === TILE.GRASS ? C.lip : null;
    for (let i = 0; i < pts.length; i++) {
      const kind = pts[i].exposedAfter;
      if (kind === EXPOSE_NONE) continue;
      const p = pts[i].p, q = pts[(i + 1) % pts.length].p;
      this.wall(b, p, q, LAND_TOP, kind === EXPOSE_VOID ? BASE : FLOOR, lip);
    }
  }

  // Mur vertical orienté vers l'extérieur (le contour tourne dans le sens qui met l'extérieur à gauche).
  wall(b, p, q, top, bottom, lipColor) {
    let y = top;
    if (lipColor) {
      const l = jitter(lipColor.clone(), p[0], p[1], 0.04);
      b.quad([p[0], y, p[1]], [p[0], y - LIP, p[1]], [q[0], y - LIP, q[1]], [q[0], y, q[1]], l, l, l, l);
      y -= LIP;
    }
    const h = top - BASE;
    const ct = C.wallBottom.clone().lerp(C.wallTop, (y - BASE) / h);
    const cb = C.wallBottom.clone().lerp(C.wallTop, (bottom - BASE) / h);
    b.quad([p[0], y, p[1]], [p[0], bottom, p[1]], [q[0], bottom, q[1]], [q[0], y, q[1]], ct, cb, cb, ct);
  }

  buildWaterPlane(map) {
    const { width: w, height: h } = map;
    const res = 2;
    const g = new THREE.PlaneGeometry(w, h, w * res, h * res);
    g.rotateX(-Math.PI / 2);
    g.translate(w / 2, WATER_LEVEL, h / 2);
    const top = g.toNonIndexed();
    const merged = new THREE.BufferGeometry();
    const pos = top.getAttribute('position').array;
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    this.waterTopCount = pos.length / 3;
    this.waterBase = pos.slice();
    this.waterW = w; this.waterH = h;
    this.waterMesh.geometry.dispose();
    this.waterMesh.geometry = merged;
    g.dispose();
  }

  // Écume blanche le long des rives.
  colorWater(map) {
    const col = this.waterMesh.geometry.getAttribute('color');
    const base = this.waterBase;
    const tmp = new THREE.Color();
    for (let i = 0; i < col.count; i++) {
      tmp.copy(C.water);
      {
        const vx = base[i * 3], vz = base[i * 3 + 2];
        let shore = false;
        for (const [dx, dz] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
          if (map.isWalkable(Math.floor(vx + dx), Math.floor(vz + dz))) { shore = true; break; }
        }
        if (shore) tmp.lerp(C.foam, 0.55);
        jitter(tmp, vx, vz, 0.03);
      }
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;
  }

  update(dt) {
    this.time += dt;
    const pos = this.waterMesh.geometry.getAttribute('position');
    if (!pos) return;
    const base = this.waterBase, t = this.time;
    for (let i = 0; i < this.waterTopCount; i++) {
      const x = base[i * 3], z = base[i * 3 + 2];
      const wave = Math.sin(x * 1.7 + t * 1.6) * 0.018 + Math.cos(z * 2.1 - t * 1.3) * 0.014;
      pos.setY(i, base[i * 3 + 1] + wave);
    }
    pos.needsUpdate = true;
  }
}

function jitter(color, x, z, amount) {
  const k = 1 + (hash(x, z) - 0.5) * 2 * amount;
  return color.multiplyScalar(k);
}
