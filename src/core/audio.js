// Procedural audio engine: every SFX, the ambience and the music are synthesized with Web Audio.
// No asset files. All public methods are safe no-ops until init() succeeds.

const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : undefined;

const MAX_VOICES = 48;
const CULL_DIST = 45;
const D1 = 36.708;
const NOTE = (semi, oct) => D1 * Math.pow(2, semi / 12 + (oct - 1));
const PHRY = [0, 1, 3, 5, 7, 8, 10];
const MODES = ['explore', 'combat', 'boss', 'boss2', 'silence'];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

let ctx = null;
let master, slowLP, sfxBus, musicBus, ambBus, duckGain, verbIn;
let hasPanner = false;
let nyq = 20000;
const NOISE = {};
const CURVES = {};

let masterVol = 0.9;
const listener = { x: 0, y: 0, z: 0, yaw: 0 };
let slowTarget = 0, slowCur = 0, slowStamp = 0, slowApplied = -1;
let activeVoices = 0;
const nameCounts = Object.create(null);
const warned = new Set();
let errCount = 0;
let resumeAt = -1e9;
let unlocked = false;
let duckEnd = 0, duckDepth = 0;
let ambienceWanted = false;
let musicMode = null;
let musicTarget = 0, musicIntensity = 0;

function report(where, e) {
  if (errCount++ < 12) console.warn(`[audio] ${where}:`, e);
}

const cf = (f) => clamp(f, 10, nyq);

// ---------------------------------------------------------------- buffers & curves

function normRms(d, target) {
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  const k = target / Math.sqrt(s / d.length || 1);
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

// remove the end-to-start jump so looped low-frequency noise doesn't click
function seamless(d) {
  const n = d.length - 1, drift = d[n] - d[0];
  for (let i = 0; i <= n; i++) d[i] -= drift * (i / n);
}

function makeNoise() {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 3);
  const white = ctx.createBuffer(1, len, sr);
  const pink = ctx.createBuffer(1, len, sr);
  const brown = ctx.createBuffer(1, len, sr);
  const w = white.getChannelData(0), p = pink.getChannelData(0), b = brown.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const x = Math.random() * 2 - 1;
    w[i] = x;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    p[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
    b6 = x * 0.115926;
    last = (last + 0.02 * x) / 1.02;
    b[i] = last;
  }
  seamless(p); seamless(b);
  normRms(w, 0.3); normRms(p, 0.3); normRms(b, 0.3);

  // sparse decaying impulses: rain patter, blood droplets, fire crackle, splinters
  const clen = Math.floor(sr * 5);
  const crackle = ctx.createBuffer(1, clen, sr);
  const c = crackle.getChannelData(0);
  let i = 0;
  while (i < clen) {
    i += 1 + Math.floor(-Math.log(1 - Math.random()) * sr / 350);
    const amp = Math.pow(Math.random(), 2.5) * (Math.random() < 0.5 ? -1 : 1);
    const n = 8 + ((Math.random() * 110) | 0);
    for (let j = 0; j < n && i + j < clen; j++) c[i + j] += amp * (Math.random() * 2 - 1) * Math.exp(-j / (n * 0.25));
  }
  let pk = 0;
  for (let j = 0; j < clen; j++) pk = Math.max(pk, Math.abs(c[j]));
  if (pk > 0) for (let j = 0; j < clen; j++) c[j] *= 0.95 / pk;

  NOISE.white = white; NOISE.pink = pink; NOISE.brown = brown; NOISE.crackle = crackle;
}

// short stone-courtyard impulse response: early wall reflections + darkening noise tail
function makeIR(sec) {
  const sr = ctx.sampleRate, len = Math.floor(sr * sec);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      const k = 0.08 + 0.82 * x;
      lp += (Math.random() * 2 - 1 - lp) * (1 - k);
      d[i] = lp * Math.pow(1 - x, 2) * Math.exp(-x * 3);
    }
    const pre = Math.floor(sr * 0.007);
    for (let j = 0; j < pre; j++) d[j] = 0;
    for (let r = 0; r < 12; r++) {
      const at = Math.floor(sr * (0.009 + Math.random() * 0.085));
      d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.75 - r * 0.04);
    }
  }
  return buf;
}

// transparent below ~-2.5 dBFS, smooth saturation for overs up to +6 dB (input pre-scaled by 0.5)
function makeClip() {
  const n = 4096, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2, ax = Math.abs(x);
    c[i] = Math.sign(x) * (ax < 0.75 ? ax : 0.75 + 0.25 * Math.tanh((ax - 0.75) / 0.25));
  }
  return c;
}

