// identity.js - Identity Store + Policy Scoring (M2)
// "Identity emerges from repeated action patterns, not explicit declaration"

const SKILL_MATURITY_THRESHOLD = 5;  // Attempts needed to consider skill "known"
const IDENTITY_DECAY_RATE = 0.02;    // Per-hour decay to prevent rigidity
const MAX_COMMITMENTS = 20;
const MAX_SKILLS = 100;              // Prevent unbounded growth
const COMMITMENT_EXPIRE_MS = 24 * 60 * 60 * 1000; // 24h default

// M4: Self-Reflection Constants
const INTROSPECT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PARAM_ADJUST_RATE = 0.05;               // Conservative learning rate
const MIN_OUTCOMES_FOR_ADJUST = 10;
const MAX_OUTCOMES = 50;
const DEFAULT_LAMBDA = 0.3;
const DEFAULT_BETA = 0.2;

function clampFinite(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

class IdentityStore {
  constructor(state) {
    this.state = state;

    // Restore from persisted state
    const saved = state.minimalSelf?.identity || {};

    // skills: Map<actionType, SuccessStats>
    this.skills = new Map(saved.skills || []);

    // commitments: Array<Commitment>
    this.commitments = saved.commitments || [];

    // Last decay timestamp
    this.lastDecayAt = saved.lastDecayAt || Date.now();

    // M4: Adaptive parameters and introspection state
    this.adaptiveParams = {
      lambda: clampFinite(saved.adaptiveParams?.lambda, 0.1, 0.5, DEFAULT_LAMBDA),
      beta: clampFinite(saved.adaptiveParams?.beta, 0.1, 0.4, DEFAULT_BETA)
    };
    this.lastIntrospect = saved.lastIntrospect || 0;
    this.recentOutcomes = Array.isArray(saved.recentOutcomes)
      ? saved.recentOutcomes.slice(-MAX_OUTCOMES)
      : [];
  }

  // === M2.1: Skill Statistics ===

  recordSkillOutcome(action, success, agency) {
    if (!action) return;
    const key = String(action).toLowerCase();

    let stats = this.skills.get(key);
    if (!stats) {
      stats = {
        attempts: 0,
        successes: 0,
        failures: 0,
        totalAgency: 0,
        avgAgency: 0.5,
        lastAttempt: 0,
        trend: 0,        // Rolling trend: positive = improving
        firstSeen: Date.now()
      };
    }

    const prevAvg = stats.avgAgency;
    stats.attempts++;
    if (success) {
      stats.successes++;
    } else {
      stats.failures++;
    }

    // Update agency tracking
    const agencyVal = Number.isFinite(agency) ? agency : 0.5;
    stats.totalAgency += agencyVal;
    stats.avgAgency = stats.totalAgency / stats.attempts;

    // Calculate trend (exponential smoothing)
    const newTrend = agencyVal - prevAvg;
    stats.trend = stats.trend * 0.7 + newTrend * 0.3;

    stats.lastAttempt = Date.now();

    this.skills.set(key, stats);
    this._pruneSkills();
    this._persist();
  }

  getSkillStats(action) {
    const key = String(action || '').toLowerCase();
    return this.skills.get(key) || null;
  }

  getSkillProfile() {
    const profile = {
      known: [],      // Mature skills with good success rate
      learning: [],   // Immature skills (< threshold attempts)
      struggling: []  // Mature skills with poor success rate
    };

    for (const [action, stats] of this.skills) {
      const successRate = stats.attempts > 0 ? stats.successes / stats.attempts : 0;
      const entry = {
        action,
        attempts: stats.attempts,
        successRate: Math.round(successRate * 100),
        avgAgency: stats.avgAgency.toFixed(2),
        trend: stats.trend > 0.05 ? '↑' : stats.trend < -0.05 ? '↓' : '→'
      };

      if (stats.attempts < SKILL_MATURITY_THRESHOLD) {
        profile.learning.push(entry);
      } else if (successRate >= 0.6) {
        profile.known.push(entry);
      } else {
        profile.struggling.push(entry);
      }
    }

    // Sort by success rate descending
    profile.known.sort((a, b) => b.successRate - a.successRate);
    profile.struggling.sort((a, b) => a.successRate - b.successRate);

    return profile;
  }

  // === M2.2: Expected Agency ===

  expectedAgency(action) {
    const stats = this.getSkillStats(action);
    if (!stats) return 0.5; // Unknown skill, neutral expectation

    // Weight by maturity
    const maturity = Math.min(stats.attempts / SKILL_MATURITY_THRESHOLD, 1);

    // Blend historical average with trend
    const predicted = stats.avgAgency + stats.trend * 0.5;

    // Uncertain for immature skills, confident for mature ones
    const raw = 0.5 + (predicted - 0.5) * maturity;

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, raw));
  }

  // === M2.3: Commitment System ===

  addCommitment(player, action, deadline = null) {
    const commitment = {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      player: String(player),
      action: String(action),
      createdAt: Date.now(),
      deadline: deadline || (Date.now() + COMMITMENT_EXPIRE_MS),
      fulfilled: false,
      fulfilledAt: null
    };

    this.commitments.push(commitment);

    // Prune old commitments
    this._pruneCommitments();
    this._persist();

    return commitment;
  }

  fulfillCommitment(id) {
    const c = this.commitments.find(x => x.id === id);
    if (!c || c.fulfilled) return false;

    c.fulfilled = true;
    c.fulfilledAt = Date.now();
    this._persist();
    return true;
  }

  failCommitment(id, reason = null) {
    const c = this.commitments.find(x => x.id === id);
    if (!c || c.fulfilled || c.failed) return false;

    c.failed = true;
    c.failedAt = Date.now();
    c.failReason = reason;
    this._persist();
    return true;
  }

  getPendingCommitments(player = null) {
    const now = Date.now();
    return this.commitments.filter(c => {
      if (c.fulfilled || c.failed) return false;
      if (c.deadline && now > c.deadline) return false;
      if (player && c.player !== player) return false;
      return true;
    });
  }

  getCommitmentStats() {
    const total = this.commitments.length;
    const fulfilled = this.commitments.filter(c => c.fulfilled).length;
    const failed = this.commitments.filter(c => c.failed).length;
    const pending = this.getPendingCommitments().length;

    return {
      total,
      fulfilled,
      failed,
      pending,
      reliabilityRate: total > 0 ? fulfilled / total : 1
    };
  }

  // === M2.4: Identity Penalty ===

  identityPenalty(action) {
    const stats = this.getSkillStats(action);

    // Unknown skill: low penalty (encourage exploration)
    if (!stats) return 0.1;

    const maturity = Math.min(stats.attempts / SKILL_MATURITY_THRESHOLD, 1);
    const successRate = stats.attempts > 0 ? stats.successes / stats.attempts : 0.5;

    // Immature skill: low penalty (still learning)
    if (maturity < 1) {
      return 0.1 * (1 - maturity);
    }

    // Mature skill with good track record: low penalty
    if (successRate >= 0.6) {
      return 0.05;
    }

    // Mature skill with poor track record: high penalty
    // But apply decay based on time since last attempt
    const timeSinceLast = Date.now() - (stats.lastAttempt || 0);
    const hoursSince = timeSinceLast / (60 * 60 * 1000);
    const decay = Math.exp(-IDENTITY_DECAY_RATE * hoursSince);

    // Base penalty scaled by failure rate and decayed over time
    const basePenalty = (1 - successRate) * 0.8;
    return basePenalty * decay;
  }

  // === M2.5: Policy Scoring ===

  scoreAction(action, baseValue = 1.0, lambda = null, beta = null) {
    const safeBaseValue = Number.isFinite(baseValue) ? baseValue : 1.0;
    const effectiveLambda = clampFinite(
      lambda ?? this.adaptiveParams.lambda, 0.1, 0.5, DEFAULT_LAMBDA
    );
    const effectiveBeta = clampFinite(
      beta ?? this.adaptiveParams.beta, 0.1, 0.4, DEFAULT_BETA
    );

    const penalty = this.identityPenalty(action);
    const agency = this.expectedAgency(action);

    // Check pending commitments related to this action
    const pending = this.getPendingCommitments();
    const actionStr = String(action || '');
    const actionLower = actionStr.toLowerCase();
    const hasRelatedCommitment = pending.some(c =>
      c.action.toLowerCase() === actionLower
    );

    // Bonus for fulfilling commitments
    const commitmentBonus = hasRelatedCommitment ? 0.3 : 0;

    // Score(a) = Value(a) - λ·IdentityPenalty(a) + β·ExpectedAgency(a) + commitmentBonus
    const score = safeBaseValue - effectiveLambda * penalty + effectiveBeta * agency + commitmentBonus;

    return {
      action: actionStr,
      score,
      components: {
        baseValue: safeBaseValue,
        penalty: -effectiveLambda * penalty,
        agency: effectiveBeta * agency,
        commitment: commitmentBonus
      }
    };
  }

  // === Context for AI ===

  buildIdentityContext() {
    const profile = this.getSkillProfile();
    const commitStats = this.getCommitmentStats();
    const pending = this.getPendingCommitments();

    const lines = [];

    // Capability summary
    if (profile.known.length) {
      const top = profile.known.slice(0, 5).map(s =>
        `${s.action}(${s.successRate}%${s.trend})`
      ).join(', ');
      lines.push(`擅长: ${top}`);
    }

    if (profile.struggling.length) {
      const warn = profile.struggling.slice(0, 3).map(s =>
        `${s.action}(${s.successRate}%)`
      ).join(', ');
      lines.push(`需谨慎: ${warn}`);
    }

    if (profile.learning.length) {
      const learn = profile.learning.slice(0, 3).map(s => s.action).join(', ');
      lines.push(`学习中: ${learn}`);
    }

    // Reliability
    if (commitStats.total >= 3) {
      const rel = Math.round(commitStats.reliabilityRate * 100);
      lines.push(`承诺兑现率: ${rel}%`);
    }

    // Pending commitments
    if (pending.length) {
      const plist = pending.slice(0, 3).map(c =>
        `${c.action}→${c.player}`
      ).join(', ');
      lines.push(`待完成承诺: ${plist}`);
    }

    return lines.length ? '身份画像: ' + lines.join(' | ') : '';
  }

  // === M4: Self-Reflection ===

  recordDecisionOutcome(action, predictedScore, actualSuccess) {
    if (!action) return;
    this.recentOutcomes.push({
      action: String(action).toLowerCase(),
      predictedScore: Number.isFinite(predictedScore) ? predictedScore : 0.5,
      actualSuccess: Boolean(actualSuccess),
      timestamp: Date.now()
    });
    if (this.recentOutcomes.length > MAX_OUTCOMES) {
      this.recentOutcomes.shift();
    }
    this._persist();
  }

  introspect() {
    const now = Date.now();
    if (now - this.lastIntrospect < INTROSPECT_INTERVAL_MS) return null;
    if (this.recentOutcomes.length < MIN_OUTCOMES_FOR_ADJUST) return null;

    const analysis = this._analyzePerformance();
    const adjustments = this._computeAdjustments(analysis);

    // Apply bounded adjustments
    this.adaptiveParams.lambda = clampFinite(
      this.adaptiveParams.lambda + adjustments.deltaLambda,
      0.1, 0.5, DEFAULT_LAMBDA
    );
    this.adaptiveParams.beta = clampFinite(
      this.adaptiveParams.beta + adjustments.deltaBeta,
      0.1, 0.4, DEFAULT_BETA
    );

    this.lastIntrospect = now;
    this._persist();

    return { analysis, adjustments, params: { ...this.adaptiveParams } };
  }

  _analyzePerformance() {
    const outcomes = this.recentOutcomes.filter(o => Number.isFinite(o?.predictedScore));
    const sorted = outcomes.slice().sort((a, b) => a.predictedScore - b.predictedScore);
    const bandSize = Math.max(1, Math.floor(sorted.length * 0.3));
    const lowScore = sorted.slice(0, bandSize);
    const highScore = sorted.slice(-bandSize);

    const calcRate = arr => arr.length > 0
      ? arr.filter(o => o.actualSuccess).length / arr.length
      : null;

    return {
      totalOutcomes: outcomes.length,
      highScoreSuccessRate: calcRate(highScore),
      lowScoreSuccessRate: calcRate(lowScore),
      overallSuccessRate: calcRate(outcomes)
    };
  }

  _computeAdjustments(analysis) {
    let deltaLambda = 0;
    let deltaBeta = 0;

    // High-score actions failing often → too optimistic → increase penalty
    if (analysis.highScoreSuccessRate !== null) {
      if (analysis.highScoreSuccessRate < 0.6) {
        deltaLambda += PARAM_ADJUST_RATE;
      } else if (analysis.highScoreSuccessRate > 0.85) {
        deltaLambda += -PARAM_ADJUST_RATE * 0.5;
      }
    }

    // Low-score actions succeeding often → too cautious → decrease penalty
    if (analysis.lowScoreSuccessRate !== null && analysis.lowScoreSuccessRate > 0.5) {
      deltaLambda += -PARAM_ADJUST_RATE;
    }

    // Adjust beta based on overall success stability (subtle)
    if (analysis.overallSuccessRate !== null) {
      const deviation = Math.abs(analysis.overallSuccessRate - 0.7);
      if (deviation > 0.2) {
        deltaBeta += deviation > 0.3 ? PARAM_ADJUST_RATE * 0.5 : 0;
      }
    }

    return { deltaLambda, deltaBeta };
  }

  getAdaptiveParams() {
    return { ...this.adaptiveParams };
  }

  // === Internal ===

  _pruneSkills() {
    if (this.skills.size <= MAX_SKILLS) return;
    // Remove least recently used skills
    const entries = Array.from(this.skills.entries());
    entries.sort((a, b) => (a[1].lastAttempt || 0) - (b[1].lastAttempt || 0));
    const toRemove = entries.slice(0, this.skills.size - MAX_SKILLS);
    for (const [key] of toRemove) {
      this.skills.delete(key);
    }
  }

  _pruneCommitments() {
    const now = Date.now();
    // Keep recent 30 days of history, remove old fulfilled/failed
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    this.commitments = this.commitments.filter(c => {
      if (c.fulfilled || c.failed) {
        return (c.fulfilledAt || c.failedAt || c.createdAt) > cutoff;
      }
      return true;
    }).slice(-MAX_COMMITMENTS);
  }

  _applyDecay() {
    const now = Date.now();
    const hoursSinceDecay = (now - this.lastDecayAt) / (60 * 60 * 1000);

    if (hoursSinceDecay < 1) return; // Decay once per hour max

    // Decay trend values toward zero (prevents stale trends)
    for (const [key, stats] of this.skills) {
      stats.trend *= Math.exp(-0.1 * hoursSinceDecay);
    }

    this.lastDecayAt = now;
  }

  _persist() {
    if (!this.state.minimalSelf) this.state.minimalSelf = {};
    this.state.minimalSelf.identity = {
      skills: Array.from(this.skills.entries()),
      commitments: this.commitments,
      lastDecayAt: this.lastDecayAt,
      // M4: Persist adaptive state
      adaptiveParams: this.adaptiveParams,
      lastIntrospect: this.lastIntrospect,
      recentOutcomes: this.recentOutcomes
    };
  }

  getStats() {
    return {
      skillsTracked: this.skills.size,
      commitments: this.getCommitmentStats(),
      profile: this.getSkillProfile(),
      // M4: Include adaptive params
      adaptiveParams: { ...this.adaptiveParams },
      recentOutcomesCount: this.recentOutcomes.length
    };
  }
}

module.exports = { IdentityStore };
