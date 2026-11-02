import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../render/materials.js';
import { clamp, smoothstep } from '../core/math.js';

// Procedural skinned characters. Bind pose: standing, arms hanging, facing +Z, right side = -X.
// Every body part is generated, placed in bind pose and given smooth skin weights,
// then merged into ONE skinned mesh so joints deform like cloth rather than doll pieces.

export const BONE_NAMES = [
  'root', 'hips', 'spine', 'chest', 'neck', 'head',
  'shoulder.R', 'upperArm.R', 'forearm.R', 'hand.R',
  'shoulder.L', 'upperArm.L', 'forearm.L', 'hand.L',
  'thigh.R', 'shin.R', 'foot.R', 'thigh.L', 'shin.L', 'foot.L',
];
const PARENT = {
  hips: 'root', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  'shoulder.R': 'chest', 'upperArm.R': 'shoulder.R', 'forearm.R': 'upperArm.R', 'hand.R': 'forearm.R',
  'shoulder.L': 'chest', 'upperArm.L': 'shoulder.L', 'forearm.L': 'upperArm.L', 'hand.L': 'forearm.L',
  'thigh.R': 'hips', 'shin.R': 'thigh.R', 'foot.R': 'shin.R',
  'thigh.L': 'hips', 'shin.L': 'thigh.L', 'foot.L': 'shin.L',
};

function joints(P = {}) {
  const sw = P.shoulderW ?? 0.19, hip = P.hipW ?? 0.095;
  const J = {
    root: [0, 0, 0],
    hips: [0, 0.97, 0],
    spine: [0, 1.08, 0],
    chest: [0, 1.27, 0],
    neck: [0, 1.5, 0],
    head: [0, 1.6, 0.01],
    'shoulder.R': [-0.05, 1.45, 0],
    'upperArm.R': [-sw, 1.44, 0],
    'forearm.R': [-sw, 1.15, 0],
    'hand.R': [-sw, 0.89, 0],
    'thigh.R': [-hip, 0.93, 0],
    'shin.R': [-hip, 0.51, 0],
    'foot.R': [-hip, 0.085, 0],
  };
  for (const k of Object.keys(J)) if (k.endsWith('.R')) {
    const v = J[k];
    J[k.replace('.R', '.L')] = [-v[0], v[1], v[2]];
  }
  const out = {};
  for (const k of Object.keys(J)) out[k] = new THREE.Vector3(...J[k]);
  return out;
}

// ---------- geometry helpers ----------
function taperedCapsule(r1, r2, len, seg = 12) {
  const pts = [];
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(Math.max(1e-3, r1 * Math.sin(a)), -r1 * Math.cos(a)));
  }
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(Math.max(1e-3, r2 * Math.cos(a)), len + r2 * Math.sin(a)));
  }
  return new THREE.LatheGeometry(pts, seg);
}
const _up = new THREE.Vector3(0, 1, 0);
function orientBetween(geo, a, b) {
  const d = new THREE.Vector3().subVectors(b, a);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d.clone().normalize());
  const m = new THREE.Matrix4().compose(a, q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m);
  return geo;
}

class BodyBuilder {
  constructor(J) {
    this.J = J;
    this.parts = [];
  }
  idx(name) { return BONE_NAMES.indexOf(name); }

  _add(geo, color, weightFn, surf = [0, 0.8], boneForSever) {
    if (geo.index) geo = geo.toNonIndexed();
    geo.deleteAttribute('uv');
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    const srf = new Float32Array(n * 2);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const c = new THREE.Color(color);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(geo.attributes.position, i);
      // slight per-vertex tone variation keeps flat colors from looking plastic
      const v = 0.94 + 0.06 * Math.sin(p.x * 41 + p.y * 37 + p.z * 23);
      col[i * 3] = c.r * v; col[i * 3 + 1] = c.g * v; col[i * 3 + 2] = c.b * v;
      srf[i * 2] = surf[0]; srf[i * 2 + 1] = surf[1];
      const ws = weightFn(p).filter((w) => w[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
      let tot = 0;
      for (const w of ws) tot += w[1];
      for (let k = 0; k < 4; k++) {
        si[i * 4 + k] = ws[k] ? this.idx(ws[k][0]) : 0;
        sw[i * 4 + k] = ws[k] ? ws[k][1] / tot : 0;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSurf', new THREE.BufferAttribute(srf, 2));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    // primary bone for severing groups
    const primary = boneForSever || weightFn(new THREE.Vector3().copy(geoCenter(geo)))[0][0];
    this.parts.push({ geo, primary });
    return geo;
  }

  // Limb segment from joint a to joint b, blending into parent at the start and child at the end.
  limb(bone, child, r1, r2, color, opts = {}) {
    const a = opts.a || this.J[bone], b = opts.b || (child ? this.J[child] : null);
    const len = a.distanceTo(b);
    const geo = orientBetween(taperedCapsule(r1, r2, len, opts.seg || 12), a, b);
    if (opts.scale) scaleAround(geo, a, b, opts.scale);
    const parent = opts.parent === undefined ? PARENT[bone] : opts.parent;
    const childB = opts.child === undefined ? child : opts.child;
    const zone = opts.zone ?? 0.22;
    const ab = new THREE.Vector3().subVectors(b, a);
    const l2 = ab.lengthSq();
    const tmp = new THREE.Vector3();
    return this._add(geo, color, (p) => {
      const t = tmp.subVectors(p, a).dot(ab) / l2;
      const out = [];
      let wb = 1;
      if (parent && opts.blendStart !== false) {
        const w = 0.5 * (1 - smoothstep(-0.05, zone, t));
        if (w > 0) { out.push([parent, w]); wb -= w; }
      }
      if (childB && opts.blendEnd !== false) {
        const w = 0.5 * smoothstep(1 - zone, 1.05, t);
        if (w > 0) { out.push([childB, w]); wb -= w; }
      }
      out.push([bone, wb]);
      return out;
    }, opts.surf, bone);
  }

  ellipsoid(bone, center, radii, color, opts = {}) {
    const geo = new THREE.SphereGeometry(1, opts.ws || 14, opts.hs || 10, opts.phiStart, opts.phiLength, opts.thetaStart, opts.thetaLength);
    geo.scale(radii[0], radii[1], radii[2]);
    if (opts.rot) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...opts.rot)));
    geo.translate(center[0], center[1], center[2]);
    return this._add(geo, color, opts.weights || (() => [[bone, 1]]), opts.surf, bone);
  }

