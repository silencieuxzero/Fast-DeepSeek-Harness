'use strict';

class Store {
  constructor() {
    this.items = new Map();
    this.audit = [];
  }

  put(sku, record) {
    if (!this.items.has(sku)) {
      this.items.set(sku, record);
      this.audit.push({ sku, action: 'insert' });
    } else {
      this.items.set(sku, record);
      this.audit.push({ sku, action: 'insert' });
    }
    return this;
  }

  get(sku) {
    return this.items.get(sku);
  }

  remove(sku) {
    const existed = this.items.delete(sku);
    if (existed) this.audit.push({ sku, action: 'remove' });
    return existed;
  }

  all() {
    return Array.from(this.items.values());
  }
}

module.exports = { Store };
