import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeFlameMaterial } from './weather.js';
import { patchMaterial } from '../render/materials.js';
import { addReflection } from '../render/reflection.js';
import { rand } from '../core/math.js';

// The Pit: an open, rain-soaked fighting ring. Nothing inside to hide behind —
// a curved stone wall to slam enemies into, four gates they pour out of, and a great gate for the Warden.

export const ARENA_R = 14;
const WALL_H = 3.4;

export class Arena {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.M = game.materials;
    this.buckets = new Map();
    this.flames = [];
    this.lights = [];
    this.breakables = [];
    this.gates = [];
    this.group = new THREE.Group();
    game.scene.add(this.group);
    this.gateOpen = 0;
  }

  _push(key, geo, uv = 0.5) {
    if (geo.index) geo = geo.toNonIndexed();
    worldUV(geo, uv);
    if (!this.buckets.has(key)) this.buckets.set(key, []);
    this.buckets.get(key).push(geo);
  }
  finalize() {
    for (const [key, list] of this.buckets) {
      const mesh = new THREE.Mesh(mergeGeometries(list.map(strip), false), this.M[key]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    this.buckets.clear();
  }
  // a box rotated to sit on the ring at angle a, radius r
  ringBox(a, r, y, w, h, d, key, uv) {
    const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(0.05, Math.min(w, h, d) * 0.25));
    g.rotateY(-a + Math.PI / 2);
    g.translate(Math.cos(a) * r, y + h / 2, Math.sin(a) * r);
    this._push(key, g, uv);
  }

  build() {
    const R = ARENA_R;
    this.world.addBox(-60, -1, -60, 60, 0, 60, { climb: false });
    this.world.setRing(0, 0, R, WALL_H + 0.6);

    // floor: wet cobble disc with live planar reflections
    const floor = new THREE.CircleGeometry(R + 0.5, 72).rotateX(-Math.PI / 2);
    worldUV(floor, 0.62);
    const T = this.game.textures.cobble;
    const floorMat = patchMaterial(new THREE.MeshStandardMaterial({ map: T.map, normalMap: T.normalMap, roughnessMap: T.roughnessMap, roughness: 0.62, normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity: 1.0 }), { rim: 0.05 });
    if (this.game.reflection) addReflection(floorMat, this.game.reflection, 1.0);
    const floorMesh = new THREE.Mesh(floor, floorMat);
    floorMesh.receiveShadow = true;
    this.group.add(floorMesh);
    if (this.game.reflection) this.game.reflection.hidden.push(floorMesh);
    this.floorMat = floorMat;
    const outerFloor = new THREE.RingGeometry(R + 0.5, 60, 48, 1).rotateX(-Math.PI / 2).translate(0, -0.01, 0);
    this._push('wallDark', outerFloor, 0.3);
    for (const [r0, r1] of [[3.0, 3.35], [8.6, 8.9]]) {
      const ring = new THREE.RingGeometry(r0, r1, 72, 1).rotateX(-Math.PI / 2).translate(0, 0.012, 0);
      this._push('trim', ring, 0.8);
    }
    this.buildPlatforms();

    // ring wall: segmented blocks with buttresses, gates at N/E/S/W
    const N = 56;
    const gateAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
    const isGate = (a) => gateAngles.some((g) => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < (g === -Math.PI / 2 ? 0.17 : 0.12));
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const seg = (2 * Math.PI * (R + 0.5)) / N * 1.04;
      if (isGate(a)) continue;
      this.ringBox(a, R + 0.45, 0, seg, WALL_H, 0.9, 'wall', 0.5);
      this.ringBox(a, R + 0.3, WALL_H, seg, 0.22, 0.75, 'trim', 0.6);
      if (i % 4 === 0) this.ringBox(a, R + 0.15, 0, 0.55, WALL_H + 0.25, 0.5, 'trim', 0.6); // pilaster
      if (i % 2 === 0) this.ringBox(a, R + 0.75, WALL_H + 0.22, seg * 0.55, 0.55, 0.35, 'wall', 0.5); // crenel
    }
    // tiered stands outside the wall
    for (let t = 0; t < 4; t++) {
      const r = R + 1.6 + t * 1.3, y = WALL_H + 0.2 + t * 0.85;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        if (isGate(a) && t < 2) continue;
        const seg = (2 * Math.PI * r) / N * 1.05;
        this.ringBox(a, r, 0, seg, y, 1.35, t % 2 ? 'wallDark' : 'trim', 0.5);
      }
    }
    // outer back wall with towers
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = R + 7.5;
      this.ringBox(a, r, 0, (2 * Math.PI * r) / 40 * 1.05, 10, 1.2, 'wall', 0.4);
      if (i % 5 === 0) {
        const g = new THREE.CylinderGeometry(1.6, 1.8, 14, 10).translate(Math.cos(a) * (r + 0.6), 7, Math.sin(a) * (r + 0.6));
        this._push('wall', g, 0.4);
        const roof = new THREE.ConeGeometry(2.1, 3.5, 10).translate(Math.cos(a) * (r + 0.6), 15.7, Math.sin(a) * (r + 0.6));
        this._push('roof', roof, 0.5);
      }
    }

    // gates
    for (const a of gateAngles) this.buildGate(a, a === -Math.PI / 2);

    // banners hanging over the wall between gates
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const g = new THREE.PlaneGeometry(1.0, 2.2, 3, 8).translate(0, -1.1, 0);
      const m = new THREE.Mesh(g, i % 2 ? this.M.clothRed : this.M.clothDark);
      m.position.set(Math.cos(a) * (R - 0.02), WALL_H + 0.1, Math.sin(a) * (R - 0.02));
      m.rotation.y = -a - Math.PI / 2;
      m.castShadow = true;
      this.group.add(m);
    }
    // weapons stuck in the ground near the wall, skulls, debris
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2), r = rand(R - 1.2, R - 0.4);
      const g = new RoundedBoxGeometry(rand(0.1, 0.3), rand(0.06, 0.14), rand(0.1, 0.3), 1, 0.03).rotateY(rand(0, 3)).translate(Math.cos(a) * r, 0.05, Math.sin(a) * r);
      this._push('wall', g, 0.5);
    }
    for (let i = 0; i < 7; i++) {
      const a = rand(0, Math.PI * 2), r = rand(R - 1.0, R - 0.5);
      const blade = new THREE.BoxGeometry(0.05, 0.9, 0.01).rotateZ(rand(-0.3, 0.3)).rotateX(rand(-0.3, 0.3)).translate(Math.cos(a) * r, 0.35, Math.sin(a) * r);
      this._push('iron', blade, 1);
    }

    // puddles
    for (let i = 0; i < 0; i++) {
      const a = rand(0, Math.PI * 2), r = rand(1.5, R - 1.5);
      const g = new THREE.CircleGeometry(rand(0.5, 1.5), 20);
      const pos = g.attributes.position;
      for (let k = 1; k < pos.count; k++) {
        const an = Math.atan2(pos.getY(k), pos.getX(k));
        const f = 1 + Math.sin(an * 3 + i) * 0.18 + Math.sin(an * 5 + i * 2) * 0.1;
        pos.setXY(k, pos.getX(k) * f, pos.getY(k) * f * rand(0.6, 0.9));
      }
      const m = new THREE.Mesh(g, this.M.puddle);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = rand(0, 6);
      m.position.set(Math.cos(a) * r, 0.008, Math.sin(a) * r);
      m.receiveShadow = true;
      this.group.add(m);
    }

    this.finalize();
    this.buildLights();
    this.buildAtmosphere();
    this.spawnPoints = {
      player: new THREE.Vector3(0, 0, 7),
      doors: gateAngles.map((a) => new THREE.Vector3(Math.cos(a) * (R - 1.2), 0, Math.sin(a) * (R - 1.2))),
      rampart: gateAngles.map((a) => new THREE.Vector3(Math.cos(a) * (R - 1.2), 0, Math.sin(a) * (R - 1.2))),
      boss: new THREE.Vector3(0, 0, -(R - 2)),
      bossPlayer: new THREE.Vector3(0, 0, 6),
    };
  }

  // A little verticality without clutter: a low central dais, four stone plinths with steps,
  // and two broken pillars to leap onto from the plinths.
  buildPlatforms() {
    const W = this.world;
    const box = (x, z, w, d, h, y0 = 0, key = 'wall', climb = true) => {
      const g = new RoundedBoxGeometry(w, h, d, 2, 0.07);
      g.translate(x, y0 + h / 2, z);
      this._push(key, g, 0.55);
      W.addBox(x - w / 2, y0, z - d / 2, x + w / 2, y0 + h, z + d / 2, { climb });
    };
    const trimCap = (x, z, w, d, y) => {
      const g = new RoundedBoxGeometry(w + 0.16, 0.12, d + 0.16, 2, 0.04).translate(x, y + 0.02, z);
      this._push('trim', g, 0.7);
    };
    // central dais (walkable step) — round visual, collision from overlapping boxes
    const daisH = 0.42, daisR = 2.5;
    this._push('trim', new THREE.CylinderGeometry(daisR, daisR + 0.12, daisH, 40).translate(0, daisH / 2, 0), 0.6);
    this._push('wall', new THREE.CylinderGeometry(daisR - 0.25, daisR - 0.25, 0.04, 40).translate(0, daisH + 0.01, 0), 0.4);
    W.addBox(-daisR, 0, -1.05, daisR, daisH, 1.05);
    W.addBox(-1.05, 0, -daisR, 1.05, daisH, daisR);
    W.addBox(-1.78, 0, -1.78, 1.78, daisH, 1.78);
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      this._push('trim', new THREE.BoxGeometry(0.16, 0.03, 3.6).rotateY(a).translate(0, daisH + 0.025, 0), 0.8);
    }
    this._push('trim', new THREE.TorusGeometry(1.2, 0.06, 6, 40).rotateX(Math.PI / 2).translate(0, daisH + 0.02, 0), 0.8);

    // four plinths between the gates
    this.plinths = [];
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2;
      const cx = Math.round(Math.cos(a) * 8.0 * 10) / 10, cz = Math.round(Math.sin(a) * 8.0 * 10) / 10;
      const h = 1.25;
      box(cx, cz, 2.3, 2.3, h);
      trimCap(cx, cz, 2.3, 2.3, h - 0.08);
      // a waist-high step on the side facing the centre
      const sx = cx - Math.sign(cx) * 1.55, sz = cz;
      box(sx, sz, 0.9, 1.4, 0.6, 0, 'trim');
      // carved frieze stripe
      this._push('wallDark', new RoundedBoxGeometry(2.36, 0.16, 2.36, 1, 0.03).translate(cx, 0.55, cz), 0.6);
      this.plinths.push({ x: cx, z: cz, top: h });
      // two plinths carry a broken pillar you can leap onto
      if (i % 2 === 0) {
        const px = cx + Math.sign(cx) * 0.55, pz = cz + Math.sign(cz) * 0.55;
        const ph = 2.05;
        this._push('wall', new THREE.CylinderGeometry(0.5, 0.56, ph - h, 14).translate(px, h + (ph - h) / 2, pz), 0.5);
        W.addBox(px - 0.45, h, pz - 0.45, px + 0.45, ph, pz + 0.45);
        // jagged break on top
        for (let k = 0; k < 4; k++) {
          const g = new RoundedBoxGeometry(rand(0.2, 0.35), rand(0.08, 0.18), rand(0.2, 0.35), 1, 0.03).rotateY(rand(0, 3)).translate(px + rand(-0.25, 0.25), ph + 0.04, pz + rand(-0.25, 0.25));
          this._push('wall', g, 0.5);
        }
      } else {
        // the others hold a low brazier on their outer corner
        this.plinthBraziers = this.plinthBraziers || [];
        this.plinthBraziers.push(new THREE.Vector3(cx + Math.sign(cx) * 0.75, h, cz + Math.sign(cz) * 0.75));
        W.addBox(cx + Math.sign(cx) * 0.75 - 0.32, h, cz + Math.sign(cz) * 0.75 - 0.32, cx + Math.sign(cx) * 0.75 + 0.32, h + 0.9, cz + Math.sign(cz) * 0.75 + 0.32, { climb: false });
      }
    }
  }

  buildGate(a, big) {
    const R = ARENA_R;
    const w = big ? 3.4 : 2.4, h = big ? 4.6 : 3.2;
    const cx = Math.cos(a), cz = Math.sin(a);
    const tx = -cz, tz = cx; // tangent
    // side towers
    for (const s of [-1, 1]) {
      const px = cx * (R + 0.5) + tx * s * (w / 2 + 0.55), pz = cz * (R + 0.5) + tz * s * (w / 2 + 0.55);
      const g = new RoundedBoxGeometry(1.1, h + 1.6, 1.4, 2, 0.06).rotateY(-a + Math.PI / 2).translate(px, (h + 1.6) / 2, pz);
      this._push('wall', g, 0.5);
      const cap = new RoundedBoxGeometry(1.3, 0.25, 1.6, 2, 0.05).rotateY(-a + Math.PI / 2).translate(px, h + 1.7, pz);
      this._push('trim', cap, 0.6);
    }
    // lintel
    const lin = new RoundedBoxGeometry(w + 2.2, 0.6, 1.2, 2, 0.06).rotateY(-a + Math.PI / 2).translate(cx * (R + 0.5), h + 0.3, cz * (R + 0.5));
    this._push('trim', lin, 0.6);
    // dark tunnel behind the gate
    const tun = new THREE.BoxGeometry(w, h, 3).rotateY(-a + Math.PI / 2).translate(cx * (R + 2.2), h / 2, cz * (R + 2.2));
    this._push('wallDark', tun, 0.5);
    // portcullis (animated)
    const bars = [];
    const nb = Math.round(w / 0.42);
    for (let i = 0; i <= nb; i++) bars.push(new THREE.BoxGeometry(0.07, h, 0.07).translate(-w / 2 + (i / nb) * w, h / 2, 0));
    for (let j = 0; j < 5; j++) bars.push(new THREE.BoxGeometry(w, 0.07, 0.07).translate(0, 0.35 + j * (h / 5), 0));
    const pg = mergeGeometries(bars.map(strip));
    const port = new THREE.Mesh(pg, this.M.iron);
    port.castShadow = true;
    port.position.set(cx * (R + 0.2), 0, cz * (R + 0.2));
    port.rotation.y = -a + Math.PI / 2;
    this.group.add(port);
    this.gates.push({ a, mesh: port, h, open: 0, target: 0, big });
  }

  buildLights() {
    const scene = this.game.scene;
    const R = ARENA_R;
    const flameGeo = new THREE.PlaneGeometry(1, 1);
    for (const b of this.plinthBraziers || []) {
      const parts = [
        new THREE.CylinderGeometry(0.05, 0.08, 0.6, 8).translate(b.x, b.y + 0.3, b.z),
        new THREE.CylinderGeometry(0.32, 0.2, 0.24, 12, 1, true).translate(b.x, b.y + 0.72, b.z),
        new THREE.TorusGeometry(0.32, 0.03, 6, 14).rotateX(Math.PI / 2).translate(b.x, b.y + 0.84, b.z),
      ];
      for (const p of parts) this._push('iron', p, 1);
      const coal = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.24, 0.1, 10), this.M.coal);
      coal.position.set(b.x, b.y + 0.78, b.z);
      this.group.add(coal);
      for (let k = 0; k < 2; k++) {
        const f = new THREE.Mesh(flameGeo, makeFlameMaterial());
        f.material.uniforms.uHeat.value = 0.55;
        f.position.set(b.x + rand(-0.06, 0.06), b.y + 0.78, b.z + rand(-0.06, 0.06));
        f.scale.set(rand(0.38, 0.5), rand(0.55, 0.8), 1);
        f.renderOrder = 7;
        f.frustumCulled = false;
        this.group.add(f);
        this.flames.push(f);
      }
      const light = new THREE.PointLight(0xff8a3a, 4.5, 14, 1.4);
      light.position.set(b.x, b.y + 1.5, b.z);
      scene.add(light);
      this.lights.push({ light, base: 4.5, ph: Math.random() * 10 });
      this.emberSources = this.emberSources || [];
      this.emberSources.push(new THREE.Vector3(b.x, b.y + 0.95, b.z));
    }
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.PI / 8;
      const x = Math.cos(a) * (R + 0.35), z = Math.sin(a) * (R + 0.35), y = WALL_H + 0.22;
      const parts = [
        new THREE.CylinderGeometry(0.34, 0.22, 0.26, 10, 1, true).translate(x, y + 0.13, z),
        new THREE.TorusGeometry(0.34, 0.03, 6, 14).rotateX(Math.PI / 2).translate(x, y + 0.26, z),
        new THREE.CylinderGeometry(0.06, 0.1, 0.1, 8).translate(x, y + 0.02, z),
      ];
      for (const p of parts) this._push('iron', p, 1);
      const coal = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.1, 10), this.M.coal);
      coal.position.set(x, y + 0.2, z);
      this.group.add(coal);
      for (let k = 0; k < 2; k++) {
        const f = new THREE.Mesh(flameGeo, makeFlameMaterial());
        f.material.uniforms.uHeat.value = 0.55;
        f.position.set(x + rand(-0.08, 0.08), y + 0.2, z + rand(-0.08, 0.08));
        f.scale.set(rand(0.4, 0.55), rand(0.6, 0.85), 1);
        f.renderOrder = 7;
        f.frustumCulled = false;
        this.group.add(f);
        this.flames.push(f);
      }
      this.emberSources = this.emberSources || [];
      this.emberSources.push(new THREE.Vector3(x, y + 0.4, z));
      const light = new THREE.PointLight(0xff8a3a, 5.5, 20, 1.25);
      light.position.set(Math.cos(a) * (R - 1.2), y + 0.5, Math.sin(a) * (R - 1.2));
      scene.add(light);
      this.lights.push({ light, base: 5.5, ph: Math.random() * 10 });
    }
    this.finalize();
  }

  // flame halos in the rainy air, low drifting mist
  buildAtmosphere() {
    const tex = this.game.textures.soft;
    this.halos = [];
    for (const src of this.emberSources || []) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(0.9, 0.38, 0.12), transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.position.copy(src).setY(src.y + 0.2);
      sp.scale.setScalar(2.4);
      sp.renderOrder = 6;
      this.group.add(sp);
      this.halos.push(sp);
    }
    const mistMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uR: { value: ARENA_R + 0.4 } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        uniform float uTime; uniform float uR; varying vec3 vW;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        float fbm(vec2 p){ float a=0.5,s=0.0; for(int i=0;i<4;i++){ s+=a*n(p); p*=2.1; a*=0.5; } return s; }
        void main(){
          vec2 p = vW.xz * 0.18 + vec2(uTime * 0.03, uTime * 0.017) + vW.y;
          float m = smoothstep(0.35, 0.85, fbm(p));
          float edge = smoothstep(uR, uR * 0.55, length(vW.xz));
          gl_FragColor = vec4(vec3(0.32, 0.37, 0.46), m * 0.055 * (0.4 + 0.6 * edge));
        }`,
    });
    this.mistMat = mistMat;
    for (const y of [0.12, 0.38, 0.7]) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(ARENA_R + 0.4, 48).rotateX(-Math.PI / 2), mistMat);
      m.position.y = y;
      m.renderOrder = 4;
      this.group.add(m);
      if (this.game.reflection) this.game.reflection.hidden.push(m);
    }
  }

  breakObject() {}

  openGate(boss = false) {
    for (const g of this.gates) if (g.big === boss) g.target = 1;
    this.game.audio.play('gate', { pos: new THREE.Vector3(0, 2, -ARENA_R) , volume: 0.8 });
  }
  // raise a regular gate briefly (enemy entrance)
  pulseGate(pos) {
    let best = null, bd = 1e9;
    for (const g of this.gates) {
      if (g.big) continue;
      const d = Math.hypot(Math.cos(g.a) * ARENA_R - pos.x, Math.sin(g.a) * ARENA_R - pos.z);
      if (d < bd) { bd = d; best = g; }
    }
    if (best) { best.target = 1; best.closeAt = 2.5; }
  }

  update(dt, t) {
    for (const f of this.flames) f.material.uniforms.uTime.value = t;
    if (this.mistMat) this.mistMat.uniforms.uTime.value = t;
    // embers drifting up from every brazier
    const fx = this.game.fx;
    if (fx && dt > 0) for (const src of this.emberSources || []) {
      if (Math.random() < dt * 7) fx.embers.spawn(src.x + rand(-0.15, 0.15), src.y, src.z + rand(-0.15, 0.15), rand(-0.3, 0.3) + 0.4, rand(1.0, 2.2), rand(-0.3, 0.3) + 0.25, 4, 1.4, 0.25, 1, rand(0.006, 0.013), rand(1.2, 2.4), -0.4, 0.6);
    }
    if (this.halos) for (let i = 0; i < this.halos.length; i++) this.halos[i].material.opacity = 0.15 + Math.sin(t * 9 + i * 1.7) * 0.03;
    for (const L of this.lights) {
      const fl = 0.85 + Math.sin(t * 13 + L.ph) * 0.05 + Math.sin(t * 7.3 + L.ph * 2) * 0.07;
      L.light.intensity = L.base * fl;
    }
    for (const k of ['clothRed', 'clothDark', 'clothTan']) {
      const u = this.M[k].userData.uniforms.uTime;
      if (u) u.value = t;
    }
    let maxOpen = 0;
    for (const g of this.gates) {
      if (g.closeAt !== undefined) { g.closeAt -= dt; if (g.closeAt <= 0) { g.target = 0; g.closeAt = undefined; } }
      g.open += Math.sign(g.target - g.open) * Math.min(Math.abs(g.target - g.open), dt / (g.big ? 3 : 0.8));
      const e = g.open * g.open * (3 - 2 * g.open);
      g.mesh.position.y = e * (g.h - 0.3);
      if (g.big) maxOpen = g.open;
    }
    this.gateOpen = maxOpen;
  }
}

function strip(g) {
  let geo = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo;
}
function worldUV(geo, s) {
  const p = geo.attributes.position;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const N = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const nx = Math.abs(N.getX(i)), ny = Math.abs(N.getY(i)), nz = Math.abs(N.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = p.getX(i); v = p.getZ(i); }
    else if (nx >= nz) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u * s; uv[i * 2 + 1] = v * s;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