  box(bone, center, size, color, opts = {}) {
    const geo = new RoundedBoxGeometry(size[0], size[1], size[2], 2, opts.r ?? Math.min(...size) * 0.3);
    if (opts.rot) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...opts.rot)));
    geo.translate(center[0], center[1], center[2]);
    return this._add(geo, color, opts.weights || (() => [[bone, 1]]), opts.surf, bone);
  }

  cyl(bone, center, rTop, rBot, h, color, opts = {}) {
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, opts.seg || 14, 1, !!opts.open);
    if (opts.scale) geo.scale(...opts.scale);
    if (opts.rot) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...opts.rot)));
    geo.translate(center[0], center[1], center[2]);
    return this._add(geo, color, opts.weights || (() => [[bone, 1]]), opts.surf, bone);
  }

  // Revolved profile around a vertical axis at (cx, cz). profile: [[r, y], ...] bottom->top.
  lathe(profile, color, opts = {}) {
    const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-3, r), y));
    const geo = new THREE.LatheGeometry(pts, opts.seg || 18, opts.phiStart || 0, opts.phiLength || Math.PI * 2);
    geo.scale(opts.sx || 1, 1, opts.sz || 1);
    geo.translate(opts.cx || 0, 0, opts.cz || 0);
    return this._add(geo, color, opts.weights || byHeight([[0.96, 'hips'], [1.1, 'spine'], [1.28, 'chest'], [1.5, 'neck']]), opts.surf, opts.sever);
  }

  build() {
    return mergeGeometries(this.parts.map((p) => p.geo), false);
  }
}
function geoCenter(geo) {
  geo.computeBoundingBox();
  return geo.boundingBox.getCenter(new THREE.Vector3());
}
function scaleAround(geo, a, b, s) {
  // scale cross-section (x,z of the limb frame) — used for flattened limbs
  const c = a.clone().add(b).multiplyScalar(0.5);
  geo.translate(-c.x, -c.y, -c.z);
  geo.scale(s[0], s[1], s[2]);
  geo.translate(c.x, c.y, c.z);
}

// ---------- weight helpers ----------
// Blend between bones by height (torso)
export function byHeight(stops) {
  return (p) => {
    if (p.y <= stops[0][0]) return [[stops[0][1], 1]];
    for (let i = 0; i < stops.length - 1; i++) {
      const [y0, b0] = stops[i], [y1, b1] = stops[i + 1];
      if (p.y <= y1) {
        const t = smoothstep(y0, y1, p.y);
        return [[b0, 1 - t], [b1, t]];
      }
    }
    return [[stops[stops.length - 1][1], 1]];
  };
}
// Skirt / coat tail: hips at the top, increasingly following the thighs lower down.
function skirtWeights(top, bottom, maxLeg = 0.75, hipsBone = 'hips') {
  return (p) => {
    const t = clamp((top - p.y) / (top - bottom), 0, 1);
    const legW = smoothstep(0.0, 1.0, t) * maxLeg;
    const side = clamp(0.5 - p.x * 3.2, 0, 1); // 1 = right (-x)
    return [[hipsBone, 1 - legW], ['thigh.R', legW * side], ['thigh.L', legW * (1 - side)]];
  };
}
// Shoulder region: chest + upper arm
function shoulderWeights(side) {
  return (p) => {
    const ax = Math.abs(p.x);
    const t = smoothstep(0.12, 0.24, ax);
    return [['chest', 1 - t * 0.7], [`upperArm.${side}`, t * 0.7]];
  };
}

// ---------- character looks ----------
const SKIN = 0xc8a088;
const SKIN_PALE = 0x5a4a44;

