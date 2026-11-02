import * as THREE from 'three';
import { Animator } from './animator.js';
import { Ragdoll } from './ragdoll.js';
import { moveBody } from '../world/collision.js';
import { clamp, damp, dampAngle, lerp, wrapAngle, rand } from '../core/math.js';
import { Trail } from '../fx/fx.js';

// Shared character base: kinematic body, procedural animator, sword trail, footsteps, ragdoll death.
export class Character {
  constructor(game, rig, opts = {}) {
    this.game = game;
    this.rig = rig;
    const S = rig.scale;
    this.body = {
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), radius: (opts.radius ?? 0.34) * S, height: 1.8 * S,
      grounded: true, groundY: 0, landed: false, wallHit: false,
    };
    this.yaw = 0;
    this.anim = new Animator(rig, opts);
    this.hp = this.maxHp = opts.hp ?? 100;
    this.alive = true;
    this.state = 'idle';
    this.stateT = 0;
    this.ragdoll = null;
    this.guard = opts.guard;
    this.combat = false;
    this.lastVel = new THREE.Vector3();
    this.trail = new Trail(game.scene, opts.trail || {});
    this.trailOn = false;
    this.bladeBase = new THREE.Vector3();
    this.bladeTip = new THREE.Vector3();
    this.prevBase = new THREE.Vector3();
    this.prevTip = new THREE.Vector3();
    this.hitSet = new Set();
    this.bladeBlood = 0;
    game.scene.add(rig.root);
    this.anim.stepCallback = (foot, speed) => {
      if (this.game.audio && speed > 0.3) this.game.audio.play('footstep', { pos: foot.pos, volume: clamp(0.25 + speed * 0.07, 0.25, 0.8) * (opts.stepVol ?? 1) });
    };
  }

  setState(s) { this.state = s; this.stateT = 0; }
  forward(out) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  center(out) { return out.copy(this.body.pos).setY(this.body.pos.y + 1.1 * this.rig.scale); }
  headPos(out) { return this.rig.bones.head.getWorldPosition(out); }
  distTo(other) { return Math.hypot(other.body.pos.x - this.body.pos.x, other.body.pos.z - this.body.pos.z); }
  angleTo(other) {
    const a = Math.atan2(other.body.pos.x - this.body.pos.x, other.body.pos.z - this.body.pos.z);
    return wrapAngle(a - this.yaw);
  }
  yawTo(x, z) { return Math.atan2(x - this.body.pos.x, z - this.body.pos.z); }
  faceTo(x, z, k, dt) { this.yaw = dampAngle(this.yaw, this.yawTo(x, z), k, dt); }

  // world -> character-local direction (x right?, z forward). Returns {x: lateral (+left), z: forward}
  toLocal(v, out) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    out.x = v.x * c - v.z * s;
    out.z = v.x * s + v.z * c;
    out.y = v.y;
    return out;
  }

  // Shared locomotion pose: guard stance blending into a run with the sword trailing.
  locomotionPose(P, dt, G, opts = {}) {
    const sp = Math.hypot(this.body.vel.x, this.body.vel.z);
    const run = clamp((sp - 1.0) / 5.5, 0, 1);
    const ph = this.anim.phase * Math.PI * 2;
    const combatK = this.combat ? 1 : 0;
    this._combatK = damp(this._combatK ?? 0, combatK, 4, dt);
    const ck = this._combatK * (1 - run * 0.85);
    // relaxed (exploration) vs guard (combat)
    const rx = opts.relaxed || { g: [-0.24, 0.92, 0.12], b: [0.05, -0.35, 1], l: [0.22, 0.95, 0.04] };
    P.grip.set(lerp(rx.g[0], G.g[0], ck), lerp(rx.g[1], G.g[1], ck), lerp(rx.g[2], G.g[2], ck));
    P.blade.set(lerp(rx.b[0], G.b[0], ck), lerp(rx.b[1], G.b[1], ck), lerp(rx.b[2], G.b[2], ck)).normalize();
    const rl = rx.l || [0.22, 1.0, 0.12];
    P.handL.set(lerp(rl[0], G.l?.[0] ?? 0.2, ck), lerp(rl[1], G.l?.[1] ?? 1.1, ck), lerp(rl[2], G.l?.[2] ?? 0.2, ck));
    P.two = (G.two ?? 0) * ck + (rx.two ?? 0) * (1 - ck);
    const tw = (G.tw ?? 0) * ck;
    P.spine.set(0.02, tw * 0.45, 0);
    P.chest.set(0.02, tw * 0.55, 0);
    P.hips.set(0, (G.hy ?? 0) * ck, 0);
    P.hipsRot.set(0, 0, 0);
    P.head.set(0, -tw * 0.8, 0);
    P.poleR.set(-0.7, -0.5, -0.5);
    P.poleL.set(0.7, -0.5, -0.5);
    P.footL = P.footR = null;
    P.kickR = null;
    if (run > 0.01 || sp > 0.3) {
      // running: sword arm trails low behind, free arm pumps, torso leans and counter-rotates
      const w = clamp(sp / 2, 0, 1);
      const trailG = _tg.set(-0.3, 0.98 + Math.sin(ph * 2) * 0.02, -0.12 - run * 0.08);
      const trailB = _tb.set(-0.15, -0.3, -0.94).normalize();
      if (!opts.noTrailSword) {
        P.grip.lerp(trailG, run);
        P.blade.lerp(trailB, run).normalize();
      }
      const swing = Math.sin(ph);
      if (P.two < 0.5) {
        P.handL.x = lerp(P.handL.x, 0.2, w);
        P.handL.y = lerp(P.handL.y, 1.0 + run * 0.08 + Math.max(0, swing) * 0.12 * run, w);
        P.handL.z = lerp(P.handL.z, 0.05 + swing * (0.12 + run * 0.22), w);
      }
      P.spine.x += run * 0.18;
      P.chest.x += run * 0.12;
      P.chest.y += -swing * 0.12 * w;
      P.hipsRot.y = swing * 0.14 * w;
      P.head.y += swing * 0.08 * w;
      P.head.x -= run * 0.15;
    }
    return run;
  }

  // body lean from acceleration (whole-body tilt in the animator)
  updateLean(dt) {
    const ax = (this.body.vel.x - this.lastVel.x) / Math.max(dt, 1e-4);
    const az = (this.body.vel.z - this.lastVel.z) / Math.max(dt, 1e-4);
    this.lastVel.copy(this.body.vel);
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const fwdA = ax * s + az * c;
    const sideA = ax * c - az * s;
    const sp = Math.hypot(this.body.vel.x, this.body.vel.z);
    const tx = clamp(fwdA * 0.012 + sp * 0.012, -0.25, 0.3);
    const ty = clamp(-sideA * 0.01, -0.2, 0.2);
    if (this.body.grounded) {
      this.anim.bodyTilt.x = damp(this.anim.bodyTilt.x, tx, 8, dt);
      this.anim.bodyTilt.y = damp(this.anim.bodyTilt.y, ty, 8, dt);
    } else {
      this.anim.bodyTilt.x = damp(this.anim.bodyTilt.x, 0, 6, dt);
      this.anim.bodyTilt.y = damp(this.anim.bodyTilt.y, 0, 6, dt);
    }
  }

  physics(dt, gravity = 24) {
    moveBody(this.game.world, this.body, dt, gravity);
    // smooth visual stepping on stairs
    if (this.body.grounded) {
      const dy = this.body.pos.y - (this._lastY ?? this.body.pos.y);
      if (Math.abs(dy) > 0.02 && Math.abs(dy) < 0.55) this.body.visualYOffset = (this.body.visualYOffset || 0) - dy;
    }
    this._lastY = this.body.pos.y;
    this.body.visualYOffset = damp(this.body.visualYOffset || 0, 0, 14, dt);
  }

  animate(dt) {
    if (this.ragdoll && this.ragdoll.active) { this.ragdoll.update(dt); return; }
    if (this.ragdoll) return;
    this.anim.update(dt, this);
    // blade tracking for trails + hit sweeps
    this.prevBase.copy(this.bladeBase);
    this.prevTip.copy(this.bladeTip);
    if (this.anim.bladeSegment(this.bladeBase, this.bladeTip)) {
      if (this._bladeInit !== true) { this.prevBase.copy(this.bladeBase); this.prevTip.copy(this.bladeTip); this._bladeInit = true; }
      if (this.trailOn) this.trail.push(this.bladeBase, this.bladeTip, this.game.time.game);
    }
    this.trail.update(this.game.time.game);
    if (this.rig.sword) {
      const u = this.rig.sword.material.userData.uniforms;
      u.uBladeBlood.value = damp(u.uBladeBlood.value, this.bladeBlood, 3, dt);
    }
    const hf = this.rig.material.userData.uniforms.uHitFlash;
    if (hf && hf.value > 0) hf.value = Math.max(0, hf.value - this.game.time.realDt * 7);
  }

  // Start ragdoll with a push
  ragdollDeath(vel, impulse, part = 'chest') {
    this.ragdoll = new Ragdoll(this.rig, this.game.world);
    this.ragdoll.start(vel, impulse, part);
    this.trailOn = false;
  }

  dropSword(vel) {
    const sw = this.rig.sword;
    if (!sw) return;
    sw.updateWorldMatrix(true, false);
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    sw.matrixWorld.decompose(wp, wq, ws);
    sw.removeFromParent();
    sw.position.copy(wp); sw.quaternion.copy(wq); sw.scale.copy(ws);
    this.rig.sword = null;
    this.game.fx.addDebris(sw, vel || new THREE.Vector3(rand(-2, 2), 3, rand(-2, 2)), new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8)), {
      radius: 0.03, bounce: 0.3, life: 30,
      onHit: (d, s) => { if (s > 3) this.game.audio.play('clash', { pos: d.obj.position, volume: 0.35, rate: 1.3 }); },
    });
  }

  dispose() {
    this.rig.root.removeFromParent();
    this.trail.mesh.removeFromParent();
  }
}
const _tg = new THREE.Vector3(), _tb = new THREE.Vector3();
