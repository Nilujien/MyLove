import * as THREE from 'three';
import { GameMap, TILE } from './map.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Terrain, LAND_TOP, WATER_LEVEL, shared } from './terrain.js';
import { Character } from './character.js';
import { GrassField } from './grass.js';
import { Motes } from './motes.js';
import { Forest, GROW_TIME, stageOf, logsFor } from './trees.js';
import { Bridges } from './bridges.js';
import { Shrubs, bushGrowth } from './bushes.js';
import { ecologyTick, adultNeighbors, MAJESTIC_NEIGHBORS } from './ecology.js';
import { PathPreview } from './path.js';
import { Sparkles } from './sparkles.js';
import { SeedThrower } from './seeds.js';

const MAP_SIZE = 48;
const BRIDGE_COST = 1; // rondins par pont
const STORAGE_KEY = 'iso-jeu-carte-v1';

// ---------- Scène ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

const scene = new THREE.Scene();
// Ciel d'aube pastel, en dégradé.
scene.background = (() => {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#5f6fc4');
  grad.addColorStop(0.45, '#a99be0');
  grad.addColorStop(0.8, '#efc2dc');
  grad.addColorStop(1, '#ffe2cf');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

scene.add(new THREE.HemisphereLight(0xd6dcff, 0x6a4f6e, 1.1));
const sun = new THREE.DirectionalLight(0xffe4c8, 2.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// ---------- Caméra isométrique ----------
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
const cam = {
  target: new THREE.Vector3(),
  rotation: 0, // quart de tour (0..3)
  yaw: Math.PI / 4, // angle courant, interpolé vers la rotation demandée
  zoom: 1,
  follow: true,
};
const VIEW = 7; // demi-hauteur visible (en tuiles) à zoom 1

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  updateProjection();
}

function updateProjection() {
  const aspect = window.innerWidth / window.innerHeight;
  const v = VIEW / cam.zoom;
  camera.left = -v * aspect; camera.right = v * aspect;
  camera.top = v; camera.bottom = -v;
  camera.updateProjectionMatrix();
  motes.setView(cam.zoom, renderer.getPixelRatio());
  sparkles.setScale(cam.zoom * renderer.getPixelRatio());
}
window.addEventListener('resize', resize);

function updateCamera(dt) {
  const goal = Math.PI / 4 + cam.rotation * Math.PI / 2;
  cam.yaw += (goal - cam.yaw) * Math.min(1, dt * 10);
  if (cam.follow) {
    const p = hero.root.position;
    cam.target.x += (p.x - cam.target.x) * Math.min(1, dt * 6);
    cam.target.z += (p.z - cam.target.z) * Math.min(1, dt * 6);
    cam.target.y = LAND_TOP;
  }
  const d = 50;
  camera.position.set(
    cam.target.x + Math.sin(cam.yaw) * d * Math.SQRT2,
    cam.target.y + d,
    cam.target.z + Math.cos(cam.yaw) * d * Math.SQRT2,
  );
  camera.lookAt(cam.target);
}

// Vecteurs « droite » et « haut » de l'écran projetés sur le sol.
// Vecteurs réutilisés (recalculés à chaque appel) : ne pas les conserver d'une image à l'autre.
const axes = { right: new THREE.Vector3(), up: new THREE.Vector3() };
function screenAxes() {
  const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
  axes.right.set(c, 0, -s);
  axes.up.set(-s, 0, -c);
  return axes;
}

// Direction de grille (axe strict) la plus proche d'une direction écran.
function gridDirFromScreen(sx, sy) {
  const { right, up } = screenAxes();
  const v = right.multiplyScalar(sx).add(up.multiplyScalar(sy));
  if (Math.abs(v.x) > Math.abs(v.z)) return [Math.sign(v.x), 0];
  return [0, Math.sign(v.z)];
}

// ---------- Monde ----------
let savedLogs = 0;
let map = loadMap() ?? GameMap.random(MAP_SIZE, MAP_SIZE);
const terrain = new Terrain(scene);
const grass = new GrassField(scene);
const motes = new Motes(scene);
const hero = new Character(scene, 0, 0);
const sparkles = new Sparkles(scene);
const forest = new Forest(scene, sparkles);
const seeds = new SeedThrower(scene, sparkles);
const bridges = new Bridges(scene);
const shrubs = new Shrubs(scene);
const pathPreview = new PathPreview(scene);
const inventory = { logs: savedLogs };

// Post-traitement : halo lumineux (bloom) sur les reflets et les poussières de lumière.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.7, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function refreshWorld() {
  terrain.rebuild(map);
  grass.rebuild(map);
  forest.sync(map);
  bridges.sync(map);
  shrubs.sync(map);
  dirty.tiles.length = 0; dirty.hide.length = 0; dirty.show.length = 0; dirty.objects = false;
  gridDirty = true;
  if (state.grid[state.mode]) buildGrid();
}

// Modifications de l'éditeur en attente : appliquées une fois par image (flushRebuild).
const dirty = { tiles: [], hide: [], show: [], objects: false };
function flushRebuild() {
  if (dirty.tiles.length) {
    terrain.rebuildCells(map, dirty.tiles);
    grass.rebuildCells(map, dirty.tiles);
    gridDirty = true;
  }
  // Arbres plantés / coupés sans changement de tuile : seuls leurs brins sont masqués / rétablis.
  for (const [x, z] of dirty.hide) grass.setTileHidden(x, z, map.hasTree(x, z));
  for (const [x, z] of dirty.show) grass.setTileHidden(x, z, map.hasTree(x, z));
  if (dirty.objects) { forest.sync(map); bridges.sync(map); shrubs.sync(map); }
  dirty.tiles.length = 0; dirty.hide.length = 0; dirty.show.length = 0; dirty.objects = false;
  // Grille reconstruite seulement quand elle est affichée.
  if (gridDirty && state.grid[state.mode]) buildGrid();
}

// Grille affichée en mode édition : chaque arête une seule fois (deux si elle sépare terre et eau).
let gridLines = null, gridDirty = true;
// Opacité 0.51 = deux passes à 0.3 : l'ancienne grille traçait deux fois chaque arête intérieure.
const gridMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.51 });
function buildGrid() {
  const W = map.width, H = map.height;
  const maxSeg = 2 * ((W + 1) * H + (H + 1) * W);
  let attr = gridLines?.geometry.getAttribute('position');
  if (!attr || attr.count < maxSeg * 2) {
    if (gridLines) { scene.remove(gridLines); gridLines.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    attr = new THREE.BufferAttribute(new Float32Array(maxSeg * 6), 3);
    g.setAttribute('position', attr);
    gridLines = new THREE.LineSegments(g, gridMaterial);
    gridLines.renderOrder = 2;
    gridLines.frustumCulled = false;
    scene.add(gridLines);
  }
  const a = attr.array;
  let n = 0;
  const lvl = (x, z) => { const t = map.get(x, z); return t === -1 ? -1 : (t === TILE.WATER ? WATER_LEVEL : LAND_TOP) + 0.005; };
  const seg = (x0, z0, x1, z1, y) => { a[n++] = x0; a[n++] = y; a[n++] = z0; a[n++] = x1; a[n++] = y; a[n++] = z1; };
  // Arête entre deux cases (ou une case et le vide) : tracée à la hauteur de chacune.
  const edge = (x0, z0, x1, z1, ya, yb) => {
    if (ya >= 0) seg(x0, z0, x1, z1, ya);
    if (yb >= 0 && yb !== ya) seg(x0, z0, x1, z1, yb);
  };
  for (let z = 0; z <= H; z++) for (let x = 0; x < W; x++) edge(x, z, x + 1, z, lvl(x, z - 1), lvl(x, z));
  for (let z = 0; z < H; z++) for (let x = 0; x <= W; x++) edge(x, z, x, z + 1, lvl(x - 1, z), lvl(x, z));
  gridLines.geometry.setDrawRange(0, n / 3);
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n);
  attr.needsUpdate = true;
  gridLines.visible = state.grid[state.mode];
  gridDirty = false;
}

