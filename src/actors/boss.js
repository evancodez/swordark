import * as THREE from 'three';
import { Enemy, TYPES } from './enemy.js';
import { Cloth } from './cloth.js';
import { BOSS, BOSS_GUARD } from './clips.js';
import { clamp, damp, rand, pick, ease } from '../core/math.js';

TYPES.boss = { look: 'boss', hp: 1100, sword: 'boss', scale: 1.14, speed: 4.4, parryWindow: 0.19, attacks: [] };

const P1 = [
  ['slashR', 'slashL'],
  ['slashR', 'slashL', 'overhead'],
  ['delayed'],
  ['thrust'],
  ['sweep'],
  ['slashR', 'thrust'],
  ['overhead'],
];
const P2 = [
  ['slashR', 'slashL', 'spin'],
  ['spin'],
  ['delayed', 'sweep'],
  ['slashL', 'slashR', 'overhead', 'thrust'],
  ['slashR', 'slashL', 'slashR', 'delayed'],
  ['thrust', 'sweep'],
  ['sweep', 'overhead'],
];

// Vaelor, the Iron Warden: precise duel with posture, perilous attacks and a second phase.
export class Boss extends Enemy {
  constructor(game) {
    super(game, 'boss');
    this.trail.setColor([1.1, 1.0, 1.0], [2.2, 2.1, 2.0]);
    this.trail.life = 0.16;
    const rig = this.rig;
    this.cape = new Cloth({
      cols: 6, rows: 10, width: 0.62, length: 1.45, color: 0x5a0a0a,
      anchors: [[-0.24, 0.17, -0.13], [-0.15, 0.19, -0.16], [-0.05, 0.2, -0.17], [0.05, 0.2, -0.17], [0.15, 0.19, -0.16], [0.24, 0.17, -0.13]],
      bone: rig.bones.chest,
      collide: [
        { bone: rig.bones.chest, offset: [0, 0.0, -0.02], r: 0.26 }, { bone: rig.bones.hips, offset: [0, -0.05, 0], r: 0.27 },
        { bone: rig.bones['thigh.L'], offset: [0, -0.22, 0], r: 0.13 }, { bone: rig.bones['thigh.R'], offset: [0, -0.22, 0], r: 0.13 },
        { bone: rig.bones['shin.L'], offset: [0, -0.2, 0], r: 0.1 }, { bone: rig.bones['shin.R'], offset: [0, -0.2, 0], r: 0.1 },
      ],
    });
    game.scene.add(this.cape.mesh);
    this.posture = 0;
    this.maxPosture = 100;
    this.phase = 1;
    this.combo = [];
    this.comboIdx = 0;
    this.sincePressure = 10;
    this.guardT = 1;
    this.heat = 0;
    this.speedMul = 1;
    this.deathblows = 0;
    this.setState('intro');
    this.anim.stanceW = 0.16;
  }

  get isBoss() { return true; }
  canBeExecuted() { return this.alive && (this.state === 'broken' || this.state === 'finished'); }
  parryWindow() { return this.clip && this.clip.perilous === 'thrust' ? 0.14 : this.T.parryWindow; }

  // Override the think step entirely
  stThink(dt) { this.stGuard(dt); }

  stIntro(dt) {
    this.body.vel.set(0, this.body.vel.y, 0);
  }

  startIntro() {
    this.setState('roar');
    this.anim.playClip(BOSS.roar, { blendIn: 0.2 });
    this.roarFired = false;
  }

