/* 1D barcode decoder: EAN-13 (incl. UPC-A as 0-prefixed EAN-13), EAN-8, Code 128.
   Pure JS, no DOM. Input: grayscale Uint8 array (w*h). Scans several rows in both
   directions; a result is accepted only if it validates its checksum AND is read
   identically on at least `minAgree` rows (default 2) to avoid false reads. */
(function (root) {
  'use strict';

  // ---- EAN tables (widths of space,bar,space,bar for L codes) ----
  var L = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'].map(toArr);
  var G = L.map(function (p) { return p.slice().reverse(); });
  var PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  var C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'].map(toArr);
  function toArr(s) { return s.split('').map(Number); }

  // variance of observed run widths vs a pattern (in module units), zxing-style
  function variance(runs, off, pattern, maxIndiv) {
    var n = pattern.length, total = 0, pt = 0, i;
    for (i = 0; i < n; i++) { total += runs[off + i]; pt += pattern[i]; }
    if (total < pt) return Infinity;
    var unit = total / pt, maxI = maxIndiv * unit, v = 0;
    for (i = 0; i < n; i++) {
      var d = Math.abs(runs[off + i] - pattern[i] * unit);
      if (d > maxI) return Infinity;
      v += d;
    }
    return v / total;
  }
  function bestMatch(runs, off, table, maxAvg, maxIndiv) {
    var best = -1, bv = maxAvg;
    for (var k = 0; k < table.length; k++) {
      var v = variance(runs, off, table[k], maxIndiv);
      if (v < bv) { bv = v; best = k; }
    }
    return best;
  }

  // ---- row -> run lengths (sub-pixel edges via linear interpolation of threshold crossings) ----
  function rowRuns(gray, w, y, x0, x1, mode) {
    var n = x1 - x0, v = new Float32Array(n), i, base = y * w + x0;
    if (mode === 0) for (i = 0; i < n; i++) v[i] = gray[base + i];
    else for (i = 0; i < n; i++) v[i] = (gray[base + Math.max(0, i - 1)] + 2 * gray[base + i] + gray[base + Math.min(n - 1, i + 1)]) / 4;
    var d = new Float32Array(n); // d<0 => dark
    if (mode !== 1) {
      var mn = 255, mx = 0;
      for (i = 0; i < n; i++) { if (v[i] < mn) mn = v[i]; if (v[i] > mx) mx = v[i]; }
      if (mx - mn < 35) return null;
      var t = (mn + mx) / 2;
      for (i = 0; i < n; i++) d[i] = v[i] - t;
    } else {
      var win = Math.max(16, Math.round(n / 10)), half = win >> 1, pre = new Float64Array(n + 1);
      for (i = 0; i < n; i++) pre[i + 1] = pre[i] + v[i];
      for (i = 0; i < n; i++) {
        var a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
        d[i] = v[i] - ((pre[b] - pre[a]) / (b - a) - 6);
      }
    }
    var runs = [], colors = [], last = 0, cur = d[0] < 0 ? 1 : 0;
    for (i = 1; i < n; i++) {
      var c = d[i] < 0 ? 1 : 0;
      if (c !== cur) {
        var x = (i - 1) + d[i - 1] / (d[i - 1] - d[i]); // interpolated crossing
        runs.push(x - last); colors.push(cur); last = x; cur = c;
      }
    }
    runs.push(n - last); colors.push(cur);
    return { runs: runs, colors: colors };
  }
  /* v2.1.2 — edges from LOCAL extrema: every edge is placed half-way between its own neighbouring light peak and
     dark valley, so narrow elements whose contrast was reduced by blur, glare or uneven light still produce an edge.
     A hysteresis (fraction of the row's contrast) ignores sensor noise and paper texture. */
  function rowRunsExtrema(gray, w, y, x0, x1, sharpen) {
    var n = x1 - x0, base = y * w + x0, v = new Float32Array(n), i;
    for (i = 0; i < n; i++) v[i] = (gray[base + Math.max(0, i - 1)] + 2 * gray[base + i] + gray[base + Math.min(n - 1, i + 1)]) / 4;
    if (sharpen) { // v2.1.2: out-of-focus rows — unsharp mask (row minus its wider blur) restores narrow bars/spaces
      var s = new Float32Array(n), r = 3, acc;
      for (i = 0; i < n; i++) { acc = 0; for (var j = -r; j <= r; j++) acc += v[Math.min(n - 1, Math.max(0, i + j))] * (r + 1 - Math.abs(j)); s[i] = acc / ((r + 1) * (r + 1)); }
      for (i = 0; i < n; i++) v[i] = v[i] + sharpen * (v[i] - s[i]);
    }
    var mn = 255, mx = 0;
    for (i = 0; i < n; i++) { if (v[i] < mn) mn = v[i]; if (v[i] > mx) mx = v[i]; }
    if (mx - mn < 35) return null;
    var hyst = Math.max(9, (mx - mn) * 0.1), ext = [], typ = []; // typ 1 = light peak, 0 = dark valley
    var hiI = 0, hiV = v[0], loI = 0, loV = v[0], state = 0;
    for (i = 1; i < n; i++) {
      var x = v[i];
      if (state === 0) {
        if (x > hiV) { hiV = x; hiI = i; } if (x < loV) { loV = x; loI = i; }
        if (hiV - loV > hyst) {
          if (hiI < loI) { ext.push(hiI); typ.push(1); state = -1; } else { ext.push(loI); typ.push(0); state = 1; }
        }
      } else if (state === 1) { // after a valley: track the highest point, a drop of > hyst confirms it as a peak
        if (x > hiV) { hiV = x; hiI = i; }
        else if (hiV - x > hyst) { ext.push(hiI); typ.push(1); state = -1; loV = x; loI = i; }
      } else { // after a peak: track the lowest point, a rise of > hyst confirms it as a valley
        if (x < loV) { loV = x; loI = i; }
        else if (x - loV > hyst) { ext.push(loI); typ.push(0); state = 1; hiV = x; hiI = i; }
      }
    }
    if (state === 1 && hiI > ext[ext.length - 1]) { ext.push(hiI); typ.push(1); } else if (state === -1 && loI > ext[ext.length - 1]) { ext.push(loI); typ.push(0); }
    if (ext.length < 20) return null;
    var edges = [];
    for (var k = 0; k + 1 < ext.length; k++) {
      var a = ext[k], b = ext[k + 1], lev = (v[a] + v[b]) / 2, e = (a + b) / 2;
      for (i = a; i < b; i++) {
        var d0 = v[i] - lev, d1 = v[i + 1] - lev;
        if (d0 === 0) { e = i; break; }
        if ((d0 < 0) !== (d1 < 0)) { e = i + d0 / (d0 - d1); break; }
      }
      edges.push(e);
    }
    var runs = [], colors = [], last = 0;
    for (k = 0; k < edges.length; k++) { runs.push(edges[k] - last); colors.push(typ[k] === 0 ? 1 : 0); last = edges[k]; }
    runs.push(n - last); colors.push(typ[typ.length - 1] === 0 ? 1 : 0);
    return { runs: runs, colors: colors };
  }

  // ---- EAN-13 / EAN-8 on runs array; runs[off] must be a bar ----
  function eanCheck(digits) {
    var s = 0, n = digits.length;
    for (var i = 0; i < n - 1; i++) s += digits[n - 2 - i] * (i % 2 === 0 ? 3 : 1);
    return (10 - (s % 10)) % 10 === digits[n - 1];
  }
  function guardOk(runs, off, n, unit) {
    for (var i = 0; i < n; i++) { var r = runs[off + i] / unit; if (r < 0.4 || r > 1.9) return false; }
    return true;
  }
  function tryEan(runs, colors, off) {
    // EAN-13: 59 runs; EAN-8: 43 runs
    var res = tryEanLen(runs, colors, off, 13);
    return res || tryEanLen(runs, colors, off, 8);
  }
  function tryEanLen(runs, colors, off, len) {
    var r = eanAt(runs, colors, off, len);
    if (r) return r;
    // v2.1.2: blur / ink spread make every bar wider (and every space narrower) by about the same amount.
    // Measure that on the guard bars (all nominally 1 module) and correct it before matching the digits.
    var half = len === 13 ? 6 : 4, nRuns = 3 + half * 4 + 5 + half * 4 + 3;
    if (off + nRuns > runs.length || colors[off] !== 1) return null;
    var g = [off, off + 1, off + 2, off + 3 + half * 4, off + 4 + half * 4, off + 5 + half * 4, off + 6 + half * 4, off + 7 + half * 4, off + nRuns - 3, off + nRuns - 2, off + nRuns - 1];
    var b = biasOf(runs, colors, g, off, nRuns, len === 13 ? 95 : 67);
    return b ? eanAt(unbias(runs, colors, off - 1, off + nRuns + 1, b), colors, off, len) : null;
  }
  function biasOf(runs, colors, idx, off, nRuns, mods) {
    var tot = 0, sb = 0, nb = 0, ss = 0, ns = 0, i;
    for (i = 0; i < nRuns; i++) tot += runs[off + i];
    var unit = tot / mods;
    for (i = 0; i < idx.length; i++) { var k = idx[i]; if (colors[k] === 1) { sb += runs[k]; nb++; } else { ss += runs[k]; ns++; } }
    if (!nb || !ns) return 0;
    var bias = (sb / nb - ss / ns) / 2;
    return Math.abs(bias) > 0.1 * unit && Math.abs(bias) < 0.7 * unit ? bias : 0;
  }
  function unbias(runs, colors, a, b, bias) {
    var out = runs.slice();
    for (var i = Math.max(0, a); i < Math.min(runs.length, b); i++) out[i] = Math.max(0.05, runs[i] + (colors[i] === 1 ? -bias : bias));
    return out;
  }
  function eanAt(runs, colors, off, len) {
    var half = len === 13 ? 6 : 4, nRuns = 3 + half * 4 + 5 + half * 4 + 3, mods = len === 13 ? 95 : 67;
    if (off + nRuns > runs.length || colors[off] !== 1) return null;
    var tot = 0; for (var i = 0; i < nRuns; i++) tot += runs[off + i];
    var unit = tot / mods;
    if (unit < 0.9) return null;
    // quiet zone before / after (at least ~3 modules of space, or image edge)
    if (off > 0 && runs[off - 1] < 3 * unit) return null;
    if (off + nRuns < runs.length && runs[off + nRuns] < 3 * unit) return null;
    if (!guardOk(runs, off, 3, unit)) return null;
    var p = off + 3, digits = [], parity = '';
    for (var d = 0; d < half; d++, p += 4) {
      var kl = bestMatch(runs, p, L, 0.42, 0.75), kg = len === 13 ? bestMatch(runs, p, G, 0.42, 0.75) : -1;
      if (kl < 0 && kg < 0) return null;
      if (kl >= 0 && kg >= 0) { // choose lower variance
        if (variance(runs, p, L[kl], 0.75) <= variance(runs, p, G[kg], 0.75)) kg = -1; else kl = -1;
      }
      if (kl >= 0) { digits.push(kl); parity += 'L'; } else { digits.push(kg); parity += 'G'; }
    }
    if (!guardOk(runs, p, 5, unit)) return null;
    p += 5;
    for (d = 0; d < half; d++, p += 4) {
      var kr = bestMatch(runs, p, L, 0.42, 0.75); // R code has same widths as L, starting with a bar
      if (kr < 0) return null;
      digits.push(kr);
    }
    if (!guardOk(runs, p, 3, unit)) return null;
    if (len === 13) {
      var first = PARITY.indexOf(parity);
      if (first < 0) return null;
      digits.unshift(first);
    } else if (parity !== 'LLLL') return null;
    if (!eanCheck(digits)) return null;
    return { format: len === 13 ? 'EAN13' : 'EAN8', text: digits.join('') };
  }

  // ---- Code 128 ----
  function tryC128(runs, colors, off) {
    if (colors[off] !== 1 || off + 6 > runs.length) return null;
    var start = bestMatch(runs, off, C128.slice(103, 106), 0.25, 0.7);
    if (start < 0) return null;
    start += 103;
    var unit0 = 0; for (var i = 0; i < 6; i++) unit0 += runs[off + i]; unit0 /= 11;
    if (off > 0 && runs[off - 1] < 4 * unit0) return null; // quiet zone
    var codes = [start], p = off + 6;
    for (var guard = 0; guard < 200; guard++) {
      if (p + 7 <= runs.length && variance(runs, p, C128[106], 0.7) < 0.25) { codes.push(106); break; }
      if (p + 6 > runs.length) return null;
      var k = bestMatch(runs, p, C128.slice(0, 103), 0.25, 0.7);
      if (k < 0) return null;
      codes.push(k); p += 6;
    }
    if (codes[codes.length - 1] !== 106 || codes.length < 4) return null;
    var data = codes.slice(1, -2), chk = codes[codes.length - 2], sum = start;
    for (i = 0; i < data.length; i++) sum += (i + 1) * data[i];
    if (sum % 103 !== chk) return null;
    // decode
    var set = start === 103 ? 'A' : start === 104 ? 'B' : 'C', out = '', shift = false;
    for (i = 0; i < data.length; i++) {
      var c = data[i], cs = shift ? (set === 'A' ? 'B' : 'A') : set; shift = false;
      if (cs === 'C') {
        if (c < 100) out += (c < 10 ? '0' : '') + c;
        else if (c === 100) set = 'B'; else if (c === 101) set = 'A';
      } else {
        if (c < 96) out += String.fromCharCode(cs === 'A' ? (c < 64 ? c + 32 : c - 64) : c + 32);
        else if (c === 98) shift = true;
        else if (c === 99) set = 'C';
        else if (c === 100 && cs === 'A') set = 'B';
        else if (c === 101 && cs === 'B') set = 'A';
        // FNC1-4 ignored
      }
    }
    return out ? { format: 'CODE128', text: out } : null;
  }

  /* ---- v2.1.2: EAN half codes ----
     A scratch, stain or torn corner usually spoils a DIFFERENT part of the code on different rows. Each half
     (left guard … centre guard, centre guard … right guard) is therefore read and voted separately across rows;
     the final code needs both halves seen on >= minAgree rows, a valid parity pattern AND the checksum. */
  function halfDigits(runs, p, half, unit, withG) {
    var digits = [], parity = '';
    for (var d = 0; d < half; d++, p += 4) {
      var kl = bestMatch(runs, p, L, 0.42, 0.75), kg = withG ? bestMatch(runs, p, G, 0.42, 0.75) : -1;
      if (kl < 0 && kg < 0) return null;
      if (kl >= 0 && kg >= 0) { if (variance(runs, p, L[kl], 0.75) <= variance(runs, p, G[kg], 0.75)) kg = -1; else kl = -1; }
      if (kl >= 0) { digits.push(kl); parity += 'L'; } else { digits.push(kg); parity += 'G'; }
    }
    return { digits: digits, parity: parity };
  }
  function leftHalfAt(runs, colors, off, len, unit) {
    var half = len === 13 ? 6 : 4;
    if (!guardOk(runs, off, 3, unit)) return null;
    var h = halfDigits(runs, off + 3, half, unit, len === 13);
    if (!h || !guardOk(runs, off + 3 + half * 4, 5, unit)) return null;
    if (len === 13 ? PARITY.indexOf(h.parity) < 0 : h.parity !== 'LLLL') return null;
    return h;
  }
  function leftHalf(runs, colors, off, len) {
    var half = len === 13 ? 6 : 4, nRuns = 3 + half * 4 + 5, mods = 3 + half * 7 + 5;
    if (off + nRuns > runs.length || colors[off] !== 1 || colors[off + 3 + half * 4] !== 0) return null;
    var tot = 0; for (var i = 0; i < nRuns; i++) tot += runs[off + i];
    var unit = tot / mods;
    if (unit < 0.9 || off < 1 || runs[off - 1] < 5 * unit) return null; // halves: a REAL quiet zone is required
    var h = leftHalfAt(runs, colors, off, len, unit);
    if (h) return h;
    var g = [off, off + 1, off + 2]; for (i = 0; i < 5; i++) g.push(off + 3 + half * 4 + i);
    var b = biasOf(runs, colors, g, off, nRuns, mods);
    return b ? leftHalfAt(unbias(runs, colors, off, off + nRuns, b), colors, off, len, unit) : null;
  }
  function rightHalfAt(runs, c, q, half, unit) {
    if (!guardOk(runs, c, 5, unit) || !guardOk(runs, q, 3, unit)) return null;
    var h = halfDigits(runs, c + 5, half, unit, false); // R codes: same widths as L, starting with a bar
    return h && h.parity === (half === 6 ? 'LLLLLL' : 'LLLL') ? h : null;
  }
  function rightHalf(runs, colors, q, len) { // q = first bar of the right guard
    var half = len === 13 ? 6 : 4, c = q - half * 4 - 5, nRuns = 5 + half * 4 + 3, mods = 5 + half * 7 + 3;
    if (c < 1 || q + 3 > runs.length || colors[q] !== 1 || colors[c] !== 0) return null;
    var tot = 0; for (var i = 0; i < nRuns; i++) tot += runs[c + i];
    var unit = tot / mods;
    if (unit < 0.9 || q + 3 >= runs.length || runs[q + 3] < 5 * unit) return null; // halves: a REAL quiet zone is required
    var h = rightHalfAt(runs, c, q, half, unit);
    if (h) return h;
    var g = [c, c + 1, c + 2, c + 3, c + 4, q, q + 1, q + 2];
    var b = biasOf(runs, colors, g, c, nRuns, mods);
    return b ? rightHalfAt(unbias(runs, colors, c, c + nRuns, b), c, q, half, unit) : null;
  }
  // EAN-13 only: EAN-8 halves are just 4 digits — short enough for other patterns (e.g. a damaged Code 128) to imitate.
  // Every detection also records WHERE its centre guard is and its module size: the two halves must line up.
  function collectHalves(rr, VL, VR, seen, reversed, n) {
    var runs = rr.runs, colors = rr.colors, pre = [0], i;
    for (i = 0; i < runs.length; i++) pre.push(pre[i] + runs[i]);
    function X(x) { return reversed ? n - x : x; }
    function add(V, k, outer, u, tag) { // outer = x of the outer edge of the guard (left start / right end), in image coordinates
      var e = V[k] || (V[k] = { n: 0, at: [] });
      if (!seen[tag + k]) { seen[tag + k] = 1; e.n++; }
      e.at.push([outer, u]);
    }
    for (var off = 0; off < runs.length; off++) {
      if (colors[off] !== 1) continue;
      var lh = leftHalf(runs, colors, off, 13), rh = rightHalf(runs, colors, off, 13);
      if (lh) add(VL, lh.parity + ':' + lh.digits.join(''), reversed ? -X(pre[off]) : X(pre[off]), (pre[off + 32] - pre[off]) / 50, 'L');
      if (rh) add(VR, rh.digits.join(''), reversed ? -X(pre[off + 3]) : X(pre[off + 3]), (pre[off + 3] - pre[off - 29]) / 50, 'R');
    }
  }
  // some left and some right detection that together span ONE barcode: same orientation, module size within 15 %,
  // and from the left guard's start to the right guard's end = 95 modules (±6 %)
  function lineUp(a, b) {
    for (var i = 0; i < a.length; i++) for (var j = 0; j < b.length; j++) {
      if ((a[i][0] < 0) !== (b[j][0] < 0)) continue; // read in opposite directions
      var u = (a[i][1] + b[j][1]) / 2, span = Math.abs(b[j][0]) - Math.abs(a[i][0]);
      if (a[i][0] < 0) span = -span;
      if (Math.abs(a[i][1] - b[j][1]) <= 0.15 * u && Math.abs(span - 95 * u) <= 0.06 * 95 * u) return true;
    }
    return false;
  }
  function combineHalves(VL, VR, minAgree) {
    var best = null, bs = 0;
    Object.keys(VL).forEach(function (kl) {
      if (VL[kl].n < minAgree) return;
      var a = kl.split(':'), parity = a[0], dl = a[1].split('').map(Number);
      Object.keys(VR).forEach(function (kr) {
        if (VR[kr].n < minAgree) return;
        var d = [PARITY.indexOf(parity)].concat(dl, kr.split('').map(Number));
        if (eanCheck(d) && lineUp(VL[kl].at, VR[kr].at) && VL[kl].n + VR[kr].n > bs) { bs = VL[kl].n + VR[kr].n; best = { format: 'EAN13', text: d.join('') }; }
      });
    });
    return best;
  }

  /* ---- v2.4.2: Codabar (NW-7) — printed by many warehouse / distributor label printers (e.g. Grimaldi boxes:
     «A2900117600958B»). 7 elements per character (4 bars, 3 spaces), narrow/wide, a narrow gap between characters,
     start/stop A–D. No checksum, so it is read strictly: quiet zones, a consistent narrow width, digits only (and «-»),
     at least 4 of them, and (like every code) the same text on 2 rows before it counts. ---- */
  var CB_CODES = [0x003, 0x006, 0x009, 0x060, 0x012, 0x042, 0x021, 0x024, 0x030, 0x048, 0x00c, 0x018, 0x045, 0x051, 0x054, 0x015, 0x01a, 0x029, 0x00b, 0x00e];
  var CB_CHARS = '0123456789-$:/.+ABCD', CB_MAP = {};
  CB_CODES.forEach(function (c, i) { CB_MAP[c] = CB_CHARS[i]; });
  function cbChar(runs, p) { // -> {ch, nar} or null; narrow/wide decided inside the character (2–3 wide of 7)
    if (p + 7 > runs.length) return null;
    var mn = Infinity, mx = 0, i;
    for (i = 0; i < 7; i++) { var r = runs[p + i]; if (r < mn) mn = r; if (r > mx) mx = r; }
    if (mn <= 0 || mx < 1.6 * mn || mx > 4.5 * mn) return null;
    var t = (mn + mx) / 2, code = 0, wide = 0, sumN = 0, nN = 0;
    for (i = 0; i < 7; i++) { var w = runs[p + i] > t; code = (code << 1) | (w ? 1 : 0); if (w) wide++; else { sumN += runs[p + i]; nN++; } }
    var ch = CB_MAP[code];
    return ch && (wide === 2 || wide === 3) ? { ch: ch, nar: sumN / nN } : null;
  }
  function tryCodabar(runs, colors, off) {
    if (colors[off] !== 1) return null;
    var st = cbChar(runs, off); if (!st || 'ABCD'.indexOf(st.ch) < 0) return null;
    var nar = st.nar;
    if (off > 0 && runs[off - 1] < 5 * nar) return null; // quiet zone before
    var p = off + 7, out = '', nars = [nar];
    for (var guard = 0; guard < 40; guard++) {
      if (p >= runs.length) return null;
      var gap = runs[p]; if (gap > 3.5 * nar) return null; // the gap between characters is narrow-ish
      p++;
      var c = cbChar(runs, p); if (!c) return null;
      nars.push(c.nar);
      if ('ABCD'.indexOf(c.ch) >= 0) { // stop
        p += 7;
        if (p < runs.length && runs[p] < 5 * nar) return null; // quiet zone after
        if (out.length < 4 || !/^[0-9-]+$/.test(out)) return null;
        var sorted = nars.slice().sort(function (a, b) { return a - b; }), med = sorted[sorted.length >> 1];
        if (nars.some(function (n) { return n < 0.6 * med || n > 1.6 * med; })) return null; // one module size for the whole code
        return { format: 'CODABAR', text: out };
      }
      out += c.ch; p += 7;
    }
    return null;
  }

  /* ---- v2.4: SUGGESTIONS from the shop's own barcodes (never a read of their own; the app asks first) ----
     (a) the guards and the layout of an EAN-13 are intact but 1–3 digits cannot be read, or every digit was read but the
         checksum fails (one digit misread): the digits (+ parity) are compared with the shop's EAN-13 codes; (b) only ONE half is readable on several rows (the other half torn or
         covered): the half (7 or 6 digits) is compared. A suggestion needs exactly ONE fitting code and 2 rows agreeing. */
  var KA_SRC = null, KA = [];
  function knownArr(known) { if (known !== KA_SRC) { KA_SRC = known; KA = Object.keys(known || {}).filter(function (c) { return /^\d{13}$/.test(c); }); } return KA; }
  function eanPartialAt(runs, colors, off, pre) {
    if (off + 59 > runs.length || colors[off] !== 1) return null;
    var unit = (pre[off + 59] - pre[off]) / 95;
    if (unit < 0.9 || (off > 0 && runs[off - 1] < 3 * unit) || (off + 59 < runs.length && runs[off + 59] < 3 * unit)) return null;
    if (!guardOk(runs, off, 3, unit) || !guardOk(runs, off + 27, 5, unit) || !guardOk(runs, off + 56, 3, unit)) return null;
    var p = off + 3, dg = [], par = '', bad = 0, d;
    for (d = 0; d < 6; d++, p += 4) {
      var kl = bestMatch(runs, p, L, 0.42, 0.75), kg = bestMatch(runs, p, G, 0.42, 0.75);
      if (kl >= 0 && kg >= 0) { if (variance(runs, p, L[kl], 0.75) <= variance(runs, p, G[kg], 0.75)) kg = -1; else kl = -1; }
      if (kl >= 0) { dg.push(kl); par += 'L'; } else if (kg >= 0) { dg.push(kg); par += 'G'; } else { dg.push(-1); par += '?'; bad++; }
    }
    p += 5;
    for (d = 0; d < 6; d++, p += 4) { var kr = bestMatch(runs, p, L, 0.42, 0.75); dg.push(kr); if (kr < 0) bad++; }
    if (bad > 3) return null;
    if (!bad) { var first = PARITY.indexOf(par); if (first >= 0 && eanCheck([first].concat(dg))) return null; } // a valid read is not a partial
    return { d: dg, par: par, mis: bad ? 0 : 1 }; // all digits read but the checksum fails -> exactly ONE digit was misread
  }
  function fitsPartial(code, pa) {
    var par = PARITY[+code[0]], mis = 0;
    for (var i = 0; i < 12; i++) {
      if (pa.d[i] < 0) continue;
      if (+code[i + 1] !== pa.d[i]) { if (++mis > pa.mis) return false; continue; }
      if (i < 6 && pa.par[i] !== par[i]) return false;
    }
    return mis === pa.mis;
  }
  function onlyOne(list, test) { var hit = null; for (var i = 0; i < list.length; i++) if (test(list[i])) { if (hit) return null; hit = list[i]; } return hit; }
  function partialVotes(rr, sug, seen) {
    var runs = rr.runs, colors = rr.colors, pre = [0], i;
    for (i = 0; i < runs.length; i++) pre.push(pre[i] + runs[i]);
    for (var off = 0; off < runs.length; off++) {
      if (colors[off] !== 1) continue;
      var pa = eanPartialAt(runs, colors, off, pre); if (!pa) continue;
      var c = onlyOne(KA, function (k) { return fitsPartial(k, pa); });
      if (c && !seen['S' + c]) { seen['S' + c] = 1; sug[c] = (sug[c] || 0) + 1; }
    }
  }
  function halfSuggestion(VL, VR, sug) {
    var cands = {};
    Object.keys(sug).forEach(function (c) { if (sug[c] >= 2) cands[c] = 1; });
    Object.keys(VL).forEach(function (kl) {
      if (VL[kl].n < 2) return; var a = kl.split(':'), first = PARITY.indexOf(a[0]); if (first < 0) return;
      var pre = first + a[1], c = onlyOne(KA, function (k) { return k.slice(0, 7) === pre; }); if (c) cands[c] = 1;
    });
    Object.keys(VR).forEach(function (kr) { if (VR[kr].n < 2) return; var c = onlyOne(KA, function (k) { return k.slice(7) === kr; }); if (c) cands[c] = 1; });
    var all = Object.keys(cands);
    return all.length === 1 ? { format: 'EAN13', text: all[0], suggest: true } : null;
  }

  function decodeRuns(runs, colors) {
    for (var off = 0; off < runs.length; off++) {
      if (colors[off] !== 1) continue;
      var r = tryEan(runs, colors, off) || tryC128(runs, colors, off) || tryCodabar(runs, colors, off); // v2.4.2: + Codabar
      if (r) return r;
    }
    return null;
  }
  function reverse(obj) { return { runs: obj.runs.slice().reverse(), colors: obj.colors.slice().reverse() }; }

  // gray: Uint8Array/Uint8ClampedArray length w*h
  function decode(gray, w, h, opts) {
    opts = opts || {};
    var rows = opts.rows || 15, minAgree = opts.minAgree == null ? 2 : opts.minAgree;
    var x0 = 0, x1 = w, votes = {}, best = null, VL = {}, VR = {}, halves = opts.halves !== false;
    // v2.2: known = {code: 1} of the shop's own barcodes -> ONE clean row (checksum ok) is enough for them;
    // order = the decoding methods in the order that worked best on this phone (learned by the worker)
    var known = opts.known || null, order = opts.order && opts.order.length === 5 ? opts.order : [0, 1, 2, 3, 4];
    var suggest = known && opts.suggest !== false && knownArr(known).length > 0, sug = {}; // v2.4
    var y0 = Math.floor(h * 0.15), y1 = Math.floor(h * 0.85);
    for (var r = 0; r < rows; r++) {
      // center-out row order
      var k = Math.floor((r + 1) / 2) * (r % 2 ? 1 : -1);
      var y = Math.round((y0 + y1) / 2 + k * (y1 - y0) / rows);
      if (y < 0 || y >= h) continue;
      var seen = {};
      for (var mi = 0; mi < 5; mi++) { // 0-2: thresholds (as before); 3: local-extrema edges; 4: same after sharpening (v2.1.2)
        var mode = order[mi];
        var rr = mode >= 3 ? rowRunsExtrema(gray, w, y, x0, x1, mode === 4 ? 1.6 : 0) : rowRuns(gray, w, y, x0, x1, mode);
        if (!rr) continue;
        var rv = reverse(rr);
        var res = decodeRuns(rr.runs, rr.colors) || decodeRuns(rv.runs, rv.colors);
        if (res) {
          var key = res.format + ':' + res.text;
          votes[key] = (votes[key] || 0) + 1;
          res.mode = mode;
          if (votes[key] >= minAgree) return res;
          if (known && known[res.text]) { res.known = true; return res; }
          if (!best) best = res;
          break;
        }
        if (halves) { collectHalves(rr, VL, VR, seen, false, w); collectHalves(rv, VL, VR, seen, true, w); }
        if (suggest) { partialVotes(rr, sug, seen); partialVotes(rv, sug, seen); }
      }
      if (halves && r >= 2) { var hc = combineHalves(VL, VR, Math.max(2, minAgree)); if (hc) return hc; }
    }
    if (minAgree <= 1 && best) return best;
    var hs = suggest ? halfSuggestion(halves ? VL : {}, halves ? VR : {}, sug) : null;
    if (hs) return hs;
    // v2.4.3: a faint label may give only ONE clean row per frame; the live scanner accepts it when the next frame agrees
    // (Codabar / Code 128 only: on 1,800 non-barcode images a single EAN row was sometimes imitated, these never)
    return opts.weak && best && (best.format === 'CODABAR' || best.format === 'CODE128') ? { format: best.format, text: best.text, mode: best.mode, weak: true } : null;
  }

  function rgbaToGray(rgba, w, h) {
    var g = new Uint8Array(w * h);
    for (var i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }

  var api = { decode: decode, rgbaToGray: rgbaToGray, _eanCheck: eanCheck, C128: C128, _partial: function (runs, colors, off) { var pre = [0]; for (var i = 0; i < runs.length; i++) pre.push(pre[i] + runs[i]); return eanPartialAt(runs, colors, off, pre); } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Barcode1D = api;
})(typeof self !== 'undefined' ? self : this);