function makeCurve(k) {
  const n = 2048, c = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

// ---------------------------------------------------------------- voices

class Voice {
  constructor(name, gain, pan, verb, lp, dest, t0) {
    this.name = name;
    this.nodes = [];
    this.live = 0;
    this.done = false;
    this.end = 0;
    this.timer = 0;
    this.P = 1;
    this.T = 1;
    this.t0 = t0 === undefined ? ctx.currentTime : t0;
    const out = (this.out = this.node(ctx.createGain()));
    out.gain.value = gain;
    let last = out;
    if (lp) {
      const f = this.node(ctx.createBiquadFilter());
      f.type = 'lowpass';
      f.frequency.value = cf(lp);
      last.connect(f);
      last = f;
    }
    if (pan && hasPanner) {
      const p = this.node(ctx.createStereoPanner());
      p.pan.value = clamp(pan, -1, 1);
      last.connect(p);
      last = p;
    }
    last.connect(dest || sfxBus);
    if (verb > 0 && verbIn) {
      const s = this.node(ctx.createGain());
      s.gain.value = verb;
      last.connect(s);
      s.connect(verbIn);
    }
  }
  node(n) {
    this.nodes.push(n);
    return n;
  }
  src(s, t0, t1, offset) {
    this.live++;
    s.onended = () => {
      if (--this.live <= 0) this.free();
    };
    if (offset !== undefined) s.start(t0, offset);
    else s.start(t0);
    s.stop(t1);
    if (t1 > this.end) this.end = t1;
    return s;
  }
  arm() {
    if (this.done) return;
    const ms = Math.max(0, this.end - ctx.currentTime) * 1000 + 700;
    this.timer = setTimeout(() => this.free(), ms);
  }
  free() {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    for (const n of this.nodes) {
      try { n.disconnect(); } catch (e) { /* already gone */ }
    }
    this.nodes.length = 0;
    if (this.name) {
      activeVoices--;
      nameCounts[this.name]--;
    }
  }
}

// ---------------------------------------------------------------- synthesis helpers
// All helper times/durations are nominal seconds relative to the voice start; v.T stretches
// them and v.P scales frequencies (tape-style rate change for opts.rate and slow-mo).

function bq(v, type, f, q = 0.707) {
  const b = v.node(ctx.createBiquadFilter());
  b.type = type;
  b.frequency.value = cf(f);
  b.Q.value = q;
  return b;
}

function gn(v, val = 1) {
  const g = v.node(ctx.createGain());
  g.gain.value = val;
  return g;
}

function shaper(v, name) {
  const w = v.node(ctx.createWaveShaper());
  w.curve = CURVES[name];
  w.oversample = '2x';
  return w;
}

// attack -> (optional fast drop to mid level) -> (optional hold) -> exponential tail
function env(p, t, a, d, peak, mid, hold) {
  const F = 0.0001;
  peak = Math.max(peak, 0.0002);
  if (a > 0.0015) {
    p.setValueAtTime(F, t);
    p.linearRampToValueAtTime(peak, t + a);
  } else {
    p.setValueAtTime(peak, t);
  }
  let tt = t + a, lvl = peak;
  if (mid) {
    lvl = Math.max(peak * mid[0], 0.0002);
    tt += mid[1];
    p.exponentialRampToValueAtTime(lvl, tt);
  }
  if (hold) {
    tt += hold;
    p.setValueAtTime(lvl, tt);
  }
  p.exponentialRampToValueAtTime(F, tt + Math.max(d, 0.005));
  return tt + Math.max(d, 0.005);
}

function sweep(p, t, f0, pts, P, T) {
  p.setValueAtTime(cf(f0 * P), t);
  if (pts) for (const [f, dt] of pts) p.exponentialRampToValueAtTime(cf(f * P), t + Math.max(dt, 0.001) * T);
}

function finish(v, o, src, last, t, offset) {
  const T = v.T;
  if (o.shape) {
    const w = shaper(v, o.shape);
    last.connect(w);
    last = w;
  }
  const g = gn(v, 0);
  const end = env(g.gain, t, (o.a ?? 0.001) * T, (o.d ?? 0.15) * T, o.peak ?? 1, o.mid && [o.mid[0], o.mid[1] * T], (o.hold || 0) * T);
  last.connect(g);
  g.connect(o.dest || v.out);
  v.src(src, t, end + 0.02, offset);
  return g;
}

// filtered noise burst
function nz(v, o) {
  const P = v.P, T = v.T, t = v.t0 + (o.at || 0) * T;
  const s = v.node(ctx.createBufferSource());
  s.buffer = NOISE[o.buf || 'white'];
  s.loop = true;
  const r = (o.rate || 1) * (o.buf === 'crackle' ? P : 1);
  if (r !== 1) s.playbackRate.value = r;
  let last = s, filt = null;
  if (o.type) {
    filt = bq(v, o.type, o.f * P, o.q ?? 1);
    sweep(filt.frequency, t, o.f, o.sw, P, T);
    s.connect(filt);
    last = filt;
  }
  if (o.type2) {
    const f2 = bq(v, o.type2, o.f2 * P, o.q2 ?? 0.707);
    last.connect(f2);
    last = f2;
  }
  const gain = finish(v, o, s, last, t, Math.random() * s.buffer.duration * 0.9);
  return { src: s, filt, gain };
}

// oscillator tone with pitch sweep
function tn(v, o) {
  const P = v.P, T = v.T, t = v.t0 + (o.at || 0) * T;
  const s = v.node(ctx.createOscillator());
  s.type = o.type || 'sine';
  sweep(s.frequency, t, o.f, o.sw, P, T);
  if (o.det) s.detune.value = o.det;
  let last = s;
  if (o.lp) {
    const f = bq(v, 'lowpass', o.lp * P, o.lpq ?? 0.707);
    s.connect(f);
    last = f;
  }
  finish(v, o, s, last, t);
  return s;
}

function lfo(v, param, rate, depth, at, until, type = 'sine') {
  const o = v.node(ctx.createOscillator());
  o.type = type;
  o.frequency.value = rate * v.P;
  const g = gn(v, depth);
  o.connect(g);
  g.connect(param);
  v.src(o, v.t0 + at * v.T, v.t0 + until * v.T);
}

// inharmonic metallic partials: [ratio, amp, decay]
function ring(v, at, f0, parts, peak, dest) {
  for (const [r, amp, d] of parts) {
    tn(v, { f: f0 * r * rnd(0.996, 1.004), at, a: 0.0005, d: d * rnd(0.85, 1.15), peak: peak * amp, mid: [0.45, 0.03], dest });
  }
}

// cluster of tiny noise ticks (bone crunch, splinters)
function cracks(v, n, span, lo, hi, peak, at = 0, dest) {
  for (let i = 0; i < n; i++) {
    nz(v, { type: 'bandpass', f: rnd(lo, hi), q: rnd(2, 6), at: at + span * Math.pow(Math.random(), 1.7), a: 0.0005, d: rnd(0.008, 0.035), peak: peak * rnd(0.4, 1), dest });
  }
}

function bell(v, at, f, pk, dest) {
  for (const [r, a, d] of [[1, 1, 3.2], [2, 0.3, 2.2], [2.76, 0.45, 1.6], [5.4, 0.16, 0.8], [8.93, 0.06, 0.4]]) {
    tn(v, { f: f * r, at, a: 0.002, d, peak: pk * a, dest });
  }
}

const VOWELS = {
  ah: [[730, 1, 7], [1090, 0.5, 9], [2440, 0.18, 12]],
  uh: [[640, 1, 7], [1190, 0.45, 9], [2390, 0.15, 12]],
  oh: [[570, 1, 7], [840, 0.55, 8], [2410, 0.12, 12]],
};

// formant-filtered glottal source (detuned saws + rasp noise, saturated) for grunts/groans/roars
function vocal(v, o) {
  const P = v.P, T = v.T, at = o.at || 0;
  const t = v.t0 + at * T;
  const a = o.a * T, d = o.d * T, hold = (o.hold || 0) * T;
  const end = t + a + hold + d + 0.05;
  const src = gn(v, 1);
  const oscs = [];
  for (const det of [0, 9]) {
    const s = v.node(ctx.createOscillator());
    s.type = 'sawtooth';
    s.detune.value = det;
    sweep(s.frequency, t, o.f0, o.sw, P, T);
    s.connect(src);
    v.src(s, t, end);
    oscs.push(s);
  }
  if (o.sub) {
    const s = v.node(ctx.createOscillator());
    s.type = 'square';
    sweep(s.frequency, t, o.f0 * 0.5, o.sw && o.sw.map(([f, dt]) => [f * 0.5, dt]), P, T);
    const sg = gn(v, 0.35);
    s.connect(sg);
    sg.connect(src);
    v.src(s, t, end);
    oscs.push(s);
  }
  for (const [rate, depth, type] of [[rnd(5, 7), 16, 'sine'], [rnd(11, 17), 9, 'triangle']]) {
    const l = v.node(ctx.createOscillator());
    l.type = type;
    l.frequency.value = rate * P;
    const lg = gn(v, depth);
    l.connect(lg);
    for (const s of oscs) lg.connect(s.detune);
    v.src(l, t, end);
  }
  const n = v.node(ctx.createBufferSource());
  n.buffer = NOISE.pink;
  n.loop = true;
  const ng = gn(v, o.rasp || 0.2);
  n.connect(ng);
  ng.connect(src);
  v.src(n, t, end, Math.random() * 2);

  const sh = shaper(v, o.dist || 'soft');
  src.connect(sh);
  const out = gn(v, 0);
  const A = VOWELS[o.vowel] || VOWELS.ah, B = o.vowel2 ? VOWELS[o.vowel2] : null;
  const k = (o.shift || 1) * P;
  A.forEach(([F, amp, Q], i) => {
    const b = bq(v, 'bandpass', F * k, Q);
    if (B) {
      b.frequency.setValueAtTime(cf(F * k), t);
      b.frequency.linearRampToValueAtTime(cf(B[i][0] * k), t + a + hold + d);
    } else if (i === 0) {
      b.frequency.setValueAtTime(cf(F * k * 0.8), t);
      b.frequency.linearRampToValueAtTime(cf(F * k), t + 0.05 * T);
    }
    const g = gn(v, amp * 2.5);
    sh.connect(b);
    b.connect(g);
    g.connect(out);
  });
  const chest = bq(v, 'lowpass', 360 * P, 0.7);
  const cg = gn(v, 0.3);
  sh.connect(chest);
  chest.connect(cg);
  cg.connect(out);
  env(out.gain, t, a, d, o.peak ?? 1, o.mid && [o.mid[0], o.mid[1] * T], hold);
  const dest = o.dest || v.out;
  if (o.gurgle) {
    const [rate, depth, from] = o.gurgle;
    const gm = gn(v, 1);
    out.connect(gm);
    gm.connect(dest);
    const until = at + o.a + (o.hold || 0) + o.d + 0.05;
    lfo(v, gm.gain, rate, depth, at + from, until);
    lfo(v, gm.gain, rate * 0.53, depth * 0.5, at + from, until, 'triangle');
  } else {
    out.connect(dest);
  }
}

// ---------------------------------------------------------------- SFX recipes

const SFX = Object.create(null);
function def(name, max, verb, gain, fn) {
  SFX[name] = { max, verb, gain, fn };
}

// fast swish: bandpassed noise sweeping up then down, plus a thin edge whistle
def('whoosh_light', 6, 0.05, 1.2, (v) => {
  const dur = rnd(0.15, 0.21), pk = dur * rnd(0.35, 0.55);
  const lo = rnd(450, 700), hi = rnd(2000, 3200), end = rnd(650, 1000);
  nz(v, { type: 'bandpass', q: rnd(1.3, 2.2), f: lo, sw: [[hi, pk], [end, dur]], a: pk, d: dur - pk, peak: 2.4 });
  nz(v, { type: 'bandpass', q: rnd(5, 9), f: lo * 3, sw: [[hi * 2, pk], [end * 2.5, dur]], a: pk, d: (dur - pk) * 0.7, peak: 1.0 });
});

// heavy swing: deeper sweep with low body
def('whoosh_heavy', 6, 0.06, 1, (v) => {
  const dur = rnd(0.32, 0.4), pk = dur * rnd(0.4, 0.55);
  nz(v, { buf: 'pink', type: 'bandpass', q: rnd(1, 1.5), f: rnd(220, 320), sw: [[rnd(1000, 1400), pk], [rnd(300, 450), dur]], a: pk, d: dur - pk + 0.05, peak: 1.9 });
  nz(v, { buf: 'brown', type: 'lowpass', q: 2, f: 140, sw: [[380, pk], [150, dur]], a: pk, d: dur - pk, peak: 0.8 });
  nz(v, { type: 'bandpass', q: 4, f: 1200, sw: [[3500, pk], [1400, dur]], a: pk, d: (dur - pk) * 0.6, peak: 1.1 });
});

// circular swish with doppler-ish filter wobble and a pan sweep
def('whoosh_spin', 4, 0.07, 1.2, (v) => {
  const dur = rnd(0.45, 0.55), pk = dur * 0.5, t = v.t0, dir = Math.random() < 0.5 ? -1 : 1;
  let dest = v.out;
  if (hasPanner) {
    const p = v.node(ctx.createStereoPanner());
    p.pan.setValueAtTime(-0.6 * dir, t);
    p.pan.linearRampToValueAtTime(0.6 * dir, t + dur * v.T);
    p.connect(v.out);
    dest = p;
  }
  const am = gn(v, 0.7);
  am.connect(dest);
  const wob = rnd(5, 7);
  lfo(v, am.gain, wob, 0.3, 0, dur + 0.16);
  const n = nz(v, { type: 'bandpass', q: 1.6, f: 500, sw: [[1800, pk], [600, dur]], a: pk * 0.8, d: dur - pk * 0.8 + 0.1, peak: 2.4, dest: am });
  lfo(v, n.filt.frequency, wob, 300 * v.P, 0, dur + 0.16);
  nz(v, { buf: 'pink', type: 'bandpass', q: 1.2, f: 250, sw: [[700, pk], [260, dur]], a: pk, d: dur - pk, peak: 1.3, dest: am });
  nz(v, { type: 'bandpass', q: 7, f: 2500, sw: [[5000, pk], [2200, dur]], a: pk, d: (dur - pk) * 0.8, peak: 0.9, dest });
});

// sword-on-sword: random subset of inharmonic partials + noise transient
def('clash', 8, 0.2, 1, (v) => {
  const f0 = rnd(1100, 1500);
  const pool = [[1.34, 0.5, 0.3], [1.81, 0.6, 0.28], [2.27, 0.45, 0.22], [2.76, 0.5, 0.2], [3.42, 0.3, 0.14]];
  const parts = [[1, 1, 0.42]];
  for (const p of pool) if (Math.random() < 0.65) parts.push([p[0] * rnd(0.97, 1.03), p[1], p[2]]);
  ring(v, 0, f0, parts, 0.4);
  nz(v, { type: 'highpass', f: 2500, a: 0.0005, d: 0.035, peak: 0.7 });
  nz(v, { type: 'bandpass', f: rnd(1800, 2600), q: 1.5, a: 0.0005, d: 0.09, peak: 1.8 });
  tn(v, { f: 180, sw: [[90, 0.04]], d: 0.08, peak: 0.35 });
  nz(v, { type: 'bandpass', f: rnd(5000, 7000), q: 2, at: 0.005, a: 0.004, d: 0.15, peak: 0.6 });
});

// THE parry: sharp crack, shimmering long ring (beating partial pairs), shing scrape, sub thump
def('parry', 4, 0.32, 0.85, (v) => {
  const f0 = rnd(880, 1000);
  ring(v, 0, f0, [
    [1, 1, 1.7], [1.0068, 0.7, 1.55],
    [2.02, 0.35, 0.8], [2.74, 0.55, 1.1], [2.763, 0.35, 1.0],
    [4.05, 0.28, 0.5], [5.42, 0.2, 0.32], [6.1, 0.1, 0.2],
  ], 0.32);
  tn(v, { type: 'triangle', f: f0 * 0.5 * rnd(0.98, 1.02), a: 0.001, d: 0.4, peak: 0.09, mid: [0.5, 0.02] });
  nz(v, { type: 'highpass', f: 3000, a: 0.0004, d: 0.03, peak: 1.3 });
  nz(v, { type: 'bandpass', f: 2200, q: 1.2, a: 0.0004, d: 0.07, peak: 2.2 });
  nz(v, { type: 'bandpass', f: 9000, q: 3, sw: [[4500, 0.25]], at: 0.004, a: 0.003, d: 0.28, peak: 0.9 });
  tn(v, { f: 120, sw: [[48, 0.08]], a: 0.001, d: 0.22, peak: 0.7, shape: 'soft' });
});

// dull metal block: low partials, short ring, thump
def('block', 6, 0.12, 1, (v) => {
  ring(v, 0, rnd(520, 700), [[1, 1, 0.22], [1.52, 0.6, 0.16], [2.3, 0.5, 0.12], [3.1, 0.3, 0.08]], 0.25);
  nz(v, { type: 'bandpass', f: rnd(700, 1000), q: 1, a: 0.0005, d: 0.08, peak: 2.4 });
  nz(v, { type: 'highpass', f: 2000, a: 0.0005, d: 0.015, peak: 0.6 });
  tn(v, { f: 140, sw: [[60, 0.06]], d: 0.16, peak: 0.6, shape: 'soft' });
});

// wet slice: high tick + resonant squelch sweep + wet crackle + low thump
def('flesh', 6, 0.06, 1.5, (v) => {
  nz(v, { type: 'highpass', f: rnd(3000, 4500), a: 0.0005, d: rnd(0.015, 0.03), peak: 0.9 });
  nz(v, { buf: 'pink', type: 'bandpass', q: rnd(3.5, 5), f: rnd(1600, 2100), sw: [[rnd(300, 420), 0.11]], at: 0.004, a: 0.004, d: rnd(0.1, 0.14), peak: 3.6 });
  nz(v, { buf: 'crackle', type: 'bandpass', f: rnd(1200, 2000), q: 1, rate: rnd(0.7, 1.1), at: 0.01, a: 0.005, d: 0.14, peak: 3 });
  tn(v, { f: rnd(110, 140), sw: [[50, 0.07]], d: 0.12, peak: 0.55, shape: 'soft' });
});

// gory chop: distorted body thump, longer squelch, bone crunch ticks
def('flesh_heavy', 6, 0.08, 0.85, (v) => {
  nz(v, { type: 'highpass', f: 2500, a: 0.0005, d: 0.025, peak: 1.0 });
  tn(v, { f: rnd(95, 120), sw: [[38, 0.1]], d: 0.26, peak: 0.8, shape: 'hard' });
  nz(v, { buf: 'pink', type: 'bandpass', q: 3.5, f: rnd(1400, 1900), sw: [[280, 0.16]], at: 0.006, a: 0.005, d: 0.18, peak: 4 });
  cracks(v, 5 + ((Math.random() * 3) | 0), 0.05, 1500, 4500, 3, 0.004);
  nz(v, { buf: 'crackle', type: 'bandpass', f: 2500, q: 0.8, at: 0.01, a: 0.004, d: 0.12, peak: 3 });
  nz(v, { buf: 'crackle', type: 'lowpass', f: 1200, rate: 0.6, at: 0.03, a: 0.01, d: 0.2, peak: 3 });
});

// dismemberment: meaty chop + dense crunch + fluttering wet spray tail
def('sever', 4, 0.1, 0.8, (v) => {
  nz(v, { type: 'highpass', f: 2200, a: 0.0005, d: 0.03, peak: 1.1 });
  tn(v, { f: rnd(85, 105), sw: [[34, 0.12]], d: 0.32, peak: 0.9, shape: 'hard' });
  nz(v, { buf: 'brown', type: 'lowpass', f: 400, q: 1, a: 0.001, d: 0.12, peak: 1.2 });
  nz(v, { buf: 'pink', type: 'bandpass', q: 3, f: 1700, sw: [[260, 0.2]], at: 0.005, a: 0.004, d: 0.22, peak: 4.5 });
  cracks(v, 8 + ((Math.random() * 4) | 0), 0.09, 1200, 5000, 3, 0.006);
  const am = gn(v, 0.6);
  am.connect(v.out);
  lfo(v, am.gain, rnd(11, 16), 0.4, 0.04, 0.95);
  nz(v, { buf: 'crackle', type: 'bandpass', f: rnd(1800, 2800), q: 0.9, at: 0.05, a: 0.03, d: 0.75, peak: 4, dest: am });
  nz(v, { buf: 'pink', type: 'bandpass', f: 2600, q: 1.2, at: 0.06, a: 0.04, d: 0.7, peak: 1.3, dest: am });
});

// blood droplets on stone: cheap wet crackle + tiny pat
def('splat', 6, 0, 0.8, (v) => {
  nz(v, { buf: 'crackle', type: 'highpass', f: rnd(900, 1600), rate: rnd(1.4, 2.2), a: 0.002, d: rnd(0.07, 0.14), peak: rnd(3.5, 4.5) });
  nz(v, { buf: 'pink', type: 'bandpass', f: rnd(350, 600), q: 1.5, a: 0.001, d: 0.03, peak: 2 });
});

// arterial spray: 2-3 decaying wet pulses
def('gore_spurt', 4, 0.06, 1.3, (v) => {
  const n = Math.random() < 0.5 ? 2 : 3;
  let at = 0;
  for (let i = 0; i < n; i++) {
    const k = 1 - i * 0.25;
    nz(v, { buf: 'pink', type: 'bandpass', f: rnd(1100, 1600), sw: [[rnd(1800, 2400), 0.05], [900, 0.16]], q: 1.4, at, a: 0.025, d: 0.14, peak: 3 * k });
    nz(v, { buf: 'crackle', type: 'bandpass', f: rnd(2000, 3000), q: 0.8, at, a: 0.02, d: 0.16, peak: 3.5 * k });
    tn(v, { f: 75, sw: [[45, 0.05]], at, a: 0.005, d: 0.08, peak: 0.25 * k });
    at += rnd(0.17, 0.24);
  }
});

// body kick: saturated low thump + leather slap + cloth thwump
def('kick', 6, 0.06, 0.9, (v) => {
  tn(v, { f: rnd(130, 160), sw: [[45, 0.07]], a: 0.0008, d: 0.2, peak: 0.9, shape: 'hard' });
  nz(v, { type: 'bandpass', f: rnd(1300, 2000), q: 1.1, a: 0.0005, d: 0.035, peak: 2.6 });
  nz(v, { buf: 'pink', type: 'lowpass', f: 380, q: 0.9, a: 0.001, d: 0.1, peak: 1.0 });
  nz(v, { type: 'highpass', f: 4000, a: 0.0005, d: 0.012, peak: 0.6 });
});

// body hits ground/wall: heavy low thud + wet splash
def('thud', 6, 0.1, 0.75, (v) => {
  tn(v, { f: rnd(85, 100), sw: [[32, 0.12]], d: 0.38, peak: 0.9, shape: 'soft' });
  nz(v, { buf: 'brown', type: 'lowpass', f: 260, q: 0.8, a: 0.002, d: 0.3, peak: 1.3 });
  nz(v, { buf: 'pink', type: 'bandpass', f: rnd(600, 900), q: 1, a: 0.001, d: 0.06, peak: 2 });
  nz(v, { buf: 'crackle', type: 'highpass', f: 1200, at: 0.01, a: 0.004, d: 0.22, peak: 2.4 });
});

// wet stone footstep (cheap: two noise units)
def('footstep', 4, 0, 1.2, (v) => {
  nz(v, { buf: 'pink', type: 'bandpass', f: rnd(500, 1000), q: rnd(0.8, 1.4), a: 0.001, d: rnd(0.04, 0.07), peak: rnd(1.5, 2.2) });
  nz(v, { buf: 'crackle', type: 'highpass', f: rnd(1800, 3000), rate: rnd(1.3, 1.9), at: 0.005, a: 0.003, d: rnd(0.05, 0.09), peak: rnd(2, 3) });
});

// landing: heavier step with splash
def('land', 3, 0.05, 0.7, (v) => {
  tn(v, { f: 95, sw: [[40, 0.08]], d: 0.16, peak: 0.7, shape: 'soft' });
  nz(v, { buf: 'pink', type: 'bandpass', f: rnd(450, 700), q: 1, a: 0.001, d: 0.09, peak: 2.5 });
  nz(v, { buf: 'crackle', type: 'highpass', f: 1400, a: 0.003, d: 0.28, peak: 3 });
  nz(v, { type: 'bandpass', f: 3500, q: 0.8, sw: [[2200, 0.2]], at: 0.01, a: 0.01, d: 0.18, peak: 0.6 });
});

// leap: cloth whoosh + push-off scuff
def('jump', 3, 0.03, 1.1, (v) => {
  nz(v, { buf: 'pink', type: 'bandpass', q: 1.2, f: 600, sw: [[1600, 0.07], [900, 0.16]], a: 0.06, d: 0.1, peak: 2.2 });
  nz(v, { buf: 'pink', type: 'bandpass', f: rnd(700, 1100), q: 1.2, a: 0.001, d: 0.04, peak: 1.2 });
  nz(v, { buf: 'crackle', type: 'highpass', f: 2000, a: 0.002, d: 0.06, peak: 1.5 });
});

// dodge roll: cloth swoosh + skid/scrape on wet stone
def('dodge', 3, 0.04, 0.9, (v) => {
  nz(v, { buf: 'pink', type: 'bandpass', q: 1.1, f: 450, sw: [[1500, 0.09], [600, 0.26]], a: 0.08, d: 0.18, peak: 2.6 });
  nz(v, { buf: 'crackle', type: 'bandpass', f: rnd(2200, 3200), q: 0.9, rate: 0.6, at: 0.06, a: 0.03, d: 0.24, peak: 3 });
  nz(v, { type: 'bandpass', f: 2800, q: 1.5, sw: [[1800, 0.25]], at: 0.07, a: 0.04, d: 0.2, peak: 1.4 });
  nz(v, { type: 'highpass', f: 3500, at: 0.05, a: 0.05, d: 0.2, peak: 0.35 });
});

// crate/barrel smash: hollow knock, splinter cracks, rattle, tumbling debris
def('break_wood', 4, 0.1, 0.9, (v) => {
  tn(v, { f: rnd(140, 180), sw: [[55, 0.06]], d: 0.14, peak: 0.8, shape: 'hard' });
  nz(v, { buf: 'pink', type: 'bandpass', f: rnd(350, 550), q: 1.4, a: 0.0005, d: 0.1, peak: 3 });
  tn(v, { type: 'triangle', f: rnd(260, 340), d: 0.07, peak: 0.25 });
  tn(v, { type: 'triangle', f: rnd(480, 620), d: 0.05, peak: 0.18 });
  nz(v, { type: 'highpass', f: 2500, a: 0.0005, d: 0.02, peak: 1 });
  cracks(v, 10, 0.32, 1200, 5500, 3.2, 0.003);
  nz(v, { buf: 'crackle', type: 'bandpass', f: 2600, q: 0.7, rate: 0.8, at: 0.02, a: 0.01, d: 0.4, peak: 3 });
  for (let i = 0; i < 3; i++) nz(v, { buf: 'pink', type: 'bandpass', f: rnd(250, 500), q: 2.5, at: rnd(0.12, 0.55), a: 0.0008, d: 0.05, peak: rnd(1.2, 2.2) });
});

// thrown knife: spinning whir (amplitude-modulated band) + release flick
def('throw', 4, 0.04, 1.8, (v) => {
  const dur = 0.38;
  const am = gn(v, 0.5);
  am.connect(v.out);
  lfo(v, am.gain, rnd(22, 30), 0.5, 0, dur + 0.05, 'triangle');
  nz(v, { type: 'bandpass', f: rnd(1800, 2300), q: 3, sw: [[rnd(1300, 1600), dur]], a: 0.04, d: dur - 0.04, peak: 3.2, dest: am });
  nz(v, { type: 'bandpass', f: 900, q: 1.5, sw: [[2500, 0.05], [1000, 0.12]], a: 0.04, d: 0.08, peak: 1.6 });
});

// knife thunk into wood/flesh with a small embedded-blade twang
def('knife_hit', 4, 0.06, 1.5, (v) => {
  tn(v, { f: rnd(200, 260), sw: [[120, 0.04]], d: 0.07, peak: 0.6, shape: 'soft' });
  nz(v, { type: 'bandpass', f: rnd(1800, 2600), q: 1.2, a: 0.0005, d: 0.025, peak: 1.6 });
  nz(v, { buf: 'pink', type: 'bandpass', f: 600, q: 1.5, a: 0.0005, d: 0.05, peak: 2 });
  const o = tn(v, { type: 'triangle', f: rnd(280, 360), at: 0.005, a: 0.002, d: 0.3, peak: 0.08 });
  lfo(v, o.frequency, rnd(28, 40), 14, 0, 0.33);
});

// male pain/effort grunt
def('grunt', 4, 0.06, 0.6, (v) => {
  const f0 = rnd(95, 135), dur = rnd(0.18, 0.3);
  vocal(v, {
    f0, sw: [[f0 * rnd(1.15, 1.3), 0.03], [f0 * rnd(0.75, 0.85), dur]],
    vowel: pick(['ah', 'uh', 'oh']), shift: rnd(0.9, 1.08),
    a: 0.015, d: dur, mid: [0.6, 0.05], peak: 1.6, rasp: rnd(0.15, 0.3),
  });
  nz(v, { buf: 'pink', type: 'bandpass', f: 1200, q: 0.8, at: dur * 0.6, a: 0.02, d: 0.12, peak: 0.5 });
});

// death groan sliding into a wet gurgle and exhale
def('death', 4, 0.08, 0.55, (v) => {
  const f0 = rnd(85, 110), dur = rnd(0.75, 1.0);
  vocal(v, {
    f0, sw: [[f0 * 1.12, 0.06], [f0 * 0.95, dur * 0.4], [f0 * 0.62, dur]],
    vowel: 'oh', vowel2: 'uh', shift: rnd(0.9, 1.05),
    a: 0.04, hold: dur * 0.3, d: dur * 0.7, peak: 1.8, rasp: 0.35, gurgle: [rnd(13, 19), 0.55, dur * 0.35],
  });
  nz(v, { buf: 'crackle', type: 'lowpass', f: 700, q: 2, rate: 0.35, at: dur * 0.35, a: 0.1, d: dur * 0.6, peak: 4 });
  nz(v, { buf: 'pink', type: 'bandpass', f: 380, q: 3, at: dur * 0.4, a: 0.08, d: dur * 0.5, peak: 1.6 });
  nz(v, { buf: 'pink', type: 'bandpass', f: 1100, q: 0.9, at: dur * 0.8, a: 0.05, d: 0.35, peak: 0.7 });
});

// armored boss bellow: low distorted vocal through a helmet comb resonance + rumble
def('boss_roar', 2, 0.3, 0.36, (v) => {
  const f0 = rnd(55, 64), dur = rnd(1.35, 1.6);
  const comb = gn(v, 1), dl = v.node(ctx.createDelay(0.05)), fb = gn(v, 0.5), wet = gn(v, 0.45);
  dl.delayTime.value = 1 / rnd(190, 240);
  comb.connect(v.out);
  comb.connect(dl);
  dl.connect(fb);
  fb.connect(dl);
  dl.connect(wet);
  wet.connect(v.out);
  vocal(v, {
    f0, sw: [[f0 * 1.4, 0.22], [f0 * 1.25, dur * 0.6], [f0 * 0.8, dur]],
    vowel: 'ah', vowel2: 'oh', shift: 0.8,
    a: 0.1, hold: dur * 0.5, d: dur * 0.5, peak: 2.2, rasp: 0.6, dist: 'fuzz', sub: true, dest: comb,
  });
  nz(v, { buf: 'brown', type: 'lowpass', f: 140, q: 1.2, a: 0.15, hold: dur * 0.4, d: dur * 0.6, peak: 2 });
  nz(v, { buf: 'pink', type: 'bandpass', f: 1800, q: 0.7, a: 0.1, hold: dur * 0.3, d: dur * 0.6, peak: 0.8 });
  tn(v, { f: 70, sw: [[38, 0.2]], a: 0.01, d: 0.6, peak: 0.6, shape: 'soft' });
});

// sword catching fire: inhaled rising whoomph, sub swell, crackle burst
def('fire_ignite', 2, 0.15, 1, (v) => {
  nz(v, { buf: 'brown', type: 'lowpass', q: 2, f: 150, sw: [[1800, 0.12], [500, 0.7]], a: 0.1, d: 0.6, peak: 0.6, shape: 'soft' });
  nz(v, { buf: 'pink', type: 'bandpass', q: 0.8, f: 400, sw: [[2500, 0.12], [900, 0.6]], a: 0.09, d: 0.55, peak: 1.4 });
  tn(v, { f: 55, sw: [[80, 0.08], [35, 0.4]], a: 0.06, d: 0.4, peak: 0.6 });
  nz(v, { buf: 'crackle', type: 'highpass', f: 1500, at: 0.08, a: 0.05, d: 0.7, peak: 3.5 });
  nz(v, { type: 'highpass', f: 5000, a: 0.12, d: 0.3, peak: 0.4 });
});

// flaming sword swing: distorted low roar + swoosh + crackle
def('fire_swing', 4, 0.1, 1, (v) => {
  const dur = rnd(0.38, 0.46), pk = dur * 0.45;
  nz(v, { buf: 'brown', type: 'bandpass', q: 0.9, f: 200, sw: [[700, pk], [220, dur]], a: pk, d: dur - pk + 0.1, peak: 0.45, shape: 'hard' });
  nz(v, { buf: 'pink', type: 'bandpass', q: 1.2, f: 500, sw: [[1800, pk], [600, dur]], a: pk, d: dur - pk + 0.05, peak: 2.4 });
  nz(v, { buf: 'crackle', type: 'highpass', f: 1800, a: pk, d: dur, peak: 3 });
  nz(v, { type: 'bandpass', q: 5, f: 1500, sw: [[3800, pk], [1500, dur]], a: pk, d: (dur - pk) * 0.6, peak: 0.9 });
});

// iron portcullis: winch clank, grinding, scrape, ratchet + chain clinks, final lock clunk
def('gate', 1, 0.25, 0.7, (v) => {
  ring(v, 0, rnd(380, 450), [[1, 1, 0.3], [2.4, 0.6, 0.2], [3.9, 0.4, 0.12]], 0.3);
  tn(v, { f: 110, sw: [[45, 0.1]], d: 0.3, peak: 0.8, shape: 'hard' });
  nz(v, { type: 'bandpass', f: 1200, q: 1, d: 0.06, peak: 2 });
  const am = gn(v, 0.6);
  am.connect(v.out);
  lfo(v, am.gain, rnd(9, 12), 0.25, 0, 3.3, 'square');
  lfo(v, am.gain, rnd(3, 5), 0.15, 0, 3.3);
  nz(v, { buf: 'brown', type: 'bandpass', f: 140, q: 2.5, sw: [[190, 1.5], [150, 2.8]], at: 0.08, a: 0.3, hold: 2.3, d: 0.5, peak: 0.45, shape: 'hard', dest: am });
  nz(v, { type: 'bandpass', f: 2100, q: 9, sw: [[2500, 1.2], [1900, 2.6]], at: 0.1, a: 0.4, hold: 2.0, d: 0.5, peak: 1.6, dest: am });
  nz(v, { buf: 'crackle', type: 'bandpass', f: 3200, q: 3, rate: 0.5, at: 0.1, a: 0.2, hold: 2.4, d: 0.4, peak: 2.5 });
  for (let at = 0.2; at < 2.75; at += rnd(0.15, 0.21)) {
    nz(v, { buf: 'pink', type: 'bandpass', f: rnd(700, 950), q: 4, at, a: 0.0005, d: 0.025, peak: 2.5 });
    if (Math.random() < 0.6) nz(v, { type: 'bandpass', f: rnd(2600, 5200), q: rnd(10, 18), at: at + rnd(0.02, 0.1), a: 0.0005, d: rnd(0.03, 0.08), peak: rnd(3, 6) });
  }
  tn(v, { f: 90, sw: [[40, 0.1]], at: 2.85, d: 0.35, peak: 0.9, shape: 'hard' });
  ring(v, 2.85, rnd(300, 360), [[1, 1, 0.35], [2.7, 0.5, 0.2]], 0.3);
  nz(v, { type: 'bandpass', f: 900, q: 1, at: 2.85, d: 0.08, peak: 2.5 });
});

// distant rolling thunder: optional muffled crack, randomly amplitude-modulated low rumble
def('thunder', 2, 0.25, 0.6, (v) => {
  const t = v.t0, T = v.T, dur = rnd(3.5, 4.5);
  const crack = Math.random() < 0.45;
  if (crack) {
    nz(v, { type: 'bandpass', f: rnd(900, 1500), q: 0.7, a: 0.002, d: 0.25, peak: 2.5 });
    cracks(v, 6, 0.25, 600, 2200, 2.5);
  }
  const am = gn(v, 0);
  am.connect(v.out);
  am.gain.setValueAtTime(0.0001, t);
  let x = crack ? 0.04 : rnd(0.05, 0.3);
  while (x < dur) {
    am.gain.linearRampToValueAtTime(Math.max(0.04, Math.pow(1 - x / dur, 1.3)) * rnd(0.3, 1), t + x * T);
    x += rnd(0.06, 0.22);
  }
  am.gain.linearRampToValueAtTime(0.0001, t + (dur + 0.25) * T);
  nz(v, { buf: 'brown', type: 'lowpass', f: rnd(160, 260), q: 0.9, sw: [[110, dur]], a: 0.05, hold: dur, d: 0.3, peak: 1.1, dest: am });
  nz(v, { buf: 'pink', type: 'bandpass', f: 400, q: 0.8, a: 0.02, d: dur * 0.5, peak: 0.6, dest: am });
  nz(v, { buf: 'brown', type: 'lowpass', f: 60, q: 1, a: 0.3, hold: dur * 0.5, d: dur * 0.5, peak: 0.7 });
});

// low double-thump heartbeat
def('heartbeat', 2, 0, 0.7, (v) => {
  tn(v, { f: 60, sw: [[38, 0.08]], a: 0.004, d: 0.16, peak: 0.85, shape: 'soft' });
  nz(v, { buf: 'brown', type: 'lowpass', f: 150, a: 0.004, d: 0.12, peak: 1.0 });
  tn(v, { f: 54, sw: [[36, 0.08]], at: 0.24, a: 0.004, d: 0.18, peak: 0.6, shape: 'soft' });
  nz(v, { buf: 'brown', type: 'lowpass', f: 140, at: 0.24, a: 0.004, d: 0.14, peak: 0.7 });
});

// finisher stinger: deep distorted boom + reverse swell that sucks in and cuts
def('execute', 2, 0.25, 1, (v) => {
  const t = v.t0, T = v.T;
  tn(v, { f: 75, sw: [[26, 0.35]], a: 0.001, d: 0.85, peak: 0.55, shape: 'hard' });
  tn(v, { f: 150, sw: [[50, 0.12]], d: 0.3, peak: 0.4 });
  nz(v, { buf: 'brown', type: 'lowpass', f: 500, sw: [[120, 0.4]], a: 0.001, d: 0.6, peak: 0.8 });
  nz(v, { type: 'highpass', f: 2000, d: 0.04, peak: 1 });
  const sw = gn(v, 0);
  sw.connect(v.out);
  sw.gain.setValueAtTime(0.0001, t);
  sw.gain.exponentialRampToValueAtTime(1, t + 0.62 * T);
  sw.gain.linearRampToValueAtTime(0.0001, t + 0.69 * T);
  nz(v, { buf: 'pink', type: 'bandpass', f: 300, q: 0.9, sw: [[2400, 0.62]], a: 0.001, hold: 0.7, d: 0.05, peak: 2.2, dest: sw });
  tn(v, { type: 'sawtooth', f: 73.4, lp: 900, a: 0.001, hold: 0.7, d: 0.05, peak: 0.15, dest: sw });
  tn(v, { type: 'sawtooth', f: 77.8, lp: 900, a: 0.001, hold: 0.7, d: 0.05, peak: 0.15, dest: sw });
});

// subtle UI tick
def('combo_tick', 4, 0, 1.3, (v) => {
  tn(v, { f: rnd(2300, 2500), a: 0.0005, d: 0.035, peak: 0.25 });
  nz(v, { type: 'highpass', f: 6000, d: 0.008, peak: 0.6 });
});

// UI confirm: D -> A fifth with a soft low thump
def('ui_confirm', 3, 0.1, 1.25, (v) => {
  tn(v, { type: 'triangle', f: 293.66, d: 0.25, peak: 0.25, mid: [0.5, 0.03] });
  tn(v, { type: 'triangle', f: 440, at: 0.07, d: 0.4, peak: 0.25, mid: [0.5, 0.03] });
  tn(v, { f: 880 * 1.004, at: 0.07, d: 0.3, peak: 0.05 });
  tn(v, { f: 110, sw: [[60, 0.06]], d: 0.12, peak: 0.35 });
});

// time slows: sub whum with a falling filtered whoosh
def('slowmo_in', 2, 0.15, 0.55, (v) => {
  tn(v, { f: 90, sw: [[32, 0.55]], a: 0.04, d: 0.6, peak: 0.85, shape: 'soft' });
  nz(v, { buf: 'pink', type: 'lowpass', q: 4, f: 1400, sw: [[140, 0.5]], a: 0.03, d: 0.5, peak: 1.2 });
  nz(v, { type: 'bandpass', q: 2, f: 3000, sw: [[600, 0.35]], a: 0.005, d: 0.3, peak: 0.6 });
});

// wave start: ominous drum hit + metallic shimmer + dissonant low swell
def('wave_start', 2, 0.35, 0.65, (v) => {
  tn(v, { f: 62, sw: [[40, 0.15]], a: 0.002, d: 1.2, peak: 0.95, shape: 'soft' });
  nz(v, { buf: 'pink', type: 'bandpass', f: 180, q: 0.9, a: 0.001, d: 0.25, peak: 3 });
  nz(v, { type: 'bandpass', f: 1500, q: 1, d: 0.03, peak: 1.2 });
  const base = rnd(1900, 2100);
  for (const [r, a] of [[1, 1], [1.007, 0.8], [1.41, 0.6], [1.89, 0.5], [2.52, 0.35]]) tn(v, { f: base * r, at: 0.05, a: 0.35, d: 1.6, peak: 0.035 * a });
  tn(v, { type: 'sawtooth', f: 36.7, lp: 220, a: 0.1, d: 1.6, peak: 0.25 });
  tn(v, { type: 'sawtooth', f: 38.9, lp: 220, a: 0.1, d: 1.6, peak: 0.18 });
});

// wave cleared: phrygian bII -> i resolution with drum hits and a bell
def('victory', 1, 0.3, 0.7, (v) => {
  tn(v, { f: 60, sw: [[40, 0.12]], d: 0.9, peak: 0.75, shape: 'soft' });
  nz(v, { buf: 'pink', type: 'bandpass', f: 170, q: 1, d: 0.25, peak: 2.5 });
  const pad = (f, at, hold, d, pk) => {
    for (const det of [-7, 7]) tn(v, { type: 'sawtooth', f, det, lp: 1100, at, a: 0.08, hold, d, peak: pk });
  };
  for (const f of [155.56, 196.0, 233.08]) pad(f, 0, 0.3, 0.25, 0.06);
  for (const f of [146.83, 220.0, 293.66]) pad(f, 0.5, 0.5, 1.4, 0.07);
  tn(v, { f: 73.42, at: 0.5, a: 0.05, hold: 0.4, d: 1.4, peak: 0.3 });
  tn(v, { f: 60, sw: [[40, 0.12]], at: 0.5, d: 0.9, peak: 0.7, shape: 'soft' });
  bell(v, 0.5, 587.33, 0.1);
});

// ---------------------------------------------------------------- ambience

let amb = null;
let ambTimer = 0;

function startAmb() {
  if (amb || !ctx) return;
  const t = ctx.currentTime;
  const A = (amb = { keep: [], srcs: [] });
  const k = (n) => (A.keep.push(n), n);
  const G = (val) => { const g = k(ctx.createGain()); g.gain.value = val; return g; };
  const F = (type, f, q = 0.707) => { const b = k(ctx.createBiquadFilter()); b.type = type; b.frequency.value = cf(f); b.Q.value = q; return b; };
  const N = (buf, rate = 1) => {
    const s = k(ctx.createBufferSource());
    s.buffer = NOISE[buf];
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t, Math.random() * s.buffer.duration * 0.9);
    A.srcs.push(s);
    return s;
  };
  const PAN = (p) => {
    if (!hasPanner) return G(1);
    const n = k(ctx.createStereoPanner());
    n.pan.value = p;
    return n;
  };
  const L = (param, rate, depth, type = 'sine') => {
    const o = k(ctx.createOscillator());
    o.type = type;
    o.frequency.value = rate;
    const g = G(depth);
    o.connect(g);
    g.connect(param);
    o.start(t);
    A.srcs.push(o);
  };
  const chain = (...ns) => { for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]); };

  const out = G(0.0001);
  out.connect(ambBus);
  out.gain.setTargetAtTime(1, t, 1.2);
  const rain = (A.rain = G(1));
  rain.connect(out);
  // broad rain wash, decorrelated left/right
  for (const p of [-0.75, 0.75]) {
    const g = G(0.5);
    chain(N('pink', rnd(0.96, 1.04)), F('highpass', 450, 0.5), F('lowpass', 7000, 0.5), g, PAN(p), rain);
    L(g.gain, rnd(0.05, 0.11), 0.12);
  }
  // bright hiss of rain on stone
  for (const p of [-0.4, 0.4]) {
    const bp = F('bandpass', rnd(3200, 4000), 0.6);
    chain(N('white', rnd(0.97, 1.03)), bp, G(0.22), PAN(p), rain);
    L(bp.frequency, rnd(0.02, 0.05), 700);
  }
  // close droplet patter
  for (const p of [-0.6, 0.6]) chain(N('crackle', rnd(0.85, 1.15)), F('highpass', 1800, 0.7), G(0.35), PAN(p), rain);
  // low body of the downpour
  chain(N('brown'), F('lowpass', 240, 0.7), G(0.3), rain);
  // distant wind: resonant band, slow sweep, gusts, drifting pan
  const wind = (A.wind = G(0.8));
  const wbp = F('bandpass', 420, 2.5), wpan = PAN(0);
  chain(N('pink', 0.8), wbp, wind, wpan, out);
  L(wbp.frequency, 0.061, 180);
  L(wind.gain, 0.043, 0.3);
  if (hasPanner) L(wpan.pan, 0.027, 0.6);
  const whistle = F('bandpass', 950, 9);
  chain(N('pink', 0.9), whistle, G(0.18), out);
  L(whistle.frequency, 0.083, 320);
  // faint brazier crackle bed
  chain(N('crackle', 0.55), F('bandpass', 2400, 0.8), G(0.07), out);

  ambTimer = setInterval(ambTick, 2500);
  ambTick();
}

