/* QR Code encoder (byte mode, ECC L/M/Q/H, versions 1-40). Self-contained, no deps.
   Algorithm follows ISO/IEC 18004. API: QR.encode(text, ecl) -> {size, version, modules:[[bool]]} */
(function (root) {
  'use strict';
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    [-1,1,1,2,4,4,6,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81,85]];
  var ECL = { L: 0, M: 1, Q: 2, H: 3 };
  var FORMAT_BITS = { 0: 1, 1: 0, 2: 3, 3: 2 };

  function utf8(str) {
    var out = [];
    var s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }
  function getNumRawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function getNumDataCodewords(ver, e) {
    return Math.floor(getNumRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];
  }
  function rsMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z;
  }
  function rsDivisor(degree) {
    var res = []; for (var i = 0; i < degree - 1; i++) res.push(0); res.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < res.length; j++) { res[j] = rsMul(res[j], root); if (j + 1 < res.length) res[j] ^= res[j + 1]; }
      root = rsMul(root, 2);
    }
    return res;
  }
  function rsRemainder(data, div) {
    var res = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ res.shift(); res.push(0);
      div.forEach(function (c, i) { res[i] ^= rsMul(c, f); });
    });
    return res;
  }
  function addEccAndInterleave(data, ver, e) {
    var nb = NUM_ERROR_CORRECTION_BLOCKS[e][ver], bel = ECC_CODEWORDS_PER_BLOCK[e][ver];
    var raw = Math.floor(getNumRawDataModules(ver) / 8);
    var numShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
    var blocks = [], div = rsDivisor(bel);
    for (var i = 0, k = 0; i < nb; i++) {
      var dat = data.slice(k, k + shortLen - bel + (i < numShort ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var out = [];
    for (i = 0; i < blocks[0].length; i++)
      blocks.forEach(function (b, j) { if (i !== shortLen - bel || j >= numShort) out.push(b[i]); });
    return out;
  }
  function alignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    var res = [6];
    for (var pos = ver * 4 + 10; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }
  function Matrix(ver) {
    this.ver = ver; this.size = ver * 4 + 17;
    this.m = []; this.f = [];
    for (var i = 0; i < this.size; i++) { this.m.push(new Array(this.size).fill(false)); this.f.push(new Array(this.size).fill(false)); }
  }
  Matrix.prototype.set = function (x, y, dark) { this.m[y][x] = dark; this.f[y][x] = true; };
  Matrix.prototype.drawFunctionPatterns = function () {
    var s = this.size, i;
    for (i = 0; i < s; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    this.finder(3, 3); this.finder(s - 4, 3); this.finder(3, s - 4);
    var ap = alignPositions(this.ver), n = ap.length;
    for (i = 0; i < n; i++) for (var j = 0; j < n; j++)
      if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this.align(ap[i], ap[j]);
    this.drawFormat(0, 0);
    this.drawVersion();
  };
  Matrix.prototype.finder = function (cx, cy) {
    for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
      var d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, d !== 2 && d !== 4);
    }
  };
  Matrix.prototype.align = function (cx, cy) {
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++)
      this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  };
  Matrix.prototype.drawFormat = function (e, mask) {
    var data = (FORMAT_BITS[e] << 3) | mask, rem = data, i;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412, s = this.size;
    var b = function (k) { return ((bits >>> k) & 1) !== 0; };
    for (i = 0; i <= 5; i++) this.set(8, i, b(i));
    this.set(8, 7, b(6)); this.set(8, 8, b(7)); this.set(7, 8, b(8));
    for (i = 9; i < 15; i++) this.set(14 - i, 8, b(i));
    for (i = 0; i < 8; i++) this.set(s - 1 - i, 8, b(i));
    for (i = 8; i < 15; i++) this.set(8, s - 15 + i, b(i));
    this.set(8, s - 8, true);
  };
  Matrix.prototype.drawVersion = function () {
    if (this.ver < 7) return;
    var rem = this.ver, i;
    for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (this.ver << 12) | rem;
    for (i = 0; i < 18; i++) {
      var bit = ((bits >>> i) & 1) !== 0, a = this.size - 11 + i % 3, b = Math.floor(i / 3);
      this.set(a, b, bit); this.set(b, a, bit);
    }
  };
  Matrix.prototype.drawCodewords = function (data) {
    var i = 0, s = this.size;
    for (var right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < s; vert++) for (var j = 0; j < 2; j++) {
        var x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? s - 1 - vert : vert;
        if (!this.f[y][x] && i < data.length * 8) { this.m[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
      }
    }
  };
  Matrix.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) for (var x = 0; x < this.size; x++) {
      var inv;
      switch (mask) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = x * y % 2 + x * y % 3 === 0; break;
        case 6: inv = (x * y % 2 + x * y % 3) % 2 === 0; break;
        default: inv = ((x + y) % 2 + x * y % 3) % 2 === 0;
      }
      if (!this.f[y][x] && inv) this.m[y][x] = !this.m[y][x];
    }
  };
  // Simplified penalty (adjacent runs, 2x2 blocks, balance). Any mask yields a valid code;
  // this only picks a good one.
  Matrix.prototype.penalty = function () {
    var s = this.size, m = this.m, res = 0, x, y;
    for (var dir = 0; dir < 2; dir++) for (var a = 0; a < s; a++) {
      var run = 1;
      for (var b = 1; b < s; b++) {
        var cur = dir ? m[b][a] : m[a][b], prev = dir ? m[b - 1][a] : m[a][b - 1];
        if (cur === prev) { run++; if (run === 5) res += 3; else if (run > 5) res++; } else run = 1;
      }
    }
    for (y = 0; y < s - 1; y++) for (x = 0; x < s - 1; x++) {
      var c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) res += 3;
    }
    var dark = 0; for (y = 0; y < s; y++) for (x = 0; x < s; x++) if (m[y][x]) dark++;
    var total = s * s, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return res + k * 10;
  };

  // minVersion: labels use >= 2 so the code has an ALIGNMENT PATTERN (needed to correct camera tilt/perspective)
  function encode(text, eclName, minVersion) {
    var e = ECL[eclName || 'M'];
    var bytes = utf8(text), ver;
    for (ver = Math.max(1, minVersion || 1); ver <= 40; ver++) {
      var cap = getNumDataCodewords(ver, e) * 8;
      var used = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
      if (used <= cap) break;
      if (ver === 40) throw new Error('QR: data too long');
    }
    var bb = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    var capBits = getNumDataCodewords(ver, e) * 8;
    put(0, Math.min(4, capBits - bb.length));
    put(0, (8 - bb.length % 8) % 8);
    for (var pad = 0xEC; bb.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bb.length; i += 8) { var v = 0; for (var j = 0; j < 8; j++) v = (v << 1) | bb[i + j]; data.push(v); }
    var all = addEccAndInterleave(data, ver, e);
    var best = null, bestPen = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var mx = new Matrix(ver); mx.drawFunctionPatterns(); mx.drawCodewords(all);
      mx.applyMask(mask); mx.drawFormat(e, mask);
      var p = mx.penalty();
      if (p < bestPen) { bestPen = p; best = mx; }
    }
    return { size: best.size, version: ver, modules: best.m };
  }
  var api = { encode: encode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.QR = api;
})(typeof self !== 'undefined' ? self : this);
