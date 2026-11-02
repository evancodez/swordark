import { damp } from './math.js';

// Global game time: hitstop (freeze frames) and slow motion.
export const time = {
  real: 0,          // real seconds since start
  game: 0,          // scaled game seconds
  dt: 0,            // scaled delta this frame
  realDt: 0,
  scale: 1,         // current slowmo scale (smoothed)
  hitstop: 0,       // remaining real seconds of hitstop
  _slowTarget: 1,
  _slowTimer: 0,
  _slowRelease: 6,

  step(realDt) {
    this.realDt = realDt;
    this.real += realDt;
    if (this._slowTimer > 0) {
      this._slowTimer -= realDt;
      if (this._slowTimer <= 0) this._slowTarget = 1;
    }
    const k = this._slowTarget < this.scale ? 30 : this._slowRelease;
    this.scale = damp(this.scale, this._slowTarget, k, realDt);
    if (Math.abs(this.scale - 1) < 0.002) this.scale = 1;
    let s = this.scale;
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      s *= 0.03;
    }
    this.dt = realDt * s;
    this.game += this.dt;
  },

  // Freeze-frame on impact. Longest request wins.
  stop(seconds) {
    this.hitstop = Math.max(this.hitstop, seconds);
  },

  // Slow motion to `scale` for `seconds` of real time, then ease back.
  slow(scale, seconds, release = 6) {
    if (scale <= this._slowTarget || this._slowTimer <= 0) {
      this._slowTarget = scale;
      this._slowTimer = Math.max(this._slowTimer, seconds);
      this._slowRelease = release;
    }
  },

  get slowAmount() {
    return 1 - this.scale;
  },
};
