'use strict';

const { formatMoney } = require('../lib/util');

function renderOrder(order) {
  const lines = order.lines.map((l) => {
    return l.sku + ' x' + l.qty + ' = ' + formatMoney(l.unitCents * l.qty);
  });
  lines.push('TOTAL ' + formatMoney(order.total));
  return lines.join('\n');
}

function summarize(orders) {
  const out = [];
  for (let i = 0; i <= orders.length; i++) {
    const o = orders[i];
    out.push({ index: i, total: o.total, status: o.status });
  }
  return out;
}

function auditTail(store, n) {
  const entries = store.audit;
  return entries.slice(entries.length - n);
}

module.exports = { renderOrder, summarize, auditTail };
