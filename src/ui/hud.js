import * as THREE from 'three';
// DOM HUD: health/focus, freeflow combo counter, boss bars, banners, prompts and menus.
const _pv = new THREE.Vector3();

const PROMPTS = {
  kbm: { light: 'LMB', heavy: 'RMB', parry: 'Q', dodge: 'SHIFT', jump: 'SPACE', throw: 'F', lock: 'TAB / MMB', art: 'E', pause: 'ESC', restart: 'R' },
  pad: { light: '□', heavy: '△', parry: 'L2', dodge: '○', jump: '✕', throw: 'R1', lock: 'L1 (hold) / R3', art: 'R2', pause: 'OPTIONS', restart: 'CREATE' },
};

export class HUD {
  constructor(game) {
    this.game = game;
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'), hp: $('hp-fill'), hpLag: $('hp-lag'), focus: $('focus-fill'), focusWrap: $('focus'),
      combo: $('combo'), comboNum: $('combo-num'), comboLabel: $('combo-label'),
      boss: $('boss'), bossName: $('boss-name'), bossHp: $('boss-hp-fill'), bossHpLag: $('boss-hp-lag'), posture: $('boss-posture-fill'),
      banner: $('banner'), bannerTitle: $('banner-title'), bannerSub: $('banner-sub'),
      prompt: $('prompt'), hint: $('hint'),
      title: $('title'), pause: $('pause'), death: $('death'), victory: $('victory'),
      controls: document.querySelectorAll('.controls'), fps: $('fps'), wave: $('wave'),
      guard: $('guard'), guardFill: $('guard-fill'), knives: document.querySelectorAll('#knives b'),
    };
    this.hpLag = 1;
    this.bossLag = 1;
    this.comboShown = 0;
    this.bannerT = 0;
    this.hintT = 0;
    this.hints = [];
    this.device = null;
    this.frames = 0; this.fpsT = 0;
    this.showFps = false;
    this.popups = [];
    this.popWrap = document.getElementById('popups');
    this.threatWrap = document.getElementById('threats');
    this.threatEls = [];
    this.lockEl = document.getElementById('lockon');
    this.lockFill = this.lockEl.querySelector('.lhp-fill');
    this.lockTag = this.lockEl.querySelector('.ltag');
    this.sb = document.getElementById('screenblood');
    this.sbx = this.sb.getContext('2d');
    this.sbAlpha = 0;
    const fit = () => { this.sb.width = Math.floor(window.innerWidth / 2); this.sb.height = Math.floor(window.innerHeight / 2); };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('keydown', (e) => { if (e.code === 'Backquote') { this.showFps = !this.showFps; this.el.fps.style.display = this.showFps ? 'block' : 'none'; } });
  }

  key(action) { return PROMPTS[this.game.input.device === 'pad' ? 'pad' : 'kbm'][action]; }

  renderControls() {
    const d = this.game.input.device === 'pad' ? 'pad' : 'kbm';
    if (d === this.device) return;
    this.device = d;
    const P = PROMPTS[d];
    const rows = [
      ['Move', d === 'pad' ? 'Left stick' : 'WASD'], ['Camera', d === 'pad' ? 'Right stick' : 'Mouse'],
      ['Strike (freeflow combo)', P.light], ['Heavy · breaks guards · executes', P.heavy], ['Parry (tap) / Block (hold)', P.parry],
      ['Dodge (toward foe: vault)', P.dodge], ['Jump (double jump)', P.jump], ['Throwing knife', P.throw], ['Lock-on', P.lock],
      ['Blood Art (costs focus)', P.art], ['In air: ground pound', P.art], ['8+ combo: special takedown', P.heavy],
    ];
    const html = rows.map(([a, k]) => `<div class="row"><span class="act">${a}</span><span class="key">${k}</span></div>`).join('');
    this.el.controls.forEach((c) => (c.innerHTML = html));
  }

  banner(title, sub = '', dur = 2.6) {
    this.el.bannerTitle.textContent = title;
    this.el.bannerSub.textContent = sub;
    this.el.banner.classList.remove('show');
    void this.el.banner.offsetWidth;
    this.el.banner.classList.add('show');
    this.bannerT = dur;
  }

  hint(text, dur = 4) {
    this.hints.push({ text, dur });
  }

  popup(text, worldPos, color = '#fff', scale = 1) {
    const el = document.createElement('div');
    el.className = 'popup';
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = `${18 * scale}px`;
    this.popWrap.appendChild(el);
    this.popups.push({ el, pos: worldPos.clone(), t: 0, life: 0.9 });
    if (this.popups.length > 8) { const o = this.popups.shift(); o.el.remove(); }
  }

  // blood splattered across the lens
  screenBlood(amount = 0.5) {
    const c = this.sbx, W = this.sb.width, H = this.sb.height;
    const n = Math.floor(4 + amount * 10);
    for (let i = 0; i < n; i++) {
      const edge = Math.random() < 0.7;
      const x = edge ? (Math.random() < 0.5 ? Math.random() * W * 0.25 : W - Math.random() * W * 0.25) : Math.random() * W;
      const y = Math.random() * H;
      const r = (8 + Math.random() * 40) * (0.5 + amount);
      c.fillStyle = `rgba(${90 + Math.random() * 60 | 0}, 0, 0, ${0.55 + Math.random() * 0.4})`;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
      for (let k = 0; k < 8; k++) {
        const a = Math.random() * Math.PI * 2, d = r * (0.8 + Math.random() * 1.6);
        c.beginPath();
        c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.08 + Math.random() * 0.25), 0, Math.PI * 2);
        c.fill();
      }
      // drip
      if (Math.random() < 0.6) { c.fillRect(x - r * 0.12, y, r * 0.24, r * (1 + Math.random() * 3)); }
    }
    this.sbAlpha = Math.min(1, this.sbAlpha + amount);
    this.sb.style.opacity = this.sbAlpha;
  }

  flashFocus() {
    this.el.focusWrap.classList.remove('denied');
    void this.el.focusWrap.offsetWidth;
    this.el.focusWrap.classList.add('denied');
  }

  comboHit(n) {
    this.el.combo.classList.add('show');
    this.el.comboNum.textContent = n;
    this.el.comboNum.classList.remove('pop');
    void this.el.comboNum.offsetWidth;
    this.el.comboNum.classList.add('pop');
    this.el.combo.style.setProperty('--heat', Math.min(1, n / 30).toFixed(2));
    this.el.comboLabel.textContent = n >= 20 ? 'UNSTOPPABLE' : n >= 12 ? 'MASSACRE' : n >= 6 ? 'BRUTAL' : 'HITS';
  }
  comboEnd(broken = false) {
    this.el.combo.classList.remove('show');
    if (broken) this.el.combo.classList.add('broken');
    setTimeout(() => this.el.combo.classList.remove('broken'), 400);
  }

  showBoss(name) { this.el.bossName.textContent = name; this.el.boss.classList.add('show'); }
  hideBoss() { this.el.boss.classList.remove('show'); }

  setScreen(name) {
    for (const k of ['title', 'pause', 'death', 'victory']) this.el[k].classList.toggle('show', k === name);
    this.el.hud.classList.toggle('hidden', name === 'title');
  }

  update(dt) {
    const g = this.game, p = g.player;
    this.renderControls();
    // fps
    this.frames++; this.fpsT += g.time.realDt;
    if (this.fpsT > 0.5) { if (this.showFps) this.el.fps.textContent = `${Math.round(this.frames / this.fpsT)} fps`; this.frames = 0; this.fpsT = 0; }
    if (!p) return;
    const hp = Math.max(0, p.hp / p.maxHp);
    this.hpLag = this.hpLag > hp ? Math.max(hp, this.hpLag - dt * 0.35) : hp;
    this.el.hp.style.transform = `scaleX(${hp})`;
    this.el.hpLag.style.transform = `scaleX(${this.hpLag})`;
    this.el.focus.style.transform = `scaleX(${p.focus / 100})`;
    const gd = Math.max(0, p.guard / 100);
    this.el.guardFill.style.transform = `scaleX(${gd})`;
    this.el.guard.classList.toggle('show', gd < 0.99 || p.state === 'block');
    this.el.guard.classList.toggle('low', gd < 0.35);
    this.el.knives.forEach((k, i) => k.classList.toggle('empty', i >= p.knives));
    this.el.focusWrap.classList.toggle('full', p.focus >= 100);
    // boss
    const b = g.director.boss;
    if (b && this.el.boss.classList.contains('show')) {
      const bh = Math.max(0, b.hp / b.maxHp);
      this.bossLag = this.bossLag > bh ? Math.max(bh, this.bossLag - dt * 0.25) : bh;
      this.el.bossHp.style.transform = `scaleX(${bh})`;
      this.el.bossHpLag.style.transform = `scaleX(${this.bossLag})`;
      this.el.posture.style.transform = `scaleX(${b.posture / b.maxPosture})`;
      this.el.posture.parentElement.classList.toggle('hot', b.posture > 75 || b.state === 'broken');
    }
    // popups follow their world point
    const cam = g.camera;
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const pp = this.popups[i];
      pp.t += dt;
      const v = _pv.copy(pp.pos);
      v.y += 0.3 + pp.t * 0.6;
      v.project(cam);
      const k = pp.t / pp.life;
      if (k >= 1 || v.z > 1) { pp.el.remove(); this.popups.splice(i, 1); continue; }
      const x = (v.x * 0.5 + 0.5) * window.innerWidth, y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      const sc = k < 0.12 ? 1.6 - k * 5 : 1;
      pp.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${sc})`;
      pp.el.style.left = '0px'; pp.el.style.top = '0px';
      pp.el.style.opacity = String(1 - Math.max(0, (k - 0.6) / 0.4));
    }
    // arrows at the screen edge for attackers winding up off-screen
    let ti = 0;
    if (p.alive) for (const e of g.enemies) {
      if (!e.alive) continue;
      const ttl = e.timeToHit();
      if (!(ttl < 0.7) || e.distTo(p) > 7) continue;
      const v = _pv.copy(e.body.pos); v.y += 1.2;
      v.project(cam);
      const behind = v.z > 1;
      let x = v.x, y = v.y;
      if (behind) { x = -x; y = -y; }
      if (!behind && Math.abs(x) < 0.92 && Math.abs(y) < 0.9) continue;
      const a = Math.atan2(y, x);
      const W = window.innerWidth, H = window.innerHeight;
      const k = Math.min(0.88 * W / 2 / Math.max(1e-3, Math.abs(Math.cos(a) * W / 2)), 0.85 * H / 2 / Math.max(1e-3, Math.abs(Math.sin(a) * H / 2)));
      const sx = W / 2 + Math.cos(a) * W / 2 * k, sy = H / 2 - Math.sin(a) * H / 2 * k;
      let el = this.threatEls[ti];
      if (!el) { el = document.createElement('div'); el.className = 'threat'; this.threatWrap.appendChild(el); this.threatEls.push(el); }
      el.style.display = 'block';
      el.style.transform = `translate(${sx - 12}px, ${sy - 11}px) rotate(${-a + Math.PI / 2}rad)`;
      el.classList.toggle('red', !!(e.clip && (e.clip.unblockable || e.clip.perilous)));
      el.classList.toggle('now', ttl <= e.parryWindow());
      ti++;
    }
    for (let i = ti; i < this.threatEls.length; i++) this.threatEls[i].style.display = 'none';
    // lock-on marker with the target's health and stance
    const L = p.lock && p.lock.alive && !p.lock.isBoss ? p.lock : null;
    if (L) {
      const v = _pv.copy(L.body.pos);
      v.y += 2.15 * L.rig.scale;
      v.project(cam);
      if (v.z < 1) {
        const x = (v.x * 0.5 + 0.5) * window.innerWidth, y = (-v.y * 0.5 + 0.5) * window.innerHeight;
        this.lockEl.style.transform = `translate(${x - 32}px, ${y - 10}px)`;
        this.lockFill.style.transform = `scaleX(${Math.max(0, L.hp / L.maxHp)})`;
        const guard = (L.guardUp || L.T.shield) && !L.isOpen();
        const open = L.canBeExecuted();
        this.lockEl.classList.toggle('guard', guard && !open);
        this.lockEl.classList.toggle('open', open);
        const tag = open ? 'OPEN' : guard ? 'GUARDING' : '';
        if (tag !== this._ltag) { this._ltag = tag; this.lockTag.textContent = tag; }
      }
    }
    this.lockEl.classList.toggle('show', !!L);
    // lens blood fades and runs
    if (this.sbAlpha > 0) {
      this.sbAlpha = Math.max(0, this.sbAlpha - dt * 0.28);
      this.sb.style.opacity = this.sbAlpha;
      if (this.sbAlpha <= 0) this.sbx.clearRect(0, 0, this.sb.width, this.sb.height);
    }
    // banner
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) this.el.banner.classList.remove('show'); }
    // hints
    if (this.hintT > 0) { this.hintT -= dt; if (this.hintT <= 0) this.el.hint.classList.remove('show'); }
    else if (this.hints.length && this.bannerT <= 0.5) {
      const h = this.hints.shift();
      this.el.hint.innerHTML = h.text.replace(/\{(\w+)\}/g, (_, a) => `<b>${this.key(a)}</b>`);
      this.el.hint.classList.add('show');
      this.hintT = h.dur;
    }
    // execute prompt
    let prompt = '';
    if (p.alive && p.state !== 'execute') {
      const t = g.nearestExecutable(p, 4.2);
      if (t) prompt = `<b>${this.key('heavy')}</b> ${t.isBoss ? (t.state === 'finished' ? 'FINISH HIM' : 'DEATHBLOW') : 'EXECUTE'}`;
      if (!prompt && p.combo >= p.specialAt && p.alive) prompt = `<b>${this.key('heavy')}</b> SPECIAL TAKEDOWN`;
      if (!prompt && p.lock && p.lock.alive && p.lock.guardUp && !p.lock.isOpen()) prompt = `GUARDING · <b>${this.key('heavy')}</b> BREAK`;
    }
    if (prompt !== this._prompt) { this._prompt = prompt; this.el.prompt.innerHTML = prompt; this.el.prompt.classList.toggle('show', !!prompt); }
    // wave counter
    const d = g.director;
    const w = d.phase === 'boss' ? 'THE WARDEN' : d.wave >= 0 ? `WAVE ${d.wave + 1}/${d.waveCount}` : '';
    if (w !== this._wave) { this._wave = w; this.el.wave.textContent = w; }
  }
}