function ambTick() {
  try {
    if (!ctx || !amb) return;
    const now = ctx.currentTime;
    amb.rain.gain.setTargetAtTime(rnd(0.8, 1.15), now, 2);
    amb.wind.gain.setTargetAtTime(rnd(0.4, 1.3), now, 1.6);
    const n = 1 + ((Math.random() * 4) | 0);
    for (let i = 0; i < n; i++) drip(now + rnd(0.05, 2.45));
  } catch (e) {
    report('ambience', e);
  }
}

// single water drip into a puddle
function drip(t) {
  const v = new Voice(null, rnd(0.03, 0.09), rnd(-0.85, 0.85), 0.3, 0, ambBus, t);
  const f = rnd(900, 2400);
  tn(v, { f, sw: [[f * rnd(1.4, 1.9), 0.018]], a: 0.0008, d: rnd(0.03, 0.06), peak: 1 });
  nz(v, { type: 'bandpass', f: rnd(3000, 6000), q: 2, d: 0.008, peak: 0.6 });
  v.arm();
}

// ---------------------------------------------------------------- music instruments

function inst(dest, t, vol, build) {
  try {
    const v = new Voice(null, vol, 0, 0, 0, dest, t);
    build(v);
    v.arm();
  } catch (e) {
    report('music', e);
  }
}

