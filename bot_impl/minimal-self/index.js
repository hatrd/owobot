// minimal-self/index.js - Module installer for Minimal Self system
// Hooks into skill:start/end and external:begin/end events
// Learns world model and computes agency attribution

const { encode } = require('./state-encode');
const { WorldModel, NOOP } = require('./world-model');
const { computeAgency, agencyLevel } = require('./attribution');
const { IdentityStore } = require('./identity');

const NOOP_INTERVAL = 5000; // ms between NoOp baseline samples
const MIN_IDLE_TIME = 2000; // ms of idle before NoOp learning

class MinimalSelf {
  constructor(bot, state) {
    this.bot = bot;
    this.state = state;
    this.W = new WorldModel();

    // Restore persisted world model if available
    if (state.minimalSelf?.worldModel) {
      this.W.deserialize(state.minimalSelf.worldModel);
    }

    // M2: Identity Store
    this.identity = new IdentityStore(state);

    // Action tracking
    this.currentAction = null;
    this.actionStartState = null;
    this.lastActionEnd = 0;

    // NoOp baseline tracking
    this.lastNoopSample = 0;
    this.lastNoopState = null;

    // Agency history (recent attributions)
    this.agencyHistory = [];
    this.maxHistory = 50;

    // Event handlers (bound for cleanup)
    this._onSkillStart = this._handleSkillStart.bind(this);
    this._onSkillEnd = this._handleSkillEnd.bind(this);
    this._onExternalBegin = this._handleExternalBegin.bind(this);
    this._onExternalEnd = this._handleExternalEnd.bind(this);
    this._onTick = this._handleTick.bind(this);

    this._tickInterval = null;
  }

  activate() {
    const bot = this.bot;

    bot.on('skill:start', this._onSkillStart);
    bot.on('skill:end', this._onSkillEnd);
    bot.on('external:begin', this._onExternalBegin);
    bot.on('external:end', this._onExternalEnd);

    // Periodic tick for NoOp learning
    this._tickInterval = setInterval(this._onTick, 1000);

    console.log('[minimal-self] activated');
  }

  deactivate() {
    const bot = this.bot;

    bot.off('skill:start', this._onSkillStart);
    bot.off('skill:end', this._onSkillEnd);
    bot.off('external:begin', this._onExternalBegin);
    bot.off('external:end', this._onExternalEnd);

    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }

    // Persist world model
    this.state.minimalSelf = this.state.minimalSelf || {};
    this.state.minimalSelf.worldModel = this.W.serialize();

    console.log('[minimal-self] deactivated, model persisted');
  }

  _handleSkillStart(data) {
    const snap = this._getSnapshot();
    if (!snap) return;

    this.currentAction = data?.name || 'skill';
    this.actionStartState = encode(snap);
  }

  _handleSkillEnd(data) {
    if (!this.actionStartState || !this.currentAction) return;

    const snap = this._getSnapshot();
    if (!snap) return;

    const s2 = encode(snap);
    const action = this.currentAction;
    const s1 = this.actionStartState;

    // Learn transition
    this.W.learn(s1, action, s2);

    // Compute and record agency
    const agency = computeAgency(this.W, s1, action, s2);
    const success = data?.success ?? (data?.status === 'succeeded');
    this._recordAgency(action, agency, success);

    // M2: Update identity store with skill outcome
    this.identity.recordSkillOutcome(action, success, agency);

    // Reset
    this.currentAction = null;
    this.actionStartState = null;
    this.lastActionEnd = Date.now();
  }

  _handleExternalBegin(data) {
    // External event starts - world is changing not by our action
    // We can use this to learn environmental changes
    const snap = this._getSnapshot();
    if (!snap) return;
    this.lastNoopState = encode(snap);
  }

  _handleExternalEnd(data) {
    // External event ends - learn as NoOp (environmental change)
    if (!this.lastNoopState) return;

    const snap = this._getSnapshot();
    if (!snap) return;

    const s2 = encode(snap);
    this.W.learnNoop(this.lastNoopState, s2);
    this.lastNoopState = null;
  }

  _handleTick() {
    const now = Date.now();

    // Guard: bot disconnected
    if (!this.bot?.entity) return;

    // M2: Apply identity decay periodically
    try { this.identity._applyDecay(); } catch {}

    // Only learn NoOp when truly idle
    if (this.currentAction) return;
    if (this.state.externalBusy) return;
    if (now - this.lastActionEnd < MIN_IDLE_TIME) return;
    if (now - this.lastNoopSample < NOOP_INTERVAL) return;

    const snap = this._getSnapshot();
    if (!snap) return;

    const s2 = encode(snap);

    if (this.lastNoopState) {
      this.W.learnNoop(this.lastNoopState, s2);
    }

    this.lastNoopState = s2;
    this.lastNoopSample = now;
  }

  _getSnapshot() {
    try {
      const observer = require('../agent/observer');
      return observer.snapshot(this.bot, {});
    } catch {
      return null;
    }
  }

  _recordAgency(action, agency, success) {
    this.agencyHistory.push({
      t: Date.now(),
      action,
      agency,
      level: agencyLevel(agency),
      success: success ?? null
    });

    // Prune old entries
    while (this.agencyHistory.length > this.maxHistory) {
      this.agencyHistory.shift();
    }
  }

  // Public API

  getStats() {
    return {
      worldModel: this.W.getStats(),
      agencyHistory: this.agencyHistory.length,
      avgAgency: this._avgAgency(),
      identity: this.identity.getStats()
    };
  }

  _avgAgency() {
    if (!this.agencyHistory.length) return 0.5;
    const sum = this.agencyHistory.reduce((a, h) => a + h.agency, 0);
    return sum / this.agencyHistory.length;
  }

  getRecentAgency(n = 10) {
    return this.agencyHistory.slice(-n);
  }

  // For debugging/introspection
  explainLastAction() {
    const last = this.agencyHistory[this.agencyHistory.length - 1];
    if (!last) return null;
    return {
      action: last.action,
      agency: last.agency.toFixed(3),
      level: last.level,
      interpretation: last.level === 'high'
        ? 'I caused this change'
        : last.level === 'medium'
          ? 'Partially my doing'
          : 'Environment caused this'
    };
  }

  // M2: Identity API
  getIdentity() {
    return this.identity;
  }

  buildIdentityContext() {
    return this.identity.buildIdentityContext();
  }

  scoreAction(action, baseValue = 1.0) {
    return this.identity.scoreAction(action, baseValue);
  }
}

let instance = null;

function activate(bot, state) {
  if (instance) instance.deactivate();
  instance = new MinimalSelf(bot, state);
  instance.activate();
  return instance;
}

function deactivate() {
  if (instance) {
    instance.deactivate();
    instance = null;
  }
}

function getInstance() {
  return instance;
}

module.exports = { activate, deactivate, getInstance, MinimalSelf };
