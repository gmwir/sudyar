/* IndexedDB storage adapter for the core engine.
   - One object store per engine store (keyPath 'id') + 'snapshots' (local safety copies).
   - commit(changes): writes every changed record of one engine operation in ONE readwrite
     transaction; resolves only after the transaction completes (data is on disk).
   - run(fn): executes an engine operation, persists it, and on any storage failure calls
     engine.revert(changes) so memory and disk never disagree. Operations are serialized. */
(function (root) {
  'use strict';
  var DB_NAME = 'amiran-yadak-inventory';
  var DB_VERSION = 2; // v2: + categories, suppliers, audit object stores (existing data untouched)
  /* v2.5: the engine stores 'deals' and 'ledger' are kept INSIDE the existing 'meta' object store under the id prefixes below.
     So the IndexedDB version does not change and an older app version (rollback) still opens the same phone data: it simply
     does not see these records and keeps them untouched (they are in its backups, too, and come back on the next update). */
  var PHYS = { deals: 'x.deals.', ledger: 'x.ledger.', quotes: 'x.quotes.' }; // v2.8: + quotes (proforma)
  function pfxOf(id) { for (var s in PHYS) if (typeof id === 'string' && id.indexOf(PHYS[s]) === 0) return s; return null; }
  function toLogical(data) { // physical rows -> engine stores (also accepts backups made by an older app after a rollback)
    var out = {}; Object.keys(data || {}).forEach(function (k) { out[k] = (data[k] || []).slice(); }); Object.keys(PHYS).forEach(function (s) { out[s] = out[s] || []; });
    out.meta = (out.meta || []).filter(function (r) { var s = r && pfxOf(r.id); if (!s) return true; out[s].push(Object.assign({}, r, { id: r.id.slice(PHYS[s].length) })); return false; });
    return out;
  }
  function physOf(store, rec) { return PHYS[store] ? { store: 'meta', rec: Object.assign({}, rec, { id: PHYS[store] + rec.id }) } : { store: store, rec: rec }; }
  var SNAP = 'snapshots';

  function req2p(r) {
    return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; });
  }
  function tx2p(t) {
    return new Promise(function (res, rej) {
      t.oncomplete = function () { res(); };
      t.onerror = function () { rej(t.error || new Error('IDB transaction error')); };
      t.onabort = function () { rej(t.error || new Error('IDB transaction aborted')); };
    });
  }

  function createStore(engine, opts) {
    opts = opts || {};
    var name = opts.name || DB_NAME;
    var stores = engine.STORES.filter(function (s) { return !PHYS[s]; }); // physical object stores
    var db = null, queue = Promise.resolve(), listeners = [];
    var chan = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('ay-inventory') : null;

    function open() {
      if (typeof indexedDB === 'undefined') return Promise.reject(new Error('NO_IDB'));
      return new Promise(function (res, rej) {
        var r = indexedDB.open(name, DB_VERSION);
        r.onupgradeneeded = function () {
          var d = r.result;
          stores.forEach(function (s) { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); });
          if (!d.objectStoreNames.contains(SNAP)) d.createObjectStore(SNAP, { keyPath: 'id' });
        };
        r.onsuccess = function () {
          if (blockedT) clearTimeout(blockedT);
          db = r.result;
          db.onversionchange = function () { db.close(); emit({ type: 'closed' }); };
          res(db);
        };
        r.onerror = function () { rej(r.error); };
        var blockedT = null;
        r.onblocked = function () { blockedT = setTimeout(function () { rej(new Error('IDB_BLOCKED')); }, 8000); }; // another window still has the old version open
      });
    }
    function readAll() {
      var t = db.transaction(stores, 'readonly'), out = {};
      return Promise.all(stores.map(function (s) {
        return req2p(t.objectStore(s).getAll()).then(function (rows) { out[s] = rows; });
      })).then(function () { return toLogical(out); });
    }
    function load() { return readAll().then(function (data) { engine.load(data); return data; }); }
    function schemaOf(data) { var m = (data.meta || []).filter(function (x) { return x.id === 'schema'; })[0]; return m && m.v && m.v.v || 1; }

    /* Optimistic concurrency: inside the SAME transaction each record is read first and written only if
       its stored revision equals the revision this engine started from. If another window/tab changed it
       meanwhile, the whole transaction aborts (nothing is written) and the caller reloads fresh data. */
    function commit(changes) {
      if (!changes || !changes.length) return Promise.resolve();
      // a batch may touch the same record several times: expect its state BEFORE the batch, write its FINAL state
      var byKey = {}, order = [];
      changes.forEach(function (c) {
        var k = c.store + '\u0000' + c.rec.id;
        if (!byKey[k]) { byKey[k] = { store: c.store, rec: c.rec, prev: c.prev, deleted: !!c.deleted }; order.push(k); }
        else { byKey[k].rec = c.rec; byKey[k].deleted = !!c.deleted; }
      });
      changes = order.map(function (k) { var c = byKey[k], p = physOf(c.store, c.rec); return { store: p.store, rec: p.rec, prev: c.prev, deleted: c.deleted }; });
      var names = []; changes.forEach(function (c) { if (names.indexOf(c.store) < 0) names.push(c.store); });
      var t = db.transaction(names, 'readwrite'), conflict = null;
      var done = tx2p(t).catch(function (e) {
        if (conflict) { var err = new Error('CONFLICT'); err.code = 'CONFLICT'; err.conflict = conflict; throw err; }
        throw e;
      });
      try {
        changes.forEach(function (c) {
          var os = t.objectStore(c.store), r = os.get(c.rec.id);
          r.onsuccess = function () {
            if (conflict) return;
            var cur = r.result, exp = c.prev;
            var same = (!cur && !exp) || (cur && exp && (cur.rev || 0) === (exp.rev || 0));
            if (!same) { conflict = { store: c.store, id: c.rec.id }; try { t.abort(); } catch (_) { /* ignore */ } return; }
            if (c.deleted) os.delete(c.rec.id); else os.put(c.rec);
          };
        });
      } catch (e) { try { t.abort(); } catch (_) { /* ignore */ } return Promise.reject(e); }
      return done;
    }
    function serialize(job) {
      var p = queue.then(job, job);
      queue = p.then(function () {}, function () {});
      return p;
    }
    // fn returns an engine result ({changes}) or an array of results (batch, all in one transaction)
    function run(fn) {
      return serialize(function () {
        var results = [], changes = [];
        try {
          var r = fn();
          results = Array.isArray(r) ? r : [r];
        } catch (e) {
          // engine validation error: engine already guarantees nothing changed for the failing call;
          // for batches, roll back the calls that did succeed before the failure.
          if (e && e.batchDone) e.batchDone.slice().reverse().forEach(function (x) { engine.revert(x.changes || []); });
          throw e;
        }
        results.forEach(function (x) { if (x && x.changes) changes = changes.concat(x.changes); });
        return commit(changes).then(function () {
          if (changes.length && chan) chan.postMessage({ type: 'changed', at: Date.now() });
          emit({ type: 'changed' });
          return Array.isArray(r) ? results : results[0];
        }, function (err) {
          results.slice().reverse().forEach(function (x) { engine.revert((x && x.changes) || []); });
          if (err && err.code === 'CONFLICT') {
            return load().then(function () {
              emit({ type: 'external' });
              var c = new Error('این اطلاعات هم‌زمان در پنجره دیگری از برنامه تغییر کرده بود. اطلاعات تازه بارگذاری شد؛ عملیات ثبت نشد، لطفاً دوباره انجام دهید.');
              c.code = 'CONFLICT'; throw c;
            });
          }
          var e = new Error('ذخیره در حافظه دستگاه ناموفق بود؛ عملیات ثبت نشد. (' + (err && (err.name || err.message)) + ')');
          e.code = 'STORAGE'; e.cause = err; throw e;
        });
      });
    }
    // helper for batches: runs fns in order, and if one throws, marks which ones already succeeded
    function batch(fns) {
      return function () {
        var done = [];
        for (var i = 0; i < fns.length; i++) {
          try { done.push(fns[i](done)); } catch (e) { e.batchDone = done; e.batchIndex = i; throw e; }
        }
        return done;
      };
    }

    // ---- restore / wipe: replace everything in ONE transaction ----
    function replaceAll(data) {
      return serialize(function () {
        var t = db.transaction(stores, 'readwrite'), done = tx2p(t);
        data = toLogical(data);
        stores.forEach(function (s) {
          var os = t.objectStore(s); os.clear();
          (data[s] || []).forEach(function (rec) { os.put(rec); });
        });
        Object.keys(PHYS).forEach(function (s) { var os = t.objectStore('meta'); data[s].forEach(function (rec) { os.put(physOf(s, rec).rec); }); });
        return done.then(function () { engine.load(data); if (chan) chan.postMessage({ type: 'changed' }); emit({ type: 'changed' }); });
      });
    }

    // ---- local snapshots (same device; protect against wrong restore / user mistakes) ----
    function putSnapshot(kind, payload, keep) {
      var t = db.transaction([SNAP], 'readwrite'), os = t.objectStore(SNAP), done = tx2p(t);
      var id = kind + ':' + Date.now();
      os.put({ id: id, kind: kind, ts: Date.now(), json: JSON.stringify(payload) });
      return done.then(function () { return pruneSnapshots(kind, keep || 5); }).then(function () { return id; });
    }
    function listSnapshots() {
      var t = db.transaction([SNAP], 'readonly');
      return req2p(t.objectStore(SNAP).getAll()).then(function (rows) {
        return rows.map(function (r) { return { id: r.id, kind: r.kind, ts: r.ts, size: r.json.length }; }).sort(function (a, b) { return b.ts - a.ts; });
      });
    }
    function getSnapshot(id) {
      var t = db.transaction([SNAP], 'readonly');
      return req2p(t.objectStore(SNAP).get(id)).then(function (r) { return r ? JSON.parse(r.json) : null; });
    }
    function pruneSnapshots(kind, keep) {
      return listSnapshots().then(function (all) {
        var mine = all.filter(function (s) { return s.kind === kind; }).slice(keep);
        if (!mine.length) return;
        var t = db.transaction([SNAP], 'readwrite'), done = tx2p(t);
        mine.forEach(function (s) { t.objectStore(SNAP).delete(s.id); });
        return done;
      });
    }

    function persist() {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) return Promise.resolve(null);
      return navigator.storage.persisted().then(function (p) { return p ? true : navigator.storage.persist(); }).catch(function () { return null; });
    }
    function estimate() {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
      return navigator.storage.estimate().catch(function () { return null; });
    }
    function on(fn) { listeners.push(fn); }
    function emit(ev) { listeners.forEach(function (fn) { try { fn(ev); } catch (e) { /* ignore */ } }); }
    if (chan) chan.onmessage = function (m) {
      if (!m.data) return;
      if (m.data.type === 'changed') serialize(function () { return load(); }).then(function () { emit({ type: 'external' }); });
      else if (m.data.type === 'hello') { chan.postMessage({ type: 'here' }); emit({ type: 'multi' }); }
      else if (m.data.type === 'here') emit({ type: 'multi' });
    };
    function announce() { if (chan) chan.postMessage({ type: 'hello' }); }

    return { open: open, load: load, readAll: readAll, schemaOf: schemaOf, announce: announce, commit: commit, run: run, batch: batch, replaceAll: replaceAll,
      putSnapshot: putSnapshot, listSnapshots: listSnapshots, getSnapshot: getSnapshot, persist: persist, estimate: estimate, on: on,
      get db() { return db; } };
  }

  var api = { createStore: createStore, DB_NAME: DB_NAME, PHYS: PHYS, toLogical: toLogical };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Store = api;
})(typeof self !== 'undefined' ? self : this);