function setMap(m, recenterHero = false) {
  map = m;
  refreshWorld();
  placeHeroSafely(recenterHero);
}

// Le soleil (et sa zone d'ombre) suit la vue : ombres nettes quelle que soit la taille de la carte.
const SUN_OFFSET = new THREE.Vector3(14, 24, 8);
shared.uSunDir.value.copy(SUN_OFFSET).normalize();
let shadowRadius = 0;
function updateSun() {
  const r = THREE.MathUtils.clamp(16 / cam.zoom, 16, 48);
  const texel = (2 * r) / sun.shadow.mapSize.x;
  // Alignement sur les texels de l'ombre pour éviter le scintillement en déplacement.
  const tx = Math.round(cam.target.x / texel) * texel, tz = Math.round(cam.target.z / texel) * texel;
  sun.target.position.set(tx, 0, tz);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);
  if (r !== shadowRadius) {
    shadowRadius = r;
    const s = sun.shadow.camera;
    s.left = -r; s.right = r; s.top = r; s.bottom = -r; s.near = 1; s.far = 90;
    s.updateProjectionMatrix();
  }
  motes.setCenter(cam.target.x, cam.target.z);
}

function placeHeroSafely(force = false) {
  if (!force && map.isWalkable(hero.gridX, hero.gridZ) && !hero.busy) return;
  // Case marchable la plus proche du centre.
  let best = null, bestD = Infinity;
  for (let z = 0; z < map.height; z++) for (let x = 0; x < map.width; x++) {
    if (!map.isWalkable(x, z)) continue;
    const d = (x - map.width / 2) ** 2 + (z - map.height / 2) ** 2;
    if (d < bestD) { bestD = d; best = [x, z]; }
  }
  if (!best) { map.set(0, 0, TILE.GRASS); refreshWorld(); best = [0, 0]; }
  hero.teleport(best[0], best[1]);
}

// Sauvegarde différée : les demandes rapprochées (~400 ms) sont regroupées en une seule écriture,
// et toute sauvegarde en attente est écrite immédiatement quand la page est masquée ou fermée.
let saveTimer = 0;
function saveMap() {
  if (!saveTimer) saveTimer = setTimeout(flushSave, 400);
}
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ map: map.toJSON(), hero: [hero.gridX, hero.gridZ], logs: inventory.logs }));
  } catch { /* stockage indisponible */ }
}
window.addEventListener('pagehide', flushSave);
window.addEventListener('beforeunload', flushSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
function loadMap() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    let m = GameMap.fromJSON(data.map);
    let ox = 0, oz = 0;
    // Les anciennes cartes, plus petites, sont agrandies : leur contenu est conservé au centre.
    if (m.width < MAP_SIZE || m.height < MAP_SIZE) {
      ({ map: m, ox, oz } = m.expanded(Math.max(MAP_SIZE, m.width), Math.max(MAP_SIZE, m.height)));
    }
    if (Number.isInteger(data.logs) && data.logs > 0) savedLogs = data.logs;
    if (Array.isArray(data.hero)) {
      const [hx, hz] = [data.hero[0] + ox, data.hero[1] + oz];
      queueMicrotask(() => { if (m.isWalkable(hx, hz)) { hero.teleport(hx, hz); cam.target.set(hx + 0.5, LAND_TOP, hz + 0.5); } });
    }
    return m;
  } catch { return null; }
}

