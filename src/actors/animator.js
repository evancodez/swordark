import * as THREE from 'three';
import { Pose, blendPose, sampleClip } from './pose.js';
import { clamp, damp, lerp, quatFromYZ, smoothstep, spring, wrapAngle, ease } from '../core/math.js';

// Procedural animator: every frame the pose is computed from character state.
// Upper body: FK spine + two-bone IK arms reaching for sword-grip targets.
// Lower body: planted-foot gait with two-bone IK legs, works on stairs and slopes.

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

class Foot {
  constructor(side) {
    this.side = side; // 1 = left (+x), -1 = right
    this.pos = new THREE.Vector3();     // world ankle-ground point
    this.yaw = 0;
    this.swing = false;
    this.swingT = 0;
    this.swingDur = 0.25;
    this.from = new THREE.Vector3();
    this.fromYaw = 0;
    this.lift = 0.1;
    this.pitch = 0;
    this.planted = true;
    this.lastPhaseSwing = false;
  }
}

export class Animator {
  constructor(rig, opts = {}) {
    this.rig = rig;
    this.pose = new Pose();
    this.base = new Pose();
    this.action = new Pose();
    this.from = new Pose();
    this.final = new Pose();
    this.actionW = 0;
    this.clip = null;
    this.clipT = 0;
    this.clipSpeed = 1;
    this.clipBlendIn = 0.06;
    this.clipBlendOut = 0.15;
    this.clipEnding = false;
    this.feet = [new Foot(1), new Foot(-1)];
    this.phase = 0;
    this.stanceW = opts.stanceW ?? 0.12;
    this.footMode = 'gait';   // 'gait' | 'air'
    this.airPose = 0;
    // springs for additive reactions
    this.flinch = { x: 0, v: 0 };   // lean back
    this.twist = { x: 0, v: 0 };
    this.side = { x: 0, v: 0 };
    this.headSnap = { x: 0, v: 0 };
    this.land = { x: 0, v: 0 };
    this.lookYaw = 0;          // head look (relative yaw)
    this.lookPitch = 0;
    this.breath = Math.random() * 10;
    this.hipsBob = 0;
    this.flip = 0;             // full-body pitch rotation (radians) for flips
    this.roll = 0;             // full body roll (for dodges / vaults)
    this.bodyTilt = new THREE.Vector2(); // lean of whole body (x: forward, y: side) from acceleration
    this.hipDrop = 0;
    this.initialized = false;
    this.gripOffset = new THREE.Vector3(0, -0.085, 0.01);
    this.lastBlade = new THREE.Vector3(0, 0, 1);
    this.stepCallback = null;
  }

  playClip(clip, opts = {}) {
    this.from.copy(this.final);
    this.clip = clip;
    this.clipT = opts.startAt || 0;
    this.clipSpeed = opts.speed || 1;
    this.clipBlendIn = opts.blendIn ?? clip.blendIn ?? 0.05;
    this.clipBlendOut = opts.blendOut ?? clip.blendOut ?? 0.16;
    this.actionW = 1;
    this.clipEnding = false;
    this.useStart = opts.useStart !== false;
  }
  stopClip(blendOut = 0.15) {
    if (!this.clip) return;
    this.clipEnding = true;
    this.clipBlendOut = blendOut;
  }
  get clipDone() { return !this.clip || this.clipT >= this.clip.dur; }

  hit(dirLocalX, dirLocalZ, strength = 1) {
    // additive flinch impulse: dir is attack travel direction in char space
    this.flinch.v += -dirLocalZ * 9 * strength + 5 * strength;
    this.twist.v += dirLocalX * 14 * strength;
    this.side.v += -dirLocalX * 6 * strength;
    this.headSnap.v += 16 * strength;
  }

