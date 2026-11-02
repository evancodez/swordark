import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Render pipeline: scene (MSAA + depth) -> ink outlines -> bloom -> grade/tonemap/fx -> screen.

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const INK_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear, uFar, uInk, uTime;
uniform vec3 uInkColor;
varying vec2 vUv;

float linZ(vec2 uv){
  float d = texture2D(tDepth, uv).x;
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }

void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  float z0 = linZ(vUv);
  if (z0 > uFar * 0.98) { gl_FragColor = vec4(col, 1.0); return; }
  // pen "boil": lines jitter a little a few times per second
  float boil = floor(uTime * 9.0);
  vec2 jit = (vec2(n2(vUv*90.0 + boil), n2(vUv*90.0 - boil + 7.0)) - 0.5) * 0.9;
  float w = mix(1.5, 0.7, smoothstep(3.0, 45.0, z0));
  vec2 o = w / uRes;
  vec2 uv = vUv + jit / uRes;
  float i0 = 1.0 / z0;
  float il = 1.0 / linZ(uv - vec2(o.x, 0.0));
  float ir = 1.0 / linZ(uv + vec2(o.x, 0.0));
  float iu = 1.0 / linZ(uv + vec2(0.0, o.y));
  float id = 1.0 / linZ(uv - vec2(0.0, o.y));
  float ia = 1.0 / linZ(uv + o);
  float ib = 1.0 / linZ(uv - o);
  float ic = 1.0 / linZ(uv + vec2(o.x, -o.y));
  float idd = 1.0 / linZ(uv + vec2(-o.x, o.y));
  float lap = (il + ir + iu + id - 4.0 * i0) + 0.5 * (ia + ib + ic + idd - 4.0 * i0);
  float rel = lap / i0;
  // foreground side of silhouettes gets the heavy line, creases a lighter one
  float sil = smoothstep(0.06, 0.22, -rel);
  float crease = smoothstep(0.035, 0.12, rel) * 0.55;
  float e = max(sil, crease);
  // break the line up like pen strokes
  float breakup = smoothstep(0.15, 0.55, n2(vUv * vec2(uRes.x, uRes.y) * 0.035 + boil * 3.1));
  e *= mix(0.55, 1.0, breakup);
  e *= 1.0 - smoothstep(30.0, 70.0, z0) * 0.7;
  col = mix(col, uInkColor * (0.4 + 0.6 * dot(col, vec3(0.3))), clamp(e * uInk, 0.0, 0.92));
  gl_FragColor = vec4(col, 1.0);
}`;

const FINAL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform vec2 uRes;
uniform float uTime, uExposure, uSat, uContrast, uVignette, uGrain, uCA, uDamage, uLowHealth, uSlow, uFlash, uBlur, uFade, uRedFlash;
uniform vec2 uBlurCenter;
varying vec2 vUv;

vec3 aces(vec3 x){ const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0); }
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
float h21(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main(){
  vec2 uv = vUv;
  vec2 dir = uv - 0.5;
  float r2 = dot(dir, dir);
  vec3 col;
  float ca = uCA * (0.3 + r2 * 2.5);
  if (uBlur > 0.001) {
    vec3 acc = vec3(0.0);
    vec2 bd = (uv - uBlurCenter) * uBlur * 0.12;
    for (int i = 0; i < 10; i++) {
      float t = float(i) / 9.0;
      vec2 suv = uv - bd * t;
      acc += vec3(texture2D(tColor, suv + dir*ca).r, texture2D(tColor, suv).g, texture2D(tColor, suv - dir*ca).b);
    }
    col = acc / 10.0;
  } else {
    col = vec3(texture2D(tColor, uv + dir * ca).r, texture2D(tColor, uv).g, texture2D(tColor, uv - dir * ca).b);
  }
  col *= uExposure;
  col = aces(col);
  col = toSRGB(col);

  // Grade: restrained palette, blood + fire keep their saturation.
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float ratio = max(col.g, col.b) / max(col.r, 1e-3);
  float red = (1.0 - smoothstep(0.12, 0.42, ratio)) * smoothstep(0.03, 0.12, col.r);
  float sat = mix(uSat, 1.12, red);
  sat = mix(sat, red * 1.4, uSlow * 0.85);
  col = mix(vec3(l), col, sat);
  // split tone: teal shadows, warm highlights
  col += vec3(-0.015, 0.008, 0.03) * (1.0 - smoothstep(0.0, 0.45, l));
  col += vec3(0.025, 0.008, -0.02) * smoothstep(0.55, 1.0, l);
  // contrast
  col = clamp(col, 0.0, 1.0);
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);

  // lightning / impact flash
  col += vec3(0.75, 0.85, 1.0) * uFlash;
  col = mix(col, vec3(0.6, 0.02, 0.02), uRedFlash * 0.35 * smoothstep(0.05, 0.5, r2 * 2.0));

  // vignette
  float vig = 1.0 - smoothstep(0.15, 0.85, r2 * (1.6 + uSlow * 0.8));
  col *= mix(1.0 - uVignette, 1.0, vig);

  // damage / low health edges
  float edge = smoothstep(0.12, 0.5, r2);
  float pulse = 0.65 + 0.35 * sin(uTime * 6.0);
  col = mix(col, vec3(0.35, 0.0, 0.0), edge * clamp(uDamage + uLowHealth * pulse * 0.6, 0.0, 0.85));

  // film grain
  float g = h21(uv * uRes + fract(uTime * 37.0) * 100.0) - 0.5;
  col += g * uGrain * (1.0 - l * 0.5);

  col *= 1.0 - uFade;
  gl_FragColor = vec4(col, 1.0);
}`;

