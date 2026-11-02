import * as THREE from 'three';

// GPU-drawn, CPU-simulated stretched particles (sparks, blood droplets, mist, embers).
// Each particle is a camera-facing quad stretched along its velocity.

const VERT = /* glsl */ `
attribute vec2 corner;
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iCol;
attribute float iSize;
uniform float uStretch;
varying vec2 vUv;
varying vec4 vCol;
void main(){
  vec4 h = viewMatrix * vec4(iPos, 1.0);
  vec4 t = viewMatrix * vec4(iPos - iVel * uStretch, 1.0);
  vec2 d = h.xy - t.xy;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);
  // quad from tail to head, padded by size at both ends
  vec3 p = mix(t.xyz, h.xyz, corner.y);
  p.xy += dir * (corner.y * 2.0 - 1.0) * iSize;
  p.xy += side * corner.x * iSize;
  vUv = corner;
  vCol = iCol;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vCol;
uniform float uSoft;
void main(){
  float x = abs(vUv.x);
  float y = abs(vUv.y * 2.0 - 1.0);
  float r = sqrt(x * x + y * y * y * y);
  float a = 1.0 - smoothstep(uSoft, 1.0, r);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol.rgb * (0.65 + 0.7 * (1.0 - r)), vCol.a * a);
}`;

export class StreakSystem {
  constructor(capacity, { additive = false, stretch = 0.035, soft = 0.4, depthWrite = false, renderOrder = 0 } = {}) {
    this.cap = capacity;
    this.n = 0;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, 0, 1, 0, 1, 1, -1, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.aPos, this.aVel, this.aCol, this.aSize]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iVel', this.aVel);
    g.setAttribute('iCol', this.aCol);
    g.setAttribute('iSize', this.aSize);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uStretch: { value: stretch }, uSoft: { value: soft } },
      transparent: true, depthWrite, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide, // quads are built in view space; winding flips with direction
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    // sim state
    this.p = new Float32Array(capacity * 3);
    this.v = new Float32Array(capacity * 3);
    this.c = new Float32Array(capacity * 4);
    this.s = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.fade = new Float32Array(capacity);
    this.user = new Float32Array(capacity); // free slot for per-type data
  }

  spawn(px, py, pz, vx, vy, vz, r, g, b, a, size, life, grav = 9.8, drag = 0.5, grow = 0, user = 0) {
    let i;
    if (this.n < this.cap) i = this.n++;
    else i = (Math.random() * this.cap) | 0;
    this.p[i * 3] = px; this.p[i * 3 + 1] = py; this.p[i * 3 + 2] = pz;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.c[i * 4] = r; this.c[i * 4 + 1] = g; this.c[i * 4 + 2] = b; this.c[i * 4 + 3] = a;
    this.s[i] = size; this.life[i] = life; this.maxLife[i] = life;
    this.grav[i] = grav; this.drag[i] = drag; this.grow[i] = grow; this.user[i] = user;
    return i;
  }

  kill(i) {
    const last = --this.n;
    if (i !== last) {
      for (let k = 0; k < 3; k++) { this.p[i * 3 + k] = this.p[last * 3 + k]; this.v[i * 3 + k] = this.v[last * 3 + k]; }
      for (let k = 0; k < 4; k++) this.c[i * 4 + k] = this.c[last * 4 + k];
      this.s[i] = this.s[last]; this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
      this.grav[i] = this.grav[last]; this.drag[i] = this.drag[last]; this.grow[i] = this.grow[last]; this.user[i] = this.user[last];
    }
  }

  // collide(i, x, y, z, px, py, pz) -> true to kill
  update(dt, collide = null) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kill(i); continue; }
      const i3 = i * 3;
      if (this.drag[i] < 0) continue; // static streak (velocity only sets its shape)
      const ox = this.p[i3], oy = this.p[i3 + 1], oz = this.p[i3 + 2];
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.v[i3] *= dr; this.v[i3 + 1] = this.v[i3 + 1] * dr - this.grav[i] * dt; this.v[i3 + 2] *= dr;
      this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
      this.s[i] += this.grow[i] * dt;
      if (collide && collide(i, ox, oy, oz)) { this.kill(i); continue; }
    }
    // upload
    const n = this.n;
    const P = this.aPos.array, V = this.aVel.array, C = this.aCol.array, S = this.aSize.array;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3, i4 = i * 4;
      P[i3] = this.p[i3]; P[i3 + 1] = this.p[i3 + 1]; P[i3 + 2] = this.p[i3 + 2];
      V[i3] = this.v[i3]; V[i3 + 1] = this.v[i3 + 1]; V[i3 + 2] = this.v[i3 + 2];
      const lf = this.life[i] / this.maxLife[i];
      C[i4] = this.c[i4]; C[i4 + 1] = this.c[i4 + 1]; C[i4 + 2] = this.c[i4 + 2];
      C[i4 + 3] = this.c[i4 + 3] * Math.min(1, lf * 3);
      S[i] = this.s[i];
    }
    this.geo.instanceCount = n;
    if (n) {
      this.aPos.needsUpdate = this.aVel.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
      this.aPos.addUpdateRange(0, n * 3); this.aVel.addUpdateRange(0, n * 3);
      this.aCol.addUpdateRange(0, n * 4); this.aSize.addUpdateRange(0, n);
    }
  }
}
