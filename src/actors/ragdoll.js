import * as THREE from 'three';
import { quatFromYZ } from '../core/math.js';

// Verlet ragdoll driven from bone positions at the moment of death, then mapped back onto the skeleton.
const NAMES = ['pelvis', 'chest', 'head', 'shL', 'shR', 'hipL', 'hipR', 'elL', 'elR', 'haL', 'haR', 'knL', 'knR', 'anL', 'anR'];
const BONE_OF = {
  pelvis: 'hips', chest: 'chest', head: 'head', shL: 'upperArm.L', shR: 'upperArm.R', hipL: 'thigh.L', hipR: 'thigh.R',
  elL: 'forearm.L', elR: 'forearm.R', haL: 'hand.L', haR: 'hand.R', knL: 'shin.L', knR: 'shin.R', anL: 'foot.L', anR: 'foot.R',
};
const I = Object.fromEntries(NAMES.map((n, i) => [n, i]));

export class Ragdoll {
  constructor(rig, world) {
    this.rig = rig;
    this.world = world;
    const n = NAMES.length;
    this.p = Array.from({ length: n }, () => new THREE.Vector3());
    this.o = Array.from({ length: n }, () => new THREE.Vector3());
    this.r = NAMES.map((nm) => (nm === 'head' ? 0.11 : nm === 'pelvis' || nm === 'chest' ? 0.13 : 0.06) * rig.scale);
    this.invMass = NAMES.map((nm) => (nm === 'pelvis' || nm === 'chest' ? 0.5 : nm === 'head' ? 0.8 : 1));
    this.cons = [];
    this.minCons = [];
    this.active = false;
    this.sleep = 0;
    this.time = 0;
  }