// ---------- Curseur / sélection de case ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const cursor = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
);
cursor.renderOrder = 10;
scene.add(cursor);
const cursorFill = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }),
);
cursor.add(cursorFill);
let hoverCell = null;

// Sélection analytique (sans lancer de rayon sur les maillages) : la caméra est orthographique,
// on intersecte le rayon avec les silhouettes approchées des arbres, puis on parcourt les colonnes
// de cases traversées sous le niveau de la terre (dessus, falaises, surface de l'eau).
let canvasRect = null;
window.addEventListener('resize', () => { canvasRect = null; });
const PICK_BOTTOM = -1; // bas des falaises au bord de la carte
const PICK_TREE_TOP = 5; // hauteur maximale d'un arbre (majestueux compris)
let pickX = 0, pickZ = 0; // résultat de pickInto

const smoothPick = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Paramètre du rayon à l'entrée dans l'ellipsoïde vertical qui approche le feuillage de l'arbre (Infinity sinon).
function treeHit(tree, cx, cz, o, d, now) {
  const g = tree.growth(now);
  let r, y0, y1;
  if (g < 0.3) {
    r = 0.2; y0 = 0; y1 = 0.3; // graine, pousse
  } else {
    const mj = tree.majesty ? tree.majesty(now) : (tree.majestic ? 1 : 0);
    const k = (0.25 + 0.75 * smoothPick(0.3, 1, g)) * (tree.sizeK ?? 1.25) * (1 + 0.55 * mj);
    const hk0 = tree.heightK ?? 1;
    const sy = k * (hk0 + (1.25 - hk0) * mj) * (1 + 0.15 * mj);
    // Feuillage (repère de l'arbre) : rayon ~0,34, de 0,47 à 1,1 ; la couronne du majestueux monte plus haut.
    r = k * (0.34 + 0.06 * mj);
    y0 = sy * (0.47 - 0.12 * mj); y1 = sy * (1.1 + 0.42 * mj);
  }
  // Ellipsoïde : centre (cx, LAND_TOP + (y0 + y1) / 2, cz), demi-axes r (horizontal) et ry (vertical).
  const ry = (y1 - y0) / 2, sk = r / ry;
  const ox = o.x - cx, oy = (o.y - (LAND_TOP + y0 + ry)) * sk, oz = o.z - cz;
  const dx = d.x, dy = d.y * sk, dz = d.z;
  const a = dx * dx + dy * dy + dz * dz, b = ox * dx + oy * dy + oz * dz, c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return Infinity;
  return (-b - Math.sqrt(disc)) / a;
}

// Case sous le pointeur, écrite dans pickX / pickZ ; renvoie false si aucune.
function pickInto(clientX, clientY) {
  const rect = canvasRect ??= canvas.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  if (d.y > -1e-6) return false;
  const tLand = (LAND_TOP - o.y) / d.y;
  // 1) Arbres : cases survolées entre le sommet des plus grands arbres et le sol.
  const tHigh = (LAND_TOP + PICK_TREE_TOP - o.y) / d.y;
  const ax = o.x + d.x * tHigh, az = o.z + d.z * tHigh, bx = o.x + d.x * tLand, bz = o.z + d.z * tLand;
  let best = Infinity;
  if (map.trees.size) {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - 1)), x1 = Math.min(map.width - 1, Math.floor(Math.max(ax, bx) + 1));
    const z0 = Math.max(0, Math.floor(Math.min(az, bz) - 1)), z1 = Math.min(map.height - 1, Math.floor(Math.max(az, bz) + 1));
    const now = Date.now();
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (!map.hasTree(x, z)) continue;
      const tree = forest.get(x, z);
      if (!tree) continue;
      const t = treeHit(tree, x + 0.5, z + 0.5, o, d, now);
      if (t < best) { best = t; pickX = x; pickZ = z; }
    }
  }
  if (best < Infinity) return true;
  // 2) Terrain : parcours des colonnes traversées (DDA), du niveau de la terre jusqu'au bas des falaises.
  const tWater = (WATER_LEVEL - o.y) / d.y, tEnd = (PICK_BOTTOM - o.y) / d.y;
  let x = Math.floor(bx), z = Math.floor(bz);
  const sx = d.x > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
  const ddx = Math.abs(d.x) > 1e-9 ? Math.abs(1 / d.x) : Infinity, ddz = Math.abs(d.z) > 1e-9 ? Math.abs(1 / d.z) : Infinity;
  let tx = ddx === Infinity ? Infinity : (x + (sx > 0 ? 1 : 0) - o.x) / d.x;
  let tz = ddz === Infinity ? Infinity : (z + (sz > 0 ? 1 : 0) - o.z) / d.z;
  let tIn = tLand;
  for (let i = 0; i < 32; i++) {
    const tOut = Math.min(tx, tz, tEnd);
    if (map.inBounds(x, z)) {
      // Terre (dessus ou falaise) ; un pont n'est visé que par son tablier, au niveau de la terre.
      if (map.isLand(x, z) || (i === 0 && map.hasBridge(x, z))) { pickX = x; pickZ = z; return true; }
      if (tWater >= tIn && tWater <= tOut) { pickX = x; pickZ = z; return true; }
    }
    if (tOut >= tEnd) break;
    tIn = tOut;
    if (tx < tz) { x += sx; tx += ddx; } else { z += sz; tz += ddz; }
  }
  return false;
}

