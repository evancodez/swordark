import * as THREE from 'three';

// All textures are generated on canvas at startup — no art files.
// Each generator produces color (sRGB), and optionally a height map that we turn into normals + roughness.

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Seeded RNG so textures are stable between loads
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tileable value noise field
function noiseField(size, cells, r) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x / size) * cells, fy = (y / size) * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[(iy % cells) * cells + (ix % cells)];
    const b = g[(iy % cells) * cells + ((ix + 1) % cells)];
    const c = g[((iy + 1) % cells) * cells + (ix % cells)];
    const d = g[((iy + 1) % cells) * cells + ((ix + 1) % cells)];
    out[y * size + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  }
  return out;
}
function fbm(size, seed, octaves = 5, base = 4) {
  const r = rng(seed);
  const out = new Float32Array(size * size);
  let amp = 0.5, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = noiseField(size, base << o, r);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function heightToNormal(height, size, strength) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const l = height[y * size + ((x - 1 + size) % size)];
    const r = height[y * size + ((x + 1) % size)];
    const u = height[((y - 1 + size) % size) * size + x];
    const d = height[((y + 1) % size) * size + x];
    let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    const i = (y * size + x) * 4;
    img.data[i] = (nx * 0.5 + 0.5) * 255;
    img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function grayCanvas(values, size, map) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(0, Math.min(255, map(values[i], i) * 255));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function tex(c, srgb, repeat = 1) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// Generic: build a texture set from a function that fills color + height arrays.
function buildSet(size, seed, fill, normalStrength = 6, roughMap) {
  const col = new Float32Array(size * size * 3);
  const h = new Float32Array(size * size);
  const wet = new Float32Array(size * size); // 1 = puddle / wet
  fill({ size, col, h, wet, r: rng(seed), seed });
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    img.data[i * 4] = Math.max(0, Math.min(255, col[i * 3] * 255));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, col[i * 3 + 1] * 255));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, col[i * 3 + 2] * 255));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const normal = heightToNormal(h, size, normalStrength);
  const rough = grayCanvas(h, size, roughMap || ((v, i) => 0.85 - wet[i] * 0.7));
  return { map: tex(c, true), normalMap: tex(normal, false), roughnessMap: tex(rough, false) };
}

// Voronoi helper (tileable) returning F1, F2 distances and cell id
function voronoi(size, points) {
  const n = points.length;
  const F1 = new Float32Array(size * size), F2 = new Float32Array(size * size), id = new Int32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let d1 = 1e9, d2 = 1e9, best = 0;
    const px = x / size, py = y / size;
    for (let k = 0; k < n; k++) {
      let dx = Math.abs(px - points[k][0]); dx = Math.min(dx, 1 - dx);
      let dy = Math.abs(py - points[k][1]); dy = Math.min(dy, 1 - dy);
      dx *= points[k][2] || 1;
      const d = dx * dx + dy * dy;
      if (d < d1) { d2 = d1; d1 = d; best = k; } else if (d < d2) d2 = d;
    }
    const i = y * size + x;
    F1[i] = Math.sqrt(d1); F2[i] = Math.sqrt(d2); id[i] = best;
  }
  return { F1, F2, id };
}

