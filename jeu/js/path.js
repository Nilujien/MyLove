import * as THREE from 'three';
import { LAND_TOP } from './terrain.js';

const MAX_DOTS = 1024;

// Pointillés lumineux discrets le long du chemin choisi, et repère pulsant sur la destination.
export class PathPreview {
  constructor(scene) {
    const disc = new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2);
    this.material = new THREE.MeshBasicMaterial({ color: 0xfff6dc, transparent: true, opacity: 0.5, depthWrite: false });
    this.dots = new THREE.InstancedMesh(disc, this.material, MAX_DOTS);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 3;
    this.dots.raycast = () => {};
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.25, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xfff6dc, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.ring.renderOrder = 3;
    this.ring.visible = false;
    this.ring.raycast = () => {};
    scene.add(this.dots, this.ring);
    this.m = new THREE.Matrix4();
    this.alpha = 0;
    this.idle = true; // rien d'affiché : aucune mise à jour
    // Dernier état dessiné (pour ne reconstruire les points que s'il change).
    this.lastPath = null; this.lastLen = -1; this.lastFirst = null; this.lastMoving = null;
    this.lastLX = 0; this.lastLZ = 0;
  }

  // Ajoute un point (au plus MAX_DOTS) ; renvoie le nouveau nombre de points.
  put(n, x, y, z, r) {
    if (n >= MAX_DOTS) return n;
    this.m.makeScale(r, 1, r).setPosition(x, y, z);
    this.dots.setMatrixAt(n, this.m);
    return n + 1;
  }

  // Reconstruit les points du chemin ; renvoie le nombre de cases (0 si aucun chemin).
  rebuild(hero) {
    const y = LAND_TOP + 0.025;
    const path = hero.path, mv = hero.moving;
    const total = hero.showPath ? path.length + (mv ? 1 : 0) : 0;
    const hp = hero.root.position;
    let px = hp.x, pz = hp.z, n = 0;
    for (let i = 0; i < total; i++) {
      let cx, cz;
      if (mv && i === 0) { cx = mv.toX; cz = mv.toZ; } else { const c = path[mv ? i - 1 : i]; cx = c[0]; cz = c[1]; }
      const x = cx + 0.5, z = cz + 0.5;
      // Point intermédiaire, puis point de case (sauf la dernière, marquée par l'anneau).
      if (Math.hypot(x - px, z - pz) > 0.6) n = this.put(n, (x + px) / 2, y, (z + pz) / 2, 0.028);
      if (i < total - 1) n = this.put(n, x, y, z, 0.045);
      px = x; pz = z;
      if (i === total - 1) { this.lastLX = cx; this.lastLZ = cz; }
    }
    this.dots.count = n;
    if (n) {
      const im = this.dots.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
    }
    return total;
  }

  update(dt, hero, t) {
    const path = hero.path, mv = hero.moving;
    const has = hero.showPath && (path.length > 0 || !!mv);
    if (!has && this.alpha < 0.01) {
      // Rien à montrer : on coupe tout une seule fois.
      if (!this.idle) {
        this.idle = true;
        this.alpha = 0;
        this.dots.count = 0;
        this.dots.visible = this.ring.visible = false;
        this.lastPath = null;
      }
      return;
    }
    this.idle = false;
    this.dots.visible = true;
    // Points à refaire si le chemin ou la case visée change, ou à chaque image pendant un pas
    // (le premier point intermédiaire suit la position du personnage).
    const changed = path !== this.lastPath || path.length !== this.lastLen || path[0] !== this.lastFirst || mv !== this.lastMoving;
    let cells = has ? 1 : 0;
    if (changed || mv) {
      this.lastPath = path; this.lastLen = path.length; this.lastFirst = path[0]; this.lastMoving = mv;
      cells = this.rebuild(hero);
    }
    // Fondu d'apparition / disparition.
    this.alpha += ((cells ? 1 : 0) - this.alpha) * Math.min(1, dt * 8);
    const y = LAND_TOP + 0.025;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    this.material.opacity = (0.32 + 0.12 * pulse) * this.alpha;
    if (cells) this.ring.position.set(this.lastLX + 0.5, y, this.lastLZ + 0.5);
    this.ring.visible = this.alpha > 0.02;
    this.ring.scale.setScalar(0.9 + 0.15 * pulse);
    this.ring.material.opacity = (0.4 + 0.2 * pulse) * this.alpha;
  }
}
