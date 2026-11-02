import * as THREE from 'three';
import { clamp } from '../core/math.js';

// Static world made of AABBs and ramps (stairs), indexed in an XZ grid.
const CELL = 4;

export class CollisionWorld {
  constructor() {
    this.boxes = [];
    this.grid = new Map();
    this._stamp = 0;
    this.ring = null; // circular arena wall {cx, cz, r, h}
  }

  setRing(cx, cz, r, h) {
    this.ring = { cx, cz, r, h };
    this.ringBox = { ring: true, min: new THREE.Vector3(-1e4, -1, -1e4), max: new THREE.Vector3(1e4, h, 1e4), ramp: null, climb: false, active: true, tag: 'ring' };
  }
  // inward normal of the ring wall at p
  ringNormal(p, out) {
    const R = this.ring;
    const dx = p.x - R.cx, dz = p.z - R.cz;
    const d = Math.hypot(dx, dz) || 1;
    return out.set(-dx / d, 0, -dz / d);
  }

  // Axis-aligned box. opts: { ramp: {axis:'x'|'z', dir:1|-1}, tag, noCamera, climb:false, userData }
  addBox(minX, minY, minZ, maxX, maxY, maxZ, opts = {}) {
    const b = {
      min: new THREE.Vector3(minX, minY, minZ),
      max: new THREE.Vector3(maxX, maxY, maxZ),
      ramp: opts.ramp || null,
      tag: opts.tag || 'solid',
      noCamera: !!opts.noCamera,
      climb: opts.climb !== false,
      userData: opts.userData || null,
      active: true,
      _s: 0,
    };
    this.boxes.push(b);
    this._insert(b);
    return b;
  }
  addCentered(x, y, z, w, h, d, opts) {
    return this.addBox(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2, opts);
  }
  remove(b) {
    b.active = false;
    for (const key of b._cells || []) {
      const arr = this.grid.get(key);
      if (arr) { const i = arr.indexOf(b); if (i >= 0) arr.splice(i, 1); }
    }
  }
  _insert(b) {
    b._cells = [];
    const x0 = Math.floor(b.min.x / CELL), x1 = Math.floor(b.max.x / CELL);
    const z0 = Math.floor(b.min.z / CELL), z1 = Math.floor(b.max.z / CELL);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const key = x * 73856093 ^ z * 19349663;
      let arr = this.grid.get(key);
      if (!arr) this.grid.set(key, (arr = []));
      arr.push(b);
      b._cells.push(key);
    }
  }
  // Collect boxes near an XZ rect
  query(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    const s = ++this._stamp;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const arr = this.grid.get(x * 73856093 ^ z * 19349663);
      if (!arr) continue;
      for (const b of arr) if (b._s !== s) { b._s = s; out.push(b); }
    }
    return out;
  }

  // Height of top surface of box at x,z (ramps slope)
  topAt(b, x, z) {
    if (!b.ramp) return b.max.y;
    const r = b.ramp;
    let t = r.axis === 'x' ? (x - b.min.x) / (b.max.x - b.min.x) : (z - b.min.z) / (b.max.z - b.min.z);
    t = clamp(t, 0, 1);
    if (r.dir < 0) t = 1 - t;
    return b.min.y + (b.max.y - b.min.y) * t;
  }

  // Highest walkable surface under (x,z) that is at or below maxY. radius widens the support footprint.
  groundHeight(x, z, maxY, radius = 0.2) {
    let best = -100;
    const list = this.query(x - radius, z - radius, x + radius, z + radius, _tmp);
    for (const b of list) {
      if (x + radius < b.min.x || x - radius > b.max.x || z + radius < b.min.z || z - radius > b.max.z) continue;
      // for ramps use exact point (clamped into footprint)
      const top = b.ramp
        ? this.topAt(b, clamp(x, b.min.x, b.max.x), clamp(z, b.min.z, b.max.z))
        : b.max.y;
      if (top <= maxY + 1e-4 && top > best) best = top;
    }
    return best;
  }

  // Push a vertical capsule (circle in XZ) out of boxes overlapping its vertical span.
  // Returns true if any collision happened; writes push normal into outN (last).
  resolveCircle(pos, radius, feetY, height, stepUp, outN) {
    let hit = false;
    const list = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius, _tmp2);
    for (let iter = 0; iter < 2; iter++) {
      for (const b of list) {
        let top = b.max.y;
        if (b.ramp) top = this.topAt(b, clamp(pos.x, b.min.x, b.max.x), clamp(pos.z, b.min.z, b.max.z));
        if (top <= feetY + stepUp || b.min.y >= feetY + height) continue;
        const cx = clamp(pos.x, b.min.x, b.max.x);
        const cz = clamp(pos.z, b.min.z, b.max.z);
        let dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const push = radius - d;
          dx /= d; dz /= d;
          pos.x += dx * push; pos.z += dz * push;
          if (outN) outN.set(dx, 0, dz);
        } else {
          // center inside box: push out along smallest axis
          const l = pos.x - b.min.x, r = b.max.x - pos.x, n = pos.z - b.min.z, f = b.max.z - pos.z;
          const m = Math.min(l, r, n, f);
          if (m === l) { pos.x = b.min.x - radius; outN && outN.set(-1, 0, 0); }
          else if (m === r) { pos.x = b.max.x + radius; outN && outN.set(1, 0, 0); }
          else if (m === n) { pos.z = b.min.z - radius; outN && outN.set(0, 0, -1); }
          else { pos.z = b.max.z + radius; outN && outN.set(0, 0, 1); }
        }
        hit = true;
      }
    }
    const R = this.ring;
    if (R && feetY < R.h) {
      const dx = pos.x - R.cx, dz = pos.z - R.cz;
      const d = Math.hypot(dx, dz);
      const lim = R.r - radius;
      if (d > lim && d > 1e-6) {
        pos.x = R.cx + (dx / d) * lim;
        pos.z = R.cz + (dz / d) * lim;
        if (outN) outN.set(-dx / d, 0, -dz / d);
        hit = true;
      }
    }
    return hit;
  }

  // Lowest ceiling above y at x,z
  ceilingAt(x, z, y, radius = 0.2) {
    let best = 1e9;
    const list = this.query(x - radius, z - radius, x + radius, z + radius, _tmp);
    for (const b of list) {
      if (b.ramp) continue;
      if (x + radius < b.min.x || x - radius > b.max.x || z + radius < b.min.z || z - radius > b.max.z) continue;
      if (b.min.y >= y && b.min.y < best) best = b.min.y;
    }
    return best;
  }

  // Ray vs boxes. Returns distance or Infinity. ignoreNoCamera for camera rays.
  raycast(origin, dir, maxDist, forCamera = false, outNormal = null) {
    const ex = origin.x + dir.x * maxDist, ez = origin.z + dir.z * maxDist;
    const list = this.query(Math.min(origin.x, ex), Math.min(origin.z, ez), Math.max(origin.x, ex), Math.max(origin.z, ez), _tmp);
    let best = maxDist;
    let bestAxis = -1, bestSign = 0;
    for (const b of list) {
      if (forCamera && b.noCamera) continue;
      let tmin = 0, tmax = best, axis = -1, sign = 0;
      let ok = true;
      for (let a = 0; a < 3; a++) {
        const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
        const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
        const mn = a === 0 ? b.min.x : a === 1 ? b.min.y : b.min.z;
        let mx = a === 0 ? b.max.x : a === 1 ? b.max.y : b.max.z;
        if (Math.abs(d) < 1e-9) {
          if (o < mn || o > mx) { ok = false; break; }
        } else {
          let t1 = (mn - o) / d, t2 = (mx - o) / d;
          let s = -1;
          if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
          if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) { ok = false; break; }
        }
      }
      if (!ok) continue;
      if (b.ramp) {
        // check the point is under the slope
        const px = origin.x + dir.x * tmin, py = origin.y + dir.y * tmin, pz = origin.z + dir.z * tmin;
        if (py > this.topAt(b, px, pz) + 0.05) {
          // march to find slope intersection
          let found = false;
          for (let t = tmin; t <= tmax; t += 0.1) {
            const qx = origin.x + dir.x * t, qy = origin.y + dir.y * t, qz = origin.z + dir.z * t;
            if (qy <= this.topAt(b, qx, qz)) { tmin = t; axis = 1; sign = 1; found = true; break; }
          }
          if (!found) continue;
        }
      }
      if (tmin < best && tmin >= 0) { best = tmin; bestAxis = axis; bestSign = sign; }
    }
    const R = this.ring;
    if (R) {
      // ray from inside the arena hitting the cylinder wall
      const ox = origin.x - R.cx, oz = origin.z - R.cz;
      const a = dir.x * dir.x + dir.z * dir.z;
      if (a > 1e-8) {
        const b = 2 * (ox * dir.x + oz * dir.z), c = ox * ox + oz * oz - R.r * R.r;
        const disc = b * b - 4 * a * c;
        if (disc >= 0 && c < 0) {
          const t = (-b + Math.sqrt(disc)) / (2 * a);
          if (t >= 0 && t < best && origin.y + dir.y * t < R.h) {
            best = t;
            bestAxis = -2;
            if (outNormal) outNormal.set(-(ox + dir.x * t), 0, -(oz + dir.z * t)).normalize();
          }
        }
      }
    }
    if (outNormal && bestAxis >= 0) {
      outNormal.set(0, 0, 0);
      outNormal.setComponent(bestAxis, bestSign);
    }
    return best < maxDist ? best : Infinity;
  }

  // Which box contains point p (with margin)? Returns the box (or the ring wall pseudo-box) or null.
  pointInside(p, margin = 0) {
    const R = this.ring;
    if (R && p.y < R.h && Math.hypot(p.x - R.cx, p.z - R.cz) > R.r - margin) return this.ringBox;
    const list = this.query(p.x, p.z, p.x, p.z, _tmp);
    for (const b of list) {
      if (p.x < b.min.x - margin || p.x > b.max.x + margin || p.z < b.min.z - margin || p.z > b.max.z + margin) continue;
      const top = this.topAt(b, p.x, p.z);
      if (p.y < b.min.y - margin || p.y > top + margin) continue;
      return b;
    }
    return null;
  }

  // Find a ledge in front of a character that it can mantle onto.
  findLedge(pos, fx, fz, feetY, minRise, maxRise, radius) {
    const sx = pos.x + fx * (radius + 0.35), sz = pos.z + fz * (radius + 0.35);
    const top = this.groundHeight(sx, sz, feetY + maxRise, 0.05);
    if (top < feetY + minRise) return null;
    // must have headroom above the ledge
    const ceil = this.ceilingAt(sx, sz, top + 0.01, 0.2);
    if (ceil - top < 1.7) return null;
    // the landing spot must be inside a box that is climbable
    const list = this.query(sx, sz, sx, sz, _tmp);
    let climbable = false;
    for (const b of list) {
      if (sx >= b.min.x && sx <= b.max.x && sz >= b.min.z && sz <= b.max.z && Math.abs(this.topAt(b, sx, sz) - top) < 0.01) {
        climbable = b.climb;
        break;
      }
    }
    if (!climbable) return null;
    return { x: sx + fx * 0.15, y: top, z: sz + fz * 0.15 };
  }

  lineOfSight(a, b) {
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 1e-4) return true;
    _d.divideScalar(len);
    return this.raycast(a, _d, len) === Infinity;
  }
}
const _tmp = [], _tmp2 = [];
const _d = new THREE.Vector3();