export function makeTextures() {
  const T = {};

  // Wet cobblestones with puddles
  T.cobble = buildSet(512, 11, ({ size, col, h, wet, r }) => {
    const pts = [];
    for (let gy = 0; gy < 9; gy++) for (let gx = 0; gx < 9; gx++)
      pts.push([(gx + 0.15 + r() * 0.7) / 9, (gy + 0.15 + r() * 0.7) / 9]);
    const v = voronoi(size, pts);
    const n = fbm(size, 5, 5, 4);
    const puddle = fbm(size, 9, 4, 8);
    const tint = pts.map(() => [0.85 + r() * 0.3, r()]);
    for (let i = 0; i < size * size; i++) {
      const edge = v.F2[i] - v.F1[i];
      const stone = Math.min(1, edge * 22);
      const bump = Math.pow(stone, 0.6) * (0.75 + n[i] * 0.4);
      const t = tint[v.id[i]];
      const pw = Math.max(0, Math.min(1, (puddle[i] - 0.6) * 5)) * 0.6;
      h[i] = bump * (1 - pw * 0.85) + pw * 0.55;
      wet[i] = Math.max(pw, (1 - stone) * 0.25);
      let base = (0.26 + n[i] * 0.16) * t[0] * (0.5 + stone * 0.5);
      const moss = Math.max(0, (1 - stone) - 0.4) * (n[i] > 0.55 ? 1 : 0.2);
      col[i * 3] = base * (0.92 + t[1] * 0.1) - moss * 0.05;
      col[i * 3 + 1] = base * 0.95 + moss * 0.04;
      col[i * 3 + 2] = base * (1.0 + t[1] * 0.08);
      // puddles darken
      col[i * 3] *= 1 - pw * 0.55; col[i * 3 + 1] *= 1 - pw * 0.55; col[i * 3 + 2] *= 1 - pw * 0.5;
    }
  }, 7);

  // Large cut stone blocks for walls
  T.wall = buildSet(512, 21, ({ size, col, h, wet, r }) => {
    const n = fbm(size, 22, 5, 4);
    const n2 = fbm(size, 23, 3, 8);
    const rows = 6;
    const rowH = size / rows;
    const streak = fbm(size, 29, 3, 2);
    const offsets = [], widths = [];
    for (let ry = 0; ry < rows; ry++) {
      offsets.push(r());
      const ws = [];
      let acc = 0;
      while (acc < 1) { const w = 0.22 + r() * 0.25; ws.push(Math.min(w, 1 - acc)); acc += w; }
      widths.push(ws);
    }
    for (let y = 0; y < size; y++) {
      const ry = Math.floor(y / rowH);
      const fy = (y % rowH) / rowH;
      for (let x = 0; x < size; x++) {
        let fx = (x / size + offsets[ry]) % 1;
        let acc = 0, bi = 0, bx = 0;
        const ws = widths[ry];
        for (bi = 0; bi < ws.length; bi++) { if (fx < acc + ws[bi]) { bx = (fx - acc) / ws[bi]; break; } acc += ws[bi]; }
        const ex = Math.min(bx, 1 - bx) * ws[Math.min(bi, ws.length - 1)] * size;
        const ey = Math.min(fy, 1 - fy) * rowH;
        const e = Math.min(ex, ey);
        const i = y * size + x;
        const mortar = e < 3 + n2[i] * 3;
        const chip = n2[i] > 0.7 ? (n2[i] - 0.7) * 2 : 0;
        const blockTone = 0.8 + ((bi * 7 + ry * 13) % 5) * 0.06;
        h[i] = mortar ? 0.1 : Math.min(1, e / 10) * 0.6 + 0.4 - chip * 0.4 + n[i] * 0.15;
        const sv = streak[i] * (1 - fy * 0.3);
        wet[i] = mortar ? 0.4 : sv * 0.35;
        let base = mortar ? 0.12 : (0.3 + n[i] * 0.18) * blockTone;
        base *= 1 - sv * 0.25;
        col[i * 3] = base * 0.97;
        col[i * 3 + 1] = base * 0.96;
        col[i * 3 + 2] = base * 1.02;
      }
    }
  }, 5);

  // Wood planks
  T.wood = buildSet(256, 31, ({ size, col, h, wet, r }) => {
    const n = fbm(size, 32, 4, 4);
    const planks = 4;
    const pTone = Array.from({ length: planks }, () => 0.8 + r() * 0.4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = Math.floor((x / size) * planks);
      const fx = ((x / size) * planks) % 1;
      const grain = Math.sin((y / size) * 60 + n[y * size + x] * 14 + p * 3) * 0.5 + 0.5;
      const gap = fx < 0.04 || fx > 0.96;
      const i = y * size + x;
      h[i] = gap ? 0 : 0.6 + grain * 0.2;
      wet[i] = 0.1;
      const t = pTone[p] * (gap ? 0.3 : 1);
      const v = (0.26 + grain * 0.1 + n[i] * 0.08) * t;
      col[i * 3] = v * 1.25; col[i * 3 + 1] = v * 0.92; col[i * 3 + 2] = v * 0.62;
    }
  }, 4, (v) => 0.75 - v * 0.1);

  // Roof tiles
  T.roof = buildSet(256, 41, ({ size, col, h, wet }) => {
    const n = fbm(size, 42, 4, 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const row = Math.floor((y / size) * 8);
      const fy = ((y / size) * 8) % 1;
      const fx = ((x / size) * 6 + (row % 2) * 0.5) % 1;
      const curve = Math.sin(fx * Math.PI);
      const i = y * size + x;
      h[i] = curve * 0.6 + fy * 0.4;
      wet[i] = 0.3;
      const v = (0.18 + curve * 0.08 + n[i] * 0.08) * (0.6 + fy * 0.4);
      col[i * 3] = v * 1.35; col[i * 3 + 1] = v * 0.75; col[i * 3 + 2] = v * 0.6;
    }
  }, 5);

  // Plaster with exposed brick
  T.plaster = buildSet(256, 51, ({ size, col, h, wet }) => {
    const n = fbm(size, 52, 5, 4);
    const peel = fbm(size, 53, 4, 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const exposed = peel[i] > 0.6;
      if (exposed) {
        const row = Math.floor((y / size) * 16);
        const fx = ((x / size) * 8 + (row % 2) * 0.5) % 1, fy = ((y / size) * 16) % 1;
        const m = fx < 0.06 || fy < 0.12;
        h[i] = m ? 0.1 : 0.4;
        const v = m ? 0.15 : 0.28 + n[i] * 0.1;
        col[i * 3] = v * 1.3; col[i * 3 + 1] = v * 0.8; col[i * 3 + 2] = v * 0.65;
      } else {
        h[i] = 0.7 + n[i] * 0.1;
        const v = 0.42 + n[i] * 0.14 - Math.max(0, peel[i] - 0.5) * 0.6;
        col[i * 3] = v * 0.98; col[i * 3 + 1] = v * 0.95; col[i * 3 + 2] = v * 0.88;
      }
      wet[i] = 0.15;
    }
  }, 4);

  // Cloth weave (tinted by material color)
  T.cloth = buildSet(128, 61, ({ size, col, h, wet }) => {
    const n = fbm(size, 62, 3, 8);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const wv = (Math.sin(x * 1.6) * Math.sin(y * 1.6) * 0.5 + 0.5) * 0.4;
      h[i] = wv * 0.5 + n[i] * 0.3;
      wet[i] = 0;
      const v = 0.75 + wv * 0.15 + n[i] * 0.15;
      col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
    }
  }, 2, () => 0.95);

  // Brushed / pitted metal
  T.metal = buildSet(128, 71, ({ size, col, h, wet }) => {
    const n = fbm(size, 72, 5, 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      h[i] = n[i] * 0.3;
      wet[i] = 0;
      const v = 0.6 + n[i] * 0.3 + Math.sin(y * 1.7 + n[i] * 4) * 0.03;
      col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
    }
  }, 2, (v) => 0.35 + v * 0.5);

  // Soft particle sprite
  {
    const c = canvas(64);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    T.soft = new THREE.CanvasTexture(c);
  }

  // Blood splat atlas: 4x2 variants, white mask in alpha
  T.splat = makeSplatAtlas();
  return T;
}