function pickCell(clientX, clientY) {
  return pickInto(clientX, clientY) ? [pickX, pickZ] : null;
}

// Survol : le pointeur est mémorisé à chaque mouvement, la case est recalculée une fois par image.
const hover = { inside: false, x: 0, y: 0, moved: false };
function updateHover() {
  if (hover.inside && !panning) {
    if (!pickInto(hover.x, hover.y)) hoverCell = null;
    else if (!hoverCell || hoverCell[0] !== pickX || hoverCell[1] !== pickZ) hoverCell = [pickX, pickZ];
  }
  if (hover.moved) { hover.moved = false; updateTooltip(hover.x, hover.y); } else updateTooltip();
}

// Dernier état du curseur : rien n'est recalculé tant que la case, le mode, Maj ou le pinceau
// ne changent pas (sauf toutes les 250 ms, pour l'inventaire, la position du personnage…).
const cursorState = { x: NaN, z: NaN, mode: '', shift: false, brush: null, size: 0, ok: null, at: 0 };
function updateCursor() {
  const target = menu.cell ?? hoverCell; // la case du menu reste surlignée tant qu'il est ouvert
  cursor.visible = !!target;
  if (!target) { cursorState.x = NaN; return; }
  const size = state.mode === 'edit' && state.brush !== 'hero' ? state.brushSize : 1;
  const x = target[0], z = target[1], cs = cursorState, now = performance.now();
  if (x === cs.x && z === cs.z && state.mode === cs.mode && state.shift === cs.shift && state.brush === cs.brush
    && size === cs.size && now - cs.at < 250) return;
  cs.x = x; cs.z = z; cs.mode = state.mode; cs.shift = state.shift; cs.brush = state.brush; cs.size = size; cs.at = now;
  const y = map.isLand(x, z) || map.hasBridge(x, z) ? LAND_TOP : WATER_LEVEL;
  cursor.position.set(x + 0.5, y + 0.02, z + 0.5);
  cursor.scale.set(size, 1, size);
  // Lancer : mêmes règles que throwTargetError, sans construire le texte du message.
  const ok = state.mode === 'edit'
    || (state.shift ? !(x === hero.gridX && z === hero.gridZ) && !map.hasTree(x, z) && map.inBounds(x, z) : clickTargetOk(x, z));
  if (ok === cs.ok) return;
  cs.ok = ok;
  cursor.material.color.set(ok ? 0xffffff : 0xff6b6b);
  cursorFill.material.color.set(ok ? 0xffffff : 0xff6b6b);
}

// ---------- État, éditeur ----------
const state = {
  mode: 'play', brush: TILE.GRASS, brushSize: 1, painting: false, shift: false,
  grid: loadGridPrefs(), // grille affichée ou non, par mode (touche G)
};

function loadGridPrefs() {
  try { return { play: false, edit: true, ...JSON.parse(localStorage.getItem('iso-jeu-grille')) }; } catch { return { play: false, edit: true }; }
}
function toggleGrid() {
  state.grid[state.mode] = !state.grid[state.mode];
  if (gridLines) gridLines.visible = state.grid[state.mode];
  try { localStorage.setItem('iso-jeu-grille', JSON.stringify(state.grid)); } catch { /* stockage indisponible */ }
  toast(state.grid[state.mode] ? 'Grille affichée' : 'Grille masquée');
}
const undoStack = [];

function brushCells([cx, cz]) {
  const r = Math.floor(state.brushSize / 2), cells = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) cells.push([cx + dx, cz + dz]);
  return cells;
}

// Ne modifie que la carte : le monde est mis à jour une fois par image (flushRebuild).
let lastPaintCell = null;
function paint(cell) {
  lastPaintCell = cell;
  if (state.brush === 'hero') {
    if (map.isWalkable(...cell)) hero.teleport(...cell);
    return;
  }
  for (const [x, z] of brushCells(cell)) {
    const onHero = x === hero.gridX && z === hero.gridZ;
    if (state.brush === 'tree') {
      // Arbre déjà adulte en mode édition.
      if (!onHero && map.plant(x, z, Date.now() - GROW_TIME * 1000)) { dirty.objects = true; dirty.hide.push([x, z]); }
      continue;
    }
    if (state.brush === TILE.WATER && onHero) continue;
    // Les pinceaux de terrain effacent les arbres.
    if (map.removeTree(x, z)) { dirty.objects = true; dirty.show.push([x, z]); }
    if (map.removeBridge(x, z)) dirty.objects = true;
    if (map.removeBush(x, z)) dirty.objects = true;
    if (map.set(x, z, state.brush)) dirty.tiles.push([x, z]);
  }
}

// Peint toutes les cases entre la précédente et « cell » (Bresenham) : pas de trous si la souris va vite.
function paintTo(cell) {
  const from = lastPaintCell;
  if (!from || state.brush === 'hero') { paint(cell); return; }
  let [x, z] = from;
  const [x1, z1] = cell;
  if (x === x1 && z === z1) return;
  const dx = Math.abs(x1 - x), dz = -Math.abs(z1 - z), sx = x < x1 ? 1 : -1, sz = z < z1 ? 1 : -1;
  let err = dx + dz;
  while (x !== x1 || z !== z1) {
    const e2 = 2 * err;
    if (e2 >= dz) { err += dz; x += sx; }
    if (e2 <= dx) { err += dx; z += sz; }
    paint([x, z]);
  }
}