const mTaiko = (dest, t, vol, f = 60) => inst(dest, t, vol, (v) => {
  tn(v, { f: f * 2.4, sw: [[f, 0.035]], d: 0.65, peak: 0.9, shape: 'soft' });
  nz(v, { buf: 'pink', type: 'bandpass', f: f * 3, q: 0.9, d: 0.14, peak: 2.4 });
  nz(v, { type: 'bandpass', f: 1400, q: 0.8, d: 0.02, peak: 0.7 });
});

const mTom = (dest, t, vol, f, far) => inst(dest, t, vol, (v) => {
  tn(v, { f: f * 1.8, sw: [[f, 0.04]], d: far ? 0.5 : 0.35, peak: 0.8, lp: far ? 400 : 0 });
  nz(v, { buf: 'pink', type: 'bandpass', f: f * (far ? 2 : 2.5), q: 1.2, d: 0.08, peak: far ? 0.8 : 1.6 });
});

const mKick = (dest, t, vol) => inst(dest, t, vol, (v) => {
  tn(v, { f: 70, sw: [[42, 0.06]], a: 0.003, d: 0.3, peak: 0.9 });
  nz(v, { buf: 'brown', type: 'lowpass', f: 160, a: 0.003, d: 0.1, peak: 0.6 });
});