  stRoar(dt) {
    const g = this.game;
    this.body.vel.x = damp(this.body.vel.x, 0, 8, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 8, dt);
    if (!this.roarFired && this.stateT > 0.45) {
      this.roarFired = true;
      g.audio.play('boss_roar', { pos: this.body.pos });
      g.camRig.shake(0.5);
      g.audio.duck(0.5, 1.2);
      if (this.phase === 2) {
        this.heat = 1;
        g.audio.play('fire_ignite', { pos: this.body.pos });
        this.trail.setColor([3.0, 0.9, 0.2], [6, 2.5, 0.6]);
        g.fx.emberBurst(this.center(_p), 40, 0.6);
        // shockwave pushes the player back
        const pl = g.player;
        const d = this.distTo(pl);
        if (d < 6 && pl.alive) {
          const away = _p2.subVectors(pl.body.pos, this.body.pos).setY(0).normalize();
          pl.body.vel.addScaledVector(away, 9 * (1 - d / 6) + 3);
          pl.body.vel.y = 3;
        }
        g.fx.dustPuff(this.body.pos, 20, [0.25, 0.15, 0.1]);
      }
    }
    if (this.stateT > 2.2) {
      this.anim.stopClip(0.3);
      this.setState('guard');
      this.guardT = rand(0.4, 0.9);
      if (this.phase === 1) g.onBossEngaged(this);
    }
  }

