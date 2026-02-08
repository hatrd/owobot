// drive.js - M5: Internal Drive System (Intrinsic Drive)
// "Boredom and curiosity are two expressions of the same force - dissatisfaction with information entropy"

const MIN_COOLDOWN = 180000;    // 3 min (was 2)
const MAX_COOLDOWN = 5400000;   // 90 min
const MIN_GLOBAL_TRIGGER_GAP = 45000; // 45s between any triggers

const BOREDOM_RATE = 0.0014;     // slower accumulation
const CURIOSITY_SPIKE = 0.2;     // slightly lower spike
const EXISTENTIAL_RATE = 0.0008; // slower
const SOCIAL_RATE = 0.0024;      // slower social buildup
const DECAY_RATE = 0.0012;       // slightly faster decay to bleed off levels

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampFinite(x, lo, hi, fallback) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function defaultDriveState() {
  return {
    curiosity: { level: 0.0, threshold: 0.6, lastTrigger: null, cooldown: 420000 },   // 7min CD
    boredom: { level: 0.0, threshold: 0.5, lastTrigger: null, cooldown: 720000 },     // 12min CD
    existential: { level: 0.0, threshold: 0.7, lastTrigger: null, cooldown: 1500000 }, // 25min CD
    social: { level: 0.0, threshold: 0.45, lastTrigger: null, cooldown: 270000 }        // 4.5min CD
  };
}

function ensureDriveState(root) {
  if (!root.drives || typeof root.drives !== 'object') {
    root.drives = defaultDriveState();
  } else {
    const d = root.drives;
    for (const [k, def] of Object.entries(defaultDriveState())) {
      if (!d[k] || typeof d[k] !== 'object') d[k] = { ...def };
      if (!Number.isFinite(Number(d[k].level))) d[k].level = def.level;
      if (!Number.isFinite(Number(d[k].threshold))) d[k].threshold = def.threshold;
      if (!Number.isFinite(Number(d[k].cooldown))) d[k].cooldown = def.cooldown;
      if (d[k].lastTrigger != null && !Number.isFinite(Number(d[k].lastTrigger))) d[k].lastTrigger = null;
    }
  }
  if (!Number.isFinite(Number(root.lastTickAt))) root.lastTickAt = 0;
  if (!Number.isFinite(Number(root.lastAnyTriggerAt))) root.lastAnyTriggerAt = 0;
  if (!Number.isFinite(Number(root.lastFeedbackAt))) root.lastFeedbackAt = 0;
  if (!Array.isArray(root._processedWindows)) root._processedWindows = [];
  if (!root._seen || typeof root._seen !== 'object') root._seen = {};
  if (!Array.isArray(root._seen.nearPlayers)) root._seen.nearPlayers = [];
  return root.drives;
}

function timeSinceLastPlayerChatSec(state, nowTs) {
  try {
    const recent = Array.isArray(state.aiRecent) ? state.aiRecent : [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      if (!e || typeof e !== 'object') continue;
      if (e.kind !== 'player') continue;
      if (!Number.isFinite(Number(e.t))) continue;
      return Math.max(0, (nowTs - e.t) / 1000);
    }
  } catch {}
  return Infinity;
}

function getLastPlayerSpeaker(state) {
  try {
    const recent = Array.isArray(state.aiRecent) ? state.aiRecent : [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      if (!e || typeof e !== 'object') continue;
      if (e.kind !== 'player') continue;
      const user = String(e.user || '').trim();
      if (user) return user;
    }
  } catch {}
  return null;
}

function extractDriveSignal(record) {
  try {
    const sigs = Array.isArray(record?.signals) ? record.signals : [];
    const types = new Set(sigs.map(s => String(s?.type || '').toUpperCase()).filter(Boolean));
    if (types.has('FRUSTRATION')) return 'FRUSTRATION';
    if (types.has('IGNORE')) return 'IGNORE';
    if (record?.isPositive) return 'POSITIVE';
    if (record?.isNegative) return 'NEGATIVE';
  } catch {}
  return 'NEUTRAL';
}

class DriveEngine {
  constructor({ state, now = () => Date.now() } = {}) {
    this.state = state;
    this.now = now;

    if (!state.minimalSelf) state.minimalSelf = {};
    if (!state.minimalSelf.drive || typeof state.minimalSelf.drive !== 'object') {
      state.minimalSelf.drive = {};
    }

    this.root = state.minimalSelf.drive;
    this.drives = ensureDriveState(this.root);
  }