  start(vel, impulse = null, impulsePart = 'chest') {
    const rig = this.rig;
    // visual group back to neutral so bone world positions are what we see
    rig.root.updateMatrixWorld(true);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < NAMES.length; i++) {
      const b = rig.bones[BONE_OF[NAMES[i]]];
      b.getWorldPosition(tmp);
      if (NAMES[i] === 'head') tmp.add(new THREE.Vector3(0, 0.1 * rig.scale, 0).applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion())));
      this.p[i].copy(tmp);
      this.o[i].copy(tmp).addScaledVector(vel, -1 / 60);
    }
    if (impulse) {
      const k = I[impulsePart] ?? I.chest;
      this.o[k].addScaledVector(impulse, -1 / 60);
      // neighbours get a bit of it too so the body twists
      for (const nb of ['chest', 'shL', 'shR', 'head']) if (nb !== impulsePart) this.o[I[nb]].addScaledVector(impulse, -0.4 / 60);
    }
    const pairs = [];
    const rigid = ['pelvis', 'chest', 'shL', 'shR', 'hipL', 'hipR'];
    for (let a = 0; a < rigid.length; a++) for (let b = a + 1; b < rigid.length; b++) pairs.push([rigid[a], rigid[b], 1]);
    pairs.push(['head', 'chest', 1], ['head', 'shL', 0.5], ['head', 'shR', 0.5]);
    pairs.push(['shL', 'elL', 1], ['elL', 'haL', 1], ['shR', 'elR', 1], ['elR', 'haR', 1]);
    pairs.push(['hipL', 'knL', 1], ['knL', 'anL', 1], ['hipR', 'knR', 1], ['knR', 'anR', 1]);
    this.cons = pairs.map(([a, b, s]) => [I[a], I[b], this.p[I[a]].distanceTo(this.p[I[b]]), s]);
    const L = (a, b) => this.p[I[a]].distanceTo(this.p[I[b]]);
    this.minCons = [
      [I.shL, I.haL, (L('shL', 'elL') + L('elL', 'haL')) * 0.45],
      [I.shR, I.haR, (L('shR', 'elR') + L('elR', 'haR')) * 0.45],
      [I.hipL, I.anL, (L('hipL', 'knL') + L('knL', 'anL')) * 0.55],
      [I.hipR, I.anR, (L('hipR', 'knR') + L('knR', 'anR')) * 0.55],
      [I.head, I.pelvis, L('head', 'pelvis') * 0.8],
    ];
    this.active = true;
    this.sleep = 0;
    this.time = 0;
    rig.visual.quaternion.identity();
    rig.visual.position.set(0, 0, 0);
  }

  update(dt) {
    if (!this.active) return;
    this.time += dt;
    const steps = 2;
    const h = Math.min(dt, 1 / 30) / steps;
    let energy = 0;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.p.length; i++) {
        const p = this.p[i], o = this.o[i];
        const vx = (p.x - o.x) * 0.995, vy = (p.y - o.y) * 0.995, vz = (p.z - o.z) * 0.995;
        o.copy(p);
        p.x += vx; p.y += vy - 20 * h * h; p.z += vz;
        energy += vx * vx + vy * vy + vz * vz;
      }
      for (let it = 0; it < 6; it++) {
        for (const [a, b, rest, st] of this.cons) this._dist(a, b, rest, st);
        for (const [a, b, mn] of this.minCons) {
          const d = this.p[a].distanceTo(this.p[b]);
          if (d < mn) this._dist(a, b, mn, 0.5);
        }
        this._knees();
        this._collide();
      }
    }
    if (energy < 1e-5 * steps && this.time > 0.6) this.sleep += dt; else this.sleep = 0;
    if (this.sleep > 1.2) this.active = false;
    this.apply();
  }

  _dist(a, b, rest, st) {
    const pa = this.p[a], pb = this.p[b];
    _d.subVectors(pb, pa);
    const d = _d.length() || 1e-6;
    const wa = this.invMass[a], wb = this.invMass[b];
    const diff = ((d - rest) / (d * (wa + wb))) * st;
    pa.addScaledVector(_d, diff * wa);
    pb.addScaledVector(_d, -diff * wb);
  }

  _knees() {
    // keep knees bending forward and elbows bending back relative to the torso
    const P = this.p;
    const fwd = _f.crossVectors(_x.subVectors(P[I.hipL], P[I.hipR]), _y.subVectors(P[I.chest], P[I.pelvis])).normalize();
    for (const [h, k, a] of [[I.hipL, I.knL, I.anL], [I.hipR, I.knR, I.anR]]) {
      _m.addVectors(P[h], P[a]).multiplyScalar(0.5);
      const off = _d.subVectors(P[k], _m).dot(fwd);
      if (off < 0.02) P[k].addScaledVector(fwd, (0.02 - off) * 0.5);
    }
    for (const [s, e, w] of [[I.shL, I.elL, I.haL], [I.shR, I.elR, I.haR]]) {
      _m.addVectors(P[s], P[w]).multiplyScalar(0.5);
      const off = _d.subVectors(P[e], _m).dot(fwd);
      if (off > -0.01) P[e].addScaledVector(fwd, (-0.01 - off) * 0.3);
    }
  }

  _collide() {
    const w = this.world;
    for (let i = 0; i < this.p.length; i++) {
      const p = this.p[i], r = this.r[i];
      _t.copy(p);
      const box = w.pointInside(_t, r);
      if (!box) continue;
      if (box.ring) {
        const R = w.ring;
        const dx = p.x - R.cx, dz = p.z - R.cz, d = Math.hypot(dx, dz) || 1;
        p.x = R.cx + (dx / d) * (R.r - r); p.z = R.cz + (dz / d) * (R.r - r);
        continue;
      }
      const top = w.topAt(box, p.x, p.z);
      // choose the shallowest exit
      const dTop = top + r - p.y;
      const dxm = p.x - (box.min.x - r), dxp = box.max.x + r - p.x;
      const dzm = p.z - (box.min.z - r), dzp = box.max.z + r - p.z;
      const m = Math.min(dTop, dxm, dxp, dzm, dzp);
      const o = this.o[i];
      if (m === dTop) {
        p.y = top + r;
        // friction
        o.x += (p.x - o.x) * 0.35; o.z += (p.z - o.z) * 0.35;
        if (o.y < p.y - 0.02) o.y = p.y - (p.y - o.y) * 0.3;
      } else if (m === dxm) p.x = box.min.x - r;
      else if (m === dxp) p.x = box.max.x + r;
      else if (m === dzm) p.z = box.min.z - r;
      else p.z = box.max.z + r;
    }
  }

  apply() {
    const rig = this.rig, B = rig.bones, P = this.p;
    rig.root.updateMatrixWorld(true);
    // hips
    const hipsW = quatFromYZ(_y.subVectors(P[I.chest], P[I.pelvis]), _z.crossVectors(_x.subVectors(P[I.hipL], P[I.hipR]), _y2.subVectors(P[I.chest], P[I.pelvis])), _qh);
    B.hips.position.copy(B.root.worldToLocal(_t.copy(P[I.pelvis])));
    setWorldQuat(B.hips, hipsW);
    // chest
    _m.addVectors(P[I.shL], P[I.shR]).multiplyScalar(0.5);
    const chestW = quatFromYZ(_y.subVectors(_m, P[I.chest]), _z.crossVectors(_x.subVectors(P[I.shL], P[I.shR]), _y2.subVectors(_m, P[I.chest])), _qc);
    // spine halfway
    _qs.copy(hipsW).slerp(chestW, 0.5);
    setWorldQuat(B.spine, _qs);
    setWorldQuat(B.chest, chestW);
    // head
    B.chest.updateMatrixWorld(true);
    const neckW = B.neck.getWorldPosition(_t);
    const zc = _z.set(0, 0, 1).applyQuaternion(chestW);
    const headW = quatFromYZ(_y.subVectors(P[I.head], neckW), zc, _qd);
    _qs.copy(chestW).slerp(headW, 0.5);
    setWorldQuat(B.neck, _qs);
    setWorldQuat(B.head, headW);
    B['shoulder.L'].quaternion.identity();
    B['shoulder.R'].quaternion.identity();
    // limbs
    this._limb(B['upperArm.L'], B['forearm.L'], B['hand.L'], P[I.shL], P[I.elL], P[I.haL], 1);
    this._limb(B['upperArm.R'], B['forearm.R'], B['hand.R'], P[I.shR], P[I.elR], P[I.haR], 1);
    this._limb(B['thigh.L'], B['shin.L'], B['foot.L'], P[I.hipL], P[I.knL], P[I.anL], -1);
    this._limb(B['thigh.R'], B['shin.R'], B['foot.R'], P[I.hipR], P[I.knR], P[I.anR], -1);
  }

  _limb(ub, lb, eb, a, b, c, arm) {
    ub.parent.updateMatrixWorld(true);
    const yU = _y.subVectors(a, b);
    const zU = arm > 0 ? _z.subVectors(c, b) : _z.subVectors(b, c);
    const qU = quatFromYZ(yU, zU, _qu);
    const xU = _x.set(1, 0, 0).applyQuaternion(qU);
    const yL = _y2.subVectors(b, c).normalize();
    const zL = _z2.crossVectors(xU, yL);
    const qL = quatFromYZ(yL, zL, _ql);
    setWorldQuat(ub, qU);
    ub.updateMatrixWorld(true);
    setWorldQuat(lb, qL);
    eb.quaternion.identity();
    if (arm < 0) eb.rotation.set(0.3, 0, 0);
  }
}
function setWorldQuat(bone, q) {
  bone.parent.getWorldQuaternion(_pq);
  bone.quaternion.copy(_pq.invert().multiply(q));
  bone.updateMatrixWorld(true);
}
const _d = new THREE.Vector3(), _f = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _y2 = new THREE.Vector3();
const _z = new THREE.Vector3(), _z2 = new THREE.Vector3(), _m = new THREE.Vector3(), _t = new THREE.Vector3();
const _qh = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _qs = new THREE.Quaternion(), _qd = new THREE.Quaternion();
const _qu = new THREE.Quaternion(), _ql = new THREE.Quaternion(), _pq = new THREE.Quaternion();
