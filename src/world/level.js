import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeFlameMaterial } from './weather.js';
import { Rig } from '../actors/rig.js';
import { rand } from '../core/math.js';

// "The Ashgate" — a rain-soaked citadel courtyard with arcaded ramparts, a market, a statue plinth,
// and a portcullis leading to the inner sanctum where the Warden waits.

export const RAMPART_Y = 3.3;

export class Level {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.M = game.materials;
    this.buckets = new Map();
    this.flames = [];
    this.lights = [];
    this.breakables = [];
    this.swayMats = [];
    this.group = new THREE.Group();
    game.scene.add(this.group);
  }

  // ---------- builder helpers ----------
  _push(matKey, geo, uvScale = 0.5) {
    if (geo.index) geo = geo.toNonIndexed();
    worldUV(geo, uvScale);
    if (!this.buckets.has(matKey)) this.buckets.set(matKey, []);
    this.buckets.get(matKey).push(geo);
  }
  // box by min/max, optional collider
  box(x0, y0, z0, x1, y1, z1, mat, opts = {}) {
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    const r = opts.r ?? Math.min(0.06, Math.min(w, h, d) * 0.25);
    const geo = r > 0.001 ? new RoundedBoxGeometry(w, h, d, opts.seg ?? 2, r) : new THREE.BoxGeometry(w, h, d);
    if (opts.rotY) geo.rotateY(opts.rotY);
    geo.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    if (mat) this._push(mat, geo, opts.uv ?? 0.5);
    if (opts.collide !== false) return this.world.addBox(x0, y0, z0, x1, y1, z1, opts);
    return null;
  }
  boxC(x, y, z, w, h, d, mat, opts) {
    return this.box(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2, mat, opts);
  }
  geo(matKey, geo, uv) { this._push(matKey, geo, uv); }

  finalize() {
    for (const [key, list] of this.buckets) {
      const merged = mergeGeometries(list.map(stripTo), false);
      const mesh = new THREE.Mesh(merged, this.M[key]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    this.buckets.clear();
  }

  // ---------- build ----------
  build() {
    const M = this.M;
    const scene = this.game.scene;
    // ground (collider covers everything)
    this.world.addBox(-40, -1, -40, 40, 0, 40, { climb: false });
    const ground = new THREE.PlaneGeometry(30, 50, 1, 1).rotateX(-Math.PI / 2).translate(0, 0, -8);
    this.geo('cobble', ground, 0.62);

    this.buildWalls();
    this.buildRamparts();
    this.buildGatehouse();
    this.buildPlinth();
    this.buildMarket();
    this.buildWestYard();
    this.buildSanctum();
    this.buildDecor();
    this.finalize();
    this.buildLights();
    this.spawnPoints = this.makeSpawnPoints();
  }

  buildWalls() {
    const H = 7.5;
    // south wall with a barred door
    this.box(-15, 0, 16, 15, H, 17.2, 'wall');
    this.box(-1.6, 0, 15.75, 1.6, 3.4, 16.05, 'woodDark', { collide: false });
    for (let i = 0; i < 5; i++) this.box(-1.5 + i * 0.75, 0.2, 15.65, -1.38 + i * 0.75, 3.2, 15.75, 'iron', { collide: false, r: 0.01 });
    this.box(-2.1, 3.4, 15.6, 2.1, 3.9, 16.2, 'trim', { collide: false });
    // west / east outer walls
    this.box(-16.2, 0, -33, -15, H, 17.2, 'wall');
    this.box(15, 0, -33, 16.2, H, 17.2, 'wall');
    // battlements on top of outer walls
    for (let z = -32; z < 17; z += 1.6) {
      this.box(-16.2, H, z, -15, H + 0.7, z + 0.8, 'wall', { collide: false });
      this.box(15, H, z, 16.2, H + 0.7, z + 0.8, 'wall', { collide: false });
    }
    // north (dividing) wall with gate gap x in [-2.2, 2.2]
    this.box(-15, 0, -13, -2.2, H, -11.8, 'wall');
    this.box(2.2, 0, -13, 15, H, -11.8, 'wall');
    this.box(-2.2, 5.2, -13, 2.2, H, -11.8, 'wall');
    // sanctum back wall
    this.box(-15, 0, -34.2, 15, H + 2, -33, 'wall');
  }

  buildRamparts() {
    const Y = RAMPART_Y;
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -15 : 11.4, x1 = s < 0 ? -11.4 : 15;
      // walkway slab (arcade beneath)
      this.box(x0, Y - 0.3, -11.8, x1, Y, 16, 'trim', { r: 0.04 });
      // slab front lip
      const lipX = s < 0 ? x1 - 0.2 : x0;
      this.box(lipX, Y - 0.55, -11.8, lipX + 0.2, Y - 0.3, 16, 'trim', { collide: false, r: 0.03 });
      // pillars + arches
      const px = s < 0 ? -11.85 : 11.4;
      for (let z = -9.5; z <= 14; z += 4.25) {
        this.box(px, 0, z - 0.25, px + 0.45, Y - 0.3, z + 0.25, 'wall', { r: 0.05 });
        this.box(px - 0.08, 0, z - 0.33, px + 0.53, 0.35, z + 0.33, 'trim', { collide: false });
        this.box(px - 0.06, Y - 0.6, z - 0.3, px + 0.51, Y - 0.3, z + 0.3, 'trim', { collide: false });
        if (z + 4.25 <= 14.5) this.arch(px + 0.225, z + 2.125, 4.25 - 0.5, Y - 0.3, s);
      }
      // dark doorways in the outer wall under the arcade (spawn doors)
      for (const z of [-6, 3, 11]) {
        const wx = s < 0 ? -15.01 : 14.91;
        this.box(wx, 0, z - 0.8, wx + 0.1, 2.6, z + 0.8, 'woodDark', { collide: false, r: 0.01 });
        this.box(s < 0 ? -15 : 14.7, 2.6, z - 1.0, s < 0 ? -14.7 : 15, 2.9, z + 1.0, 'trim', { collide: false });
      }
    }
    // stairs: west along south wall, east along north wall
    this.stairs(-11.4, -5.4, 14.6, 16, 0, RAMPART_Y, -1);
    this.stairs(5.4, 11.4, -11.8, -10.4, 0, RAMPART_Y, 1);
    // north wall walkway connecting over gatehouse is solid wall top; add parapet segments at rampart ends
  }

  arch(x, z, span, topY, side) {
    // semicircular-ish arch made from small blocks spanning along z
    const n = 9;
    const r = span / 2;
    const geos = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI, a1 = ((i + 1) / n) * Math.PI;
      const am = (a0 + a1) / 2;
      const zz = z - Math.cos(am) * r;
      const yy = topY - 0.95 + Math.sin(am) * 0.6;
      const g = new RoundedBoxGeometry(0.4, 0.28, r * (a1 - a0) * 1.02, 1, 0.02);
      g.rotateX(-(am - Math.PI / 2) * 0.55);
      g.translate(x, yy, zz);
      geos.push(g);
    }
    // spandrel fill above the arch
    const fill = new THREE.BoxGeometry(0.36, 0.5, span).translate(x, topY - 0.4, z);
    geos.push(fill);
    for (const g of geos) this.geo('trim', g, 0.5);
  }

  stairs(x0, x1, z0, z1, y0, y1, dir) {
    // walkable ramp collider + visible steps
    this.world.addBox(x0, y0, z0, x1, y1, z1, { ramp: { axis: 'x', dir } });
    const steps = 14;
    const w = (x1 - x0) / steps;
    for (let i = 0; i < steps; i++) {
      const sx0 = x0 + i * w, sx1 = sx0 + w;
      const t = dir > 0 ? (i + 1) / steps : (steps - i) / steps;
      const top = y0 + (y1 - y0) * t;
      this.box(sx0, y0, z0, sx1 + 0.02, top, z1, 'trim', { collide: false, r: 0.03 });
    }
    // side wall under steps facing courtyard
    const sideZ = z0 < 0 ? z1 : z0 - 0.0;
    void sideZ;
  }

  buildGatehouse() {
    // flanking towers
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -5.2 : 2.2, x1 = s < 0 ? -2.2 : 5.2;
      this.box(x0, 0, -13.6, x1, 9.5, -11.1, 'wall');
      for (let i = 0; i < 3; i++) this.box(x0 + i * 1.05, 9.5, -13.6, x0 + i * 1.05 + 0.6, 10.3, -11.1, 'wall', { collide: false });
      this.box(x0 - 0.1, 5.2, -11.2, x1 + 0.1, 5.6, -10.9, 'trim', { collide: false });
      // arrow slit
      this.box((x0 + x1) / 2 - 0.08, 6.4, -11.12, (x0 + x1) / 2 + 0.08, 7.6, -11.08, 'iron', { collide: false, r: 0.01 });
    }
    // gate arch trim
    this.box(-2.4, 5.0, -11.4, 2.4, 5.4, -11.0, 'trim', { collide: false });
    // portcullis (dynamic)
    const bars = [];
    for (let i = 0; i <= 9; i++) bars.push(new THREE.BoxGeometry(0.09, 5.2, 0.09).translate(-2.1 + i * 0.466, 2.6, 0));
    for (let j = 0; j < 6; j++) bars.push(new THREE.BoxGeometry(4.4, 0.08, 0.08).translate(0, 0.4 + j * 0.9, 0));
    for (let i = 0; i <= 9; i++) bars.push(new THREE.ConeGeometry(0.07, 0.25, 6).rotateX(Math.PI).translate(-2.1 + i * 0.466, -0.1, 0));
    const pg = mergeGeometries(bars.map(stripTo));
    this.portcullis = new THREE.Mesh(pg, this.M.iron);
    this.portcullis.position.set(0, 0, -12.4);
    this.portcullis.castShadow = true;
    this.group.add(this.portcullis);
    this.gateBox = this.world.addBox(-2.2, 0, -12.6, 2.2, 5.2, -12.2, { climb: false });
    this.gateOpen = 0;
    this.gateOpening = false;
    // chains
    for (const s of [-1, 1]) this.box(s * 1.8 - 0.03, 5.2, -12.3, s * 1.8 + 0.03, 7.5, -12.24, 'iron', { collide: false, r: 0.01 });
  }

  buildPlinth() {
    // central statue plinth at (0, 2)
    const cz = 2;
    this.boxC(0, 0, cz, 5.6, 0.4, 5.6, 'trim', { r: 0.08 });
    this.boxC(0, 0.4, cz, 3.6, 0.7, 3.6, 'wall', { r: 0.08 });
    this.boxC(0, 1.1, cz, 3.8, 0.12, 3.8, 'trim', { collide: false, r: 0.04 });
    this.boxC(0, 1.1, cz, 1.3, 1.5, 1.3, 'trim', { r: 0.06 });
    this.boxC(0, 2.6, cz, 1.5, 0.14, 1.5, 'trim', { collide: false, r: 0.04 });
    // statue collider (cannot stand on the statue itself)
    this.world.addCentered(0, 2.6, cz, 0.9, 3.4, 0.9, { climb: false });
    // statue: a knight raising a sword, built with the character generator in stone
    const rig = new Rig('boss', { scale: 1.45 });
    rig.mesh.material = this.M.statue;
    rig.mesh.castShadow = true;
    const B = rig.bones;
    B['upperArm.R'].rotation.set(-2.6, 0, -0.3);
    B['forearm.R'].rotation.set(-0.5, 0, 0);
    B['upperArm.L'].rotation.set(-0.6, 0, 0.25);
    B['forearm.L'].rotation.set(-1.3, 0, 0);
    B.head.rotation.set(-0.25, 0.2, 0);
    B.chest.rotation.set(-0.08, 0.15, 0);
    B['thigh.L'].rotation.set(-0.35, 0, 0);
    B['shin.L'].rotation.set(0.4, 0, 0);
    const sword = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 1.6).translate(0, 0, 0.7), this.M.statue);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.06), this.M.statue);
    sword.add(guard);
    sword.rotation.x = 0;
    B['hand.R'].add(sword);
    sword.position.set(0, -0.08, 0);
    rig.root.position.set(0, 2.67, cz);
    rig.root.rotation.y = Math.PI;
    rig.root.updateMatrixWorld(true);
    this.group.add(rig.root);
    this.statue = rig;
  }

  buildMarket() {
    // two stalls on the east side facing west
    for (const zc of [7, -2.5]) {
      const x0 = 7.2, x1 = 10.8, z0 = zc - 2, z1 = zc + 2;
      for (const [px, pz] of [[x0, z0], [x0, z1], [x1, z0], [x1, z1]]) this.boxC(px, 0, pz, 0.18, 2.5, 0.18, 'woodDark', { r: 0.02 });
      // counter
      this.box(x0 - 0.1, 0, z0 + 0.3, x0 + 0.6, 1.0, z1 - 0.3, 'wood', { r: 0.03 });
      this.box(x0 - 0.2, 1.0, z0 + 0.2, x0 + 0.7, 1.08, z1 - 0.2, 'woodDark', { collide: false, r: 0.02 });
      // walkable roof collider + tiled visual (slight slope)
      this.world.addBox(x0 - 0.5, 2.5, z0 - 0.4, x1 + 0.3, 2.68, z1 + 0.4);
      const roof = new RoundedBoxGeometry(x1 - x0 + 0.8, 0.14, z1 - z0 + 0.8, 1, 0.03);
      roof.rotateZ(0.09);
      roof.translate((x0 + x1) / 2 - 0.1, 2.6, zc);
      this.geo('roof', roof, 0.6);
      // awning cloth hanging in front
      const aw = new THREE.PlaneGeometry(z1 - z0 + 0.6, 0.7, 8, 2).rotateY(Math.PI / 2);
      aw.translate(x0 - 0.52, 2.15, zc);
      const awm = new THREE.Mesh(aw, zc > 0 ? this.M.clothRed : this.M.clothTan);
      awm.castShadow = true;
      this.group.add(awm);
      // wares on counter
      for (let i = 0; i < 5; i++) this.boxC(x0 + 0.25, 1.08, z0 + 0.7 + i * 0.6, 0.25, rand(0.1, 0.25), 0.3, i % 2 ? 'hay' : 'woodDark', { collide: false, r: 0.03 });
      // sacks behind
      for (let i = 0; i < 3; i++) {
        const s = new THREE.SphereGeometry(0.32, 10, 8).scale(1, 0.8, 1).translate(x1 - 0.6, 0.26, z0 + 0.8 + i * 1.1);
        this.geo('clothTan', s, 1);
        this.world.addCentered(x1 - 0.6, 0, z0 + 0.8 + i * 1.1, 0.6, 0.5, 0.6);
      }
    }
    // climb route: crates by the north stall -> roof -> rampart
    this.crate(6.2, 0, 10.4, 1.0, false);
    this.crate(6.2, 1.0, 10.4, 1.0, false);
    this.crate(5.1, 0, 10.6, 1.0, false);
    this.crate(6.0, 0, 4.2, 0.9, false);
    // breakables scattered
    this.crate(5.0, 0, -5.4, 0.8, true);
    this.crate(4.6, 0, 9.0, 0.7, true);
    this.barrel(6.2, 0, -0.6, true);
    this.barrel(6.3, 0, 0.4, true);
    this.barrel(10.6, 0, 12.4, true);
    this.barrel(9.8, 0, 13.2, true);
    this.barrel(-4.4, 0, -9.4, true);
    this.crate(4.2, 0, -9.6, 0.8, true);
  }

  buildWestYard() {
    // cart
    const cx = -7.6, cz = 6.5;
    this.box(cx - 0.8, 0.5, cz - 1.5, cx + 0.8, 1.15, cz + 1.5, 'wood', { r: 0.04 });
    this.world.addBox(cx - 0.8, 0, cz - 1.5, cx + 0.8, 0.5, cz + 1.5);
    for (const sx of [-1, 1]) for (const sz of [-0.9, 0.9]) {
      const wheel = new THREE.CylinderGeometry(0.5, 0.5, 0.1, 14).rotateZ(Math.PI / 2).translate(cx + sx * 0.88, 0.5, cz + sz);
      this.geo('woodDark', wheel, 1);
    }
    this.box(cx - 0.06, 0.6, cz + 1.5, cx + 0.06, 0.7, cz + 3.2, 'woodDark', { collide: false, r: 0.02 });
    // hay bales stack
    this.box(-10.6, 0, -1.4, -9.0, 0.7, -0.2, 'hay', { r: 0.12 });
    this.box(-10.6, 0, -0.1, -9.0, 0.7, 1.1, 'hay', { r: 0.12 });
    this.box(-10.5, 0.7, -0.8, -9.1, 1.4, 0.5, 'hay', { r: 0.12 });
    // well
    const wx = -7.2, wz = -4.5;
    this.boxC(wx, 0, wz, 1.6, 0.85, 1.6, 'wall', { r: 0.08 });
    for (const sx of [-0.7, 0.7]) this.boxC(wx + sx, 0.85, wz, 0.14, 1.6, 0.14, 'woodDark', { collide: false, r: 0.02 });
    const wr = new RoundedBoxGeometry(1.9, 0.1, 1.4, 1, 0.02).rotateX(0.0).translate(wx, 2.5, wz);
    this.geo('roof', wr, 0.6);
    this.box(wx - 0.75, 2.2, wz - 0.03, wx + 0.75, 2.26, wz + 0.03, 'woodDark', { collide: false, r: 0.01 });
    const water = new THREE.CircleGeometry(0.6, 16).rotateX(-Math.PI / 2).translate(wx, 0.8, wz);
    this.geo('iron', water, 1);
    // weapon rack against arcade pillar
    this.box(-11.2, 0, 7.6, -10.9, 1.6, 9.4, 'woodDark', { r: 0.03 });
    for (let i = 0; i < 4; i++) this.box(-10.9, 0.2, 7.85 + i * 0.4, -10.86, 1.5, 7.88 + i * 0.4, 'iron', { collide: false, r: 0.005 });
    // breakables
    this.crate(-9.6, 0, 3.4, 0.8, true);
    this.crate(-9.4, 0, 4.4, 0.7, true);
    this.barrel(-5.4, 0, -6.6, true);
    this.barrel(-10.4, 0, -7.2, true);
    this.barrel(-10.2, 0, 12.6, true);
    // tree
    this.tree(-8.8, 11.6);
  }

  tree(x, z) {
    const parts = [];
    const branch = (p, dir, len, r, depth) => {
      const end = p.clone().addScaledVector(dir, len);
      const g = new THREE.CylinderGeometry(r * 0.65, r, len, 7);
      g.translate(0, len / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      g.translate(p.x, p.y, p.z);
      parts.push(g);
      if (depth > 0) {
        const n = depth > 2 ? 2 : 3;
        for (let i = 0; i < n; i++) {
          const nd = dir.clone().add(new THREE.Vector3(rand(-0.9, 0.9), rand(0.1, 0.6), rand(-0.9, 0.9))).normalize();
          branch(end, nd, len * rand(0.55, 0.8), r * 0.62, depth - 1);
        }
      }
    };
    branch(new THREE.Vector3(x, 0, z), new THREE.Vector3(0.1, 1, -0.05).normalize(), 2.4, 0.28, 4);
    for (const g of parts) this.geo('bark', g, 1);
    this.world.addCentered(x, 0, z, 0.55, 3.5, 0.55, { climb: false });
  }

  buildSanctum() {
    const zA = -13, zB = -33;
    // floor ring trim
    this.box(-11, 0, -31.8, 11, 0.35, -29, 'trim', { r: 0.05 });
    this.box(-9, 0.35, -32.6, 9, 0.7, -30.2, 'trim', { r: 0.05 });
    // chapel facade
    this.box(-8, 0, -33.4, 8, 12, -32.6, 'wallDark');
    this.box(-8.6, 0, -33.6, -6.8, 13, -32.2, 'wall');
    this.box(6.8, 0, -33.6, 8.6, 13, -32.2, 'wall');
    // rose window (glowing)
    const rose = new THREE.Mesh(new THREE.CircleGeometry(2.2, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.25, 0.08), toneMapped: false }));
    rose.position.set(0, 7.6, -32.55);
    this.group.add(rose);
    const tracery = [];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.BoxGeometry(0.1, 4.4, 0.1).rotateZ((i / 8) * Math.PI).translate(0, 7.6, -32.5);
      tracery.push(g);
    }
    tracery.push(new THREE.TorusGeometry(2.25, 0.14, 6, 32).translate(0, 7.6, -32.5));
    tracery.push(new THREE.TorusGeometry(1.0, 0.08, 6, 24).translate(0, 7.6, -32.5));
    for (const g of tracery) this.geo('trim', g, 0.5);
    this.roseLight = new THREE.PointLight(0xff4020, 12, 18, 1.6);
    this.roseLight.position.set(0, 6.5, -30.5);
    this.game.scene.add(this.roseLight);
    // great door
    this.box(-1.8, 0.7, -32.62, 1.8, 4.6, -32.5, 'woodDark', { collide: false, r: 0.02 });
    this.box(-2.2, 4.6, -32.7, 2.2, 5.0, -32.3, 'trim', { collide: false });
    // side walls already from outer walls; columns
    for (const s of [-1, 1]) for (const z of [-17, -22.5, -28]) {
      const x = s * 9.2;
      const broken = z === -22.5 && s > 0;
      this.boxC(x, 0, z, 1.1, 0.4, 1.1, 'trim', { r: 0.06 });
      const col = new THREE.CylinderGeometry(0.42, 0.46, broken ? 2.6 : 6.5, 14).translate(x, 0.4 + (broken ? 1.3 : 3.25), z);
      this.geo('wall', col, 0.5);
      this.world.addCentered(x, 0, z, 0.85, broken ? 3.0 : 6.9, 0.85);
      if (!broken) this.boxC(x, 6.9, z, 1.0, 0.35, 1.0, 'trim', { collide: false, r: 0.05 });
      else for (let i = 0; i < 4; i++) {
        const rub = new RoundedBoxGeometry(rand(0.3, 0.6), rand(0.2, 0.4), rand(0.3, 0.6), 1, 0.05).rotateY(rand(0, 3)).translate(x + rand(-1.2, 0.3), 0.15, z + rand(-1, 1));
        this.geo('wall', rub, 0.5);
      }
    }
    // hanging cages
    for (const [x, z] of [[-6, -20], [6, -25]]) {
      this.box(x - 0.02, 4.2, z - 0.02, x + 0.02, 7.5, z + 0.02, 'iron', { collide: false, r: 0.005 });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        this.box(x + Math.cos(a) * 0.45 - 0.02, 2.8, z + Math.sin(a) * 0.45 - 0.02, x + Math.cos(a) * 0.45 + 0.02, 4.2, z + Math.sin(a) * 0.45 + 0.02, 'iron', { collide: false, r: 0.005 });
      }
      this.boxC(x, 2.75, z, 1.0, 0.06, 1.0, 'iron', { collide: false, r: 0.01 });
      this.boxC(x, 4.2, z, 1.0, 0.06, 1.0, 'iron', { collide: false, r: 0.01 });
    }
    // candles on dais
    this.candles = [];
    for (let i = 0; i < 18; i++) {
      const x = rand(-8.5, 8.5), z = rand(-32.3, -30.4);
      const h = rand(0.15, 0.45);
      const c = new THREE.CylinderGeometry(0.035, 0.04, h, 8).translate(x, 0.7 + h / 2, z);
      this.geo('candle', c, 1);
      const f = new THREE.Mesh(this._candleGeo || (this._candleGeo = new THREE.SphereGeometry(0.025, 6, 4).scale(1, 1.8, 1)), this.M.glow);
      f.position.set(x, 0.7 + h + 0.04, z);
      this.group.add(f);
      this.candles.push(f);
    }
    void zA; void zB;
  }

  buildDecor() {
    // banners hanging from rampart lips
    for (const s of [-1, 1]) for (const z of [-7.4, 1.1, 9.6]) {
      const x = s < 0 ? -11.25 : 11.25;
      const g = new THREE.PlaneGeometry(1.1, 2.4, 4, 8).rotateY(s < 0 ? Math.PI / 2 : -Math.PI / 2);
      g.translate(0, -1.2, 0);
      const m = new THREE.Mesh(g, this.M.clothRed);
      m.position.set(x, RAMPART_Y - 0.4, z);
      m.castShadow = true;
      this.group.add(m);
      // emblem
      const e = new THREE.Mesh(new THREE.CircleGeometry(0.28, 6), this.M.brass);
      e.rotation.y = s < 0 ? Math.PI / 2 : -Math.PI / 2;
      e.position.set(x + (s < 0 ? 0.01 : -0.01), RAMPART_Y - 1.5, z);
      this.group.add(e);
    }
    // giant banners on the gate towers
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(1.8, 4.2, 4, 10).translate(0, -2.1, 0);
      const m = new THREE.Mesh(g, this.M.clothRed);
      m.position.set(s * 3.7, 8.6, -11.05);
      this.group.add(m);
    }
    // lantern strings across courtyard
    this.lanterns = [];
    for (const z of [-5.5, 5.5, 12.5]) {
      const pts = [];
      const n = 16;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = -11.4 + t * 22.8;
        const y = 5.6 - Math.sin(t * Math.PI) * 1.4;
        pts.push(new THREE.Vector3(x, y, z));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.TubeGeometry(curve, 32, 0.012, 4, false);
      this.geo('rope', tube, 1);
      for (let i = 2; i < n - 1; i += 3) {
        const p = pts[i];
        const lg = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.32, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.9, 0.3), toneMapped: false }));
        body.position.y = -0.3;
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.12, 8), this.M.iron);
        cap.position.y = -0.1;
        lg.add(body, cap);
        lg.position.copy(p);
        this.group.add(lg);
        this.lanterns.push({ g: lg, ph: Math.random() * 6 });
      }
    }
    // puddles
    for (let i = 0; i < 22; i++) {
      const x = rand(-10, 10), z = rand(-30, 14);
      if (Math.abs(x) < 3.2 && Math.abs(z - 2) < 3.2) continue;
      const g = new THREE.CircleGeometry(rand(0.5, 1.6), 20);
      const pos = g.attributes.position;
      for (let k = 1; k < pos.count; k++) {
        const a = Math.atan2(pos.getY(k), pos.getX(k));
        const r = 1 + Math.sin(a * 3 + i) * 0.18 + Math.sin(a * 5 + i * 2) * 0.1;
        pos.setXY(k, pos.getX(k) * r, pos.getY(k) * r * rand(0.6, 0.9));
      }
      const m = new THREE.Mesh(g, this.M.puddle);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = rand(0, 6);
      m.position.set(x, 0.008, z);
      m.receiveShadow = true;
      this.group.add(m);
    }
    // rubble + scattered stones
    for (let i = 0; i < 30; i++) {
      const x = rand(-13.5, 13.5), z = rand(-31, 15.5);
      const g = new RoundedBoxGeometry(rand(0.1, 0.3), rand(0.06, 0.16), rand(0.1, 0.3), 1, 0.03).rotateY(rand(0, 3)).translate(x, 0.05, z);
      this.geo('wall', g, 0.5);
    }
  }

  crate(x, y, z, s, breakable) {
    if (!breakable) {
      this.boxC(x, y, z, s, s, s, 'wood', { r: 0.04 });
      // frame strips
      this.boxC(x, y, z, s + 0.02, 0.08, s + 0.02, 'woodDark', { collide: false, r: 0.02 });
      this.boxC(x, y + s - 0.08, z, s + 0.02, 0.08, s + 0.02, 'woodDark', { collide: false, r: 0.02 });
      return;
    }
    const g = mergeGeometries([
      worldUVd(new RoundedBoxGeometry(s, s, s, 2, 0.04)),
      worldUVd(new RoundedBoxGeometry(s + 0.02, 0.08, s + 0.02, 1, 0.02).translate(0, -s / 2 + 0.04, 0)),
      worldUVd(new RoundedBoxGeometry(s + 0.02, 0.08, s + 0.02, 1, 0.02).translate(0, s / 2 - 0.04, 0)),
    ].map(stripTo));
    const m = new THREE.Mesh(g, this.M.wood);
    m.position.set(x, y + s / 2, z);
    m.rotation.y = rand(-0.3, 0.3);
    m.castShadow = m.receiveShadow = true;
    this.group.add(m);
    const box = this.world.addCentered(x, y, z, s, s, s);
    const b = { mesh: m, box, hp: 1, pos: new THREE.Vector3(x, y + s / 2, z), size: s, type: 'crate', alive: true };
    box.userData = b;
    this.breakables.push(b);
  }

  barrel(x, y, z, breakable) {
    const prof = [];
    for (let i = 0; i <= 8; i++) { const t = i / 8; prof.push(new THREE.Vector2(0.3 + Math.sin(t * Math.PI) * 0.06, t * 0.9)); }
    const body = new THREE.LatheGeometry(prof, 14);
    const lid = new THREE.CircleGeometry(0.3, 14).rotateX(-Math.PI / 2).translate(0, 0.9, 0);
    const hoops = [0.12, 0.45, 0.78].map((h) => new THREE.TorusGeometry(0.33 + Math.sin((h / 0.9) * Math.PI) * 0.05, 0.015, 4, 16).rotateX(Math.PI / 2).translate(0, h, 0));
    const m = new THREE.Group();
    const bm = new THREE.Mesh(mergeGeometries([body, lid].map(stripTo)), this.M.wood);
    const hm = new THREE.Mesh(mergeGeometries(hoops.map(stripTo)), this.M.iron);
    bm.castShadow = hm.castShadow = true;
    bm.receiveShadow = true;
    m.add(bm, hm);
    m.position.set(x, y, z);
    this.group.add(m);
    const box = this.world.addCentered(x, y, z, 0.66, 0.9, 0.66);
    if (breakable) {
      const b = { mesh: m, box, hp: 1, pos: new THREE.Vector3(x, y + 0.45, z), size: 0.7, type: 'barrel', alive: true };
      box.userData = b;
      this.breakables.push(b);
    }
  }

  breakObject(b, dir) {
    if (!b.alive) return;
    b.alive = false;
    this.world.remove(b.box);
    b.mesh.removeFromParent();
    const g = this.game;
    g.fx.splinters(b.pos, b.type === 'crate' ? 18 : 14, 0x6a4a30, dir);
    g.fx.dustPuff(b.pos, 10, [0.2, 0.17, 0.14]);
    g.audio.play('break_wood', { pos: b.pos });
  }

  buildLights() {
    const scene = this.game.scene;
    const braziers = [[-9, -9.2], [9, -8.6], [-9.8, 14], [3.4, 14.2], [-3.7, -10.4], [3.7, -10.4], [-6, -28.5], [6, -28.5]];
    const flameGeo = new THREE.PlaneGeometry(1, 1);
    for (const [x, z] of braziers) {
      // stand + bowl
      const parts = [
        new THREE.CylinderGeometry(0.05, 0.08, 0.9, 8).translate(x, 0.45, z),
        new THREE.CylinderGeometry(0.42, 0.26, 0.3, 12, 1, true).translate(x, 1.05, z),
        new THREE.TorusGeometry(0.42, 0.03, 6, 16).rotateX(Math.PI / 2).translate(x, 1.2, z),
      ];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        parts.push(new THREE.CylinderGeometry(0.025, 0.03, 0.95, 6).rotateZ(0.35).rotateY(a).translate(x + Math.cos(a) * 0.2, 0.4, z + Math.sin(a) * 0.2));
      }
      for (const p of parts) this.geo('iron', p, 1);
      this.world.addCentered(x, 0, z, 0.7, 1.15, 0.7, { climb: false });
      const coal = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.3, 0.12, 10), this.M.coal);
      coal.position.set(x, 1.1, z);
      this.group.add(coal);
      const flames = [];
      for (let i = 0; i < 3; i++) {
        const fm = makeFlameMaterial();
        const f = new THREE.Mesh(flameGeo, fm);
        f.position.set(x + rand(-0.12, 0.12), 1.08, z + rand(-0.12, 0.12));
        f.scale.set(rand(0.55, 0.8), rand(0.9, 1.3), 1);
        f.renderOrder = 7;
        f.frustumCulled = false;
        this.group.add(f);
        flames.push(f);
      }
      const light = new THREE.PointLight(0xff8a3a, 7, 14, 1.5);
      light.position.set(x, 1.8, z);
      scene.add(light);
      this.lights.push({ light, base: 7, ph: Math.random() * 10, pos: new THREE.Vector3(x, 1.4, z) });
      this.flames.push(...flames);
    }
  }

  makeSpawnPoints() {
    return {
      player: new THREE.Vector3(0, 0, 13),
      doors: [
        new THREE.Vector3(-13.6, 0, -6), new THREE.Vector3(-13.6, 0, 3), new THREE.Vector3(-13.6, 0, 11),
        new THREE.Vector3(13.6, 0, -6), new THREE.Vector3(13.6, 0, 3), new THREE.Vector3(13.6, 0, 11),
      ],
      rampart: [
        new THREE.Vector3(-12.6, RAMPART_Y, -4), new THREE.Vector3(-12.6, RAMPART_Y, 6),
        new THREE.Vector3(12.6, RAMPART_Y, -2), new THREE.Vector3(12.6, RAMPART_Y, 8),
      ],
      boss: new THREE.Vector3(0, 0, -27),
      bossPlayer: new THREE.Vector3(0, 0, -16),
    };
  }

  openGate() {
    if (this.gateOpening) return;
    this.gateOpening = true;
    this.game.audio.play('gate', { pos: new THREE.Vector3(0, 2, -12) });
  }

  update(dt, t) {
    for (const f of this.flames) f.material.uniforms.uTime.value = t;
    for (const L of this.lights) {
      const fl = 0.82 + Math.sin(t * 13 + L.ph) * 0.06 + Math.sin(t * 7.3 + L.ph * 2) * 0.08 + Math.sin(t * 23 + L.ph) * 0.04;
      L.light.intensity = L.base * fl;
    }
    if (this.roseLight) this.roseLight.intensity = 10 + Math.sin(t * 1.3) * 1.5;
    for (const k of ['clothRed', 'clothDark', 'clothTan', 'leaves']) {
      const u = this.M[k].userData.uniforms.uTime;
      if (u) u.value = t;
    }
    if (this.lanterns) for (const l of this.lanterns) l.g.rotation.z = Math.sin(t * 1.4 + l.ph) * 0.08;
    if (this.candles) for (let i = 0; i < this.candles.length; i++) this.candles[i].scale.y = 1 + Math.sin(t * 17 + i * 3) * 0.2;
    if (this.gateOpening && this.gateOpen < 1) {
      this.gateOpen = Math.min(1, this.gateOpen + dt / 3.2);
      const e = this.gateOpen * this.gateOpen * (3 - 2 * this.gateOpen);
      this.portcullis.position.y = e * 5.0;
      this.portcullis.position.x = Math.sin(t * 40) * 0.01 * (1 - this.gateOpen);
      if (this.gateOpen > 0.45 && this.gateBox.active) this.world.remove(this.gateBox);
    }
  }
}

// --- geometry utilities ---
function stripTo(g) {
  let geo = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo;
}
// planar world-space UVs picked by face normal so textures never stretch
function worldUV(geo, s) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  if (!n) geo.computeVertexNormals();
  const N = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const nx = Math.abs(N.getX(i)), ny = Math.abs(N.getY(i)), nz = Math.abs(N.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = p.getX(i); v = p.getZ(i); }
    else if (nx >= nz) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u * s; uv[i * 2 + 1] = v * s;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
function worldUVd(g) { const geo = g.index ? g.toNonIndexed() : g; worldUV(geo, 0.9); return geo; }
