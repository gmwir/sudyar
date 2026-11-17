/* v2.6 — «خروجی برای استودیو» (DIR-INV-01): a small file for the catalog & price-list studio.
   Pure function, works in the browser and Node 20+. Input: the engine's exportAll() data. Output: a JSON text that the
   catalog studio reads. WHITELIST ONLY — purchase prices, stock, cost layers, customers, documents, payments, audit,
   notes, suppliers and every meta record except priceGroups are never copied. Nothing in the input is modified. */
(function (root) {
  'use strict';
  var FORMAT = 'amiran-yadak-studio-export', VERSION = 1;
  function money(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null; }
  function str(v) { return v == null ? '' : String(v); }
  function build(data, opts) {
    var ids = opts && opts.ids ? opts.ids : null; // v2.6: the exact products of the list on screen (Set of ids)
    opts = opts || {}; data = data || {};
    var catById = {}; (data.categories || []).forEach(function (c) { if (c && c.id) catById[c.id] = c; });
    function inGroup(catId) { if (!opts.groupId) return true; var c = catById[catId], g = 0; while (c && g++ < 32) { if (c.id === opts.groupId) return true; c = catById[c.parentId]; } return false; }
    var products = (data.products || []).filter(function (p) { return p && p.id && (!ids || ids.has(p.id)) && (opts.activeOnly === false || p.active !== false) && inGroup(p.categoryId); }).map(function (p) {
      var prices = {}; if (p.prices && typeof p.prices === 'object') Object.keys(p.prices).forEach(function (k) { var v = money(p.prices[k]); if (v) prices[k] = v; });
      var attrs = {}; if (p.attrs && typeof p.attrs === 'object') Object.keys(p.attrs).forEach(function (k) { var v = p.attrs[k]; if (v != null && typeof v !== 'object') attrs[k] = v; });
      return { id: str(p.id), sku: str(p.sku), name: str(p.name), brand: str(p.brand), model: str(p.model), cars: Array.isArray(p.cars) ? p.cars.map(str) : [],
        categoryId: p.categoryId || null, category: str(p.category), unit: str(p.unit), packSize: Number.isSafeInteger(p.packSize) && p.packSize > 0 ? p.packSize : 1,
        attrs: attrs, sellPrice: money(p.sellPrice), prices: prices, active: p.active !== false, updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : null };
    });
    var used = {}; products.forEach(function (p) { var c = catById[p.categoryId], g = 0; while (c && g++ < 32) { used[c.id] = 1; c = catById[c.parentId]; } });
    var categories = Object.keys(used).map(function (id) { var c = catById[id];
      return { id: str(c.id), name: str(c.name), parentId: c.parentId || null, attrDefs: (c.attrDefs || []).filter(function (d) { return d && d.key; }).map(function (d) { return { key: str(d.key), label: str(d.label) }; }) }; });
    var pg = (data.meta || []).filter(function (m) { return m && m.id === 'priceGroups'; })[0];
    var priceGroups = pg && Array.isArray(pg.v) ? pg.v.filter(function (g) { return g && g.id; }).map(function (g) { return { id: str(g.id), name: str(g.name) }; }) : [];
    return { priceGroups: priceGroups, categories: categories, products: products };
  }
  // -> Promise<string>
  function make(data, opts) {
    opts = opts || {};
    var payload = build(data, opts), json = JSON.stringify(payload), c = root.crypto || (typeof globalThis !== 'undefined' && globalThis.crypto);
    return c.subtle.digest('SHA-256', new TextEncoder().encode(json)).then(function (buf) {
      var hash = Array.prototype.map.call(new Uint8Array(buf), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      return JSON.stringify({ format: FORMAT, version: VERSION, app: opts.app || '', createdAt: Date.now(),
        scope: { groupId: opts.groupId || null, groupPath: opts.groupPath || '', activeOnly: opts.activeOnly !== false },
        counts: { products: payload.products.length, categories: payload.categories.length }, hash: hash, data: payload });
    });
  }
  var api = { FORMAT: FORMAT, VERSION: VERSION, build: build, make: make };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StudioExport = api;
})(typeof self !== 'undefined' ? self : this);