function commonBody(B, c, P) {
  const J = B.J;
  const bulk = P.bulk ?? 1;
  const belly = P.belly ?? 0;
  // torso
  const tw = 0.15 * bulk;
  B.lathe([
    [0.02, 0.86], [0.13 * bulk, 0.88], [0.15 * bulk + belly * 0.5, 0.97], [0.14 * bulk + belly, 1.08],
    [0.155 * bulk + belly * 0.6, 1.2], [0.19 * bulk, 1.32], [0.205 * bulk, 1.4], [0.17 * bulk, 1.47], [0.07, 1.52], [0.02, 1.53],
  ], c.torso, { sz: 0.7 * (P.depth ?? 1), seg: 20, weights: byHeight([[0.96, 'hips'], [1.1, 'spine'], [1.28, 'chest']]), surf: c.torsoSurf, sever: 'chest' });
  // neck
  B.limb('neck', 'head', 0.055 * Math.sqrt(bulk), 0.05, c.neck ?? SKIN, { a: J.neck.clone().setY(1.47), b: J.head.clone().add(new THREE.Vector3(0, 0.02, 0)), zone: 0.3 });
  // head
  B.ellipsoid('head', [0, 1.7, 0.015], [0.098, 0.118, 0.108], c.skin ?? SKIN, { surf: [0, 0.6] });
  // arms
  for (const s of ['R', 'L']) {
    const sx = s === 'R' ? -1 : 1;
    B.ellipsoid('chest', [sx * 0.15 * bulk, 1.42, 0], [0.09 * bulk, 0.075, 0.085], c.torso, { weights: shoulderWeights(s), surf: c.torsoSurf });
    B.limb(`upperArm.${s}`, `forearm.${s}`, 0.068 * bulk, 0.056 * Math.sqrt(bulk), c.sleeve ?? c.torso, { surf: c.sleeveSurf });
    B.limb(`forearm.${s}`, `hand.${s}`, 0.056 * Math.sqrt(bulk), 0.044 * Math.sqrt(bulk), c.forearm ?? c.sleeve ?? c.torso, { surf: c.forearmSurf });
    const wr = J[`hand.${s}`];
    B.cyl(`forearm.${s}`, [wr.x, wr.y + 0.05, wr.z], 0.05 * Math.sqrt(bulk), 0.054 * Math.sqrt(bulk), 0.07, c.cuff ?? 0x2a211b, { seg: 10, surf: [0, 0.65] });
    // hand: chunky mitten
    const h = J[`hand.${s}`];
    B.box(`hand.${s}`, [h.x, h.y - 0.075, h.z + 0.005], [0.07 * Math.sqrt(bulk), 0.13, 0.09], c.hands ?? 0x2a2420, { r: 0.03, surf: c.handSurf });
    // legs
    B.limb(`thigh.${s}`, `shin.${s}`, 0.094 * bulk, 0.066 * Math.sqrt(bulk), c.legs, { zone: 0.25, surf: c.legSurf });
    B.limb(`shin.${s}`, `foot.${s}`, 0.066 * Math.sqrt(bulk), 0.054, c.boots ?? c.legs, { surf: c.bootSurf });
    const kn = J[`shin.${s}`];
    B.cyl(`shin.${s}`, [kn.x, kn.y - 0.12, kn.z + 0.005], 0.078 * Math.sqrt(bulk), 0.072 * Math.sqrt(bulk), 0.07, c.boots ?? 0x221c18, { seg: 12, surf: c.bootSurf ?? [0, 0.6] });
    const f = J[`foot.${s}`];
    B.box(`foot.${s}`, [f.x, 0.045, f.z + 0.05], [0.1, 0.09, 0.24], c.boots ?? 0x221c18, { r: 0.035, surf: c.bootSurf });
  }
}