// Plante une graine sur la case devant le personnage.
function plantInFront() {
  const [x, z] = hero.front;
  if (!map.canPlant(x, z)) {
    toast(map.hasTree(x, z) ? describeTree(x, z) : 'Impossible de planter ici');
    return;
  }
  map.plant(x, z);
  forest.sync(map);
  shrubs.sync(map);
  grass.setTileHidden(x, z, true);
  hero.playPlant();
  sparkles.burst(x + 0.5, LAND_TOP + 0.05, z + 0.5, 24, { spread: 0.4, up: 0.8, life: 1, size: 8 });
  saveMap();
  toast('🌱 Graine plantée');
}

// Raison pour laquelle on ne peut pas lancer de graine sur cette case (null si possible).
function throwTargetError(x, z) {
  if (x === hero.gridX && z === hero.gridZ) return 'Vise une autre case';
  if (map.hasTree(x, z)) return describeTree(x, z);
  if (!map.inBounds(x, z)) return 'Hors de la carte';
  return null;
}

// Lance une graine vers la case visée ; elle germe à l'atterrissage si la case le permet.
function throwSeed([x, z]) {
  const err = throwTargetError(x, z);
  if (err) { toast(err); return; }
  const from = hero.root.position.clone();
  hero.lookAt(x + 0.5 - from.x, z + 0.5 - from.z);
  hero.playPlant();
  from.y += 0.55;
  const to = new THREE.Vector3(x + 0.5, (map.isLand(x, z) || map.hasBridge(x, z) ? LAND_TOP : WATER_LEVEL) + 0.04, z + 0.5);
  seeds.throw(from, to, () => landSeed(x, z, to));
}

function landSeed(x, z, at) {
  if (map.hasBridge(x, z)) {
    sparkles.burst(at.x, LAND_TOP + 0.1, at.z, 10, { spread: 0.2, up: 0.6, life: 0.6, size: 6 });
    toast('La graine a rebondi sur le pont');
    return;
  }
  if (!map.isLand(x, z)) {
    sparkles.burst(at.x, at.y, at.z, 26, { spread: 0.35, up: 1.3, life: 0.8, size: 8, colors: sparkles.waterColors });
    toast('💧 Plouf ! La graine a coulé');
    return;
  }
  const heroThere = (hero.gridX === x && hero.gridZ === z) || (hero.moving && hero.moving.toX === x && hero.moving.toZ === z);
  if (!map.canPlant(x, z) || heroThere) {
    sparkles.burst(at.x, at.y + 0.1, at.z, 10, { spread: 0.2, up: 0.6, life: 0.6, size: 6 });
    toast(heroThere ? 'La graine a rebondi sur le personnage' : 'Il y a déjà un arbre ici');
    return;
  }
  map.plant(x, z);
  forest.sync(map);
  shrubs.sync(map);
  grass.setTileHidden(x, z, true);
  sparkles.burst(at.x, at.y, at.z, 24, { spread: 0.4, up: 0.8, life: 1, size: 8 });
  saveMap();
  toast('🌱 Graine plantée');
}

// ---------- Clic en mode jeu : se déplacer, couper un arbre, construire un pont ----------
function heroCell() {
  return hero.moving ? [hero.moving.toX, hero.moving.toZ] : [hero.gridX, hero.gridZ];
}
const isAdjacent = ([ax, az], [bx, bz]) => Math.abs(ax - bx) + Math.abs(az - bz) === 1;
const isOpenWater = (x, z) => map.get(x, z) === TILE.WATER && !map.hasBridge(x, z);

function clickTargetOk(x, z) {
  if (map.hasTree(x, z)) return true;
  if (isOpenWater(x, z)) return inventory.logs >= BRIDGE_COST && isAdjacent(heroCell(), [x, z]);
  return map.isWalkable(x, z);
}

function playClick(cell) {
  const [x, z] = cell;
  if (map.hasTree(x, z)) { goNextTo(cell, () => chopTree(cell)); return; }
  if (isOpenWater(x, z)) {
    if (!isAdjacent(heroCell(), cell)) { toast('Approche-toi : un pont se construit sur une case d\'eau voisine'); return; }
    if (hero.moving) hero.setPath([], { face: cell, action: () => buildBridge(cell) });
    else buildBridge(cell);
    return;
  }
  const [fx, fz] = heroCell();
  const path = map.findPath(fx, fz, x, z);
  if (path) hero.setPath(path, { show: true });
  else toast('Pas de chemin jusque-là');
}

// Va sur la case voisine la plus proche de « cell », s'y tourne vers elle puis lance l'action.
function goNextTo(cell, action) {
  const here = heroCell();
  if (isAdjacent(here, cell) && !hero.moving) {
    hero.face(cell[0] - here[0], cell[1] - here[1]);
    action();
    return;
  }
  let best = null;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = cell[0] + dx, nz = cell[1] + dz;
    const p = nx === here[0] && nz === here[1] ? [] : map.findPath(here[0], here[1], nx, nz);
    if (p && (!best || p.length < best.length)) best = p;
  }
  if (!best) { toast('Impossible d\'atteindre cet arbre'); return; }
  hero.setPath(best, { face: cell, action, show: best.length > 0 });
}

function chopTree([x, z]) {
  const tree = forest.get(x, z);
  if (!tree || !isAdjacent([hero.gridX, hero.gridZ], [x, z])) return;
  const n = logsFor(tree.growth(), tree.majestic);
  if (!n) { toast('🌱 Trop jeune pour être coupé'); return; }
  map.removeTree(x, z);
  forest.fell(x, z, x - hero.gridX, z - hero.gridZ);
  grass.setTileHidden(x, z, false);
  hero.playPlant();
  addLogs(n);
  saveMap();
  toast(`🪓 +${n} rondin${n > 1 ? 's' : ''}`);
}