const mTick = (dest, t, vol) => inst(dest, t, vol, (v) => {
  nz(v, { type: 'bandpass', f: rnd(7000, 9500), q: 1.5, d: rnd(0.025, 0.05), peak: 1.4 });
});

const mBass = (dest, t, f, dur, vol) => inst(dest, t, vol, (v) => {
  const filt = bq(v, 'lowpass', 700, 5);
  filt.frequency.setValueAtTime(700, t);
  filt.frequency.exponentialRampToValueAtTime(110, t + dur);
  filt.connect(v.out);
  tn(v, { type: 'sawtooth', f, a: 0.004, d: dur, peak: 0.8, dest: filt });
  tn(v, { type: 'square', f: f * 2, a: 0.004, d: dur * 0.7, peak: 0.25, dest: filt });
});

const mBrass = (dest, t, f, dur, vol) => inst(dest, t, vol, (v) => {
  const filt = bq(v, 'lowpass', 250, 2.5);
  filt.frequency.setValueAtTime(250, t);
  filt.frequency.exponentialRampToValueAtTime(1700, t + 0.05);
  filt.frequency.exponentialRampToValueAtTime(450, t + dur);
  const sh = shaper(v, 'soft');
  filt.connect(sh);
  sh.connect(v.out);
  for (const det of [-14, -4, 6, 15]) tn(v, { type: 'sawtooth', f, det, a: 0.025, d: dur, peak: 0.22, dest: filt });
  tn(v, { type: 'sawtooth', f: f / 2, a: 0.02, d: dur, peak: 0.25, dest: filt });
});

