// Unified keyboard/mouse + gamepad (DualSense / standard mapping) input with press buffering.

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'dodge', ShiftRight: 'dodge',
  KeyQ: 'parry', KeyC: 'parry',
  KeyF: 'kick', KeyE: 'art', KeyV: 'art',
  Tab: 'lock',
  Escape: 'pause', KeyP: 'pause',
  KeyR: 'restart',
  Enter: 'confirm',
};
const MOUSEMAP = { 0: 'light', 1: 'lock', 2: 'heavy', 3: 'parry', 4: 'parry' };
// Standard gamepad mapping (DualSense in Chrome/Safari/Firefox)
const PADMAP = {
  0: 'jump',     // Cross
  1: 'dodge',    // Circle
  2: 'light',    // Square
  3: 'heavy',    // Triangle
  4: 'parry',    // L1
  5: 'kick',     // R1
  6: 'lockhold', // L2 (hold to lock on)
  7: 'art',      // R2 (Blood Art)
  11: 'lock',    // R3
  9: 'pause',    // Options
  8: 'restart',  // Create
};
const ACTIONS = ['jump', 'dodge', 'light', 'heavy', 'parry', 'kick', 'lock', 'lockhold', 'art', 'pause', 'restart', 'confirm'];

class Input {
  constructor() {
    this.keys = new Set();
    this.held = Object.fromEntries(ACTIONS.map((a) => [a, false]));
    this.heldSince = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
    this.pressT = Object.fromEntries(ACTIONS.map((a) => [a, -1e9]));
    this.releaseT = Object.fromEntries(ACTIONS.map((a) => [a, -1e9]));
    this.consumed = Object.fromEntries(ACTIONS.map((a) => [a, true]));
    this._kbHeld = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
    this._padHeld = Object.fromEntries(ACTIONS.map((a) => [a, false]));
    this.move = { x: 0, y: 0 };      // x right, y forward, magnitude 0..1
    this.look = { x: 0, y: 0 };      // radians this frame (yaw delta, pitch delta)
    this._mouse = { x: 0, y: 0 };
    this.device = 'kbm';
    this.padConnected = false;
    this.padName = '';
    this.sensitivity = 0.0022;
    this.padSensitivity = 3.4;
    this.invertY = false;
    this.locked = false;
    this.now = 0;
    this.enabled = true;
    this.onPress = null; // optional callback(action)
    this._padIndex = -1;
    this._rumbleUntil = 0;
  }