function buildBridge([x, z]) {
  if (!isAdjacent([hero.gridX, hero.gridZ], [x, z]) || !isOpenWater(x, z)) return;
  if (inventory.logs < BRIDGE_COST) { toast('🪵 Il faut un rondin pour construire un pont : coupe un arbre'); return; }
  const dx = x - hero.gridX, dz = z - hero.gridZ;
  map.buildBridge(x, z, dx !== 0 ? 'x' : 'z');
  bridges.sync(map, `${x},${z}`);
  hero.face(dx, dz);
  hero.playPlant();
  addLogs(-BRIDGE_COST);
  sparkles.burst(x + 0.5, LAND_TOP, z + 0.5, 30, { spread: 0.6, up: 0.7, life: 1, size: 8, colors: sparkles.woodColors });
  saveMap();
  toast('🌉 Pont construit');
}

function addLogs(n) {
  inventory.logs = Math.max(0, inventory.logs + n);
  const el = document.getElementById('inventory');
  el.querySelector('b').textContent = inventory.logs;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function describeBush(x, z) {
  const b = map.bushes.get(`${x},${z}`);
  if (!b) return '';
  const g = bushGrowth(b);
  return g >= 1 ? '🌺 Buisson en fleurs' : `🌿 Buisson · ${Math.floor(g * 100)} %`;
}

// Évolution de la forêt, quelques fois par seconde.
let ecologyClock = 0;
const ecoHere = [0, 0];
const ecoHooks = {
  blocked: (x, z) => (x === ecoHere[0] && z === ecoHere[1]) || (x === hero.gridX && z === hero.gridZ),
  variantOf: (x, z) => forest.get(x, z)?.variantIndex ?? 0,
};
function updateEcology(dt) {
  ecologyClock += dt;
  if (ecologyClock < 1.5) return;
  ecologyClock = 0;
  const here = heroCell();
  ecoHere[0] = here[0]; ecoHere[1] = here[1];
  const { majestic, bushes } = ecologyTick(map, ecoHooks);
  for (const t of majestic) {
    sparkles.burst(t.x + 0.5, LAND_TOP + 1.2, t.z + 0.5, 60, { spread: 0.9, up: 0.8, life: 2.4, size: 10, colors: sparkles.goldColors });
  }
  if (majestic.length) toast('✨ Un arbre devient majestueux');
  if (bushes.length) shrubs.sync(map);
  if (majestic.length || bushes.length) saveMap();
}

function describeTree(x, z) {
  const tree = forest.get(x, z);
  if (!tree) return '';
  const g = tree.growth();
  const n = logsFor(g, tree.majestic);
  const hint = n ? ` · clic : couper (${n} 🪵)` : ' · trop jeune pour être coupé';
  if (tree.majestic) return `✨ Arbre majestueux${hint}`;
  if (g >= 1) {
    const around = adultNeighbors(map, x, z);
    return `🌸 ${stageOf(g).name} · ${around}/${MAJESTIC_NEIGHBORS} arbres autour pour devenir majestueux${hint}`;
  }
  const left = Math.ceil((1 - g) * GROW_TIME);
  return `🌳 ${stageOf(g).name} · ${Math.floor(g * 100)} % (encore ${left} s)${hint}`;
}

let toastTimer = 0;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// Instantané léger : copie des tuiles (Uint8Array) et des objets posés.
const copyEntries = (m) => new Map([...m].map(([k, v]) => [k, { ...v }]));
function pushUndo() {
  undoStack.push({ w: map.width, h: map.height, tiles: map.tiles.slice(), trees: copyEntries(map.trees), bushes: copyEntries(map.bushes), bridges: copyEntries(map.bridges) });
  if (undoStack.length > 50) undoStack.shift();
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  const m = new GameMap(s.w, s.h);
  m.tiles.set(s.tiles);
  m.trees = s.trees; m.bushes = s.bushes; m.bridges = s.bridges;
  setMap(m);
  saveMap();
}

// ---------- Entrées ----------
let panning = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (menu.cell) { closeMenu(); if (e.button === 0) return; }
  if (e.button === 1 || e.button === 2) {
    // Glisser : déplace la vue. Clic droit sans glisser : menu contextuel (au relâchement).
    panning = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, button: e.button, moved: false };
    return;
  }
  const cell = pickCell(e.clientX, e.clientY);
  if (!cell) return;
  if (state.mode === 'edit') {
    pushUndo();
    state.painting = true;
    paint(cell);
  } else if (e.shiftKey) {
    throwSeed(cell);
  } else {
    // Déplacement au clic : la caméra reste fixe (les flèches ou F la recentrent).
    cam.follow = false;
    playClick(cell);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (panning) {
    const worldPerPx = (camera.top - camera.bottom) / canvas.clientHeight;
    const { right, up } = screenAxes();
    if (!panning.moved && Math.hypot(e.clientX - panning.x0, e.clientY - panning.y0) < 5) return;
    if (!panning.moved) { panning.moved = true; cam.follow = false; }
    const dx = e.clientX - panning.x, dy = e.clientY - panning.y;
    cam.target.addScaledVector(right, -dx * worldPerPx);
    cam.target.addScaledVector(up, dy * worldPerPx * Math.sqrt(3));
    panning.x = e.clientX; panning.y = e.clientY;
    return;
  }
  state.shift = e.shiftKey;
  hover.inside = true; hover.x = e.clientX; hover.y = e.clientY; hover.moved = true;
  // En peinture, la case est calculée tout de suite (sinon : une fois par image, dans updateHover).
  if (state.painting) { hoverCell = pickCell(e.clientX, e.clientY); if (hoverCell) paintTo(hoverCell); }
});
const endPointer = (e) => {
  if (state.painting) saveMap();
  state.painting = false;
  if (e.type === 'pointerup' && panning?.button === 2 && !panning.moved && state.mode === 'play') {
    const cell = pickCell(e.clientX, e.clientY);
    if (cell) openMenu(cell, e.clientX, e.clientY);
  }
  panning = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { hover.inside = false; hoverCell = null; updateTooltip(); });

