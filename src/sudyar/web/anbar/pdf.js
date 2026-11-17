/* PDF output without external libraries.
   - PdfDoc: tiny PDF 1.4 writer (JPEG images via DCTDecode + vector filled rectangles). Works in Node too.
   - Browser renderers (need <canvas>): Persian text is drawn by the browser's own text engine onto a
     canvas (correct shaping + RTL), embedded as a JPEG; QR codes are drawn as VECTOR squares so they
     print sharp at any size.  renderFlow() = reports / invoices, renderLabels() = A4 label sheets. */
(function (root) {
  'use strict';
  var PT = 72 / 25.4; // points per mm

  function PdfDoc(meta) { this.pages = []; this.images = []; this.meta = meta || {}; }
  PdfDoc.prototype.addPage = function (wMm, hMm) {
    var p = { w: wMm, h: hMm, ops: [], xo: {} }; this.pages.push(p); return p;
  };
  // jpeg: Uint8Array, pxW/pxH: pixel size
  PdfDoc.prototype.addJpeg = function (jpeg, pxW, pxH) {
    this.images.push({ data: jpeg, w: pxW, h: pxH }); return 'Im' + this.images.length;
  };
  function n(v) { return (Math.round(v * 1000) / 1000).toString(); }
  PdfDoc.prototype.drawImage = function (page, name, xMm, yMm, wMm, hMm) {
    page.xo[name] = true;
    page.ops.push('q ' + n(wMm * PT) + ' 0 0 ' + n(hMm * PT) + ' ' + n(xMm * PT) + ' ' + n((page.h - yMm - hMm) * PT) + ' cm /' + name + ' Do Q');
  };
  PdfDoc.prototype.fillRects = function (page, rects, gray) { // rects: [[x,y,w,h] mm, top-left origin]
    if (!rects.length) return;
    var o = [(gray == null ? 0 : gray) + ' g'];
    rects.forEach(function (r) { o.push(n(r[0] * PT) + ' ' + n((page.h - r[1] - r[3]) * PT) + ' ' + n(r[2] * PT) + ' ' + n(r[3] * PT) + ' re'); });
    o.push('f'); page.ops.push(o.join('\n'));
  };
  PdfDoc.prototype.strokeRect = function (page, x, y, w, h, gray, widthMm) {
    page.ops.push('q ' + gray + ' G ' + n((widthMm || 0.2) * PT) + ' w ' + n(x * PT) + ' ' + n((page.h - y - h) * PT) + ' ' + n(w * PT) + ' ' + n(h * PT) + ' re S Q');
  };
  // QR modules as vector (merges horizontal runs)
  PdfDoc.prototype.drawQr = function (page, modules, xMm, yMm, sizeMm, quiet) {
    quiet = quiet == null ? 2 : quiet;
    var N = modules.length, m = sizeMm / (N + 2 * quiet), rects = [];
    for (var y = 0; y < N; y++) {
      var x = 0;
      while (x < N) {
        if (!modules[y][x]) { x++; continue; }
        var s = x; while (x < N && modules[y][x]) x++;
        rects.push([xMm + (quiet + s) * m, yMm + (quiet + y) * m, (x - s) * m + 0.002, m + 0.002]); // tiny overlap avoids hairline gaps
      }
    }
    this.fillRects(page, rects, 0);
  };
  function utf16hex(s) {
    var h = 'FEFF';
    for (var i = 0; i < s.length; i++) h += ('0000' + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
    return '<' + h + '>';
  }
  PdfDoc.prototype.output = function () { // -> Uint8Array
    var te = new TextEncoder(), chunks = [], offs = [], len = 0, self = this;
    function push(x) { var b = typeof x === 'string' ? te.encode(x) : x; chunks.push(b); len += b.length; }
    var nPages = this.pages.length, nImg = this.images.length;
    // object numbering: 1 catalog, 2 pages, 3 info, images 4.., then per page: page obj + content obj
    var imgObj = function (i) { return 4 + i; }, pageObj = function (i) { return 4 + nImg + 2 * i; }, total = 4 + nImg + 2 * nPages;
    function obj(num, body) { offs[num] = len; push(num + ' 0 obj\n'); body(); push('\nendobj\n'); }
    push('%PDF-1.4\n'); push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
    obj(1, function () { push('<< /Type /Catalog /Pages 2 0 R >>'); });
    obj(2, function () { push('<< /Type /Pages /Count ' + nPages + ' /Kids [' + self.pages.map(function (p, i) { return pageObj(i) + ' 0 R'; }).join(' ') + '] >>'); });
    obj(3, function () { push('<< /Producer (Amiran Yadak Inventory) /Title ' + utf16hex(self.meta.title || 'Amiran Yadak') + ' >>'); });
    this.images.forEach(function (im, i) {
      obj(imgObj(i), function () {
        push('<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.data.length + ' >>\nstream\n');
        push(im.data); push('\nendstream');
      });
    });
    this.pages.forEach(function (p, i) {
      var content = te.encode(p.ops.join('\n'));
      var xo = Object.keys(p.xo).map(function (k) { return '/' + k + ' ' + imgObj(parseInt(k.slice(2), 10) - 1) + ' 0 R'; }).join(' ');
      obj(pageObj(i), function () {
        push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + n(p.w * PT) + ' ' + n(p.h * PT) + '] /Resources << /ProcSet [/PDF /ImageC]' + (xo ? ' /XObject << ' + xo + ' >>' : '') + ' >> /Contents ' + (pageObj(i) + 1) + ' 0 R >>');
      });
      obj(pageObj(i) + 1, function () { push('<< /Length ' + content.length + ' >>\nstream\n'); push(content); push('\nendstream'); });
    });
    var xref = len;
    push('xref\n0 ' + total + '\n0000000000 65535 f \n');
    for (var k = 1; k < total; k++) push(('0000000000' + offs[k]).slice(-10) + ' 00000 n \n');
    push('trailer\n<< /Size ' + total + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    var out = new Uint8Array(len), o = 0; chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    return out;
  };

  // ======================= browser renderers =======================
  var FONT = "Vazirmatn, Tahoma, 'Geeza Pro', sans-serif";
  function canvasJpeg(c, q) {
    var url = c.toDataURL('image/jpeg', q || 0.88), b64 = url.slice(url.indexOf(',') + 1), bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function ensureFonts() {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([document.fonts.load('16px Vazirmatn'), document.fonts.load('bold 16px Vazirmatn')]).catch(function () {});
  }
  function fitText(ctx, s, maxW) {
    s = String(s == null ? '' : s);
    if (ctx.measureText(s).width <= maxW) return s;
    var lo = 0, hi = s.length;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo) + '…';
  }
  function wrapText(ctx, s, maxW, maxLines) {
    var words = String(s == null ? '' : s).split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { var rest = lines.slice(maxLines - 1).join(' '); lines = lines.slice(0, maxLines - 1); lines.push(fitText(ctx, rest, maxW)); }
    return lines.map(function (l) { return fitText(ctx, l, maxW); });
  }

  /* renderFlow(blocks, opts) -> Promise<Uint8Array PDF>
     blocks: {type:'title', text, sub} | {type:'kv', items:[[k,v]], cols} | {type:'table', columns:[{label,w,align,wrap}], rows:[[..]], foot:[..]}
             | {type:'text', text, bold, size} | {type:'gap', h}
             | v2.5 {type:'band', text, level: 1|2, right} = a coloured section bar (group / brand) kept with what follows
     table v2.5: header:false (no header now, still repeated after a page break), after (gap mm), fontSize, column bold
     opts: {landscape, title, footer, dpi, theme: {brand, head, zebra, band2, ink}} — defaults = the app's colours */
  function renderFlow(blocks, opts) {
    opts = opts || {};
    return ensureFonts().then(function () {
      var W = opts.landscape ? 297 : 210, H = opts.landscape ? 210 : 297, M = 11, dpi = opts.dpi || 160, s = dpi / 25.4;
      var TH = Object.assign({ brand: '#1d3b53', head: '#e8eef4', zebra: '#fafafa', band2: '#eef3f7', ink: '#111111' }, opts.theme || {});
      var scratch = document.createElement('canvas').getContext('2d');
      var pages = [[]], y = M, bottom = H - M - 8;
      function f(sizeMm, bold) { return (bold ? 'bold ' : '') + Math.round(sizeMm * s) + 'px ' + FONT; }
      function measure(font, t) { scratch.font = font; return scratch.measureText(t).width / s; }
      function newPage() { pages.push([]); y = M; }
      function op(o) { pages[pages.length - 1].push(o); }
      function need(h) { if (y + h > bottom) newPage(); }
      var contentW = W - 2 * M;
      blocks.forEach(function (b) {
        if (b.type === 'title') {
          need(16);
          op({ t: 'text', x: W - M, y: y + 6, s: b.text, font: f(5.2, true), align: 'right' });
          if (b.sub) op({ t: 'text', x: W - M, y: y + 12, s: b.sub, font: f(3.2), align: 'right', color: '#444' });
          if (b.left) b.left.forEach(function (l, i) { op({ t: 'text', x: M, y: y + 5 + i * 5, s: l, font: f(3), align: 'left', color: '#444' }); });
          y += b.sub ? 15 : 10;
          op({ t: 'line', x1: M, x2: W - M, y: y, w: 0.4, color: TH.brand }); y += 4;
        } else if (b.type === 'kv') {
          var cols = b.cols || 2, cw = contentW / cols, rh = 6.2;
          for (var i = 0; i < b.items.length; i += cols) {
            need(rh);
            for (var c = 0; c < cols && i + c < b.items.length; c++) {
              var kv = b.items[i + c], xr = W - M - c * cw;
              op({ t: 'text', x: xr, y: y + 4.4, s: kv[0] + ':', font: f(3.1, true), align: 'right', color: '#333' });
              var kw = measure(f(3.1, true), kv[0] + ':') + 2;
              op({ t: 'text', x: xr - kw, y: y + 4.4, s: String(kv[1] == null ? '' : kv[1]), font: f(3.2), align: 'right', maxW: cw - kw - 3 });
            }
            y += rh;
          }
          y += 2;
        } else if (b.type === 'text') {
          var sz = b.size || 3.2, font = f(sz, b.bold); scratch.font = font;
          var lines = wrapText(scratch, b.text, contentW * s, 50).map(function (l) { return l; });
          lines.forEach(function (l) { need(sz * 1.6); op({ t: 'text', x: W - M, y: y + sz * 1.2, s: l, font: font, align: 'right', color: b.color }); y += sz * 1.6; });
          y += 1;
        } else if (b.type === 'gap') { y += b.h || 4; }
        else if (b.type === 'page') { if (y > M + 1) newPage(); } // v2.9: start the next block on a new page (e.g. each brand)
        else if (b.type === 'band') {
          var l1 = (b.level || 1) === 1, bh = l1 ? (b.big ? 10 : 8) : 6.6, bs = l1 ? (b.big ? 4.4 : 3.6) : 3.2, pc = pages.length;
          need(bh + (b.keep == null ? 14 : b.keep));
          var broke = pages.length > pc;
          op({ t: 'rect', x: M, y: y, w: contentW, h: bh, color: b.color || (l1 ? TH.brand : TH.band2) });
          if (!l1) op({ t: 'rect', x: W - M - 1.2, y: y, w: 1.2, h: bh, color: TH.brand });
          op({ t: 'text', x: W - M - (l1 ? 2.5 : 3.2), y: y + bh / 2 + bs * 0.38, s: b.text, font: f(bs, true), align: 'right', color: l1 ? '#ffffff' : TH.brand, maxW: contentW * 0.7 });
          if (b.right) op({ t: 'text', x: M + 2.5, y: y + bh / 2 + bs * 0.34, s: b.right, font: f(bs * 0.82), align: 'left', color: l1 ? '#ffffff' : TH.brand });
          y += bh + (l1 ? 1.2 : 0.6);
          if (broke && b.thead) drawTable({ columns: b.thead, rows: [], after: 0, fontSize: b.fs, headAlign: b.headAlign }); // a new page starts with the column titles
        }
        else if (b.type === 'table') drawTable(b);
      });
      function drawTable(b) {
        var cols = b.columns, totalW = cols.reduce(function (a, c) { return a + (c.w || 1); }, 0), fs = b.fontSize || 2.9;
        var xs = [], x = W - M; // RTL: first column on the right
        cols.forEach(function (c) { var w = (c.w || 1) / totalW * contentW; xs.push({ r: x, w: w }); x -= w; });
        var pad = 1.2, lineH = fs * 1.45;
        function header() {
          need(8 + lineH);
          op({ t: 'rect', x: M, y: y, w: contentW, h: 7, color: TH.head });
          cols.forEach(function (c, i) { // v2.5: headAlign -> the title sits where the column's values sit
            var al = b.headAlign ? c.align || 'right' : 'right', tx = al === 'right' ? xs[i].r - pad : al === 'left' ? xs[i].r - xs[i].w + pad : xs[i].r - xs[i].w / 2;
            op({ t: 'text', x: tx, y: y + 4.8, s: c.label, font: f(fs, true), align: al, maxW: xs[i].w - 2 * pad });
          });
          y += 7;
        }
        if (b.header !== false) header();
        var rows = b.rows.concat(b.foot ? [b.foot] : []);
        rows.forEach(function (r, ri) {
          var isFoot = b.foot && ri === rows.length - 1, font = f(fs, isFoot), fontB = f(fs, true);
          scratch.font = font;
          var cellLines = cols.map(function (c, i) {
            var v = r[i] == null ? '' : String(r[i]);
            return c.wrap ? wrapText(scratch, v, (xs[i].w - 2 * pad) * s, 3) : [v];
          });
          var nl = Math.max.apply(null, cellLines.map(function (l) { return l.length || 1; })), rh = nl * lineH + 2.2;
          if (y + rh > bottom) { newPage(); header(); }
          if (isFoot) op({ t: 'rect', x: M, y: y, w: contentW, h: rh, color: '#f3f3f3' });
          else if (ri % 2 === 1 && TH.zebra) op({ t: 'rect', x: M, y: y, w: contentW, h: rh, color: TH.zebra });
          cols.forEach(function (c, i) {
            cellLines[i].forEach(function (l, li) {
              var al = c.align || 'right', tx = al === 'right' ? xs[i].r - pad : al === 'left' ? xs[i].r - xs[i].w + pad : xs[i].r - xs[i].w / 2;
              op({ t: 'text', x: tx, y: y + 1.1 + (li + 1) * lineH - fs * 0.35, s: l, font: c.bold ? fontB : font, align: al, maxW: xs[i].w - 2 * pad, color: (c.color && c.color(r)) || (b.ink || TH.ink) });
            });
          });
          y += rh;
          op({ t: 'line', x1: M, x2: W - M, y: y, w: 0.1, color: '#cccccc' });
        });
        y += b.after == null ? 4 : b.after;
      }
      // ---- draw pages ----
      var doc = new PdfDoc({ title: opts.title }), total = pages.length;
      var cv = document.createElement('canvas'); cv.width = Math.round(W * s); cv.height = Math.round(H * s);
      var ctx = cv.getContext('2d');
      function drawPage(ops, pi) {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.direction = 'rtl'; ctx.textBaseline = 'alphabetic';
        ops.concat([{ t: 'text', x: W / 2, y: H - M + 2, s: 'صفحه ' + fa(pi + 1) + ' از ' + fa(total) + (opts.footer ? '  —  ' + opts.footer : ''), font: f(2.6), align: 'center', color: '#666' }])
          .forEach(function (o) {
            if (o.t === 'rect') { ctx.fillStyle = o.color; ctx.fillRect(o.x * s, o.y * s, o.w * s, o.h * s); }
            else if (o.t === 'line') { ctx.strokeStyle = o.color; ctx.lineWidth = Math.max(1, o.w * s); ctx.beginPath(); ctx.moveTo(o.x1 * s, o.y * s); ctx.lineTo(o.x2 * s, o.y * s); ctx.stroke(); }
            else if (o.t === 'text') {
              ctx.font = o.font; ctx.fillStyle = o.color || '#111'; ctx.textAlign = o.align || 'right';
              var str = o.maxW ? fitText(ctx, o.s, o.maxW * s) : String(o.s);
              ctx.direction = /[\u0600-\u06FF]/.test(str) ? 'rtl' : 'ltr';
              ctx.fillText(str, o.x * s, o.y * s);
            }
          });
        var name = doc.addJpeg(canvasJpeg(cv, 0.86), cv.width, cv.height);
        var page = doc.addPage(W, H); doc.drawImage(page, name, 0, 0, W, H);
      }
      // draw in short slices and yield between them so a long report never freezes the screen
      return new Promise(function (resolve, reject) {
        var i = 0;
        (function step() {
          try {
            var t0 = Date.now();
            while (i < total && (i === 0 || Date.now() - t0 < 60)) { drawPage(pages[i], i); i++; }
            if (opts.onProgress) opts.onProgress(i, total);
            if (i < total) setTimeout(step, 0);
            else { cv.width = 0; cv.height = 0; resolve(doc.output()); }
          } catch (e) { cv.width = 0; cv.height = 0; reject(e); }
        })();
      });
    });
  }
  function fa(x) { return String(x).replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; }); }

  /* Label templates (mm). Layout: QR on the right (RTL), text on the left. */
  var LABELS = {
    '30': { w: 30, h: 26, qr: 16.5, layout: 'stack' },
    '40': { w: 40, h: 30, qr: 19, layout: 'side' },
    '50': { w: 50, h: 30, qr: 23, layout: 'side' }
  };
  function labelGrid(t, margin, gap) {
    margin = margin == null ? 8 : margin; gap = gap == null ? 2 : gap;
    var cols = Math.floor((210 - 2 * margin + gap) / (t.w + gap)), rows = Math.floor((297 - 2 * margin + gap) / (t.h + gap));
    var x0 = (210 - (cols * t.w + (cols - 1) * gap)) / 2, y0 = (297 - (rows * t.h + (rows - 1) * gap)) / 2;
    return { cols: cols, rows: rows, perPage: cols * rows, x0: x0, y0: y0, gap: gap };
  }
  /* items: [{payload, title, brand, sku, price}] (already expanded by copies)
     opts: {size:'30'|'40'|'50', border:true, skip:0} */
  function renderLabels(items, opts) {
    opts = opts || {};
    var t = LABELS[opts.size || '40'], g = labelGrid(t), skip = Math.max(0, Math.min(g.perPage - 1, opts.skip | 0));
    var QRlib = root.QR;
    return ensureFonts().then(function () {
      var dpi = 300, s = dpi / 25.4, doc = new PdfDoc({ title: 'Labels' });
      var cells = []; for (var i = 0; i < skip; i++) cells.push(null); cells = cells.concat(items);
      var nPages = Math.max(1, Math.ceil(cells.length / g.perPage));
      var cv = document.createElement('canvas'); cv.width = Math.round(210 * s); cv.height = Math.round(297 * s);
      var ctx = cv.getContext('2d');
      function f(mm, bold) { return (bold ? 'bold ' : '') + Math.round(mm * s) + 'px ' + FONT; }
      for (var p = 0; p < nPages; p++) {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.direction = 'rtl'; ctx.fillStyle = '#000';
        var qrs = [];
        for (var k = 0; k < g.perPage; k++) {
          var it = cells[p * g.perPage + k]; if (!it) continue;
          var col = k % g.cols, row = Math.floor(k / g.cols);
          var x = 210 - g.x0 - (col + 1) * t.w - col * g.gap, y = g.y0 + row * (t.h + g.gap); // RTL fill order
          var mod = QRlib.encode(it.payload, it.ecl || 'H', 2).modules;
          if (t.layout === 'stack') {
            qrs.push({ m: mod, x: x + (t.w - t.qr) / 2, y: y + 0.8, size: t.qr });
            ctx.textAlign = 'center'; ctx.fillStyle = '#000';
            ctx.font = f(2.5, true); ctx.fillText(fitText(ctx, it.sku, (t.w - 2) * s), (x + t.w / 2) * s, (y + t.qr + 3.6) * s);
            ctx.font = f(2.1); ctx.fillText(fitText(ctx, it.title, (t.w - 2) * s), (x + t.w / 2) * s, (y + t.qr + 6.6) * s);
            // (no room for a price line on 30 mm labels)
          } else {
            var qx = x + t.w - t.qr - 0.6, qy = y + (t.h - t.qr) / 2;
            qrs.push({ m: mod, x: qx, y: qy, size: t.qr });
            var tr = qx - 0.6, tw = tr - (x + 1.4), ty = y + 2.2, big = t.w >= 50 ? 2.9 : 2.6;
            ctx.textAlign = 'right'; ctx.fillStyle = '#000';
            ctx.font = f(big, true);
            wrapText(ctx, it.title, tw * s, t.w >= 50 ? 3 : 2).forEach(function (l) { ty += big * 1.25; ctx.fillText(l, tr * s, ty * s); });
            if (it.brand) { ctx.font = f(2.2); ty += 2.9; ctx.fillText(fitText(ctx, it.brand, tw * s), tr * s, ty * s); }
            ctx.font = f(2.6, true); ty += 3.4; ctx.direction = 'ltr'; ctx.textAlign = 'right'; ctx.fillText(fitText(ctx, it.sku, tw * s), tr * s, ty * s); ctx.direction = 'rtl';
            if (it.price) { ctx.font = f(2.4, true); ty += 3.2; ctx.fillText(fitText(ctx, it.price, tw * s), tr * s, ty * s); }
          }
          if (opts.border !== false) { ctx.strokeStyle = '#bbbbbb'; ctx.lineWidth = 2; ctx.strokeRect(x * s, y * s, t.w * s, t.h * s); }
        }
        var name = doc.addJpeg(canvasJpeg(cv, 0.92), cv.width, cv.height);
        var page = doc.addPage(210, 297); doc.drawImage(page, name, 0, 0, 210, 297);
        qrs.forEach(function (q) { doc.drawQr(page, q.m, q.x, q.y, q.size, 2); });
      }
      cv.width = 0; cv.height = 0;
      return { pdf: doc.output(), pages: nPages, perPage: g.perPage };
    });
  }

  var api = { PdfDoc: PdfDoc, renderFlow: renderFlow, renderLabels: renderLabels, LABELS: LABELS, labelGrid: labelGrid };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDF = api;
})(typeof self !== 'undefined' ? self : this);
