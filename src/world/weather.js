import * as THREE from 'three';

// GPU rain (streaks + splashes around the camera), sky dome with moon and clouds, flame shader.

const RAIN_VERT = /* glsl */ `
attribute vec2 corner;
attribute vec3 iSeed;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uWind;
uniform float uBox;
varying float vA;
varying vec2 vUv;
void main(){
  float speed = 13.0 + iSeed.y * 5.0;
  vec3 vel = vec3(uWind.x, -speed, uWind.z);
  vec3 p = iSeed * uBox + vel * uTime;
  p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  p.y = mod(p.y - uCam.y + 6.0, 16.0) - 6.0 + uCam.y;
  vec4 h = viewMatrix * vec4(p, 1.0);
  vec4 t = viewMatrix * vec4(p - vel * 0.05, 1.0);
  vec2 d = h.xy - t.xy; float l = length(d);
  vec2 dir = l > 1e-5 ? d / l : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);
  vec3 q = mix(t.xyz, h.xyz, corner.y);
  q.xy += side * corner.x * 0.004;
  float dist = length(h.xyz);
  vA = smoothstep(0.5, 2.5, dist) * (1.0 - smoothstep(14.0, 22.0, dist));
  vUv = corner;
  gl_Position = projectionMatrix * vec4(q, 1.0);
}`;
const RAIN_FRAG = /* glsl */ `
uniform float uFlash;
varying float vA; varying vec2 vUv;
void main(){
  float a = (1.0 - abs(vUv.x)) * vA * 0.11 * (0.5 + vUv.y);
  gl_FragColor = vec4(vec3(0.55, 0.62, 0.75) * (1.0 + uFlash * 6.0), a);
}`;

const SPLASH_VERT = /* glsl */ `
attribute vec2 corner;
attribute vec3 iSeed;
uniform float uTime;
uniform vec3 uCam;
varying float vLife;
varying vec2 vUv;
varying float vVis;
void main(){
  float rate = 1.6 + iSeed.z;
  float cyc = uTime * rate + iSeed.x * 17.0;
  float life = fract(cyc);
  float id = floor(cyc);
  vec2 rnd = fract(sin(vec2(id * 12.9898 + iSeed.x * 78.233, id * 39.346 + iSeed.y * 11.135)) * 43758.5453);
  vec2 xz = uCam.xz + (rnd - 0.5) * 22.0;
  vVis = (abs(xz.x) < 11.3 && xz.y > -31.5 && xz.y < 15.8) ? 1.0 : 0.0;
  float s = 0.02 + life * 0.09;
  vec3 p = vec3(xz.x + corner.x * s, 0.015, xz.y + corner.y * s);
  vLife = life;
  vUv = corner;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const SPLASH_FRAG = /* glsl */ `
