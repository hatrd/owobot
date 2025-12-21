// narrative.js - Narrative Memory System (M3)
// Three constrained memory types: I-CAN, I-DID, I-OWE
// "Memory is not free-form, but structured around self-identity"

const I_CAN_THRESHOLD = { agency: 0.65, successRate: 0.6, attempts: 5 };
const I_DID_KEEP_DAYS = 30;
const I_OWE_KEEP_DAYS = 7;
const MAX_NARRATIVES = 50;
const MAX_MANUAL_DID = 50;

class NarrativeMemory {
  constructor(state, identityStore) {
    this.state = state;
    this.identity = identityStore;

    // Restore from persisted state (with bounds check)
    const saved = state?.minimalSelf?.narrative || {};
    this.entries = Array.isArray(saved.entries)
      ? saved.entries.slice(0, MAX_NARRATIVES)
      : [];
    this.manualDid = Array.isArray(saved.manualDid)
      ? saved.manualDid.slice(-MAX_MANUAL_DID)
      : [];
    this.lastUpdate = Number.isFinite(saved.lastUpdate) ? saved.lastUpdate : 0;
  }

  // Sanitize text to avoid undefined/null leaking into prompts
  _cleanText(v) {
    if (v == null) return '';
    const s = String(v).trim();
    return (s === 'undefined' || s === 'null') ? '' : s;
  }

  // === M3.1: Memory Types ===

  // I-CAN: Capability memory
  // Generated when: agency > 0.65, successRate > 60%, attempts >= 5
  _generateICanEntries() {
    const profile = this.identity.getSkillProfile();
    const entries = [];

    for (const skill of profile.known) {
      const stats = this.identity.getSkillStats(skill.action);
      if (!stats) continue;

      const meetsAgency = stats.avgAgency >= I_CAN_THRESHOLD.agency;
      const meetsSuccess = (stats.successes / stats.attempts) >= I_CAN_THRESHOLD.successRate;
      const matureEnough = stats.attempts >= I_CAN_THRESHOLD.attempts;

      if (meetsAgency && meetsSuccess && matureEnough) {
        entries.push({
          type: 'I-CAN',
          action: skill.action,
          confidence: Math.round(skill.successRate),
          trend: skill.trend,
          since: stats.firstSeen
        });
      }
    }

    return entries;
  }

  // I-DID: Achievement memory
  // Generated from: fulfilled commitments
  _generateIDidEntries() {
    const commitments = Array.isArray(this.identity?.commitments)
      ? this.identity.commitments
      : [];
    const cutoff = Date.now() - I_DID_KEEP_DAYS * 24 * 60 * 60 * 1000;

    return commitments
      .filter(c => {
        if (!c || !c.fulfilled || !c.fulfilledAt) return false;
        if (c.fulfilledAt <= cutoff) return false;
        return this._cleanText(c.action) && this._cleanText(c.player);
      })
      .map(c => ({
        type: 'I-DID',
        action: this._cleanText(c.action),
        player: this._cleanText(c.player),
        fulfilledAt: c.fulfilledAt
      }));
  }

  // I-OWE: Obligation memory
  // Generated from: pending commitments
  _generateIOweEntries() {
    const pending = this.identity?.getPendingCommitments?.() || [];
    const now = Date.now();

    return pending
      .filter(c => c && this._cleanText(c.action) && this._cleanText(c.player))
      .map(c => {
        const urgency = c.deadline ? Math.max(0, c.deadline - now) / (60 * 60 * 1000) : null;
        return {
          type: 'I-OWE',
          action: this._cleanText(c.action),
          player: this._cleanText(c.player),
          createdAt: c.createdAt,
          deadline: c.deadline,
          urgencyHours: urgency != null ? Math.round(urgency) : null
        };
      });
  }

  // === M3.2-M3.4: Unified Generation ===

  refresh() {
    const iCan = this._generateICanEntries();
    const iDid = this._generateIDidEntries();
    const iOwe = this._generateIOweEntries();
    const manual = Array.isArray(this.manualDid) ? this.manualDid : [];

    this.entries = [...iOwe, ...iCan, ...iDid, ...manual].slice(0, MAX_NARRATIVES);
    this.lastUpdate = Date.now();
    this._persist();

    return this.entries;
  }

  // === M3.5: Context Building ===

  buildNarrativeContext() {
    // Refresh if stale (> 1 minute)
    if (Date.now() - this.lastUpdate > 60000) {
      this.refresh();
    }

    const lines = [];

    // I-OWE first (obligations are urgent)
    const owes = this.entries.filter(e => e.type === 'I-OWE');
    if (owes.length) {
      const oweText = owes.slice(0, 3).map(e => {
        const urgency = e.urgencyHours != null && e.urgencyHours < 24
          ? `(急:${e.urgencyHours}h)`
          : '';
        return `${e.action}→${e.player}${urgency}`;
      }).join(', ');
      lines.push(`我承诺: ${oweText}`);
    }

    // I-CAN (capabilities)
    const cans = this.entries.filter(e => e.type === 'I-CAN');
    if (cans.length) {
      const canText = cans.slice(0, 5).map(e =>
        `${e.action}(${e.confidence}%${e.trend})`
      ).join(', ');
      lines.push(`我能: ${canText}`);
    }

    // I-DID (recent achievements, last 3)
    const dids = this.entries.filter(e => e.type === 'I-DID');
    if (dids.length) {
      const recentDids = dids
        .sort((a, b) => (b.fulfilledAt || 0) - (a.fulfilledAt || 0))
        .slice(0, 3);
      const didText = recentDids.map(e => {
        const ago = this._relativeTime(e.fulfilledAt);
        return `${e.action}→${e.player}(${ago})`;
      }).join(', ');
      lines.push(`我做过: ${didText}`);
    }

    return lines.length ? lines.join(' | ') : '';
  }

  _relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const hours = Math.floor(diff / (60 * 60 * 1000));
    if (hours < 1) return '刚才';
    if (hours < 24) return `${hours}h前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
  }

  // === Query API ===

  getByType(type) {
    return this.entries.filter(e => e.type === type);
  }

  getStats() {
    return {
      total: this.entries.length,
      iCan: this.entries.filter(e => e.type === 'I-CAN').length,
      iDid: this.entries.filter(e => e.type === 'I-DID').length,
      iOwe: this.entries.filter(e => e.type === 'I-OWE').length,
      lastUpdate: this.lastUpdate
    };
  }

  recordDid(action, player = null, note = null) {
    const cleanAction = this._cleanText(action);
    if (!cleanAction) return false;
    const entry = {
      type: 'I-DID',
      action: cleanAction,
      player: this._cleanText(player || ''),
      note: this._cleanText(note || ''),
      fulfilledAt: Date.now(),
      source: 'event'
    };
    if (!Array.isArray(this.manualDid)) this.manualDid = [];
    this.manualDid.push(entry);
    this.manualDid = this.manualDid.slice(-MAX_MANUAL_DID);
    // Merge manual entries into current view
    this.entries = [...this.entries, entry].slice(-MAX_NARRATIVES);
    this.lastUpdate = Date.now();
    this._persist();
    return true;
  }

  // === Persistence ===

  _persist() {
    if (!this.state.minimalSelf) this.state.minimalSelf = {};
    this.state.minimalSelf.narrative = {
      entries: this.entries,
      lastUpdate: this.lastUpdate,
      manualDid: this.manualDid
    };
  }
}

module.exports = { NarrativeMemory, I_CAN_THRESHOLD };
