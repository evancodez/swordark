import * as THREE from 'three';
import { patchMaterial } from '../render/materials.js';

// Verlet cloth strip/sheet pinned to a bone: hero scarf, boss cape.
export class Cloth {
  constructor({ cols, rows, width, length, color, anchors, bone, thickness = 0, collide = [] }) {
    this.cols = cols; this.rows = rows;
    this.bone = bone;
    this.anchors = anchors.map((a) => new THREE.Vector3(...a)); // bone-local positions for top row (length = cols)
    this.collide = collide; // [{bone, offset:[x,y,z], r}]
    this.segLen = length / (rows - 1);
    this.colLen = width / Math.max(1, cols - 1);
    const n = cols * rows;
    this.p = new Float32Array(n * 3);
    this.o = new Float32Array(n * 3);
    this.initialized = false;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const uv = new Float32Array(n * 2);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      uv[(r * cols + c) * 2] = cols > 1 ? c / (cols - 1) : 0.5;
      uv[(r * cols + c) * 2 + 1] = r / (rows - 1);
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const idx = [];
    const cc = cols > 1 ? cols : 2;
    if (cols === 1) throw new Error('cloth needs >= 2 cols');
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cc - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    geo.setIndex(idx);
    this.geo = geo;
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide }), { rim: 0.4 });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.wind = new THREE.Vector3(0.6, 0, 0.3);
    this.time = Math.random() * 10;
    this.acc = 0;
  }

  _anchorWorld(i, out) {
    return out.copy(this.anchors[i]).applyMatrix4(this.bone.matrixWorld);
  }

  reset() {
    this.bone.updateWorldMatrix(true, false);
    const a = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    for (let c = 0; c < this.cols; c++) {
      this._anchorWorld(c, a);
      for (let r = 0; r < this.rows; r++) {
        const i = (r * this.cols + c) * 3;
        this.p[i] = a.x + down.x * r * this.segLen;
        this.p[i + 1] = a.y + down.y * r * this.segLen;
        this.p[i + 2] = a.z + down.z * r * this.segLen;
        this.o[i] = this.p[i]; this.o[i + 1] = this.p[i + 1]; this.o[i + 2] = this.p[i + 2];
      }
    }
    this.initialized = true;
  }

  update(dt) {
    if (!this.initialized) this.reset();
    this.time += dt;
    this.acc += Math.min(dt, 0.05);
    const h = 1 / 90;
    let steps = 0;
    while (this.acc >= h && steps < 4) { this._step(h); this.acc -= h; steps++; }
    if (steps === 4) this.acc = 0;
    // write geometry
    const pos = this.geo.attributes.position.array;
    pos.set(this.p);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
  }

  _step(h) {
    const { cols, rows, p, o } = this;
    const gust = 0.6 + Math.sin(this.time * 1.3) * 0.5 + Math.sin(this.time * 3.7) * 0.25;
    const wx = this.wind.x * gust, wz = this.wind.z * gust;
    const grav = -9.8;
    const damp = 0.985;
    for (let r = 1; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      const x = p[i], y = p[i + 1], z = p[i + 2];
      const flutter = Math.sin(this.time * 9 + r * 0.9 + c) * 0.6;
      p[i] += (x - o[i]) * damp + (wx + flutter * 0.3) * h * h * 6;
      p[i + 1] += (y - o[i + 1]) * damp + grav * h * h;
      p[i + 2] += (z - o[i + 2]) * damp + (wz + flutter * 0.2) * h * h * 6;
      o[i] = x; o[i + 1] = y; o[i + 2] = z;
    }
    // pin top row
    const a = _a;
    for (let c = 0; c < cols; c++) {
      this._anchorWorld(c, a);
      const i = c * 3;
      o[i] = p[i]; o[i + 1] = p[i + 1]; o[i + 2] = p[i + 2];
      p[i] = a.x; p[i + 1] = a.y; p[i + 2] = a.z;
    }
    // collision spheres in world
    const spheres = this._spheres || (this._spheres = this.collide.map(() => ({ c: new THREE.Vector3(), r: 0 })));
    for (let k = 0; k < this.collide.length; k++) {
      const cdef = this.collide[k];
      spheres[k].c.set(...cdef.offset).applyMatrix4(cdef.bone.matrixWorld);
      spheres[k].r = cdef.r;
    }
    for (let it = 0; it < 4; it++) {
      // vertical
      for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++) this._constrain(r * cols + c, (r + 1) * cols + c, this.segLen, r === 0);
      // horizontal
      for (let r = 1; r < rows; r++) for (let c = 0; c < cols - 1; c++) this._constrain(r * cols + c, r * cols + c + 1, this.colLen, false);
      // bend (skip one, vertical)
      for (let r = 0; r < rows - 2; r++) for (let c = 0; c < cols; c++) this._constrain(r * cols + c, (r + 2) * cols + c, this.segLen * 2, r === 0, 0.3);
      for (const s of spheres) {
        for (let r = 1; r < rows; r++) for (let c = 0; c < cols; c++) {
          const i = (r * cols + c) * 3;
          const dx = p[i] - s.c.x, dy = p[i + 1] - s.c.y, dz = p[i + 2] - s.c.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < s.r * s.r && d2 > 1e-8) {
            const d = Math.sqrt(d2), k = (s.r - d) / d;
            p[i] += dx * k; p[i + 1] += dy * k; p[i + 2] += dz * k;
          }
        }
      }
      // ground
      for (let r = 1; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3 + 1;
        if (p[i] < this.groundY + 0.02) p[i] = this.groundY + 0.02;
      }
    }
  }

  _constrain(ia, ib, rest, pinA, stiff = 1) {
    const p = this.p;
    const a = ia * 3, b = ib * 3;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    if (d < rest && stiff < 1) return; // bending only resists compression lightly
    const diff = ((d - rest) / d) * stiff;
    if (pinA) {
      p[b] -= dx * diff; p[b + 1] -= dy * diff; p[b + 2] -= dz * diff;
    } else {
      p[a] += dx * diff * 0.5; p[a + 1] += dy * diff * 0.5; p[a + 2] += dz * diff * 0.5;
      p[b] -= dx * diff * 0.5; p[b + 1] -= dy * diff * 0.5; p[b + 2] -= dz * diff * 0.5;
    }
  }
}
Cloth.prototype.groundY = -100;
const _a = new THREE.Vector3();