  getState() {
    const d = this.drives;
    return {
      curiosity: clamp01(d.curiosity.level),
      boredom: clamp01(d.boredom.level),
      existential: clamp01(d.existential.level),
      social: clamp01(d.social.level)
    };
  }

  getDominantDrive() {
    const d = this.drives;
    let best = { type: null, level: 0, triggered: false, ratio: 0 };
    for (const [type, rec] of Object.entries(d)) {
      const level = clamp01(rec.level);
      const threshold = clampFinite(rec.threshold, 0.2, 0.98, 0.7);
      const ratio = threshold > 0 ? level / threshold : 0;
      if (ratio > best.ratio) best = { type, level, triggered: level >= threshold, ratio };
    }
    return best;
  }

  buildDriveContext() {
    try {
      const d = this.drives;
      const fmt = (k) => {
        const level = clamp01(d[k].level).toFixed(2);
        const thr = clampFinite(d[k].threshold, 0.2, 0.98, 0.7).toFixed(2);
        return `${k}=${level}/${thr}`;
      };
      const dom = this.getDominantDrive();
      const parts = [fmt('curiosity'), fmt('boredom'), fmt('existential'), fmt('social')];
      return `驱动力: ${parts.join(', ')} | dominant=${dom.type || 'none'}`;
    } catch {
      return '';
    }
  }

  _identityConfidence(identityStats) {
    try {
      const profile = identityStats?.profile || {};
      const known = Array.isArray(profile.known) ? profile.known.length : 0;
      const learning = Array.isArray(profile.learning) ? profile.learning.length : 0;
      const struggling = Array.isArray(profile.struggling) ? profile.struggling.length : 0;
      const rel = Number(identityStats?.commitments?.reliabilityRate);
      const reliability = Number.isFinite(rel) ? rel : 1;
      const raw = 0.15 + 0.10 * known + 0.04 * learning - 0.03 * struggling + 0.20 * (reliability - 0.5);
      return clamp01(raw);
    } catch {
      return 0.5;
    }
  }

  accumulateDrives(dtSec, context = {}) {
    const dt = Number(dtSec);
    if (!Number.isFinite(dt) || dt <= 0) return;

    const nowTs = this.now();
    const identityConfidence = this._identityConfidence(context.identityStats);
    const timeSinceChat = timeSinceLastPlayerChatSec(this.state, nowTs);
    const nearPlayers = Array.isArray(context?.snapshot?.nearby?.players)
      ? context.snapshot.nearby.players
      : [];
    const nearbyCount = nearPlayers.length;

    // Fallback: server online players for social drive
    const onlinePlayers = Array.isArray(context.onlinePlayers) ? context.onlinePlayers : [];
    const hasOnline = onlinePlayers.length > 0;

    // Active chat detection: strong trigger condition
    const hasActiveChat = timeSinceChat < 60;    // Player chatted within 1min
    const hasRecentChat = timeSinceChat < 300;   // Player chatted within 5min

    // Activity proxy: recent chat reduces boredom/social accumulation
    const recentChatFactor = timeSinceChat === Infinity ? 1 : clamp01(timeSinceChat / 120);
    const recentActivity = 1 - recentChatFactor;

    // Busy factor: reduce accumulation when actively executing tasks
    const pending = Array.isArray(context.pendingCommitments) ? context.pendingCommitments : [];
    const hasPathfinderGoal = Boolean(context.hasPathfinderGoal);
    const hasPendingCommitments = pending.length > 0;
    const isBusy = Boolean(context.currentAction) || Boolean(context.externalBusy) || hasPathfinderGoal || hasPendingCommitments;
    const busyFactor = isBusy ? 0 : 1.0;

    // Gentle decay to avoid saturation (using DECAY_RATE constant)
    const decay = Math.exp(-DECAY_RATE * dt);
    for (const rec of Object.values(this.drives)) {
      rec.level = clamp01(Number(rec.level) * decay);
    }

    // Boredom: grows when no interactions (suppressed when busy)
    this.drives.boredom.level = clamp01(
      this.drives.boredom.level + dt * BOREDOM_RATE * (1 - recentActivity) * busyFactor
    );

    // Existential: grows when identity confidence is low
    this.drives.existential.level = clamp01(
      this.drives.existential.level + dt * EXISTENTIAL_RATE * (1 - identityConfidence)
    );

    // Social: tiered accumulation based on chat activity (suppressed when busy)
    // Active chat = strongest trigger (player is talking to bot NOW)
    if (hasActiveChat) {
      // 5x rate when player actively chatting - this is the "very strong trigger"
      this.drives.social.level = clamp01(this.drives.social.level + dt * SOCIAL_RATE * 5 * busyFactor);
    } else if (hasRecentChat && (nearbyCount > 0 || hasOnline)) {
      // 2x rate when recent chat + players available
      this.drives.social.level = clamp01(this.drives.social.level + dt * SOCIAL_RATE * 2 * busyFactor);
    } else if ((nearbyCount > 0 || hasOnline) && timeSinceChat > 30) {
      // Normal rate: players exist but no recent chat
      this.drives.social.level = clamp01(this.drives.social.level + dt * SOCIAL_RATE * busyFactor);
    }

    // Curiosity: spikes on new nearby players
    try {
      const prev = new Set((this.root._seen?.nearPlayers || []).map(String));
      const current = new Set(nearPlayers.map(p => String(p?.name || '')).filter(Boolean));
      let newCount = 0;
      for (const n of current) {
        if (!prev.has(n)) newCount += 1;
      }
      if (newCount > 0) {
        this.drives.curiosity.level = clamp01(
          this.drives.curiosity.level + CURIOSITY_SPIKE * newCount
        );
      }
      this.root._seen.nearPlayers = [...current].slice(0, 20);
    } catch {}
  }

