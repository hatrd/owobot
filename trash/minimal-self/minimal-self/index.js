// minimal-self/index.js - Module installer for Minimal Self system
// Hooks into skill:start/end and external:begin/end events
// Learns world model and computes agency attribution

const { encode } = require('./state-encode');
const { WorldModel, NOOP } = require('./world-model');
const { computeAgency, agencyLevel } = require('./attribution');
const { IdentityStore } = require('./identity');
const { NarrativeMemory } = require('./narrative');
const { DriveEngine } = require('./drive');

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

    // M3: Narrative Memory
    this.narrative = new NarrativeMemory(state, this.identity);

    // M5: Internal Drive System
    this.drive = new DriveEngine({ state });
    this._lastDriveTickAt = 0;

    // Action tracking
    this.currentAction = null;
    this.actionStartState = null;
    this.actionPredictedScore = null; // M4: Track predicted score
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

    this.currentAction = String(data?.name || 'skill');
    this.actionStartState = encode(snap);

    // M4: Capture predicted score for later outcome recording
    const scoreResult = this.identity.scoreAction(this.currentAction);
    this.actionPredictedScore = scoreResult?.score ?? 0.5;
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
    const success = typeof data?.success === 'boolean'
      ? data.success
      : (data?.status === 'succeeded');
    this._recordAgency(action, agency, success);

    // M2: Update identity store with skill outcome
    this.identity.recordSkillOutcome(action, success, agency);

    // M4: Record decision outcome for introspection
    if (this.actionPredictedScore != null) {
      this.identity.recordDecisionOutcome(action, this.actionPredictedScore, success);
    }

    // Reset
    this.currentAction = null;
    this.actionStartState = null;
    this.actionPredictedScore = null;
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

    // Snapshot once (used by drive + NoOp)
    const snap = this._getSnapshot();

    // M2: Apply identity decay periodically
    try { this.identity._applyDecay(); } catch {}

    // M4: Periodic introspection for parameter adjustment
    try { this.identity.introspect(); } catch {}

    // M5: Drive tick (runs regardless of NoOp learning gates)
    try {
      if (this.drive) {
        const prev = this._lastDriveTickAt || now;
        const dt = Math.max(0, (now - prev) / 1000);
        this._lastDriveTickAt = now;

        const identityPart = this.identity.buildIdentityContext();
        const narrativePart = this.narrative.buildNarrativeContext();
        const identityContext = [identityPart, narrativePart].filter(Boolean).join(' | ');

        // Collect online players from bot.players (Mineflayer API)
        const onlinePlayers = (() => {
          try {
            const players = this.bot?.players;
            if (!players || typeof players !== 'object') return [];
            const botName = this.bot?.username || '';
            return Object.keys(players)
              .filter(n => n && n !== botName)
              .map(n => ({ name: n }));
          } catch { return []; }
        })();

        // Detect pathfinder movement state
        const hasPathfinderGoal = !!(this.bot.pathfinder && this.bot.pathfinder.goal);
        // Get pending commitments for drive gating
        const pendingCommitments = this.identity.getPendingCommitments();

        const trigger = this.drive.tick(dt, {
          snapshot: snap,
          identityContext,
          identityStats: this.identity.getStats(),
          currentAction: this.currentAction,
          externalBusy: this.state.externalBusy,
          lastActionEnd: this.lastActionEnd,
          onlinePlayers,
          hasPathfinderGoal,
          pendingCommitments
        });

        if (trigger?.message) {
          try { this.bot.emit('minimal-self:drive', trigger); } catch {}
        }
      }
    } catch {}

    // Only learn NoOp when truly idle
    if (this.currentAction) return;
    if (this.state.externalBusy) return;
    if (now - this.lastActionEnd < MIN_IDLE_TIME) return;
    if (now - this.lastNoopSample < NOOP_INTERVAL) return;

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
      identity: this.identity.getStats(),
      narrative: this.narrative.getStats()
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
    // Combine identity profile with narrative memory and drive state
    const identityPart = this.identity.buildIdentityContext();
    const narrativePart = this.narrative.buildNarrativeContext();
    const statusPart = (() => {
      try {
        const pos = this.bot?.entity?.position;
        const coords = pos ? `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}` : null;
        const dim = (() => {
          try { return this.bot?.game?.dimension ? String(this.bot.game.dimension) : null; } catch { return null; }
        })();
        const hasGoal = !!(this.bot?.pathfinder && this.bot.pathfinder.goal);
        const externalBusy = Boolean(this.state?.externalBusy);
        const afk = Boolean(this.state?.afk?.isAfk);
        const current = String(this.currentAction || '').trim();
        let mode = '空闲';
        if (afk) mode = '挂机';
        else if (externalBusy) mode = '执行任务';
        else if (hasGoal) mode = '移动/导航';
        else if (current) mode = `进行${current}`;

        const parts = [`状态:${mode}`];
        if (dim) parts.push(`维度:${dim}`);
        if (coords) parts.push(`坐标:${coords}`);
        return parts.join(' ');
      } catch {
        return '';
      }
    })();
    const drivePart = (() => {
      try { return this.drive?.buildDriveContext?.() || ''; } catch { return ''; }
    })();

    const parts = [statusPart, identityPart, narrativePart, drivePart].filter(Boolean);
    return parts.join(' | ');
  }

  scoreAction(action, baseValue = 1.0) {
    return this.identity.scoreAction(action, baseValue);
  }

  // M3: Narrative API
  getNarrative() {
    return this.narrative;
  }

  refreshNarrative() {
    return this.narrative.refresh();
  }

  // M4: Introspection API
  triggerIntrospect() {
    return this.identity.introspect();
  }

  getAdaptiveParams() {
    return this.identity.getAdaptiveParams();
  }

  // M5: Drive API
  getDriveEngine() {
    return this.drive;
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