  // ---------- main update ----------
  update(dt, ch) {
    const rig = this.rig;
    const body = ch.body;
    const S = rig.scale;
    // springs
    spring(this.flinch, 0, 2.2, dt, 0.45);
    spring(this.twist, 0, 2.4, dt, 0.5);
    spring(this.side, 0, 2.4, dt, 0.5);
    spring(this.headSnap, 0, 3, dt, 0.4);
    spring(this.land, 0, 3.5, dt, 0.5);
    this.breath += dt;

    // clip
    if (this.clip) {
      this.clipT += dt * this.clipSpeed;
      sampleClip(this.clip, this.clipT, this.action, this.useStart ? this.from : null);
      if (this.clipEnding || this.clipT >= this.clip.dur) {
        this.actionW -= dt / Math.max(0.01, this.clipBlendOut);
        if (this.actionW <= 0) { this.actionW = 0; this.clip = null; }
      }
    }

    // base pose provided by character (locomotion / stance / air)
    ch.buildBasePose(this.base, dt);
    blendPose(this.final, this.base, this.action, this.clip ? ease.inOut(clamp(this.actionW, 0, 1)) : 0);
    const P = this.final;

    // additive
    const br = Math.sin(this.breath * 1.8) * 0.012;
    P.chest.x += br - this.flinch.x * 0.12;
    P.spine.x += -this.flinch.x * 0.08;
    P.chest.y += this.twist.x * 0.08;
    P.spine.z += this.side.x * 0.06;
    P.head.x += -this.headSnap.x * 0.05;
    P.hips.y += -this.land.x * 0.05 + this.hipsBob;

    // ---------- root placement ----------
    rig.root.position.copy(body.pos);
    if (body.visualYOffset) rig.root.position.y += body.visualYOffset;
    rig.root.rotation.set(0, ch.yaw, 0);
    // whole-body flips / rolls / tilt pivot around hips
    const vis = rig.visual;
    const pivotY = 0.95 * S;
    _q.setFromEuler(_e.set(this.flip + this.bodyTilt.x, 0, this.roll + this.bodyTilt.y, 'YXZ'));
    vis.quaternion.copy(_q);
    _v.set(0, pivotY, 0).applyQuaternion(_q);
    vis.position.set(0, pivotY - _v.y, -_v.z);
    vis.position.x = -_v.x;

    // ---------- spine FK ----------
    const B = rig.bones;
    const J = rig.J;
    const hipsDrop = this.hipDrop;
    B.hips.position.set(P.hips.x, J.hips.y + P.hips.y - hipsDrop, P.hips.z);
    B.hips.rotation.set(P.hipsRot.x, P.hipsRot.y, P.hipsRot.z, 'YXZ');
    B.spine.rotation.set(P.spine.x, P.spine.y, P.spine.z, 'YXZ');
    B.chest.rotation.set(P.chest.x, P.chest.y, P.chest.z, 'YXZ');
    const hy = clamp(P.head.y + this.lookYaw, -1.2, 1.2), hp = P.head.x + this.lookPitch;
    B.neck.rotation.set(hp * 0.4, hy * 0.4, P.head.z * 0.4, 'YXZ');
    B.head.rotation.set(hp * 0.6, hy * 0.6, P.head.z * 0.6, 'YXZ');
    // shoulders shrug toward raised arms
    const raiseR = clamp((P.grip.y - 1.2) * 1.6, -0.2, 0.6);
    const raiseL = clamp(((P.two > 0.5 ? P.grip.y : P.handL.y) - 1.2) * 1.6, -0.2, 0.6);
    B['shoulder.R'].rotation.set(0, 0, -raiseR * 0.35);
    B['shoulder.L'].rotation.set(0, 0, raiseL * 0.35);
    rig.root.updateMatrixWorld(true);

    // ---------- arms ----------
    // grip target in world
    const gripW = _v4.copy(P.grip).applyMatrix4(vis.matrixWorld);
    const bladeW = _bladeW.copy(P.blade).transformDirection(vis.matrixWorld);
    this.solveArm('R', gripW, bladeW, _poleW.copy(P.poleR).transformDirection(vis.matrixWorld), S);
    // left hand: free target or hilt grip
    const freeL = _freeL.copy(P.handL).applyMatrix4(vis.matrixWorld);
    if (P.two > 0.01 && rig.sword) {
      // a point lower on the grip
      const hiltL = _hiltL.copy(gripW).addScaledVector(bladeW, -0.11 * S);
      freeL.lerp(hiltL, clamp(P.two, 0, 1));
    }
    const dirL = _dirL.copy(bladeW);
    if (P.two < 0.5) dirL.set(0, 0, 1).transformDirection(vis.matrixWorld).multiplyScalar(0.5).add(_v.set(0, -0.6, 0)).normalize();
    this.solveArm('L', freeL, dirL, _poleW.copy(P.poleL).transformDirection(vis.matrixWorld), S, P.two < 0.5);

    // ---------- legs ----------
    this.updateFeet(dt, ch, P);
    if (P.kickR) {
      const f = this.feet[1];
      const yaw = ch.yaw, cy = Math.cos(yaw), sy = Math.sin(yaw);
      const k = P.kickR;
      f.pos.set(ch.body.pos.x + (k.x * cy + k.z * sy) * S, ch.body.pos.y + k.y * S, ch.body.pos.z + (-k.x * sy + k.z * cy) * S);
      f.swing = false; f.planted = false; f.pitch = -0.6; f.yaw = yaw;
    }
    this.solveLegs(ch, P, S, dt);
    this.lastBlade.copy(bladeW);
  }