// Infobulle : stade de croissance de l'arbre survolé.
// Le texte est recalculé quand la case change, sinon au plus 4 fois par seconde ;
// le DOM n'est modifié que si quelque chose change.
const tip = { el: document.getElementById('tooltip'), text: '', x: NaN, z: NaN, at: 0, px: NaN, py: NaN };
function updateTooltip(px, py) {
  const el = tip.el, now = performance.now();
  const x = hoverCell ? hoverCell[0] : NaN, z = hoverCell ? hoverCell[1] : NaN;
  if (x !== tip.x || z !== tip.z || now - tip.at >= 250) {
    tip.x = x; tip.z = z; tip.at = now;
    const text = !hoverCell ? '' : map.hasTree(x, z) ? describeTree(x, z) : map.hasBush(x, z) ? describeBush(x, z) : '';
    if (text !== tip.text) {
      tip.text = text;
      if (text) el.textContent = text;
      if (el.hidden !== !text) el.hidden = !text;
    }
  }
  if (!tip.text || px === undefined || (px === tip.px && py === tip.py)) return;
  tip.px = px; tip.py = py;
  el.style.left = `${px + 14}px`; el.style.top = `${py + 14}px`;
}
// ---------- Menu contextuel (clic droit) ----------
const menu = { el: document.getElementById('ctxmenu'), cell: null };

function tileLabel(x, z) {
  if (map.hasTree(x, z)) return forest.get(x, z)?.majestic ? '✨ Arbre majestueux' : '🌳 Arbre';
  if (map.hasBridge(x, z)) return '🌉 Pont';
  if (map.hasBush(x, z)) return '🌿 Buisson';
  return { [TILE.GRASS]: '🌱 Herbe', [TILE.DIRT]: '🟫 Terre', [TILE.WATER]: '💧 Eau' }[map.get(x, z)] ?? '';
}

function teleportError(x, z) {
  if (x === hero.gridX && z === hero.gridZ && !hero.moving) return 'Tu es déjà ici';
  if (!map.isWalkable(x, z)) return 'Case non praticable';
  return null;
}