  attach(canvas) {
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.device = 'kbm';
      this.keys.add(e.code);
      const a = KEYMAP[e.code];
      if (a && ACTIONS.includes(a)) this._kbDown(a);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const a = KEYMAP[e.code];
      if (a && ACTIONS.includes(a)) this._kbUp(a);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      for (const a of ACTIONS) { this._kbHeld[a] = 0; this._setHeld(a); }
    });
    canvas.addEventListener('mousedown', (e) => {
      this.device = 'kbm';
      if (!this.locked) return;
      const a = MOUSEMAP[e.button];
      if (a) this._kbDown(a);
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => {
      const a = MOUSEMAP[e.button];
      if (a) this._kbUp(a);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Ignore absurd spikes some browsers emit on lock
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this._mouse.x += e.movementX;
      this._mouse.y += e.movementY;
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) this.device = 'kbm';
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    window.addEventListener('gamepadconnected', (e) => {
      this.padConnected = true;
      this.padName = e.gamepad.id;
      this._padIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this._padIndex) { this._padIndex = -1; this.padConnected = false; }
    });
  }

  requestLock() {
    if (!this.canvas || this.locked) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { this.canvas.requestPointerLock(); } catch (_) {} });
    } catch (_) {
      try { this.canvas.requestPointerLock(); } catch (_) {}
    }
  }

  _kbDown(a) {
    this._kbHeld[a]++;
    this._setHeld(a);
  }
  _kbUp(a) {
    this._kbHeld[a] = Math.max(0, this._kbHeld[a] - 1);
    this._setHeld(a);
  }
  _setHeld(a) {
    const h = this._kbHeld[a] > 0 || this._padHeld[a];
    if (h && !this.held[a]) {
      this.pressT[a] = this.now;
      this.consumed[a] = false;
      this.heldSince[a] = this.now;
      if (this.onPress) this.onPress(a);
    } else if (!h && this.held[a]) {
      this.releaseT[a] = this.now;
    }
    this.held[a] = h;
  }

  _getPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this._padIndex >= 0 && pads[this._padIndex]) return pads[this._padIndex];
    for (const p of pads) if (p && p.connected) { this._padIndex = p.index; this.padConnected = true; this.padName = p.id; return p; }
    return null;
  }

  // Call once per frame before game logic. realDt in seconds.
  update(realDt, now) {
    this.now = now;
    // Keyboard movement
    let mx = 0, my = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    const kl = Math.hypot(mx, my);
    if (kl > 0) { mx /= kl; my /= kl; }

    let lx = this._mouse.x * this.sensitivity;
    let ly = this._mouse.y * this.sensitivity;
    this._mouse.x = this._mouse.y = 0;

    const pad = this._getPad();
    if (pad) {
      const ax = pad.axes;
      const ls = radial(ax[0] || 0, ax[1] || 0, 0.14);
      const rs = radial(ax[2] || 0, ax[3] || 0, 0.12);
      if (ls.m > 0) {
        this.device = 'pad';
        if (kl === 0) { mx = ls.x; my = -ls.y; }
      }
      if (rs.m > 0) {
        this.device = 'pad';
        const curve = Math.pow(rs.m, 1.7) / rs.m;
        lx += rs.x * curve * this.padSensitivity * realDt;
        ly += rs.y * curve * this.padSensitivity * 0.62 * realDt;
      }
      for (const [idx, a] of Object.entries(PADMAP)) {
        const b = pad.buttons[idx];
        if (!b) continue;
        const down = b.pressed || b.value > 0.45;
        if (down !== this._padHeld[a] && down) this.device = 'pad';
        // multiple buttons can map to one action; OR them
        this._padTmp = this._padTmp || {};
        this._padTmp[a] = (this._padTmp[a] || false) || down;
      }
      for (const a of ACTIONS) {
        const down = !!(this._padTmp && this._padTmp[a]);
        if (down !== this._padHeld[a]) { this._padHeld[a] = down; this._setHeld(a); }
      }
      this._padTmp = null;
    }
    this.move.x = mx;
    this.move.y = my;
    this.look.x = lx;
    this.look.y = this.invertY ? -ly : ly;
    this.flick = pad ? (Math.abs(pad.axes[2] || 0) > 0.75 ? Math.sign(pad.axes[2]) : 0) : 0;
    if (!this.enabled) { this.move.x = this.move.y = 0; this.look.x = this.look.y = 0; }
  }

  // Was `a` pressed within `window` seconds and not yet consumed? Consumes it.
  take(a, window = 0.18) {
    if (!this.enabled) return false;
    if (!this.consumed[a] && this.now - this.pressT[a] <= window) {
      this.consumed[a] = true;
      return true;
    }
    return false;
  }
  peek(a, window = 0.18) {
    return this.enabled && !this.consumed[a] && this.now - this.pressT[a] <= window;
  }
  isHeld(a) { return this.enabled && this.held[a]; }
  heldFor(a) { return this.held[a] ? this.now - this.heldSince[a] : 0; }
  clearBuffer() { for (const a of ACTIONS) this.consumed[a] = true; }

  rumble(strong = 0.5, weak = 0.5, ms = 120) {
    const pad = this._getPad();
    if (!pad || this.device !== 'pad') return;
    const act = pad.vibrationActuator;
    if (!act || !act.playEffect) return;
    try {
      act.playEffect('dual-rumble', {
        startDelay: 0, duration: ms,
        strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak),
      }).catch(() => {});
    } catch (_) {}
  }
}

function radial(x, y, dead) {
  const m = Math.hypot(x, y);
  if (m < dead) return { x: 0, y: 0, m: 0 };
  const nm = Math.min(1, (m - dead) / (1 - dead));
  return { x: (x / m) * nm, y: (y / m) * nm, m: nm };
}

export const input = new Input();
