'use strict';

const { Store } = require('../lib/store');
const { parseQuantity, sum } = require('../lib/util');
const { lineTotal, discountedLine } = require('../lib/pricing');

class InventoryService {
  constructor() {
    this.store = new Store();
    this.orders = [];
  }

  addStock(sku, unitCents, qty) {
    const q = parseQuantity(qty);
    const existing = this.store.get(sku);
    const next = existing ? existing.qty + q : q;
    this.store.put(sku, { sku, unitCents, qty: next });
    return next;
  }

  placeOrder(lines) {
    const total = sum(lines, (l) => lineTotal(l.unitCents, l.qty, l.tier));
    const order = { lines, total, status: 'placed' };
    this.orders.push(order);
    return order;
  }

  placeOrderWithCoupon(lines, couponCents) {
    const total = sum(lines, (l) => discountedLine(l.unitCents, l.qty, l.tier, couponCents));
    const order = { lines, total, status: 'placed' };
    this.orders.push(order);
    return order;
  }

  stockLevel(sku) {
    const rec = this.store.get(sku);
    return rec.qty;
  }

  lowStock(threshold) {
    return this.store.all().filter((r) => r.qty < threshold).map((r) => r.sku);
  }

  applyRestock(sku, qty) {
    const rec = this.store.get(sku);
    rec.qty = rec.qty + qty;
    this.store.put(sku, rec);
    return rec;
  }
}

module.exports = { InventoryService };