export class Pipeline {
  constructor(canvas) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.setClearColor(0x05070a, 1);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer = r;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);

    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture: new THREE.DepthTexture(4, 4),
    });
    this.sceneRT.depthTexture.format = THREE.DepthFormat;
    this.sceneRT.depthTexture.type = THREE.UnsignedIntType;
    this.inkRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });

    this.inkMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2() },
        uNear: { value: 0.1 }, uFar: { value: 200 }, uInk: { value: 1 }, uTime: { value: 0 },
        uInkColor: { value: new THREE.Color(0.012, 0.01, 0.018) },
      },
      vertexShader: VERT, fragmentShader: INK_FRAG, depthTest: false, depthWrite: false,
    });
    this.finalMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, uRes: { value: new THREE.Vector2() }, uTime: { value: 0 },
        uExposure: { value: 1.25 }, uSat: { value: 0.78 }, uContrast: { value: 0.35 },
        uVignette: { value: 0.55 }, uGrain: { value: 0.045 }, uCA: { value: 0.002 },
        uDamage: { value: 0 }, uLowHealth: { value: 0 }, uSlow: { value: 0 }, uFlash: { value: 0 },
        uBlur: { value: 0 }, uBlurCenter: { value: new THREE.Vector2(0.5, 0.5) }, uFade: { value: 0 }, uRedFlash: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: FINAL_FRAG, depthTest: false, depthWrite: false,
    });
    this.inkQuad = new FullScreenQuad(this.inkMat);
    this.finalQuad = new FullScreenQuad(this.finalMat);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.36, 0.5, 1.05);
    this.fx = this.finalMat.uniforms;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    const W = Math.floor(w * pr), H = Math.floor(h * pr);
    this.sceneRT.setSize(W, H);
    this.inkRT.setSize(W, H);
    this.bloom.setSize(W, H);
    this.inkMat.uniforms.uRes.value.set(W, H);
    this.finalMat.uniforms.uRes.value.set(W, H);
    this.width = w; this.height = h;
    if (this.onResize) this.onResize(w, h);
  }

  render(scene, camera, t) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    const iu = this.inkMat.uniforms;
    iu.tColor.value = this.sceneRT.texture;
    iu.tDepth.value = this.sceneRT.depthTexture;
    iu.uNear.value = camera.near;
    iu.uFar.value = camera.far;
    iu.uTime.value = t;
    r.setRenderTarget(this.inkRT);
    this.inkQuad.render(r);

    this.bloom.render(r, null, this.inkRT, 0, false);

    this.fx.tColor.value = this.inkRT.texture;
    this.fx.uTime.value = t;
    r.setRenderTarget(null);
    this.finalQuad.render(r);
  }
}
