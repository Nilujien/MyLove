import * as THREE from 'three';

// Graines lancées en cloche, avec une traînée d'étincelles.
export class SeedThrower {
  constructor(scene, sparkles) {
    this.scene = scene;
    this.sparkles = sparkles;
    this.flying = [];
    this.geometry = new THREE.SphereGeometry(0.055, 10, 8).scale(1, 0.75, 1);
    this.material = new THREE.MeshLambertMaterial({ color: 0xe8c890, emissive: 0xffd98a, emissiveIntensity: 0.9 });
  }

  // from, to : THREE.Vector3 ; onLand appelé à l'atterrissage.
  throw(from, to, onLand) {
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.castShadow = true;
    mesh.position.copy(from);
    this.scene.add(mesh);
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    this.flying.push({
      mesh, from: from.clone(), to: to.clone(), onLand, t: 0, trail: 0,
      duration: 0.35 + dist * 0.07,
      arc: 0.5 + dist * 0.18,
    });
  }

  update(dt) {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const s = this.flying[i];
      s.t = Math.min(1, s.t + dt / s.duration);
      const p = s.mesh.position;
      p.lerpVectors(s.from, s.to, s.t);
      p.y += Math.sin(Math.PI * s.t) * s.arc;
      s.mesh.rotation.x += dt * 9;
      s.mesh.rotation.z += dt * 6;
      s.trail += dt;
      while (s.trail > 0.025) {
        s.trail -= 0.025;
        this.sparkles.burst(p.x, p.y - 0.1, p.z, 1, { spread: 0.05, up: 0.1, life: 0.45, size: 6 });
      }
      if (s.t >= 1) {
        this.scene.remove(s.mesh);
        this.flying.splice(i, 1);
        s.onLand();
      }
    }
  }
}