export const LOOKS = {
  hero(B) {
    const c = {
      torso: 0x2a2c33, sleeve: 0x2a2c33, forearm: 0x4a3426, hands: 0x1c1a1a,
      legs: 0x24262b, boots: 0x2a201a, skin: SKIN_PALE, neck: 0x5a0f12,
      torsoSurf: [0, 0.85], forearmSurf: [0, 0.6],
    };
    commonBody(B, c, { bulk: 1.02 });
    const J = B.J;
    // long coat skirt
    B.lathe([[0.33, 0.36], [0.28, 0.55], [0.22, 0.78], [0.175, 0.95], [0.16, 1.02]], 0x24262c, { sz: 0.78, seg: 22, weights: skirtWeights(0.98, 0.36, 0.8), sever: 'hips' });
    // red sash + knot
    B.lathe([[0.168, 0.98], [0.172, 1.0], [0.168, 1.06], [0.16, 1.08]], 0x7a1014, { sz: 0.74, weights: byHeight([[0.98, 'hips'], [1.1, 'spine']]) });
    B.box('hips', [0.1, 0.94, 0.11], [0.06, 0.16, 0.03], 0x7a1014, { rot: [0.1, 0, 0.2] });
    // belt pouch + shoulder strap
    B.box('hips', [-0.13, 0.98, 0.06], [0.07, 0.08, 0.05], 0x3a2a1c);
    B.box('chest', [0, 1.3, 0.115], [0.04, 0.4, 0.02], 0x3a2a1c, { rot: [0, 0, 0.75], weights: byHeight([[1.15, 'spine'], [1.3, 'chest']]) });
    // pauldron on sword arm
    B.ellipsoid('upperArm.R', [-0.21, 1.44, 0], [0.1, 0.07, 0.1], 0x3a3c44, { weights: shoulderWeights('R'), surf: [0.6, 0.45] });
    // bracers
    for (const s of ['R', 'L']) {
      const sx = s === 'R' ? -1 : 1;
      B.cyl(`forearm.${s}`, [sx * 0.19, 1.0, 0], 0.052, 0.045, 0.16, 0x3a281c, { seg: 10 });
      B.cyl(`shin.${s}`, [sx * 0.095, 0.35, 0.01], 0.07, 0.06, 0.3, 0x2e241c, { seg: 10 });
    }
    // hood + mask
    B.ellipsoid('head', [0, 1.72, -0.01], [0.13, 0.15, 0.14], 0x2b2d34, { thetaStart: 0, thetaLength: Math.PI * 0.62, phiStart: Math.PI * 0.9, phiLength: Math.PI * 1.2, ws: 18, hs: 12 });
    B.ellipsoid('head', [0, 1.73, -0.035], [0.13, 0.15, 0.12], 0x2b2d34, { ws: 16, hs: 12 });
    B.ellipsoid('head', [0, 1.655, 0.035], [0.1, 0.07, 0.09], 0x5a0f12, { surf: [0, 0.9] }); // mask
    B.box('head', [0, 1.725, 0.094], [0.13, 0.04, 0.03], 0x060608, { r: 0.012, surf: [0, 0.3] }); // shadowed eye band
    // hood peak + front brim to shade the face
    B.ellipsoid('head', [0, 1.84, -0.06], [0.07, 0.07, 0.09], 0x2b2d34, { rot: [-0.5, 0, 0] });
    B.ellipsoid('head', [0, 1.79, 0.07], [0.125, 0.04, 0.08], 0x2b2d34, { rot: [0.25, 0, 0] });
    B.lathe([[0.17, 1.4], [0.12, 1.5], [0.09, 1.56]], 0x2b2d34, { sz: 0.85, weights: byHeight([[1.45, 'chest'], [1.55, 'neck']]) }); // cowl
    // coat front panels and back slit flaps — swing with the legs
    for (const sx of [-1, 1]) {
      B.box('hips', [sx * 0.1, 0.68, 0.2], [0.17, 0.62, 0.025], 0x26282e, { rot: [0.08, 0, sx * -0.05], weights: skirtWeights(0.98, 0.36, 0.85), r: 0.01, surf: [0, 0.9] });
      B.box('hips', [sx * 0.11, 0.66, -0.21], [0.18, 0.66, 0.025], 0x24262c, { rot: [-0.08, 0, 0], weights: skirtWeights(0.98, 0.36, 0.85), r: 0.01, surf: [0, 0.9] });
    }
    B.box('hips', [0.15, 0.97, 0.05], [0.07, 0.09, 0.05], 0x3a2a1c, { surf: [0, 0.65] });
    B.box('chest', [0, 1.36, 0.155], [0.16, 0.05, 0.03], 0x3a2a1c, { surf: [0, 0.6] }); // chest strap buckle
  },

  grunt(B, v = 0) {
    const tunics = [0x6a5a44, 0x4a4a42, 0x5a3a2a, 0x3c4048];
    const c = {
      torso: tunics[v % 4], sleeve: tunics[(v + 1) % 4], forearm: SKIN, hands: 0x3a2c22,
      legs: 0x3a3430, boots: 0x2a221c, skin: SKIN,
      torsoSurf: [0, 0.9],
    };
    commonBody(B, c, { bulk: 1.0 });
    // short skirt / tunic tail
    B.lathe([[0.24, 0.6], [0.2, 0.78], [0.165, 0.95], [0.155, 1.02]], c.torso, { sz: 0.78, weights: skirtWeights(0.98, 0.6, 0.85) });
    const accent = [0x5a1612, 0x2a3a2a, 0x4a3a1a, 0x1a2230][v % 4];
    B.box('hips', [0, 0.74, 0.175], [0.2, 0.46, 0.02], accent, { weights: skirtWeights(0.98, 0.5, 0.65), r: 0.008, surf: [0, 0.95] });
    B.box('hips', [0, 0.76, -0.18], [0.22, 0.42, 0.02], accent, { weights: skirtWeights(0.98, 0.5, 0.65), r: 0.008, surf: [0, 0.95] });
    B.box('chest', [0, 1.28, 0.125], [0.05, 0.46, 0.02], 0x2a1e16, { rot: [0, 0, 0.7], weights: byHeight([[1.12, 'spine'], [1.3, 'chest']]), surf: [0, 0.6] });
    B.box('hips', [-0.16, 0.95, 0.07], [0.08, 0.1, 0.06], 0x3a2a1c, { surf: [0, 0.7] });
    // leather vest
    B.lathe([[0.16, 1.04], [0.165, 1.15], [0.2, 1.3], [0.21, 1.38], [0.17, 1.44]], 0x3a2a1e, { sz: 0.74, seg: 16, weights: byHeight([[1.08, 'spine'], [1.28, 'chest']]), surf: [0, 0.6] });
    // belt
    B.lathe([[0.158, 0.96], [0.163, 0.98], [0.163, 1.02], [0.158, 1.04]], 0x1e1814, { sz: 0.74 });
    // left shoulder pad
    B.ellipsoid('upperArm.L', [0.21, 1.44, 0], [0.1, 0.07, 0.1], 0x55504a, { weights: shoulderWeights('L'), surf: [0.7, 0.5] });
    // arm wraps
    B.cyl('forearm.R', [-0.19, 1.0, 0], 0.05, 0.044, 0.12, 0x8a7a60, { seg: 10 });
    // heads
    const hv = v % 4;
    if (hv === 0) { // kettle hat
      B.ellipsoid('head', [0, 1.76, 0], [0.12, 0.08, 0.125], 0x5a5a5e, { thetaLength: Math.PI * 0.5, surf: [0.8, 0.45] });
      B.cyl('head', [0, 1.76, 0], 0.2, 0.2, 0.012, 0x4a4a4e, { seg: 18, surf: [0.8, 0.5] });
    } else if (hv === 1) { // hood
      B.ellipsoid('head', [0, 1.72, -0.02], [0.125, 0.145, 0.13], 0x3a3530, { ws: 16 });
    } else if (hv === 2) { // skull cap + face paint
      B.ellipsoid('head', [0, 1.74, -0.005], [0.105, 0.1, 0.115], 0x2a2420, { thetaLength: Math.PI * 0.55 });
      B.ellipsoid('head', [0, 1.69, 0.05], [0.085, 0.06, 0.07], 0xd8d0c0);
    } else { // bandana
      B.ellipsoid('head', [0, 1.745, -0.01], [0.104, 0.09, 0.115], 0x6a1a14, { thetaLength: Math.PI * 0.5 });
      B.box('head', [0, 1.75, -0.12], [0.03, 0.08, 0.03], 0x6a1a14);
    }
    // cloth mask (all)
    if (hv !== 2) B.ellipsoid('head', [0, 1.655, 0.04], [0.095, 0.065, 0.085], 0x2a2622);
    B.box('head', [0, 1.715, 0.1], [0.1, 0.018, 0.012], 0x0a0806, { r: 0.005 });
  },

  shield(B, v = 0) {
    LOOKS.grunt(B, v);
    B.ellipsoid('head', [0, 1.75, 0], [0.115, 0.1, 0.125], 0x606268, { thetaLength: Math.PI * 0.55, surf: [0.85, 0.4] });
    B.box('head', [0, 1.69, 0.12], [0.02, 0.1, 0.02], 0x606268, { surf: [0.85, 0.4] });
    B.lathe([[0.17, 1.16], [0.205, 1.3], [0.215, 1.38], [0.175, 1.45]], 0x55565c, { sz: 0.76, seg: 16, weights: byHeight([[1.08, 'spine'], [1.28, 'chest']]), surf: [0.8, 0.45] });
  },

  thrower(B, v = 0) {
    const c = {
      torso: 0x2e3430, sleeve: 0x2e3430, forearm: 0x3a2c22, hands: 0x1a1612,
      legs: 0x2a2826, boots: 0x1e1a16, skin: SKIN,
    };
    commonBody(B, c, { bulk: 0.92 });
    B.lathe([[0.22, 0.55], [0.19, 0.78], [0.16, 0.95], [0.15, 1.02]], 0x2a302c, { sz: 0.78, weights: skirtWeights(0.98, 0.55, 0.85) });
    B.ellipsoid('head', [0, 1.72, -0.02], [0.125, 0.145, 0.13], 0x223028, { ws: 16 });
    B.ellipsoid('head', [0, 1.655, 0.04], [0.095, 0.065, 0.085], 0x223028);
    B.box('head', [0, 1.715, 0.1], [0.1, 0.018, 0.012], 0x0a0806, { r: 0.005 });
    // knife bandolier
    B.box('chest', [0, 1.28, 0.12], [0.04, 0.45, 0.02], 0x3a2a1c, { rot: [0, 0, -0.75], weights: byHeight([[1.15, 'spine'], [1.3, 'chest']]) });
    for (let i = 0; i < 4; i++) B.box('chest', [-0.08 + i * 0.05, 1.2 + i * 0.05, 0.13], [0.012, 0.09, 0.012], 0x9a9aa0, { surf: [0.9, 0.3], weights: byHeight([[1.15, 'spine'], [1.3, 'chest']]) });
  },

  brute(B) {
    const c = {
      torso: 0x4a3c30, sleeve: SKIN, forearm: SKIN, hands: 0x2a2018,
      legs: 0x2e2824, boots: 0x1e1814, skin: SKIN,
    };
    commonBody(B, c, { bulk: 1.45, belly: 0.05, depth: 1.1 });
    B.lathe([[0.3, 0.55], [0.26, 0.78], [0.22, 0.95], [0.21, 1.02]], 0x3a2e24, { sz: 0.8, weights: skirtWeights(0.98, 0.55, 0.85) });
    // chain + leather harness
    B.box('chest', [0, 1.28, 0.16], [0.06, 0.55, 0.03], 0x2a1e16, { rot: [0, 0, 0.8], weights: byHeight([[1.15, 'spine'], [1.3, 'chest']]) });
    B.box('chest', [0, 1.28, 0.16], [0.06, 0.55, 0.03], 0x2a1e16, { rot: [0, 0, -0.8], weights: byHeight([[1.15, 'spine'], [1.3, 'chest']]) });
    // big pauldrons
    for (const s of ['R', 'L']) {
      const sx = s === 'R' ? -1 : 1;
      B.ellipsoid(`upperArm.${s}`, [sx * 0.24, 1.45, 0], [0.14, 0.1, 0.14], 0x4a4a4e, { weights: shoulderWeights(s), surf: [0.85, 0.5] });
      B.cyl(`forearm.${s}`, [sx * 0.19, 1.0, 0], 0.075, 0.065, 0.16, 0x3a2a1e, { seg: 10 });
    }
    // horned iron helm
    B.ellipsoid('head', [0, 1.72, 0], [0.13, 0.14, 0.135], 0x46464a, { surf: [0.85, 0.45], ws: 16 });
    B.box('head', [0, 1.71, 0.125], [0.11, 0.02, 0.02], 0x050505, { r: 0.006 });
    for (const sx of [-1, 1]) {
      const horn = taperedCapsule(0.035, 0.008, 0.2, 8);
      horn.applyMatrix4(new THREE.Matrix4().makeRotationZ(sx * -1.1));
      horn.applyMatrix4(new THREE.Matrix4().makeRotationX(-0.4));
      horn.translate(sx * 0.11, 1.78, 0);
      B._add(horn, 0xd8ccb0, () => [['head', 1]], [0, 0.5], 'head');
    }
  },

  boss(B) {
    const steel = [0.9, 0.32];
    const c = {
      torso: 0x5a5c62, sleeve: 0x2a2224, forearm: 0x5a5c62, hands: 0x3a3a3e,
      legs: 0x2a2224, boots: 0x55565c, skin: SKIN,
      torsoSurf: steel, forearmSurf: steel, handSurf: [0.8, 0.4], bootSurf: steel,
    };
    commonBody(B, c, { bulk: 1.18 });
    // plate skirt (tassets) + red tabard
    B.lathe([[0.31, 0.6], [0.26, 0.78], [0.2, 0.95], [0.19, 1.03]], 0x4a4c52, { sz: 0.8, seg: 20, weights: skirtWeights(0.98, 0.6, 0.75), surf: steel });
    B.box('hips', [0, 0.78, 0.17], [0.2, 0.42, 0.02], 0x6a0c0c, { weights: skirtWeights(0.98, 0.55, 0.5), r: 0.008 });
    B.box('hips', [0, 0.78, -0.18], [0.22, 0.42, 0.02], 0x6a0c0c, { weights: skirtWeights(0.98, 0.55, 0.5), r: 0.008 });
    // breastplate ridge + brass trim
    B.box('chest', [0, 1.3, 0.14], [0.03, 0.3, 0.04], 0x6a6c72, { surf: steel });
    B.lathe([[0.2, 1.43], [0.205, 1.445], [0.18, 1.47]], 0x9a7038, { sz: 0.72, surf: [0.9, 0.3] });
    // massive pauldrons (layered)
    for (const s of ['R', 'L']) {
      const sx = s === 'R' ? -1 : 1;
      B.ellipsoid(`upperArm.${s}`, [sx * 0.25, 1.47, 0], [0.15, 0.1, 0.15], 0x5e6066, { weights: shoulderWeights(s), surf: steel });
      B.ellipsoid(`upperArm.${s}`, [sx * 0.27, 1.4, 0], [0.13, 0.08, 0.14], 0x55575d, { weights: shoulderWeights(s), surf: steel });
      B.cyl(`upperArm.${s}`, [sx * 0.19, 1.27, 0], 0.07, 0.065, 0.14, 0x55575d, { seg: 12, surf: steel });
      B.ellipsoid(`forearm.${s}`, [sx * 0.19, 1.15, -0.01], [0.07, 0.06, 0.07], 0x6a6c72, { surf: steel }); // couter
      B.cyl(`thigh.${s}`, [sx * 0.095, 0.72, 0.01], 0.09, 0.08, 0.3, 0x55575d, { seg: 12, surf: steel });
      B.ellipsoid(`shin.${s}`, [sx * 0.095, 0.51, 0.04], [0.07, 0.07, 0.06], 0x6a6c72, { surf: steel }); // poleyn
    }
    // great helm with crest
    B.cyl('head', [0, 1.72, 0.01], 0.115, 0.125, 0.26, 0x5a5c62, { seg: 16, surf: steel });
    B.ellipsoid('head', [0, 1.85, 0.01], [0.115, 0.05, 0.115], 0x5a5c62, { thetaLength: Math.PI * 0.5, surf: steel });
    B.box('head', [0, 1.74, 0.125], [0.15, 0.018, 0.03], 0x020202, { r: 0.006 });
    B.box('head', [0, 1.66, 0.13], [0.015, 0.1, 0.02], 0x9a7038, { surf: [0.9, 0.3] });
    B.box('head', [0, 1.93, -0.04], [0.025, 0.12, 0.28], 0x7a0c0c, { r: 0.012, surf: [0, 0.95] }); // crest
  },
};

