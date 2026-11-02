import * as THREE from 'three';
import { StreakSystem } from './particles.js';
import { rand, clamp } from '../core/math.js';

// Blood: droplets that fly, stretch and splat into decals on whatever they hit,
// a red mist, arterial spurts from stumps, and pools that spread under corpses.

const MAX_DECALS = 900;

export class BloodFX {
  constructor(scene, world, textures, audio) {
    this.world = world;
    this.audio = audio;
    this.drops = new StreakSystem(2600, { stretch: 0.028, soft: 0.5 });
    this.drops.mesh.renderOrder = 2;
    this.mist = new StreakSystem(500, { stretch: 0.0, soft: 0.0 });
    this.mist.mat.uniforms.uSoft.value = -0.4;
    scene.add(this.drops.mesh, this.mist.mesh);

    // decals
    const geo = new THREE.PlaneGeometry(1, 1);
    this.aDecal = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS * 2), 2); // variant, alpha
    this.aDecal.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aDecal', this.aDecal);
    const mat = new THREE.MeshStandardMaterial({
      map: textures.splat, color: 0x320202, roughness: 0.14, metalness: 0.0,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      envMapIntensity: 1.8,
    });
    const cols = textures.splat.userData.cols, rows = textures.splat.userData.rows;
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aDecal;\nvarying float vDecalA;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
  vMapUv = (uv + vec2(mod(aDecal.x, ${cols}.0), floor(aDecal.x / ${cols}.0))) / vec2(${cols}.0, ${rows}.0);
  vDecalA = aDecal.y;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDecalA;')
        .replace('#include <map_fragment>', `#include <map_fragment>
  diffuseColor.a *= vDecalA;
  diffuseColor.rgb *= mix(0.55, 1.0, sampledDiffuseColor.r);
  if (diffuseColor.a < 0.02) discard;`);
    };
    this.decals = new THREE.InstancedMesh(geo, mat, MAX_DECALS);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.receiveShadow = true;
    this.decals.renderOrder = 1;
    scene.add(this.decals);
    this.decalData = [];
    this.decalHead = 0;
    this.spurts = [];
    this.pools = [];
    this._splatCooldown = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  // Spray: origin, direction (normalized-ish), count, speed, spread
  spray(origin, dir, count = 40, speed = 6, spread = 0.5, sizeMul = 1) {
    for (let i = 0; i < count; i++) {
      const sp = speed * rand(0.35, 1.25);
      const vx = dir.x * sp + rand(-1, 1) * spread * sp;
      const vy = dir.y * sp + rand(-0.6, 1) * spread * sp + rand(0, 1.5);
      const vz = dir.z * sp + rand(-1, 1) * spread * sp;
      const s = rand(0.006, 0.017) * sizeMul * (Math.random() < 0.1 ? 1.8 : 1);
      const dark = rand(0.55, 1);
      this.drops.spawn(origin.x, origin.y, origin.z, vx, vy, vz, 0.2 * dark, 0.002, 0.002, 1, s, rand(1.2, 2.6), 11, rand(0.3, 1.4), 0, s * 2);
    }
    // mist puffs
    const mistN = Math.ceil(count / 8);
    for (let i = 0; i < mistN; i++) {
      const sp = speed * rand(0.1, 0.35);
      this.mist.spawn(origin.x, origin.y, origin.z, dir.x * sp + rand(-0.5, 0.5), dir.y * sp + rand(-0.2, 0.6), dir.z * sp + rand(-0.5, 0.5),
        0.12, 0.004, 0.004, rand(0.2, 0.32), rand(0.06, 0.12), rand(0.3, 0.6), 0.4, 3, rand(0.4, 0.9));
    }
  }

  // Arterial spurt attached to an object (bone), pulses for `duration` seconds
  addSpurt(obj, localOffset, localDir, duration = 2.5, strength = 1) {
    this.spurts.push({ obj, off: localOffset.clone(), dir: localDir.clone(), t: 0, dur: duration, str: strength, next: 0 });
  }

  addPool(pos, maxSize = 1.4, rate = 0.5) {
    const g = this.world.groundHeight(pos.x, pos.z, pos.y + 0.5, 0.05);
    const p = new THREE.Vector3(pos.x, g + 0.012, pos.z);
    const idx = this.addDecal(p, _UP, 0.1, Math.floor(Math.random() * 4), Math.random() * Math.PI * 2, 0.95);
    this.pools.push({ idx, p, size: 0.1, max: maxSize, rate, rot: Math.random() * Math.PI * 2, gen: this.decalData[idx].gen });
  }

  addDecal(p, normal, size, variant, angle, alpha = 1) {
    const i = this.decalHead;
    this.decalHead = (this.decalHead + 1) % MAX_DECALS;
    if (this.decals.count < MAX_DECALS) this.decals.count++;
    const d = this.decalData[i] || (this.decalData[i] = { p: new THREE.Vector3(), n: new THREE.Vector3(), size: 0, target: 0, angle: 0, grow: 0, gen: 0 });
    d.p.copy(p); d.n.copy(normal); d.size = size * 0.35; d.target = size; d.angle = angle; d.grow = 1; d.gen++;
    this.aDecal.setXY(i, variant, alpha);
    this.aDecal.needsUpdate = true;
    this._writeDecal(i);
    return i;
  }

  _writeDecal(i) {
    const d = this.decalData[i];
    // orient plane +Z to normal, rotate around normal
    this._q.setFromUnitVectors(_Z, d.n);
    _qr.setFromAxisAngle(_Z, d.angle);
    this._q.multiply(_qr);
    this._s.set(d.size, d.size, 1);
    this._m.compose(d.p, this._q, this._s);
    this.decals.setMatrixAt(i, this._m);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    const world = this.world;
    this._splatCooldown -= dt;
    this.drops.update(dt, (i, ox, oy, oz) => {
      const P = this.drops.p;
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      _pp.set(x, y, z);
      const box = world.pointInside(_pp);
      if (!box) return false;
      // which face did we enter through?
      const n = _nn;
      if (box.ring) {
        world.ringNormal(_pp, n);
        const R = world.ring;
        _pp.x = R.cx - n.x * (R.r - 0.008); _pp.z = R.cz - n.z * (R.r - 0.008);
        const s0 = this.drops.user[i];
        this.addDecal(_pp, n, clamp(s0 * 7, 0.06, 0.35), Math.floor(Math.random() * 4), Math.random() * 6.28, rand(0.75, 1));
        return true;
      }
      if (oy >= world.topAt(box, ox, oz) - 0.01) n.set(0, 1, 0);
      else if (ox <= box.min.x) n.set(-1, 0, 0);
      else if (ox >= box.max.x) n.set(1, 0, 0);
      else if (oz <= box.min.z) n.set(0, 0, -1);
      else if (oz >= box.max.z) n.set(0, 0, 1);
      else if (oy <= box.min.y) n.set(0, -1, 0);
      else n.set(0, 1, 0);
      if (n.y < -0.5) return true;
      // snap to surface
      if (n.y > 0.5) _pp.y = world.topAt(box, x, z) + 0.006 + Math.random() * 0.004;
      else if (n.x !== 0) _pp.x = (n.x < 0 ? box.min.x : box.max.x) + n.x * 0.006;
      else _pp.z = (n.z < 0 ? box.min.z : box.max.z) + n.z * 0.006;
      const s = this.drops.user[i];
      const V = this.drops.v;
      const vx = V[i * 3], vy = V[i * 3 + 1], vz = V[i * 3 + 2];
      const speed = Math.hypot(vx, vy, vz);
      // directional splats when hitting at speed
      let variant = Math.floor(Math.random() * 4), angle = Math.random() * Math.PI * 2;
      if (n.y > 0.5 && Math.hypot(vx, vz) > 2.5) { variant = 4 + Math.floor(Math.random() * 4); angle = Math.atan2(vz, vx) * -1; }
      // only some droplets leave a mark, sizes vary a lot so it reads as spatter, not polka dots
      if (Math.random() < 0.45) {
        const size = clamp(s * 5 + speed * 0.01, 0.035, 0.38) * (Math.random() < 0.12 ? 2.2 : Math.random() < 0.5 ? 0.55 : 1);
        this.addDecal(_pp, n, size, variant, angle, rand(0.55, 0.95));
      }
      if (this._splatCooldown <= 0 && this.audio && Math.random() < 0.25) {
        this._splatCooldown = 0.05;
        this.audio.play('splat', { pos: _pp, volume: 0.4 });
      }
      return true;
    });
    this.mist.update(dt);

    // decal grow-in
    for (let i = 0; i < this.decals.count; i++) {
      const d = this.decalData[i];
      if (d && d.grow > 0) {
        d.size += (d.target - d.size) * Math.min(1, dt * 22);
        if (Math.abs(d.target - d.size) < 0.002) { d.size = d.target; d.grow = 0; }
        this._writeDecal(i);
      }
    }
    // pools
    for (let k = this.pools.length - 1; k >= 0; k--) {
      const pl = this.pools[k];
      const d = this.decalData[pl.idx];
      if (!d || d.gen !== pl.gen) { this.pools.splice(k, 1); continue; }
      pl.size += (pl.max - pl.size) * dt * pl.rate * 0.6;
      d.size = d.target = pl.size;
      this._writeDecal(pl.idx);
      if (pl.max - pl.size < 0.01) this.pools.splice(k, 1);
    }
    // spurts
    for (let k = this.spurts.length - 1; k >= 0; k--) {
      const s = this.spurts[k];
      s.t += dt;
      if (s.t > s.dur || !s.obj.parent) { this.spurts.splice(k, 1); continue; }
      s.next -= dt;
      const fall = 1 - s.t / s.dur;
      if (s.next <= 0) {
        s.next = 0.32 + (1 - fall) * 0.25;
        s.obj.updateWorldMatrix(true, false);
        _pp.copy(s.off).applyMatrix4(s.obj.matrixWorld);
        _nn.copy(s.dir).transformDirection(s.obj.matrixWorld);
        this.spray(_pp, _nn, Math.floor(26 * fall * s.str) + 4, 4.5 * fall * s.str + 1.5, 0.12, 1.1);
        if (this.audio && fall > 0.4) this.audio.play('gore_spurt', { pos: _pp, volume: 0.5 * fall });
      } else if (Math.random() < 0.6) {
        s.obj.updateWorldMatrix(true, false);
        _pp.copy(s.off).applyMatrix4(s.obj.matrixWorld);
        _nn.copy(s.dir).transformDirection(s.obj.matrixWorld);
        this.spray(_pp, _nn, 1, 1.2 * fall + 0.4, 0.15, 0.9);
      }
    }
  }

  clear() {
    this.drops.n = 0; this.mist.n = 0;
    this.decals.count = 0; this.decalHead = 0;
    this.spurts.length = 0; this.pools.length = 0;
  }
}
const _UP = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);
const _qr = new THREE.Quaternion();
const _pp = new THREE.Vector3();
const _nn = new THREE.Vector3();
