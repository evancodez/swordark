import * as THREE from 'three';
import { Pipeline } from './render/pipeline.js';
import { FloorReflection } from './render/reflection.js';
import { makeTextures } from './render/textures.js';
import { makeMaterials, RIM_DIR } from './render/materials.js';
import { CollisionWorld } from './world/collision.js';
import { Arena } from './world/arena.js';
import { Weather, makeSky } from './world/weather.js';
import { FX } from './fx/fx.js';
import { BloodFX } from './fx/blood.js';
import { Player } from './actors/player.js';
import { Director } from './actors/director.js';
import { PLAYER, GRUNT } from './actors/clips.js';
import { buildSword } from './actors/rig.js';
import { CameraRig } from './core/camera.js';
import { input } from './core/input.js';
import { time } from './core/time.js';
import { audio } from './core/audio.js';
import { HUD } from './ui/hud.js';
import { clamp, damp, rand, pick, lerp, segSegDistSq } from './core/math.js';

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.pipeline = new Pipeline(this.canvas);
    this.renderer = this.pipeline.renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.08, 220);
    this.pipeline.onResize = (w, h) => { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); if (this.reflection) this.reflection.setSize(w * this.pipeline.pixelRatio, h * this.pipeline.pixelRatio); };
    this.pipeline.resize();
    this.input = input;
    this.time = time;
    this.audio = audio;
    input.attach(this.canvas);

    this.textures = makeTextures();
    this.materials = makeMaterials(this.textures);
    this.world = new CollisionWorld();
    this.setupLights();
    this.reflection = new FloorReflection(0.5);
    this.reflection.setSize(window.innerWidth * this.pipeline.pixelRatio, window.innerHeight * this.pipeline.pixelRatio);
    this.level = new Arena(this);
    this.level.build();
    this.artUnlocked = false;
    this.muted = new URLSearchParams(location.search).has('mute');
    this.fx = new FX(this.scene, this.world, this.textures);
    this.blood = new BloodFX(this.scene, this.world, this.textures, audio);
    this.fx.onGibHit = (pos) => { this.blood.spray(pos, new THREE.Vector3(0, 1, 0), 6, 2, 0.8, 1.1); audio.play('splat', { pos, volume: 0.5 }); };
    this.weather = new Weather(this.scene);
    this.camRig = new CameraRig(this.camera, this.world);
    this.enemies = [];
    this.projectiles = [];
    this.executions = [];
    this.timers = [];
    this.hud = new HUD(this);
    this.director = new Director(this);
    this.player = new Player(this);
    this.camRig.snapBehind(this.player.yaw);
    this.camRig.pivot.copy(this.player.body.pos);
    this.state = 'title';
    this.fxState = { damage: 0, ca: 0, blur: 0, flash: 0, red: 0 };
    this.stats = { kills: 0, maxCombo: 0, parries: 0, executions: 0, start: 0 };
    this.hud.setScreen('title');
    this.bindMenus();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  setupLights() {
    const s = this.scene;
    s.fog = new THREE.FogExp2(0x0b1018, 0.02);
    s.background = new THREE.Color(0x05070a);
    this.hemi = new THREE.HemisphereLight(0x5a6e96, 0x241a14, 0.85);
    s.add(this.hemi);
    this.moonDir = new THREE.Vector3(-0.4, 0.82, 0.42).normalize();
    const moon = new THREE.DirectionalLight(0x9fb6e6, 1.7);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    const sc = moon.shadow.camera;
    sc.left = -18; sc.right = 18; sc.top = 18; sc.bottom = -18; sc.near = 1; sc.far = 90;
    moon.shadow.bias = -0.0004;
    moon.shadow.normalBias = 0.03;
    s.add(moon, moon.target);
    this.moon = moon;
    this.sky = makeSky(this.moonDir);
    s.add(this.sky);
    // environment map for wet reflections: dark sky with warm fire spots and a bright moon
    const envScene = new THREE.Scene();
    const envSky = makeSky(this.moonDir).material.clone();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), envSky));
    const warm = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.1, 0.35), side: THREE.DoubleSide });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const m = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 6), warm);
      m.position.set(Math.cos(a) * 30, rand(-4, 2), Math.sin(a) * 30);
      envScene.add(m);
    }
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pm.fromScene(envScene, 0.02, 0.1, 100);
    s.environment = this.envRT.texture;
    s.environmentIntensity = 0.55;
    pm.dispose();
  }

  bindMenus() {
    const start = () => {
      if (this.state === 'title') this.startGame();
      else if (this.state === 'paused') this.resume();
    };
    this.canvas.addEventListener('click', start);
    for (const id of ['title', 'pause']) document.getElementById(id).addEventListener('click', start);
    document.getElementById('death').addEventListener('click', () => this.state === 'dead' && this.restartCheckpoint());
    document.getElementById('victory').addEventListener('click', () => this.state === 'victory' && this.restartAll());
    input.onPress = (a) => {
      if (this.state === 'title' && (a === 'jump' || a === 'confirm' || a === 'pause')) this.startGame();
      else if (this.state === 'paused' && (a === 'pause' || a === 'jump' || a === 'confirm')) this.resume();
      else if (this.state === 'paused' && a === 'restart') { this.resume(); this.restartCheckpoint(); }
      else if (this.state === 'play' && a === 'pause') this.pause();
      else if (this.state === 'dead' && (a === 'restart' || a === 'jump' || a === 'confirm')) this.restartCheckpoint();
      else if (this.state === 'victory' && (a === 'restart' || a === 'jump' || a === 'confirm')) this.restartAll();
    };
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.state === 'play' && input.device === 'kbm') this.pause();
    });
  }

  startGame() {
    audio.init();
    if (this.muted) audio.setMasterVolume(0);
    audio.startAmbience();
    audio.setMusicMode('explore');
    audio.play('ui_confirm');
    input.requestLock();
    input.clearBuffer();
    this.state = 'play';
    this.hud.setScreen(null);
    this.stats.start = time.real;
    this.after(1.6, () => this.director.startWave(0));
  }
  pause() {
    this.state = 'paused';
    this.hud.setScreen('pause');
    if (document.pointerLockElement) document.exitPointerLock();
  }
  resume() {
    this.state = this.player.alive ? 'play' : 'dead';
    this.hud.setScreen(this.player.alive ? null : 'death');
    input.requestLock();
    input.clearBuffer();
  }

  after(sec, fn) { this.timers.push({ t: sec, fn }); }

  // ---------------- queries ----------------
  enemiesNear(pos, r) {
    let n = 0;
    for (const e of this.enemies) if (e.alive && !e.spawning && Math.hypot(e.body.pos.x - pos.x, e.body.pos.z - pos.z) < r) n++;
    return n;
  }
  nearestThreat(pos, r) {
    let best = null, bt = Infinity, bd = Infinity;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.body.pos.x - pos.x, e.body.pos.z - pos.z);
      if (d > r) continue;
      const t = e.timeToHit();
      if (t < bt || (t === Infinity && bt === Infinity && d < bd)) { bt = t; bd = d; best = e; }
    }
    return best;
  }
  nearestExecutable(p, r) {
    let best = null, bd = r;
    for (const e of this.enemies) {
      if (!e.alive || !e.canBeExecuted()) continue;
      const d = p.distTo(e);
      if (d < bd && Math.abs(e.body.pos.y - p.body.pos.y) < 1.5) { bd = d; best = e; }
    }
    return best;
  }

  // fighters don't walk through each other (enemies give way more than the player)
  separateBodies() {
    const P = this.player;
    const list = this.enemies.filter((e) => e.alive && e.state !== 'victim');
    if (P.alive && !['dash', 'art', 'vault', 'execute', 'plunge'].includes(P.state)) list.push(P);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (Math.abs(a.body.pos.y - b.body.pos.y) > 1.3) continue;
      const dx = b.body.pos.x - a.body.pos.x, dz = b.body.pos.z - a.body.pos.z;
      const d = Math.hypot(dx, dz), min = (a.body.radius + b.body.radius) * 0.92;
      if (d >= min || d < 1e-5) continue;
      const push = min - d, nx = dx / d, nz = dz / d;
      const wa = a === P ? 0.3 : b === P ? 0.7 : 0.5;
      a.body.pos.x -= nx * push * wa; a.body.pos.z -= nz * push * wa;
      b.body.pos.x += nx * push * (1 - wa); b.body.pos.z += nz * push * (1 - wa);
      this.world.resolveCircle(a.body.pos, a.body.radius, a.body.pos.y, a.body.height, 0.5);
      this.world.resolveCircle(b.body.pos, b.body.radius, b.body.pos.y, b.body.height, 0.5);
    }
  }

  // ---------------- combat ----------------
  playerHits(player, enemy, clip, point, dir) {
    const kind = clip.riposte ? 'riposte' : clip.heavy ? 'heavy' : clip.air ? 'air' : clip.spin ? 'spin' : 'light';
    let dmg = clip.dmg;
    if (enemy.state === 'confused') dmg *= 1.6;
    if (enemy.state === 'parried' && !enemy.isBoss) dmg *= 2;
    if (player.perfectSwing) dmg *= 1.25;
    const info = { attacker: player, dmg, kind, dir: dir.clone(), point: point.clone(), knock: clip.knock };
    const res = enemy.receiveHit(info);
    if (res === 'none') return;
    if (res === 'blocked' || res === 'guardbreak') {
      // sparks where the two blades actually cross (or the shield face)
      const sp = new THREE.Vector3();
      if (enemy.shield) enemy.shield.getWorldPosition(sp);
      else { segSegDistSq(player.bladeBase, player.bladeTip, enemy.bladeBase, enemy.bladeTip, _ca1, _cb1); sp.copy(_ca1).lerp(_cb1, 0.5); }
      this.fx.sparksBurst(sp, dir.clone().negate(), res === 'guardbreak' ? 45 : 24, 7);
      this.fx.flash(sp, 0.45, 0.08);
      audio.play(res === 'guardbreak' ? 'parry' : 'clash', { pos: point, rate: res === 'guardbreak' ? 0.8 : 1 });
      time.stop(res === 'guardbreak' ? 0.11 : 0.07);
      this.camRig.shake(res === 'guardbreak' ? 0.3 : 0.16);
      this.camRig.punch(dir.clone().negate(), 0.05);
      input.rumble(0.4, 0.7, 100);
      if (res === 'guardbreak') { this.hud.popup('GUARD BREAK', enemy.headPos(new THREE.Vector3()), '#ffb347'); enemy.rig.material.userData.uniforms.uHitFlash.value = 0.8; }
      else if (!this._blockHinted) { this._blockHinted = true; this.hud.hint('Guard up! {heavy} heavy breaks it, or parry their attack', 4); }
      if (res === 'blocked') {
        // our blade bounces off
        player.anim.playClip(PLAYER.deflect, { blendIn: 0.02 });
        player.setState('deflect');
        player.deflectT = 0;
        player.parried = null;
      }
      return;
    }
    // ---- flesh ----
    const killed = res === 'killed';
    const heavy = kind === 'heavy' || kind === 'riposte' || kind === 'spin';
    const out = new THREE.Vector3().subVectors(point, enemy.center(new THREE.Vector3())).setY(0).normalize();
    const spray = dir.clone().multiplyScalar(0.8).add(out.multiplyScalar(0.6)).normalize();
    spray.y = Math.max(spray.y, 0.15);
    {
      const big = heavy || info.counter || killed || player.perfectSwing;
      this.fx.slashFlash(point, dir, big ? [4, 0.8, 0.5] : [2.6, 0.5, 0.35], big ? 1.4 : 1);
      this.blood.spray(point, spray, big ? 85 : 50, big ? 8.5 : 6.5, 0.45, big ? 1.35 : 1.05);
      if (killed) this.blood.spray(point, spray.clone().negate().setY(0.4), 40, 4, 0.6, 1.2);
      enemy.rig.addBlood(point, heavy ? 0.17 : 0.12);
      player.bladeBlood = Math.min(1, player.bladeBlood + 0.07);
      audio.play(big ? 'flesh_heavy' : 'flesh', { pos: point });
      if (!killed && Math.random() < 0.55) audio.play('grunt', { pos: point, rate: rand(0.85, 1.15) * (enemy.type === 'brute' ? 0.75 : 1) });
      time.stop(killed ? 0.14 : info.counter ? 0.12 : heavy ? 0.11 : 0.075);
      this.camRig.shake(killed ? 0.38 : heavy ? 0.32 : 0.18);
      this.camRig.punch(dir, heavy || killed ? 0.11 : 0.06);
      this.camRig.zoomKick(killed ? -4 : heavy ? -2.5 : -1);
      input.rumble(big ? 1 : 0.5, big ? 0.7 : 0.85, big ? 160 : 80);
      this.fxState.ca = Math.max(this.fxState.ca, big ? 1.2 : 0.6);
      enemy.rig.material.userData.uniforms.uHitFlash.value = big ? 0.75 : 0.5;
      if (info.counter) { this.hud.popup('COUNTER', enemy.headPos(new THREE.Vector3()), '#ff6a4a'); time.slow(0.4, 0.18); }
      else if (player.perfectSwing && !killed) this.hud.popup('✦', point, '#ffd27a', 0.5);
      if (killed && player.distTo(enemy) < 2.4 && Math.random() < 0.5) this.hud.screenBlood(0.35);
      if (killed && big) this.fx.gibs(point, dir, 5);
    }
    // combo + focus
    player.combo++;
    player.comboTimer = 2.4;
    player.focus = Math.min(100, player.focus + 4);
    if (player.combo === player.specialAt) { this.hud.popup('TAKEDOWN READY', player.headPos(new THREE.Vector3()), '#ffd27a', 0.8); audio.play('combo_tick', { rate: 0.7 }); }
    this.stats.maxCombo = Math.max(this.stats.maxCombo, player.combo);
    this.hud.comboHit(player.combo);
    if (killed) {
      // dismemberment
      const S = enemy.rig.scale;
      const high = point.y > enemy.body.pos.y + 1.4 * S;
      if ((heavy || high) && Math.random() < (kind === 'riposte' ? 0.6 : high ? 0.55 : 0.25)) this.sever(enemy, 'head', dir);
      else if (heavy && Math.random() < 0.4) this.sever(enemy, Math.random() < 0.5 ? 'armL' : 'armR', dir);
    }
  }

  onArt(player) {
    audio.play('whoosh_spin', { pos: player.body.pos, rate: 1.4 });
    audio.play('slowmo_in', { volume: 0.6 });
    this.fxState.blur = 0.9;
    this.fxState.red = 0.35;
    this.camRig.zoomKick(-6);
    input.rumble(0.6, 1, 180);
    this.fx.sparksBurst(player.center(new THREE.Vector3()), player.artDir.clone().negate(), 16, 5, 1.2);
  }
  artHit(player, enemy, dir) {
    const c = enemy.center(new THREE.Vector3()).addScaledVector(dir, -enemy.body.radius * 0.9);
    const res = enemy.receiveHit({ attacker: player, dmg: enemy.isBoss ? 70 : 62, kind: 'art', dir: dir.clone(), point: c, knock: 6 });
    if (res === 'none') return;
    if (res === 'blocked' && enemy.isBoss) { this.fx.sparksBurst(c, dir, 40, 8); audio.play('parry', { pos: c }); return; }
    const killed = res === 'killed';
    this.blood.spray(c, dir.clone().setY(0.35).normalize(), killed ? 120 : 80, 9, 0.4, 1.4);
    this.blood.spray(c, new THREE.Vector3(-dir.z, 0.3, dir.x), 40, 5, 0.5, 1.2);
    enemy.rig.addBlood(c, 0.2);
    enemy.rig.material.userData.uniforms.uHitFlash.value = 0.8;
    audio.play('flesh_heavy', { pos: c });
    time.stop(0.13);
    time.slow(0.3, 0.35, 4);
    this.camRig.shake(0.4);
    player.combo++; player.comboTimer = 2.6; this.hud.comboHit(player.combo);
    if (killed) {
      if (Math.random() < 0.55) this.sever(enemy, 'head', dir);
      else this.sever(enemy, Math.random() < 0.5 ? 'armL' : 'armR', dir);
      this.fx.gibs(c, dir, 6);
    }
  }

  sever(enemy, part, dir) {
    const piece = enemy.rig.severPart(part);
    if (!piece) return;
    const v = dir.clone().multiplyScalar(3).add(new THREE.Vector3(rand(-1, 1), part === 'head' ? 5.5 : 3.5, rand(-1, 1)));
    this.fx.addDebris(piece, v, new THREE.Vector3(rand(-14, 14), rand(-14, 14), rand(-14, 14)), {
      radius: part === 'head' ? 0.11 : 0.06, bounce: 0.3, life: 120, friction: 0.7,
      onHit: (d, s) => {
        if (s > 2) { this.blood.spray(d.obj.position, new THREE.Vector3(0, 1, 0), 10, 2.5, 0.8, 1.2); audio.play('thud', { pos: d.obj.position, volume: 0.4, rate: 1.6 }); }
      },
    });
    const R = enemy.rig;
    const g = { head: ['neck', 'head'], armL: ['upperArm.L', 'forearm.L'], armR: ['upperArm.R', 'forearm.R'] }[part];
    const off = R.J[g[1]].clone().sub(R.J[g[0]]);
    const sdir = part === 'head' ? new THREE.Vector3(0, 1, 0.2) : new THREE.Vector3(0, -1, 0);
    this.blood.addSpurt(R.bones[g[0]], off, sdir, part === 'head' ? 3.5 : 2.2, part === 'head' ? 1.3 : 0.9);
    this.blood.addSpurt(piece, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, part === 'head' ? -1 : 1, 0), 1.0, 0.4);
    const p = piece.position.clone();
    this.blood.spray(p, dir.clone().add(new THREE.Vector3(0, 0.6, 0)).normalize(), 80, 7, 0.4, 1.4);
    audio.play('sever', { pos: p });
    audio.play('gore_spurt', { pos: p });
  }

  // An enemy swing only lands if its blade actually sweeps into the player (or into a raised guard).
  // Called every frame of the swing's active window; returns null until contact.
  enemyBladeSweep(enemy, clip) {
    const p = this.player;
    if (!p.alive) return 'miss';
    const per = clip.perilous;
    const unblock = !!clip.unblockable || per === 'sweep' || per === 'spin';
    const guarding = !unblock && (p.state === 'parry' || p.state === 'block' || p.state === 'deflect');
    const pp = p.body.pos;
    _sa1.set(pp.x, pp.y + 0.25, pp.z);
    _sb1.set(pp.x, pp.y + 1.75, pp.z);
    const bodyR = 0.32;
    // guard volume: in front of the chest, where the parrying blade is
    p.forward(_gf);
    _gc.set(pp.x + _gf.x * 0.36, pp.y + 1.25, pp.z + _gf.z * 0.36);
    const gR = 0.46;
    let hitS = -1, kind = null;
    for (let k = 0; k <= 6; k++) {
      const s = k / 6;
      _bb.lerpVectors(enemy.prevBase, enemy.bladeBase, s);
      _bt.lerpVectors(enemy.prevTip, enemy.bladeTip, s);
      if (guarding && distPointSeg(_gc, _bb, _bt) < gR) { hitS = s; kind = 'guard'; closestOnSeg(_gc, _bb, _bt, _contact); break; }
      if (segSegDistSq(_bb, _bt, _sa1, _sb1, _ca1, _cb1) < bodyR * bodyR) { hitS = s; kind = 'body'; _contact.copy(_ca1); break; }
    }
    if (hitS < 0) return null;
    // jumped clean over a low sweep
    if (per === 'sweep' && pp.y - p.body.groundY > 0.3) return null;
    enemy.rewindToContact(hitS);
    // for steel-on-steel, meet the blade where it is drawn this frame so the freeze shows real contact
    if (kind === 'guard' || guarding) closestOnSeg(_gc, enemy.bladeBase, enemy.bladeTip, _contact);
    const travel = _tv.subVectors(enemy.bladeTip, enemy.prevTip);
    if (travel.lengthSq() < 1e-6) enemy.forward(travel);
    travel.normalize();
    const info = {
      dmg: clip.dmg, perilous: per, heavy: clip.dmg >= 24 || enemy.type === 'brute', unblockable: unblock,
      parryWindow: enemy.parryWindow(), chip: enemy.isBoss ? 0.25 : 0.15,
      contact: _contact.clone(), edir: travel.clone(), kind,
    };
    return this.resolveStrike(enemy, clip, info);
  }

  resolveParryFx(enemy, info) {
    const p = this.player;
    const contact = info.contact || enemy.bladeTip.clone();
    const edir = info.edir || new THREE.Vector3(0, 0, 1);
    enemy.parried();
    this.stats.parries++;
    this.hud.popup('PARRY', contact, '#fff2c8', 0.7);
      const n = edir.clone().negate().add(new THREE.Vector3(0, 0.4, 0)).normalize();
      this.fx.sparksBurst(contact, n, 60, 10, 1.3);
      this.fx.flash(contact, 0.42, 0.12);
      this.fx.slashFlash(contact, new THREE.Vector3().crossVectors(edir, new THREE.Vector3(0, 1, 0)).normalize(), [3.5, 2.6, 1.6], 0.8);
      audio.play('parry', { pos: contact });
      time.stop(enemy.isBoss ? 0.1 : 0.13);
      if (!enemy.isBoss) time.slow(0.35, 0.22, 5);
      this.camRig.shake(0.22);
      this.camRig.zoomKick(-3);
      this.camRig.punch(edir, 0.05);
      input.rumble(1, 0.5, 130);
      this.fxState.flash = 0.1;
      p.combo++; p.comboTimer = 2.4; this.hud.comboHit(p.combo);
  }

  resolveStrike(enemy, clip, info) {
    const p = this.player;
    const res = p.receiveStrike(enemy, info);
    const contact = info.contact;
    if (res === 'parried') this.resolveParryFx(enemy, info);
    else if (res === 'blocked') {
      this.fx.sparksBurst(contact, info.edir.clone().negate(), 22, 6);
      this.fx.flash(contact, 0.3, 0.08);
      audio.play('block', { pos: contact });
      time.stop(0.07);
      this.camRig.shake(0.16);
      input.rumble(0.5, 0.3, 80);
    } else if (res === 'hit') {
      const c = contact.clone();
      const dir = info.edir.clone().setY(Math.max(0.2, info.edir.y)).normalize();
      this.blood.spray(c, dir, info.heavy ? 70 : 45, 6, 0.45, 1.2);
      p.rig.addBlood(c, info.heavy ? 0.15 : 0.11);
      p.rig.material.userData.uniforms.uHitFlash.value = 0.5;
      this.fx.slashFlash(c, info.edir, [3, 0.5, 0.35], 1);
      audio.play(info.heavy ? 'flesh_heavy' : 'flesh', { pos: c });
      time.stop(info.heavy ? 0.12 : 0.09);
      this.camRig.shake(info.heavy ? 0.5 : 0.35);
      this.camRig.punch(info.edir, 0.08);
      this.fxState.damage = 0.75;
      this.fxState.ca = 1.2;
      input.rumble(1, 1, info.heavy ? 260 : 160);
      if (p.alive && info.heavy) this.hud.screenBlood(0.3);
    }
    return res;
  }

  perfectDodge(player, enemy) {
    if (this._pdT && time.real - this._pdT < 0.6) return;
    this._pdT = time.real;
    time.slow(0.3, 0.55, 4);
    audio.play('slowmo_in');
    player.focus = Math.min(100, player.focus + 20);
    this.fxState.blur = 0.6;
    this.hud.popup('PERFECT DODGE', player.headPos(new THREE.Vector3()), '#9fd0ff');
    if (enemy && enemy.alive) {
      if (enemy.isBoss) enemy.addPosture(12);
      else if (enemy.state === 'attack') { enemy.parried(); }
    }
  }

  bossSlam(boss, clip) {
    const p = this.player;
    this.fx.dustPuff(boss.body.pos, 30, [0.22, 0.2, 0.2]);
    this.fx.sparksBurst(boss.bladeTip, new THREE.Vector3(0, 1, 0), 30, 6, boss.heat > 0.5 ? 1.5 : 1);
    if (boss.heat > 0.5) this.fx.emberBurst(boss.bladeTip, 40, 1.2);
    audio.play('thud', { pos: boss.body.pos, volume: 1, rate: 0.7 });
    this.camRig.shake(0.55);
    input.rumble(0.8, 0.4, 200);
    const d = boss.distTo(p);
    if (d < clip.aoe && p.alive && p.body.pos.y - boss.body.pos.y < 1.2) {
      const res = p.receiveStrike(boss, { dmg: clip.dmg * (1 - d / clip.aoe * 0.4), heavy: true, unblockable: true, parryWindow: 0 });
      if (res === 'hit') {
        const c = p.center(new THREE.Vector3());
        this.blood.spray(c, new THREE.Vector3(0, 1, 0), 50, 5, 0.6);
        audio.play('flesh_heavy', { pos: c });
        this.fxState.damage = 0.8;
        time.stop(0.09);
      }
    }
  }

  aoe(player, center, radius, dmg, kind) {
    this.fx.dustPuff(center, 30, [0.22, 0.2, 0.2]);
    this.fx.sparksBurst(center.clone().setY(center.y + 0.1), new THREE.Vector3(0, 1, 0), 26, 7);
    audio.play('thud', { pos: center, volume: 1, rate: 0.8 });
    audio.play('whoosh_heavy', { pos: center, rate: 0.6 });
    this.camRig.shake(0.6);
    time.stop(0.1);
    input.rumble(1, 0.7, 220);
    for (const b of this.level.breakables) if (b.alive && b.pos.distanceTo(center) < radius) this.level.breakObject(b, new THREE.Vector3().subVectors(b.pos, center).normalize());
    for (const e of this.enemies) {
      if (!e.alive || e.state === 'victim' || e.spawning) continue;
      const d = player.distTo(e);
      if (d > radius || Math.abs(e.body.pos.y - center.y) > 1.5) continue;
      const dir = new THREE.Vector3().subVectors(e.body.pos, center).setY(0);
      if (dir.lengthSq() < 1e-4) dir.set(rand(-1, 1), 0, rand(-1, 1));
      dir.normalize();
      if (kind === 'plunge' && d < 1.2 && !e.isBoss) {
        // impaled from above
        const c = e.center(new THREE.Vector3());
        e.receiveHit({ attacker: player, dmg: 999, kind: 'heavy', dir: new THREE.Vector3(0, -1, 0), point: c });
        this.blood.spray(c, new THREE.Vector3(0, 1, 0), 120, 7, 0.5, 1.5);
        e.rig.addBlood(c, 0.25);
        audio.play('sever', { pos: c });
        audio.play('execute');
        time.slow(0.3, 0.4);
        this.stats.executions++;
        continue;
      }
      const res = e.receiveHit({ attacker: player, dmg: dmg * (1 - (d / radius) * 0.5), kind, dir, point: e.center(new THREE.Vector3()), knock: 7 });
      if (res === 'hit' || res === 'killed') {
        const c = e.center(new THREE.Vector3());
        this.blood.spray(c, dir.clone().setY(0.5).normalize(), 40, 6, 0.5);
        player.combo++; player.comboTimer = 2.4; this.hud.comboHit(player.combo);
      }
    }
  }

  wallSplat(enemy, impact) {
    const dmg = 14 + impact * 3;
    const c = enemy.center(new THREE.Vector3());
    const n = enemy.body.wallNormal ? enemy.body.wallNormal.clone() : new THREE.Vector3(0, 0, 1);
    enemy.body.vel.set(n.x * 1.5, 0, n.z * 1.5);
    audio.play('thud', { pos: c, volume: 1 });
    audio.play('kick', { pos: c, volume: 0.6, rate: 0.7 });
    this.blood.spray(c, n.clone().negate().setY(0.3).normalize(), 40, 5, 0.5);
    this.camRig.shake(0.3);
    time.stop(0.08);
    enemy.takeDamage({ dmg, kind: 'fall', dir: n.clone(), point: c });
  }

  // Player quick-fire knife: homes lightly onto the target, interrupts wind-ups, sticks in flesh.
  playerThrowKnife(player, target) {
    const knife = buildSword('knife');
    const hand = new THREE.Vector3();
    player.rig.bones['hand.L'].getWorldPosition(hand);
    let aim;
    if (target && target.alive) aim = target.center(new THREE.Vector3()).addScaledVector(target.body.vel, 0.1);
    else { aim = hand.clone().addScaledVector(player.forward(new THREE.Vector3()), 14); aim.y = hand.y - 0.2; }
    const vel = aim.sub(hand).normalize().multiplyScalar(32);
    knife.position.copy(hand);
    this.scene.add(knife);
    this.projectiles.push({ mesh: knife, pos: hand.clone(), vel, owner: player, target, fromPlayer: true, life: 1.3, spin: 0, stuck: 0 });
    audio.play('throw', { pos: hand, rate: 1.35 });
    input.rumble(0.2, 0.4, 50);
  }

  // R2 in the air: the blade hits the ground and everything nearby is thrown off its feet.
  groundPound(player, pos) {
    this.fx.dustPuff(pos, 36, [0.24, 0.23, 0.24]);
    this.fx.shockwave(pos, 3.8);
    this.fx.sparksBurst(pos.clone().setY(pos.y + 0.1), new THREE.Vector3(0, 1, 0), 40, 8);
    this.fx.flash(pos.clone().setY(pos.y + 0.3), 0.8, 0.15);
    audio.play('thud', { pos, volume: 1, rate: 0.65 });
    audio.play('whoosh_heavy', { pos, rate: 0.55 });
    this.camRig.shake(0.7);
    this.camRig.zoomKick(-5);
    this.fxState.ca = 1.5;
    time.stop(0.12);
    input.rumble(1, 1, 280);
    for (const e of this.enemies) {
      if (!e.alive || e.state === 'victim' || e.spawning) continue;
      const d = Math.hypot(e.body.pos.x - pos.x, e.body.pos.z - pos.z);
      if (d > 3.8 || Math.abs(e.body.pos.y - pos.y) > 1.6) continue;
      const dir = new THREE.Vector3(e.body.pos.x - pos.x, 0, e.body.pos.z - pos.z);
      if (dir.lengthSq() < 1e-4) dir.set(rand(-1, 1), 0, rand(-1, 1));
      dir.normalize();
      const c = e.center(new THREE.Vector3());
      if (d < 1.1 && !e.isBoss) {
        // came down right on top of them
        e.receiveHit({ attacker: player, dmg: 999, kind: 'heavy', dir: new THREE.Vector3(0, -1, 0), point: c });
        this.blood.spray(c, new THREE.Vector3(0, 1, 0), 120, 7, 0.5, 1.5);
        e.rig.addBlood(c, 0.25);
        this.hud.screenBlood(0.4);
        audio.play('sever', { pos: c });
        audio.play('execute');
        time.slow(0.3, 0.4);
        this.stats.executions++;
        continue;
      }
      const res = e.receiveHit({ attacker: player, dmg: 32 * (1 - (d / 3.8) * 0.5), kind: 'pound', dir, point: c, knock: 6 });
      if (res === 'hit' || res === 'killed' || res === 'guardbreak') {
        this.blood.spray(c, dir.clone().setY(0.5).normalize(), 35, 5, 0.5);
        e.rig.material.userData.uniforms.uHitFlash.value = 0.6;
        player.combo++; player.comboTimer = 2.6; this.hud.comboHit(player.combo);
      }
    }
  }

  throwKnife(enemy) {
    const knife = buildSword('knife');
    const hand = new THREE.Vector3();
    enemy.rig.bones['hand.R'].getWorldPosition(hand);
    knife.position.copy(hand);
    const p = this.player;
    const target = p.center(new THREE.Vector3()).addScaledVector(p.body.vel, 0.25);
    target.y += 0.15;
    const speed = 19;
    const dir = new THREE.Vector3().subVectors(target, hand);
    const dist = dir.length();
    dir.normalize();
    const vel = dir.multiplyScalar(speed);
    vel.y += 2 * (dist / speed); // compensate gravity
    this.scene.add(knife);
    this.projectiles.push({ mesh: knife, pos: hand.clone(), vel, owner: enemy, life: 3, deflected: false, spin: 0, stuck: 0 });
    audio.play('throw', { pos: hand });
  }

  updateProjectiles(dt) {
    const p = this.player;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const k = this.projectiles[i];
      k.life -= dt;
      if (k.stuck > 0) {
        k.stuck -= dt;
        if (k.stuck <= 0) { k.mesh.removeFromParent(); this.projectiles.splice(i, 1); }
        continue;
      }
      if (k.life <= 0) { k.mesh.removeFromParent(); this.projectiles.splice(i, 1); continue; }
      if (k.fromPlayer) {
        if (k.target && k.target.alive) {
          const want = k.target.center(new THREE.Vector3()).sub(k.pos).normalize().multiplyScalar(32);
          k.vel.lerp(want, Math.min(1, dt * 7));
        }
        const prevP = k.pos.clone();
        k.pos.addScaledVector(k.vel, dt);
        k.mesh.position.copy(k.pos);
        k.mesh.lookAt(k.pos.clone().add(k.vel));
        k.spin += dt * 40;
        k.mesh.rotateX(k.spin);
        if (Math.random() < 0.6) this.fx.sparks.spawn(k.pos.x, k.pos.y, k.pos.z, 0, 0, 0, 1.0, 0.95, 0.9, 0.5, 0.006, 0.1, 0, 0);
        let done = false;
        for (const e of this.enemies) {
          if (!e.alive || e.spawning || e.state === 'victim') continue;
          const a = e.body.pos.clone().setY(e.body.pos.y + 0.3), b = e.body.pos.clone().setY(e.body.pos.y + 1.8 * e.rig.scale);
          if (distPointSeg(k.pos, a, b) > 0.42) continue;
          const dir = k.vel.clone().normalize();
          const res = e.receiveHit({ attacker: p, dmg: 10, kind: 'knife', dir, point: k.pos.clone() });
          if (res === 'blocked') {
            this.fx.sparksBurst(k.pos, dir.clone().negate(), 14, 5);
            audio.play('block', { pos: k.pos, rate: 1.5, volume: 0.6 });
            this.fx.addDebris(k.mesh, dir.clone().multiplyScalar(-2).setY(2.5), new THREE.Vector3(14, 3, 6), { radius: 0.02, life: 8 });
          } else {
            this.blood.spray(k.pos, dir, 18, 3.5, 0.4);
            e.rig.addBlood(k.pos, 0.07);
            audio.play('knife_hit', { pos: k.pos });
            if (e.state === 'stagger' || e.state === 'hitstun') this.hud.popup('INTERRUPT', e.headPos(new THREE.Vector3()), '#9fd0ff', 0.6);
            time.stop(0.04);
            // the knife stays in them
            e.rig.bones.chest.attach(k.mesh);
            p.combo++; p.comboTimer = 2.4; this.hud.comboHit(p.combo);
          }
          done = true;
          break;
        }
        if (!done && this.world.pointInside(k.pos)) {
          k.pos.copy(prevP); k.mesh.position.copy(prevP);
          audio.play('knife_hit', { pos: k.pos, volume: 0.5 });
          k.stuck = 6; k.fromPlayer = false; k.deflected = true; k.owner = null;
          continue;
        }
        if (done) { this.projectiles.splice(i, 1); }
        continue;
      }
      if (k.deflected && k.owner && k.owner.alive) {
        // homes back into the thrower
        const tgt = k.owner.center(new THREE.Vector3());
        const want = tgt.sub(k.pos).normalize().multiplyScalar(28);
        k.vel.lerp(want, Math.min(1, dt * 10));
      } else k.vel.y -= 4 * dt;
      const prev = k.pos.clone();
      k.pos.addScaledVector(k.vel, dt);
      k.mesh.position.copy(k.pos);
      k.mesh.lookAt(k.pos.clone().add(k.vel));
      k.spin += dt * 30;
      k.mesh.rotateX(k.spin);
      // embers-like glint trail
      if (Math.random() < 0.7) this.fx.sparks.spawn(k.pos.x, k.pos.y, k.pos.z, 0, 0, 0, 1.2, 1.1, 1.0, 0.6, 0.008, 0.12, 0, 0);
      if (!k.deflected && p.alive) {
        const a = p.body.pos.clone().setY(p.body.pos.y + 0.3), b = p.body.pos.clone().setY(p.body.pos.y + 1.75);
        const dseg = distPointSeg(k.pos, a, b);
        if (dseg < 0.5) {
          const res = p.receiveStrike(k.owner, { dmg: 11, parryWindow: 0.4, heavy: false, ranged: true });
          if (res === 'parried') {
            k.deflected = true;
            k.life = 2;
            this.stats.parries++;
            this.fx.sparksBurst(k.pos, k.vel.clone().normalize().negate(), 30, 8);
            this.fx.flash(k.pos, 0.7, 0.1);
            audio.play('parry', { pos: k.pos, rate: 1.2 });
            time.stop(0.07);
            time.slow(0.4, 0.2);
            input.rumble(0.8, 0.4, 100);
            continue;
          } else if (res === 'blocked') {
            this.fx.sparksBurst(k.pos, k.vel.clone().normalize().negate(), 16, 5);
            audio.play('block', { pos: k.pos, rate: 1.4 });
            this.fx.addDebris(k.mesh, k.vel.clone().multiplyScalar(-0.15).setY(2), new THREE.Vector3(10, 0, 5), { radius: 0.02, life: 10 });
            this.projectiles.splice(i, 1);
            continue;
          } else if (res === 'hit') {
            const c = k.pos.clone();
            this.blood.spray(c, k.vel.clone().normalize(), 25, 4, 0.4);
            p.rig.addBlood(c, 0.08);
            audio.play('knife_hit', { pos: c });
            this.fxState.damage = 0.5;
            this.camRig.shake(0.2);
            k.mesh.removeFromParent();
            this.projectiles.splice(i, 1);
            continue;
          }
        }
      }
      if (k.deflected) {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          const a = e.body.pos.clone().setY(e.body.pos.y + 0.3), b = e.body.pos.clone().setY(e.body.pos.y + 1.8);
          if (distPointSeg(k.pos, a, b) < 0.45) {
            const dir = k.vel.clone().normalize();
            const res = e.receiveHit({ attacker: p, dmg: e.isBoss ? 30 : 120, kind: 'riposte', dir, point: k.pos.clone() });
            this.blood.spray(k.pos, dir, 50, 6, 0.4, 1.2);
            e.rig.addBlood(k.pos, 0.12);
            audio.play('knife_hit', { pos: k.pos });
            audio.play('flesh_heavy', { pos: k.pos });
            time.stop(0.08);
            if (res === 'killed') { p.combo++; p.comboTimer = 2.4; this.hud.comboHit(p.combo); }
            k.mesh.removeFromParent();
            this.projectiles.splice(i, 1);
            break;
          }
        }
        if (!this.projectiles.includes(k)) continue;
      }
      // world (deflected knives always find their thrower)
      if (!k.deflected && this.world.pointInside(k.pos)) {
        k.pos.copy(prev);
        k.mesh.position.copy(prev);
        k.stuck = 8;
        audio.play('knife_hit', { pos: k.pos, volume: 0.6 });
        this.fx.sparksBurst(k.pos, k.vel.clone().normalize().negate(), 6, 3);
      }
    }
  }

  // ---------------- executions ----------------
  execute(player, enemy) {
    const boss = enemy.isBoss;
    let variant;
    if (boss) variant = enemy.state === 'finished' ? 'decap' : 'split';
    else variant = enemy.type === 'brute' ? pick(['impale', 'split']) : pick(['decap', 'decap', 'impale', 'split']);
    const clip = { decap: PLAYER.execDecap, impale: PLAYER.execImpale, split: PLAYER.execSplit }[variant];
    enemy.cancelAttack();
    enemy.setState('victim');
    if (!boss) enemy.anim.playClip(GRUNT.victim, { blendIn: 0.1 });
    enemy.yaw = enemy.yawTo(player.body.pos.x, player.body.pos.z);
    enemy.body.vel.set(0, 0, 0);
    player.setState('execute');
    player.target = enemy;
    player.trailOn = false;
    player.anim.playClip(clip, { blendIn: 0.08 });
    const dir = new THREE.Vector3().subVectors(player.body.pos, enemy.body.pos).setY(0);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    const dist = (boss ? 1.45 : 1.05) * enemy.rig.scale;
    const to = enemy.body.pos.clone().addScaledVector(dir, dist);
    to.y = player.body.pos.y;
    const ex = { player, enemy, clip, variant, t: 0, from: player.body.pos.clone(), to, hit: false, kicked: false, dieAt: -1 };
    this.executions.push(ex);
    // cinematic camera from the side
    const mid = player.body.pos.clone().lerp(enemy.body.pos, 0.5);
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    if (side.dot(this.camRig.right(new THREE.Vector3())) < 0) side.negate();
    const camPos = mid.clone().addScaledVector(side, boss ? 4.2 : 3.0).addScaledVector(dir, 0.6);
    camPos.y += boss ? 1.9 : 1.6;
    this.world.raycast(mid.clone().setY(mid.y + 1.4), camPos.clone().sub(mid).normalize(), 4);
    this.camRig.cinematic(camPos, mid.clone().setY(mid.y + 1.25), clip.dur - 0.2);
    time.slow(0.75, 0.25);
    audio.play('whoosh_heavy', { pos: mid, rate: 0.85 });
    this.stats.executions++;
  }

  updateExecutions(dt) {
    for (let i = this.executions.length - 1; i >= 0; i--) {
      const ex = this.executions[i];
      const { player: p, enemy: e, clip } = ex;
      ex.t += dt;
      const k = Math.min(1, ex.t / 0.14);
      p.body.pos.lerpVectors(ex.from, ex.to, k * k * (3 - 2 * k));
      p.yaw = p.yawTo(e.body.pos.x, e.body.pos.z);
      const ct = p.anim.clipT;
      p.trailOn = !ex.hit ? ct > clip.hitAt - 0.08 : ct < clip.hitAt + 0.1;
      // the finishing blow lands when the blade actually reaches the neck / chest / skull
      if (!ex.hit && ct >= clip.hitAt - 0.1) {
        const bone = e.rig.bones[ex.variant === 'decap' ? 'neck' : ex.variant === 'impale' ? 'chest' : 'head'];
        bone.getWorldPosition(_exb);
        let d = 9;
        for (let k = 0; k <= 6; k++) {
          _bb.lerpVectors(p.prevBase, p.bladeBase, k / 6);
          _bt.lerpVectors(p.prevTip, p.bladeTip, k / 6);
          d = Math.min(d, distPointSeg(_exb, _bb, _bt));
        }
        if (d < 0.14 || ct >= clip.hitAt + 0.08) { ex.hit = true; this.executionHit(ex); }
      }
      if (ex.variant === 'impale' && ex.hit && !ex.kicked && ct >= clip.kickAt) {
        ex.kicked = true;
        const dir = p.forward(new THREE.Vector3());
        audio.play('kick', { pos: e.body.pos });
        this.camRig.shake(0.3);
        if (e.alive) e.die({ dir: dir.clone().multiplyScalar(1.8).setY(0.5), kind: 'kick', point: e.center(new THREE.Vector3()) });
      }
      if (ex.dieAt > 0 && ex.t >= ex.dieAt && e.alive) {
        ex.dieAt = -1;
        e.die({ dir: p.forward(new THREE.Vector3()).multiplyScalar(0.4), kind: 'execute', point: e.center(new THREE.Vector3()) });
      }
      if (ct >= clip.dur - 0.2 || !p.alive) {
        p.anim.stopClip(0.2);
        p.trailOn = false;
        if (p.alive) p.setState('move');
        p.invuln = 0.4;
        this.executions.splice(i, 1);
        if (e.isBoss && e.alive && e.state === 'victim') {
          e.posture = 0;
          e.setState('stagger');
          e.hitstun = 0.9;
          e.anim.stopClip(0.3);
        }
      }
    }
  }

  executionHit(ex) {
    const { player: p, enemy: e, variant } = ex;
    const fwd = p.forward(new THREE.Vector3());
    const left = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    const c = e.center(new THREE.Vector3());
    const S = e.rig.scale;
    audio.play('execute');
    audio.duck(0.6, 0.6);
    time.stop(0.12);
    time.slow(0.22, 0.45, 4);
    this.camRig.shake(0.4);
    input.rumble(1, 1, 300);
    this.fxState.ca = 1.4;
    this.fxState.red = 0.6;
    p.bladeBlood = Math.min(1, p.bladeBlood + 0.25);
    p.hp = Math.min(p.maxHp, p.hp + (e.isBoss ? 10 : 15));
    p.focus = Math.min(100, p.focus + 12);
    p.combo++; p.comboTimer = 3; this.hud.comboHit(p.combo);
    this.hud.screenBlood(e.isBoss ? 0.5 : 0.7);
    this.fx.gibs(c, fwd, e.isBoss ? 4 : 8);
    if (e.isBoss && variant === 'split') {
      // posture deathblow: heavy damage, boss survives
      const head = e.headPos(new THREE.Vector3());
      this.blood.spray(head, new THREE.Vector3(0, 1, 0).add(fwd).normalize(), 110, 7, 0.45, 1.4);
      e.rig.addBlood(head, 0.25);
      audio.play('flesh_heavy', { pos: head });
      audio.play('boss_roar', { pos: head, rate: 1.3, volume: 0.6 });
      e.hp -= e.maxHp * 0.24;
      if (e.hp <= 1) { e.hp = 1; }
      return;
    }
    if (variant === 'decap') {
      const neck = e.headPos(new THREE.Vector3());
      e.rig.addBlood(neck, 0.22);
      this.sever(e, 'head', left.clone().add(new THREE.Vector3(0, 0.3, 0)).normalize());
      ex.dieAt = ex.t + 0.4;
      if (e.isBoss) { ex.dieAt = ex.t + 0.6; this.onBossKilled(e); }
    } else if (variant === 'impale') {
      const back = c.clone().addScaledVector(fwd, 0.28 * S);
      this.blood.spray(back, fwd, 90, 7, 0.3, 1.3);
      this.blood.spray(c, fwd.clone().negate().setY(0.3), 30, 3, 0.4);
      e.rig.addBlood(c, 0.2);
      e.rig.addBlood(back, 0.2);
      audio.play('flesh_heavy', { pos: c });
      audio.play('death', { pos: c });
    } else {
      const head = e.headPos(new THREE.Vector3());
      this.blood.spray(head, new THREE.Vector3(0, 1, 0), 140, 8, 0.5, 1.5);
      e.rig.addBlood(head, 0.3);
      e.rig.addBlood(c, 0.2);
      if (Math.random() < 0.6) this.sever(e, 'armL', left);
      audio.play('flesh_heavy', { pos: head });
      ex.dieAt = ex.t + 0.12;
    }
  }

  // ---------------- events ----------------
  onEnemyDeath(e, info) {
    this.stats.kills++;
    if (Math.random() < 0.6) audio.play('death', { pos: e.body.pos, rate: rand(0.85, 1.1) * (e.type === 'brute' ? 0.75 : 1) });
    this.after(0.9, () => {
      if (e.ragdoll) {
        const p = e.ragdoll.p[0].clone();
        this.blood.addPool(p, rand(0.9, 1.6) * e.rig.scale, 0.5);
      }
    });
    const left = this.enemies.filter((x) => x.alive && !x.isBoss).length;
    if (left === 0 && this.director.phase === 'wave' && this.director.queue.length === 0) {
      time.slow(0.2, 0.9, 2);
      audio.play('slowmo_in');
      this.camRig.zoomKick(-6);
    }
  }
  onWaveCleared(i) {
    audio.play('victory');
    this.hud.banner('WAVE CLEARED', i === 0 ? 'Blood Art awakens' : 'Breathe', 2.4);
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + 35);
    this.player.focus = Math.min(100, this.player.focus + 34);
    audio.setMusicMode('explore');
  }
  onBossIntro(b) {
    audio.setMusicMode('silence');
    const look = b.body.pos.clone().setY(1.9);
    const pos = b.body.pos.clone().add(new THREE.Vector3(2.2, 1.5, 5.0));
    this.camRig.cinematic(pos, look, 3.4);
    b.body.vel.set(0, 0, 0);
    this.player.body.vel.set(0, 0, 0);
    this.after(0.5, () => { b.startIntro(); audio.setMusicMode('boss'); });
    this.after(0.9, () => this.hud.banner('VAELOR', 'The Iron Warden', 3));
    this.after(2.8, () => this.hud.showBoss('VAELOR, THE IRON WARDEN'));
    this.player.lock = b;
  }
  onBossEngaged() {
    this.hud.hint('Parry his blows to break his posture, then {heavy} for a deathblow', 5.5);
    this.after(6, () => this.hud.hint('<span style="color:#ff5040">Red</span> glint: thrusts need a perfect parry · sweeps and spins: dodge or jump', 6));
  }
  onBossPhase2() {
    audio.setMusicMode('boss2');
    this.hud.banner('THE WARDEN IGNITES', '', 2.4);
  }
  onPostureBreak(b) {
    audio.play('parry', { pos: b.body.pos, rate: 0.6 });
    audio.play('execute', { volume: 0.5 });
    time.slow(0.3, 0.5);
    this.fx.flash(b.center(new THREE.Vector3()), 1.5, 0.2);
    this.camRig.shake(0.3);
  }
  onBossFinishable(b) {
    time.slow(0.25, 1.0, 2);
    audio.setMusicMode('silence');
    audio.play('boss_roar', { pos: b.body.pos, rate: 0.8, volume: 0.7 });
  }
  onBossKilled(b) {
    this.after(3.5, () => {
      this.state = 'victory';
      const t = Math.round(time.real - this.stats.start);
      document.getElementById('victory-stats').textContent =
        `${this.stats.kills} slain · ${this.stats.executions} executions · ${this.stats.parries} parries · best combo ${this.stats.maxCombo} · ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      this.hud.setScreen('victory');
      this.hud.hideBoss();
      audio.play('victory');
      if (document.pointerLockElement) document.exitPointerLock();
    });
  }
  onPlayerDeath() {
    time.slow(0.25, 1.4, 2);
    audio.setMusicMode('silence');
    audio.play('death', { rate: 0.8 });
    this.fxState.damage = 1;
    this.after(1.8, () => { this.state = 'dead'; this.hud.setScreen('death'); });
  }

  clearEnemies() {
    for (const e of this.enemies) { e.dispose(); if (e.cape) e.cape.mesh.removeFromParent(); }
    this.enemies.length = 0;
    for (const k of this.projectiles) k.mesh.removeFromParent();
    this.projectiles.length = 0;
    this.executions.length = 0;
    this.director.attackers.clear();
  }

  restartCheckpoint() {
    const cp = this.director.checkpoint();
    this.clearEnemies();
    this.fx.clear();
    this.blood.drops.n = 0;
    this.hud.setScreen(null);
    this.state = 'play';
    input.requestLock();
    input.clearBuffer();
    time.scale = 1; time._slowTarget = 1; time.hitstop = 0;
    this.camRig.cine = null;
    const p = this.player;
    if (!p.rig.sword) p.rig.attachSword(buildSword('hero'));
    if (cp === 'boss') {
      p.reset(this.level.spawnPoints.bossPlayer, Math.PI);
      this.camRig.snapBehind(p.yaw);
      this.hud.hideBoss();
      this.director.phase = 'gate';
      this.director.gateT = 1.5;
      this.director.boss = null;
      this.artUnlocked = true;
    } else {
      this.artUnlocked = cp >= 1;
      p.reset(this.level.spawnPoints.player, Math.PI);
      this.camRig.snapBehind(p.yaw);
      this.director.phase = 'idle';
      this.after(1.0, () => this.director.startWave(cp));
    }
    p.rig.root.updateMatrixWorld(true);
  }
  restartAll() {
    window.location.reload();
  }

  // ---------------- loop ----------------
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const realDt = Math.min(0.05, Math.max(0.0001, (now - this.last) / 1000));
    this.last = now;
    if (this.freeze) { this.reflection.update(this.renderer, this.scene, this.camera); this.pipeline.render(this.scene, this.camera, time.real); return; }
    input.update(realDt, time.real);
    const playing = this.state === 'play' || this.state === 'dead' || this.state === 'victory';
    if (this.state === 'paused' || this.state === 'title') { time.realDt = realDt; time.real += realDt; time.dt = 0; }
    else time.step(realDt);
    const dt = time.dt;

    // timers (real time)
    if (this.state !== 'paused') {
      for (let i = this.timers.length - 1; i >= 0; i--) {
        const tm = this.timers[i];
        tm.t -= realDt;
        if (tm.t <= 0) { this.timers.splice(i, 1); tm.fn(); }
      }
    }
    input.enabled = this.state === 'play' && !this.camRig.cine;
    if (this.state === 'play' && this.camRig.cine && this.player.state === 'execute') input.enabled = false;

    if (playing && dt > 0) {
      this.director.update(dt);
      this.player.update(dt);
      for (const e of this.enemies) e.update(dt);
      this.separateBodies();
      this.updateExecutions(dt);
      this.updateProjectiles(dt);
      this.fx.update(dt);
      this.blood.update(dt);
    } else if (playing) {
      // hitstop: keep player cloth etc frozen but update trails visually
    }
    if (this.state === 'title') {
      // slow orbit around the courtyard on the title screen
      this.titleT = (this.titleT || 0) + realDt;
      this.player.update(0.0001);
    }
    this.level.update(realDt * (this.state === 'paused' ? 0 : 1), time.real);

    // camera
    const p = this.player;
    const lockPos = p.lock && p.lock.alive ? p.lock.body.pos.clone().setY(p.lock.body.pos.y + 1.2) : null;
    this.camRig.lock = lockPos;
    const look = this.state === 'play' ? { x: lockPos ? 0 : input.look.x, y: input.look.y } : { x: this.state === 'title' ? realDt * 0.12 : 0, y: 0 };
    // gentle framing assist: when you leave the camera alone mid-fight it drifts to keep your target in view
    let assistYaw;
    const tgt = p.target && p.target.alive ? p.target : null;
    if (!lockPos && tgt && p.combat && this.state === 'play') {
      const dx = tgt.body.pos.x - p.body.pos.x, dz = tgt.body.pos.z - p.body.pos.z;
      if (dx * dx + dz * dz > 0.5) assistYaw = Math.atan2(-dx, -dz);
    }
    this.camRig.update(realDt, dt, p.alive || !p.ragdoll ? p.body.pos : p.ragdoll.p[0], look, {
      combat: p.combat, airborne: !p.body.grounded, sprint: p.sprint, assistYaw,
    });
    // follow shadows
    const sp = p.body.pos;
    this.moon.position.set(Math.round(sp.x) + this.moonDir.x * 40, sp.y + this.moonDir.y * 40, Math.round(sp.z) + this.moonDir.z * 40);
    this.moon.target.position.set(Math.round(sp.x), sp.y, Math.round(sp.z));

    // weather + lightning
    const flash = this.weather.update(realDt, time.real, this.camera.position, () => audio.play('thunder', { volume: 0.9 }));
    this.moon.intensity = 1.7 + flash * 6;
    this.hemi.intensity = 0.85 + flash * 1.5;
    this.sky.material.uniforms.uTime.value = time.real;
    this.sky.material.uniforms.uFlash.value = flash;
    this.sky.position.copy(this.camera.position);
    this.camera.updateMatrixWorld();
    RIM_DIR.value.copy(this.moonDir).transformDirection(this.camera.matrixWorldInverse);

    // post fx
    const F = this.fxState, U = this.pipeline.fx;
    F.damage = Math.max(0, F.damage - realDt * 1.8);
    F.ca = Math.max(0, F.ca - realDt * 4);
    F.blur = Math.max(0, F.blur - realDt * 2);
    F.flash = Math.max(0, F.flash - realDt * 3);
    F.red = Math.max(0, F.red - realDt * 1.5);
    U.uDamage.value = F.damage * 0.8;
    U.uLowHealth.value = p.alive ? clamp(1 - p.hp / 35, 0, 1) : 1;
    U.uSlow.value = damp(U.uSlow.value, clamp((1 - time.scale) * 1.3, 0, 1), 10, realDt);
    U.uCA.value = 0.0015 + F.ca * 0.006 + U.uSlow.value * 0.003;
    const dashBlur = p.state === 'dash' ? 0.5 : p.state === 'vault' ? 0.3 : 0;
    U.uBlur.value = damp(U.uBlur.value, Math.max(F.blur, dashBlur, this.camRig.cine ? 0.25 : 0), 12, realDt);
    U.uFlash.value = flash * 0.25 + F.flash;
    U.uRedFlash.value = F.red;
    U.uFade.value = damp(U.uFade.value, this.state === 'title' ? 0.15 : 0, 3, realDt);

    // audio
    audio.setListener(this.camera.position, this.camRig.yaw);
    audio.setSlowmo(clamp(1 - time.scale, 0, 1));
    const threat = this.enemies.filter((e) => e.alive && !e.spawning).length;
    audio.setMusicIntensity(clamp(threat / 5 + p.combo / 25, 0, 1));

    this.hud.update(realDt);
    if (!this.skipRender) {
      this.camera.updateMatrixWorld();
      this.reflection.update(this.renderer, this.scene, this.camera);
      this.pipeline.render(this.scene, this.camera, time.real);
    }
  }
}

function closestOnSeg(p, a, b, out) {
  const ab = _ab.subVectors(b, a);
  const t = clamp(_ap.subVectors(p, a).dot(ab) / Math.max(1e-8, ab.lengthSq()), 0, 1);
  return out.copy(a).addScaledVector(ab, t);
}
function distPointSeg(p, a, b) {
  const ab = _ab.subVectors(b, a);
  const t = clamp(_ap.subVectors(p, a).dot(ab) / ab.lengthSq(), 0, 1);
  return _cp.copy(a).addScaledVector(ab, t).distanceTo(p);
}
const _ab = new THREE.Vector3(), _ap = new THREE.Vector3(), _cp = new THREE.Vector3();
const _sa1 = new THREE.Vector3(), _sb1 = new THREE.Vector3(), _ca1 = new THREE.Vector3(), _cb1 = new THREE.Vector3();
const _gf = new THREE.Vector3(), _gc = new THREE.Vector3(), _bb = new THREE.Vector3(), _bt = new THREE.Vector3();
const _contact = new THREE.Vector3(), _tv = new THREE.Vector3(), _exb = new THREE.Vector3();
void lerp;

window.game = new Game();

// Dev helpers for scripted playtesting from the console
if (import.meta.env.DEV) {
  const g = window.game;
  let simT = performance.now();
  const dbg = {
    sim(sec, onStep) {
      g.freeze = false;
      g.skipRender = !!dbg.fast;
      const n = Math.round(sec * 60);
      for (let i = 0; i < n; i++) { simT += 1000 / 60; g.frame(simT); if (onStep) onStep(i); }
      g.freeze = true;
      g.skipRender = false;
      g.last = simT;
    },
    tap(a) { g.input._kbDown(a); dbg.sim(1 / 60); g.input._kbUp(a); },
    hold(a) { g.input._kbDown(a); },
    release(a) { g.input._kbUp(a); },
    move(x, y) { g.input.keys.clear(); if (y > 0) g.input.keys.add('KeyW'); if (y < 0) g.input.keys.add('KeyS'); if (x > 0) g.input.keys.add('KeyD'); if (x < 0) g.input.keys.add('KeyA'); },
    start(wave = 0) {
      g.muted = true;
      g.startGame(); g.timers.length = 0; g.hud.hints.length = 0;
      audio.setMasterVolume(0);
      simT = performance.now(); g.last = simT;
      if (wave === 'boss') { g.director.wave = 4; g.director.phase = 'gate'; g.director.gateT = 0.5; g.artUnlocked = true; g.level.openGate(true); g.player.reset(g.level.spawnPoints.bossPlayer, Math.PI); }
      else if (wave >= 0) { g.director.startWave(wave); g.hud.hints.length = 0; if (wave >= 1) g.artUnlocked = true; }
      g.freeze = true;
    },
    unfreeze() { g.freeze = false; g.last = performance.now(); },
  };
  window.dbg = dbg;
}
if (import.meta.env.DEV) {
  // capture the current frame at full resolution and save it via the dev server
  window.dbg.shot = async (name = 'shot', w = 1280, h = 720) => {
    const g = window.game;
    const pr = g.pipeline.pixelRatio;
    const ow = window.innerWidth, oh = window.innerHeight;
    g.pipeline.pixelRatio = 1;
    g.renderer.setPixelRatio(1);
    g.renderer.setSize(w, h, false);
    g.pipeline.sceneRT.setSize(w, h); g.pipeline.inkRT.setSize(w, h); g.pipeline.bloom.setSize(w, h);
    g.pipeline.inkMat.uniforms.uRes.value.set(w, h); g.pipeline.fx.uRes.value.set(w, h);
    g.camera.aspect = w / h; g.camera.updateProjectionMatrix();
    g.camera.updateMatrixWorld();
    g.reflection.update(g.renderer, g.scene, g.camera);
    g.pipeline.render(g.scene, g.camera, g.time.real);
    const url = g.canvas.toDataURL('image/jpeg', 0.88);
    g.pipeline.pixelRatio = pr;
    g.pipeline.resize();
    void ow; void oh;
    const r = await fetch(`/__shot?name=${name}`, { method: 'POST', body: url });
    return r.text();
  };
}
if (import.meta.env.DEV) {
  const g = window.game;
  // orbit the gameplay camera around a target for a still
  window.dbg.view = async (name, yawOff = Math.PI / 2, pitch = 0.15, dist = 3.2, target = null, h = 1.45) => {
    const p = g.player;
    g.camRig.cine = null; g.camRig.lock = null;
    const hs = g.time.hitstop; g.time.hitstop = 5;
    const tp = (target || p.body.pos).clone(); tp.y += h - 1.45;
    g.camRig.yaw = p.yaw + Math.PI + yawOff; g.camRig.pitch = pitch; g.camRig.dist = g.camRig.distTarget = dist; g.camRig._smoothD = undefined;
    const sh = g.camRig.shoulder; g.camRig.shoulder = 0;
    g.camRig.pivot.copy(tp).setY(tp.y + 1.45);
    g.camRig.update(0.016, 0, tp, { x: 0, y: 0 }, {}); g.camRig.dist = dist;
    g.camRig.update(0.016, 0, tp, { x: 0, y: 0 }, {});
    g.camRig.shoulder = sh;
    const r = await window.dbg.shot(name);
    g.time.hitstop = hs;
    return r;
  };
}
