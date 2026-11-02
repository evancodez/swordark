import * as THREE from 'three';
import { ease, clamp } from '../core/math.js';

// A Pose is a compact description of a character's upper body + sword in character space
// (feet at origin, facing +Z, right = -X). Legs are solved separately by the gait system.

export class Pose {
  constructor() {
    this.hips = new THREE.Vector3();     // offset from rest hips position
    this.hipsRot = new THREE.Vector3();  // pitch, yaw, roll (rad)
    this.spine = new THREE.Vector3();
    this.chest = new THREE.Vector3();
    this.head = new THREE.Vector3();
    this.grip = new THREE.Vector3(-0.25, 1.0, 0.25);  // sword grip (right hand)
    this.blade = new THREE.Vector3(0, 0.4, 1).normalize();
    this.handL = new THREE.Vector3(0.24, 0.95, 0.05); // left hand (wrist) when free
    this.two = 0;                                      // 0 = left hand free, 1 = on the hilt
    this.poleR = new THREE.Vector3(-0.6, -0.4, -0.7);  // elbow hints
    this.poleL = new THREE.Vector3(0.6, -0.4, -0.7);
    this.footL = null;                                  // optional local foot targets (air poses)
    this.footR = null;
    this.kickR = null;                                  // kicking foot target (local)
  }
  copy(p) {
    this.hips.copy(p.hips); this.hipsRot.copy(p.hipsRot);
    this.spine.copy(p.spine); this.chest.copy(p.chest); this.head.copy(p.head);
    this.grip.copy(p.grip); this.blade.copy(p.blade); this.handL.copy(p.handL);
    this.two = p.two; this.poleR.copy(p.poleR); this.poleL.copy(p.poleL);
    this.footL = p.footL ? (this.footL || new THREE.Vector3()).copy(p.footL) : null;
    this.footR = p.footR ? (this.footR || new THREE.Vector3()).copy(p.footR) : null;
    this.kickR = p.kickR ? (this.kickR || new THREE.Vector3()).copy(p.kickR) : null;
    return this;
  }
  clone() { return new Pose().copy(this); }
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _f = new THREE.Vector3(0, 0, 1);
export function slerpDir(out, a, b, t) {
  // spherical interpolation of unit vectors
  const d = clamp(a.dot(b), -1, 1);
  if (d > 0.9995) return out.copy(a).lerp(b, t).normalize();
  const th = Math.acos(d) * t;
  const rel = _tmpV.copy(b).addScaledVector(a, -d).normalize();
  return out.copy(a).multiplyScalar(Math.cos(th)).addScaledVector(rel, Math.sin(th)).normalize();
}
const _tmpV = new THREE.Vector3();

export function blendPose(out, a, b, t) {
  if (t <= 0) return out.copy(a);
  if (t >= 1) return out.copy(b);
  out.hips.lerpVectors(a.hips, b.hips, t);
  out.hipsRot.lerpVectors(a.hipsRot, b.hipsRot, t);
  out.spine.lerpVectors(a.spine, b.spine, t);
  out.chest.lerpVectors(a.chest, b.chest, t);
  out.head.lerpVectors(a.head, b.head, t);
  out.grip.lerpVectors(a.grip, b.grip, t);
  slerpDir(out.blade, a.blade, b.blade, t);
  out.handL.lerpVectors(a.handL, b.handL, t);
  out.two = a.two + (b.two - a.two) * t;
  out.poleR.lerpVectors(a.poleR, b.poleR, t);
  out.poleL.lerpVectors(a.poleL, b.poleL, t);
  if (a.footL && b.footL) out.footL = (out.footL || new THREE.Vector3()).lerpVectors(a.footL, b.footL, t);
  else out.footL = t < 0.5 ? (a.footL ? a.footL.clone() : null) : (b.footL ? b.footL.clone() : null);
  if (a.footR && b.footR) out.footR = (out.footR || new THREE.Vector3()).lerpVectors(a.footR, b.footR, t);
  else out.footR = t < 0.5 ? (a.footR ? a.footR.clone() : null) : (b.footR ? b.footR.clone() : null);
  if (a.kickR && b.kickR) out.kickR = (out.kickR || new THREE.Vector3()).lerpVectors(a.kickR, b.kickR, t);
  else out.kickR = b.kickR && t > 0.3 ? (out.kickR || new THREE.Vector3()).copy(b.kickR) : (a.kickR && t < 0.7 ? (out.kickR || new THREE.Vector3()).copy(a.kickR) : null);
  return out;
}

// ---- Clips: keyframed poses with per-segment easing and Catmull-Rom hand paths ----
// Key: { t, g:[x,y,z] grip, b:[x,y,z] blade dir, l:[x,y,z] left hand, two, tw (torso twist), ln (lean), sd (side bend),
//        hy (hips y), hz (hips z), hx, hr (hips yaw), hd: [x,y,z] head, e: easing name into this key, pr/pl: elbow poles }
export function compileClip(def) {
  const keys = def.keys.map((k) => ({
    t: k.t,
    g: new THREE.Vector3(...(k.g || [-0.25, 1.0, 0.25])),
    b: new THREE.Vector3(...(k.b || [0, 0.4, 1])).normalize(),
    l: k.l ? new THREE.Vector3(...k.l) : null,
    two: k.two ?? null,
    tw: k.tw ?? 0, ln: k.ln ?? 0, sd: k.sd ?? 0,
    // hips height authored generously; scaled down so fighters stand tall instead of squatting
    hy: (k.hy ?? 0) * 0.45, hz: k.hz ?? 0, hx: k.hx ?? 0, hr: k.hr ?? 0,
    hd: k.hd ? new THREE.Vector3(...k.hd) : null,
    pr: k.pr ? new THREE.Vector3(...k.pr) : null,
    pl: k.pl ? new THREE.Vector3(...k.pl) : null,
    fl: k.fl ? new THREE.Vector3(...k.fl) : null,
    fr: k.fr ? new THREE.Vector3(...k.fr) : null,
    kr: k.kr ? new THREE.Vector3(...k.kr) : null,
    e: k.e || 'inOut',
  }));
  return { ...def, keys, dur: def.dur ?? keys[keys.length - 1].t };
}

const _cr = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
function catmull(out, p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  out.x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  out.y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  out.z = 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
  return out;
}

const DEFAULT_L = new THREE.Vector3(0.22, 1.05, 0.15);
const DEFAULT_PR = new THREE.Vector3(-0.7, -0.5, -0.5);
const DEFAULT_PL = new THREE.Vector3(0.7, -0.5, -0.5);

// Sample a clip at time t into `out` pose. `startPose` (optional) replaces key 0 for seamless entry.
export function sampleClip(clip, t, out, startPose = null) {
  const K = clip.keys;
  let i = 0;
  while (i < K.length - 2 && t > K[i + 1].t) i++;
  const k1 = K[i], k2 = K[i + 1] || K[i];
  const span = Math.max(1e-4, k2.t - k1.t);
  const raw = clamp((t - k1.t) / span, 0, 1);
  const u = (ease[k2.e] || ease.inOut)(raw);
  const k0 = K[i - 1] || k1, k3 = K[i + 2] || k2;
  const useStart = startPose && i === 0;
  const g1 = useStart ? startPose.grip : k1.g;
  const g0 = useStart ? startPose.grip : k0.g;
  catmull(out.grip, g0, g1, k2.g, k3.g, u);
  slerpDir(out.blade, useStart ? startPose.blade : k1.b, k2.b, u);
  const l1 = useStart ? startPose.handL : (k1.l || DEFAULT_L), l2 = k2.l || DEFAULT_L;
  out.handL.lerpVectors(l1, l2, u);
  const two1 = useStart ? startPose.two : (k1.two ?? 0), two2 = k2.two ?? 0;
  out.two = two1 + (two2 - two1) * u;
  const L = (a, b) => a + (b - a) * u;
  if (useStart) {
    out.spine.set(L(startPose.spine.x, k2.ln * 0.5), L(startPose.spine.y, k2.tw * 0.45), L(startPose.spine.z, k2.sd * 0.5));
    out.chest.set(L(startPose.chest.x, k2.ln * 0.5), L(startPose.chest.y, k2.tw * 0.55), L(startPose.chest.z, k2.sd * 0.5));
    out.hips.set(L(startPose.hips.x, k2.hx), L(startPose.hips.y, k2.hy), L(startPose.hips.z, k2.hz));
    out.hipsRot.set(L(startPose.hipsRot.x, k2.ln * 0.25), L(startPose.hipsRot.y, k2.hr), L(startPose.hipsRot.z, 0));
    out.poleR.lerpVectors(startPose.poleR, k2.pr || DEFAULT_PR, u);
    out.poleL.lerpVectors(startPose.poleL, k2.pl || DEFAULT_PL, u);
  } else {
    const tw = L(k1.tw, k2.tw), ln = L(k1.ln, k2.ln), sd = L(k1.sd, k2.sd);
    out.spine.set(ln * 0.5, tw * 0.45, sd * 0.5);
    out.chest.set(ln * 0.5, tw * 0.55, sd * 0.5);
    out.hips.set(L(k1.hx, k2.hx), L(k1.hy, k2.hy), L(k1.hz, k2.hz));
    out.hipsRot.set(ln * 0.25, L(k1.hr, k2.hr), 0);
    out.poleR.lerpVectors(k1.pr || DEFAULT_PR, k2.pr || DEFAULT_PR, u);
    out.poleL.lerpVectors(k1.pl || DEFAULT_PL, k2.pl || DEFAULT_PL, u);
  }
  const h1 = k1.hd, h2 = k2.hd;
  if (h1 || h2) out.head.lerpVectors(h1 || _zero, h2 || _zero, u);
  else out.head.set(0, -out.spine.y - out.chest.y * 0.6, 0);
  if (k1.fl || k2.fl) out.footL = (out.footL || new THREE.Vector3()).lerpVectors(k1.fl || k2.fl, k2.fl || k1.fl, u);
  else out.footL = null;
  if (k1.fr || k2.fr) out.footR = (out.footR || new THREE.Vector3()).lerpVectors(k1.fr || k2.fr, k2.fr || k1.fr, u);
  else out.footR = null;
  if (k1.kr && k2.kr) out.kickR = (out.kickR || new THREE.Vector3()).lerpVectors(k1.kr, k2.kr, u);
  else if (k2.kr) out.kickR = (out.kickR || new THREE.Vector3()).copy(k2.kr);
  else if (k1.kr && u < 0.5) out.kickR = (out.kickR || new THREE.Vector3()).copy(k1.kr);
  else out.kickR = null;
  return out;
}
const _zero = new THREE.Vector3();
