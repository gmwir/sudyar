/* v2.2 screens: supplier price lists (Excel/CSV) with smart matching + learning, and completing purchase costs.
   v2.4.1: the unit is the VARIANT as sold (a box of 2 = 1; a set = 1); a per-piece list price × pieces in the box = the
   variant price. «ست» rows match the set product only. */
(function () {
  'use strict';
  var A = window.App, E = A.E, DB = A.DB, UI = window.UI, h = UI.h, Core = window.Core, view = document.getElementById('view');
  var field = A.field, sel = A.sel;
  var COLS = {
    code: ['کد', 'کد کالا', 'کد قطعه', 'شماره فنی', 'شماره قطعه', 'part', 'part no', 'part number', 'code', 'sku', 'بارکد', 'barcode', 'ean'],
    name: ['نام', 'نام کالا', 'شرح', 'شرح کالا', 'عنوان', 'کالا', 'قطعه', 'نام قطعه', 'description', 'name', 'item', 'title'],
    brand: ['برند', 'مارک', 'سازنده', 'brand', 'make'],
    boxQty: ['تعداد در جعبه', 'تعداد در بسته', 'تعداد جعبه', 'بسته', 'جعبه', 'pack', 'box', 'qty box'],
    cartonQty: ['تعداد در کارتن', 'کارتن', 'carton', 'تعداد در کارتن مادر'],
    price: ['قیمت', 'فی', 'قیمت واحد', 'قیمت هر عدد', 'قیمت عدد', 'قیمت همکار', 'قیمت خرید', 'قیمت فروش', 'مبلغ', 'price', 'unit price', 'net']
  };
  var LBL = { code: 'کد', name: 'نام / شرح', brand: 'برند', boxQty: 'تعداد در جعبه', cartonQty: 'تعداد در کارتن', price: 'قیمت' };
  function normH(s) { return Core.normText(s).replace(/[‌_\-:()]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function autoMap(header) {
    var map = {}, used = {};
    Object.keys(COLS).forEach(function (k) {
      var syn = COLS[k].map(normH);
      header.forEach(function (hd, i) { if (map[k] == null && !used[i] && syn.indexOf(normH(hd)) >= 0) { map[k] = i; used[i] = 1; } });
    });
    if (map.price == null) header.forEach(function (hd, i) { if (map.price == null && !used[i] && /قیمت|price|فی/.test(normH(hd))) { map.price = i; used[i] = 1; } });
    return map;
  }
  function pct(a, b) { return b ? Math.round((a - b) / b * 100) : null; }
  function intOr(v) { var n = window.Match.parsePrice(v); return n != null && n >= 1 && n <= 9999 ? n : null; }

  // ======================= PRICE LIST =======================
  A.routes.pricelist = function () {
    A.setTitle('لیست قیمت', true);
    var st = { kind: 'buy', supplierId: null, date: UI.todayStr(), cur: null, per: null, map: null, header: null, rows: null, file: null, res: null, applyBox: true, rowAs: {}, priceOk: false }; // v2.8: currency / per-box are asked, never assumed
    var box = h('div');
    view.appendChild(h('div.card', h('p.small', 'لیست قیمت تأمین‌کننده را (Excel یا CSV) انتخاب کنید. برنامه هر ردیف را با کالاهای شما تطبیق می‌دهد: کد یکسان یا ردیفی که قبلاً تأیید کرده‌اید خودکار است؛ نام‌های شبیه را می‌پرسد و انتخاب شما را یاد می‌گیرد. ردیف‌هایی که در انبار شما نیستند کنار گذاشته می‌شوند.'),
      h('div.grid2', h('button.btn.primary', { onclick: choose }, 'انتخاب فایل'), h('button.btn', { onclick: template }, 'فایل نمونه'))));
    view.appendChild(box);
    function template() {
      UI.fileSheet(window.XLSX.writeXlsx([{ name: 'لیست قیمت', rows: [['کد', 'شرح', 'برند', 'تعداد در جعبه', 'تعداد در کارتن', 'قیمت'],
        ['A-405', 'سیبک زیر اکسل پژو ۴۰۵', 'ایساکو', 2, 24, 1250000], ['S-206-SET', 'سیبک فرمان پژو ۲۰۶ (ست)', 'ایساکو', 1, 20, 2900000]] }]), 'amiran-price-list-template.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
    function choose() {
      UI.pickFile('.xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').then(function (f) {
        if (!f) return;
        UI.readFileBytes(f).then(function (bytes) {
          var isX = /\.xlsx$/i.test(f.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
          var hashP = window.crypto && crypto.subtle ? crypto.subtle.digest('SHA-256', bytes).then(function (b) { return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }) : Promise.resolve('');
          return Promise.all([hashP, isX ? window.XLSX.readXlsx(bytes) : { sheets: [{ name: 'CSV', rows: window.XLSX.readCsv(bytes) }] }]);
        }).then(function (r) {
          var sheet = r[1].sheets.filter(function (s) { return s.rows.length; })[0]; if (!sheet) throw new Error('فایل خالی است.');
          var rows = sheet.rows, hi = 0; while (hi < rows.length && rows[hi].filter(function (c) { return String(c).trim(); }).length < 2) hi++;
          if (hi >= rows.length) throw new Error('ردیف عنوان ستون‌ها پیدا نشد.');
          st.header = rows[hi].map(function (c) { return String(c == null ? '' : c).trim(); }); st.rows = rows.slice(hi + 1).filter(function (rw) { return rw.some(function (c) { return String(c).trim(); }); });
          st.map = autoMap(st.header); st.file = { name: f.name, sha256: r[0] }; st.res = null; st.rowAs = {};
          st.priceCols = st.header.map(function (hd, i) { return /قیمت|price|فی|مبلغ|net/.test(normH(hd)) ? i : -1; }).filter(function (i) { return i >= 0; });
          st.priceOk = st.priceCols.length <= 1; draw();
        }).catch(function (e) { UI.toast('فایل خوانده نشد: ' + (e.message || e), 'bad'); });
      });
    }
    function draw() {
      UI.clear(box);
      if (!st.rows) return;
      var hdrOpts = { '-1': '— ندارد —' }; st.header.forEach(function (hd, i) { hdrOpts[i] = hd || ('ستون ' + UI.fa(i + 1)); });
      var mapCard = h('div.card', h('h2', 'ستون‌ها (' + UI.fa(st.rows.length) + ' ردیف)'));
      function sample(i) { return st.rows.slice(0, 3).map(function (rw) { return String(rw[i] == null ? '' : rw[i]).trim() || '—'; }).join(' · '); }
      Object.keys(LBL).forEach(function (k) { var s1 = sel(hdrOpts, st.map[k] == null ? '-1' : String(st.map[k]), { onchange: function () { st.map[k] = +s1.value < 0 ? null : +s1.value; if (k === 'price') st.priceOk = true; st.res = null; draw(); } });
        mapCard.appendChild(field(LBL[k], s1, st.map[k] != null ? h('div.hint', 'نمونه: ' + sample(st.map[k])) : null)); });
      if (!st.priceOk) mapCard.appendChild(h('div.alert.warn', h('div.grow', h('b', 'این فایل چند ستون قیمت دارد؛ کدام ستون قیمت ' + (st.kind === 'buy' ? 'خرید' : 'فروش') + ' است؟'),
        h('div.stack', st.priceCols.map(function (i) { return h('button.btn.sm' + (st.map.price === i ? '.primary' : ''), { onclick: function () { st.map.price = i; st.priceOk = true; st.res = null; draw(); } }, (st.header[i] || 'ستون ' + UI.fa(i + 1)) + ' — نمونه: ' + sample(i)); })))));
      var kindSel = sel({ buy: 'قیمت خرید (لیست تأمین‌کننده)', sell: 'قیمت فروش کالاهای من' }, st.kind, { onchange: function () { st.kind = kindSel.value; st.res = null; draw(); } });
      var curSel = sel({ '': '— انتخاب کنید —', toman: 'تومان', rial: 'ریال (÷۱۰)' }, st.cur || '', { onchange: function () { st.cur = curSel.value || null; st.res = null; drawResult(); } });
      var perSel = sel({ '': '— انتخاب کنید —', piece: 'هر عدد داخل جعبه (× تعداد در جعبه)', box: 'کل تنوع (جعبه / ست)' }, st.per || '', { onchange: function () { st.per = perSel.value || null; st.res = null; drawResult(); } }); // v2.4.1; v2.8: asked only when the list has «تعداد در جعبه» > 1
      var dateIn = h('input.in', { value: st.date, inputmode: 'numeric', 'data-date': 1, onchange: function () { st.date = dateIn.value; st.res = null; drawResult(); } });
      var brands = { '': '— انتخاب کنید —', '*': 'چند برند / برند در فایل نیست (بدون کنترل برند)' }; E.list('products').forEach(function (p) { if (p.brand) brands[p.brand] = p.brand; });
      var brandSel = st.map.brand == null ? sel(brands, st.listBrand || '', { onchange: function () { st.listBrand = brandSel.value || null; st.res = null; drawResult(); } }) : null; // v2.9: asked, never assumed
      var sp = st.supplierId && E.state.suppliers[st.supplierId];
      var supBtn = h('button.btn.block', { onclick: function () { A.pickSupplier(function (x) { st.supplierId = x.id; st.res = null; draw(); }); } }, sp ? 'تأمین‌کننده: ' + sp.name + ' (تغییر)' : '+ تأمین‌کننده (اختیاری؛ برای یادگیری کدهای او)');
      box.appendChild(mapCard);
      box.appendChild(h('div.card', field('نوع لیست', kindSel), brandSel ? field('برند کالاهای این لیست', brandSel, h('div.hint', 'فایل ستون برند ندارد. با انتخاب برند، ردیف‌ها فقط به کالای همان برند وصل می‌شوند.')) : null, h('div.grid2', field('واحد پول', curSel), field('قیمت لیست برای', perSel, h('div.hint', 'موجودی و قیمت در اپ برای هر تنوع است (یک جعبه = ۱). ردیف بدون «تعداد در جعبه» همان قیمت لیست را می‌گیرد.'))),
        st.kind === 'buy' ? field('تاریخ لیست', dateIn, h('div.hint', 'ورودهای بی‌قیمت، بهای خرید را از نزدیک‌ترین لیست می‌گیرند (اول همان تأمین‌کننده، بعد آخرین لیست پیش از تاریخ ورود).')) : null, supBtn));
      // the button stays in place; a change of the settings only clears the results (re-creating the button while the
      // date field loses focus would swallow the tap)
      var resBox = h('div');
      box.appendChild(h('button.btn.primary.block', { onclick: function () {
        if (!st.priceOk) { UI.toast('اول ستون قیمت را انتخاب کنید.', 'bad'); return; }
        if (st.map.price == null) { UI.toast('ستون قیمت را مشخص کنید.', 'bad'); return; }
        if (!st.cur) { UI.toast('واحد پول لیست (تومان یا ریال) را انتخاب کنید.', 'bad'); return; }
        if (st.map.brand == null && !st.listBrand) { UI.toast('برند کالاهای این لیست را انتخاب کنید (یا «چند برند»).', 'bad'); return; }
        var needPer = st.map.boxQty != null && st.rows.some(function (rw) { return intOr(rw[st.map.boxQty]) > 1; });
        if (needPer && !st.per) { UI.toast('مشخص کنید قیمت لیست برای هر عدد داخل جعبه است یا کل جعبه.', 'bad'); return; }
        run(); show(resBox);
      } }, 'تطبیق با کالاهای من'));
      box.appendChild(resBox);
      function drawResult() { UI.clear(resBox); if (st.res) show(resBox); }
    }
    function listTs() { var t = UI.parseDateInput(st.date || ''); return t == null || isNaN(t) ? Date.now() : Math.min(t + 12 * 3600e3, Date.now()); }
    function run() {
      var m = A.matcher(), M = st.map, out = [], seenP = {}, group = '', groups = [];
      st.rows.forEach(function (rw, i) {
        function cell(k) { return M[k] == null ? '' : rw[M[k]]; }
        var name = String(cell('name') || '').trim(), code = String(cell('code') || '').trim(), brand = String(cell('brand') || '').trim() || (st.listBrand && st.listBrand !== '*' ? st.listBrand : '');
        var pi = window.Match.parsePriceInfo(cell('price')), price = pi.value, bq = intOr(cell('boxQty')), cq = intOr(cell('cartonQty'));
        // v2.2.1: a title row (e.g. «۲۰۶») is the group of the rows below it
        // v2.3: a title alone in the first («کد») column, written in Persian, is a title too (e.g. «پژو ۲۰۶» or «متفرقه»)
        var lone = rw.filter(function (c) { return String(c == null ? '' : c).trim(); }).length === 1, codeTitle = lone && !name && /[\u0600-\u06FF]/.test(code);
        var hd = window.Match.headerText(rw, !!code && !codeTitle, price != null || pi.why === 'ambiguous' || pi.why === 'fraction');
        if (hd) { // v2.8: a title is certain only for a car / model, «گروه: …», or a Persian text alone in the code column; otherwise it is asked
          var sure = codeTitle || window.Match.carLike(hd) || /^(سر\s*گروه|گروه|دسته|خودرو)/.test(Core.normText(hd)), as = st.rowAs[i];
          if (as === 'title' || (sure && as !== 'item')) { group = hd; groups.push(hd); return; }
          if (as !== 'item') { out.push({ i: i, name: hd, raw: hd, askKind: true, r: { decision: 'none', candidates: [] }, ok: false }); return; }
          if (!name) name = hd;
        }
        if (!name && !code) return;
        if (price != null && st.cur === 'rial') { if (price % 10) { pi = { value: null, why: 'fraction' }; price = null; } else price = price / 10; } // v2.8: never rounds
        var unitP = price; // v2.4.1: the variant (box) is the unit: a per-piece list price × pieces in the box
        if (price != null && st.per === 'piece' && bq > 1) price = price * bq;
        var pk = !bq ? window.Match.packOf(name || code) : null; // v2.8: «۲ دست», «جفت» … in the name and no box column -> asked per row
        var full = window.Match.withGroup(name || code, group); // «سیبک فرمان راست» under «۲۰۶» -> «سیبک فرمان راست ۲۰۶»
        var r = m.match({ name: full, code: code, brand: brand, supplierId: st.supplierId });
        var x0 = { i: i, name: full, raw: name, code: code, brand: brand, group: group, price: price, listPrice: price, priceWhy: price == null ? pi.why || 'empty' : null, unitP: unitP, boxQty: bq, cartonQty: cq, r: r,
          pick: r.decision === 'auto' || r.decision === 'confirm' ? r.best.product.id : null, ok: r.decision === 'auto' && price != null && price > 0 };
        var pp = x0.pick && E.state.products[x0.pick], pn = pk ? pk.n : (!bq && pp && pp.boxQty > 1 ? pp.boxQty : null);
        if (pn && price != null) { x0.packN = pn; x0.packText = pk ? pk.text : 'جعبه ' + UI.fa(pn) + ' تایی'; x0.ok = false; } // which unit is the list price for? -> asked
        if (price != null && (price < 1000 || price > 2e9)) { x0.odd = true; x0.ok = false; } // v2.8: unusual amount (rial / toman?) -> asked
        out.push(x0);
      });
      st.groups = groups;
      // v2.2.1: rows not in the shop -> NEW products (defined from the list), unless the same name+brand already exists
      var seenNB = {};
      out.forEach(function (x) {
        if (x.r.decision !== 'none' || x.askKind) return;
        var key = window.Match.compact(x.name + ' ' + x.brand);
        if (seenNB[key] || E.findDuplicates({ sku: x.code, name: x.name, brand: x.brand }).length) { x.dupNew = true; return; }
        seenNB[key] = 1; x.isNew = true; x.ok = x.price != null && !x.packN && !x.odd;
        x.cls = A.classifier().guess(x.name, { brand: x.brand, group: x.group }); // v2.3: group + cars guessed, confirmed once per group
      });
      out.forEach(function (x) { if (x.pick) { if (seenP[x.pick]) x.dupOf = seenP[x.pick]; else seenP[x.pick] = x.i + 1; } });
      st.res = out;
    }
    function show(resBox) {
      UI.clear(resBox);
      var auto = st.res.filter(function (x) { return x.r.decision === 'auto'; }), ask = st.res.filter(function (x) { return x.r.decision === 'confirm'; }), none = st.res.filter(function (x) { return x.r.decision === 'none' && !x.askKind; });
      var kindQ = st.res.filter(function (x) { return x.askKind; }), packQ = st.res.filter(function (x) { return x.packN && !x.packAns && (x.pick || x.isNew); }), noPrice = st.res.filter(function (x) { return x.price == null && !x.askKind && (x.pick || x.isNew); });
      var isBuy = st.kind === 'buy';
      function cur(p) { return isBuy ? (E.replacementCost(p.id, null) || {}).unitCost : p.sellPrice; }
      function row(x) {
        var p = x.pick && E.state.products[x.pick], chk = h('input', { type: 'checkbox', checked: !!x.ok });
        chk.addEventListener('change', function () { if (chk.checked && (x.packN && !x.packAns || x.price == null)) { chk.checked = false; UI.toast('اول به سؤال این ردیف (واحد قیمت / قیمت) پاسخ دهید.', 'bad'); return; } x.ok = chk.checked; x.userOk = chk.checked; foot(); });
        var opts = { '': '— هیچ‌کدام —' }; x.r.candidates.forEach(function (c) { opts[c.product.id] = c.product.name + (c.product.brand ? ' — ' + c.product.brand : '') + ' (' + UI.fa(c.score) + '٪' + (c.conflict ? '، ⚠ ' + c.conflict.join('، ') : '') + ')'; });
        var pickSel = sel(opts, x.pick || '', { onchange: function () { x.pick = pickSel.value || null; x.ok = !!x.pick && x.price > 0; x.userPicked = true; show(resBox); } });
        var old = p ? cur(p) : null, ch = p && old ? pct(x.price, old) : null, warn = [];
        if (x.price == null || x.price <= 0) warn.push('قیمت ندارد');
        if (ch != null && Math.abs(ch) >= 50) { warn.push('تغییر ' + UI.fa(ch) + '٪ — تیک را خودتان بزنید'); if (!x.bigSeen) { x.bigSeen = true; if (!x.userOk) x.ok = false; chk.checked = x.ok; } }
        if (x.r.best && x.r.best.exact && !x.userPicked) warn.push('فقط نام یکسان است؛ تأیید کنید');
        if (x.odd) warn.push('مبلغ غیرعادی (ریال یا تومان؟) — بررسی و تیک بزنید');
        if (x.packN && !x.packAns) warn.push('واحد قیمت پاسخ داده نشده (بالا)');
        if (ch != null && old && x.price >= old * 7) warn.push('شاید ریال است');
        if (x.dupOf) warn.push('همان کالای ردیف ' + UI.fa(x.dupOf));
        if (isBuy && p && x.price > 0) { // v2.9: another list of (about) the same date says something else -> asked
          var lt = listTs(), oth = E.priceLists().filter(function (pl) { return Math.abs(pl.date - lt) < 36 * 3600e3 && pl.items[p.id] != null && pl.items[p.id] !== x.price; })[0];
          if (oth) { warn.push('لیست «' + oth.name + '» همین روز: ' + UI.money(oth.items[p.id]) + ' — کدام درست است؟ تیک را خودتان بزنید'); if (!x.othSeen) { x.othSeen = true; if (!x.userOk) x.ok = false; chk.checked = x.ok; } }
        }
        if (p && x.r.best && x.r.best.product.id === p.id && x.r.best.conflict) warn.push(x.r.best.conflict.join('، '));
        return h('div.line', h('label.row', chk, h('div.grow', h('b', x.name || x.code), h('div.small.muted', [x.code, x.brand, x.boxQty > 1 ? 'جعبه ' + UI.fa(x.boxQty) + ' تایی' : ''].filter(Boolean).join(' · ')))),
          x.r.decision === 'auto' && !x.userPicked ? h('div.small', '← ' + (p ? p.name : '') + ' (' + (x.r.best.why || []).join('، ') + ')') : pickSel,
          h('div.small', 'قیمت تنوع: ', h('b', x.price != null ? UI.moneyT(x.price) : '—'), x.boxQty > 1 && x.price != null && x.unitP !== x.price ? ' (' + UI.fa(x.boxQty) + ' × ' + UI.money(x.unitP) + ')' : '', old != null ? ' · قبلی: ' + UI.money(old) : ''),
          warn.length ? h('div.hint', { style: { color: 'var(--warn)' } }, '⚠ ' + warn.join(' · ')) : null);
      }
      var sumBox = h('div');
      // v2.9: a row of brand A matched only by a product of brand B -> «are A and B the same brand?» (never assumed)
      var pairs = {}; st.noAlias = st.noAlias || {};
      st.res.forEach(function (x) {
        if (!x.brand || x.askKind) return;
        var c = (x.r.candidates || []).filter(function (c) { return c.conflict && c.conflict.every(function (t) { return /^برند /.test(t); }); })[0];
        if (!c || !c.product.brand || (x.pick && !(x.r.best && x.r.best.conflict))) return;
        var k = x.brand + '\u0000' + c.product.brand; if (st.noAlias[k]) return;
        (pairs[k] = pairs[k] || { a: x.brand, b: c.product.brand, n: 0 }).n++;
      });
      var PK = Object.keys(pairs).filter(function (k) { return pairs[k].n >= 2; });
      if (PK.length) resBox.appendChild(h('div.card', h('h2', 'این برندها یکی هستند؟'),
        h('p.small.muted', 'ردیف‌های این برند فقط با کالاهای برند دیگری جور شده‌اند. اگر هر دو نام یک برند است تأیید کنید (یاد گرفته می‌شود)؛ وگرنه این ردیف‌ها به آن کالاها وصل نمی‌شوند.'),
        PK.map(function (k) { var pr = pairs[k];
          return h('div.line.row', h('div.grow', '«' + pr.a + '» و «' + pr.b + '» — ' + UI.fa(pr.n) + ' ردیف'),
            h('button.btn.sm', { onclick: function () {
              var al = Object.assign({}, E.getMeta('brandAlias') || {}), x = window.Match.compact(pr.a), y = window.Match.compact(pr.b), g = al[y] || al[x] || y;
              Object.keys(al).forEach(function (kk) { if (al[kk] === al[x] || al[kk] === al[y]) al[kk] = g; }); al[x] = g; al[y] = g;
              A.run(function () { return E.putMeta('brandAlias', al, A.userCtx()); }).then(function () { run(); show(resBox); }, function () {});
            } }, 'بله، یکی‌اند'),
            h('button.btn.sm.ghost', { onclick: function () { st.noAlias[k] = 1; show(resBox); } }, 'نه'));
        })));
      // v2.8: questions first — nothing ambiguous is decided by the app
      if (kindQ.length) resBox.appendChild(h('div.card', h('h2', 'ردیف‌های مبهم (' + UI.fa(kindQ.length) + ')'),
        h('p.small.muted', 'این ردیف‌ها فقط یک نوشته دارند و قیمت یا کد ندارند. عنوان گروهِ ردیف‌های زیرشان است یا کالای بی‌قیمت؟'),
        h('div.row', h('button.btn.sm', { onclick: function () { kindQ.forEach(function (x) { st.rowAs[x.i] = 'title'; }); run(); show(resBox); } }, 'همه عنوان‌اند'),
          h('button.btn.sm', { onclick: function () { kindQ.forEach(function (x) { st.rowAs[x.i] = 'item'; }); run(); show(resBox); } }, 'همه کالا هستند')),
        kindQ.slice(0, 200).map(function (x) {
          return h('div.line.row', h('b.grow', x.name + ' (ردیف ' + UI.fa(x.i + 1) + ')'), h('button.btn.sm', { onclick: function () { st.rowAs[x.i] = 'title'; run(); show(resBox); } }, 'عنوان'),
            h('button.btn.sm', { onclick: function () { st.rowAs[x.i] = 'item'; run(); show(resBox); } }, 'کالا'));
        })));
      if (packQ.length) {
        var setPack = function (x, mul) { x.packAns = mul ? 'unit' : 'pack'; x.boxQty = x.packN; x.price = mul ? x.listPrice * x.packN : x.listPrice; x.unitP = x.listPrice; if (!x.odd && (x.pick || x.isNew)) x.ok = x.isNew || x.r.decision === 'auto' || x.userPicked || x.ok; };
        resBox.appendChild(h('div.card', h('h2', 'قیمت لیست برای چه واحدی است؟ (' + UI.fa(packQ.length) + ')'),
          h('p.small.muted', 'در اپ موجودی و قیمت برای کل تنوع (بسته) است. اگر لیست قیمت هر دست / هر عدد را نوشته، قیمت بسته = قیمت × تعداد.'),
          h('div.row', h('button.btn.sm', { onclick: function () { packQ.forEach(function (x) { setPack(x, true); }); show(resBox); } }, 'همه: قیمت هر واحد است (× تعداد)'),
            h('button.btn.sm', { onclick: function () { packQ.forEach(function (x) { setPack(x, false); }); show(resBox); } }, 'همه: قیمت کل بسته است')),
          packQ.slice(0, 200).map(function (x) {
            return h('div.line', h('b', x.name), h('div.small.muted', '«' + x.packText + '» · قیمت لیست ' + UI.money(x.listPrice)),
              h('div.row', h('button.btn.sm', { onclick: function () { setPack(x, true); show(resBox); } }, 'هر واحد ← بسته ' + UI.money(x.listPrice * x.packN)),
                h('button.btn.sm', { onclick: function () { setPack(x, false); show(resBox); } }, 'کل بسته ' + UI.money(x.listPrice))));
          })));
      }
      if (noPrice.length) resBox.appendChild(h('div.card', h('h2', 'قیمت خوانده نشد (' + UI.fa(noPrice.length) + ')'),
        h('p.small.muted', 'این ردیف‌ها ثبت نمی‌شوند مگر قیمت را خودتان بنویسید.'),
        noPrice.slice(0, 200).map(function (x) {
          var mi = A.moneyInput(null, 'قیمت (تومان)'), raw = st.map.price == null ? '' : String(st.rows[x.i][st.map.price] == null ? '' : st.rows[x.i][st.map.price]);
          mi.input.addEventListener('change', function () { var v = mi.value(); if (v > 0) { x.price = v; x.listPrice = v; x.priceWhy = null; x.ok = !!(x.pick || x.isNew); x.userOk = true; } });
          return h('div.line', h('b', x.name), h('div.small', { style: { color: 'var(--warn)' } }, 'در فایل: «' + (raw || '—') + '» — ' + (window.Match.PRICE_WHY[x.priceWhy] || 'نامشخص')), mi.input, mi.hint);
        }), h('button.btn.sm', { onclick: function () { show(resBox); } }, 'اعمال قیمت‌های نوشته‌شده')));
      resBox.appendChild(h('div.card', h('div.tot', h('span', 'خودکار (کد یکسان یا قبلاً تأییدشده)'), h('b', UI.fa(auto.length))), h('div.tot', h('span', 'نیاز به تأیید شما'), h('b', UI.fa(ask.length))), h('div.tot', h('span', 'کالای جدید (تعریف از لیست)'), h('b', UI.fa(none.filter(function (x) { return x.isNew; }).length)))));
      if (ask.length) resBox.appendChild(h('div.card', h('div.row.between', h('h2', 'نیاز به تأیید (' + UI.fa(ask.length) + ')'),
        h('button.btn.sm', { onclick: function () { ask.forEach(function (x) { if (x.pick && x.price > 0 && !(x.r.best && x.r.best.conflict)) x.ok = true; }); show(resBox); } }, 'تأیید همه پیشنهادها')),
        h('p.small.muted', 'کالای پیشنهادی را بررسی و تیک بزنید. انتخاب شما یاد گرفته می‌شود و دفعه بعد همین ردیف خودکار تطبیق می‌شود.'), ask.slice(0, 300).map(row)));
      if (auto.length) resBox.appendChild(h('div.card', h('h2', 'خودکار (' + UI.fa(auto.length) + ')'), auto.slice(0, 300).map(row)));
      if (st.groups && st.groups.length) resBox.appendChild(h('div.card', h('div.small', 'سرگروه‌های شناسایی‌شده (خودرو یا راهنمای گروه ردیف‌های زیرشان): ', h('b', st.groups.slice(0, 30).join('، ') + (st.groups.length > 30 ? '…' : '')))));
      var news = none.filter(function (x) { return x.isNew; });
      if (news.length) {
        resBox.appendChild(A.groupCard(news, function () { show(resBox); }, { title: 'گروه کالاهای جدید' })); // v2.3
        var nl = h('div'), allChk = h('input', { type: 'checkbox', checked: news.every(function (x) { return x.ok; }) });
        allChk.addEventListener('change', function () { news.forEach(function (x) { x.ok = allChk.checked && x.price != null && !(x.packN && !x.packAns); }); show(resBox); });
        resBox.appendChild(h('div.card', h('h2', 'کالاهای جدید — از این لیست تعریف می‌شوند (' + UI.fa(news.length) + ')'),
          h('p.small.muted', 'این ردیف‌ها در برنامه نیستند. با «ثبت»، با نام، برند، کد (یا کد خودکار)، گروه بالا، خودرو و تعداد در جعبه، با موجودی صفر تعریف می‌شوند' + (st.kind === 'buy' ? ' و قیمتشان در لیست خرید ذخیره می‌شود.' : ' و قیمت فروششان ثبت می‌شود.') + ' بعداً با اسکن، بارکد جعبه را یک بار به آن‌ها وصل کنید.'),
          h('label.check', allChk, 'تعریف همه'), nl));
        news.slice(0, 300).forEach(function (x) {
          var c = h('input', { type: 'checkbox', checked: !!x.ok }); c.addEventListener('change', function () { if (c.checked && (x.price == null || x.packN && !x.packAns)) { c.checked = false; UI.toast('اول به سؤال این ردیف پاسخ دهید.', 'bad'); return; } x.ok = c.checked; foot(); });
          nl.appendChild(h('label.line.row', c, h('div.grow', h('b', x.name), h('div.small.muted', [x.code || 'کد خودکار', x.brand, x.cls && x.cls.cars.length ? 'خودرو: ' + x.cls.cars.join('، ') : '', x.boxQty > 1 ? 'جعبه ' + UI.fa(x.boxQty) + ' تایی' : ''].filter(Boolean).join(' · '))),
            h('div.small', x.price != null ? UI.money(x.price) : '—', x.boxQty > 1 && x.unitP !== x.price ? h('div.muted', UI.fa(x.boxQty) + ' × ' + UI.money(x.unitP)) : null, x.packN && !x.packAns ? h('div', { style: { color: 'var(--warn)' } }, 'واحد قیمت؟') : null)));
        });
      }
      var dupN = none.filter(function (x) { return x.dupNew; }).length;
      if (dupN) resBox.appendChild(h('div.card.small.muted', UI.fa(dupN) + ' ردیف تکراری یا هم‌نام با کالای موجود بود و جدا تعریف نشد.'));
      // cost completion of earlier receipts without cost (30-day rule)
      var comp = isBuy ? completions() : [];
      st.comp = comp;
      if (comp.length) resBox.appendChild(h('div.card', h('h2', 'تکمیل بهای خرید ورودهای قبلی (' + UI.fa(comp.length) + ')'),
        h('p.small.muted', 'این ورودها بدون بهای خرید ثبت شده‌اند و این لیست نزدیک‌ترین لیست به تاریخ آن‌هاست؛ با ثبت، بهایشان از همین لیست تکمیل می‌شود (سند جدید با تاریخ امروز، با رمز مدیر). ردیف‌هایی که با بهای قبلی کالا خیلی فرق دارند تیک نخورده‌اند.'),
        comp.map(function (c) {
          var chk = h('input', { type: 'checkbox', checked: c.ok }); chk.addEventListener('change', function () { c.ok = chk.checked; foot(); });
          return h('label.line.row', chk, h('div.grow', h('b', c.cand.name), h('div.small.muted', c.cand.srcNo + ' · ' + UI.dateFa(c.cand.ts) + ' · ' + UI.qty(c.cand.qty) + ' عدد (' + UI.qty(c.cand.inStock) + ' در انبار)')),
            h('div.small', UI.money(c.price), c.warn ? h('div', { style: { color: 'var(--warn)' } }, c.warn) : null));
        })));
      resBox.appendChild(sumBox);
      function foot() {
        UI.clear(sumBox);
        var n = st.res.filter(function (x) { return x.ok && x.pick && x.price > 0; }).length, nc = (st.comp || []).filter(function (c) { return c.ok; }).length, nn = st.res.filter(function (x) { return x.ok && x.isNew; }).length;
        var wait = kindQ.length + st.res.filter(function (x) { return x.packN && !x.packAns && (x.pick || x.isNew); }).length + st.res.filter(function (x) { return x.price == null && !x.askKind && (x.pick || x.isNew); }).length;
        if (wait) sumBox.appendChild(h('div.alert.warn', UI.fa(wait) + ' ردیف منتظر پاسخ شماست و ثبت نمی‌شود (سؤال‌های بالا).'));
        sumBox.appendChild(h('div.sticky-act', h('button.btn.primary.block', { disabled: !n && !nc && !nn, onclick: apply }, 'ثبت ' + UI.fa(n) + ' قیمت' + (nn ? ' + تعریف ' + UI.fa(nn) + ' کالا' : '') + (nc ? ' + تکمیل بهای ' + UI.fa(nc) + ' ورود' : ''))));
      }
      foot();
    }
    function chosen() {
      var by = {};
      st.res.forEach(function (x) { if (x.ok && x.pick && x.price > 0 && E.state.products[x.pick]) by[x.pick] = x; }); // the last row of a product wins
      return Object.keys(by).map(function (k) { return by[k]; });
    }
    function completions() {
      var t = listTs(), price = {}, me = { date: t, supplierId: st.supplierId, createdAt: Date.now() };
      chosen().forEach(function (x) { price[x.pick] = x.price; });
      return E.costCandidates().filter(function (c) { // the engine's rule: same supplier first, then the nearest list (no age limit)
        if (c.ts == null || price[c.productId] == null) return false;
        var s = c.suggestion; if (!s) return true;
        return !E.rankLess(E.listRank({ date: s.date, supplierId: s.supplierId, createdAt: 0 }, c.ts, c.supplierId), E.listRank(me, c.ts, c.supplierId));
      }).map(function (c) {
        var p = E.state.products[c.productId], ref = p && p.costedQty ? Math.round(p.costBasis / p.costedQty) : (E.replacementCost(c.productId, null) || {}).unitCost, pr = price[c.productId];
        var far = ref && (pr > ref * 1.5 || pr < ref * 0.6);
        return { cand: c, price: pr, ok: !far, warn: far ? 'با بهای قبلی (' + UI.money(ref) + ') فاصله زیادی دارد' : '' };
      });
    }
    function apply() {
      var rows = chosen(), isBuy = st.kind === 'buy', price = {}; rows.forEach(function (x) { price[x.pick] = x.price; });
      var comp = (st.comp || []).filter(function (c) { return c.ok && price[c.cand.productId] === c.price; }); // only rows still selected in the list
      var learnE = []; rows.forEach(function (x) { if (x.r.decision !== 'auto' || x.userPicked) A.matcher().learnKeys({ name: x.name, code: x.code, brand: x.brand, supplierId: st.supplierId }).forEach(function (key) { learnE.push({ key: key, productId: x.pick }); }); });
      var boxUpd = rows.filter(function (x) { var p = E.state.products[x.pick]; return (x.boxQty && x.boxQty !== (p.boxQty || 1)) || (x.cartonQty && x.cartonQty !== (p.cartonQty || null)); });
      (comp.length ? A.manager('تکمیل بهای خرید') : Promise.resolve(A.userCtx())).then(function (ctx) {
        if (!ctx) return;
        var key = UI.opKey('pl'), steps = [], news = st.res.filter(function (x) { return x.ok && x.isNew; }), newIdx = [], usedSku = {};
        // v2.3: groups of the new items (the confirmed path; missing levels created), then the new products
        var G = A.planGroups(news, steps, ctx);
        news.forEach(function (x) {
          var base = window.Match.codeNorm(x.group || 'P').replace(/[^0-9A-Zا-ی]/g, '').slice(0, 8) || 'P', sku = x.code, n = 0;
          if (!sku || E.findProductBySku(sku) || usedSku[Core.normSku(sku)]) { do { n++; sku = base + '-' + ('00' + n).slice(-3); } while (E.findProductBySku(sku) || usedSku[Core.normSku(sku)]); }
          usedSku[Core.normSku(sku)] = 1;
          newIdx.push({ x: x, step: steps.length });
          steps.push(function (dn) {
            return E.createProduct({ sku: sku, name: x.name, brand: x.brand, categoryId: G.catId(x, dn), cars: x.cls ? x.cls.cars : undefined, boxQty: x.boxQty > 1 ? x.boxQty : undefined, cartonQty: x.cartonQty > 1 ? x.cartonQty : undefined,
              sellPrice: !isBuy && x.price > 0 ? x.price : null, source: 'pricelist' }, ctx);
          });
        });
        if (isBuy) steps.push(function (dn) {
          var items = rows.map(function (x) { return { productId: x.pick, price: x.price }; });
          newIdx.forEach(function (o) { if (o.x.price > 0) items.push({ productId: dn[o.step].product.id, price: o.x.price }); });
          return items.length ? E.savePriceList({ opKey: key, date: listTs(), supplierId: st.supplierId, name: st.file.name.replace(/\.[^.]+$/, ''), currency: st.cur, file: st.file, items: items }, ctx) : { changes: [] };
        });
        else rows.forEach(function (x) { if (E.state.products[x.pick].sellPrice !== x.price) steps.push(function () { return E.updateProduct(x.pick, { sellPrice: x.price, reason: 'لیست قیمت ' + st.file.name }, ctx); }); });
        boxUpd.forEach(function (x) { var pt = {}; if (x.boxQty) pt.boxQty = x.boxQty; if (x.cartonQty) pt.cartonQty = x.cartonQty; steps.push(function () { return E.updateProduct(x.pick, pt, ctx); }); });
        if (learnE.length) steps.push(function () { return E.learn(learnE, ctx); });
        if (newIdx.length) steps.push(function (dn) { // v2.8: a product defined from a row is that row's answer -> recognised next time without asking
          var L = []; newIdx.forEach(function (o) { var pr = dn[o.step] && dn[o.step].product; if (pr) A.matcher().learnKeys({ name: o.x.name, code: o.x.code, brand: o.x.brand, supplierId: st.supplierId }).forEach(function (k) { L.push({ key: k, productId: pr.id }); }); });
          return L.length ? E.learn(L, ctx) : { changes: [] };
        });
        if (news.length) steps.push(G.learnStep); // v2.3: the confirmed groups are learned
        if (comp.length) steps.push(function (dn) { var pl = (dn.filter(function (r) { return r && r.priceList; })[0] || {}).priceList; return E.completeCosts({ opKey: key + ':c', reason: 'از لیست قیمت ' + st.file.name, items: comp.map(function (c) { return { srcDocId: c.cand.srcDocId, productId: c.cand.productId, unitCost: c.price, listId: pl ? pl.id : null }; }) }, ctx); });
        if (!steps.length) { UI.toast('چیزی برای ثبت نیست.'); return; }
        steps.push(function (dn) { return E.recordImport({ kind: 'pricelist', label: (isBuy ? 'لیست قیمت خرید' : 'قیمت فروش') + ' — ' + st.file.name, file: st.file }, dn, ctx); }); // v2.2.2: can be undone
        A.run(DB.batch(steps)).then(function (res) {
          var plNew = (res || []).filter(function (r) { return r && r.priceList; })[0]; // v2.4: next step = sale prices from this list
          UI.toast(UI.fa(rows.length) + ' قیمت ثبت شد' + (news.length ? '؛ ' + UI.fa(news.length) + ' کالای جدید تعریف شد' : '') + (comp.length ? '؛ بهای ' + UI.fa(comp.length) + ' ورود تکمیل شد' : '') + (learnE.length ? '؛ تطبیق‌ها یاد گرفته شد' : '') + '.', 'ok', 3500);
          A.go(isBuy ? (plNew ? '#/markup/' + encodeURIComponent(plNew.priceList.id) : '#/pricelists') : '#/products');
        }, function () {});
      });
    }
  };

  // ======================= saved purchase price lists =======================
  A.routes.pricelists = function () {
    A.setTitle('لیست‌های قیمت خرید', true);
    var L = E.priceLists().slice().reverse();
    view.appendChild(h('div.grid2', { style: { margin: '10px 0' } }, h('a.btn.primary', { href: '#/pricelist' }, '+ بارگذاری لیست قیمت'), h('a.btn', { href: '#/imports' }, 'سابقه و بازگرداندن')));
    if (!L.length) { view.appendChild(h('div.card.empty', 'هنوز لیست قیمتی ثبت نشده است.')); return; }
    // v2.9: the same product priced differently by two lists of (about) the same date — one of them is wrong; the user chooses
    var CF = []; L.forEach(function (a, i) { L.slice(i + 1).forEach(function (b) { if (Math.abs(a.date - b.date) >= 36 * 3600e3) return;
      Object.keys(a.items).forEach(function (pid) { if (b.items[pid] != null && b.items[pid] !== a.items[pid] && E.state.products[pid]) CF.push({ p: E.state.products[pid], a: a, b: b }); }); }); });
    if (CF.length) view.appendChild(h('div.card', h('h2', 'اختلاف قیمت بین لیست‌های هم‌تاریخ (' + UI.fa(CF.length) + ')'),
      h('p.small.muted', 'یک کالا در دو لیست نزدیک به هم دو قیمت دارد (مثلاً ردیفِ برند دیگری به این کالا وصل شده). قیمت اشتباه را از همان لیست حذف کنید؛ «قیمت خرید امروز» از لیست درست می‌آید. بعد از اصلاح، قیمت فروش را از صفحه «قیمت فروش» همان لیست دوباره بسازید.'),
      CF.slice(0, 200).map(function (x) {
        function rm(pl) { A.manager('حذف قیمت از لیست قیمت').then(function (ctx) { if (ctx) A.run(function () { return E.removePriceListItems(pl.id, [x.p.id], ctx); }).then(function () { UI.toast('حذف شد.', 'ok'); A.route(); }, function () {}); }); }
        return h('div.line', h('b', x.p.name + (x.p.brand ? ' — ' + x.p.brand : '')),
          h('div.row', h('button.btn.sm', { onclick: function () { rm(x.a); } }, 'حذف ' + UI.money(x.a.items[x.p.id]) + ' از «' + x.a.name + '»'),
            h('button.btn.sm', { onclick: function () { rm(x.b); } }, 'حذف ' + UI.money(x.b.items[x.p.id]) + ' از «' + x.b.name + '»')));
      })));
    view.appendChild(h('div.list', L.map(function (pl) {
      var sp = pl.supplierId && E.state.suppliers[pl.supplierId];
      return h('div.li', h('div.grow', h('div.t', pl.name || 'لیست قیمت'), h('div.s', [UI.dateFa(pl.date), sp ? sp.name : '', UI.fa(pl.count) + ' کالا'].filter(Boolean).join(' · '))),
        h('a.btn.sm', { href: '#/markup/' + encodeURIComponent(pl.id) }, 'قیمت فروش'), // v2.4
        h('button.btn.sm.ghost', { onclick: function () { // v2.2.2
          var rec = E.importRecords().filter(function (r) { return !r.undoneAt && r.plists.indexOf(pl.id) >= 0; })[0];
          if (rec) { A.go('#/imports'); UI.toast('برای برگرداندن قیمت‌ها و کالاهای این لیست، همان ورود را «بازگردانی» کنید.'); return; }
          UI.confirmBox('لیست «' + (pl.name || '') + '» حذف شود؟ (قیمت‌های این لیست دیگر برای بهای خرید پیشنهاد نمی‌شوند.)', 'حذف', true).then(function (ok) {
            if (ok) A.manager('حذف لیست قیمت').then(function (ctx) { if (ctx) A.run(function () { return E.deletePriceList(pl.id, ctx); }).then(function () { UI.toast('حذف شد.', 'ok'); A.route(); }, function () {}); });
          });
        } }, 'حذف'));
    })));
  };

  // ======================= v2.2.2 import history + undo =======================
  A.routes.imports = function () {
    A.setTitle('سابقه ورود از فایل', true);
    view.appendChild(h('div.card', h('p.small', 'هر لیست قیمت یا لیست کالایی که از فایل وارد کرده‌اید اینجاست. «بازگرداندن» همه اثرهای آن را برمی‌گرداند: لیست حذف، قیمت‌ها و تعداد جعبه به مقدار قبل، کالاها و گروه‌های ساخته‌شده حذف (یا اگر سابقه دارند غیرفعال)، موجودی اولیه لغو، تکمیل بها و یادگیری‌ها برگردانده می‌شود. چیزی که بعداً دوباره تغییر کرده یا فروش رفته دست نمی‌خورد و دلیلش نشان داده می‌شود.')));
    var R = E.importRecords();
    if (!R.length) { view.appendChild(h('div.card.empty', 'هنوز ورودی از فایل ثبت نشده است (ورودهای پیش از نسخه ۲٫۲٫۲ اینجا نیستند).')); return; }
    view.appendChild(h('div.list', R.map(function (r) {
      var cnt = [r.products.length ? UI.fa(r.products.length) + ' کالای جدید' : '', r.changed.length ? UI.fa(r.changed.length) + ' کالای تغییرکرده' : '', r.plists.length ? 'لیست قیمت' : '', r.receipts.length ? 'موجودی اولیه' : '', r.costs.length ? 'تکمیل بها' : ''].filter(Boolean).join(' · ');
      return h('div.li', h('div.grow', h('div.t', r.label || r.kind), h('div.s', UI.dateFa(r.at, true) + ' · ' + (cnt || '—') + (r.undoneAt ? ' · بازگردانده شد ' + UI.dateFa(r.undoneAt) : ''))),
        r.undoneAt ? null : h('button.btn.sm', { onclick: function () { undo(r); } }, 'بازگرداندن'));
    })));
    function undo(r) {
      var plan = E.undoImportPlan(r.id), lines = [];
      if (plan.receipts.length) lines.push(UI.fa(plan.receipts.length) + ' سند موجودی اولیه لغو می‌شود');
      if (plan.products.del.length) lines.push(UI.fa(plan.products.del.length) + ' کالا حذف می‌شود');
      if (plan.products.off.length) lines.push(UI.fa(plan.products.off.length) + ' کالا (دارای سابقه) غیرفعال می‌شود');
      if (plan.fields.length) lines.push(UI.fa(plan.fields.length) + ' مقدار (قیمت، تعداد جعبه…) به قبل برمی‌گردد');
      if (plan.plists.length) lines.push('لیست قیمت حذف می‌شود');
      if (plan.costs.length) lines.push('تکمیل بهای خرید برگردانده می‌شود');
      if (plan.categories.length) lines.push('گروه‌های ساخته‌شده (اگر خالی شوند) حذف می‌شوند');
      var s = UI.sheet('بازگرداندن ورود', h('div.stack', h('b', r.label || ''), h('ul', lines.map(function (x) { return h('li', x); })),
        plan.skips.length ? h('div.alert.warn', h('div.grow', h('b', 'دست نمی‌خورد: '), plan.skips.slice(0, 20).join('؛ '))) : null,
        h('button.btn.danger.block', { onclick: function () {
          s.close();
          A.manager('بازگرداندن ورود از فایل').then(function (ctx) {
            if (!ctx) return;
            var key = UI.opKey('undo'), steps = plan.receipts.map(function (did, i) { return function () { return E.reverseDoc(did, { opKey: key + ':' + i, reason: 'بازگرداندن ورود از فایل' }, ctx); }; });
            steps.push(function () { return E.undoImport(r.id, ctx); });
            A.run(DB.batch(steps)).then(function () { UI.toast('بازگردانده شد.', 'ok'); A.route(); }, function () {});
          });
        } }, 'بازگرداندن (با رمز مدیر)')));
    }
  };

  // ======================= v2.4 SALE PRICES FROM A PURCHASE LIST =======================
  /* sale price = list price × (1 + percent), rounded UP to the next 1,000 Toman (never below the chosen margin).
     Percent per brand; a group may have its own percent (it wins over the brand). The percents are remembered
     (meta «markup»), so next time only new brands / groups are empty. Undone from the import history. */
  function sellOf(cost, pct) { return Math.ceil(cost * (100 + pct) / 100 / 1000 - 1e-9) * 1000; }
  A.sellOf = sellOf;
  A.routes.markup = function (id) {
    A.setTitle('قیمت فروش از لیست خرید', true);
    var pl = E.priceLists().filter(function (x) { return x.id === id; })[0];
    if (!pl) { view.appendChild(h('div.card.empty', 'لیست قیمت پیدا نشد.')); return; }
    var cfg = E.getMeta('markup') || {}; cfg = { brands: cfg.brands || {}, groups: cfg.groups || {} };
    var N = Core.normText, rows = Object.keys(pl.items || {}).map(function (pid) { return { p: E.state.products[pid], cost: pl.items[pid] }; })
      .filter(function (r) { return r.p && r.p.active !== false && r.cost > 0; });
    var brands = {}, groups = {};
    rows.forEach(function (r) { var b = r.p.brand || ''; brands[N(b)] = brands[N(b)] || b; if (r.p.categoryId) groups[r.p.categoryId] = 1; });
    var bIn = {}, gIn = {};
    function inp(v) { return h('input.in', { inputmode: 'decimal', value: v == null ? '' : UI.fa(v), placeholder: '٪', style: { maxWidth: '90px' } }); }
    view.appendChild(h('div.card', h('b', pl.name || 'لیست قیمت'), h('div.small.muted', UI.dateFa(pl.date) + ' · ' + UI.fa(rows.length) + ' کالا'),
      h('p.small', 'قیمت فروش = قیمت این لیست × (۱ + درصد سود)، رو به بالا تا ۱٬۰۰۰ تومان. درصد گروه (اگر پر شود) بر درصد برند مقدم است. درصدها ذخیره می‌شوند و دفعه بعد آماده‌اند.')));
    view.appendChild(h('div.card', h('h2', 'درصد سود هر برند'), Object.keys(brands).sort().map(function (k) {
      bIn[k] = inp(cfg.brands[k]); return h('div.row', { style: { margin: '6px 0' } }, h('div.grow', brands[k] || '— بدون برند —'), bIn[k]);
    })));
    var gk = Object.keys(groups).sort(function (a, b) { return E.categoryPath(a).join('›').localeCompare(E.categoryPath(b).join('›'), 'fa'); });
    if (gk.length) view.appendChild(h('div.card', h('h2', 'درصد جدا برای گروه (اختیاری)'), h('p.small.muted', 'خالی = درصد برند.'), gk.map(function (cid) {
      gIn[cid] = inp(cfg.groups[cid]); return h('div.row', { style: { margin: '6px 0' } }, h('div.grow.small', E.categoryPath(cid).slice(-2).join(' › ')), gIn[cid]);
    })));
    var res = h('div'); view.appendChild(h('button.btn.primary.block', { onclick: calc }, 'محاسبه قیمت‌ها')); view.appendChild(res);
    function pctOf(el) { var t = String(el.value || '').trim(); if (!t) return null; var n = UI.parseNum(t); return n == null || isNaN(n) || n < 0 || n > 1000 ? NaN : n; }
    function calc() {
      var bad = false, nb = {}, ng = {};
      Object.keys(bIn).forEach(function (k) { var v = pctOf(bIn[k]); if (v !== v) bad = true; else if (v != null) nb[k] = v; });
      Object.keys(gIn).forEach(function (k) { var v = pctOf(gIn[k]); if (v !== v) bad = true; else if (v != null) ng[k] = v; });
      UI.clear(res);
      if (bad) { UI.toast('درصد باید عددی بین ۰ تا ۱۰۰۰ باشد.', 'bad'); return; }
      var out = [], skip = 0;
      rows.forEach(function (r) {
        var pct = r.p.categoryId && ng[r.p.categoryId] != null ? ng[r.p.categoryId] : nb[N(r.p.brand || '')];
        if (pct == null) { skip++; return; }
        var sp = sellOf(r.cost, pct); if (sp !== r.p.sellPrice) out.push({ p: r.p, cost: r.cost, pct: pct, sell: sp });
      });
      res.appendChild(h('div.card', h('div.tot', h('span', 'تغییر قیمت فروش'), h('b', UI.fa(out.length))), skip ? h('div.tot', h('span', 'بدون درصد (دست نمی‌خورد)'), h('b', UI.fa(skip))) : null,
        out.slice(0, 200).map(function (x) { return h('div.line', h('b', x.p.name), h('div.small', 'خرید ' + UI.money(x.cost) + ' + ' + UI.fa(x.pct) + '٪ ← فروش ', h('b', UI.moneyT(x.sell)), x.p.sellPrice != null ? ' (قبلی ' + UI.money(x.p.sellPrice) + ')' : '')); })));
      if (!out.length) return;
      res.appendChild(h('div.sticky-act', h('button.btn.primary.block', { onclick: function () {
        var ctx = A.userCtx(), keep = { brands: Object.assign({}, cfg.brands, nb), groups: Object.assign({}, cfg.groups, ng) };
        var steps = [function () { return E.putMeta('markup', keep, ctx); }].concat(out.map(function (x) { return function () { return E.updateProduct(x.p.id, { sellPrice: x.sell, reason: 'قیمت فروش از لیست ' + (pl.name || '') + ' + ' + x.pct + '٪' }, ctx); }; }));
        steps.push(function (dn) { return E.recordImport({ kind: 'markup', label: 'قیمت فروش از لیست — ' + (pl.name || '') }, dn, ctx); });
        A.run(DB.batch(steps)).then(function () { UI.toast('قیمت فروش ' + UI.fa(out.length) + ' کالا ثبت شد.', 'ok', 3000); A.go('#/pricelists'); }, function () {});
      } }, 'ثبت قیمت فروش ' + UI.fa(out.length) + ' کالا')));
    }
    view.appendChild(h('a.btn.block', { href: '#/pricelists', style: { marginTop: '8px' } }, 'بعداً'));
  };

  // ======================= COMPLETE PURCHASE COSTS =======================
  A.routes.costs = function (arg, query) {
    A.setTitle('تکمیل بهای خرید', true);
    query = query || {};
    // v2.5: opened from a product (?p=) or a receipt (?d=) -> only its rows
    var C = E.costCandidates(query.p ? { productId: query.p } : null).filter(function (c) { return !query.d || c.srcDocId === query.d; });
    view.appendChild(h('div.card', h('p.small', 'کالاهایی که بدون بهای خرید وارد شده‌اند. بهای خرید همان زمان ورود را بنویسید (اگر لیست قیمت خریدی دارید، از نزدیک‌ترین لیست خودکار پر شده؛ وگرنه آخرین قیمت خرید کالا پیشنهاد شده است). با ثبت، سند ورود همین بها را نشان می‌دهد، سود فروش‌های قبلی و بعدی محاسبه می‌شود و هشدار «بدون بهای خرید» برطرف می‌شود. گزارش دوره‌های بسته تغییر نمی‌کند.'),
      query.p || query.d ? h('a.small', { href: '#/costs' }, 'نمایش همه ورودهای بی‌قیمت') : null));
    if (!C.length) { view.appendChild(h('div.card.empty', 'همه ورودها بهای خرید دارند.')); return; }
    var inputs = C.map(function (c) {
      // the last purchase price is only PRE-FILLED for one product / one receipt; in the full list it is a placeholder
      var lp = E.state.products[c.productId], last = lp && lp.buyPrice != null ? lp.buyPrice : null;
      var pre = c.suggestion ? c.suggestion.price : (query.p || query.d ? last : null);
      var mi = A.moneyInput(pre, last != null ? 'آخرین خرید: ' + UI.money(last) : 'بهای هر عدد');
      return { c: c, mi: mi };
    });
    view.appendChild(h('div.card', { style: { padding: '4px 14px' } }, inputs.map(function (x) {
      var c = x.c;
      return h('div.line', h('b', c.name), h('div.small.muted', [c.srcNo || 'موجودی قدیمی بدون سند', c.ts ? UI.dateFa(c.ts) : '', c.supplier, UI.qty(c.qty) + ' عدد (' + UI.qty(c.inStock) + ' در انبار)'].filter(Boolean).join(' · ')),
        h('div', { style: { marginTop: '6px' } }, x.mi.input, x.mi.hint), c.suggestion ? h('div.hint', 'از لیست قیمت' + (c.suggestion.name ? ' «' + c.suggestion.name + '»' : '') + ' (' + UI.dateFa(c.suggestion.date) + ')')
          : x.mi.value() != null ? h('div.hint', 'پیشنهاد: آخرین قیمت خرید کالا — اگر بهای آن ورود فرق داشت اصلاح کنید') : null);
    })));
    var btn = h('button.btn.primary.block', { onclick: function () {
      var items = [], bad = false;
      inputs.forEach(function (x) { var n = x.mi.value(); if (n == null) return; if (isNaN(n) || n <= 0 || !Number.isInteger(n)) { bad = true; return; } items.push({ srcDocId: x.c.srcDocId, productId: x.c.productId, unitCost: n, listId: x.c.suggestion && x.c.suggestion.price === n ? x.c.suggestion.listId : null }); });
      if (bad) { UI.toast('بها را عدد صحیح مثبت بنویسید.', 'bad'); return; }
      if (!items.length) { UI.toast('بهای هیچ ردیفی وارد نشده است.', 'bad'); return; }
      A.manager('تکمیل بهای خرید').then(function (ctx) {
        if (!ctx) return;
        A.run(function () { return E.completeCosts({ opKey: UI.opKey('cst'), reason: 'تکمیل دستی', items: items }, ctx); }).then(function (r) { UI.toast('بهای ' + UI.fa(items.length) + ' ردیف تکمیل شد (' + r.doc.no + ').', 'ok'); A.go('#/doc/' + r.docId); }, function () {});
      });
    } }, 'ثبت تکمیل بها');
    view.appendChild(h('div.sticky-act', btn));
  };
})();
