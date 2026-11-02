import * as THREE from 'three';
import { Character } from './character.js';
import { Rig, buildSword } from './rig.js';
import { Cloth } from './cloth.js';
import { PLAYER } from './clips.js';
import { compileClip } from './pose.js';
import { clamp, damp, dampAngle, lerp, wrapAngle, rand, segSegDistSq, ease } from '../core/math.js';

const GUARD = { g: [-0.2, 1.1, 0.33], b: [0.25, 0.55, 0.8], l: [0.16, 1.14, 0.22], tw: -0.15, hy: -0.03 };
const RUN = 6.8, SPRINT = 9.4, JUMP = 7.8, DJUMP = 7.4;
const COMBO_CHAIN = ['l1', 'l2', 'l3', 'l4'];

export class Player extends Character {
  constructor(game) {
    const rig = new Rig('hero', { rim: 0.6 });
    super(game, rig, { hp: 100, radius: 0.34, guard: GUARD, trail: { color: [0.35, 0.37, 0.42], edge: [1.2, 1.25, 1.4], life: 0.13 } });
    rig.attachSword(buildSword('hero'));
    this.scarf = new Cloth({
      cols: 2, rows: 11, width: 0.16, length: 0.95, color: 0x7a1014,
      anchors: [[-0.055, 0.0, -0.085], [0.055, 0.0, -0.085]], bone: rig.bones.neck,
      collide: [{ bone: rig.bones.chest, offset: [0, 0.02, -0.02], r: 0.2 }, { bone: rig.bones.hips, offset: [0, -0.05, 0], r: 0.21 },
        { bone: rig.bones['thigh.L'], offset: [0, -0.2, 0], r: 0.11 }, { bone: rig.bones['thigh.R'], offset: [0, -0.2, 0], r: 0.11 }],
    });
    game.scene.add(this.scarf.mesh);
    // faint cold eye glints under the hood
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 1.6, 2.0), toneMapped: false });
    for (const sx of [-0.032, 0.032]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 4), eyeMat);
      e.scale.set(1.6, 0.7, 0.5);
      e.position.set(sx, 0.125, 0.105);
      rig.bones.head.add(e);
    }
    this.team = 'player';
    const step = this.anim.stepCallback;
    this.anim.stepCallback = (foot, speed) => {
      step(foot, speed);
      if (speed > 2.5) game.fx.dustPuff(foot.pos, 2, [0.32, 0.36, 0.42]);
    };
    this.reset(game.level.spawnPoints.player, Math.PI);
  }

  reset(pos, yaw) {
    this.body.pos.copy(pos);
    this.body.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.hp = this.maxHp;
    this.alive = true;
    this.focus = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboStep = 0;
    this.lastAttackT = -10;
    this.airAttacks = 0;
    this.doubleJumped = false;
    this.airDashed = false;
    this.parryT = 99;
    this.parryCD = 0;
    this.iframes = 0;
    this.invuln = 0;
    this.target = null;
    this.lock = null;
    this.coyote = 0;
    this.sprint = false;
    this.clip = null;
    this.parried = null;
    this.deflectT = 0;
    this.bladeBlood = 0;
    this.rig.clearBlood();
    if (this.ragdoll) { this.ragdoll = null; }
    this.anim.flip = 0; this.anim.roll = 0;
    this.anim.initialized = false;
    this.setState('move');
    this.scarf.initialized = false;
    this.lowHpBeat = 0;
  }

  get busy() { return ['execute', 'dead'].includes(this.state); }
  get airborne() { return !this.body.grounded; }
  isInvulnerable() { return this.invuln > 0 || this.state === 'execute' || this.state === 'vault' || this.state === 'art' || (this.state === 'dodge' && this.iframes > 0); }

  moveVector(out) {
    const inp = this.game.input;
    const cam = this.game.camRig;
    const f = cam.forward(_f), r = cam.right(_r);
    out.set(0, 0, 0).addScaledVector(f, inp.move.y).addScaledVector(r, inp.move.x);
    return out;
  }

  // ---------- main update ----------
  update(dt) {
    const g = this.game, inp = g.input;
    this.stateT += dt;
    this.parryT += dt;
    this.parryCD -= dt;
    this.invuln -= dt;
    this.deflectT -= dt;
    this.comboTimer -= dt;
    this.fumbleT = (this.fumbleT || 0) - dt;
    if (this.comboTimer <= 0 && this.combo > 0) { this.combo = 0; g.hud.comboEnd(); }
    if (this.state === 'dodge') this.iframes -= dt;
    this.bladeBlood = Math.max(0, this.bladeBlood - dt * 0.02);

    if (!this.alive) {
      this.animate(dt);
      this.scarf.update(dt);
      return;
    }
    const mv = this.moveVector(_mv);
    const mag = Math.min(1, mv.length());
    if (mag > 0.01) _dir.copy(mv).divideScalar(Math.max(mag, 1e-4)); else _dir.set(0, 0, 0);
    this.combat = g.enemiesNear(this.body.pos, 9) > 0;
    // lock-on: toggle (R3 / Tab / MMB) or hold (L2); flick right stick / swipe mouse to switch
    if (inp.take('lock', 0.1)) {
      if (this.lock) { this.lock = null; this.lockToggle = false; }
      else { this.lock = this.selectTarget(16, null, true); this.lockToggle = !!this.lock; }
    }
    const holding = inp.isHeld('lockhold');
    if (holding && !this.lockHeld) { this.lock = this.selectTarget(16, null, true); }
    if (!holding && this.lockHeld && !this.lockToggle) this.lock = null;
    this.lockHeld = holding;
    if (this.lock && (!this.lock.alive || this.distTo(this.lock) > 22 || this.lock.state === 'victim')) {
      this.lock = (holding || this.lockToggle) ? this.selectTarget(12, null, true) : null;
    }
    this.switchCD = (this.switchCD || 0) - dt;
    if (this.lock) {
      this.switchAcc = (this.switchAcc || 0) * Math.exp(-dt * 8) + inp.look.x;
      const sw = inp.flick || (Math.abs(this.switchAcc) > 0.1 ? Math.sign(this.switchAcc) : 0);
      if (sw && this.switchCD <= 0) {
        const n = this.switchTarget(sw);
        if (n) { this.lock = n; g.audio.play('combo_tick', { volume: 0.5, rate: 1.5 }); }
        this.switchCD = 0.3; this.switchAcc = 0;
      }
    }

    let gravity = 24;
    switch (this.state) {
      case 'move': this.stMove(dt, mv, mag); break;
      case 'air': gravity = this.stAir(dt, mv, mag); break;
      case 'attack': gravity = this.stAttack(dt, mv, mag); break;
      case 'dash': gravity = this.stDash(dt); break;
      case 'parry': this.stParry(dt, mv, mag); break;
      case 'block': this.stBlock(dt, mv, mag); break;
      case 'deflect': this.stDeflect(dt, mv, mag); break;
      case 'dodge': gravity = this.stDodge(dt, mv, mag); break;
      case 'vault': gravity = this.stVault(dt); break;
      case 'hit': this.stHit(dt); break;
      case 'down': this.stDown(dt); break;
      case 'mantle': gravity = this.stMantle(dt); break;
      case 'charge': this.stCharge(dt); break;
      case 'slam': gravity = this.stSlam(dt); break;
      case 'plunge': gravity = this.stPlunge(dt); break;
      case 'execute': this.body.vel.set(0, 0, 0); break;
      case 'art': gravity = this.stArt(dt); break;
    }
    if (this.state !== 'mantle' && this.state !== 'vault' && this.state !== 'execute') this.physics(dt, gravity);
    else if (this.state === 'execute') { /* positioned by execution */ }

    // landing
    if (this.body.landed) this.onLand();
    if (this.body.grounded) { this.coyote = 0.1; this.airAttacks = 0; this.doubleJumped = false; this.airDashed = false; }
    else this.coyote -= dt;

    this.anim.footMode = (['dash', 'vault', 'mantle', 'slam', 'plunge', 'art'].includes(this.state) || !this.body.grounded) ? 'air' : 'gait';
    this.anim.combatStance = this.combat && this.state !== 'move' ? true : this.combat;
    this.updateLean(dt);
    // head look toward target
    const look = this.lock || this.target;
    if (look && look.alive) {
      const a = clamp(this.angleTo(look), -1.1, 1.1);
      this.anim.lookYaw = damp(this.anim.lookYaw, a * 0.7, 8, dt);
    } else this.anim.lookYaw = damp(this.anim.lookYaw, 0, 6, dt);
    this.animate(dt);
    this.scarf.groundY = this.body.groundY;
    this.scarf.update(dt);

    // low health heartbeat
    if (this.hp < 30) {
      this.lowHpBeat -= dt;
      if (this.lowHpBeat <= 0) { this.lowHpBeat = 0.9 + this.hp / 60; g.audio.play('heartbeat', { volume: 0.7 }); }
    }
  }

  // ---------- states ----------
  groundMove(dt, mv, mag, maxSpeed, accel = 48, faceK = 14) {
    const b = this.body;
    const tx = mv.x * maxSpeed, tz = mv.z * maxSpeed;
    const k = mag > 0.05 ? accel : 34;
    const dvx = tx - b.vel.x, dvz = tz - b.vel.z;
    const dl = Math.hypot(dvx, dvz);
    const step = Math.min(dl, k * dt);
    if (dl > 1e-5) { b.vel.x += (dvx / dl) * step; b.vel.z += (dvz / dl) * step; }
    if (this.lock && !this.sprint) this.faceTo(this.lock.body.pos.x, this.lock.body.pos.z, 12, dt);
    else if (mag > 0.1) this.yaw = dampAngle(this.yaw, Math.atan2(mv.x, mv.z), faceK, dt);
  }

  stMove(dt, mv, mag) {
    const inp = this.game.input;
    if (!inp.isHeld('dodge')) this.sprint = false;
    let speed = this.sprint && mag > 0.5 ? SPRINT : RUN * (mag < 0.6 ? mag * 0.8 : mag);
    if (this.lock && !this.sprint) speed = Math.min(speed, 4.6);
    this.groundMove(dt, mv, mag, speed);
    if (this.tryActions(mv, mag)) return;
    if (!this.body.grounded && this.coyote <= 0) this.setState('air');
  }

  tryActions(mv, mag, allowJump = true) {
    const inp = this.game.input;
    if (inp.take('parry')) { this.startParry(); return true; }
    if (inp.take('dodge', 0.12)) { this.startDodge(mv, mag); return true; }
    if (allowJump && inp.take('jump') && (this.body.grounded || this.coyote > 0)) { this.jump(); return true; }
    if (this.fumbleT > 0) { inp.take('light'); }
    else if (inp.take('light', 0.22)) { this.startAttack('light', mv, mag); return true; }
    if (inp.take('heavy', 0.22)) { this.startAttack('heavy', mv, mag); return true; }
    if (inp.take('kick', 0.2)) { this.startAttack('kick', mv, mag); return true; }
    if (inp.take('art', 0.2)) { return this.startArt(mv, mag); }
    return false;
  }

  // ---------- Blood Art: Crimson Rend ----------
  // A blinding dash-cut through everything in a line. Costs one focus segment (33).
  startArt(mv, mag) {
    const g = this.game;
    if (!g.artUnlocked) { g.hud.hint('Blood Art is sealed · survive the first wave', 2.5); return false; }
    if (this.focus < 33) { g.audio.play('combo_tick', { volume: 0.7, rate: 0.5 }); g.hud.flashFocus(); return false; }
    this.focus -= 33;
    let dir;
    const tgt = this.lock && this.lock.alive ? this.lock : (mag > 0.2 ? this.selectTarget(7, _dir, false, 0.6) : this.selectTarget(7, null, false, 0.7));
    if (tgt) dir = _ad.set(tgt.body.pos.x - this.body.pos.x, 0, tgt.body.pos.z - this.body.pos.z).normalize();
    else dir = mag > 0.2 ? _ad.copy(_dir) : this.forward(_ad);
    const dist = tgt ? Math.min(7.5, this.distTo(tgt) + 2.2) : 6;
    this.artFrom = this.body.pos.clone();
    this.artDir = dir.clone();
    this.artDist = dist;
    this.yaw = Math.atan2(dir.x, dir.z);
    this.setState('art');
    this.hitSet.clear();
    this.anim.playClip(PLAYER.thrust, { startAt: 0.08, speed: 0.6, blendIn: 0.02 });
    this.trail.setColor([1.6, 0.05, 0.03], [3.2, 0.25, 0.15]);
    this.trailOn = true;
    this.invuln = 0.4;
    g.onArt(this);
    return true;
  }
  stArt(dt) {
    const g = this.game;
    const dur = 0.2;
    const t = Math.min(1, this.stateT / dur);
    const e = ease.out(t);
    const nx = this.artFrom.x + this.artDir.x * this.artDist * e, nz = this.artFrom.z + this.artDir.z * this.artDist * e;
    this.body.vel.set((nx - this.body.pos.x) / Math.max(dt, 1e-4), 0, (nz - this.body.pos.z) / Math.max(dt, 1e-4));
    this.anim.bodyTilt.x = damp(this.anim.bodyTilt.x, 0.5, 20, dt);
    // cut everything near the path
    for (const en of g.enemies) {
      if (!en.alive || this.hitSet.has(en) || en.state === 'victim' || en.spawning) continue;
      const d = distToSegXZ(en.body.pos, this.artFrom, this.body.pos);
      if (d < 1.25 + en.body.radius) {
        this.hitSet.add(en);
        g.artHit(this, en, this.artDir);
      }
    }
    if (this.stateT > dur + 0.18) {
      this.body.vel.multiplyScalar(0.1);
      this.trailOn = false;
      this.trail.setColor([0.35, 0.37, 0.42], [1.2, 1.25, 1.4]);
      this.anim.stopClip(0.2);
      this.setState(this.body.grounded ? 'move' : 'air');
    }
    return this.body.grounded ? 24 : 6;
  }

  jump() {
    this.body.vel.y = JUMP;
    this.body.grounded = false;
    this.coyote = 0;
    this.setState('air');
    this.anim.stopClip(0.1);
    this.anim.land.v -= 3;
    this.game.audio.play('jump', { pos: this.body.pos, volume: 0.6 });
  }

  stAir(dt, mv, mag) {
    const b = this.body, inp = this.game.input;
    // air control
    const max = Math.max(RUN, Math.hypot(b.vel.x, b.vel.z));
    const tx = mv.x * max, tz = mv.z * max;
    b.vel.x = damp(b.vel.x, mag > 0.05 ? tx : b.vel.x, 3.5, dt);
    b.vel.z = damp(b.vel.z, mag > 0.05 ? tz : b.vel.z, 3.5, dt);
    if (mag > 0.1) this.yaw = dampAngle(this.yaw, Math.atan2(mv.x, mv.z), 8, dt);
    // double jump front flip
    if (this.anim.flip !== 0) {
      this.flipT += dt;
      const t = Math.min(1, this.flipT / 0.5);
      this.anim.flip = -Math.PI * 2 * ease.inOut(t);
      if (t >= 1) this.anim.flip = 0;
    }
    if (inp.take('jump') && !this.doubleJumped) {
      if (this.coyote > 0) { this.jump(); return 24; }
      this.doubleJumped = true;
      b.vel.y = DJUMP;
      this.flipT = 0;
      this.anim.flip = -0.001;
      this.game.audio.play('whoosh_spin', { pos: b.pos, volume: 0.5, rate: 1.3 });
    }
    if (inp.take('light', 0.2) && this.airAttacks < 3) { this.anim.flip = 0; this.startAttack('light', mv, mag); return 24; }
    if (inp.take('heavy', 0.2)) { this.anim.flip = 0; this.startPlunge(); return 24; }
    if (inp.take('parry')) { this.anim.flip = 0; this.startParry(); return 24; }
    if (inp.take('dodge', 0.12) && !this.airDashed) { this.anim.flip = 0; this.airDashed = true; this.startDodge(mv, mag, true); return 0; }
    // ledge mantle
    if (b.vel.y < 4 && this.tryMantle(mv, mag)) return 24;
    return 24;
  }

  tryMantle(mv, mag) {
    const b = this.body;
    const fx = mag > 0.3 ? mv.x / mag : Math.sin(this.yaw), fz = mag > 0.3 ? mv.z / mag : Math.cos(this.yaw);
    if (mag < 0.3 && !b.wallHit) return false;
    const ledge = this.game.world.findLedge(b.pos, fx, fz, b.pos.y, 0.35, 1.55, b.radius);
    if (!ledge) return false;
    this.mantleFrom = b.pos.clone();
    this.mantleTo = new THREE.Vector3(ledge.x, ledge.y, ledge.z);
    this.yaw = Math.atan2(fx, fz);
    this.setState('mantle');
    this.anim.flip = 0;
    this.game.audio.play('jump', { pos: b.pos, volume: 0.4, rate: 0.8 });
    return true;
  }

  stMantle(dt) {
    const t = Math.min(1, this.stateT / 0.26);
    const a = this.mantleFrom, b2 = this.mantleTo;
    const up = ease.out(Math.min(1, t * 1.6));
    const fw = ease.inOut(Math.max(0, (t - 0.25) / 0.75));
    this.body.pos.set(lerp(a.x, b2.x, fw), lerp(a.y, b2.y + 0.05, up), lerp(a.z, b2.z, fw));
    this.body.vel.set(0, 0, 0);
    if (t >= 1) {
      this.body.pos.y = b2.y;
      this.body.grounded = true;
      this.anim.land.v += 2;
      this.setState('move');
      this.game.audio.play('land', { pos: this.body.pos, volume: 0.5 });
    }
    return 0;
  }

  onLand() {
    const s = this.body.landSpeed || 0;
    this.anim.flip = 0;
    this.anim.land.v += clamp(s * 0.5, 1, 8);
    this.game.audio.play('land', { pos: this.body.pos, volume: clamp(s / 12, 0.3, 1) });
    if (s > 9) this.game.fx.dustPuff(this.body.pos, 8);
    if (this.state === 'air') this.setState('move');
    if (this.state === 'attack' && this.clip && this.clip.air) { this.anim.stopClip(0.12); this.setState('move'); }
    if (this.state === 'slam') this.slamImpact();
    if (this.state === 'plunge') this.plungeImpact();
  }

  // ---------- targeting ----------
  // Pick a target inside an aim cone: stick direction if held, otherwise facing.
  // Far enemies need deliberate aim; with no input only close enemies in front are taken.
  selectTarget(maxDist, dir, lockMode = false, cone = 0.85) {
    let best = null, bestScore = 1e9;
    const p = this.body.pos;
    const fwd = dir && dir.lengthSq() > 0.01 ? dir : (lockMode ? this.game.camRig.forward(_f2) : this.forward(_f2));
    for (const e of this.game.enemies) {
      if (!e.alive || e.state === 'victim' || e.spawning) continue;
      const dx = e.body.pos.x - p.x, dz = e.body.pos.z - p.z, dy = e.body.pos.y - p.y;
      const d = Math.hypot(dx, dz);
      if (d > maxDist || Math.abs(dy) > 2.6) continue;
      const ang = Math.acos(clamp((dx * fwd.x + dz * fwd.z) / Math.max(d, 1e-4), -1, 1));
      if (ang > (lockMode ? 1.3 : cone) && d > 1.5) continue;
      const score = d * 0.7 + ang * 3.5 - (e.isBoss ? 1 : 0) - (e.timeToHit() < 0.6 ? 0.6 : 0);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  switchTarget(side) {
    const cam = this.game.camRig;
    const r = cam.right(_r), f = cam.forward(_f);
    const lat = (e) => {
      const dx = e.body.pos.x - this.body.pos.x, dz = e.body.pos.z - this.body.pos.z;
      return Math.atan2(dx * r.x + dz * r.z, dx * f.x + dz * f.z);
    };
    const cur = lat(this.lock);
    let best = null, bd = 1e9;
    for (const e of this.game.enemies) {
      if (!e.alive || e === this.lock || e.spawning || e.state === 'victim' || this.distTo(e) > 16) continue;
      const d = (lat(e) - cur) * side;
      if (d > 0.05 && d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // ---------- attacks ----------
  startAttack(kind, mv, mag) {
    const g = this.game;
    const inAir = !this.body.grounded;
    const dir = mag > 0.2 ? _dir : null;
    const lunge = inAir ? 4.0 : kind === 'heavy' ? 3.6 : 4.6;
    let target = null;
    if (this.lock && this.lock.alive && this.distTo(this.lock) < lunge + 0.4) {
      // locked: stay on the lock unless the stick clearly aims elsewhere
      const dx = this.lock.body.pos.x - this.body.pos.x, dz = this.lock.body.pos.z - this.body.pos.z;
      const away = dir && (dx * dir.x + dz * dir.z) / Math.hypot(dx, dz) < -0.2;
      target = away ? this.selectTarget(lunge, dir) : this.lock;
    } else target = dir ? this.selectTarget(lunge, dir) : this.selectTarget(2.6, null, false, 1.1);
    this.target = target;

    // executions (heavy on an open enemy, or any heavy at full focus)
    if (kind === 'heavy' && target && !inAir && this.distTo(target) < 4.5) {
      if (target.canBeExecuted() || (this.focus >= 100 && !target.isBoss)) {
          if (this.focus >= 100 && !target.canBeExecuted()) this.focus = 0;
        g.execute(this, target);
        return;
      }
    }
    // attacking into empty space turns you toward the stick
    if (!target && dir) this.yaw = Math.atan2(dir.x, dir.z);
    // riposte after parry
    if (kind === 'light' && this.parried && this.parried.alive && this.deflectT > 0 && this.parried.state === 'parried') {
      target = this.target = this.parried;
      this.playAttack(PLAYER.riposte, target);
      this.parried = null;
      return;
    }
    let clip;
    if (kind === 'kick') clip = PLAYER.kick;
    else if (kind === 'heavy') clip = PLAYER.heavy;
    else if (inAir) {
      if (this.airAttacks >= 3) return;
      clip = this.airAttacks % 2 === 0 ? PLAYER.air1 : PLAYER.air2;
      this.airAttacks++;
    }
    else {
      if (g.time.game - this.lastAttackT > 0.65) this.comboStep = 0;
      clip = PLAYER[COMBO_CHAIN[this.comboStep % 4]];
      // variety: long distance targets get a thrust, every so often swap in a thrust mid-chain
      if (target && this.distTo(target) > 3.4 && this.comboStep !== 3) clip = PLAYER.thrust;
      this.comboStep = (this.comboStep + 1) % 4;
    }
    this.lastAttackT = g.time.game;
    const reach = kind === 'kick' ? 1.5 : 1.85;
    if (target && this.distTo(target) > reach + 0.25 && Math.abs(target.body.pos.y - this.body.pos.y) < 2.5) {
      this.startDash(clip, target, kind);
      return;
    }
    this.playAttack(clip, target);
  }

  playAttack(clip, target, startAt = 0) {
    this.clip = clip;
    this.setState('attack');
    this.mash = 0;
    this.perfectSwing = !!this.rhythm;
    this.rhythm = false;
    this.hitSet.clear();
    this.whooshed = false;
    this.spinDone = 0;
    const sp = this.attackSpeed();
    if (startAt > 0 && this.anim.clip === clip) {
      this.anim.clipSpeed = sp;
    } else this.anim.playClip(clip, { speed: sp, startAt, blendIn: 0.04 });
    this.stateT = startAt / sp;
    if (clip.hop) this.body.vel.y = clip.hop;
    if (clip.air) this.body.vel.y = Math.max(this.body.vel.y, this.airAttacks <= 1 ? 2.4 : 0.6);
    if (target) this.yaw = dampAngle(this.yaw, this.yawTo(target.body.pos.x, target.body.pos.z), 30, 0.05);
    this.heavyHeldCheck = clip === PLAYER.heavy;
  }

  attackSpeed() {
    return 1 + Math.min(this.combo, 25) * 0.012;
  }

  startDash(clip, target, kind) {
    this.setState('dash');
    this.clip = clip;
    this.dashTarget = target;
    this.dashKind = kind;
    const d = this.distTo(target);
    this.dashDur = clamp((d - 1.35) / 13, 0.06, 0.26);
    this.dashFrom = this.body.pos.clone();
    const chamberT = clip.keys[1].t;
    this.anim.playClip(clip, { speed: chamberT / Math.max(0.06, this.dashDur * 0.85), blendIn: 0.04 });
    this.anim.airFeet = [_lf.set(0.13, 0.12, 0.38), _rf.set(-0.13, 0.25, -0.35)];
    if (!this.body.grounded) this.body.vel.y = Math.max(this.body.vel.y, 1.5);
    this.game.audio.play('dodge', { pos: this.body.pos, volume: 0.45, rate: 1.4 });
    this.game.camRig.zoomKick(-2.5);
  }

  stDash(dt) {
    const t = this.dashTarget;
    const chamberT = this.clip.keys[1].t;
    if (this.anim.clipT > chamberT) this.anim.clipT = chamberT;
    if (!t || !t.alive) { this.anim.airFeet = null; this.playAttack(this.clip, null, chamberT); return 24; }
    const dx = t.body.pos.x - this.body.pos.x, dz = t.body.pos.z - this.body.pos.z;
    const d = Math.hypot(dx, dz);
    this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), 30, dt);
    const stopAt = (this.clip.range ?? 1.15) + 0.25 + (t.rig.scale - 1) * 0.3;
    const speed = Math.max(9, (d - stopAt) / Math.max(0.03, this.dashDur - this.stateT + 0.02));
    const sp = Math.min(speed, 15);
    this.body.vel.x = (dx / d) * sp;
    this.body.vel.z = (dz / d) * sp;
    this.anim.bodyTilt.x = damp(this.anim.bodyTilt.x, 0.35, 12, dt);
    if (d <= stopAt + 0.15 || this.stateT > this.dashDur + 0.12 || this.body.wallHit) {
      this.body.vel.x *= 0.25; this.body.vel.z *= 0.25;
      this.anim.airFeet = null;
      this.playAttack(this.clip, t, chamberT);
    }
    return this.body.grounded ? 24 : 14;
  }

  stAttack(dt, mv, mag) {
    const g = this.game, inp = g.input;
    const clip = this.clip;
    const t = this.anim.clip === clip ? this.anim.clipT : 99;
    const b = this.body;
    // heavy charge
    if (this.heavyHeldCheck && t > 0.16) {
      this.heavyHeldCheck = false;
      if (inp.isHeld('heavy') && b.grounded) { this.startCharge(); return 24; }
    }
    // root motion lunge (stops short of target)
    if (clip.lunge && t >= clip.lunge[0] && t <= clip.lunge[1]) {
      const span = clip.lunge[1] - clip.lunge[0];
      const u = (t - clip.lunge[0]) / span;
      let v = (clip.lunge[2] / span) * (Math.PI / 2) * Math.cos(u * Math.PI / 2) * this.anim.clipSpeed;
      if (this.target && this.target.alive) {
        // close to the spacing where this swing's arc cuts through the body
        const d = this.distTo(this.target);
        const want = (clip.range ?? 1.15) * (0.85 + 0.15 * this.target.rig.scale) + (this.target.rig.scale - 1) * 0.3;
        const remain = Math.max(0.05, (clip.lunge[1] - t) / this.anim.clipSpeed);
        v = clamp((d - want) / remain, -3, 10);
        this.yaw = dampAngle(this.yaw, this.yawTo(this.target.body.pos.x, this.target.body.pos.z), 20, dt);
      } else if (mag > 0.2 && t < (clip.hit ? clip.hit[0] : 0.1)) this.yaw = dampAngle(this.yaw, Math.atan2(mv.x, mv.z), 12, dt);
      b.vel.x = Math.sin(this.yaw) * v;
      b.vel.z = Math.cos(this.yaw) * v;
    } else {
      b.vel.x = damp(b.vel.x, 0, 14, dt);
      b.vel.z = damp(b.vel.z, 0, 14, dt);
    }
    // spin
    if (clip.spin && t >= clip.spin[0] && t <= clip.spin[1] + 0.02) {
      const want = clamp((t - clip.spin[0]) / (clip.spin[1] - clip.spin[0]), 0, 1) * clip.spin[2];
      this.yaw += want - this.spinDone;
      this.spinDone = want;
    }
    // trail + whoosh
    if (clip.hit) {
      this.trailOn = t >= clip.hit[0] - 0.035 && t <= clip.hit[1] + 0.05;
      if (!this.whooshed && t >= clip.hit[0] - 0.03) {
        this.whooshed = true;
        g.audio.play(clip.heavy ? 'whoosh_heavy' : clip.spin ? 'whoosh_spin' : 'whoosh_light', { pos: b.pos, rate: this.anim.clipSpeed * rand(0.95, 1.08) });
      }
      if (t >= clip.hit[0] && t <= clip.hit[1] + 0.001) this.sweepHits(clip, t >= clip.hit[1] - 0.02);
    }
    // gravity during air attacks
    let grav = 24;
    if (clip.air) { grav = 5; if (b.vel.y < -1) b.vel.y = damp(b.vel.y, -1, 10, dt); }
    // cancels — strikes must be timed: presses well before the window are thrown away,
    // and mashing (2+ early presses) kills the chain for this swing.
    const afterHit = !clip.hit || t > clip.hit[1];
    const cancelT = clip.cancel ?? clip.dur;
    if (t < cancelT - 0.13 && inp.peek('light', 0.03)) {
      inp.take('light');
      this.mash = (this.mash || 0) + 1;
      if (this.mash === 2 && !this.mashHinted) { this.mashHinted = true; g.hud.hint('Time your strikes · mashing breaks the chain', 3.5); }
    }
    if (t >= cancelT && (this.mash || 0) < 2) {
      if (inp.peek('light', 0.3) || inp.peek('heavy', 0.3) || inp.peek('kick', 0.3) || inp.peek('art', 0.3)) {
        this.rhythm = inp.peek('light', 0.3) && (t - cancelT) < 0.16;
        if (this.tryActions(mv, mag, false)) return grav;
      }
    }
    if (afterHit || t < (clip.hit ? clip.hit[0] - 0.05 : 0)) {
      if (inp.peek('dodge', 0.12) || inp.peek('parry', 0.12)) {
        if (inp.take('parry')) { this.startParry(); return grav; }
        if (inp.take('dodge', 0.12)) { this.startDodge(mv, mag, !b.grounded); return grav; }
      }
      if (afterHit && b.grounded && inp.take('jump', 0.12)) { this.jump(); return grav; }
    }
    if (t >= clip.dur - 0.12 || this.anim.clip !== clip) {
      this.trailOn = false;
      if ((this.mash || 0) >= 2) {
        // overswung: a beat to recover your footing
        this.fumbleT = 0.32;
        this.anim.flinch.v -= 4;
        this.anim.twist.v += 6;
        inp.take('light');
      }
      this.setState(b.grounded ? 'move' : 'air');
      this.anim.stopClip(0.18);
    }
    return grav;
  }

  // blade sweep vs enemies: the blade has to actually pass through the body.
  sweepHits(clip, final) {
    const g = this.game;
    const r0b = this.prevBase, r0t = this.prevTip, r1b = this.bladeBase, r1t = this.bladeTip;
    let firstS = 2;
    for (const e of g.enemies) {
      if (!e.alive || this.hitSet.has(e) || e.state === 'victim' || e.spawning) continue;
      const S = e.rig.scale;
      _ea.copy(e.body.pos).setY(e.body.pos.y + 0.3 * S);
      _eb.copy(e.body.pos).setY(e.body.pos.y + 1.72 * S);
      const rad = (clip.kick ? 0.3 : 0.22) * S + 0.03;
      let hitS = -1, best = 1e9;
      for (let k = 0; k <= 6; k++) {
        const s = k / 6;
        if (clip.kick) {
          // kicks connect with the foot, not the sword
          this.rig.bones['shin.R'].getWorldPosition(_sa);
          this.rig.bones['foot.R'].getWorldPosition(_sb);
          _sb.addScaledVector(this.forward(_sw), 0.12);
        } else {
          _sa.lerpVectors(r0b, r1b, s);
          _sb.lerpVectors(r0t, r1t, s);
        }
        const d2 = segSegDistSq(_sa, _sb, _ea, _eb, _ca, _cb);
        if (d2 < best) { best = d2; _bca.copy(_ca); _bcb.copy(_cb); }
        if (d2 < rad * rad) { hitS = s; _bca.copy(_ca); _bcb.copy(_cb); break; }
      }
      // forgiving only for the chosen target, and only when the edge really grazes it
      if (hitS < 0 && final && e === this.target && best < (rad + 0.22) * (rad + 0.22)) hitS = 1;
      if (hitS < 0) continue;
      this.hitSet.add(e);
      // contact point on the body surface
      const off = _sw.subVectors(_bca, _bcb);
      const ol = off.length();
      const point = _pt.copy(_bcb);
      if (ol > 1e-4) point.addScaledVector(off, Math.min(ol, rad * 0.9) / ol);
      const dir = _sw.subVectors(r1t, r0t);
      if (dir.lengthSq() < 1e-6 || clip.kick) this.forward(dir);
      dir.normalize();
      firstS = Math.min(firstS, hitS);
      g.playerHits(this, e, clip, point, dir);
    }
    // freeze on the exact frame the steel meets the body
    if (firstS <= 1 && !clip.kick) {
      this.rewindToContact(firstS);
      if (firstS < 1) this.trail.samples.pop(); // don't let the trail fold back over the rewind
    }
    // breakables
    for (const b of g.level.breakables) {
      if (!b.alive || this.hitSet.has(b)) continue;
      const d = Math.min(this.bladeTip.distanceTo(b.pos), _sa.lerpVectors(this.bladeTip, this.bladeBase, 0.5).distanceTo(b.pos));
      if (d < b.size * 0.75 + 0.1) {
        this.hitSet.add(b);
        g.level.breakObject(b, this.forward(_sw));
        g.time.stop(0.03);
        g.camRig.shake(0.12);
      }
    }
  }

  // ---------- charge / slam / plunge ----------
  startCharge() {
    this.setState('charge');
    this.anim.clipSpeed = 0;
    this.chargeT = 0;
    this.game.audio.play('fire_ignite', { pos: this.body.pos, volume: 0.25, rate: 1.6 });
  }
  stCharge(dt) {
    const g = this.game;
    this.chargeT += dt;
    this.body.vel.x = damp(this.body.vel.x, 0, 12, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 12, dt);
    const tgt = this.selectTarget(9, null);
    if (tgt) this.faceTo(tgt.body.pos.x, tgt.body.pos.z, 8, dt);
    this.anim.flinch.x = Math.sin(this.chargeT * 40) * 0.08 * Math.min(1, this.chargeT * 2);
    if (this.chargeT > 0.25) g.fx.emberBurst(this.bladeTip, 1, 0.05);
    if (!g.input.isHeld('heavy') || this.chargeT > 0.9) {
      if (this.chargeT > 0.3) this.startSlam(tgt);
      else { this.anim.clipSpeed = 1; this.setState('attack'); this.clip = PLAYER.heavy; this.stateT = 0.18; }
    }
  }
  startSlam(tgt) {
    this.setState('slam');
    const d = tgt ? Math.min(this.distTo(tgt), 7) : 3;
    const flight = 0.62;
    this.body.vel.y = 9.5;
    const sp = Math.max(2, d / flight);
    this.body.vel.x = Math.sin(this.yaw) * sp;
    this.body.vel.z = Math.cos(this.yaw) * sp;
    this.body.grounded = false;
    this.anim.clipSpeed = 0;
    this.game.audio.play('whoosh_heavy', { pos: this.body.pos, rate: 0.8 });
    this.flipT = 0;
  }
  stSlam(dt) {
    this.flipT += dt;
    this.anim.flip = -Math.PI * 2 * ease.inOut(Math.min(1, this.flipT / 0.55));
    if (this.flipT > 0.55) this.anim.flip = 0;
    return 30;
  }
  slamImpact() {
    const g = this.game;
    this.anim.flip = 0;
    this.body.vel.set(0, 0, 0);
    this.clip = PLAYER.heavy;
    this.anim.clipSpeed = 1.3;
    this.anim.clipT = 0.27;
    this.setState('attack');
    this.stateT = 0.3;
    this.hitSet.clear();
    this.whooshed = true;
    g.aoe(this, this.body.pos, 3.4, 42, 'slam');
  }
  startPlunge() {
    this.setState('plunge');
    this.anim.playClip(PLAYER.plunge, { blendIn: 0.05 });
    this.body.vel.y = Math.min(this.body.vel.y, 4);
    this.body.vel.x *= 0.3; this.body.vel.z *= 0.3;
    this.trailOn = true;
  }
  stPlunge(dt) {
    if (this.stateT > 0.12) this.body.vel.y = Math.min(this.body.vel.y, -24);
    else this.body.vel.y = damp(this.body.vel.y, 1, 10, dt);
    return this.stateT > 0.12 ? 60 : 4;
  }
  plungeImpact() {
    const g = this.game;
    this.trailOn = false;
    this.anim.stopClip(0.25);
    this.setState('hit');
    this.hitRecover = 0.35;
    this.invuln = 0.3;
    g.aoe(this, this.body.pos, 2.6, 46, 'plunge');
  }

  // ---------- defense ----------
  startParry() {
    if (this.parryCD > 0 && this.state === 'parry') return;
    this.setState('parry');
    this.parryT = 0;
    this.parryCD = 0.12;
    this.anim.playClip(PLAYER.parry, { blendIn: 0.03, speed: 1.2 });
    this.trailOn = false;
  }
  stParry(dt, mv, mag) {
    const inp = this.game.input;
    this.groundMove(dt, mv, mag, 1.2, 30, 6);
    this.faceThreat(dt);
    if (this.stateT > 0.36) {
      if (inp.isHeld('parry')) { this.setState('block'); this.anim.playClip(PLAYER.block, { blendIn: 0.08 }); }
      else { this.setState('move'); this.anim.stopClip(0.15); }
    }
    if (this.stateT > 0.22) {
      if (inp.take('light', 0.15)) { this.startAttack('light', mv, mag); return; }
      if (inp.take('dodge', 0.12)) { this.startDodge(mv, mag); return; }
    }
  }
  stBlock(dt, mv, mag) {
    const inp = this.game.input;
    this.groundMove(dt, mv, mag, 1.8, 30, 6);
    this.faceThreat(dt);
    if (!inp.isHeld('parry')) { this.setState('move'); this.anim.stopClip(0.15); return; }
    if (inp.take('light', 0.15)) { this.startAttack('light', mv, mag); return; }
    if (inp.take('dodge', 0.12)) { this.startDodge(mv, mag); return; }
    if (inp.take('kick', 0.15)) { this.startAttack('kick', mv, mag); return; }
  }
  stDeflect(dt, mv, mag) {
    const inp = this.game.input;
    this.body.vel.x = damp(this.body.vel.x, 0, 10, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 10, dt);
    if (this.parried && this.parried.alive) this.faceTo(this.parried.body.pos.x, this.parried.body.pos.z, 14, dt);
    if (inp.take('parry')) { this.startParry(); return; }
    if (this.stateT > 0.06) {
      if (inp.take('light', 0.3)) { this.startAttack('light', mv, mag); return; }
      if (inp.take('heavy', 0.3)) { this.startAttack('heavy', mv, mag); return; }
      if (inp.take('dodge', 0.12)) { this.startDodge(mv, mag); return; }
      if (inp.take('kick', 0.2)) { this.startAttack('kick', mv, mag); return; }
    }
    if (this.stateT > 0.32) { this.setState(inp.isHeld('parry') ? 'block' : 'move'); if (this.state === 'block') this.anim.playClip(PLAYER.block, { blendIn: 0.08 }); else this.anim.stopClip(0.2); }
  }
  // Snap our blade onto the point where the enemy's steel arrives, then throw it off.
  meetBlade(contactW, edirW, deflect) {
    this.rig.root.rotation.set(0, this.yaw, 0);
    this.rig.root.updateMatrixWorld(true);
    const C = this.rig.root.worldToLocal(_mc.copy(contactW));
    const E = edirW ? _me.copy(edirW).transformDirection(_mi.copy(this.rig.root.matrixWorld).invert()) : _me.set(1, 0, 0);
    const G0 = _mg.set(-0.14, 1.28, 0.3);
    const toC = _mb.subVectors(C, G0);
    const L = toC.length();
    toC.normalize();
    const G = _mg2.copy(C).addScaledVector(toC, -Math.min(L, 0.62));
    G.x = clamp(G.x, -0.5, 0.42); G.y = clamp(G.y, 0.8, 1.8); G.z = clamp(G.z, 0.12, 0.62);
    const Bd = _mb.subVectors(C, G).normalize();
    // recoil: blade swept along the enemy's line of travel
    const Br = _mr.copy(Bd).addScaledVector(E, deflect ? 0.9 : 0.35).normalize();
    const tw = clamp(C.x * 0.9, -0.55, 0.55);
    const clip = compileClip({
      keys: [
        { t: 0, g: G.toArray(), b: Bd.toArray(), tw, hy: -0.06 },
        { t: 0.03, g: G.toArray(), b: Bd.toArray(), tw, ln: -0.05, hy: -0.08, e: 'outExpo' },
        { t: 0.12, g: G.toArray(), b: Bd.toArray(), tw, ln: -0.06, hy: -0.08, e: 'linear' },
        { t: 0.22, g: [G.x + E.x * 0.12, G.y + 0.1, G.z - 0.05], b: Br.toArray(), tw: tw * 0.5, ln: -0.12, hy: -0.08, e: 'outExpo' },
        { t: 0.48, ...{ g: GUARD.g, b: GUARD.b, l: GUARD.l, tw: GUARD.tw, hy: GUARD.hy }, e: 'inOut' },
      ],
    });
    this.anim.playClip(clip, { startAt: 0.03, blendIn: 0.01 });
    this.anim.final.grip.copy(G);
  }

  faceThreat(dt) {
    const e = this.game.nearestThreat(this.body.pos, 6);
    if (e) this.faceTo(e.body.pos.x, e.body.pos.z, 10, dt);
  }

  // Called by game when an enemy strike reaches us. Returns 'parried' | 'blocked' | 'dodged' | 'hit'
  receiveStrike(enemy, info) {
    const g = this.game;
    if (!this.alive) return 'miss';
    if (this.state === 'execute' || this.invuln > 0 || this.state === 'vault' || this.state === 'art') return 'dodged';
    if (this.state === 'dodge' && this.iframes > 0) { g.perfectDodge(this, enemy); return 'dodged'; }
    const window = info.parryWindow ?? 0.32;
    const canParry = !info.unblockable && (this.state === 'parry' || this.state === 'block' || this.state === 'deflect');
    if (canParry && this.parryT <= window + 0.02) {
      this.setState('deflect');
      this.parried = enemy;
      this.deflectT = 0.85;
      this.faceTo(enemy.body.pos.x, enemy.body.pos.z, 1000, 1);
      if (info.contact) this.meetBlade(info.contact, info.edir, true);
      else this.anim.playClip(PLAYER.deflect, { blendIn: 0.02 });
      this.focus = Math.min(100, this.focus + 14);
      return 'parried';
    }
    if (!info.unblockable && this.state === 'block' && info.perilous !== 'thrust') {
      if (info.contact) this.meetBlade(info.contact, info.edir, false);
      this.damage(info.dmg * (info.chip ?? 0.15), info, true);
      const away = _sw.subVectors(this.body.pos, enemy.body.pos).setY(0).normalize();
      this.body.vel.addScaledVector(away, 3.2);
      return 'blocked';
    }
    if (!info.unblockable && (this.state === 'parry' || this.state === 'block') && this.parryT > window) {
      this.game.hud.popup(this.parryT < window + 0.35 ? 'EARLY' : 'BLOCK LATE', this.headPos(_mc), '#ff8a6a', 0.7);
    }
    this.damage(info.dmg, info, false, enemy);
    return 'hit';
  }

  damage(amount, info, blocked, from) {
    const g = this.game;
    this.hp -= amount;
    if (!blocked) {
      if (this.combo > 0) { this.combo = 0; g.hud.comboEnd(true); }
      const away = _sw.subVectors(this.body.pos, from ? from.body.pos : this.body.pos).setY(0);
      if (away.lengthSq() < 1e-4) this.forward(away).negate();
      away.normalize();
      const local = this.toLocal(away, _loc);
      this.anim.hit(-local.x, -local.z, info.heavy ? 1.6 : 1);
      this.body.vel.addScaledVector(away, info.heavy ? 7 : 4);
      this.trailOn = false;
      const heavy = info.heavy || amount >= 25;
      if (this.hp > 0) {
        this.anim.stopClip(0.08);
        if (heavy) { this.setState('down'); this.downDir = away.clone(); this.body.vel.y = 3; }
        else { this.setState('hit'); this.hitRecover = 0.36; }
      }
    }
    if (this.hp <= 0) this.die(info, from);
  }

  stHit(dt) {
    this.body.vel.x = damp(this.body.vel.x, 0, 7, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 7, dt);
    if (this.stateT > (this.hitRecover ?? 0.36)) this.setState(this.body.grounded ? 'move' : 'air');
    const inp = this.game.input;
    if (this.stateT > 0.18 && inp.take('dodge', 0.15)) this.startDodge(this.moveVector(_mv), Math.min(1, _mv.length()));
  }
  stDown(dt) {
    const t = this.stateT;
    this.body.vel.x = damp(this.body.vel.x, 0, 4, dt);
    this.body.vel.z = damp(this.body.vel.z, 0, 4, dt);
    // fall back, lie, get up
    const fall = Math.min(1, t / 0.28);
    const rise = clamp((t - 0.75) / 0.35, 0, 1);
    this.anim.flip = (-1.35 * ease.out(fall)) * (1 - ease.inOut(rise));
    if (t > 0.25) this.invuln = 0.15;
    const inp = this.game.input;
    if (t > 0.5 && t < 0.75 && inp.take('dodge', 0.2)) { this.stateT = 0.75; }
    if (t > 1.1) { this.anim.flip = 0; this.setState('move'); this.invuln = 0.25; }
  }

  startDodge(mv, mag, air = false) {
    const g = this.game;
    const dir = mag > 0.2 ? _dd.copy(mv).normalize() : this.forward(_dd).negate();
    // vault over an enemy in the way
    if (mag > 0.2 && !air) {
      for (const e of g.enemies) {
        if (!e.alive || e.isBoss || e.spawning || e.state === 'victim') continue;
        const dx = e.body.pos.x - this.body.pos.x, dz = e.body.pos.z - this.body.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 2.4 && (dx * dir.x + dz * dir.z) / d > 0.8 && Math.abs(e.body.pos.y - this.body.pos.y) < 0.5) {
          this.startVault(e, dir);
          return;
        }
      }
    }
    this.setState('dodge');
    this.dodgeDir = dir.clone();
    this.iframes = 0.26;
    this.anim.stopClip(0.08);
    this.trailOn = false;
    if (!this.combat && !this.lock && mag > 0.2) this.yaw = Math.atan2(dir.x, dir.z);
    const local = this.toLocal(dir, _loc);
    this.dodgeLocal = { x: local.x, z: local.z };
    if (air) this.body.vel.y = 1.5;
    g.audio.play('dodge', { pos: this.body.pos, volume: 0.6 });
  }
  stDodge(dt, mv, mag) {
    const t = this.stateT;
    const k = Math.max(0, 1 - t / 0.34);
    const sp = 14.5 * Math.pow(k, 1.4) + 1.5;
    this.body.vel.x = this.dodgeDir.x * sp;
    this.body.vel.z = this.dodgeDir.z * sp;
    // lean into it
    this.anim.bodyTilt.x = damp(this.anim.bodyTilt.x, this.dodgeLocal.z * 0.45, 20, dt);
    this.anim.bodyTilt.y = damp(this.anim.bodyTilt.y, this.dodgeLocal.x * 0.5, 20, dt);
    this.anim.hipsBob = -0.12 * Math.sin(Math.min(1, t / 0.3) * Math.PI);
    const inp = this.game.input;
    if (t > 0.16) {
      if (inp.take('light', 0.2)) { this.startAttack('light', mv, mag); return 24; }
      if (inp.take('parry')) { this.startParry(); return 24; }
      if (inp.take('kick', 0.2)) { this.startAttack('kick', mv, mag); return 24; }
      if (inp.take('jump', 0.15) && this.body.grounded) { this.jump(); return 24; }
    }
    if (t > 0.32) {
      if (inp.isHeld('dodge') && mag > 0.5) this.sprint = true;
      this.setState(this.body.grounded ? 'move' : 'air');
    }
    return this.body.grounded ? 24 : 8;
  }

  startVault(enemy, dir) {
    this.setState('vault');
    this.vaultFrom = this.body.pos.clone();
    const ep = enemy.body.pos;
    this.vaultTo = new THREE.Vector3(ep.x + dir.x * 1.5, ep.y, ep.z + dir.z * 1.5);
    // keep landing spot out of walls
    const gy = this.game.world.groundHeight(this.vaultTo.x, this.vaultTo.z, ep.y + 1, 0.2);
    this.vaultTo.y = gy;
    this.vaultEnemy = enemy;
    this.yaw = Math.atan2(dir.x, dir.z);
    this.anim.stopClip(0.1);
    enemy.onVaulted && enemy.onVaulted(this);
    this.game.audio.play('whoosh_spin', { pos: this.body.pos, volume: 0.6, rate: 1.1 });
    this.game.time.slow(0.6, 0.25);
  }
  stVault(dt) {
    const dur = 0.5;
    const t = Math.min(1, this.stateT / dur);
    const a = this.vaultFrom, b = this.vaultTo;
    this.body.pos.set(lerp(a.x, b.x, t), lerp(a.y, b.y, t) + Math.sin(t * Math.PI) * 1.9, lerp(a.z, b.z, t));
    this.anim.flip = -Math.PI * 2 * ease.inOut(t);
    this.body.grounded = t >= 1;
    if (t >= 1) {
      this.anim.flip = 0;
      this.body.vel.set(0, 0, 0);
      this.anim.land.v += 3;
      this.game.world.resolveCircle(this.body.pos, this.body.radius, this.body.pos.y, this.body.height, 0.5);
      if (this.vaultEnemy && this.vaultEnemy.alive) this.yaw = this.yawTo(this.vaultEnemy.body.pos.x, this.vaultEnemy.body.pos.z);
      this.setState('move');
      this.game.audio.play('land', { pos: this.body.pos, volume: 0.5 });
    }
    return 0;
  }

  die(info, from) {
    const g = this.game;
    this.alive = false;
    this.hp = 0;
    this.setState('dead');
    const away = _sw.subVectors(this.body.pos, from ? from.body.pos : this.body.pos).setY(0.4).normalize();
    this.ragdollDeath(this.body.vel.clone().multiplyScalar(0.5), away.multiplyScalar(5), 'chest');
    this.dropSword(away.clone().multiplyScalar(2).setY(3));
    g.onPlayerDeath();
  }

  // ---------- pose ----------
  buildBasePose(P, dt) {
    const s = this.state;
    if (s === 'air' || s === 'vault' || s === 'slam' || (s === 'dodge' && !this.body.grounded)) {
      this.locomotionPose(P, dt, GUARD, { noTrailSword: true });
      const flipping = this.anim.flip !== 0;
      const up = this.body.vel.y;
      P.grip.set(-0.32, 1.12, -0.05);
      P.blade.set(-0.2, -0.25, -0.95).normalize();
      P.handL.set(0.3, 1.25 + clamp(up * 0.03, -0.1, 0.15), 0.1);
      P.spine.x = flipping ? 0.45 : 0.08;
      P.chest.x = flipping ? 0.3 : 0.05;
      const tuck = flipping ? 1 : clamp(0.5 - up * 0.05, 0.1, 0.8);
      P.footL = _fl.set(0.12, 0.25 + tuck * 0.35, 0.18 + tuck * 0.1);
      P.footR = _fr.set(-0.12, 0.15 + tuck * 0.25, -0.12);
      if (s === 'slam') { P.grip.set(-0.05, 1.85, -0.1); P.blade.set(0, 0.5, -0.86).normalize(); P.two = 1; }
      return;
    }
    if (s === 'mantle') {
      this.locomotionPose(P, dt, GUARD, { noTrailSword: true });
      P.grip.set(-0.3, 1.6, 0.3); P.blade.set(-0.3, 0.6, -0.7).normalize();
      P.handL.set(0.22, 1.7, 0.35);
      P.spine.x = 0.35; P.footL = _fl.set(0.12, 0.6, 0.25); P.footR = _fr.set(-0.12, 0.3, 0.05);
      return;
    }
    if (s === 'down') {
      this.locomotionPose(P, dt, GUARD, { noTrailSword: true });
      P.grip.set(-0.45, 0.9, 0.1); P.blade.set(-0.6, -0.2, 0.75).normalize();
      P.handL.set(0.4, 0.95, 0.0);
      P.hips.y = -0.3;
      return;
    }
    this.locomotionPose(P, dt, GUARD);
  }
}

const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _f2 = new THREE.Vector3(), _mv = new THREE.Vector3(), _dir = new THREE.Vector3();
const _ea = new THREE.Vector3(), _eb = new THREE.Vector3(), _sa = new THREE.Vector3(), _sb = new THREE.Vector3();
const _ca = new THREE.Vector3(), _cb = new THREE.Vector3(), _pt = new THREE.Vector3(), _sw = new THREE.Vector3();
const _dd = new THREE.Vector3(), _loc = new THREE.Vector3(), _fl = new THREE.Vector3(), _fr = new THREE.Vector3();
const _lf = new THREE.Vector3(), _rf = new THREE.Vector3(), _ad = new THREE.Vector3();
const _bca = new THREE.Vector3(), _bcb = new THREE.Vector3();
const _mc = new THREE.Vector3(), _me = new THREE.Vector3(), _mg = new THREE.Vector3(), _mg2 = new THREE.Vector3(), _mb = new THREE.Vector3(), _mr = new THREE.Vector3();
const _mi = new THREE.Matrix4();
function distToSegXZ(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 1e-6 ? ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}
