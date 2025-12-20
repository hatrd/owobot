// state-encode.js - SelfState encoding and loss computation
// Converts observer.snapshot() to quantized SelfState for world model

const QUANT = {
  pos: 2,      // position quantum (blocks)
  hp: 5,       // health quantum
  food: 2,     // food quantum
  dist: 4      // distance quantum for entities
};

function quantize(v, q) {
  return Math.round(v / q) * q;
}

function encode(snap) {
  if (!snap) return null;
  const s = {};

  // Position (quantized)
  if (snap.pos) {
    s.x = quantize(snap.pos.x, QUANT.pos);
    s.y = quantize(snap.pos.y, QUANT.pos);
    s.z = quantize(snap.pos.z, QUANT.pos);
  }

  // Vitals (quantized)
  const v = snap.vitals || {};
  s.hp = v.hp != null ? quantize(v.hp, QUANT.hp) : null;
  s.food = v.food != null ? quantize(v.food, QUANT.food) : null;

  // Inventory summary (hash of top items)
  const inv = snap.inv || {};
  s.held = inv.held || null;
  s.invHash = invHash(inv.all || inv.top || []);

  // Environment
  s.dim = snap.dim || 'overworld';
  s.time = snap.time || null;

  // Nearby entities summary
  const nearby = snap.nearby || {};
  s.playersNear = (nearby.players || []).length;
  s.hostilesNear = nearby.hostiles?.count || 0;
  s.nearestHostileDist = nearby.hostiles?.nearest
    ? quantize(nearby.hostiles.nearest.d, QUANT.dist)
    : null;

  // Blocks
  s.blockUnder = snap.blocks?.under || null;

  // Task state
  s.hasTask = snap.task != null;

  return s;
}

function invHash(items) {
  if (!items || !items.length) return 0;
  // Simple hash: sum of (first 3 chars of name * count) mod 1000
  let h = 0;
  for (const it of items.slice(0, 10)) {
    const name = String(it.name || '');
    const c = (name.charCodeAt(0) || 0) + (name.charCodeAt(1) || 0) + (name.charCodeAt(2) || 0);
    h = (h + c * (it.count || 1)) % 10000;
  }
  return h;
}

function stateKey(s) {
  if (!s) return 'null';
  return [
    s.x, s.y, s.z,
    s.hp, s.food,
    s.held, s.invHash,
    s.dim, s.time,
    s.playersNear, s.hostilesNear,
    s.blockUnder, s.hasTask ? 1 : 0
  ].join('|');
}

// Compute loss between predicted and actual state
function loss(predicted, actual) {
  if (!predicted || !actual) return Infinity;
  let err = 0;

  // Position error (Manhattan distance, normalized)
  if (predicted.x != null && actual.x != null) {
    err += Math.abs(predicted.x - actual.x) / QUANT.pos;
    err += Math.abs(predicted.y - actual.y) / QUANT.pos;
    err += Math.abs(predicted.z - actual.z) / QUANT.pos;
  }

  // Vitals error
  if (predicted.hp != null && actual.hp != null) {
    err += Math.abs(predicted.hp - actual.hp) / QUANT.hp;
  }
  if (predicted.food != null && actual.food != null) {
    err += Math.abs(predicted.food - actual.food) / QUANT.food;
  }

  // Inventory change
  if (predicted.invHash !== actual.invHash) err += 1;
  if (predicted.held !== actual.held) err += 0.5;

  // Entity count change
  err += Math.abs((predicted.playersNear || 0) - (actual.playersNear || 0)) * 0.3;
  err += Math.abs((predicted.hostilesNear || 0) - (actual.hostilesNear || 0)) * 0.5;

  // Block under change
  if (predicted.blockUnder !== actual.blockUnder) err += 0.5;

  return err;
}

module.exports = { encode, stateKey, loss, QUANT };
