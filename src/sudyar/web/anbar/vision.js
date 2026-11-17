/* v2.2 box-label recognition.
   OFFLINE "visual memory": every label photo the user confirms is kept as a small fingerprint (shape of edges + colours,
   ~200 bytes); a new photo is compared with them and the closest products are OFFERED (always confirmed by the user).
   It improves with use: the more labels confirmed, the more boxes it knows. It does not read text.
   ONLINE text reading (optional, only when connected and a key is set, only on the user's tap): Google Cloud Vision
   TEXT_DETECTION (supports Persian). Only the label photo is sent — no invoice, customer or price data. */
(function (root) {
  'use strict';
  var G = 96, CELL = 8, BINS = 8; // 12x12 cells: fine enough to see the shape of the name line
  // gray 64x64 of the central part (crop: fraction of the shorter side kept), area-averaged
  function grayGrid(rgba, w, h, crop, dx, dy) {
    var side = Math.min(w, h) * crop, cx = w / 2 + (dx || 0) * w, cy = h / 2 + (dy || 0) * h;
    var x0 = Math.max(0, cx - side / 2), y0 = Math.max(0, cy - side / 2), step = side / G, out = new Float32Array(G * G);
    for (var gy = 0; gy < G; gy++) for (var gx = 0; gx < G; gx++) {
      var sx = x0 + gx * step, sy = y0 + gy * step, ex = Math.min(w, sx + step), ey = Math.min(h, sy + step), sum = 0, n = 0;
      for (var y = Math.floor(sy); y < ey; y += Math.max(1, Math.floor(step / 3))) for (var x = Math.floor(sx); x < ex; x += Math.max(1, Math.floor(step / 3))) {
        var j = (y * w + x) * 4; sum += rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114; n++;
      }
      out[gy * G + gx] = n ? sum / n : 0;
    }
    var m = 0, v = 0, i; for (i = 0; i < out.length; i++) m += out[i]; m /= out.length;
    for (i = 0; i < out.length; i++) v += (out[i] - m) * (out[i] - m); v = Math.sqrt(v / out.length) || 1;
    for (i = 0; i < out.length; i++) out[i] = (out[i] - m) / v;
    return out;
  }
  function hog(g) { // 8x8 cells x 8 unsigned orientations, Hellinger-normalised
    var nc = G / CELL, f = new Float32Array(nc * nc * BINS);
    for (var y = 1; y < G - 1; y++) for (var x = 1; x < G - 1; x++) {
      var gx = g[y * G + x + 1] - g[y * G + x - 1], gy = g[(y + 1) * G + x] - g[(y - 1) * G + x], mag = Math.sqrt(gx * gx + gy * gy);
      if (!mag) continue;
      var ang = Math.atan2(gy, gx); if (ang < 0) ang += Math.PI; var b = Math.min(BINS - 1, Math.floor(ang / Math.PI * BINS));
      f[((y / CELL | 0) * nc + (x / CELL | 0)) * BINS + b] += mag;
    }
    var s = 0, i; for (i = 0; i < f.length; i++) { f[i] = Math.sqrt(f[i]); s += f[i] * f[i]; } s = Math.sqrt(s) || 1;
    for (i = 0; i < f.length; i++) f[i] /= s;
    return f;
  }
  function colors(rgba, w, h) { // 12 hues x 2 saturations + 3 greys, of the central 70%
    var hst = new Float32Array(27), x0 = w * 0.15 | 0, x1 = w * 0.85 | 0, y0 = h * 0.15 | 0, y1 = h * 0.85 | 0, st = Math.max(1, Math.floor(Math.min(w, h) / 80)), n = 0;
    for (var y = y0; y < y1; y += st) for (var x = x0; x < x1; x += st) {
      var j = (y * w + x) * 4, r = rgba[j] / 255, g = rgba[j + 1] / 255, b = rgba[j + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, s = mx ? d / mx : 0;
      if (s < 0.2 || mx < 0.15) hst[24 + (mx < 0.35 ? 0 : mx < 0.7 ? 1 : 2)]++;
      else { var hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh = (hh * 60 + 360) % 360; hst[(Math.floor(hh / 30) % 12) * 2 + (s > 0.55 ? 1 : 0)]++; }
      n++;
    }
    for (var i = 0; i < hst.length; i++) hst[i] /= n || 1;
    return hst;
  }
  function q8(f, scale) { var o = new Uint8Array(f.length); for (var i = 0; i < f.length; i++) o[i] = Math.max(0, Math.min(255, Math.round(f[i] * scale))); return o; }
  function b64(u) { var s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64')); }
  function unb64(t) { var s = typeof atob === 'function' ? atob(t) : Buffer.from(t, 'base64').toString('binary'), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  /* fingerprint of a label photo: {h: base64 HOG (512 B), c: base64 colours (27 B)} */
  function fingerprint(rgba, w, h) { return { h: b64(q8(hog(grayGrid(rgba, w, h, 0.8)), 255 * 4)), c: b64(q8(colors(rgba, w, h), 255)) }; }
  // the query is compared at a few crops/shifts (the box is rarely framed the same way twice)
  var VARIANTS = [[0.8, 0, 0], [0.66, 0, 0], [0.56, 0, 0], [0.92, 0, 0], [0.8, -0.06, 0], [0.8, 0.06, 0], [0.8, 0, -0.06], [0.8, 0, 0.06], [0.66, -0.07, 0.05], [0.66, 0.07, -0.05], [0.66, -0.07, -0.05], [0.66, 0.07, 0.05]];
  function query(rgba, w, h) { return { H: VARIANTS.map(function (v) { return hog(grayGrid(rgba, w, h, v[0], v[1], v[2])); }), C: colors(rgba, w, h) }; }
  function sim(q, fp) {
    var hh = unb64(fp.h), cc = unb64(fp.c), best = 0, n = 0, i;
    for (i = 0; i < hh.length; i++) n += hh[i] * hh[i]; n = Math.sqrt(n) || 1;
    q.H.forEach(function (f) { var d = 0; for (var k = 0; k < f.length; k++) d += f[k] * hh[k]; d /= n; if (d > best) best = d; });
    var inter = 0; for (i = 0; i < 27; i++) inter += Math.min(q.C[i], cc[i] / 255);
    return 0.75 * best + 0.25 * inter;
  }
  /* rank stored fingerprints {productId: [fp,…]} -> [{productId, score}] (score 0..1) */
  function rank(q, store, limit) {
    var out = [];
    Object.keys(store || {}).forEach(function (pid) { var best = 0; (store[pid] || []).forEach(function (fp) { var s = sim(q, fp); if (s > best) best = s; }); out.push({ productId: pid, score: best }); });
    return out.sort(function (a, b) { return b.score - a.score; }).slice(0, limit || 4);
  }

  // ---------- online text reading (Google Cloud Vision) ----------
  function ocrOnline(cfg, jpegBase64) {
    if (!cfg || !cfg.key) return Promise.reject(new Error('NO_KEY'));
    return fetch('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(cfg.key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: jpegBase64 }, features: [{ type: 'TEXT_DETECTION' }], imageContext: { languageHints: ['fa', 'en'] } }] })
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) {
      var a = j && j.responses && j.responses[0]; if (a && a.error) throw new Error(a.error.message || 'Vision error');
      return (a && a.fullTextAnnotation && a.fullTextAnnotation.text) || (a && a.textAnnotations && a.textAnnotations[0] && a.textAnnotations[0].description) || '';
    });
  }

  var api = { fingerprint: fingerprint, query: query, sim: sim, rank: rank, ocrOnline: ocrOnline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Vision = api;
})(typeof self !== 'undefined' ? self : this);
