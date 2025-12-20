// world-model.js - World prediction model W
// W.predict(state, action) -> predictedState
// W.learn(s1, action, s2) -> void

const { stateKey, loss } = require('./state-encode');

const NOOP = 'noop';
const MAX_TRANSITIONS = 500;
const DECAY = 0.95;

class WorldModel {
  constructor() {
    // Map: stateKey|action -> { mean: deltaState, count: number }
    this.transitions = new Map();
    this.noopBaseline = new Map(); // stateKey -> { mean: deltaState, count }
  }

  predict(state, action) {
    if (!state) return null;
    const key = `${stateKey(state)}|${action || NOOP}`;
    const t = this.transitions.get(key);
    if (!t) return { ...state }; // No data, predict no change
    return this._applyDelta(state, t.mean);
  }

  predictNoop(state) {
    return this.predict(state, NOOP);
  }

  learn(s1, action, s2) {
    if (!s1 || !s2) return;
    const delta = this._computeDelta(s1, s2);
    const key = `${stateKey(s1)}|${action || NOOP}`;

    this._updateTransition(key, delta);

    // Track NoOp baseline separately when action is noop
    if (action === NOOP || action == null) {
      this._updateNoop(stateKey(s1), delta);
    }

    this._prune();
  }

  learnNoop(s1, s2) {
    this.learn(s1, NOOP, s2);
  }

  _updateTransition(key, delta) {
    const existing = this.transitions.get(key);
    if (!existing) {
      this.transitions.set(key, { mean: delta, count: 1 });
    } else {
      // Exponential moving average
      const c = existing.count + 1;
      const alpha = 1 / Math.min(c, 10);
      existing.mean = this._mergeDelta(existing.mean, delta, alpha);
      existing.count = c;
    }
  }

  _updateNoop(sKey, delta) {
    const existing = this.noopBaseline.get(sKey);
    if (!existing) {
      this.noopBaseline.set(sKey, { mean: delta, count: 1 });
    } else {
      const c = existing.count + 1;
      const alpha = 1 / Math.min(c, 10);
      existing.mean = this._mergeDelta(existing.mean, delta, alpha);
      existing.count = c;
    }
  }

  _computeDelta(s1, s2) {
    const d = {};
    const numKeys = ['x', 'y', 'z', 'hp', 'food', 'playersNear', 'hostilesNear', 'nearestHostileDist'];
    for (const k of numKeys) {
      const v1 = s1[k], v2 = s2[k];
      if (v2 != null && v1 != null && Number.isFinite(v1) && Number.isFinite(v2)) {
        d[k] = v2 - v1;
      }
    }
    // Categorical changes
    d.heldChanged = s1.held !== s2.held ? 1 : 0;
    d.invChanged = s1.invHash !== s2.invHash ? 1 : 0;
    d.blockUnderChanged = s1.blockUnder !== s2.blockUnder ? 1 : 0;
    return d;
  }

  _mergeDelta(old, neu, alpha) {
    const m = {};
    const keys = new Set([...Object.keys(old), ...Object.keys(neu)]);
    for (const k of keys) {
      const o = old[k] || 0;
      const n = neu[k] || 0;
      m[k] = o * (1 - alpha) + n * alpha;
    }
    return m;
  }

  _applyDelta(state, delta) {
    const p = { ...state };
    const numKeys = ['x', 'y', 'z', 'hp', 'food', 'playersNear', 'hostilesNear', 'nearestHostileDist'];
    for (const k of numKeys) {
      if (delta[k] != null && p[k] != null) {
        p[k] = p[k] + Math.round(delta[k]);
      }
    }
    return p;
  }

  _prune() {
    if (this.transitions.size > MAX_TRANSITIONS) {
      // Remove oldest/least used entries
      const entries = Array.from(this.transitions.entries());
      entries.sort((a, b) => a[1].count - b[1].count);
      const toRemove = entries.slice(0, Math.floor(MAX_TRANSITIONS * 0.2));
      for (const [k] of toRemove) this.transitions.delete(k);
    }
    if (this.noopBaseline.size > MAX_TRANSITIONS / 2) {
      const entries = Array.from(this.noopBaseline.entries());
      entries.sort((a, b) => a[1].count - b[1].count);
      const toRemove = entries.slice(0, Math.floor(MAX_TRANSITIONS * 0.1));
      for (const [k] of toRemove) this.noopBaseline.delete(k);
    }
  }

  getStats() {
    return {
      transitions: this.transitions.size,
      noopSamples: this.noopBaseline.size
    };
  }

  serialize() {
    return {
      transitions: Array.from(this.transitions.entries()),
      noopBaseline: Array.from(this.noopBaseline.entries())
    };
  }

  deserialize(data) {
    if (data?.transitions) {
      this.transitions = new Map(data.transitions);
    }
    if (data?.noopBaseline) {
      this.noopBaseline = new Map(data.noopBaseline);
    }
  }
}

module.exports = { WorldModel, NOOP };