  solveArm(side, gripW, bladeW, poleW, S, freeHand = false) {
    const B = this.rig.bones;
    const upper = B[`upperArm.${side}`], fore = B[`forearm.${side}`], hand = B[`hand.${side}`];
    const shoulderW = upper.getWorldPosition(_sh);
    const la = this.rig.len.upperArm * S, lb = this.rig.len.forearm * S;
    // wrist target: grip minus finger offset (fingers roughly continue the shoulder->grip direction, orthogonal to blade)
    const fdir = _fd.subVectors(gripW, shoulderW);
    if (!freeHand) fdir.addScaledVector(bladeW, -fdir.dot(bladeW));
    if (fdir.lengthSq() < 1e-6) fdir.set(0, -1, 0);
    fdir.normalize();
    const wrist = _wr.copy(gripW);
    if (!freeHand) wrist.addScaledVector(fdir, -0.085 * S);
    // two-bone IK
    const d = _d.subVectors(wrist, shoulderW);
    let dist = d.length();
    const maxR = (la + lb) * 0.999;
    if (dist > maxR) { d.multiplyScalar(maxR / dist); dist = maxR; wrist.copy(shoulderW).add(d); }
    dist = Math.max(dist, Math.abs(la - lb) + 0.01);
    const dir = _dir.copy(d).normalize();
    const cosA = clamp((la * la + dist * dist - lb * lb) / (2 * la * dist), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const bend = _bend.copy(poleW).addScaledVector(dir, -poleW.dot(dir));
    if (bend.lengthSq() < 1e-6) bend.set(0, -1, 0).addScaledVector(dir, -dir.y);
    bend.normalize();
    const elbow = _el.copy(shoulderW).addScaledVector(dir, cosA * la).addScaledVector(bend, sinA * la);
    // upper arm world rotation: local -Y along bone, +Z toward fold side
    const yU = _y.subVectors(shoulderW, elbow).normalize();
    const zU = _z.subVectors(wrist, elbow).addScaledVector(bend, -0.02);
    const qU = quatFromYZ(yU, zU, _qU);
    const xU = _xU.set(1, 0, 0).applyQuaternion(qU);
    const yF = _y2.subVectors(elbow, wrist).normalize();
    const zF = _z2.crossVectors(xU, yF);
    const qF = quatFromYZ(yF, zF, _qF);
    // hand
    let qH;
    if (!freeHand) {
      const fingers = _fg.subVectors(wrist, elbow).normalize();
      fingers.addScaledVector(bladeW, -fingers.dot(bladeW));
      if (fingers.lengthSq() < 1e-4) fingers.copy(yF).negate();
      fingers.normalize();
      qH = quatFromYZ(fingers.negate(), bladeW, _qH);
    } else {
      // relaxed: continue forearm with slight curl
      _fg.copy(yF);
      qH = quatFromYZ(_fg, _z3.copy(zF).addScaledVector(yF, 0.3), _qH);
    }
    // to local
    const parentQ = upper.parent.getWorldQuaternion(_pq);
    upper.quaternion.copy(parentQ.invert().multiply(qU));
    fore.quaternion.copy(_q2.copy(qU).invert().multiply(qF));
    hand.quaternion.copy(_q3.copy(qF).invert().multiply(qH));
    upper.updateMatrixWorld(true);
  }

  // ---------- gait ----------
  restOffset(foot, P) {
    const w = this.stanceW * (this.combatStance ? 1.08 : 0.95);
    const fwd = this.combatStance ? (foot.side > 0 ? 0.1 : -0.08) : 0.02;
    return _ro.set(foot.side * w, 0, fwd);
  }

  updateFeet(dt, ch, P) {
    const body = ch.body;
    const S = this.rig.scale;
    const world = ch.game.world;
    const yaw = ch.yaw;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const toWorld = (o, out) => out.set(body.pos.x + (o.x * cy + o.z * sy) * S, body.pos.y, body.pos.z + (-o.x * sy + o.z * cy) * S);
    const vx = body.vel.x, vz = body.vel.z;
    const speed = Math.hypot(vx, vz);

    if (!this.initialized) {
      for (const f of this.feet) { toWorld(this.restOffset(f, P), f.pos); f.yaw = yaw; }
      this.initialized = true;
    }

    if (this.footMode === 'air' || (!body.grounded && this.footMode !== 'ground')) {
      // feet follow pose (tucked) — local offsets
      for (const f of this.feet) {
        const ov = this.airFeet ? this.airFeet[f.side > 0 ? 0 : 1] : null;
        const o = (f.side > 0 ? P.footL : P.footR) || ov || _airDef.set(f.side * 0.12, 0.35, f.side > 0 ? 0.12 : -0.1);
        toWorld(o, f.pos);
        f.pos.y = body.pos.y + o.y * S;
        f.yaw = yaw;
        f.swing = false;
        f.planted = false;
        f.pitch = -0.3;
      }
      this.wasAir = true;
      return;
    }
    if (this.wasAir) {
      // just landed: plant feet under the body
      this.wasAir = false;
      for (const f of this.feet) {
        toWorld(this.restOffset(f, P), f.pos);
        f.pos.y = world.groundHeight(f.pos.x, f.pos.z, body.pos.y + 0.5, 0.05);
        f.yaw = yaw; f.swing = false; f.planted = true; f.pitch = 0;
      }
    }

    // pose-driven foot targets (e.g. lunges in attack clips)
    const poseFeet = P.footL || P.footR;

    if (speed > 0.6 && !poseFeet) {
      const run = clamp((speed - 2) / 4, 0, 1);
      const stride = (0.62 + run * 0.95 + clamp(speed - 6, 0, 4) * 0.12) * S;
      const freq = speed / (stride * 2);
      this.phase = (this.phase + dt * freq) % 1;
      const swingFrac = lerp(0.42, 0.62, run);
      for (const f of this.feet) {
        const p = (this.phase + (f.side > 0 ? 0 : 0.5)) % 1;
        const inSwing = p < swingFrac;
        if (inSwing && !f.swing) {
          f.swing = true; f.from.copy(f.pos); f.fromYaw = f.yaw;
        }
        if (inSwing) {
          const t = p / swingFrac;
          const stanceTime = (1 - swingFrac) / freq;
          const remaining = (1 - t) * swingFrac / freq;
          const ro = this.restOffset(f, P);
          ro.z += 0.0;
          toWorld(ro, _tgt);
          _tgt.x += vx * (remaining + stanceTime * 0.5);
          _tgt.z += vz * (remaining + stanceTime * 0.5);
          _tgt.y = world.groundHeight(_tgt.x, _tgt.z, body.pos.y + 0.6, 0.05);
          const e = ease.inOut(t);
          f.pos.lerpVectors(f.from, _tgt, e);
          f.pos.y += Math.sin(t * Math.PI) * lerp(0.1, 0.24, run) * S;
          f.yaw = f.fromYaw + wrapAngle(yaw - f.fromYaw) * e;
          f.pitch = Math.sin(t * Math.PI) * -0.5 * run + (t > 0.7 ? (t - 0.7) * 0.8 : 0);
          f.planted = false;
        } else {
          if (f.swing) { f.swing = false; f.planted = true; if (this.stepCallback) this.stepCallback(f, speed); }
          f.pitch = damp(f.pitch, 0, 20, dt);
        }
      }
      this.hipsBob = -Math.abs(Math.sin(this.phase * Math.PI * 2)) * lerp(0.02, 0.045, run) + lerp(0.005, 0.025, run);
    } else {
      this.hipsBob = damp(this.hipsBob, 0, 10, dt);
      // idle/attack stepping: move the foot that is furthest from its target
      let worst = null, wd = 0;
      for (const f of this.feet) {
        if (f.swing) {
          f.swingT += dt / f.swingDur;
          const t = Math.min(1, f.swingT);
          const tgtLocal = poseFeet ? ((f.side > 0 ? P.footL : P.footR) || this.restOffset(f, P)) : this.restOffset(f, P);
          toWorld(tgtLocal, _tgt);
          _tgt.y = world.groundHeight(_tgt.x, _tgt.z, body.pos.y + 0.6, 0.05);
          const e = ease.inOut(t);
          f.pos.lerpVectors(f.from, _tgt, e);
          f.pos.y += Math.sin(t * Math.PI) * f.lift * S;
          f.yaw = f.fromYaw + wrapAngle(yaw - f.fromYaw) * e;
          f.pitch = Math.sin(t * Math.PI) * -0.2;
          if (t >= 1) { f.swing = false; f.planted = true; if (this.stepCallback) this.stepCallback(f, 0.5); }
          continue;
        }
        const tgtLocal = poseFeet ? ((f.side > 0 ? P.footL : P.footR) || this.restOffset(f, P)) : this.restOffset(f, P);
        toWorld(tgtLocal, _tgt);
        const d = Math.hypot(_tgt.x - f.pos.x, _tgt.z - f.pos.z) + Math.abs(wrapAngle(yaw - f.yaw)) * 0.25;
        f.pos.y = damp(f.pos.y, world.groundHeight(f.pos.x, f.pos.z, body.pos.y + 0.6, 0.05), 20, dt);
        if (d > wd) { wd = d; worst = f; }
      }
      const anySwing = this.feet[0].swing || this.feet[1].swing;
      if (!anySwing && worst && wd > (poseFeet ? 0.06 : 0.16) * S) {
        worst.swing = true;
        worst.swingT = 0;
        worst.swingDur = clamp(0.1 + wd * 0.25, 0.1, 0.22) / (poseFeet ? 1.4 : 1);
        worst.lift = clamp(wd * 0.4, 0.04, 0.12);
        worst.from.copy(worst.pos);
        worst.fromYaw = worst.yaw;
      }
    }
  }

  solveLegs(ch, P, S, dt) {
    const B = this.rig.bones;
    const la = this.rig.len.thigh * S, lb = this.rig.len.shin * S;
    const ankleH = 0.085 * S;
    // hip drop so both feet can reach the ground (stairs / wide stance)
    let need = 0;
    for (const f of this.feet) {
      const side = f.side > 0 ? 'L' : 'R';
      const hip = B[`thigh.${side}`].getWorldPosition(_sh);
      const dist = hip.distanceTo(_v.copy(f.pos).setY(f.pos.y + ankleH));
      need = Math.max(need, dist - (la + lb) * 0.985);
    }
    if (ch.body.grounded && this.footMode !== 'air') this.hipDrop = damp(this.hipDrop, clamp(this.hipDrop + need, 0, 0.45 * S), 18, dt);
    else this.hipDrop = damp(this.hipDrop, 0, 10, dt);

    for (const f of this.feet) {
      const side = f.side > 0 ? 'L' : 'R';
      const thigh = B[`thigh.${side}`], shin = B[`shin.${side}`], foot = B[`foot.${side}`];
      const hip = thigh.getWorldPosition(_sh);
      const ankle = _wr.copy(f.pos); ankle.y += ankleH;
      const d = _d.subVectors(ankle, hip);
      let dist = d.length();
      const maxR = (la + lb) * 0.999;
      if (dist > maxR) { d.multiplyScalar(maxR / dist); dist = maxR; ankle.copy(hip).add(d); }
      dist = Math.max(dist, 0.05);
      const dir = _dir.copy(d).normalize();
      const cosA = clamp((la * la + dist * dist - lb * lb) / (2 * la * dist), -1, 1);
      const sinA = Math.sqrt(1 - cosA * cosA);
      // knee points along foot yaw, slightly outward
      const fy = f.yaw + f.side * 0.12;
      const pole = _pole.set(Math.sin(fy), 0.15, Math.cos(fy));
      const bend = _bend.copy(pole).addScaledVector(dir, -pole.dot(dir));
      if (bend.lengthSq() < 1e-6) bend.set(Math.sin(fy), 0, Math.cos(fy));
      bend.normalize();
      const knee = _el.copy(hip).addScaledVector(dir, cosA * la).addScaledVector(bend, sinA * la);
      const yT = _y.subVectors(hip, knee).normalize();
      const zT = _z.subVectors(knee, ankle).addScaledVector(bend, 0.02);
      const qT = quatFromYZ(yT, zT, _qU);
      const xT = _xU.set(1, 0, 0).applyQuaternion(qT);
      const yS = _y2.subVectors(knee, ankle).normalize();
      const zS = _z2.crossVectors(xT, yS);
      const qS = quatFromYZ(yS, zS, _qF);
      // foot: flat on ground along its yaw, with pitch
      _e.set(f.pitch, f.yaw, 0, 'YXZ');
      const qFt = _qH.setFromEuler(_e);
      const parentQ = thigh.parent.getWorldQuaternion(_pq);
      thigh.quaternion.copy(parentQ.invert().multiply(qT));
      shin.quaternion.copy(_q2.copy(qT).invert().multiply(qS));
      foot.quaternion.copy(_q3.copy(qS).invert().multiply(qFt));
      thigh.updateMatrixWorld(true);
    }
  }

  // world positions of blade base & tip
  bladeSegment(outBase, outTip) {
    const sw = this.rig.sword;
    if (!sw) return false;
    sw.updateWorldMatrix(true, false);
    outBase.set(0, 0, 0.05).applyMatrix4(sw.matrixWorld);
    outTip.set(0, 0, sw.userData.len).applyMatrix4(sw.matrixWorld);
    return true;
  }
}

const _bladeW = new THREE.Vector3(), _poleW = new THREE.Vector3(), _freeL = new THREE.Vector3(), _hiltL = new THREE.Vector3(), _dirL = new THREE.Vector3();
const _sh = new THREE.Vector3(), _fd = new THREE.Vector3(), _wr = new THREE.Vector3(), _d = new THREE.Vector3(), _dir = new THREE.Vector3();
const _bend = new THREE.Vector3(), _el = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _y2 = new THREE.Vector3(), _z2 = new THREE.Vector3(), _z3 = new THREE.Vector3();
const _xU = new THREE.Vector3(), _fg = new THREE.Vector3(), _pq = new THREE.Quaternion();
const _qU = new THREE.Quaternion(), _qF = new THREE.Quaternion(), _qH = new THREE.Quaternion();
const _ro = new THREE.Vector3(), _tgt = new THREE.Vector3(), _airDef = new THREE.Vector3(), _pole = new THREE.Vector3();