function openMenu(cell, px, py) {
  const [x, z] = cell;
  const items = [
    { icon: '🌱', label: 'Lancer une graine', error: throwTargetError(x, z), run: () => throwSeed(cell) },
    { icon: '✨', label: 'Se téléporter ici', error: teleportError(x, z), run: () => teleportHero(cell) },
  ];
  const el = menu.el;
  el.replaceChildren();
  const title = document.createElement('div');
  title.className = 'ctx-title';
  title.textContent = `${tileLabel(x, z)} · ${x}, ${z}`;
  el.append(title);
  for (const it of items) {
    const b = document.createElement('button');
    b.disabled = !!it.error;
    b.innerHTML = `<span class="ctx-icon">${it.icon}</span><span><span class="ctx-label"></span><small></small></span>`;
    b.querySelector('.ctx-label').textContent = it.label;
    b.querySelector('small').textContent = it.error ?? '';
    b.addEventListener('click', () => { closeMenu(); it.run(); });
    el.append(b);
  }
  el.hidden = false;
  // Placé près du curseur, sans déborder de l'écran.
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.min(px + 6, window.innerWidth - r.width - 8)}px`;
  el.style.top = `${Math.min(py + 6, window.innerHeight - r.height - 8)}px`;
  menu.cell = cell;
  el.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

function closeMenu() {
  menu.el.hidden = true;
  menu.cell = null;
}

function teleportHero([x, z]) {
  if (teleportError(x, z)) return;
  const p = hero.root.position;
  sparkles.burst(p.x, p.y + 0.3, p.z, 30, { spread: 0.4, up: 1.4, life: 1, size: 9 });
  hero.teleport(x, z);
  hero.blink();
  sparkles.burst(x + 0.5, LAND_TOP + 0.3, z + 0.5, 36, { spread: 0.5, up: 1.1, life: 1.2, size: 9 });
  saveMap();
}

window.addEventListener('pointerdown', (e) => { if (menu.cell && !menu.el.contains(e.target) && e.target !== canvas) closeMenu(); });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  closeMenu();
  cam.zoom = THREE.MathUtils.clamp(cam.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.35, 3);
  updateProjection();
}, { passive: false });

// Flèches : haut = diagonale haut-droite de l'écran (convention isométrique).
// e.code est positionnel : WASD en QWERTY = ZQSD en AZERTY.
const MOVE_KEYS = {
  ArrowUp: [1, 1], KeyW: [1, 1],
  ArrowDown: [-1, -1], KeyS: [-1, -1],
  ArrowLeft: [-1, 1], KeyA: [-1, 1],
  ArrowRight: [1, -1], KeyD: [1, -1],
};
const held = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  switch (e.code) {
    case 'Escape': closeMenu(); return;
    case 'Tab': e.preventDefault(); setMode(state.mode === 'play' ? 'edit' : 'play'); return;
    case 'KeyG': toggleGrid(); return;
    case 'ShiftLeft': case 'ShiftRight': state.shift = true; return;
    case 'KeyE': cam.rotation += 1; return;
    case 'KeyR': cam.rotation -= 1; return;
    case 'KeyF': cam.follow = true; return;
    case 'Digit1': setBrush(TILE.GRASS); return;
    case 'Digit2': setBrush(TILE.DIRT); return;
    case 'Digit3': setBrush(TILE.WATER); return;
    case 'Digit4': setBrush('tree'); return;
    case 'Digit5': setBrush('hero'); return;
    case 'Space': e.preventDefault(); if (state.mode === 'play') plantInFront(); return;
  }
  if (e.key === '-' || e.key === '[') { setBrushSize(Math.max(1, state.brushSize - 2)); return; }
  if (e.key === '+' || e.key === '=' || e.key === ']') { setBrushSize(Math.min(5, state.brushSize + 2)); return; }
  const dir = MOVE_KEYS[e.code];
  if (dir) { e.preventDefault(); held.add(e.code); }
});
window.addEventListener('keyup', (e) => {
  held.delete(e.code);
  if (e.key === 'Shift') state.shift = false;
});
window.addEventListener('blur', () => { held.clear(); state.shift = false; });

// Déplacement continu tant qu'une touche est maintenue, une case à la fois.
function handleHeldKeys() {
  if (!held.size || hero.busy || hero.path.length !== 0) return;
  let code; // dernière touche enfoncée (ordre d'insertion du Set), sans copier le Set
  for (code of held);
  const dir = MOVE_KEYS[code];
  const [dx, dz] = gridDirFromScreen(dir[0], dir[1]);
  cam.follow = true;
  hero.step(dx, dz, map);
}

// ---------- Interface ----------
const ui = {
  modeButtons: document.querySelectorAll('button[data-mode]'),
  brushButtons: document.querySelectorAll('[data-brush]'),
  sizeButtons: document.querySelectorAll('[data-size]'),
  editor: document.getElementById('editor'),
  file: document.getElementById('import-file'),
};

function setMode(mode) {
  closeMenu();
  state.mode = mode;
  document.body.dataset.mode = mode;
  ui.modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode === 'play') cam.follow = true;
  if (gridLines) gridLines.visible = state.grid[mode];
}
function setBrush(brush, switchToEditor = true) {
  state.brush = brush;
  ui.brushButtons.forEach((b) => b.classList.toggle('active', b.dataset.brush === String(brush)));
  if (switchToEditor && state.mode !== 'edit') setMode('edit');
}
function setBrushSize(n) {
  state.brushSize = n;
  ui.sizeButtons.forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === n));
}

ui.modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
ui.brushButtons.forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.brush;
  setBrush(v === 'hero' || v === 'tree' ? v : Number(v));
}));
ui.sizeButtons.forEach((b) => b.addEventListener('click', () => setBrushSize(Number(b.dataset.size))));

const actions = {
  undo,
  plant: plantInFront,
  new: () => { pushUndo(); setMap(new GameMap(MAP_SIZE, MAP_SIZE, TILE.GRASS)); saveMap(); },
  random: () => { pushUndo(); setMap(GameMap.random(MAP_SIZE, MAP_SIZE), true); saveMap(); },
  export: () => {
    const blob = new Blob([JSON.stringify(map.toJSON())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'carte.json';
    a.click();
    URL.revokeObjectURL(a.href);
  },
  import: () => ui.file.click(),
};
document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => { b.blur(); actions[b.dataset.action](); }));
ui.file.addEventListener('change', async () => {
  const f = ui.file.files[0];
  ui.file.value = '';
  if (!f) return;
  try {
    const m = GameMap.fromJSON(JSON.parse(await f.text()));
    pushUndo();
    setMap(m);
    saveMap();
  } catch (err) {
    alert(`Import impossible : ${err.message}`);
  }
});

// ---------- Boucle ----------
setMap(map, true);
document.querySelector('#inventory b').textContent = inventory.logs;
setBrush(TILE.GRASS, false);
setBrushSize(1);
setMode('play');
resize();
cam.target.set(hero.gridX + 0.5, LAND_TOP, hero.gridZ + 0.5);

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.mode === 'edit' && held.size) {
    // En mode édition, les flèches font défiler la caméra.
    cam.follow = false;
    const { right, up } = screenAxes();
    for (const code of held) {
      const [sx, sy] = MOVE_KEYS[code];
      cam.target.addScaledVector(right, sx * dt * 8 / cam.zoom).addScaledVector(up, sy * dt * 8 / cam.zoom);
    }
  } else {
    handleHeldKeys();
  }
  hero.update(dt, map);
  shared.uHero.value.copy(hero.root.position);
  terrain.update(dt);
  forest.update(dt);
  bridges.update(dt);
  shrubs.update(dt, hero.root.position);
  updateEcology(dt);
  pathPreview.update(dt, hero, shared.uTime.value);
  seeds.update(dt);
  sparkles.update(dt);
  flushRebuild();
  grass.setZoom(cam.zoom);
  updateHover();
  updateCamera(dt);
  updateSun();
  updateCursor();
  if (perf.bloom) composer.render(dt);
  else renderer.render(scene, camera);
});

// Accès de débogage depuis la console.
// Réglages de diagnostic (mesures de performances).
const perf = { bloom: true };
window.game = { get map() { return map; }, hero, cam, setMap, terrain, forest, plantInFront, throwSeed, click: playClick, inventory, shrubs, camera, ecology: () => { ecologyClock = 99; },
  debug: { perf, renderer, composer, bloom, scene, grass, motes, sparkles, bridges, pathPreview, seeds, refreshWorld, paint, paintTo, flushRebuild, saveMap, state, buildGrid } };