// ---------- swords ----------
export function buildSword(kind = 'hero') {
  const S = {
    hero: { len: 0.95, w: 0.042, curve: 0.035, guard: 0.11, grip: 0.24, blade: 0xc8ccd4, hilt: 0x5a0f12, guardC: 0x2a2a2e },
    grunt: { len: 0.78, w: 0.05, curve: 0.06, guard: 0.12, grip: 0.14, blade: 0x8a8a90, hilt: 0x3a2a1c, guardC: 0x4a4038 },
    brute: { len: 0.9, w: 0.16, curve: 0.0, guard: 0.08, grip: 0.36, blade: 0x6a6a70, hilt: 0x2a1e16, guardC: 0x3a3a3e, cleaver: true },
    boss: { len: 1.25, w: 0.06, curve: 0.0, guard: 0.3, grip: 0.3, blade: 0xb0b4bc, hilt: 0x2a1414, guardC: 0x9a7038 },
    knife: { len: 0.22, w: 0.028, curve: 0, guard: 0.05, grip: 0.1, blade: 0xa0a0a8, hilt: 0x2a1e16, guardC: 0x3a3a3e },
  }[kind];
  const parts = [];
  const add = (geo, color, surf) => {
    if (geo.index) geo = geo.toNonIndexed();
    geo.deleteAttribute('uv');
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3), srf = new Float32Array(n * 2);
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; srf[i * 2] = surf[0]; srf[i * 2 + 1] = surf[1]; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSurf', new THREE.BufferAttribute(srf, 2));
    parts.push(geo);
  };
  // blade: flattened diamond cross-section swept along +Z, edge toward -Y, slight curve to +Y
  {
    const segs = 14;
    const pos = [];
    const ring = (t) => {
      const z = t * S.len;
      const taper = S.cleaver ? (t > 0.85 ? 1 - (t - 0.85) / 0.15 * 0.4 : 1) : (t > 0.82 ? Math.max(0.02, 1 - (t - 0.82) / 0.18) : 1 - t * 0.15);
      const w = S.w * taper;
      const th = 0.006 + 0.004 * (1 - t);
      const yOff = S.curve * t * t + (S.cleaver ? -S.w * 0.4 : 0);
      // edge (-Y), flat +X, spine (+Y), flat -X
      const spineY = S.cleaver ? yOff + w * 0.5 : yOff + w * 0.5;
      const edgeY = S.cleaver ? yOff - w * 0.5 : yOff - w * 0.5;
      return [
        [0, edgeY, z], [th, yOff + w * 0.1, z], [0, spineY, z], [-th, yOff + w * 0.1, z],
      ];
    };
    const rings = [];
    for (let i = 0; i <= segs; i++) rings.push(ring(i / segs));
    for (let i = 0; i < segs; i++) {
      for (let k = 0; k < 4; k++) {
        const a = rings[i][k], b = rings[i][(k + 1) % 4], c2 = rings[i + 1][(k + 1) % 4], d = rings[i + 1][k];
        pos.push(...a, ...d, ...c2, ...a, ...c2, ...b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    add(g, S.blade, [1.0, 0.22]);
  }
  // guard
  add(new RoundedBoxGeometry(0.035, S.guard, 0.025, 2, 0.008).translate(0, 0, -0.01), S.guardC, [0.9, 0.35]);
  if (kind === 'boss') add(new RoundedBoxGeometry(0.05, 0.05, 0.05, 2, 0.015).translate(0, 0, -0.01), S.guardC, [0.9, 0.3]);
  // grip + pommel
  add(new THREE.CylinderGeometry(0.016, 0.018, S.grip, 8).rotateX(Math.PI / 2).translate(0, 0, -0.025 - S.grip / 2), S.hilt, [0, 0.8]);
  add(new THREE.SphereGeometry(0.026, 10, 8).translate(0, 0, -0.03 - S.grip), S.guardC, [0.9, 0.35]);
  const geo = mergeGeometries(parts);
  const mat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, envMapIntensity: 1.5 }), { rim: 0.3, blade: true, surf: true });
  mat.userData.uniforms.uBladeLen.value = S.len;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.userData.len = S.len;
  mesh.userData.grip = S.grip;
  return mesh;
}

