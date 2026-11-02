import * as THREE from 'three';
import { clamp, damp, dampAngle, noise1, wrapAngle } from './math.js';

// Third-person orbit camera: smoothed follow, collision, lock-on framing, trauma shake, cinematic overrides.
export class CameraRig {
  constructor(camera, world) {
    this.cam = camera;
    this.world = world;
    this.yaw = Math.PI;        // camera looks along (-sin yaw, -cos yaw)... see forward()
    this.pitch = 0.22;
    this.dist = 4.6;
    this.distTarget = 4.6;
    this.pivot = new THREE.Vector3();
    this.pivotVel = new THREE.Vector3();
    this.shoulder = 0.42;
    this.trauma = 0;
    this.kick = new THREE.Vector3();
    this.fovBase = 62;
    this.fovKick = 0;
    this.lock = null;          // Vector3 to frame
    this.cine = null;          // {pos, look, t, dur}
    this.cineBlend = 0;
    this._look = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this.autoYaw = 0;
    this.idleTime = 0;
  }

  // Direction the camera faces on the ground plane
  forward(out) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  right(out) { return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  shake(amount) { this.trauma = Math.min(1, this.trauma + amount); }
  punch(dir, amount) { this.kick.addScaledVector(dir, amount); }
  zoomKick(deg) { this.fovKick += deg; }

  cinematic(pos, look, dur = 1.0) {
    this.cine = { pos: pos.clone(), look: look.clone(), t: 0, dur };
  }

  update(realDt, dt, target, lookInput, opts = {}) {
    // input
    this.yaw -= lookInput.x;
    this.pitch = clamp(this.pitch + lookInput.y, -0.55, 1.05);
    if (Math.abs(lookInput.x) + Math.abs(lookInput.y) > 0.0005) this.idleTime = 0;
    else this.idleTime += realDt;

    // lock-on framing: rotate toward target
    if (this.lock) {
      const dx = this.lock.x - target.x, dz = this.lock.z - target.z;
      const want = Math.atan2(-dx, -dz);
      this.yaw = dampAngle(this.yaw, want, 7, realDt);
      const flat = Math.hypot(dx, dz);
      const wantPitch = clamp(0.18 + (this.lock.y - target.y) * -0.05 + (flat < 3 ? 0.08 : 0), 0.05, 0.45);
      this.pitch = damp(this.pitch, wantPitch, 3, realDt);
    } else if (opts.assistYaw !== undefined && this.idleTime > 0.6) {
      this.yaw = dampAngle(this.yaw, opts.assistYaw, 1.2, realDt);
    }

    // pivot follows player with slight lag; vertical lags more (smooth jumps)
    const tgt = _t.copy(target);
    tgt.y += 1.45;
    this.pivot.x = damp(this.pivot.x, tgt.x, 16, realDt);
    this.pivot.z = damp(this.pivot.z, tgt.z, 16, realDt);
    this.pivot.y = damp(this.pivot.y, tgt.y, opts.airborne ? 5 : 10, realDt);
    if (this.pivot.distanceTo(tgt) > 6) this.pivot.copy(tgt);

    this.distTarget = opts.combat ? 5.0 : 4.4;
    if (this.lock) this.distTarget = 5.4;
    this.dist = damp(this.dist, this.distTarget, 2.5, realDt);

    // desired position
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const back = _b.set(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp);
    const right = this.right(_r);
    const piv = _p.copy(this.pivot).addScaledVector(right, this.shoulder);
    // collision: ray from pivot back toward camera
    let d = this.dist;
    const hit = this.world.raycast(piv, back, d + 0.3, true);
    if (hit !== Infinity) d = Math.max(0.6, hit - 0.3);
    this._smoothD = this._smoothD === undefined ? d : (d < this._smoothD ? d : damp(this._smoothD, d, 4, realDt));
    const pos = this._pos.copy(piv).addScaledVector(back, this._smoothD);
    const look = this._look.copy(piv).addScaledVector(back, -4);
    look.y -= 0.35;

    // cinematic override
    if (this.cine) {
      this.cine.t += realDt;
      const k = this.cine.t < this.cine.dur ? Math.min(1, this.cine.t / 0.25) : Math.max(0, 1 - (this.cine.t - this.cine.dur) / 0.35);
      this.cineBlend = k * k * (3 - 2 * k);
      if (this.cine.t > this.cine.dur + 0.35) { this.cine = null; this.cineBlend = 0; }
    }
    if (this.cine) {
      pos.lerp(this.cine.pos, this.cineBlend);
      look.lerp(this.cine.look, this.cineBlend);
      const R = this.world.ring;
      if (R) {
        // keep cinematic angles inside the arena wall
        const dx = pos.x - R.cx, dz = pos.z - R.cz, d = Math.hypot(dx, dz), lim = R.r - 0.6;
        if (d > lim) { pos.x = R.cx + dx / d * lim; pos.z = R.cz + dz / d * lim; }
      }
    }

    // shake
    this.trauma = Math.max(0, this.trauma - realDt * 1.6);
    const s = this.trauma * this.trauma;
    const tt = performance.now() * 0.001 * 28;
    pos.x += noise1(tt) * s * 0.35; pos.y += noise1(tt + 50) * s * 0.3; pos.z += noise1(tt + 100) * s * 0.35;
    this.kick.multiplyScalar(Math.exp(-realDt * 14));
    pos.add(this.kick);

    this.cam.position.copy(pos);
    this.cam.lookAt(look);
    this.cam.rotateZ(noise1(tt + 200) * s * 0.06);
    this.fovKick *= Math.exp(-realDt * 6);
    const fov = this.fovBase + this.fovKick + (opts.sprint ? 4 : 0);
    if (Math.abs(this.cam.fov - fov) > 0.01) { this.cam.fov = damp(this.cam.fov, fov, 10, realDt); this.cam.updateProjectionMatrix(); }
  }

  snapBehind(yaw) { this.yaw = wrapAngle(yaw + Math.PI); }
}
const _t = new THREE.Vector3(), _b = new THREE.Vector3(), _r = new THREE.Vector3(), _p = new THREE.Vector3();
