import * as THREE from 'three';

// Shared look: MeshStandardMaterial patched with a cool rim light, and optionally
// a per-character "blood soak" mask driven by hit points in bind space.

const NOISE_GLSL = /* glsl */ `
float bHash(vec3 p){ p = fract(p*0.3183099+0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float bNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(bHash(i+vec3(0,0,0)),bHash(i+vec3(1,0,0)),f.x),
                 mix(bHash(i+vec3(0,1,0)),bHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(bHash(i+vec3(0,0,1)),bHash(i+vec3(1,0,1)),f.x),
                 mix(bHash(i+vec3(0,1,1)),bHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
`;

export const RIM_COLOR = new THREE.Color(0.35, 0.5, 0.75);
// view-space direction of the rim (moon) light, updated every frame by the game
export const RIM_DIR = { value: new THREE.Vector3(0, 1, 0) };

export function patchMaterial(mat, opts = {}) {
  const rim = opts.rim ?? 0.35;
  const blood = !!opts.blood;
  const blade = !!opts.blade;
  const sway = !!opts.sway;
  const surf = !!opts.surf;
  const grime = !!opts.grime;
  mat.userData.uniforms = mat.userData.uniforms || {};
  const U = mat.userData.uniforms;
  U.uRim = { value: RIM_COLOR.clone().multiplyScalar(rim) };
  U.uRimDir = RIM_DIR;
  if (blood) {
    U.uBlood = { value: Array.from({ length: 10 }, () => new THREE.Vector4(0, 0, 0, 0)) };
    U.uBloodColor = { value: new THREE.Color(0.22, 0.005, 0.005) };
    U.uBurn = { value: 0 };
    U.uHitFlash = { value: 0 };
  }
  if (blade) {
    U.uBladeBlood = { value: 0 };
    U.uBladeHeat = { value: 0 };
    U.uBladeLen = { value: 1 };
  }
  if (sway) U.uTime = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vBindPos;
${grime ? 'varying vec3 vGrimeW;' : ''}
${surf ? 'attribute vec2 aSurf; varying vec2 vSurf;' : ''}
${sway ? 'uniform float uTime;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vBindPos = position;
${grime ? 'vGrimeW = (modelMatrix * vec4(transformed, 1.0)).xyz;' : ''}
${surf ? 'vSurf = aSurf;' : ''}
${sway ? `
  float swayW = clamp((position.y) * 0.5, 0.0, 1.0);
  vec4 wpS = modelMatrix * vec4(position,1.0);
  transformed.x += sin(uTime*1.7 + wpS.x*0.6 + wpS.z*0.4) * 0.08 * swayW;
  transformed.z += sin(uTime*2.3 + wpS.z*0.7) * 0.12 * swayW;` : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vBindPos;
uniform vec3 uRim;
uniform vec3 uRimDir;
${grime ? 'varying vec3 vGrimeW;' : ''}
${surf ? 'varying vec2 vSurf;' : ''}
${blood ? 'uniform vec4 uBlood[10]; uniform vec3 uBloodColor; uniform float uBurn; uniform float uHitFlash;' : ''}
${blade ? 'uniform float uBladeBlood; uniform float uBladeHeat; uniform float uBladeLen;' : ''}
${NOISE_GLSL}
float gBloodMask = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
${blood ? `
  {
    float n = bNoise(vBindPos*22.0)*0.6 + bNoise(vBindPos*7.0)*0.4;
    for (int i = 0; i < 10; i++) {
      vec4 b = uBlood[i];
      if (b.w > 0.0) {
        float d = distance(vBindPos, b.xyz);
        // drips run downward in bind space
        float drip = max(0.0, b.y - vBindPos.y) * (0.6 + bNoise(vec3(vBindPos.xz*30.0, 1.0)));
        float dd = min(d, length(vec2(vBindPos.x-b.x, vBindPos.z-b.z))*1.6 + drip*0.25 + max(0.0, vBindPos.y-b.y)*3.0);
        gBloodMask = max(gBloodMask, (1.0 - smoothstep(b.w*0.35, b.w, dd + (n-0.5)*0.09)));
      }
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, uBloodColor * (0.8 + n*0.4), gBloodMask * 0.92);
    diffuseColor.rgb *= 1.0 - uBurn*0.8;
  }` : ''}
${blade ? `
  {
    float t = clamp(vBindPos.z / uBladeLen, 0.0, 1.0);
    float n = bNoise(vBindPos*vec3(60.0,60.0,9.0));
    float m = smoothstep(0.0, 0.2, uBladeBlood*1.15 - t*0.9 - n*0.35) ;
    gBloodMask = m;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.25,0.0,0.0), m*0.9);
  }` : ''}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
${blood ? `
  {
    // woven cloth / worn leather micro-relief so characters don't read as smooth plastic
    float hh = bNoise(vBindPos * 150.0) * 0.55 + bNoise(vBindPos * 420.0) * 0.3 + bNoise(vBindPos * vec3(30.0, 6.0, 30.0)) * 0.4;
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    vec2 dh = vec2(dFdx(hh), dFdy(hh)) * 0.02;
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
    normal = normalize(abs(det) * normal - grad);
  }` : ''}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  ${surf ? 'roughnessFactor = vSurf.y;' : ''}
  ${grime ? `{
    // soot and rain-soaked grime pooling at the base of stonework, streaks running down
    float gn = bNoise(vGrimeW * 1.7) * 0.6 + bNoise(vGrimeW * vec3(9.0, 0.6, 9.0)) * 0.4;
    float base = 1.0 - smoothstep(0.0, 0.9 + gn * 0.6, vGrimeW.y);
    float streak = smoothstep(0.55, 0.85, bNoise(vec3(vGrimeW.x * 3.0, vGrimeW.y * 0.25, vGrimeW.z * 3.0))) * 0.5;
    float g = clamp(base * 0.75 + streak * 0.35, 0.0, 0.85);
    diffuseColor.rgb *= 1.0 - g * 0.6;
    roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.55, g);
  }` : ''}
  roughnessFactor = mix(roughnessFactor, 0.18, gBloodMask);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  ${surf ? 'metalnessFactor = vSurf.x;' : ''}
  metalnessFactor = mix(metalnessFactor, 0.0, gBloodMask);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 nn = normalize(normal);
    float fres = pow(1.0 - clamp(dot(nn, normalize(vViewPosition)), 0.0, 1.0), 3.5);
    float facing = clamp(dot(nn, uRimDir) + 0.15, 0.0, 1.0);
    totalEmissiveRadiance += uRim * fres * facing * 0.22 * (1.0 - gBloodMask*0.6);
    ${blood ? 'totalEmissiveRadiance += vec3(0.55, 0.42, 0.36) * uHitFlash * uHitFlash * (0.2 + fres * 0.8);' : ''}
    ${blade ? `
    float tb = clamp(vBindPos.z / uBladeLen, 0.0, 1.0);
    float fl = bNoise(vec3(vBindPos.z*14.0, vBindPos.x*40.0, 0.0));
    totalEmissiveRadiance += vec3(6.0,1.6,0.25) * uBladeHeat * (0.5 + fl) * smoothstep(0.05, 0.2, tb);` : ''}
  }`);
  };
  mat.customProgramCacheKey = () => `p${blood ? 1 : 0}${blade ? 1 : 0}${sway ? 1 : 0}${surf ? 1 : 0}${grime ? 1 : 0}`;
  return mat;
}

export function makeMaterials(T) {
  const M = {};
  const std = (p, o) => patchMaterial(new THREE.MeshStandardMaterial(p), o);
  M.cobble = std({ map: T.cobble.map, normalMap: T.cobble.normalMap, roughnessMap: T.cobble.roughnessMap, normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity: 1.6 }, { rim: 0.05 });
  M.wall = std({ map: T.wall.map, normalMap: T.wall.normalMap, roughnessMap: T.wall.roughnessMap, normalScale: new THREE.Vector2(1.4, 1.4), envMapIntensity: 0.9 }, { grime: true, rim: 0.12 });
  M.wallDark = std({ map: T.wall.map, normalMap: T.wall.normalMap, roughnessMap: T.wall.roughnessMap, color: 0x8a8890, envMapIntensity: 0.7 }, { grime: true, rim: 0.12 });
  M.trim = std({ map: T.wall.map, normalMap: T.wall.normalMap, color: 0xb8b2a8, roughness: 0.7, envMapIntensity: 0.6 }, { grime: true, rim: 0.2 });
  M.wood = std({ map: T.wood.map, normalMap: T.wood.normalMap, roughnessMap: T.wood.roughnessMap, envMapIntensity: 0.6 }, { rim: 0.15 });
  M.woodDark = std({ map: T.wood.map, normalMap: T.wood.normalMap, color: 0x6a5a4c, roughness: 0.8, envMapIntensity: 0.5 }, { rim: 0.15 });
  M.roof = std({ map: T.roof.map, normalMap: T.roof.normalMap, roughnessMap: T.roof.roughnessMap, envMapIntensity: 1 }, { rim: 0.1 });
  M.plaster = std({ map: T.plaster.map, normalMap: T.plaster.normalMap, roughness: 0.9 }, { rim: 0.1 });
  M.iron = std({ color: 0x3a3a40, map: T.metal.map, roughnessMap: T.metal.roughnessMap, metalness: 0.85, roughness: 0.45, envMapIntensity: 1.2 }, { rim: 0.2 });
  M.brass = std({ color: 0xb08040, map: T.metal.map, metalness: 0.9, roughness: 0.35, envMapIntensity: 1.4 }, { rim: 0.2 });
  M.clothRed = std({ color: 0x6a1010, map: T.cloth.map, normalMap: T.cloth.normalMap, roughness: 0.95, side: THREE.DoubleSide }, { rim: 0.25, sway: true });
  M.clothDark = std({ color: 0x2a3038, map: T.cloth.map, normalMap: T.cloth.normalMap, roughness: 0.95, side: THREE.DoubleSide }, { rim: 0.25, sway: true });
  M.clothTan = std({ color: 0x8a7050, map: T.cloth.map, normalMap: T.cloth.normalMap, roughness: 0.95, side: THREE.DoubleSide }, { rim: 0.2, sway: true });
  M.hay = std({ color: 0x9a8040, map: T.cloth.map, roughness: 1 }, { rim: 0.15 });
  M.statue = std({ color: 0x8c9294, map: T.wall.map, normalMap: T.wall.normalMap, roughness: 0.6, envMapIntensity: 1.2 }, { rim: 0.35 });
  M.puddle = new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.2, metalness: 0.0, envMapIntensity: 3, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  M.fire = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.6, 0.4), toneMapped: false });
  M.glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.8, 0.8), toneMapped: false });
  M.coal = std({ color: 0x1a1210, emissive: new THREE.Color(0.9, 0.18, 0.02), emissiveIntensity: 1, roughness: 0.9 }, { rim: 0 });
  M.candle = std({ color: 0xd8ccb0, roughness: 0.6 }, { rim: 0.2 });
  M.leaves = std({ color: 0x1a2418, roughness: 0.9, side: THREE.DoubleSide }, { rim: 0.2, sway: true });
  M.bark = std({ color: 0x2a2420, map: T.wood.map, roughness: 0.95 }, { rim: 0.15 });
  M.rope = std({ color: 0x5a4a38, roughness: 1 }, { rim: 0.1 });
  return M;
}