export function buildShield() {
  const g = new THREE.CylinderGeometry(0.32, 0.32, 0.05, 20).rotateX(Math.PI / 2);
  const boss = new THREE.SphereGeometry(0.08, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).translate(0, 0, 0.025);
  const rim = new THREE.TorusGeometry(0.32, 0.018, 6, 24);
  const parts = [];
  for (const [geo, color, s] of [[g, 0x5a4030, [0, 0.8]], [boss, 0x6a6a70, [0.9, 0.35]], [rim, 0x4a4a50, [0.9, 0.4]]]) {
    let gg = geo.index ? geo.toNonIndexed() : geo;
    gg.deleteAttribute('uv');
    const n = gg.attributes.position.count;
    const col = new Float32Array(n * 3), srf = new Float32Array(n * 2);
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) { col.set([c.r, c.g, c.b], i * 3); srf.set(s, i * 2); }
    gg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    gg.setAttribute('aSurf', new THREE.BufferAttribute(srf, 2));
    parts.push(gg);
  }
  const mat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true }), { rim: 0.25, surf: true, blood: true });
  const m = new THREE.Mesh(mergeGeometries(parts), mat);
  m.castShadow = true;
  return m;
}

// ---------- Rig ----------
const SEVER_GROUPS = {
  head: { bones: ['head'], joint: 'head', parent: 'neck' },
  armR: { bones: ['forearm.R', 'hand.R'], joint: 'forearm.R', parent: 'upperArm.R' },
  armL: { bones: ['forearm.L', 'hand.L'], joint: 'forearm.L', parent: 'upperArm.L' },
};