const mAnvil = (dest, t, vol) => inst(dest, t, vol, (v) => {
  ring(v, 0, rnd(780, 860), [[1, 1, 0.35], [2.76, 0.6, 0.22], [5.4, 0.3, 0.12]], 0.5);
  nz(v, { type: 'highpass', f: 3000, d: 0.02, peak: 1 });
});

const mBell = (dest, t, f, vol) => inst(dest, t, vol, (v) => bell(v, 0, f, 1));

// ---------------------------------------------------------------- music layers

const layers = {};
let schedTimer = 0, lastTick = 0, curMusic = null;

function lkeep(L, n) {
  L.keep.push(n);
  return n;
}
function lgain(L, val) {
  const g = lkeep(L, ctx.createGain());
  g.gain.value = val;
  return g;
}
function losc(L, type, f, det = 0) {
  const o = lkeep(L, ctx.createOscillator());
  o.type = type;
  o.frequency.value = f;
  o.detune.value = det;
  o.start(ctx.currentTime);
  L.srcs.push(o);
  return o;
}
function lfilt(L, type, f, q) {
  const b = lkeep(L, ctx.createBiquadFilter());
  b.type = type;
  b.frequency.value = cf(f);
  b.Q.value = q;
  return b;
}
function ramp(p, target, secs) {
  const now = ctx.currentTime;
  p.cancelScheduledValues(now);
  p.setValueAtTime(Math.max(p.value, 0.0001), now);
  p.linearRampToValueAtTime(target, now + secs);
}

// detuned saws through a slowly breathing lowpass
function drone(L, freqs, cutoff, rate, level) {
  const filt = lfilt(L, 'lowpass', cutoff, 3);
  const g = lgain(L, level);
  filt.connect(g);
  g.connect(L.bus);
  for (const f of freqs) for (const det of [-9, 8]) losc(L, 'sawtooth', f, det + rnd(-3, 3)).connect(filt);
  const lg = lgain(L, cutoff * 0.55);
  losc(L, 'sine', rate).connect(lg);
  lg.connect(filt.frequency);
  return { filt, gain: g };
}

