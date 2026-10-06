import * as THREE from 'three';
import { LAND_TOP } from './terrain.js';

const STEP_TIME = 0.22; // secondes par case
const HOP = 0.14;

// Personnage low-poly qui se déplace case par case.
export class Character {
  constructor(scene, x, z) {
    this.gridX = x;
    this.gridZ = z;
    this.path = [];
    this.moving = null; // { fromX, fromZ, toX, toZ, t }
    this.time = 0;
    this.facing = [0, 1];
    this.crouch = 0; // animation de plantation (1 -> 0)

    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.34, 8), mat(0xe8505b));
    torso.position.y = 0.3;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 1), mat(0xffd7b5));
    head.position.y = 0.6;
    const hat = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.2, 8), mat(0x3a63c8));
    hat.position.y = 0.78;
    const eyeGeo = new THREE.SphereGeometry(0.022, 6, 4);
    const eyeMat = mat(0x222222);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    const eyeR = eyeL.clone();
    eyeL.position.set(-0.055, 0.62, 0.135);
    eyeR.position.set(0.055, 0.62, 0.135);
    const legGeo = new THREE.BoxGeometry(0.08, 0.14, 0.08);
    this.legL = new THREE.Mesh(legGeo, mat(0x4a3b5c));
    this.legR = this.legL.clone();
    this.legL.position.set(-0.08, 0.07, 0);
    this.legR.position.set(0.08, 0.07, 0);
    for (const m of [torso, head, hat, eyeL, eyeR, this.legL, this.legR]) {
      m.castShadow = true;
      this.body.add(m);
    }
    scene.add(this.root);
    this.snap();
  }

  snap() {
    this.root.position.set(this.gridX + 0.5, LAND_TOP, this.gridZ + 0.5);
  }

  teleport(x, z) {
    this.gridX = x; this.gridZ = z;
    this.path = []; this.moving = null;
    this.snap();
  }

  // Case devant le personnage (selon sa dernière direction).
  get front() {
    const x = this.moving ? this.moving.toX : this.gridX;
    const z = this.moving ? this.moving.toZ : this.gridZ;
    return [x + this.facing[0], z + this.facing[1]];
  }

  playPlant() { this.crouch = 1; }

  // Se tourne vers un point quelconque (lancer), en gardant une direction de grille pour « devant ».
  lookAt(dx, dz) {
    if (!dx && !dz) return;
    this.facing = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)];
    this.targetYaw = Math.atan2(dx, dz);
  }

  get busy() { return this.moving !== null; }

  // Remplace le chemin à suivre (liste de [x, z]).
  setPath(path) { this.path = path.slice(); }

  // Pas unique au clavier : n'interrompt pas un pas en cours, il est mis en file.
  step(dx, dz, map) {
    const fromX = this.moving ? this.moving.toX : this.gridX;
    const fromZ = this.moving ? this.moving.toZ : this.gridZ;
    this.face(dx, dz);
    const nx = fromX + dx, nz = fromZ + dz;
    if (!map.isWalkable(nx, nz)) return false;
    this.path = [[nx, nz]];
    this.faceAfter = null;
    return true;
  }

  face(dx, dz) {
    this.facing = [dx, dz];
    this.targetYaw = Math.atan2(dx, dz);
  }

  update(dt, map) {
    this.time += dt;
    if (!this.moving && this.path.length) {
      const [nx, nz] = this.path.shift();
      if (map.isWalkable(nx, nz) && Math.abs(nx - this.gridX) + Math.abs(nz - this.gridZ) === 1) {
        this.face(nx - this.gridX, nz - this.gridZ);
        this.moving = { fromX: this.gridX, fromZ: this.gridZ, toX: nx, toZ: nz, t: 0 };
      } else {
        this.path = [];
      }
    }

    if (!this.moving && !this.path.length && this.faceAfter) {
      this.face(this.faceAfter[0] - this.gridX, this.faceAfter[1] - this.gridZ);
      this.faceAfter = null;
    }

    let hop = 0, swing = 0;
    if (this.moving) {
      const m = this.moving;
      m.t = Math.min(1, m.t + dt / STEP_TIME);
      const e = m.t * m.t * (3 - 2 * m.t);
      this.root.position.x = m.fromX + (m.toX - m.fromX) * e + 0.5;
      this.root.position.z = m.fromZ + (m.toZ - m.fromZ) * e + 0.5;
      hop = Math.sin(Math.PI * m.t) * HOP;
      swing = Math.sin(Math.PI * 2 * m.t) * 0.6;
      if (m.t >= 1) {
        this.gridX = m.toX; this.gridZ = m.toZ;
        this.moving = null;
      }
    }
    this.crouch = Math.max(0, this.crouch - dt * 2.5);
    const bow = Math.sin(this.crouch * Math.PI);
    this.body.position.y = hop + (this.moving ? 0 : Math.sin(this.time * 3) * 0.01) - bow * 0.08;
    this.body.rotation.x = bow * 0.35;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;

    if (this.targetYaw !== undefined) {
      let d = this.targetYaw - this.root.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.root.rotation.y += d * Math.min(1, dt * 18);
    }
  }
}
