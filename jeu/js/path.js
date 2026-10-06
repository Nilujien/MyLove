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
  }

  update(dt, hero, t) {
    const cells = [];
    if (hero.showPath) {
      if (hero.moving) cells.push([hero.moving.toX, hero.moving.toZ]);
      cells.push(...hero.path);
    }
    // Fondu d'apparition / disparition.
    this.alpha += ((cells.length ? 1 : 0) - this.alpha) * Math.min(1, dt * 8);
    const y = LAND_TOP + 0.025;
    let n = 0;
    const put = (x, z, r) => {
      if (n >= MAX_DOTS) return;
      this.m.makeScale(r, 1, r).setPosition(x, y, z);
      this.dots.setMatrixAt(n++, this.m);
    };
    const hp = hero.root.position;
    let px = hp.x, pz = hp.z;
    cells.forEach(([cx, cz], i) => {
      const x = cx + 0.5, z = cz + 0.5;
      // Point intermédiaire, puis point de case (sauf la dernière, marquée par l'anneau).
      if (Math.hypot(x - px, z - pz) > 0.6) put((x + px) / 2, (z + pz) / 2, 0.028);
      if (i < cells.length - 1) put(x, z, 0.045);
      px = x; pz = z;
    });
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    this.material.opacity = (0.32 + 0.12 * pulse) * this.alpha;
    if (cells.length) {
      const [lx, lz] = cells[cells.length - 1];
      this.ring.position.set(lx + 0.5, y, lz + 0.5);
    }
    this.ring.visible = this.alpha > 0.02;
    this.ring.scale.setScalar(0.9 + 0.15 * pulse);
    this.ring.material.opacity = (0.4 + 0.2 * pulse) * this.alpha;
  }
}
