/* Backup file format (v2) — pure module, works in browsers and Node 20+ (WebCrypto).
   Plain:     {format, version:2, app, schema, createdAt, counts, hash: SHA-256(JSON(data)), data}
   Encrypted: {format, version:2, encrypted:true, app, createdAt, kdf:{PBKDF2,SHA-256,iterations,salt}, cipher:{AES-GCM,iv}, payload}
              payload = AES-GCM(JSON of the plain object). AES-GCM authenticates: a wrong password or any
              modified byte fails to decrypt. Version-1 files (no schema field) are still accepted. */
(function (root) {
  'use strict';
  var FORMAT = 'amiran-yadak-backup', ITER = 250000;
  var subtle = function () { var c = root.crypto || (typeof globalThis !== 'undefined' && globalThis.crypto); if (!c || !c.subtle) throw err('NO_CRYPTO', 'رمزنگاری در این مرورگر در دسترس نیست (برنامه باید با HTTPS باز شود).'); return c.subtle; };
  var rnd = function (n) { var c = root.crypto || globalThis.crypto, a = new Uint8Array(n); c.getRandomValues(a); return a; };
  function err(code, msg) { var e = new Error(msg); e.code = code; return e; }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function b64(u8) { var s = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function unb64(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  var enc = new TextEncoder(), dec = new TextDecoder('utf-8');
  function sha256(text) { return subtle().digest('SHA-256', enc.encode(text)).then(hex); }
  function counts(data) { var c = {}; Object.keys(data).forEach(function (k) { if (Array.isArray(data[k])) c[k] = data[k].length; }); return c; }
  function schemaOf(data) { var m = (data.meta || []).filter(function (x) { return x && x.id === 'schema'; })[0]; return m && m.v && m.v.v || 1; }
  function key(password, salt, usage) {
    return subtle().importKey('raw', enc.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']).then(function (k) {
      return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: ITER }, k, { name: 'AES-GCM', length: 256 }, false, [usage]);
    });
  }
  // -> Promise<string>
  function make(data, opts) {
    opts = opts || {};
    var json = JSON.stringify(data);
    return sha256(json).then(function (h) {
      var plain = { format: FORMAT, version: 2, app: opts.app || '', schema: schemaOf(data), createdAt: Date.now(), counts: counts(data), hash: h, data: data };
      if (!opts.password) return JSON.stringify(plain);
      var salt = rnd(16), iv = rnd(12);
      return key(opts.password, salt, 'encrypt').then(function (k) {
        return subtle().encrypt({ name: 'AES-GCM', iv: iv }, k, enc.encode(JSON.stringify(plain)));
      }).then(function (ct) {
        return JSON.stringify({ format: FORMAT, version: 2, encrypted: true, app: plain.app, createdAt: plain.createdAt,
          kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITER, salt: b64(salt) }, cipher: { name: 'AES-GCM', iv: b64(iv) }, payload: b64(new Uint8Array(ct)) });
      });
    });
  }
  function isEncrypted(text) { try { var o = JSON.parse(text); return !!(o && o.format === FORMAT && o.encrypted); } catch (e) { return false; } }
  // -> Promise<{data, createdAt, app, schema, encrypted}>; error codes: NOT_BACKUP, NEED_PASSWORD, BAD_PASSWORD, CORRUPT
  function parse(text, password) {
    var o;
    try { o = JSON.parse(text); } catch (e) { return Promise.reject(err('NOT_BACKUP', 'فایل پشتیبان قابل خواندن نیست.')); }
    if (!o || o.format !== FORMAT) return Promise.reject(err('NOT_BACKUP', 'این فایل، پشتیبان برنامه امیران یدک نیست.'));
    var step = Promise.resolve(o);
    if (o.encrypted) {
      if (!password) return Promise.reject(err('NEED_PASSWORD', 'این فایل پشتیبان رمز دارد.'));
      step = key(password, unb64(o.kdf.salt), 'decrypt').then(function (k) {
        return subtle().decrypt({ name: 'AES-GCM', iv: unb64(o.cipher.iv) }, k, unb64(o.payload));
      }).then(function (pt) { return JSON.parse(dec.decode(pt)); }, function () { throw err('BAD_PASSWORD', 'رمز فایل پشتیبان اشتباه است یا فایل دستکاری شده است.'); });
    }
    return step.then(function (p) {
      if (!p || !p.data || typeof p.data !== 'object') throw err('CORRUPT', 'محتوای فایل پشتیبان ناقص است.');
      return sha256(JSON.stringify(p.data)).then(function (h) {
        if (p.hash && h !== p.hash) throw err('CORRUPT', 'فایل پشتیبان خراب یا دستکاری شده است (کد کنترلی مطابقت ندارد).');
        return { data: p.data, createdAt: p.createdAt, app: p.app, schema: p.schema || schemaOf(p.data), encrypted: !!o.encrypted, hashChecked: !!p.hash };
      });
    });
  }
  var api = { make: make, parse: parse, isEncrypted: isEncrypted, sha256: sha256, FORMAT: FORMAT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Backup = api;
})(typeof self !== 'undefined' ? self : this);