// high tremolo cluster that rises with combat intensity
function trem(L, freqs) {
  const out = lgain(L, 0.0001);
  out.connect(L.bus);
  const tg = lgain(L, 0.5);
  tg.connect(out);
  const filt = lfilt(L, 'bandpass', 1300, 0.7);
  filt.connect(tg);
  for (const f of freqs) for (const det of [-6, 6]) losc(L, 'sawtooth', f, det).connect(filt);
  const lg = lgain(L, 0.45);
  losc(L, 'sine', 7.5).connect(lg);
  lg.connect(tg.gain);
  return out;
}

// choir-ish pad: detuned saw chord + breath through a fixed "ah" formant bank
function choir(L) {
  const t = ctx.currentTime;
  const sum = lgain(L, 1);
  const out = lgain(L, 0.0001);
  out.connect(L.bus);
  for (const [F, amp, Q] of VOWELS.ah) {
    const b = lfilt(L, 'bandpass', F * 0.9, Q * 0.8);
    const g = lgain(L, amp);
    sum.connect(b);
    b.connect(g);
    g.connect(out);
  }
  const oscs = [];
  for (let i = 0; i < 3; i++) for (const det of [-11, 10]) {
    const o = losc(L, 'sawtooth', NOTE(0, 3), det);
    o.connect(sum);
    oscs.push(o);
  }
  const vg = lgain(L, 12);
  losc(L, 'sine', 5.2).connect(vg);
  for (const o of oscs) vg.connect(o.detune);
  const br = lkeep(L, ctx.createBufferSource());
  br.buffer = NOISE.pink;
  br.loop = true;
  br.start(t, Math.random());
  L.srcs.push(br);
  const brf = lfilt(L, 'highpass', 500, 0.7);
  const brg = lgain(L, 0.15);
  br.connect(brf);
  brf.connect(brg);
  brg.connect(sum);
  out.gain.setTargetAtTime(0.35, t, 1.5);
  const sg = lgain(L, 0.08);
  losc(L, 'sine', 0.07).connect(sg);
  sg.connect(out.gain);
  return {
    set(freqs, when) {
      freqs.forEach((f, i) => {
        oscs[i * 2].frequency.setTargetAtTime(f, when, 0.15);
        oscs[i * 2 + 1].frequency.setTargetAtTime(f, when, 0.15);
      });
    },
  };
}

function makeLayer(name) {
  const L = { name, keep: [], srcs: [], step: 0, bar: 0, nextTime: ctx.currentTime + 0.05, dieAt: 0, bpm: 0, boss2: false, x2OffAt: 0 };
  L.bus = lgain(L, 0.0001);
  L.bus.connect(musicBus);
  if (name === 'explore') {
    L.drone = drone(L, [NOTE(0, 1), NOTE(0, 2), NOTE(7, 1)], 320, 0.05, 0.14);
  } else if (name === 'combat') {
    L.drone = drone(L, [NOTE(0, 1), NOTE(0, 2), NOTE(7, 1)], 240, 0.09, 0.13);
    L.trem = trem(L, [NOTE(0, 4), NOTE(1, 4)]);
  } else {
    L.drone = drone(L, [NOTE(0, 1), NOTE(0, 1) * 1.004, NOTE(7, 1), NOTE(0, 2)], 300, 0.12, 0.14);
    L.choir = choir(L);
    L.x2 = lgain(L, 0.0001);
    L.x2.connect(L.bus);
  }
  return L;
}

function killLayer(L) {
  for (const s of L.srcs) { try { s.stop(); } catch (e) { /* not started */ } }
  for (const n of L.keep) { try { n.disconnect(); } catch (e) { /* gone */ } }
  L.srcs.length = 0;
  L.keep.length = 0;
}

function fadeLayer(name, on) {
  let L = layers[name];
  if (on) {
    if (!L) L = layers[name] = makeLayer(name);
    L.dieAt = 0;
    ramp(L.bus.gain, 1, 2);
  } else if (L && !L.dieAt) {
    ramp(L.bus.gain, 0.0001, 2);
    L.dieAt = ctx.currentTime + 2.3;
  }
}

function targetBpm(L, I) {
  if (L.name === 'explore') return 64;
  if (L.name === 'combat') return 100 + 8 * I;
  return L.boss2 ? 128 : 118;
}

function stepExplore(L, s, t) {
  const D = L.bus;
  if (s === 0 && L.bar % 4 === 0) L.drone.filt.frequency.setTargetAtTime(rnd(220, 480), t, 3);
  if (s === 0 && Math.random() < 0.5) mTom(D, t, 0.3, rnd(58, 66), true);
  if (s === 6 && Math.random() < 0.18) mTom(D, t, 0.18, rnd(70, 80), true);
  if (s === 10 && Math.random() < 0.3) mTom(D, t, 0.22, rnd(52, 58), true);
  if (s === 8 && L.bar % 2 === 1 && Math.random() < 0.55) mBell(D, t + rnd(0, 0.2), NOTE(pick(PHRY), Math.random() < 0.7 ? 4 : 5), 0.05);
}

function stepCombat(L, s, t, I, spb) {
  const D = L.bus;
  if (s === 0) {
    L.drone.filt.frequency.setTargetAtTime(200 + 380 * I, t, 1.5);
    L.trem.gain.setTargetAtTime(0.0001 + 0.06 * I * I, t, 1);
  }
  if (I < 0.55) {
    if (s === 0) mKick(D, t, 0.7);
    if (s === 3) mKick(D, t, 0.45);
    if (I > 0.2 && s === 8) mKick(D, t, 0.5);
    if (I > 0.2 && s === 11) mKick(D, t, 0.32);
  }
  if (I >= 0.15) {
    if (s === 0) mTaiko(D, t, 0.45 + 0.35 * I, 56);
    if (s === 8 && I > 0.3) mTaiko(D, t, 0.4 + 0.3 * I, 60);
    if (I > 0.45 && (s === 6 || s === 10)) mTaiko(D, t, 0.25 + 0.25 * I, 68);
    if (I > 0.7 && (s === 3 || s === 13) && Math.random() < 0.7) mTaiko(D, t, 0.22, 64);
  }
  if (I > 0.3 && (s === 12 || (s === 14 && I > 0.5))) mTom(D, t, 0.2 + 0.2 * I, s === 12 ? 105 : 88);
  if (I > 0.2) {
    const acc = s % 4 === 2;
    const p = acc ? 0.95 : s % 2 === 0 ? I * 0.9 : I * I * 0.7;
    if (Math.random() < p) mTick(D, t, (acc ? 0.5 : 0.28) * (0.5 + 0.5 * I));
  }
  if (I > 0.25 && s % 2 === 0) mBass(D, t, NOTE([0, 0, 0, 1, 0, 0, 3, 1][s >> 1], 1), spb * 1.7, 0.3 + 0.25 * I);
  if (I > 0.6 && L.bar % 4 === 3 && s >= 12) mTom(D, t, 0.18 + 0.06 * (s - 12), 140 - (s - 12) * 14);
  if (I > 0.8 && (s === 4 || s === 12) && Math.random() < 0.8) mAnvil(D, t, 0.08);
}

const CHORDS = {
  boss: [[0, 3, 7], [1, 5, 8], [0, 3, 7], [-2, 1, 5]],
  boss2: [[0, 1, 7], [1, 5, 8], [0, 3, 6], [-2, 1, 5]],
};
const BOSS_BASS = [0, 0, 12, 0, 0, 0, 1, 0, 0, 0, 12, 0, 0, 3, 1, 0];

function stepBoss(L, s, t, I, spb) {
  const D = L.bus, X = L.x2;
  const x2 = L.boss2 || t < L.x2OffAt;
  if (s === 0) {
    if (L.bar % 2 === 0) {
      const ch = (L.boss2 ? CHORDS.boss2 : CHORDS.boss)[((L.bar / 2) | 0) % 4];
      L.choir.set(ch.map((n) => NOTE(n, 3)), t);
      L.root = ch[0];
    }
    L.drone.filt.frequency.setTargetAtTime(L.boss2 ? 520 : 320, t, 2);
  }
  const root = L.root || 0;
  if (s === 0 || s === 8) mTaiko(D, t, 0.85, 50);
  if (s === 3 || s === 6 || s === 11 || s === 14) mTaiko(D, t, 0.4 + 0.15 * I, 62);
  if (x2 && s % 2 === 0 && s !== 0 && s !== 8) mTaiko(X, t, 0.35, 72);
  if (x2 && (s === 4 || s === 12)) mAnvil(X, t, 0.12);
  if (s === 0) mBrass(D, t, NOTE(root, 2), spb * 6, 0.32);
  if (s === 10 && (L.bar % 2 === 1 || x2)) mBrass(D, t, NOTE(root + 1, 2), spb * 3, 0.22);
  if (s % 2 === 0 || x2 || I > 0.6) mBass(D, t, NOTE(BOSS_BASS[s], 1), spb * 0.9, 0.35);
  const acc = s % 4 === 2;
  if (Math.random() < (acc ? 1 : 0.45 + 0.4 * I + (x2 ? 0.2 : 0))) mTick(D, t, acc ? 0.5 : 0.3);
  if (L.bar % 4 === 3 && s >= 8 && (s % 2 === 0 || x2)) mTom(D, t, 0.25 + 0.03 * (s - 8), 150 - (s - 8) * 9);
}

const STEP = { explore: stepExplore, combat: stepCombat, boss: stepBoss };