  _cooldownReady(type, nowTs) {
    const d = this.drives[type];
    if (!d) return false;
    const last = d.lastTrigger;
    const cd = clampFinite(d.cooldown, MIN_COOLDOWN, MAX_COOLDOWN, 600000);
    if (last == null) return true;
    return (nowTs - Number(last)) >= cd;
  }

  checkTriggers(context = {}) {
    const nowTs = this.now();
    const gatingBusy = Boolean(context.currentAction) || Boolean(context.externalBusy);
    if (gatingBusy) return null;

    // Gate on active pathfinder goal (movement in progress)
    if (context.hasPathfinderGoal) return null;

    // Gate on recent pending commitments (within 5 minutes of creation)
    const pending = Array.isArray(context.pendingCommitments) ? context.pendingCommitments : [];
    const recentCommitmentCutoff = nowTs - 5 * 60 * 1000;
    const hasRecentCommitment = pending.some(c => c.createdAt && c.createdAt > recentCommitmentCutoff);
    if (hasRecentCommitment) return null;

    // Global trigger gap: prevent rapid-fire triggers
    const lastAny = this.root.lastAnyTriggerAt || 0;
    if ((nowTs - lastAny) < MIN_GLOBAL_TRIGGER_GAP) return null;

    const snap = context.snapshot || null;
    const nearPlayers = Array.isArray(snap?.nearby?.players) ? snap.nearby.players : [];
    const hasNearby = nearPlayers.length > 0;

    // Fallback: use server online players if no nearby players
    const onlinePlayers = Array.isArray(context.onlinePlayers) ? context.onlinePlayers : [];
    const hasOnline = onlinePlayers.length > 0;

    const lastSpeaker = getLastPlayerSpeaker(this.state);
    const timeSinceChat = timeSinceLastPlayerChatSec(this.state, nowTs);
    const hasRecentSpeaker = Boolean(lastSpeaker) && timeSinceChat < 10 * 60;

    // Active chat: player chatted within 60s - strong trigger condition
    const hasActiveChat = Boolean(lastSpeaker) && timeSinceChat < 60;

    // Relaxed condition: trigger if ANY of these is true:
    // 1. Players nearby (16 blocks)
    // 2. Recent speaker within 10 minutes
    // 3. Server has online players (fallback for survival servers)
    if (!hasNearby && !hasRecentSpeaker && !hasOnline) return null;

    let best = null;
    for (const [type, rec] of Object.entries(this.drives)) {
      const level = clamp01(rec.level);
      let threshold = clampFinite(rec.threshold, 0.2, 0.98, 0.7);

      // Active chat lowers threshold by 30% for social drive only
      if (hasActiveChat && type === 'social') threshold *= 0.7;

      if (level < threshold) continue;
      if (!this._cooldownReady(type, nowTs)) continue;
      const ratio = threshold > 0 ? level / threshold : 0;
      if (!best || ratio > best.ratio) best = { type, level, threshold, ratio };
    }
    return best;
  }

