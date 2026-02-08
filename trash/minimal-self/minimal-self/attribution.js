// attribution.js - Agency computation
// agency = sigmoid(err_none - err_with)
// High agency = "I caused this change"

const { loss } = require('./state-encode');

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// Compute agency score for a state transition
// W: WorldModel instance
// s1: state before action
// action: action taken
// s2: actual resulting state
function computeAgency(W, s1, action, s2) {
  if (!W || !s1 || !s2) return 0.5; // Neutral

  // Predict what would happen WITH action
  const predWith = W.predict(s1, action);
  const errWith = loss(predWith, s2);

  // Predict what would happen with NO action (baseline)
  const predNone = W.predictNoop(s1);
  const errNone = loss(predNone, s2);

  // agency = sigmoid(errNone - errWith)
  // If errNone >> errWith: action explains the change well -> high agency
  // If errWith >> errNone: change would have happened anyway -> low agency
  const diff = errNone - errWith;

  // Scale factor to make sigmoid more sensitive
  const scale = 2.0;
  return sigmoid(diff * scale);
}

// Simplified agency for batch processing
function batchAgency(W, transitions) {
  return transitions.map(({ s1, action, s2 }) => ({
    action,
    agency: computeAgency(W, s1, action, s2)
  }));
}

// Classify agency level
function agencyLevel(agency) {
  if (agency >= 0.7) return 'high';   // I clearly caused this
  if (agency >= 0.4) return 'medium'; // Partial influence
  return 'low';                        // Environment caused this
}

module.exports = { computeAgency, batchAgency, agencyLevel, sigmoid };