function makeSplatAtlas() {
  const S = 256, cols = 4, rows = 2;
  const c = canvas(S * cols, S * rows);
  const ctx = c.getContext('2d');
  const r = rng(99);
  for (let k = 0; k < cols * rows; k++) {
    const ox = (k % cols) * S, oy = Math.floor(k / cols) * S;
    const cx = ox + S / 2, cy = oy + S / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, S, S);
    ctx.clip();
    ctx.fillStyle = '#fff';
    const elong = k >= 4; // directional splats
    // main blob
    const blobs = 6 + Math.floor(r() * 6);
    for (let b = 0; b < blobs; b++) {
      const a = r() * Math.PI * 2;
      const d = r() * S * 0.12;
      const rad = S * (0.06 + r() * 0.12);
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * d * (elong ? 2.2 : 1), cy + Math.sin(a) * d, rad * (elong ? 1.6 : 1), rad, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // spikes / streaks
    const spikes = 10 + Math.floor(r() * 14);
    for (let s = 0; s < spikes; s++) {
      const a = elong ? (r() - 0.5) * 0.9 : r() * Math.PI * 2;
      const len = S * (0.12 + r() * (elong ? 0.36 : 0.26));
      const w = 2 + r() * 6;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, -w);
      ctx.quadraticCurveTo(len * 0.6, -w * 0.4, len, 0);
      ctx.quadraticCurveTo(len * 0.6, w * 0.4, 0, w);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(len + 3 + r() * 6, 0, w * (0.4 + r() * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // satellite droplets
    for (let s = 0; s < 40; s++) {
      const a = elong ? (r() - 0.5) * 1.2 : r() * Math.PI * 2;
      const d = S * (0.15 + r() * 0.33);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0.6 + r() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  // soft-edge by blurring alpha slightly
  const blurred = canvas(S * cols, S * rows);
  const bctx = blurred.getContext('2d');
  bctx.filter = 'blur(1.2px)';
  bctx.drawImage(c, 0, 0);
  const t = new THREE.CanvasTexture(blurred);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.userData = { cols, rows };
  return t;
}
