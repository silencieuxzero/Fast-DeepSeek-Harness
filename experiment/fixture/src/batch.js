'use strict';

const { InventoryService } = require('./service');
const { renderOrder } = require('./report');

function runBatch(records) {
  const svc = new InventoryService();
  for (const r of records) {
    if (r.kind === 'stock') {
      svc.addStock(r.sku, r.unitCents, r.qty);
    } else if (r.kind === 'order') {
      svc.placeOrder(r.lines);
    }
  }
  return svc.orders.map(renderOrder);
}

function tierTotals(lines) {
  const byTier = new Map();
  for (const l of lines) {
    const prev = byTier.get(l.tier);
    byTier.set(l.tier, (prev || 0) + l.qty);
  }
  return byTier;
}

module.exports = { runBatch, tierTotals };
