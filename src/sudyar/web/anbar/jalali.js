/* Gregorian <-> Jalali conversion (arithmetic algorithm, valid for 1900-2100 Gregorian) */
(function (root) {
  'use strict';
  function div(a, b) { return Math.floor(a / b); }
  function g2j(gy, gm, gd) {
    var gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var gy2 = gm > 2 ? gy + 1 : gy;
    var days = 355666 + 365 * gy + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400) + gd + gdm[gm - 1];
    var jy = -1595 + 33 * div(days, 12053);
    days %= 12053;
    jy += 4 * div(days, 1461);
    days %= 1461;
    if (days > 365) { jy += div(days - 1, 365); days = (days - 1) % 365; }
    var jm = days < 186 ? 1 + div(days, 31) : 7 + div(days - 186, 30);
    var jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
    return [jy, jm, jd];
  }
  function j2g(jy, jm, jd) {
    jy += 1595;
    var days = -355668 + 365 * jy + div(jy, 33) * 8 + div((jy % 33) + 3, 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
    var gy = 400 * div(days, 146097);
    days %= 146097;
    if (days > 36524) { gy += 100 * div(--days, 36524); days %= 36524; if (days >= 365) days++; }
    gy += 4 * div(days, 1461);
    days %= 1461;
    if (days > 365) { gy += div(days - 1, 365); days = (days - 1) % 365; }
    var gd = days + 1;
    var leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
    var sal = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var gm;
    for (gm = 0; gm < 13 && gd > sal[gm]; gm++) gd -= sal[gm];
    return [gy, gm, gd];
  }
  var MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fromMs(ms) { // uses the device's local calendar date
    var d = new Date(ms); return g2j(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  function fmt(ms, withTime) {
    var j = fromMs(ms), s = j[0] + '/' + pad(j[1]) + '/' + pad(j[2]);
    if (withTime) { var d = new Date(ms); s += ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    return s;
  }
  // Persian/Arabic digits -> Latin, for parsing user input
  function toLatinDigits(s) {
    return String(s).replace(/[۰-۹]/g, function (c) { return c.charCodeAt(0) - 1776; })
      .replace(/[٠-٩]/g, function (c) { return c.charCodeAt(0) - 1632; });
  }
  function toFaDigits(s) { return String(s).replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; }); }
  // Parse "1405/07/18" (Persian or Latin digits) -> local-midnight ms, or null
  function parse(str) {
    var t0 = toLatinDigits(str).trim().replace(/\s+/g, ''), m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(t0) || /^(\d{4})(\d{2})(\d{2})$/.exec(t0); // v2.11: «14050801» typed without slashes
    if (!m) return null;
    var jy = +m[1], jm = +m[2], jd = +m[3];
    if (jm < 1 || jm > 12 || jd < 1 || jd > (jm <= 6 ? 31 : jm <= 11 ? 30 : 30)) return null;
    var g = j2g(jy, jm, jd);
    var back = g2j(g[0], g[1], g[2]);
    if (back[0] !== jy || back[1] !== jm || back[2] !== jd) return null; // e.g. 30 Esfand in non-leap year
    return new Date(g[0], g[1] - 1, g[2]).getTime();
  }
  var api = { g2j: g2j, j2g: j2g, fmt: fmt, fromMs: fromMs, parse: parse, MONTHS: MONTHS, toLatinDigits: toLatinDigits, toFaDigits: toFaDigits };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Jalali = api;
})(typeof self !== 'undefined' ? self : this);