  stGuard(dt) {
    const g = this.game, p = g.player, b = this.body;
    if (!p.alive) { b.vel.x = damp(b.vel.x, 0, 6, dt); b.vel.z = damp(b.vel.z, 0, 6, dt); return; }
    this.guardT -= dt;
    const d = this.distTo(p);
    this.faceTo(p.body.pos.x, p.body.pos.z, 9, dt);
    // keep a dueling distance, strafe
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafeT = rand(1.0, 2.2); this.strafeDir *= -1; }
    const ang = Math.atan2(b.pos.x - p.body.pos.x, b.pos.z - p.body.pos.z);
    const want = 3.4;
    const radial = clamp(d - want, -1, 1);
    const rx = Math.sin(ang), rz = Math.cos(ang);
    let tx = -rx * radial + rz * this.strafeDir * 0.5;
    let tz = -rz * radial - rx * this.strafeDir * 0.5;
    const l = Math.hypot(tx, tz) || 1;
    const speed = d > 6 ? this.speed * 1.2 : 1.9;
    tx /= l; tz /= l;
    const acc = 16 * dt;
    b.vel.x += clamp(tx * speed - b.vel.x, -acc, acc);
    b.vel.z += clamp(tz * speed - b.vel.z, -acc, acc);
    if (this.guardT <= 0) {
      if (d > 7.5) this.startCombo(['leap']);
      else if (d > 5) this.startCombo(Math.random() < 0.6 ? ['thrust'] : ['leap']);
      else this.startCombo(pick(this.phase === 1 ? P1 : P2));
    }
  }

  startCombo(list) {
    this.combo = list;
    this.comboIdx = 0;
    this.playNext();
  }
  playNext() {
    const name = this.combo[this.comboIdx];
    const clip = BOSS[name];
    this.playEnemyClip(clip, this.speedMul);
    this.struck2 = false;
    if (this.comboIdx > 0) this.anim.from.copy(this.anim.final);
    if (clip.leap) this.leapStarted = false;
    this.spinDone = 0;
  }

  stAttack(dt) {
    const g = this.game, p = g.player, clip = this.clip, b = this.body;
    const t = this.anim.clipT;
    // leap: arc toward player
    if (clip.leap) {
      if (!this.leapStarted && t >= clip.leap[0]) {
        this.leapStarted = true;
        const flight = (clip.leap[1] - clip.leap[0]) / this.anim.clipSpeed;
        const tgt = p.body.pos;
        const d = Math.max(0.1, this.distTo(p) - 1.6);
        const dir = _p.set(tgt.x - b.pos.x, 0, tgt.z - b.pos.z).normalize();
        b.vel.set(dir.x * d / flight, 24 * flight * 0.5 + (tgt.y - b.pos.y) / flight, dir.z * d / flight);
        b.grounded = false;
        g.audio.play('jump', { pos: b.pos, rate: 0.7 });
      }
      if (this.leapStarted && !this.struck && b.grounded && t > clip.leap[0] + 0.1) this.anim.clipT = Math.max(this.anim.clipT, clip.hitAt);
      if (!this.leapStarted) { b.vel.x = damp(b.vel.x, 0, 10, dt); b.vel.z = damp(b.vel.z, 0, 10, dt); this.faceTo(p.body.pos.x, p.body.pos.z, 10, dt); }
      else if (!b.grounded) this.faceTo(p.body.pos.x, p.body.pos.z, 4, dt);
      if (this.leapStarted && !b.grounded && t > clip.hitAt - 0.05) this.anim.clipT = clip.hitAt - 0.05;
      if (!this.struck && t >= clip.hitAt) {
        this.struck = true;
        g.bossSlam(this, clip);
      }
      if (t >= clip.dur - 0.1) this.finishClip();
      return;
    }
    // track during windup
    if (t < clip.hitAt - 0.14) this.faceTo(p.body.pos.x, p.body.pos.z, 8, dt);
    // spin
    if (clip.spin && t >= clip.spin[0] && t <= clip.spin[1] + 0.02) {
      const want = clamp((t - clip.spin[0]) / (clip.spin[1] - clip.spin[0]), 0, 1) * clip.spin[2];
      this.yaw += want - this.spinDone;
      this.spinDone = want;
      const lungeV = 3.2;
      b.vel.x = (p.body.pos.x - b.pos.x) / Math.max(1, this.distTo(p)) * lungeV;
      b.vel.z = (p.body.pos.z - b.pos.z) / Math.max(1, this.distTo(p)) * lungeV;
    } else if (clip.lunge && t >= clip.lunge[0] && t <= clip.lunge[1]) {
      const span = clip.lunge[1] - clip.lunge[0];
      const u = (t - clip.lunge[0]) / span;
      const remain = Math.max(0.05, (clip.lunge[1] - t) / this.anim.clipSpeed);
      const v = clamp((this.distTo(p) - (clip.range ?? 1.5)) / remain, -3, 11) * Math.min(1, u * 4 + 0.3);
      b.vel.x = Math.sin(this.yaw) * v;
      b.vel.z = Math.cos(this.yaw) * v;
    } else {
      b.vel.x = damp(b.vel.x, 0, 12, dt);
      b.vel.z = damp(b.vel.z, 0, 12, dt);
    }
    const hitEnd = clip.hitAt2 || clip.hitAt;
    this.trailOn = t > clip.hitAt - 0.09 && t < hitEnd + 0.12;
    if (!this.whooshed && t > clip.hitAt - 0.08) {
      this.whooshed = true;
      g.audio.play(this.heat > 0.5 ? 'fire_swing' : clip.spin ? 'whoosh_spin' : 'whoosh_heavy', { pos: b.pos, rate: 0.9 });
    }
    if (!this.struck && t >= clip.hitAt - 0.05) {
      const r = t <= clip.hitAt + 0.12 ? g.enemyBladeSweep(this, clip) : null;
      if (r || t > clip.hitAt + 0.12) this.struck = true;
      if (this.state !== 'attack') return;
    }
    if (clip.hitAt2 && !this.struck2 && t >= clip.hitAt2 - 0.05) {
      const r = t <= clip.hitAt2 + 0.12 ? g.enemyBladeSweep(this, clip) : null;
      if (r || t > clip.hitAt2 + 0.12) this.struck2 = true;
      if (this.state !== 'attack') return;
    }
    // chain
    const last = this.comboIdx >= this.combo.length - 1;
    if (!last && t >= hitEnd + 0.1 / this.speedMul) {
      this.comboIdx++;
      this.playNext();
      return;
    }
    if (t >= clip.dur - 0.1) this.finishClip();
  }
  finishClip() {
    this.trailOn = false;
    this.anim.stopClip(0.2);
    this.setState('recover');
    this.recoverT = rand(0.6, 1.0) / this.speedMul;
  }
  stRecover(dt) {
    const p = this.game.player;
    this.body.vel.x = damp(this.body.vel.x, 0, 8, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 8, dt);
    if (this.stateT > 0.25) this.faceTo(p.body.pos.x, p.body.pos.z, 4, dt);
    if (this.stateT > this.recoverT) { this.setState('guard'); this.guardT = rand(0.5, 1.4) / this.speedMul; }
  }

  // ---------- defense ----------
  receiveHit(info) {
    if (!this.alive) return 'none';
    const g = this.game;
    if (['intro', 'roar', 'victim', 'finished'].includes(this.state)) {
      if (this.state === 'finished') return 'none';
      return 'blocked';
    }
    this.sincePressure = 0;
    const front = Math.abs(this.angleTo(info.attacker)) < 1.3;
    const k = info.kind;
    if (this.state === 'broken') {
      this.takeBossDamage(info.dmg * 1.4, info);
      return this.alive ? 'hit' : 'killed';
    }
    if ((this.state === 'guard') && front) {
      // deflects most attacks while guarding
      if (k === 'light' || k === 'air' || k === 'spin') {
        this.addPosture(4);
        this.anim.playClip(BOSS.block, { blendIn: 0.03 });
        if (Math.random() < (this.phase === 2 ? 0.4 : 0.28)) {
          // counter-attack out of the block
          this.startCombo(pick([['slashR'], ['slashR', 'slashL'], ['thrust']]));
          this.anim.clipT = Math.max(0, this.clip.hitAt - 0.38);
        } else this.guardT = Math.min(this.guardT, 0.5);
        return 'blocked';
      }
      if (k === 'heavy' || k === 'slam' || k === 'plunge') {
        this.addPosture(14);
        this.anim.playClip(BOSS.block, { blendIn: 0.03 });
        if (this.state === 'broken') return 'guardbreak';
        return 'blocked';
      }
      if (k === 'kick') {
        this.addPosture(10);
        if (this.posture > 55 && this.state !== 'broken') { this.setState('stagger'); this.hitstun = 0.5; this.anim.playClip(BOSS.parried, { blendIn: 0.03 }); }
        return 'hit';
      }
    }
    // open: take damage
    let mul = 1;
    if (this.state === 'attack') mul = 0.55;           // trading hits: armored
    if (this.state === 'parried' || this.state === 'stagger') mul = 1.15;
    this.addPosture(k === 'heavy' ? 10 : 3);
    this.takeBossDamage(info.dmg * mul, info);
    const dir = info.dir || _p.set(0, 0, 1);
    const local = this.toLocal(dir, _p2);
    this.anim.hit(local.x * 0.6, local.z * 0.6, 0.6);
    return this.alive ? 'hit' : 'killed';
  }

  takeBossDamage(amount, info) {
    const g = this.game;
    this.hp -= amount;
    if (this.phase === 1 && this.hp < this.maxHp * 0.5) {
      this.phase = 2;
      this.speedMul = 1.14;
      this.cancelAttack();
      this.posture = 0;
      this.setState('roar');
      this.anim.playClip(BOSS.roar, { blendIn: 0.15 });
      this.roarFired = false;
      g.onBossPhase2(this);
      return;
    }
    if (this.hp <= 0) {
      this.hp = 1;
      // final: kneel and wait for the killing blow
      this.cancelAttack();
      this.setState('finished');
      this.anim.playClip(BOSS.broken, { blendIn: 0.2 });
      g.onBossFinishable(this);
    }
  }

  addPosture(v) {
    if (this.state === 'broken' || this.state === 'finished') return;
    this.posture = Math.min(this.maxPosture, this.posture + v);
    if (this.posture >= this.maxPosture) {
      this.cancelAttack();
      this.setState('broken');
      this.anim.playClip(BOSS.broken, { blendIn: 0.1 });
      this.game.onPostureBreak(this);
    }
  }

  // called when the player parries one of our strikes
  parried() {
    const last = this.comboIdx >= this.combo.length - 1;
    const per = this.clip && this.clip.perilous;
    this.addPosture(per ? 28 : last ? 20 : 15);
    this.sincePressure = 0;
    if (this.state === 'broken') return;
    if (last || per) {
      this.cancelAttack();
      this.setState('parried');
      this.anim.playClip(BOSS.parried, { blendIn: 0.02 });
      this.body.vel.x -= Math.sin(this.yaw) * 2;
      this.body.vel.z -= Math.cos(this.yaw) * 2;
    } else {
      // keeps attacking, just recoils
      this.anim.hit(0, -1, 0.8);
    }
  }

  stParried(dt) {
    this.body.vel.x = damp(this.body.vel.x, 0, 6, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 6, dt);
    if (this.stateT > 0.85 / this.speedMul) { this.anim.stopClip(0.2); this.setState('guard'); this.guardT = rand(0.2, 0.6); }
  }
  stStagger(dt) {
    this.body.vel.x = damp(this.body.vel.x, 0, 8, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 8, dt);
    if (this.stateT > (this.hitstun || 0.5)) { this.anim.stopClip(0.2); this.setState('guard'); this.guardT = rand(0.1, 0.4); }
  }
  stBroken(dt) {
    this.body.vel.x = damp(this.body.vel.x, 0, 6, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 6, dt);
    if (this.stateT > 3.0) {
      this.posture = this.maxPosture * 0.35;
      this.anim.stopClip(0.3);
      this.setState('guard');
      this.guardT = 0.3;
    }
  }

  takeDamage(info) { this.takeBossDamage(info.dmg * 0.5, info); }
  stagger(dur) { this.addPosture(12); }
  knockback() { this.addPosture(10); }
  onVaulted() {}

  die(info) {
    // final deathblow: decapitated by the execution code, then ragdoll
    super.die(info);
    this.cape.collide = [];
  }

  buildBasePose(P, dt) {
    if (this.state === 'broken' || this.state === 'finished') {
      this.locomotionPose(P, dt, BOSS_GUARD);
      return;
    }
    this.locomotionPose(P, dt, BOSS_GUARD, { relaxed: BOSS_GUARD });
  }
}

