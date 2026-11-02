import * as THREE from 'three';
import { StreakSystem } from './particles.js';
import { rand } from '../core/math.js';

// Sword trails, sparks, flashes, debris (severed parts, splinters).

const TRAIL_VERT = /* glsl */ `
attribute float aAlpha;
varying float vA;
varying float vV;
void main(){
  vA = aAlpha;
  vV = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TRAIL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uEdge;
varying float vA;
varying float vV;
void main(){
  // a thin crescent along the tip path, fading toward the hilt
  float edge = smoothstep(0.82, 1.0, vV);
  float body = smoothstep(0.45, 0.95, vV);
  vec3 c = mix(uColor, uEdge, edge);
  float a = vA * (body * 0.22 + edge * 0.7);
  gl_FragColor = vec4(c * a, a);
}`;

export class Trail {
  constructor(scene, { color = [1.2, 1.25, 1.4], edge = [2.2, 2.3, 2.6], life = 0.16, sub = 5 } = {}) {
    this.max = 40;
    this.samples = [];
    this.life = life;
    this.sub = sub;
    const n = this.max * sub * 2;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    this.alpha = new Float32Array(n);
    this.uvs = new Float32Array(n * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    const idx = [];
    for (let i = 0; i < this.max * sub - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
      uniforms: { uColor: { value: new THREE.Vector3(...color) }, uEdge: { value: new THREE.Vector3(...edge) } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }
  setColor(c, e) { this.mat.uniforms.uColor.value.set(...c); this.mat.uniforms.uEdge.value.set(...e); }

  push(base, tip, t) {
    const last = this.samples[this.samples.length - 1];
    if (last && last.tip.distanceToSquared(tip) < 1e-6) { last.t = t; return; }
    this.samples.push({ base: base.clone(), tip: tip.clone(), t });
    if (this.samples.length > this.max) this.samples.shift();
  }
  clear() { this.samples.length = 0; this.geo.setDrawRange(0, 0); }

  update(t) {
    while (this.samples.length && t - this.samples[0].t > this.life) this.samples.shift();
    const S = this.samples;
    if (S.length < 2) { this.geo.setDrawRange(0, 0); return; }
    let v = 0;
    const sub = this.sub;
    for (let i = 0; i < S.length - 1; i++) {
      const s0 = S[Math.max(0, i - 1)], s1 = S[i], s2 = S[i + 1], s3 = S[Math.min(S.length - 1, i + 2)];
      const steps = i === S.length - 2 ? sub + 1 : sub;
      for (let k = 0; k < steps; k++) {
        const u = k / sub;
        cr(_b, s0.base, s1.base, s2.base, s3.base, u);
        cr(_t, s0.tip, s1.tip, s2.tip, s3.tip, u);
        const age = (t - (s1.t + (s2.t - s1.t) * u)) / this.life;
        const a = Math.max(0, 1 - age);
        const a2 = a * a;
        this.pos[v * 6] = _b.x; this.pos[v * 6 + 1] = _b.y; this.pos[v * 6 + 2] = _b.z;
        this.pos[v * 6 + 3] = _t.x; this.pos[v * 6 + 4] = _t.y; this.pos[v * 6 + 5] = _t.z;
        this.alpha[v * 2] = a2; this.alpha[v * 2 + 1] = a2;
        this.uvs[v * 4] = 0; this.uvs[v * 4 + 1] = 0; this.uvs[v * 4 + 2] = 0; this.uvs[v * 4 + 3] = 1;
        v++;
        if (v >= this.max * sub) break;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.setDrawRange(0, Math.max(0, (v - 1) * 6));
  }
}
function cr(out, p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  out.x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  out.y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  out.z = 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
}
const _b = new THREE.Vector3(), _t = new THREE.Vector3();

export class FX {
  constructor(scene, world, textures) {
    this.scene = scene;
    this.world = world;
    this.sparks = new StreakSystem(1200, { additive: true, stretch: 0.03, soft: 0.2 });
    this.embers = new StreakSystem(600, { additive: true, stretch: 0.02, soft: 0.1 });
    this.dust = new StreakSystem(300, { stretch: 0, soft: -0.3 });
    scene.add(this.sparks.mesh, this.embers.mesh, this.dust.mesh);
    // flash sprites
    this.flashMat = new THREE.SpriteMaterial({ map: textures.soft, color: new THREE.Color(2.4, 1.7, 1.1), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.flashes = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(this.flashMat.clone());
      s.visible = false;
      s.renderOrder = 6;
      scene.add(s);
      this.flashes.push({ s, life: 0, max: 0, size: 0 });
    }
    // one dynamic light for impact flashes
    this.light = new THREE.PointLight(0xffc080, 0, 8, 2);
    scene.add(this.light);
    this.lightLife = 0;
    this.lightMax = 1;
    this.lightPeak = 0;
    this.debris = [];
    this.woodMat = null;
  }

  sparksBurst(p, dir, count = 30, speed = 9, hot = 1) {
    for (let i = 0; i < count; i++) {
      const sp = speed * rand(0.3, 1.2);
      const vx = dir.x * sp + rand(-1, 1) * sp * 0.6;
      const vy = dir.y * sp + rand(-0.4, 1) * sp * 0.6 + 2;
      const vz = dir.z * sp + rand(-1, 1) * sp * 0.6;
      const w = rand(0.7, 1);
      this.sparks.spawn(p.x, p.y, p.z, vx, vy, vz, 4.5 * hot, 2.2 * hot * w, 0.6 * hot * w * w, 1, rand(0.006, 0.013), rand(0.18, 0.5), 14, 1.5);
    }
  }

  // bright streak across the point of impact, lined up with the cut
  slashFlash(p, dir, color = [3.2, 0.6, 0.4], len = 1) {
    for (let i = 0; i < 3; i++) {
      const s = (i - 1) * 0.04;
      this.sparks.spawn(p.x + dir.x * (s + 0.35 * len), p.y + dir.y * (s + 0.35 * len) + (i - 1) * 0.02, p.z + dir.z * (s + 0.35 * len), dir.x * 24 * len, dir.y * 24 * len, dir.z * 24 * len,
        color[0], color[1], color[2], 1, 0.012 - Math.abs(i - 1) * 0.004, 0.1, 0, -1);
    }
  }

  emberBurst(p, count = 10, spread = 0.3) {
    for (let i = 0; i < count; i++) {
      this.embers.spawn(p.x + rand(-spread, spread), p.y + rand(-spread, spread), p.z + rand(-spread, spread),
        rand(-0.6, 0.6), rand(0.8, 2.5), rand(-0.6, 0.6), 5, 1.6, 0.3, 1, rand(0.008, 0.018), rand(0.6, 1.4), -0.6, 1.2);
    }
  }

  dustPuff(p, count = 8, color = [0.18, 0.18, 0.2]) {
    for (let i = 0; i < count; i++) {
      this.dust.spawn(p.x + rand(-0.2, 0.2), p.y + 0.05, p.z + rand(-0.2, 0.2), rand(-1.2, 1.2), rand(0.1, 0.6), rand(-1.2, 1.2),
        color[0], color[1], color[2], rand(0.2, 0.35), rand(0.1, 0.2), rand(0.5, 1.0), 0, 2.5, rand(0.4, 0.9));
    }
  }

  flash(p, size = 0.6, life = 0.12, color = null) {
    const f = this.flashes.find((x) => x.life <= 0) || this.flashes[0];
    f.s.position.copy(p);
    f.s.visible = true;
    f.life = f.max = life;
    f.size = size;
    if (color) f.s.material.color.setRGB(...color); else f.s.material.color.setRGB(2.4, 1.7, 1.1);
    this.light.position.copy(p);
    this.lightPeak = 5 * size;
    this.lightLife = this.lightMax = life * 2;
  }

  addDebris(obj, vel, angVel, { radius = 0.1, bounce = 0.3, life = 1e9, friction = 0.85, onHit = null } = {}) {
    this.scene.add(obj);
    this.debris.push({ obj, vel: vel.clone(), ang: angVel.clone(), radius, bounce, life, friction, onHit, rest: 0 });
    // keep debris count bounded
    if (this.debris.length > 80) {
      const old = this.debris.shift();
      old.obj.removeFromParent();
    }
  }

  splinters(p, count = 14, color = 0x6a4a30, dir = null) {
    if (!this._splGeo) {
      this._splGeo = new THREE.BoxGeometry(0.04, 0.03, 0.22);
      this._splMat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    }
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this._splGeo, this._splMat);
      m.scale.set(rand(0.6, 1.6), rand(0.6, 1.4), rand(0.4, 1.8));
      m.position.set(p.x + rand(-0.25, 0.25), p.y + rand(0, 0.5), p.z + rand(-0.25, 0.25));
      m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
      m.castShadow = true;
      const v = new THREE.Vector3(rand(-3, 3), rand(2, 6), rand(-3, 3));
      if (dir) v.addScaledVector(dir, 4);
      this.addDebris(m, v, new THREE.Vector3(rand(-15, 15), rand(-15, 15), rand(-15, 15)), { radius: 0.03, bounce: 0.25, life: rand(5, 9) });
    }
  }

  // expanding ground ring for shockwaves
  shockwave(p, radius) {
    if (!this._ringGeo) {
      this._ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
    }
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 1.0), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
    const m = new THREE.Mesh(this._ringGeo, mat);
    m.position.set(p.x, p.y + 0.04, p.z);
    this.scene.add(m);
    (this.rings || (this.rings = [])).push({ m, t: 0, r: radius });
  }

  // meaty chunks that bounce and bleed
  gibs(p, dir, count = 5) {
    if (!this._gibGeo) {
      this._gibGeo = new THREE.IcosahedronGeometry(0.045, 0);
      this._gibMat = new THREE.MeshStandardMaterial({ color: 0x4a0606, roughness: 0.25, metalness: 0 });
    }
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this._gibGeo, this._gibMat);
      m.scale.set(rand(0.5, 1.4), rand(0.5, 1.2), rand(0.6, 1.6));
      m.position.set(p.x + rand(-0.1, 0.1), p.y + rand(-0.1, 0.1), p.z + rand(-0.1, 0.1));
      m.castShadow = true;
      const v = new THREE.Vector3(rand(-2.5, 2.5), rand(2.5, 6), rand(-2.5, 2.5));
      if (dir) v.addScaledVector(dir, 3.5);
      this.addDebris(m, v, new THREE.Vector3(rand(-20, 20), rand(-20, 20), rand(-20, 20)), {
        radius: 0.03, bounce: 0.2, life: 40, friction: 0.6,
        onHit: (d, s) => { if (s > 2 && this.onGibHit) this.onGibHit(d.obj.position, s); },
      });
    }
  }

  update(dt) {
    if (this.rings) for (let i = this.rings.length - 1; i >= 0; i--) {
      const R = this.rings[i];
      R.t += dt / 0.35;
      const e = 1 - Math.pow(1 - Math.min(1, R.t), 3);
      R.m.scale.setScalar(0.2 + e * R.r);
      R.m.material.opacity = 0.8 * (1 - R.t);
      if (R.t >= 1) { R.m.removeFromParent(); R.m.material.dispose(); this.rings.splice(i, 1); }
    }
    this.sparks.update(dt);
    this.embers.update(dt);
    this.dust.update(dt);
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = Math.max(0, f.life / f.max);
      f.s.scale.setScalar(f.size * (1.4 - k * 0.4));
      f.s.material.opacity = k;
      if (f.life <= 0) f.s.visible = false;
    }
    if (this.lightLife > 0) {
      this.lightLife -= dt;
      this.light.intensity = this.lightPeak * Math.max(0, this.lightLife / this.lightMax);
    } else this.light.intensity = 0;

    const w = this.world;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) { d.obj.removeFromParent(); this.debris.splice(i, 1); continue; }
      if (d.rest > 1.5) continue;
      const o = d.obj;
      d.vel.y -= 18 * dt;
      const px = o.position.x, pz = o.position.z;
      o.position.addScaledVector(d.vel, dt);
      _aq.setFromAxisAngle(_ax.copy(d.ang).normalize(), d.ang.length() * dt);
      if (d.ang.lengthSq() > 1e-6) o.quaternion.premultiply(_aq);
      // walls
      _tp.copy(o.position);
      const box = w.pointInside(_tp, d.radius);
      if (box) {
        const top = w.topAt(box, o.position.x, o.position.z);
        if (o.position.y - d.vel.y * dt >= top - 0.02) {
          o.position.y = top + d.radius;
          if (d.vel.y < -1.5 && d.onHit) d.onHit(d, -d.vel.y);
          d.vel.y = Math.abs(d.vel.y) * d.bounce;
          if (d.vel.y < 0.6) d.vel.y = 0;
          d.vel.x *= d.friction; d.vel.z *= d.friction;
          d.ang.multiplyScalar(d.friction);
          if (d.vel.lengthSq() < 0.05) d.rest += dt;
        } else {
          o.position.x = px; o.position.z = pz;
          d.vel.x *= -d.bounce; d.vel.z *= -d.bounce;
        }
      }
      if (o.position.y < -20) d.life = 0;
    }
  }

  clear() {
    for (const d of this.debris) d.obj.removeFromParent();
    this.debris.length = 0;
    this.sparks.n = this.embers.n = this.dust.n = 0;
  }
}
const _aq = new THREE.Quaternion(), _ax = new THREE.Vector3(), _tp = new THREE.Vector3();
