/* Decoding off the main thread so the screen stays responsive while scanning.
   Receives one frame (QR crop + one or more 1D bands) and replies with the first code found and the time spent.
   v2.2: keeps the shop's own barcodes (one clean row is enough for them) and the method order learned on this phone. */
importScripts('jsQR.js', 'barcode1d.js');
var KNOWN = null, ORDER = null;
self.onmessage = function (e) {
  var m = e.data;
  if (m && m.type === 'known') { if (m.reset || !KNOWN) KNOWN = {}; (m.codes || []).forEach(function (c) { KNOWN[c] = 1; }); return; }
  if (m && m.type === 'order') { ORDER = Array.isArray(m.order) && m.order.length === 5 ? m.order : null; return; }
  if (m && m.type === 'init') { self.postMessage({ type: 'ready' }); return; }
  var t0 = (self.performance || Date).now(), res = null, tq = 0, tb = 0, pos = null;
  try {
    if (m.qr) {
      var q = self.jsQR(new Uint8ClampedArray(m.qr.buf), m.qr.w, m.qr.h, { inversionAttempts: m.invert ? 'attemptBoth' : 'dontInvert' });
      tq = (self.performance || Date).now() - t0;
      if (q && q.data) res = { format: 'QR', text: q.data };
    }
    var bands = m.bands || (m.band ? [m.band] : []);
    for (var i = 0; !res && i < bands.length; i++) {
      var b = bands[i], t1 = (self.performance || Date).now();
      var g = self.Barcode1D.rgbaToGray(new Uint8ClampedArray(b.buf), b.w, b.h);
      var r = self.Barcode1D.decode(g, b.w, b.h, { rows: 13, minAgree: 2, known: KNOWN, order: ORDER, weak: true });
      tb += (self.performance || Date).now() - t1;
      if (r) { res = r; pos = b.pos || null; }
    }
  } catch (err) { res = null; }
  self.postMessage({ id: m.id, res: res, pos: pos, ms: (self.performance || Date).now() - t0, qrMs: tq, bandMs: tb });
};
