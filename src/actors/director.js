import { Enemy } from './enemy.js';
import { Boss } from './boss.js';
import { rand, pick } from '../core/math.js';

// Wave flow + Arkham-style attack tokens: only a couple of enemies commit to an attack at once.
// Each wave adds pressure and one new thing to master.
const WAVES = [
  { name: 'Blood in the Rain', tokens: 1, guard: 0.3, aggro: 1.25, maxAlive: 3,
    list: ['grunt', 'grunt', 'grunt'],
    hints: ['{light} Strike · chain hits across enemies', 'Tap {parry} as a glint turns <i>white</i> to parry · hold to block', '{heavy} on a staggered or parried enemy to execute'] },
  { name: 'Raised Guards', tokens: 1, guard: 0.55, aggro: 1.1, maxAlive: 4,
    list: ['grunt', 'shield', 'grunt', 'grunt', 'shield'],
    hints: ['A raised blade or shield blocks your slashes', '{heavy} Heavy smashes a guard open', 'Blood Art {art} unlocked · costs one focus bar'] },
  { name: 'Knives in the Dark', tokens: 2, guard: 0.55, aggro: 1.0, maxAlive: 5,
    list: ['grunt', 'thrower', 'grunt', 'shield', 'thrower', 'grunt'],
    hints: ['Parry {parry} thrown knives to send them back', '{throw} Throw a knife to interrupt a wind-up'] },
  { name: 'The Butcher', tokens: 2, guard: 0.6, aggro: 0.9, maxAlive: 5,
    list: ['brute', 'grunt', 'grunt', 'shield', 'grunt', 'thrower'],
    hints: ['<span style="color:#ff5040">Red</span> glint cannot be parried · {dodge} dodge it', 'A last-instant dodge opens them up'] },
  { name: 'No Mercy', tokens: 3, guard: 0.7, aggro: 0.8, maxAlive: 6,
    list: ['grunt', 'brute', 'shield', 'thrower', 'grunt', 'grunt', 'shield', 'brute', 'thrower', 'grunt'],
    hints: ['Jump and press {art} mid-air for a ground pound', 'Lock on with {lock} · flick the stick to switch targets'] },
];

export class Director {
  constructor(game) {
    this.game = game;
    this.reset();
  }
  reset() {
    this.wave = -1;
    this.queue = [];
    this.spawnT = 0;
    this.attackers = new Set();
    this.lastGrant = 0;
    this.lastThrow = 0;
    this.phase = 'idle'; // idle | wave | between | gate | boss | done
    this.betweenT = 0;
    this.maxTokens = 1;
    this.boss = null;
    this.guardChance = 0.3;
    this.aggro = 1.2;
    this.maxAlive = 3;
  }

  startWave(i) {
    const g = this.game;
    this.wave = i;
    const W = WAVES[i];
    this.maxTokens = W.tokens;
    this.guardChance = W.guard;
    this.aggro = W.aggro;
    this.maxAlive = W.maxAlive;
    this.queue = W.list.map((t, k) => ({ type: t, mode: 'door', v: k + i * 3 }));
    this.spawnT = 1.4;
    this.phase = 'wave';
    g.hud.banner(`WAVE ${i + 1}`, W.name);
    g.audio.play('wave_start');
    g.audio.setMusicMode('combat');
    if (i === 1) g.artUnlocked = true;
    for (const h of W.hints) g.hud.hint(h, 4.5);
  }

  spawn(def) {
    const g = this.game;
    const e = new Enemy(g, def.type, def.v);
    const sp = g.level.spawnPoints;
    // come out of the gate farthest from the player's back
    const p = g.player.body.pos;
    const doors = sp.doors.slice().sort((a, b) => b.distanceTo(p) - a.distanceTo(p));
    const pos = (Math.random() < 0.6 ? doors[0] : pick(doors.slice(0, 3))).clone();
    e.spawnAt(pos, 'door');
    e.attackCD = rand(1.0, 2.0);
    g.enemies.push(e);
  }

  requestToken(e) {
    const now = this.game.time.game;
    const p = this.game.player;
    if (!p.alive || p.state === 'execute') return false;
    this.attackers.forEach((a) => { if (!a.alive || !a.token) this.attackers.delete(a); });
    const weight = e.type === 'brute' ? 2 : 1;
    let used = 0;
    this.attackers.forEach((a) => (used += a.type === 'brute' ? 2 : 1));
    if (used + weight > Math.max(this.maxTokens, weight)) return false;
    if (now - this.lastGrant < (this.maxTokens > 1 ? 0.4 : 0.55)) return false;
    this.lastGrant = now;
    this.attackers.add(e);
    return true;
  }
  releaseToken(e) { this.attackers.delete(e); }
  requestThrow(e) {
    const now = this.game.time.game;
    if (now - this.lastThrow < 1.8) return false;
    this.lastThrow = now;
    return true;
  }

  update(dt) {
    const g = this.game;
    if (this.phase === 'wave') {
      const alive = g.enemies.filter((e) => e.alive && !e.isBoss).length;
      this.spawnT -= dt;
      if (this.queue.length && this.spawnT <= 0 && alive < this.maxAlive) {
        this.spawn(this.queue.shift());
        this.spawnT = rand(0.8, 1.6);
      }
      if (!this.queue.length && alive === 0) {
        this.phase = 'between';
        this.betweenT = 3.2;
        g.onWaveCleared(this.wave);
      }
    } else if (this.phase === 'between') {
      this.betweenT -= dt;
      if (this.betweenT <= 0) {
        if (this.wave + 1 < WAVES.length) this.startWave(this.wave + 1);
        else { this.phase = 'gate'; this.gateT = 2.5; g.hud.banner('THE GREAT GATE RISES', 'Something heavy walks toward the light'); g.audio.setMusicMode('silence'); g.level.openGate(true); }
      }
    } else if (this.phase === 'gate') {
      this.gateT -= dt;
      if (this.gateT <= 0) this.startBoss();
    }
  }

  startBoss() {
    const g = this.game;
    this.phase = 'boss';
    this.maxTokens = 1;
    const b = new Boss(g);
    b.body.pos.copy(g.level.spawnPoints.boss);
    b.yaw = 0;
    g.enemies.push(b);
    this.boss = b;
    g.onBossIntro(b);
  }

  // restart from the current checkpoint after death
  checkpoint() {
    return this.phase === 'boss' ? 'boss' : Math.max(0, this.wave);
  }

  get waveCount() { return WAVES.length; }
}