// Shared kinematic body integration used by player and enemies.
const _n = new THREE.Vector3();
export function moveBody(world, body, dt, gravity = 24) {
  const stepUp = body.grounded ? 0.5 : 0.12;
  body.wallHit = false;
  // substep horizontal motion to avoid tunnelling during fast lunges
  const dist = Math.hypot(body.vel.x, body.vel.z) * dt;
  const steps = Math.max(1, Math.ceil(dist / (body.radius * 0.8)));
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    body.pos.x += body.vel.x * sdt;
    body.pos.z += body.vel.z * sdt;
    if (world.resolveCircle(body.pos, body.radius, body.pos.y, body.height, stepUp, _n)) {
      body.wallHit = true;
      body.wallNormal = body.wallNormal || new THREE.Vector3();
      body.wallNormal.copy(_n);
      // remove velocity into the wall
      const vn = body.vel.x * _n.x + body.vel.z * _n.z;
      if (vn < 0) { body.vel.x -= _n.x * vn; body.vel.z -= _n.z * vn; body.wallImpact = -vn; }
    }
  }
  // vertical
  if (!body.noGravity) body.vel.y -= gravity * dt;
  const prevY = body.pos.y;
  body.pos.y += body.vel.y * dt;
  if (body.vel.y > 0) {
    const ceil = world.ceilingAt(body.pos.x, body.pos.z, prevY + body.height - 0.05, body.radius * 0.7);
    if (body.pos.y + body.height > ceil) { body.pos.y = ceil - body.height; body.vel.y = 0; }
  }
  const g = world.groundHeight(body.pos.x, body.pos.z, Math.max(prevY, body.pos.y) + stepUp, body.radius * 0.6);
  const wasGrounded = body.grounded;
  body.landed = false;
  if (body.pos.y <= g + 1e-4) {
    if (!wasGrounded) { body.landed = true; body.landSpeed = -body.vel.y; }
    body.pos.y = g;
    if (body.vel.y < 0) body.vel.y = 0;
    body.grounded = true;
  } else if (wasGrounded && body.vel.y <= 0 && body.pos.y - g < 0.45) {
    body.pos.y = g; // stick to slopes / stairs going down
    body.vel.y = 0;
    body.grounded = true;
  } else {
    body.grounded = false;
  }
  body.groundY = g;
}
