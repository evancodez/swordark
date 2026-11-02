import * as THREE from 'three';
import { Character } from './character.js';
import { Rig, buildSword, buildShield } from './rig.js';
import { GRUNT, BRUTE, ENEMY_GUARD, ENEMY_GUARD_UP } from './clips.js';
import { clamp, damp, dampAngle, rand, pick, wrapAngle, ease } from '../core/math.js';
import { RAMPART_Y } from '../world/level.js';

export const TYPES = {
  grunt: { look: 'grunt', hp: 130, sword: 'grunt', scale: 1.0, speed: 4.8, parryWindow: 0.42, attacks: ['slash', 'slash', 'thrust', 'combo'] },
  shield: { look: 'shield', hp: 150, sword: 'grunt', scale: 1.02, speed: 4.2, parryWindow: 0.42, shield: true, attacks: ['slash', 'thrust'] },
  thrower: { look: 'thrower', hp: 70, sword: 'knife', scale: 0.97, speed: 5.2, parryWindow: 0.4, ranged: true, attacks: ['slash'] },
  brute: { look: 'brute', hp: 380, sword: 'brute', scale: 1.24, speed: 3.6, parryWindow: 0.38, armor: true, attacks: ['overhead', 'sweep', 'sweep'] },
};

let indicatorTex = null;
function getIndicatorTex() {
  if (indicatorTex) return indicatorTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  // four-point star glint
  x.fillStyle = '#fff';
  x.beginPath();
  x.moveTo(64, 2); x.lineTo(70, 58); x.lineTo(126, 64); x.lineTo(70, 70); x.lineTo(64, 126); x.lineTo(58, 70); x.lineTo(2, 64); x.lineTo(58, 58);
  x.closePath();
  x.fill();
  indicatorTex = new THREE.CanvasTexture(c);
  return indicatorTex;
}