function tick() {
  try {
    if (!ctx) return;
    const now = ctx.currentTime;
    const dt = Math.max(0, now - lastTick);
    lastTick = now;
    musicIntensity += (musicTarget - musicIntensity) * (1 - Math.exp(-dt / 1.2));
    const I = musicIntensity;
    let alive = 0;
    for (const name of Object.keys(layers)) {
      const L = layers[name];
      if (L.dieAt && now > L.dieAt) {
        killLayer(L);
        delete layers[name];
        continue;
      }
      alive++;
      if (L.nextTime < now - 0.1) L.nextTime = now + 0.02;
      while (L.nextTime < now + 0.1) {
        const tb = targetBpm(L, I);
        L.bpm = L.bpm ? L.bpm + (tb - L.bpm) * 0.04 : tb;
        const spb = 60 / L.bpm / 4;
        try { STEP[name](L, L.step, L.nextTime, I, spb); } catch (e) { report('music step', e); }
        L.nextTime += spb;
        if (++L.step >= 16) { L.step = 0; L.bar++; }
      }
    }
    if (!alive && curMusic === 'silence') {
      clearInterval(schedTimer);
      schedTimer = 0;
    }
  } catch (e) {
    report('music', e);
  }
}

function applyMusic() {
  if (!ctx || !musicMode || musicMode === curMusic) return;
  curMusic = musicMode;
  const want = musicMode === 'boss2' ? 'boss' : musicMode;
  for (const name of ['explore', 'combat', 'boss']) fadeLayer(name, name === want);
  const B = layers.boss;
  if (B && want === 'boss') {
    const on = musicMode === 'boss2';
    if (on !== B.boss2) {
      B.boss2 = on;
      if (!on) B.x2OffAt = ctx.currentTime + 2.2;
      ramp(B.x2.gain, on ? 1 : 0.0001, 2);
    }
  }
  if (!schedTimer && want !== 'silence') {
    lastTick = ctx.currentTime;
    schedTimer = setInterval(tick, 25);
    tick();
  }
}

// ---------------------------------------------------------------- core

function build() {
  nyq = ctx.sampleRate * 0.45;
  hasPanner = typeof ctx.createStereoPanner === 'function';
  makeNoise();
  CURVES.soft = makeCurve(1.5);
  CURVES.hard = makeCurve(4);
  CURVES.fuzz = makeCurve(12);
  const G = (val) => { const g = ctx.createGain(); g.gain.value = val; return g; };
  sfxBus = G(1);
  musicBus = G(0.22);
  ambBus = G(0.33);
  duckGain = G(1);
  master = G(masterVol);
  slowLP = ctx.createBiquadFilter();
  slowLP.type = 'lowpass';
  slowLP.frequency.value = Math.min(20000, nyq);
  slowLP.Q.value = 0.707;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 6;
  comp.ratio.value = 12;
  comp.attack.value = 0.002;
  comp.release.value = 0.16;
  sfxBus.connect(master);
  musicBus.connect(duckGain);
  ambBus.connect(duckGain);
  duckGain.connect(master);
  const pre = G(0.5);
  const clip = ctx.createWaveShaper();
  clip.curve = makeClip();
  clip.oversample = '2x';
  master.connect(slowLP);
  slowLP.connect(comp);
  comp.connect(pre);
  pre.connect(clip);
  clip.connect(ctx.destination);
  const conv = ctx.createConvolver();
  conv.buffer = makeIR(1.25);
  verbIn = G(1);
  const ret = G(0.5);
  verbIn.connect(conv);
  conv.connect(ret);
  ret.connect(master);
  const ms = G(0.25);
  musicBus.connect(ms);
  ms.connect(verbIn);
  slowStamp = ctx.currentTime;
  applySlowmo();
}

// iOS needs a sound started inside the gesture to unlock output
function unlock() {
  if (unlocked) return;
  unlocked = true;
  const b = ctx.createBuffer(1, 1, ctx.sampleRate);
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.connect(ctx.destination);
  s.start(0);
}

function slowNow() {
  const t = ctx.currentTime, dt = Math.max(0, t - slowStamp);
  slowStamp = t;
  slowCur += (slowTarget - slowCur) * (1 - Math.exp(-dt / 0.12));
  return slowCur;
}

function applySlowmo() {
  if (!ctx || !slowLP || Math.abs(slowTarget - slowApplied) < 0.004) return;
  slowApplied = slowTarget;
  const now = ctx.currentTime;
  slowLP.frequency.setTargetAtTime(Math.min(20000, nyq) * Math.pow(900 / 20000, slowTarget), now, 0.08);
  slowLP.Q.setTargetAtTime(0.707 + 0.6 * slowTarget, now, 0.08);
}

function canPlay() {
  if (!ctx) return false;
  if (ctx.state === 'running') return true;
  // allow sounds triggered by the same gesture that is resuming the context
  return ctx.state === 'suspended' && nowMs() - resumeAt < 500;
}

export const audio = {
  init() {
    try {
      if (!ctx) {
        if (!AC) return;
        let c;
        try { c = new AC({ latencyHint: 'interactive' }); } catch (e) { c = new AC(); }
        ctx = c;
        try {
          build();
        } catch (e) {
          report('init', e);
          try { c.close(); } catch (_) { /* ignore */ }
          ctx = null;
          return;
        }
        if (ambienceWanted) startAmb();
        if (musicMode) applyMusic();
      }
      if (ctx.state !== 'running' && ctx.state !== 'closed') {
        resumeAt = nowMs();
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      unlock();
    } catch (e) {
      report('init', e);
    }
  },

  get ready() {
    return !!ctx && ctx.state === 'running';
  },

  play(name, opts = {}) {
    try {
      const d = SFX[name];
      if (!d) {
        if (!warned.has(name)) {
          warned.add(name);
          console.warn(`[audio] unknown sound "${name}"`);
        }
        return;
      }
      if (!canPlay()) return;
      if (activeVoices >= MAX_VOICES || (nameCounts[name] || 0) >= d.max) return;
      opts = opts || {};
      let gain = d.gain * (opts.volume ?? 1);
      let pan = 0, lp = 0;
      const pos = opts.pos;
      if (pos) {
        const dx = pos.x - listener.x, dy = (pos.y || 0) - listener.y, dz = pos.z - listener.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!(dist <= CULL_DIST)) return;
        gain *= 1 / (1 + Math.pow(dist / 6, 1.5));
        const h = Math.sqrt(dx * dx + dz * dz);
        if (h > 0.001) {
          const rx = Math.cos(listener.yaw), rz = -Math.sin(listener.yaw);
          pan = clamp((dx * rx + dz * rz) / h, -1, 1) * 0.8 * Math.min(1, h / 1.5);
        }
        if (dist > 12) lp = Math.max(1800, 20000 / (1 + (dist - 12) / 6));
      }
      if (!(gain > 0.003)) return;
      const rate = Number.isFinite(opts.rate) && opts.rate > 0 ? opts.rate : 1;
      const P = clamp(rate * (1 - 0.35 * slowNow()) * rnd(0.98, 1.02), 0.25, 4);
      const v = new Voice(name, gain, pan, d.verb, lp);
      v.P = P;
      v.T = clamp(1 / P, 0.4, 2.5);
      activeVoices++;
      nameCounts[name] = (nameCounts[name] || 0) + 1;
      try {
        d.fn(v);
      } catch (e) {
        v.free();
        report(`play ${name}`, e);
        return;
      }
      v.arm();
    } catch (e) {
      report('play', e);
    }
  },

  setListener(pos, yaw) {
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
      listener.x = pos.x;
      listener.y = Number.isFinite(pos.y) ? pos.y : 0;
      listener.z = pos.z;
    }
    if (Number.isFinite(yaw)) listener.yaw = yaw;
  },

  startAmbience() {
    ambienceWanted = true;
    try { startAmb(); } catch (e) { report('ambience', e); }
  },

  setMusicMode(mode) {
    if (!MODES.includes(mode)) {
      if (!warned.has('mode:' + mode)) {
        warned.add('mode:' + mode);
        console.warn(`[audio] unknown music mode "${mode}"`);
      }
      return;
    }
    musicMode = mode;
    try { applyMusic(); } catch (e) { report('music', e); }
  },

  setMusicIntensity(x) {
    if (Number.isFinite(x)) musicTarget = clamp(x, 0, 1);
  },

  setSlowmo(amount) {
    try {
      const a = Number.isFinite(amount) ? clamp(amount, 0, 1) : 0;
      if (ctx) slowNow();
      slowTarget = a;
      applySlowmo();
    } catch (e) {
      report('slowmo', e);
    }
  },

  setMasterVolume(v) {
    if (!Number.isFinite(v)) return;
    masterVol = clamp(v, 0, 1);
    try {
      if (ctx && master) master.gain.setTargetAtTime(masterVol, ctx.currentTime, 0.05);
    } catch (e) {
      report('volume', e);
    }
  },

  duck(amount = 0.5, seconds = 0.3) {
    try {
      if (!ctx || !duckGain || !Number.isFinite(amount) || !Number.isFinite(seconds)) return;
      const now = ctx.currentTime;
      amount = clamp(amount, 0, 0.95);
      const until = now + clamp(seconds, 0.02, 10);
      const active = now < duckEnd;
      if (active && duckDepth >= amount && duckEnd >= until) return;
      duckDepth = active ? Math.max(duckDepth, amount) : amount;
      duckEnd = active ? Math.max(duckEnd, until) : until;
      const g = duckGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(1 - duckDepth, now + 0.03);
      g.setValueAtTime(1 - duckDepth, Math.max(duckEnd, now + 0.03));
      g.linearRampToValueAtTime(1, Math.max(duckEnd, now + 0.03) + 0.35);
    } catch (e) {
      report('duck', e);
    }
  },
};
