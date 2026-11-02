import * as THREE from 'three';

// Planar reflection of the scene in the wet arena floor (y = 0). Rendered at reduced resolution
// with mipmaps so rough stone gets a blurry sheen and puddles get a crisp mirror.
export class FloorReflection {
  constructor(scale = 0.5) {
    this.scale = scale;
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 0 });
    this.rt.texture.generateMipmaps = true;
    this.rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.cam = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4();
    this.hidden = [];   // objects to hide while rendering the reflection (the floor itself, decals)
    this._n = new THREE.Vector3(0, 1, 0);
    this._p = new THREE.Vector3();
    this._view = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._q = new THREE.Vector4();
  }

  setSize(w, h) {
    this.rt.setSize(Math.max(2, Math.floor(w * this.scale)), Math.max(2, Math.floor(h * this.scale)));
  }

  update(renderer, scene, camera) {
    const n = this._n, P = this._p.set(0, 0, 0);
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    if (camPos.y <= 0.01) return;
    // mirror the camera through the floor plane (y = 0)
    const view = this._view.set(camPos.x, -camPos.y, camPos.z);
    this._rot.extractRotation(camera.matrixWorld);
    const look = this._look.set(0, 0, -1).applyMatrix4(this._rot).add(camPos);
    const target = this._target.set(look.x, -look.y, look.z);
    const vc = this.cam;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(n);
    vc.lookAt(target);
    vc.far = camera.far;
    vc.near = camera.near;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    // oblique near plane: clip everything below the floor
    this._plane.setFromNormalAndCoplanarPoint(n, P).applyMatrix4(vc.matrixWorldInverse);
    const clip = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const pm = vc.projectionMatrix.elements;
    const q = this._q;
    q.x = (Math.sign(clip.x) + pm[8]) / pm[0];
    q.y = (Math.sign(clip.y) + pm[9]) / pm[5];
    q.z = -1;
    q.w = (1 + pm[10]) / pm[14];
    clip.multiplyScalar(2 / clip.dot(q));
    pm[2] = clip.x; pm[6] = clip.y; pm[10] = clip.z + 1 - 0.003; pm[14] = clip.w;

    for (const o of this.hidden) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.rt);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.render(scene, vc);
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevTarget);
    for (const o of this.hidden) o.visible = true;
  }
}

// Patch a MeshStandardMaterial so it adds the planar reflection, strongest where the stone is wet.
export function addReflection(mat, refl, strength = 1) {
  const U = mat.userData.uniforms || (mat.userData.uniforms = {});
  U.tReflect = { value: refl.rt.texture };
  U.uReflMat = { value: refl.textureMatrix };
  U.uReflStr = { value: strength };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uReflMat;\nvarying vec4 vReflUv;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvReflUv = uReflMat * (modelMatrix * vec4(transformed, 1.0));');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tReflect;\nuniform float uReflStr;\nvarying vec4 vReflUv;')
      .replace('#include <opaque_fragment>', `
  {
    vec2 ruv = vReflUv.xy / vReflUv.w;
    ruv += normal.xy * 0.035;                     // ripple from the normal map
    float wet = clamp(1.0 - roughnessFactor * 1.25, 0.0, 1.0);
    float lod = pow(roughnessFactor, 1.5) * 6.0;
    vec3 refl = textureLod(tReflect, ruv, lod).rgb;
    float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
    float fres = 0.06 + 0.94 * pow(1.0 - ndv, 4.0);
    outgoingLight += refl * fres * (0.35 + 1.4 * wet) * uReflStr;
  }
  #include <opaque_fragment>`);
  };
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
  mat.customProgramCacheKey = () => prevKey() + 'refl';
  mat.needsUpdate = true;
  return mat;
}