// hook the extra states into the base dispatcher
const baseUpdate = Enemy.prototype.update;
Boss.prototype.update = function (dt) {
  const s = this.state;
  this._bossState = ['intro', 'roar', 'guard', 'recover', 'broken', 'finished'].includes(s) ? s : null;
  bossPre.call(this, dt);
  baseUpdate.call(this, dt);
  bossPost.call(this, dt);
};
function bossPre(dt) {
  const g = this.game;
  this.sincePressure += dt;
  if (this.sincePressure > 1.8 && this.state !== 'broken') {
    const regen = (this.phase === 2 ? 11 : 8) * (0.35 + 0.65 * this.hp / this.maxHp);
    this.posture = Math.max(0, this.posture - regen * dt);
  }
  const u = this.rig.sword && this.rig.sword.material.userData.uniforms;
  if (u) {
    u.uBladeHeat.value = damp(u.uBladeHeat.value, this.heat, 2, dt);
    if (this.heat > 0.5 && this.alive) {
      if (Math.random() < dt * 30) {
        _p.lerpVectors(this.bladeBase, this.bladeTip, Math.random());
        g.fx.embers.spawn(_p.x, _p.y, _p.z, rand(-0.3, 0.3), rand(0.5, 1.5), rand(-0.3, 0.3), 6, 1.8, 0.3, 1, rand(0.01, 0.02), rand(0.3, 0.7), -1, 1.5);
      }
    }
  }
  // boss-only states run here; the base dispatcher ignores unknown states
  if (!this.alive) return;
  switch (this._bossState) {
    case 'intro': this.stIntro(dt); break;
    case 'roar': this.stRoar(dt); break;
    case 'guard': this.stGuard(dt); break;
    case 'recover': this.stRecover(dt); break;
    case 'broken': this.stBroken(dt); break;
    case 'finished': this.body.vel.x = damp(this.body.vel.x, 0, 6, dt); this.body.vel.z = damp(this.body.vel.z, 0, 6, dt); break;
  }
}
function bossPost(dt) {
  this.cape.groundY = this.body.groundY;
  this.cape.update(dt);
}
const _p = new THREE.Vector3(), _p2 = new THREE.Vector3();
void ease;