export class Rig {
  constructor(look, opts = {}) {
    this.scale = opts.scale || 1;
    this.J = joints(opts.proportions);
    const B = new BodyBuilder(this.J);
    LOOKS[look](B, opts.variant || 0);
    const geo = B.build();

    // bones
    this.bones = {};
    const list = [];
    for (const name of BONE_NAMES) {
      const b = new THREE.Bone();
      b.name = name;
      this.bones[name] = b;
      list.push(b);
    }
    for (const name of BONE_NAMES) {
      const b = this.bones[name];
      const p = PARENT[name];
      if (p) {
        this.bones[p].add(b);
        b.position.subVectors(this.J[name], this.J[p]);
      } else b.position.copy(this.J[name]);
    }
    this.root = new THREE.Group();          // world placement (position + yaw)
    this.visual = new THREE.Group();        // flips/tilts/scale
    this.root.add(this.visual);
    this.visual.scale.setScalar(this.scale);

    this.material = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, envMapIntensity: 0.8 }), { rim: opts.rim ?? 0.45, blood: true, surf: true });
    const mesh = new THREE.SkinnedMesh(geo, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.add(this.bones.root);
    this.visual.add(mesh);
    mesh.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(list);
    mesh.bind(this.skeleton);
    this.mesh = mesh;

    // segment lengths (unscaled)
    const L = (a, b) => this.J[a].distanceTo(this.J[b]);
    this.len = {
      upperArm: L('upperArm.R', 'forearm.R'), forearm: L('forearm.R', 'hand.R'),
      thigh: L('thigh.R', 'shin.R'), shin: L('shin.R', 'foot.R'),
    };

    // severable sub-meshes
    this.sever = {};
    for (const [key, g] of Object.entries(SEVER_GROUPS)) {
      const parts = B.parts.filter((p) => g.bones.includes(p.primary)).map((p) => p.geo);
      if (!parts.length) continue;
      const sg = mergeGeometries(parts.map((p) => {
        const c = p.clone();
        c.deleteAttribute('skinIndex'); c.deleteAttribute('skinWeight');
        return c;
      }));
      this.sever[key] = { geo: sg, joint: this.J[g.joint].clone(), bone: g.joint, parent: g.parent, done: false };
    }

    this.bloodSlot = 0;
    this.sword = null;
  }

  attachSword(sword, hand = 'hand.R') {
    const h = this.bones[hand];
    sword.position.set(0, -0.085, 0.01);
    h.add(sword);
    this.sword = sword;
  }

  // Soak blood into clothing at a world-space point.
  addBlood(worldPoint, radius = 0.12) {
    // find closest bone
    let best = null, bd = 1e9;
    const tmp = new THREE.Vector3();
    for (const name of BONE_NAMES) {
      if (name === 'root') continue;
      this.bones[name].getWorldPosition(tmp);
      const d = tmp.distanceToSquared(worldPoint);
      if (d < bd) { bd = d; best = name; }
    }
    const bi = BONE_NAMES.indexOf(best);
    const bone = this.bones[best];
    const local = bone.worldToLocal(worldPoint.clone());
    const bindWorld = new THREE.Matrix4().copy(this.skeleton.boneInverses[bi]).invert();
    const p = local.applyMatrix4(bindWorld);
    const slots = this.material.userData.uniforms.uBlood.value;
    // grow an existing nearby splash instead of always taking a new slot
    for (const s of slots) {
      if (s.w > 0 && Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z) < radius * 0.8) {
        s.w = Math.min(0.32, s.w + radius * 0.35);
        return;
      }
    }
    slots[this.bloodSlot].set(p.x, p.y, p.z, radius);
    this.bloodSlot = (this.bloodSlot + 1) % slots.length;
  }

  clearBlood() {
    for (const s of this.material.userData.uniforms.uBlood.value) s.set(0, 0, 0, 0);
  }

  // Detach a body part: hides it on the skinned mesh and returns a rigid mesh in world space.
  severPart(key) {
    const s = this.sever[key];
    if (!s || s.done) return null;
    s.done = true;
    const bone = this.bones[s.bone];
    // world transform of the part
    this.root.updateMatrixWorld(true);
    const bi = BONE_NAMES.indexOf(s.bone);
    const m = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, this.skeleton.boneInverses[bi]);
    const pivot = new THREE.Group();
    const inner = new THREE.Mesh(s.geo, this.material);
    inner.castShadow = true;
    inner.position.copy(s.joint).negate();
    pivot.add(inner);
    // pivot at the joint
    const jointWorld = s.joint.clone().applyMatrix4(m);
    const q = new THREE.Quaternion(), sc = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), q, sc);
    pivot.position.copy(jointWorld);
    pivot.quaternion.copy(q);
    pivot.scale.copy(sc);
    // flesh cap at cut
    const cap = new THREE.Mesh(new THREE.CircleGeometry(s.bone === 'head' ? 0.05 : 0.045, 10), CAP_MAT);
    cap.rotation.x = Math.PI / 2;
    pivot.add(cap);
    // collapse on skinned mesh
    bone.scale.setScalar(0.0001);
    // stump cap on parent
    const stump = new THREE.Mesh(new THREE.SphereGeometry(s.bone === 'head' ? 0.05 : 0.045, 10, 6), CAP_MAT);
    stump.scale.set(1, 0.4, 1);
    stump.position.copy(this.J[s.bone]).sub(this.J[s.parent]);
    this.bones[s.parent].add(stump);
    if (key === 'armR' && this.sword) {
      // sword stays with the severed hand
      const sw = this.sword;
      sw.removeFromParent();
      const handBind = this.J['hand.R'];
      sw.position.set(handBind.x - s.joint.x, handBind.y - s.joint.y - 0.085, handBind.z - s.joint.z + 0.01);
      sw.rotation.set(0, 0, 0);
      pivot.add(sw);
      this.sword = null;
    }
    return pivot;
  }
}
const CAP_MAT = new THREE.MeshStandardMaterial({ color: 0x5a0606, roughness: 0.3, side: THREE.DoubleSide });