export class Enemy extends Character {
  constructor(game, type, variant = 0) {
    const T = TYPES[type];
    const rig = new Rig(T.look, { scale: T.scale, variant, rim: 0.4 });
    super(game, rig, {
      hp: T.hp, radius: type === 'brute' ? 0.36 : 0.33, guard: ENEMY_GUARD, stepVol: 0.6,
      trail: { color: [0.35, 0.33, 0.3], edge: [1.0, 0.95, 0.9], life: 0.11 },
    });
    this.type = type;
    this.T = T;
    this.team = 'enemy';
    rig.attachSword(buildSword(T.sword));
    if (T.shield) {
      this.shield = buildShield();
      this.shield.position.set(0.05, -0.12, 0.02);
      this.shield.rotation.set(0, Math.PI / 2, 0);
      rig.bones['hand.L'].add(this.shield);
    }
    this.speed = T.speed * rand(0.92, 1.08);
    this.token = false;
    this.ringR = rand(3.4, 5.2);
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeT = rand(1.5, 3.5);
    this.thinkT = rand(0.3, 1.5);
    this.attackCD = rand(0.8, 2.5);
    this.clip = null;
    this.struck = false;
    this.lightHits = 0;
    this.spawning = false;
    this.corpseT = 0;
    // indicator
    this.indicator = new THREE.Sprite(new THREE.SpriteMaterial({ map: getIndicatorTex(), color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    this.indicator.visible = false;
    this.indicator.renderOrder = 20;
    game.scene.add(this.indicator);
    this.setState('idle');
  }

  get isBoss() { return false; }
  canBeExecuted() {
    return this.alive && this.state !== 'victim' && (this.state === 'parried' || (this.openT || 0) > 0 || this.hp <= this.maxHp * 0.22 || this.state === 'confused' || this.state === 'wallsplat');
  }

  spawnAt(pos, mode) {
    this.body.pos.copy(pos);
    const p = this.game.player.body.pos;
    this.yaw = this.yawTo(p.x, p.z);
    this.spawning = true;
    this.spawnMode = mode;
    this.setState('spawn');
    if (mode === 'leap') {
      // leap down from the rampart toward the courtyard
      const dir = new THREE.Vector3(-Math.sign(pos.x), 0, 0);
      this.yaw = Math.atan2(dir.x, dir.z);
      this.body.vel.set(dir.x * 4.2, 5.5, 0);
      this.body.grounded = false;
      this.game.audio.play('jump', { pos, volume: 0.5 });
    } else if (mode === 'door') {
      this.spawnDir = new THREE.Vector3(-pos.x, 0, -pos.z).normalize();
      this.yaw = Math.atan2(this.spawnDir.x, this.spawnDir.z);
      this.game.level.pulseGate && this.game.level.pulseGate(pos);
    }
  }

  // ---------- update ----------
  update(dt) {
    this.stateT += dt;
    this.attackCD -= dt;
    this.openT = Math.max(0, (this.openT || 0) - dt);
    this.thinkT -= dt;
    const g = this.game, p = g.player;
    if (!this.alive) {
      this.indicator.visible = false;
      this.animate(dt);
      this.corpseT += dt;
      return;
    }
    this.combat = true;
    let grav = 24;
    switch (this.state) {
      case 'spawn': this.stSpawn(dt); break;
      case 'idle': case 'circle': case 'approach': case 'block': this.stThink(dt); break;
      case 'attack': this.stAttack(dt); break;
      case 'throw': this.stThrow(dt); break;
      case 'stagger': case 'hitstun': this.stStagger(dt); break;
      case 'parried': this.stParried(dt); break;
      case 'down': this.stDown(dt); break;
      case 'airborne': grav = this.stAirborne(dt); break;
      case 'wallsplat': this.stWallsplat(dt); break;
      case 'confused': this.stConfused(dt); break;
      case 'victim': this.body.vel.set(0, 0, 0); break;
      case 'leapup': this.stLeapUp(dt); break;
    }
    if (this.state !== 'victim') this.physics(dt, grav);
    if (this.body.landed && this.state === 'spawn') { this.anim.land.v += 4; g.audio.play('land', { pos: this.body.pos, volume: 0.6 }); g.fx.dustPuff(this.body.pos, 5); }
    // fell a long way (kicked off ramparts)
    if (this.body.landed && (this.body.landSpeed || 0) > 11 && this.state !== 'spawn') {
      this.takeDamage({ dmg: (this.body.landSpeed - 9) * 12, kind: 'fall', dir: new THREE.Vector3(0, -1, 0), point: this.center(new THREE.Vector3()) });
    }
    this.anim.footMode = this.state === 'victim' ? 'ground' : (this.body.grounded ? 'gait' : 'air');
    this.anim.combatStance = true;
    this.updateLean(dt);
    // look at player
    if (p.alive && this.state !== 'victim') {
      const a = clamp(this.angleTo(p), -1, 1);
      this.anim.lookYaw = damp(this.anim.lookYaw, a * 0.8, 6, dt);
    }
    this.animate(dt);
    this.updateIndicator(dt);
  }

  // ---------- states ----------
  stSpawn(dt) {
    if (this.spawnMode === 'door') {
      const sp = 3.8;
      this.body.vel.x = this.spawnDir.x * sp;
      this.body.vel.z = this.spawnDir.z * sp;
      if (this.stateT > 0.9) this.finishSpawn();
    } else if (this.body.grounded && this.stateT > 0.2) {
      this.body.vel.x = damp(this.body.vel.x, 0, 10, dt);
      this.body.vel.z = damp(this.body.vel.z, 0, 10, dt);
      if (this.stateT > 0.6) this.finishSpawn();
    }
  }
  finishSpawn() {
    this.spawning = false;
    this.setState('circle');
    this.rollGuard();
    if (this.T.shield) this.raiseShield();
  }
  // decide whether this enemy keeps its guard up (blocks light attacks from the front)
  rollGuard(bonus = 0) {
    if (this.T.shield) { this.guardUp = true; return; }
    if (this.type !== 'grunt') { this.guardUp = false; return; }
    this.guardUp = Math.random() < (this.game.director.guardChance ?? 0.4) + bonus;
  }
  isOpen() {
    return ['attack', 'throw', 'stagger', 'parried', 'down', 'airborne', 'wallsplat', 'confused', 'leapup', 'spawn'].includes(this.state) ||
      (this.state === 'hitstun' && (this.comboTaken || 0) < 3);
  }
  raiseShield() {
    this.anim.playClip(GRUNT.shieldUp, { blendIn: 0.15 });
    this.setState('block');
  }

  onRampart(p) { return p.y > RAMPART_Y - 0.5 && Math.abs(p.x) > 11.2; }

  // Where to walk to reach the player (stairs for ramparts)
  navGoal(out) {
    const p = this.game.player.body.pos, me = this.body.pos;
    out.copy(p);
    if (this.onRampart(p) && !this.onRampart(me)) {
      const west = p.x < 0;
      const bottom = west ? _wb : _eb2, top = west ? _wt : _et;
      const onStair = west ? (me.z > 14.4 && me.x < -5.2) : (me.z < -10.2 && me.x > 5.2);
      if (onStair || Math.hypot(me.x - bottom.x, me.z - bottom.z) < 1.2) out.copy(top);
      else out.copy(bottom);
      return 'nav';
    }
    return 'direct';
  }

  stThink(dt) {
    const g = this.game, p = g.player;
    const b = this.body;
    if (!p.alive) {
      b.vel.x = damp(b.vel.x, 0, 6, dt); b.vel.z = damp(b.vel.z, 0, 6, dt);
      return;
    }
    const mode = this.navGoal(_goal);
    const goal = _goal;
    const dx = goal.x - b.pos.x, dz = goal.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    const pd = this.distTo(p);
    const dy = p.body.pos.y - b.pos.y;
    const reach = this.T.ranged ? 1.8 : (this.type === 'brute' ? 2.3 : 1.9);

    // ranged: keep distance and throw
    if (this.T.ranged) return this.thinkRanged(dt, pd, dy);

    // want to attack?
    if (!this.token && this.attackCD <= 0 && pd < 7 && Math.abs(dy) < 1.2) this.token = g.director.requestToken(this);
    let tx = 0, tz = 0, speed = 0;
    if (mode === 'nav') {
      tx = dx / d; tz = dz / d; speed = this.speed;
      this.faceTo(goal.x, goal.z, 10, dt);
    } else if (this.token) {
      if (pd > reach) {
        tx = dx / d; tz = dz / d;
        speed = this.speed * (pd > 4 ? 1 : 0.75);
        this.faceTo(p.body.pos.x, p.body.pos.z, 10, dt);
        // player stands on something higher: leap up
        if (dy > 0.5 && dy < 3.2 && pd < 4.0 && b.grounded) { this.leapUp(p.body.pos); return; }
      } else if (Math.abs(dy) < 1.0) {
        this.startAttack();
        return;
      }
    } else {
      // circle around the player at ring distance, strafe, occasionally shuffle
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeT = rand(1.5, 3.5); if (Math.random() < 0.6) this.strafeDir *= -1; this.ringR = rand(3.4, 5.4); }
      const ang = Math.atan2(b.pos.x - p.body.pos.x, b.pos.z - p.body.pos.z);
      const radial = pd - this.ringR;
      const rx = Math.sin(ang), rz = Math.cos(ang);
      tx = -rx * clamp(radial, -1, 1) + rz * this.strafeDir * 0.55;
      tz = -rz * clamp(radial, -1, 1) - rx * this.strafeDir * 0.55;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      speed = Math.abs(radial) > 1.5 ? this.speed * 0.9 : 1.5;
      this.faceTo(p.body.pos.x, p.body.pos.z, 8, dt);
      if (dy > 0.5 && dy < 3.2 && pd < 4.5 && b.grounded && Math.random() < dt * 0.35) { this.leapUp(p.body.pos); return; }
    }
    // separation from other enemies
    for (const o of g.enemies) {
      if (o === this || !o.alive) continue;
      const ox = b.pos.x - o.body.pos.x, oz = b.pos.z - o.body.pos.z;
      const od = Math.hypot(ox, oz);
      if (od < 1.4 && od > 1e-3) { tx += (ox / od) * (1.4 - od) * 1.5; tz += (oz / od) * (1.4 - od) * 1.5; }
    }
    const tl = Math.hypot(tx, tz);
    if (tl > 1) { tx /= tl; tz /= tl; }
    const acc = 22 * dt;
    b.vel.x += clamp(tx * speed - b.vel.x, -acc, acc);
    b.vel.z += clamp(tz * speed - b.vel.z, -acc, acc);
    // shield lowered when running
    if (this.T.shield) {
      const run = Math.hypot(b.vel.x, b.vel.z) > 2.5;
      if (run && this.state === 'block') { this.anim.stopClip(0.2); this.setState('approach'); }
      else if (!run && this.state !== 'block' && !this.token) this.raiseShield();
    }
  }

  thinkRanged(dt, pd, dy) {
    const g = this.game, p = g.player, b = this.body;
    this.faceTo(p.body.pos.x, p.body.pos.z, 8, dt);
    let tx = 0, tz = 0, speed = 0;
    const ang = Math.atan2(b.pos.x - p.body.pos.x, b.pos.z - p.body.pos.z);
    if (pd < 3.5) {
      // back off along the rampart / away
      tx = Math.sin(ang); tz = Math.cos(ang); speed = this.speed * 0.8;
      if (pd < 1.8 && this.attackCD <= 0 && Math.abs(dy) < 1) { this.startAttack(); return; }
    } else if (pd > 13) {
      const dx = p.body.pos.x - b.pos.x, dz = p.body.pos.z - b.pos.z;
      tx = dx / pd; tz = dz / pd; speed = this.speed * 0.6;
    } else {
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeT = rand(1, 2.5); this.strafeDir *= -1; }
      tx = Math.cos(ang) * this.strafeDir * 0.4; tz = -Math.sin(ang) * this.strafeDir * 0.4; speed = 1.2;
    }
    if (this.attackCD <= 0 && pd > 3.5 && pd < 22) {
      _h.copy(b.pos).setY(b.pos.y + 1.5);
      _h2.copy(p.body.pos).setY(p.body.pos.y + 1.2);
      if (g.world.lineOfSight(_h, _h2)) {
        this.noLos = 0;
        if (g.director.requestThrow(this)) { this.startThrow(); return; }
      } else this.noLos = (this.noLos || 0) + dt;
    }
    // no clear shot: relocate along the rampart
    if ((this.noLos || 0) > 1.2 && this.onRampart(b.pos)) {
      if (this.relocZ === undefined || Math.abs(b.pos.z - this.relocZ) < 0.5) this.relocZ = clamp(p.body.pos.z + rand(-7, 7), -10, 14.5);
      tz = Math.sign(this.relocZ - b.pos.z); tx = 0; speed = this.speed * 0.8;
      this.faceTo(b.pos.x, this.relocZ, 8, dt);
      if (this.noLos > 4) { this.noLos = 0; this.relocZ = undefined; }
    }
    // don't walk off rampart edges
    if (this.onRampart(b.pos)) {
      const edge = Math.sign(b.pos.x) * 11.7;
      if (Math.abs(b.pos.x + tx * 0.5) < Math.abs(edge)) tx = 0;
    }
    const acc = 18 * dt;
    b.vel.x += clamp(tx * speed - b.vel.x, -acc, acc);
    b.vel.z += clamp(tz * speed - b.vel.z, -acc, acc);
  }

  // Jump up onto whatever the player is standing on, landing beside them (not on top of them).
  leapUp(target) {
    const b = this.body, w = this.game.world;
    const dx = b.pos.x - target.x, dz = b.pos.z - target.z, d = Math.hypot(dx, dz) || 1;
    let lx = target.x + (dx / d) * 0.95, lz = target.z + (dz / d) * 0.95;
    if (w.groundHeight(lx, lz, target.y + 0.3, 0.15) < target.y - 0.25) { lx = target.x + (dx / d) * 0.4; lz = target.z + (dz / d) * 0.4; }
    const rise = Math.max(0.4, target.y - b.pos.y) + 0.65;
    const g = 24;
    b.vel.y = Math.sqrt(2 * g * rise);
    const T = b.vel.y / g + Math.sqrt(2 * 0.65 / g);
    b.vel.x = (lx - b.pos.x) / T;
    b.vel.z = (lz - b.pos.z) / T;
    b.grounded = false;
    this.yaw = this.yawTo(target.x, target.z);
    this.setState('leapup');
    this.game.audio.play('jump', { pos: b.pos, volume: 0.5 });
  }
  stLeapUp() {
    if (this.body.grounded && this.stateT > 0.1) this.setState('circle');
  }

  chooseAttack() {
    const a = pick(this.T.attacks);
    if (this.type === 'brute') return { clip: BRUTE[a], combo: null };
    if (a === 'combo') return { clip: GRUNT.slash, combo: GRUNT.slash2 };
    return { clip: GRUNT[a], combo: null };
  }

  startAttack() {
    const { clip, combo } = this.chooseAttack();
    this.playEnemyClip(clip);
    this.comboNext = combo;
  }
  playEnemyClip(clip, speed = 1) {
    this.armored = false;
    this.clip = clip;
    this.struck = false;
    this.struck2 = false;
    this.whooshed = false;
    this.setState('attack');
    this.anim.playClip(clip, { blendIn: 0.08, speed });
    this.g = this.game;
  }

  // seconds until the current strike lands (or Infinity)
  timeToHit() {
    if (this.state !== 'attack' && this.state !== 'throw') return Infinity;
    if (!this.clip || this.struck) return Infinity;
    return (this.clip.hitAt - this.anim.clipT) / Math.max(0.01, this.anim.clipSpeed);
  }

  stAttack(dt) {
    const g = this.game, p = g.player, clip = this.clip, b = this.body;
    const t = this.anim.clipT;
    // track the player during windup, commit near the strike
    if (t < clip.hitAt - 0.16) this.faceTo(p.body.pos.x, p.body.pos.z, 7, dt);
    // lunge
    if (clip.lunge && t >= clip.lunge[0] && t <= clip.lunge[1]) {
      const span = clip.lunge[1] - clip.lunge[0];
      const u = (t - clip.lunge[0]) / span;
      // step in to the distance where this swing's arc passes through the target
      const remain = Math.max(0.05, (clip.lunge[1] - t) / this.anim.clipSpeed);
      const v = clamp((this.distTo(p) - (clip.range ?? 1.2)) / remain, -2.5, 9) * Math.min(1, u * 4 + 0.3);
      b.vel.x = Math.sin(this.yaw) * v;
      b.vel.z = Math.cos(this.yaw) * v;
    } else {
      b.vel.x = damp(b.vel.x, 0, 12, dt);
      b.vel.z = damp(b.vel.z, 0, 12, dt);
    }
    this.trailOn = t > clip.hitAt - 0.08 && t < clip.hitAt + 0.1;
    if (!this.whooshed && t > clip.hitAt - 0.07) {
      this.whooshed = true;
      g.audio.play(this.type === 'brute' ? 'whoosh_heavy' : 'whoosh_light', { pos: b.pos, rate: this.type === 'brute' ? 0.8 : 1 });
    }
    // the swing connects only if the blade reaches you during its active window
    if (!this.struck && t >= clip.hitAt - 0.05) {
      const r = t <= clip.hitAt + 0.11 ? g.enemyBladeSweep(this, clip) : null;
      if (r || t > clip.hitAt + 0.11) this.struck = true;
      if (this.state !== 'attack') return;
    }
    if (clip.hitAt2 && !this.struck2 && t >= clip.hitAt2 - 0.05) {
      const r = t <= clip.hitAt2 + 0.11 ? g.enemyBladeSweep(this, clip) : null;
      if (r || t > clip.hitAt2 + 0.11) this.struck2 = true;
    }
    if (this.comboNext && t >= clip.hitAt + 0.06) {
      const next = this.comboNext;
      this.comboNext = null;
      this.playEnemyClip(next);
      this.anim.from.copy(this.anim.final);
      return;
    }
    if (t >= clip.dur - 0.1) this.endAttack();
  }
  endAttack() {
    this.trailOn = false;
    this.anim.stopClip(0.2);
    this.releaseToken();
    this.attackCD = rand(1.0, 2.4) * (this.type === 'brute' ? 1.3 : 1) * (this.game.director.aggro ?? 1);
    this.setState('circle');
    if (Math.random() < 0.5) this.rollGuard();
    if (this.T.shield) this.raiseShield();
  }
  releaseToken() {
    if (this.token) { this.game.director.releaseToken(this); this.token = false; }
  }

  startThrow() {
    this.clip = GRUNT.throwKnife;
    this.struck = false;
    this.setState('throw');
    this.anim.playClip(GRUNT.throwKnife, { blendIn: 0.1 });
  }
  stThrow(dt) {
    const g = this.game, p = g.player;
    const t = this.anim.clipT;
    this.body.vel.x = damp(this.body.vel.x, 0, 10, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 10, dt);
    if (t < this.clip.hitAt - 0.1) this.faceTo(p.body.pos.x, p.body.pos.z, 10, dt);
    if (!this.struck && t >= this.clip.hitAt) {
      this.struck = true;
      g.throwKnife(this);
    }
    if (t >= this.clip.dur - 0.05) {
      this.anim.stopClip(0.2);
      this.attackCD = rand(2.6, 4.2);
      this.setState('circle');
    }
  }

  // ---------- reactions ----------
  // Returns 'blocked' | 'guardbreak' | 'hit' | 'killed'
  receiveHit(info) {
    if (!this.alive || this.state === 'victim') return 'none';
    const fromAngle = Math.abs(this.angleTo(info.attacker));
    const now = this.game.time.game;
    if (now - (this.lastHitT || -9) > 1.1) this.comboTaken = 0;
    const k = info.kind;
    const light = k === 'light' || k === 'air' || k === 'spin';
    const breaker = k === 'heavy' || k === 'pound' || k === 'art' || k === 'riposte';
    const front = fromAngle < 1.25;
    // counter-hit: caught mid wind-up
    // (only early in the wind-up — once committed, the swing lands unless parried or dodged)
    if (this.state === 'attack' && !this.struck && !this.armored && ((this.timeToHit() > 0.24 && (light || breaker)) || (k === 'knife' && this.timeToHit() > 0.05))) info.counter = true;
    // raised guard (and shields) stop light attacks and knives from the front
    if (front && !this.isOpen() && (this.guardUp || this.T.shield) && (light || k === 'knife')) {
      if (k === 'knife') { this.anim.hit(0, -1, 0.3); return 'blocked'; }
      this.anim.hit(0, -1, 0.5);
      this.blocks = (this.blocks || 0) + 1;
      this.body.vel.addScaledVector(info.dir, 1.2);
      if (Math.random() < (this.blocks >= 2 ? 0.75 : 0.35) && this.type !== 'thrower') { this.blocks = 0; this.counterAttack(); }
      return 'blocked';
    }
    // comboed too long: recovers and blocks
    if (light && front && this.state === 'hitstun' && (this.comboTaken || 0) >= 3 && (this.type === 'grunt' || this.type === 'shield')) {
      this.comboTaken = 0;
      this.guardUp = true;
      this.counterAttack();
      return 'blocked';
    }
    if (breaker && (this.guardUp || this.T.shield) && !this.isOpen() && k !== 'riposte') {
      // heavy / art / pound smash the guard open
      this.guardUp = false;
      this.blocks = 0;
      this.hp -= info.dmg * 0.6;
      if (this.hp <= 0) { this.die(info); return 'killed'; }
      if (k === 'pound' || k === 'art') this.knockback(info.dir, k === 'pound' ? 5 : 5.5, 3.5);
      else this.stagger(1.1);
      this.openT = 1.3;
      return 'guardbreak';
    }
    this.comboTaken = (this.comboTaken || 0) + 1;
    this.lastHitT = now;
    if (info.counter) info.dmg *= 1.5;
    if (this.armored && light) info.dmg *= 0.4; // bracing through a riposte
    this.takeDamage(info);
    if (!this.alive) return 'killed';
    return 'hit';
  }

  // riposte out of a block: armored, so mashing into it gets you stabbed
  counterAttack() {
    this.cancelAttack();
    this.token = true;
    this.game.director.attackers.add(this);
    this.anim.hit(0, -1, 0.4);
    this.playEnemyClip(GRUNT.thrust, 1.3);
    this.anim.clipT = Math.max(0, GRUNT.thrust.hitAt - 0.36 * 1.3);
    this.armored = true;
    this.comboNext = null;
  }

  takeDamage(info) {
    const g = this.game;
    const armor = this.T.armor ? 0.85 : 1;
    this.hp -= info.dmg * armor;
    const dir = info.dir || _tmp.set(0, 0, 1);
    const local = this.toLocal(dir, _loc);
    this.anim.hit(local.x, local.z, info.kind === 'heavy' || info.kind === 'pound' ? 1.6 : info.kind === 'knife' ? 0.5 : 1);
    if (this.hp <= 0) { this.die(info); return; }
    const k = info.kind;
    const superArmor = this.T.armor && (this.state === 'attack') && k !== 'heavy' && k !== 'pound' && k !== 'art' && !(info.counter && k === 'riposte');
    if (superArmor) { this.lightHits++; return; }
    if (k === 'knife') {
      // a knife in the arm interrupts a wind-up; otherwise it just stings
      if (this.state === 'attack' && info.counter) { this.stagger(0.6); this.openT = 0.6; }
      else if (!this.T.armor && this.state !== 'attack') { this.cancelAttack(); this.setState('hitstun'); this.hitstun = 0.28; }
      return;
    }
    if (k === 'pound' || k === 'spin') {
      this.knockback(dir, info.knock ?? 5, k === 'pound' ? 4.2 : 3);
      this.openT = 1.4;
    } else if (k === 'art') {
      this.knockback(dir, 5, 2.5);
      this.openT = 1.2;
    } else if (k === 'heavy' || k === 'riposte') {
      if (this.T.armor && k === 'heavy') this.stagger(0.9);
      else if (k === 'heavy') { this.stagger(0.95); this.body.vel.addScaledVector(dir, 3.5); }
      else this.knockback(dir, info.knock ?? 4, 3);
      this.openT = 1.2;
    } else if (k === 'deflect') {
      this.stagger(0.6);
    } else {
      // light: interrupt + short hitstun (unless already committed to the swing)
      if (this.T.armor) { this.lightHits++; if (this.lightHits >= 4) { this.lightHits = 0; this.stagger(0.7); } return; }
      if (this.state === 'attack' && !info.counter) return; // committed swings shrug off slashes
      this.cancelAttack();
      this.setState('hitstun');
      this.hitstun = info.counter ? 0.7 : 0.42;
      this.anim.playClip(local.x > 0 ? GRUNT.hitR : GRUNT.hitL, { blendIn: 0.02, speed: info.counter ? 0.7 : 1 });
      const kb = (info.knock ?? 1.6) * 1.6;
      this.body.vel.x += dir.x * kb;
      this.body.vel.z += dir.z * kb;
    }
  }

  cancelAttack() {
    if (this.state === 'attack' || this.state === 'throw') { this.anim.stopClip(0.08); this.trailOn = false; }
    this.comboNext = null;
    this.releaseToken();
  }
  stagger(dur) {
    this.cancelAttack();
    this.setState('stagger');
    this.hitstun = dur;
    this.anim.playClip(GRUNT.stagger, { blendIn: 0.04, speed: 1.1 / Math.max(0.5, dur) });
  }
  knockback(dir, force, up) {
    this.cancelAttack();
    this.body.vel.set(dir.x * force, up, dir.z * force);
    this.body.grounded = false;
    this.setState('airborne');
    this.anim.playClip(GRUNT.stagger, { blendIn: 0.04 });
  }
  parried() {
    this.cancelAttack();
    this.setState('parried');
    this.anim.playClip(GRUNT.parried, { blendIn: 0.02 });
    this.body.vel.x -= Math.sin(this.yaw) * 2.5;
    this.body.vel.z -= Math.cos(this.yaw) * 2.5;
    this.attackCD = 1.5;
  }
  onVaulted() {
    if (this.state === 'attack') return;
    this.cancelAttack();
    this.setState('confused');
  }

  stStagger(dt) {
    this.body.vel.x = damp(this.body.vel.x, 0, 8, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 8, dt);
    if (this.stateT > this.hitstun) {
      this.anim.stopClip(0.2);
      this.setState('circle');
      this.attackCD = Math.max(this.attackCD, rand(0.3, 0.9));
      this.rollGuard(0.15);
      if (this.T.shield) this.raiseShield();
    }
  }
  stParried(dt) {
    this.body.vel.x = damp(this.body.vel.x, 0, 6, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 6, dt);
    if (this.stateT > 1.3) { this.anim.stopClip(0.25); this.setState('circle'); if (this.T.shield) this.raiseShield(); }
  }
  stAirborne(dt) {
    const b = this.body;
    if (b.wallHit && (b.wallImpact || 0) > 3.5 && this.stateT > 0.03) {
      // slammed into a wall
      const imp = b.wallImpact;
      b.wallImpact = 0;
      this.game.wallSplat(this, imp);
      if (!this.alive) return 24;
      this.setState('wallsplat');
      return 24;
    }
    // smash breakables we fly into
    for (const br of this.game.level.breakables) {
      if (br.alive && br.pos.distanceTo(_tmp.copy(b.pos).setY(b.pos.y + 0.5)) < br.size * 0.8 + 0.3) this.game.level.breakObject(br, _tmp2.copy(b.vel).normalize());
    }
    if (b.grounded && this.stateT > 0.08) {
      // land on their feet, stumbling and wide open
      this.stagger(1.0);
      this.openT = Math.max(this.openT || 0, 1.1);
      this.anim.land.v += 6;
      this.game.audio.play('thud', { pos: b.pos, volume: 0.6 });
      this.game.fx.dustPuff(b.pos, 6);
    }
    return 24;
  }
  stWallsplat(dt) {
    this.body.vel.x = damp(this.body.vel.x, 0, 10, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 10, dt);
    this.anim.bodyTilt.x = damp(this.anim.bodyTilt.x, -0.3, 10, dt);
    if (this.stateT > 1.2) { this.stagger(0.6); this.openT = 0.8; }
  }
  stDown(dt) {
    const t = this.stateT;
    const b = this.body;
    b.vel.x = damp(b.vel.x, 0, 5, dt);
    b.vel.z = damp(b.vel.z, 0, 5, dt);
    const fall = Math.min(1, t / 0.3);
    const rise = clamp((t - 1.5) / 0.45, 0, 1);
    this.anim.flip = -1.4 * ease.out(fall) * (1 - ease.inOut(rise));
    if (t > 1.95) { this.anim.flip = 0; this.setState('circle'); this.attackCD = rand(0.4, 1.0); this.rollGuard(); if (this.T.shield) this.raiseShield(); }
  }
  stConfused(dt) {
    const p = this.game.player;
    this.body.vel.x = damp(this.body.vel.x, 0, 8, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 8, dt);
    if (this.stateT > 0.35) this.faceTo(p.body.pos.x, p.body.pos.z, 3, dt);
    if (this.stateT > 1.0) { this.setState('circle'); if (this.T.shield) this.raiseShield(); }
  }

  die(info) {
    const g = this.game;
    this.alive = false;
    this.hp = 0;
    this.cancelAttack();
    this.indicator.visible = false;
    this.setState('dead');
    this.anim.flip = 0;
    const dir = info.dir ? info.dir.clone() : new THREE.Vector3(0, 0, 1);
    dir.y = Math.max(dir.y, 0.15);
    const force = info.kind === 'pound' ? 7 : info.kind === 'heavy' ? 6 : info.kind === 'fall' ? 1 : 4;
    const part = info.point && info.point.y > this.body.pos.y + 1.45 * this.rig.scale ? 'head' : 'chest';
    this.ragdollDeath(this.body.vel.clone().multiplyScalar(0.6), dir.multiplyScalar(force), part);
    if (Math.random() < 0.65 || info.kind === 'pound') this.dropSword(new THREE.Vector3(rand(-2, 2), 3.5, rand(-2, 2)));
    if (this.shield && Math.random() < 0.5) {
      const s = this.shield;
      s.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
      s.matrixWorld.decompose(wp, wq, ws);
      s.removeFromParent();
      s.position.copy(wp); s.quaternion.copy(wq);
      g.fx.addDebris(s, new THREE.Vector3(rand(-2, 2), 3, rand(-2, 2)), new THREE.Vector3(rand(-6, 6), rand(-6, 6), rand(-6, 6)), { radius: 0.05, bounce: 0.2, life: 60 });
      this.shield = null;
    }
    g.onEnemyDeath(this, info);
  }

  updateIndicator(dt) {
    const ind = this.indicator;
    const ttl = this.timeToHit();
    const showFor = this.state === 'throw' ? 0.5 : 0.48;
    if (ttl < showFor && ttl > -0.02 && this.alive) {
      const red = this.clip && (this.clip.unblockable || this.clip.perilous);
      const win = this.parryWindow();
      const inWin = ttl <= win;
      ind.visible = true;
      this.headPos(ind.position);
      ind.position.y += 0.55 * this.rig.scale;
      const pulse = 1 - ttl / showFor;
      const s = (inWin ? 0.42 : 0.26) + pulse * 0.12;
      ind.scale.set(s, s, 1);
      if (red) ind.material.color.setRGB(2.4, 0.1, 0.06);
      else if (inWin) ind.material.color.setRGB(2.2, 2.0, 1.6);
      else ind.material.color.setRGB(1.1, 0.7, 0.25);
      ind.material.rotation += dt * 4;
      if (!this._warned) { this._warned = true; if (red) this.game.audio.play('combo_tick', { volume: 0.6, rate: 0.6 }); }
    } else {
      ind.visible = false;
      this._warned = false;
    }
  }
  parryWindow() { return this.T.parryWindow; }

  buildBasePose(P, dt) {
    if (this.state === 'airborne' || this.state === 'leapup' || (this.state === 'spawn' && !this.body.grounded)) {
      this.locomotionPose(P, dt, ENEMY_GUARD, { noTrailSword: true });
      P.footL = _fl.set(0.13, 0.4, 0.15); P.footR = _fr.set(-0.13, 0.3, -0.1);
      P.handL.set(0.35, 1.4, 0.1);
      return;
    }

    if (this.state === 'wallsplat') {
      this.locomotionPose(P, dt, ENEMY_GUARD, { noTrailSword: true });
      P.hips.y = -0.25; P.spine.x = -0.2; P.grip.set(-0.4, 0.8, -0.1); P.handL.set(0.35, 0.85, -0.1); P.head.x = 0.4;
      return;
    }
    if (this.state === 'confused') {
      this.locomotionPose(P, dt, ENEMY_GUARD);
      P.spine.y += 0.4; P.head.y += 0.6;
      return;
    }
    this.locomotionPose(P, dt, this.guardUp && !this.T.shield ? ENEMY_GUARD_UP : ENEMY_GUARD, { relaxed: this.guardUp ? ENEMY_GUARD_UP : ENEMY_RELAXED });
  }

  dispose() {
    super.dispose();
    this.indicator.removeFromParent();
  }
}
const ENEMY_RELAXED = { g: [-0.22, 1.05, 0.3], b: [0.2, 0.6, 0.78], l: [0.2, 1.08, 0.15] };
const _goal = new THREE.Vector3(), _tmp = new THREE.Vector3(), _tmp2 = new THREE.Vector3(), _loc = new THREE.Vector3();
const _h = new THREE.Vector3(), _h2 = new THREE.Vector3(), _fl = new THREE.Vector3(), _fr = new THREE.Vector3();
const _wb = new THREE.Vector3(-4.6, 0, 15.3), _wt = new THREE.Vector3(-12.2, RAMPART_Y, 15.3);
const _eb2 = new THREE.Vector3(4.6, 0, -11.1), _et = new THREE.Vector3(12.2, RAMPART_Y, -11.1);
void wrapAngle;
