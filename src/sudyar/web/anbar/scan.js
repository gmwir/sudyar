/* Camera scanner for iPhone Safari / PWA (and other browsers).
   - iOS Safari has no BarcodeDetector, so decoding is done in JS (jsQR for QR, Barcode1D for EAN-13/8,
     UPC-A, Code128) inside a Web Worker; falls back to the main thread if workers are unavailable.
     If the browser has a native BarcodeDetector it is used instead (faster).
   - Camera needs a secure context (HTTPS or localhost).
   - Anti-duplicate: a code that stays in view (or re-appears within holdMs) fires only once.
   - Timing statistics are collected for the diagnostics screen (measured on the real device). */
(function (root) {
  'use strict';
  function now() { return (root.performance && performance.now) ? performance.now() : Date.now(); }

  function camError(err) {
    var n = err && (err.name || err.code || err.message) || '';
    var map = {
      INSECURE: 'دوربین فقط وقتی کار می‌کند که برنامه از آدرس HTTPS باز شده باشد.',
      NO_API: 'این مرورگر به دوربین دسترسی نمی‌دهد. برنامه را در Safari آیفون (iOS 14.3 یا جدیدتر) باز کنید، یا از دکمه «عکس» استفاده کنید.',
      NotAllowedError: 'اجازه دسترسی به دوربین داده نشد. در آیفون: Settings ← Safari ← Camera را روی Allow یا Ask بگذارید، برنامه را ببندید و دوباره باز کنید.',
      SecurityError: 'دسترسی به دوربین به دلایل امنیتی مسدود است (برنامه باید با HTTPS باز شود).',
      NotFoundError: 'دوربینی روی این دستگاه پیدا نشد.',
      NotReadableError: 'دوربین در اختیار برنامه دیگری است (مثلاً تماس تصویری). آن را ببندید و دوباره امتحان کنید.',
      OverconstrainedError: 'تنظیمات دوربین پشتیبانی نشد؛ دوباره امتحان کنید.',
      AbortError: 'باز کردن دوربین قطع شد؛ دوباره امتحان کنید.'
    };
    return map[n] || ('خطا در باز کردن دوربین: ' + n);
  }

  var workerUrl = (function () { try { var s = document.currentScript && document.currentScript.src; return s ? s.replace(/scan\.js(\?.*)?$/, 'scanworker.js') : 'scanworker.js'; } catch (e) { return 'scanworker.js'; } })();

  function Scanner(opts) {
    this.video = opts.video;
    this.onCode = opts.onCode;
    this.onStats = opts.onStats || function () {};
    this.holdMs = opts.holdMs || 1500;
    this.interval = opts.interval || 60;
    this.running = false; this.paused = false; this.busy = false;
    this.seen = {};
    this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.canvas2 = document.createElement('canvas'); this.ctx2 = this.canvas2.getContext('2d', { willReadFrequently: true });
    this.frame = 0; this.stream = null; this.timer = null; this.jobId = 0;
    this.stats = { engine: '', openMs: null, firstFrameMs: null, frames: 0, decodeMsTotal: 0, decodeMax: 0, detections: [], width: 0, height: 0 };
    this.worker = null; this.native = null;
    // v2.2: the shop's own barcodes, the decoding-method order learned on this phone, and where the line is reading
    this.known = {}; (opts.known || []).forEach(function (c) { this.known[c] = 1; }, this);
    this.modeStats = opts.modeStats || [0, 0, 0, 0, 0];
    this.onBand = opts.onBand || function () {};
    this.canvas3 = document.createElement('canvas'); this.ctx3 = this.canvas3.getContext('2d', { willReadFrequently: true });
  }
  // decoding methods sorted by how often each one found a code on this phone (default order until 20 successes)
  Scanner.prototype.order = function () {
    var st = this.modeStats, tot = st.reduce(function (a, b) { return a + b; }, 0);
    if (tot < 20) return null;
    return [0, 1, 2, 3, 4].sort(function (a, b) { return st[b] - st[a] || a - b; });
  };
  Scanner.prototype.addKnown = function (code) { if (!code || this.known[code]) return; this.known[code] = 1; if (this.worker) this.worker.postMessage({ type: 'known', codes: [code] }); };
  Scanner.supported = function () { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); };
  Scanner.prototype.start = function () {
    var self = this, t0 = now();
    if (typeof isSecureContext !== 'undefined' && !isSecureContext) return Promise.reject({ name: 'INSECURE' });
    if (!Scanner.supported()) return Promise.reject({ name: 'NO_API' });
    var v = this.video;
    v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.muted = true; v.setAttribute('autoplay', '');
    this.t0 = t0;
    // 1080p: small labels need the pixels (see tests/scan_sim). Falls back automatically if unsupported.
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } })
      .then(function (stream) {
        self.stream = stream; v.srcObject = stream;
        self.stats.openMs = Math.round(now() - t0);
        return v.play().catch(function () { /* iOS may need a tap; frames still arrive */ });
      }).then(function () { return self.initEngine(); })
      .then(function () { self.running = true; self.loop(); return true; });
  };
  Scanner.prototype.initEngine = function () {
    var self = this;
    if (root.BarcodeDetector && BarcodeDetector.getSupportedFormats) {
      return BarcodeDetector.getSupportedFormats().then(function (f) {
        if (f.indexOf('qr_code') >= 0) {
          self.native = new BarcodeDetector({ formats: f.filter(function (x) { return ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'code_128'].indexOf(x) >= 0; }) });
          self.stats.engine = 'native';
        } else self.useWorker();
      }).catch(function () { self.useWorker(); });
    }
    this.useWorker(); return Promise.resolve();
  };
  Scanner.prototype.useWorker = function () {
    var self = this;
    try {
      this.worker = new Worker(workerUrl);
      this.worker.onmessage = function (e) { if (e.data && e.data.type) return; self.onResult(e.data); };
      this.worker.postMessage({ type: 'known', reset: true, codes: Object.keys(this.known) });
      var ord = this.order(); if (ord) this.worker.postMessage({ type: 'order', order: ord });
      this.worker.onerror = function () { self.worker = null; self.stats.engine = 'main'; self.busy = false; };
      this.stats.engine = 'worker';
    } catch (e) { this.worker = null; this.stats.engine = 'main'; }
  };
  Scanner.prototype.stop = function () {
    this.running = false; clearTimeout(this.timer);
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } this.worker = null; }
    if (this.stream) this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
    this.stream = null;
    try { this.video.pause(); this.video.srcObject = null; } catch (e) { /* ignore */ }
  };
  Scanner.prototype.pause = function () { this.paused = true; };
  Scanner.prototype.resume = function () { this.paused = false; };
  Scanner.prototype.track = function () { return this.stream ? this.stream.getVideoTracks()[0] : null; };
  Scanner.prototype.hasTorch = function () {
    var t = this.track(); if (!t || !t.getCapabilities) return false;
    try { return !!t.getCapabilities().torch; } catch (e) { return false; }
  };
  Scanner.prototype.setTorch = function (on) {
    var t = this.track(); if (!t) return Promise.resolve(false);
    return t.applyConstraints({ advanced: [{ torch: !!on }] }).then(function () { return true; }, function () { return false; });
  };
  Scanner.prototype.loop = function () {
    var self = this;
    if (!this.running) return;
    try { if (!this.paused && !this.busy && this.video.readyState >= 2) this.tick(); } catch (e) { this.busy = false; }
    this.timer = setTimeout(function () { self.loop(); }, this.interval);
  };
  function grab(ctx, cv, video, sx, sy, sw, sh, tw, th) {
    if (cv.width !== tw || cv.height !== th) { cv.width = tw; cv.height = th; }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, tw, th);
    return ctx.getImageData(0, 0, tw, th);
  }
  Scanner.prototype.tick = function () {
    var self = this, vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return;
    if (this.stats.firstFrameMs == null) { this.stats.firstFrameMs = Math.round(now() - this.t0); this.stats.width = vw; this.stats.height = vh; }
    this.frame++; this.stats.frames++;
    var t0 = now();
    if (this.native) {
      this.busy = true;
      this.native.detect(this.video).then(function (codes) {
        var c = codes && codes[0];
        self.onResult({ res: c ? { format: c.format === 'qr_code' ? 'QR' : c.format.toUpperCase(), text: c.rawValue } : null, ms: now() - t0 });
      }, function () { self.native = null; self.useWorker(); self.busy = false; });
      return;
    }
    // QR: alternate (a) the whole aiming square scaled to <=720 px and (b) the CENTRE at native resolution
    // ("digital zoom") for small / distant labels — measured best in the print+camera simulation.
    var m = Math.min(vw, vh), zoomFrame = this.frame % 2 === 0;
    var side = Math.round(m * (zoomFrame ? 0.5 : 0.9)), sx = (vw - side) >> 1, sy = (vh - side) >> 1;
    var qs = Math.min(720, side);
    var qr = grab(this.ctx, this.canvas, this.video, sx, sy, side, side, qs, qs);
    // 1D (v2.2): the centre band EVERY frame + one more band in turn (upper, lower, vertical) — the whole aiming area
    // is read, a code above/below the line or held upright is found too; the line on screen follows the band being read
    var bands = [this.band(vw, vh, 0.5)], extra = BANDS[this.frame % BANDS.length];
    bands.push(extra === 'v' ? this.vband(vw, vh) : extra === 'z' ? this.zband(vw, vh) : this.band(vw, vh, extra, true));
    this.onBand(extra === 'z' ? 0.5 : extra);
    var invert = this.frame % 7 === 0; // occasionally try inverted (light-on-dark) QR codes
    if (this.worker) {
      this.busy = true;
      this.worker.postMessage({ id: ++this.jobId, invert: invert, qr: { buf: qr.data.buffer, w: qs, h: qs }, bands: bands.map(function (b) { return { buf: b.img.data.buffer, w: b.w, h: b.h, pos: b.pos }; }) },
        [qr.data.buffer].concat(bands.map(function (b) { return b.img.data.buffer; })));
      this.capMs = now() - t0;
      return;
    }
    var res = null, pos = null, q = root.jsQR(qr.data, qs, qs, { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' });
    if (q && q.data) res = { format: 'QR', text: q.data };
    for (var i = 0; !res && i < bands.length; i++) { var b = bands[i]; res = root.Barcode1D.decode(root.Barcode1D.rgbaToGray(b.img.data, b.w, b.h), b.w, b.h, { rows: 13, minAgree: 2, weak: true, known: this.known, order: this.order() }); if (res) pos = b.pos; }
    this.onResult({ res: res, pos: pos, ms: now() - t0 });
  };
  var BANDS = [0.36, 'z', 0.64, 'v', 'z']; // upper, zoom, lower, vertical (centre band is read every frame); v2.4.4: 'z' = centre at native resolution
  Scanner.prototype.band = function (vw, vh, yc, second) { // horizontal band centred at yc (fraction of the height)
    var bw = Math.round(vw * 0.94), bh = Math.round(vh * 0.25), bx = (vw - bw) >> 1, by = Math.max(0, Math.min(vh - bh, Math.round(vh * yc - bh / 2)));
    var scale = Math.min(1, 1600 / bw), tw = Math.round(bw * scale), th = Math.round(bh * scale);
    return { img: grab(second ? this.ctx3 : this.ctx2, second ? this.canvas3 : this.canvas2, this.video, bx, by, bw, bh, tw, th), w: tw, h: th, pos: yc };
  };
  // v2.4.4: "digital zoom" for 1D — the middle 56 % of the width at native resolution (a small / faint warehouse label
  // gets ~1.7× more pixels per bar than in the full-width band)
  Scanner.prototype.zband = function (vw, vh) {
    var bw = Math.round(vw * 0.56), bh = Math.round(vh * 0.2), bx = (vw - bw) >> 1, by = Math.round(vh * 0.5 - bh / 2);
    var scale = Math.min(1, 1600 / bw), tw = Math.round(bw * scale), th = Math.round(bh * scale);
    return { img: grab(this.ctx3, this.canvas3, this.video, bx, by, bw, bh, tw, th), w: tw, h: th, pos: 0.5 };
  };
  Scanner.prototype.vband = function (vw, vh) { // vertical strip through the centre, turned to horizontal
    var sw = Math.round(vw * 0.25), sh = Math.round(vh * 0.94), sx = (vw - sw) >> 1, sy = (vh - sh) >> 1;
    var scale = Math.min(1, 1280 / sh), W = Math.round(sh * scale), H = Math.round(sw * scale), cv = this.canvas3, ctx = this.ctx3;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.translate(0, H); ctx.rotate(-Math.PI / 2);
    ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, H, W);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { img: ctx.getImageData(0, 0, W, H), w: W, h: H, pos: 'v' };
  };
  Scanner.prototype.onResult = function (m) {
    this.busy = false;
    if (m.res && m.res.mode != null && m.res.mode >= 0 && m.res.mode < 5) { // learn which method works on this phone
      this.modeStats[m.res.mode]++;
      var tot = this.modeStats.reduce(function (a, b) { return a + b; }, 0);
      if (this.worker && tot >= 20 && tot % 10 === 0) { var ord = this.order(); if (ord) this.worker.postMessage({ type: 'order', order: ord }); }
    }
    if (m.res) m.res.pos = m.pos != null ? m.pos : null;
    var ms = (m.ms || 0) + (this.capMs || 0); this.capMs = 0;
    this.stats.decodeMsTotal += ms; if (ms > this.stats.decodeMax) this.stats.decodeMax = ms;
    if (!this.running || !m.res) return;
    this.emit(m.res, ms);
  };
  Scanner.prototype.emit = function (res, decodeMs) {
    if (res.weak) { // v2.4.3: one row in one frame is not enough — the same text again within 1 s (two independent reads)
      var tw = now(), wk = this.weakSeen || (this.weakSeen = {}), lw = wk[res.text];
      wk[res.text] = tw; if (!lw || tw - lw > 1000) return;
      delete wk[res.text];
    }
    if (res.suggest) { // v2.4: a suggestion from a damaged code must persist ~1.2 s with no full read before the app asks
      var tt = now(), sg = this.sug || (this.sug = {}), e0 = sg[res.text];
      if (!e0 || tt - e0.last > 700) { sg[res.text] = { first: tt, last: tt }; return; }
      e0.last = tt; if (tt - e0.first < 1200) return;
      delete sg[res.text];
      var lastFull = this.seen[res.text]; if (lastFull && tt - lastFull < this.holdMs) return; // it was just read in full
    }
    var t = now(), last = this.seen[res.text];
    this.seen[res.text] = t;
    if (last && t - last < this.holdMs) return;   // still the same code in view -> ignore
    if (this.paused) return;
    var det = { at: t, sinceStart: Math.round(t - this.t0), decodeMs: Math.round(decodeMs || 0), format: res.format };
    this.stats.detections.push(det);
    res.detectedAt = t; res.decodeMs = det.decodeMs; res.sinceStart = det.sinceStart;
    res.gapMs = last ? Math.round(t - last) : null; // v2.1.2: time since this same code was last seen (null = first time)
    this.onCode(res);
  };
  Scanner.prototype.forget = function (text) { if (text) delete this.seen[text]; else this.seen = {}; };
  // v2.1.2: treat a code as "just seen" (after a card closes) so a code still in front of the camera does not fire again
  Scanner.prototype.touch = function (text) { if (text) this.seen[text] = now(); };
  Scanner.prototype.summary = function () {
    var s = this.stats, n = s.frames || 1;
    return { engine: s.engine, openMs: s.openMs, firstFrameMs: s.firstFrameMs, frames: s.frames, avgDecodeMs: Math.round(s.decodeMsTotal / n), maxDecodeMs: Math.round(s.decodeMax),
      resolution: s.width + '×' + s.height, detections: s.detections.length, firstDetectMs: s.detections[0] ? s.detections[0].sinceStart : null };
  };

  // ---- decode a still photo (fallback: <input type=file accept=image/* capture>) ----
  function loadImage(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), im = new Image();
      im.onload = function () { res({ img: im, url: url }); };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('تصویر قابل خواندن نیست.')); };
      im.src = url;
    });
  }
  function decodeImage(blob, opts) {
    var known = opts && opts.known || null;
    return loadImage(blob).then(function (o) {
      var im = o.img, W = im.naturalWidth, H = im.naturalHeight, c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
      var found = null;
      // v2.4.4: a phone photo has 3000–4000 px — read it in horizontal strips at up to 2400 px wide first, so a small
      // warehouse label is not shrunk away (the whole picture at 1600 / 1100 / 700 px follows, for QR and big codes)
      var sw = Math.min(W, 2400), ss = sw / W, sh = Math.round(H * 0.12 * ss);
      for (var yy = 0.14; !found && yy <= 0.86; yy += 0.06) {
        c.width = sw; c.height = sh; ctx.drawImage(im, 0, Math.round(H * (yy - 0.06)), W, Math.round(H * 0.12), 0, 0, sw, sh);
        var ds = ctx.getImageData(0, 0, sw, sh), rs = root.Barcode1D.decode(root.Barcode1D.rgbaToGray(ds.data, sw, sh), sw, sh, { rows: 25, minAgree: 2, known: known });
        if (rs) found = rs;
      }
      if (!found) [1600, 1100, 700].some(function (maxSide) {
        var s = Math.min(1, maxSide / Math.max(W, H)), w = Math.round(W * s), h = Math.round(H * s);
        c.width = w; c.height = h; ctx.drawImage(im, 0, 0, w, h);
        var d = ctx.getImageData(0, 0, w, h);
        var q = root.jsQR(d.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (q && q.data) { found = { format: 'QR', text: q.data }; return true; }
        var r = root.Barcode1D.decode(root.Barcode1D.rgbaToGray(d.data, w, h), w, h, { rows: 25, minAgree: 2, known: known });
        if (r) { found = r; return true; }
        return false;
      });
      if (!found) { // v2.2: a code photographed upright (vertical bars)
        var s2 = Math.min(1, 1600 / Math.max(W, H)), w2 = Math.round(W * s2), h2 = Math.round(H * s2);
        c.width = h2; c.height = w2; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.translate(0, w2); ctx.rotate(-Math.PI / 2); ctx.drawImage(im, 0, 0, w2, h2); ctx.setTransform(1, 0, 0, 1, 0, 0);
        var d2 = ctx.getImageData(0, 0, h2, w2), r2 = root.Barcode1D.decode(root.Barcode1D.rgbaToGray(d2.data, h2, w2), h2, w2, { rows: 25, minAgree: 2, known: known });
        if (r2) found = r2;
      }
      c.width = 0; c.height = 0; URL.revokeObjectURL(o.url);
      return found;
    });
  }

  root.Scan = { Scanner: Scanner, decodeImage: decodeImage, camError: camError };
})(typeof self !== 'undefined' ? self : this);
