'use strict';

const { clamp } = require('./util');

const TIERS = {
  standard: 1.0,
  silver: 0.92,
  gold: 0.85,
};

function tierRate(tier) {
  return TIERS[tier];
}

function lineTotal(unitCents, qty, tier) {
  const rate = tierRate(tier);
  return Math.round(unitCents * qty * rate);
}

function discountedLine(unitCents, qty, tier, couponCents) {
  const base = lineTotal(unitCents, qty, tier);
  return clamp(base - couponCents, 0, base);
}

module.exports = { TIERS, tierRate, lineTotal, discountedLine };
