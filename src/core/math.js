import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a, b, v) => {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
};
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randSign = () => (Math.random() < 0.5 ? -1 : 1);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// Frame-rate independent exponential smoothing. k ~ "speed" (higher = snappier).
export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export function dampAngle(a, b, k, dt) {
  return a + wrapAngle(b - a) * (1 - Math.exp(-k * dt));
}
export function approachAngle(a, b, maxStep) {
  const d = wrapAngle(b - a);
  return a + clamp(d, -maxStep, maxStep);
}

export const ease = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  in3: (t) => t * t * t,
  out3: (t) => 1 - Math.pow(1 - t, 3),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outBack: (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  inBack: (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return c3 * t * t * t - c1 * t * t;
  },
};

// Critically damped spring for scalars (state object {x, v}).
export function spring(s, target, freq, dt, zeta = 1) {
  const w = TAU * freq;
  const f = 1 + 2 * dt * zeta * w;
  const oo = w * w;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * s.x + dt * s.v + hhoo * target;
  const detV = s.v + hoo * (target - s.x);
  s.x = detX * detInv;
  s.v = detV * detInv;
  return s.x;
}

// Value noise 1D for organic flicker / shake
const P = new Uint8Array(512);
for (let i = 0; i < 256; i++) P[i] = i;
for (let i = 255; i > 0; i--) {
  const j = (Math.random() * (i + 1)) | 0;
  [P[i], P[j]] = [P[j], P[i]];
}
for (let i = 0; i < 256; i++) P[i + 256] = P[i];
export function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = P[i & 255] / 255;
  const b = P[(i + 1) & 255] / 255;
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const _v1 = new THREE.Vector3();
export const _v2 = new THREE.Vector3();
export const _v3 = new THREE.Vector3();
export const _q1 = new THREE.Quaternion();
export const _m1 = new THREE.Matrix4();

// Distance between segment p1-p2 and segment q1-q2 (squared), plus closest points.
export function segSegDistSq(p1, p2, q1, q2, outA, outB) {
  const d1 = _sd1.subVectors(p2, p1);
  const d2 = _sd2.subVectors(q2, q1);
  const r = _sd3.subVectors(p1, q1);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a <= 1e-8 && e <= 1e-8) { s = t = 0; }
  else if (a <= 1e-8) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-8) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const ca = outA || _sd4, cb = outB || _sd5;
  ca.copy(p1).addScaledVector(d1, s);
  cb.copy(q1).addScaledVector(d2, t);
  return ca.distanceToSquared(cb);
}
const _sd1 = new THREE.Vector3(), _sd2 = new THREE.Vector3(), _sd3 = new THREE.Vector3();
const _sd4 = new THREE.Vector3(), _sd5 = new THREE.Vector3();

// Build a quaternion from a basis where `yDir` becomes local +Y and `zHint` is projected to local +Z.
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4();
export function quatFromYZ(yDir, zHint, out) {
  _by.copy(yDir).normalize();
  _bz.copy(zHint).addScaledVector(_by, -zHint.dot(_by));
  if (_bz.lengthSq() < 1e-6) {
    // fallback: pick any perpendicular
    _bz.set(0, 0, 1).addScaledVector(_by, -_by.z);
    if (_bz.lengthSq() < 1e-6) _bz.set(1, 0, 0).addScaledVector(_by, -_by.x);
  }
  _bz.normalize();
  _bx.crossVectors(_by, _bz);
  _bm.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_bm);
}