varying float vLife; varying vec2 vUv; varying float vVis;
void main(){
  float r = length(vUv);
  float ring = smoothstep(0.75, 0.9, r) * (1.0 - smoothstep(0.9, 1.0, r));
  float a = ring * (1.0 - vLife) * 0.12 * vVis;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.6, 0.68, 0.8), a);
}`;

export class Weather {
  constructor(scene) {
    const N = 4500;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, 0, 1, 0, 1, 1, -1, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) seeds[i] = Math.random();
    g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    g.instanceCount = N;
    this.uniforms = {
      uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector3(2.2, 0, 1.2) },
      uBox: { value: 26 }, uFlash: { value: 0 },
    };
    const m = new THREE.ShaderMaterial({ vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, uniforms: this.uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.rain = new THREE.Mesh(g, m);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 8;
    scene.add(this.rain);

    const SN = 500;
    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    sg.setIndex([0, 2, 1, 0, 3, 2]);
    const ss = new Float32Array(SN * 3);
    for (let i = 0; i < SN * 3; i++) ss[i] = Math.random();
    sg.setAttribute('iSeed', new THREE.InstancedBufferAttribute(ss, 3));
    sg.instanceCount = SN;
    const sm = new THREE.ShaderMaterial({ vertexShader: SPLASH_VERT, fragmentShader: SPLASH_FRAG, uniforms: this.uniforms, transparent: true, depthWrite: false });
    this.splash = new THREE.Mesh(sg, sm);
    this.splash.frustumCulled = false;
    scene.add(this.splash);

    this.nextLightning = 8 + Math.random() * 10;
    this.flash = 0;
    this.flashSeq = [];
  }

  update(dt, t, camPos, onThunder) {
    this.uniforms.uTime.value = t;
    this.uniforms.uCam.value.copy(camPos);
    this.nextLightning -= dt;
    if (this.nextLightning <= 0) {
      this.nextLightning = 14 + Math.random() * 18;
      // double/triple flicker
      const n = 1 + Math.floor(Math.random() * 3);
      let tt = 0;
      for (let i = 0; i < n; i++) { this.flashSeq.push({ at: tt, amp: 0.5 + Math.random() * 0.5 }); tt += 0.06 + Math.random() * 0.12; }
      if (onThunder) setTimeout(onThunder, 500 + Math.random() * 1500);
    }
    for (let i = this.flashSeq.length - 1; i >= 0; i--) {
      const f = this.flashSeq[i];
      f.at -= dt;
      if (f.at <= 0) { this.flash = Math.max(this.flash, f.amp); this.flashSeq.splice(i, 1); }
    }
    this.flash = Math.max(0, this.flash - dt * 6);
    this.uniforms.uFlash.value = this.flash;
    return this.flash;
  }
}

export function makeSky(moonDir) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uMoon: { value: moonDir.clone().normalize() }, uTime: { value: 0 }, uFlash: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uMoon; uniform float uTime; uniform float uFlash;
      varying vec3 vDir;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*n(p); p*=2.03; a*=0.5; } return s; }
      void main(){
        vec3 d = normalize(vDir);
        float y = clamp(d.y, -0.2, 1.0);
        vec3 col = mix(vec3(0.05, 0.065, 0.09), vec3(0.012, 0.016, 0.03), smoothstep(0.0, 0.7, y));
        float m = dot(d, uMoon);
        col += vec3(0.6, 0.7, 0.9) * pow(max(m, 0.0), 60.0) * 0.5;      // halo
        col += vec3(0.25, 0.32, 0.45) * pow(max(m, 0.0), 8.0) * 0.15;
        float disc = smoothstep(0.9993, 0.9996, m);
        float crater = fbm(d.xz * 300.0) * 0.25;
        col = mix(col, vec3(1.6, 1.65, 1.75) * (0.85 - crater), disc);
        // clouds
        vec2 cuv = d.xz / max(0.08, d.y + 0.15) * 1.3 + vec2(uTime * 0.012, uTime * 0.004);
        float c = smoothstep(0.42, 0.85, fbm(cuv));
        vec3 cloudCol = mix(vec3(0.03, 0.035, 0.05), vec3(0.2, 0.22, 0.28), pow(max(m, 0.0), 6.0));
        col = mix(col, cloudCol + uFlash * vec3(0.5, 0.55, 0.7), c * smoothstep(-0.05, 0.25, d.y) * 0.9);
        col += uFlash * vec3(0.12, 0.14, 0.2) * smoothstep(-0.1, 0.5, d.y);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

// Billboarded procedural flame
export function makeFlameMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uSeed: { value: Math.random() * 10 }, uHeat: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        mv.xy += (uv - vec2(0.5, 0.0)) * scale;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uSeed; uniform float uHeat;
      varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      void main(){
        vec2 uv = vUv;
        float t = uTime * 2.2 + uSeed;
        float turb = n(vec2(uv.x * 5.0, uv.y * 4.0 - t * 2.0)) * 0.6 + n(vec2(uv.x * 11.0, uv.y * 9.0 - t * 3.5)) * 0.4;
        float x = (uv.x - 0.5) * 2.0;
        x += (turb - 0.5) * 0.6 * uv.y;
        float width = (1.0 - uv.y) * 0.9 + 0.08;
        float shape = 1.0 - smoothstep(width * 0.55, width, abs(x));
        shape *= smoothstep(0.0, 0.08, uv.y);
        shape *= 1.0 - smoothstep(0.35 + turb * 0.5, 0.98, uv.y);
        float core = shape * (1.0 - smoothstep(0.0, 0.5, uv.y + abs(x) * 0.6));
        vec3 col = vec3(2.2, 0.65, 0.12) * shape + vec3(2.4, 1.5, 0.6) * core;
        float a = clamp(shape, 0.0, 1.0);
        gl_FragColor = vec4(col * a * uHeat, a);
      }`,
  });
}
