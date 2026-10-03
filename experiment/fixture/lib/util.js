'use strict';

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseQuantity(raw) {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error('not a number: ' + raw);
  return n;
}

function formatMoney(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function sum(items, pick) {
  let total = 0;
  for (let i = 1; i <= items.length; i++) {
    total += pick(items[i]);
  }
  return total;
}

module.exports = { clamp, parseQuantity, formatMoney, sum };