  generateQuestion(driveType, identityContext = '', context = {}) {
    return '';
    const type = String(driveType || '').toLowerCase();
    const who = (() => {
      try {
        const lastSpeaker = getLastPlayerSpeaker(this.state);
        if (lastSpeaker) return lastSpeaker;
        const snapPlayers = Array.isArray(context?.snapshot?.nearby?.players) ? context.snapshot.nearby.players : [];
        if (snapPlayers.length) return String(snapPlayers[0]?.name || '').trim();
      } catch {}
      return '';
    })();

    // Do not leak identity/narrative context into public drive utterances
    if (type === 'boredom') return '有人在吗？找点事做~';
    if (type === 'curiosity') return `最近发生了什么新鲜事？想去看看${who ? `，${who}` : ''}在忙啥~`;
    if (type === 'social') return `嗨${who ? `，${who}` : ''}，要不要一起做点事？`;
    if (type === 'existential') return '我做得还好吗？有什么建议给我？';
    return '';
  }

  handleFeedback({ driveType, signalType }) {
    const type = String(driveType || '').toLowerCase();
    const sig = String(signalType || '').toUpperCase();
    const d = this.drives[type];
    if (!d) return;

    if (sig === 'IGNORE') {
      d.threshold = clampFinite(d.threshold * 1.2, 0.2, 0.98, d.threshold);
      d.cooldown = clampFinite(d.cooldown * 1.5, MIN_COOLDOWN, MAX_COOLDOWN, d.cooldown);
      return;
    }

    if (sig === 'POSITIVE') {
      d.threshold = clampFinite(Math.max(0.4, d.threshold * 0.9), 0.2, 0.98, d.threshold);
      d.cooldown = clampFinite(Math.max(MIN_COOLDOWN, d.cooldown * 0.8), MIN_COOLDOWN, MAX_COOLDOWN, d.cooldown);
      return;
    }

    if (sig === 'FRUSTRATION' || sig === 'NEGATIVE') {
      d.threshold = clampFinite(Math.min(0.95, d.threshold * 1.35), 0.2, 0.98, d.threshold);
      d.cooldown = clampFinite(d.cooldown * 1.8, MIN_COOLDOWN, MAX_COOLDOWN, d.cooldown);
    }

    this.root.lastFeedbackAt = this.now();
  }

  _applyFeedbackFromRefs() {
    try {
      const recent = Array.isArray(this.state.aiFeedback?.recentSignals)
        ? this.state.aiFeedback.recentSignals
        : [];

      // Use windowId set for deduplication (more robust than timestamp)
      if (!this.root._processedWindows) this.root._processedWindows = [];
      const processed = new Set(this.root._processedWindows);
      const newProcessed = [];

      for (const rec of recent) {
        const windowId = rec?.windowId;
        if (!windowId || processed.has(windowId)) continue;

        const toolUsed = String(rec?.toolUsed || '');
        if (!toolUsed.startsWith('drive:')) continue;

        const driveType = toolUsed.slice('drive:'.length).trim();
        const signalType = extractDriveSignal(rec);
        this.handleFeedback({ driveType, signalType });
        newProcessed.push(windowId);
      }

      // Keep last 100 processed window IDs
      if (newProcessed.length) {
        this.root._processedWindows = [...processed, ...newProcessed].slice(-100);
      }
    } catch {}
  }

  tick(dtSec, context = {}) {
    const nowTs = this.now();
    const dt = Number.isFinite(Number(dtSec)) ? Number(dtSec) : 0;
    if (dt <= 0) {
      this.root.lastTickAt = nowTs;
      return null;
    }

    this._applyFeedbackFromRefs();
    this.accumulateDrives(dt, context);

    const trig = this.checkTriggers(context);
    if (!trig) {
      this.root.lastTickAt = nowTs;
      return null;
    }

    const type = trig.type;
    const message = this.generateQuestion(type, context.identityContext || '', context);
    const snap = context.snapshot || null;
    const nearPlayers = Array.isArray(snap?.nearby?.players) ? snap.nearby.players : [];
    const targetUser =
      getLastPlayerSpeaker(this.state) ||
      (nearPlayers.length ? String(nearPlayers[0]?.name || '') : null) ||
      null;

    this.drives[type].lastTrigger = nowTs;
    this.root.lastAnyTriggerAt = nowTs;
    // Lower level after triggering to avoid immediate re-trigger
    this.drives[type].level = clamp01(this.drives[type].level * 0.35);
    this.root.lastTickAt = nowTs;

    return { type, message, targetUser, t: nowTs };
  }

  getStats() {
    return {
      drives: this.getState(),
      dominant: this.getDominantDrive(),
      lastTickAt: this.root.lastTickAt,
      lastFeedbackAt: this.root.lastFeedbackAt
    };
  }
}

module.exports = { DriveEngine };
