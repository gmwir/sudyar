/* v2.11 «فاکتورخوان خرید» — reads a PHOTO or PDF of a supplier's purchase invoice and builds a DRAFT of «فاکتور خرید» (#/purchase).
   Method: Claude vision API with the user's OWN key, only on the user's tap and after explicit consent per file (the file is sent to Anthropic).
   Why: tiny code, reads Persian tables in photos and PDFs far better than on-device OCR, adds nothing to the offline app; reading needs internet,
   the draft, its review and the final posting stay offline.
   Nothing is ever posted here: the result goes into the purchase draft (no stock / money effect) after every doubtful item was checked by the user;
   the purchase page then runs the engine's own checks (sums, duplicate invoice, product links) before the user posts it.
   Matching reuses the purchase page rules: exact barcode / SKU only; names give suggestions, never a link. The key is stored on this device only
   (never in backups) and only when the user ticks «remember». */
(function () {
  'use strict';
  var A = window.App, E = A.E, UI = window.UI, h = UI.h, Core = window.Core, view = document.getElementById('view');
  if (!A || !E) return;
  var DKEY = 'ay.draft.purchase', LKEY = 'ay.invreader.last', KKEY = 'ay.claude.key', MKEY = 'ay.claude.model';
  var API = 'https://api.anthropic.com/v1/messages', DEF_MODEL = 'claude-sonnet-5-5', MAX_PDF = 20 * 1024 * 1024;
  var mem = { key: '' };
  function getKey() { return mem.key || A.lsGet(KKEY) || ''; }
  function model() { return A.lsGet(MKEY) || DEF_MODEL; }
  function n0(v) { if (v == null || v === '') return null; var x = typeof v === 'number' ? v : UI.parseNum(String(v)); return x == null || isNaN(x) ? null : x; }
  function rowKey() { return 'r' + Math.random().toString(36).slice(2, 9); }

  var NUM = { type: ['number', 'null'] }, STR = { type: ['string', 'null'] };
  var SCHEMA = { type: 'object', required: ['lines', 'unclear'], properties: {
    supplier_name: STR, supplier_phone: STR, invoice_no: STR, invoice_date: STR, currency: { type: ['string', 'null'], enum: ['rial', 'toman', null] },
    lines: { type: 'array', items: { type: 'object', required: ['unclear'], properties: { row: NUM, code: STR, barcode: STR, name: STR, brand: STR, qty: NUM, unit_price: NUM, line_discount: NUM, line_total: NUM,
      unclear: { type: 'array', items: { type: 'string' } } } } },
    subtotal: NUM, invoice_discount: NUM, vat: NUM, freight: NUM, payable: NUM, unclear: { type: 'array', items: { type: 'string' } }, notes: STR } };
  var PROMPT = 'This is a purchase invoice from an Iranian auto-parts supplier (usually Persian). Fill the tool with EXACTLY what is printed.\n' +
    '- Never guess, infer or calculate a value that is not clearly printed: use null and name the field in that line\'s "unclear" (or the top "unclear").\n' +
    '- If a digit or word is hard to read, still use null for it and list it in "unclear". Do not correct the supplier\'s arithmetic.\n' +
    '- Numbers: Latin digits, no thousands separators. Amounts in the invoice\'s own unit; "currency" = "rial" or "toman" only if printed (ریال / تومان), else null.\n' +
    '- One entry in "lines" per printed item row, in order; "row" = printed row number. code = the part/technical code column, barcode only if printed as a barcode number.\n' +
    '- invoice_date exactly as printed (e.g. 1405/08/10). subtotal = printed sum of rows; invoice_discount, vat (مالیات بر ارزش افزوده), freight (حمل), payable (قابل پرداخت) only if printed.\n' +
    '- notes: anything that may matter (handwritten edits, crossed-out rows, several pages, stamps saying returned/cancelled). Answer in Persian in notes.';

  function toB64(bytes) { var s = '', CH = 0x8000; for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s); }
  function sha256(bytes) { return window.crypto && crypto.subtle ? crypto.subtle.digest('SHA-256', bytes).then(function (b) { return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }) : Promise.resolve(''); }
  function shrinkImage(file) { // long side ≤ 2000 px, JPEG: fewer tokens and a smaller upload, text still sharp
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', 0.88).split(',')[1]);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('تصویر باز نشد.')); };
      img.src = url;
    });
  }
  function callClaude(block) {
    return fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': getKey(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: model(), max_tokens: 8000, tools: [{ name: 'purchase_invoice', description: 'The printed content of the purchase invoice', input_schema: SCHEMA }],
        tool_choice: { type: 'tool', name: 'purchase_invoice' }, messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }] }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); return j; }); })
      .then(function (j) { var t = (j.content || []).filter(function (c) { return c.type === 'tool_use'; })[0]; if (!t || !t.input) throw new Error('پاسخ قابل استفاده نبود؛ دوباره امتحان کنید.'); return t.input; });
  }

  /* checks: everything doubtful becomes a flag the user must tick (or fix) before the draft is filled */
  function matchProduct(L) {
    var byBar = L.barcode ? E.findProductByCode(L.barcode) : null, byCode = L.code ? E.findProductByCode(L.code) : null, bySku = L.code ? E.findProductBySku(L.code) : null;
    var ids = [byBar, byCode, bySku].filter(Boolean).map(function (p) { return p.id; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (ids.length > 1) { L.conflict = true; L.candidates = ids; L.productId = null; }
    else if (ids.length === 1) { L.productId = ids[0]; L.match = byBar && byBar.id === ids[0] ? 'file-barcode' : 'file-code'; }
    else { L.productId = null; L.candidates = L.name ? A.productSearch([L.name, L.brand].filter(Boolean).join(' ')).slice(0, 3).map(function (p) { return p.id; }) : []; }
  }
  function analyse(R) {
    var F = R.flags = [], fa = UI.fa, sumRows = 0, rowsOk = true;
    function flag(id, text) { F.push({ id: id, text: text, ok: !!(R.acks && R.acks[id]) }); }
    (R.read.unclear || []).forEach(function (u, i) { flag('u' + i, 'خوانا نبود: ' + u); });
    if (R.read.notes) flag('notes', 'یادداشت خواندن: ' + R.read.notes);
    if (!R.supplierId) flag('sup', 'تأمین‌کننده هنوز انتخاب نشده' + (R.read.supplier_name ? ' (روی فاکتور: «' + R.read.supplier_name + '»)' : ''));
    if (!R.no) flag('no', 'شماره فاکتور خوانده نشد');
    if (!R.date) flag('date', 'تاریخ فاکتور خوانده نشد'); else { var t = UI.parseDateInput(R.date); if (t == null || isNaN(t)) flag('date', 'تاریخ «' + R.date + '» قابل تبدیل نیست'); }
    if (!R.currency) flag('cur', 'واحد مبالغ (ریال / تومان) را مشخص کنید');
    else if (!R.read.currency) flag('cur2', 'واحد مبالغ روی فاکتور چاپ نشده بود؛ «' + (R.currency === 'rial' ? 'ریال' : 'تومان') + '» را شما انتخاب کرده‌اید — مطمئنید؟');
    if (!R.lines.length) flag('nolines', 'هیچ ردیف کالایی خوانده نشد');
    R.lines.forEach(function (L, i) {
      var f = L.flags = [], nm = 'ردیف ' + fa(L.row || i + 1);
      (L.unclear || []).forEach(function (u) { f.push('خوانا نبود: ' + u); });
      if (!(Number.isInteger(L.qty) && L.qty > 0)) f.push('تعداد نامعتبر یا خوانده نشد');
      if (!(Number.isInteger(L.unitPrice) && L.unitPrice >= 0)) f.push('فی نامعتبر یا خوانده نشد');
      if (L.lineDiscount != null && !(Number.isInteger(L.lineDiscount) && L.lineDiscount >= 0)) f.push('تخفیف ردیف نامعتبر');
      var calc = Number.isInteger(L.qty) && Number.isInteger(L.unitPrice) ? L.qty * L.unitPrice - (L.lineDiscount || 0) : null;
      if (L.lineTotal != null && calc != null && calc !== L.lineTotal) f.push('جمع ردیف روی فاکتور ' + UI.money(L.lineTotal) + ' است ولی تعداد × فی − تخفیف = ' + UI.money(calc));
      if (L.lineTotal == null && calc == null) rowsOk = false; else sumRows += L.lineTotal != null ? L.lineTotal : calc;
      if (L.conflict) f.push('کد با چند کالای انبار جور است؛ کالای درست را در صفحه فاکتور خرید انتخاب کنید');
      else if (!L.productId) f.push('کالای انبار با کد/بارکد دقیق پیدا نشد' + (L.candidates && L.candidates.length ? ' (پیشنهاد با نام هست؛ در صفحه فاکتور خرید تأیید کنید)' : ' (در صفحه فاکتور خرید انتخاب یا تعریف کنید)'));
      L.ok = !f.length || !!(R.acks && R.acks['L' + i]);
      if (f.length) F.push({ id: 'L' + i, text: nm + (L.name ? ' — ' + L.name : '') + ': ' + f.join('؛ '), ok: L.ok, line: i });
    });
    if (R.decSubtotal != null && rowsOk && sumRows !== R.decSubtotal) flag('sum', 'جمع ردیف‌ها ' + UI.money(sumRows) + ' است ولی جمع چاپ‌شده ' + UI.money(R.decSubtotal));
    if (R.decSubtotal == null) flag('nosum', 'جمع اقلام روی فاکتور خوانده نشد؛ کنترل جمع ممکن نیست');
    var exp = R.decSubtotal != null ? R.decSubtotal - (R.discount || 0) + (R.vat || 0) + (R.freight || 0) : null;
    if (R.decPayable != null && exp != null && exp !== R.decPayable) flag('pay', 'قابل پرداخت چاپ‌شده ' + UI.money(R.decPayable) + ' با جمع − تخفیف + مالیات + حمل (' + UI.money(exp) + ') برابر نیست');
    if (R.supplierId && (R.no || R.decPayable != null)) {
      var t2 = R.date ? UI.parseDateInput(R.date) : null;
      var dup = E.findPurchaseDuplicates({ supplierId: R.supplierId, no: R.no || '', date: t2 != null && !isNaN(t2) ? t2 : Date.now(), payableT: null });
      var all = dup.definite.concat(dup.probable);
      if (all.length) flag('dup', 'احتمال تکراری: ' + all.map(function (x) { return x.no + (x.supplierDocNo ? ' / فاکتور ' + x.supplierDocNo : ''); }).join('، ') + ' قبلاً ثبت شده');
    }
    var draft = A.lsGet(DKEY);
    if (draft && draft.importFile && draft.importFile.sha256 && draft.importFile.sha256 === R.file.sha256) flag('samefile', 'همین فایل در پیش‌نویس فعلی فاکتور خرید هم استفاده شده است');
    R.ready = !!R.currency && F.every(function (x) { return x.ok; });
    return R;
  }
  function fromRead(read, file) {
    var sup = null, nm = Core.normText(read.supplier_name || '');
    if (nm) E.list('suppliers').forEach(function (s) { if (Core.normText(s.name) === nm) sup = s; }); // exact name only = a suggestion the user confirms
    var R = { file: file, read: read, supplierId: null, supplierSuggest: sup ? sup.id : null, no: (read.invoice_no || '').trim(), date: (read.invoice_date || '').trim(), currency: read.currency || '',
      decSubtotal: n0(read.subtotal), discount: n0(read.invoice_discount), vat: n0(read.vat), freight: n0(read.freight), decPayable: n0(read.payable), acks: {},
      lines: (read.lines || []).map(function (l) { var L = { row: l.row, code: (l.code || '').trim(), barcode: (l.barcode || '').trim(), name: (l.name || '').trim(), brand: (l.brand || '').trim(), qty: n0(l.qty), unitPrice: n0(l.unit_price),
        lineDiscount: n0(l.line_discount), lineTotal: n0(l.line_total), unclear: l.unclear || [] }; matchProduct(L); return L; }) };
    return analyse(R);
  }
  function save(R) { A.lsSet(LKEY, R); }

  /* fill the purchase draft: never overwrites what the user already typed there; never posts */
  function apply(R) {
    var d = A.lsGet(DKEY), had = d && d.v === 1 && (d.items.length || d.no || d.supplierId);
    function go() {
      if (!(d && d.v === 1)) d = { v: 1, opKey: UI.opKey('pinv'), supplierId: null, no: '', invDate: '', date: '', currency: 'toman', discount: null, discountAlloc: 'value', discountManual: null, charges: [], decSubtotal: null, decPayable: null, note: '', items: [], importFile: null };
      var kept = [];
      function set(k, v) { if (v == null || v === '') return; if (d[k] == null || d[k] === '' || !had) d[k] = v; else if (d[k] !== v) kept.push(k); }
      set('supplierId', R.supplierId); set('no', R.no); set('invDate', R.date); set('decSubtotal', R.decSubtotal); set('decPayable', R.decPayable); set('discount', R.discount);
      if (!had) d.currency = R.currency; else if (d.currency !== R.currency) kept.push('currency');
      if (R.vat) d.charges.push({ type: 'vat', amount: R.vat, treatment: null, basis: 'value' }); // treatment is the user's choice on the purchase page
      if (R.freight) d.charges.push({ type: 'freight', amount: R.freight, treatment: 'capitalize', basis: 'value' });
      R.lines.forEach(function (L) {
        d.items.push({ key: rowKey(), productId: L.productId || null, qty: Number.isInteger(L.qty) && L.qty > 0 ? L.qty : 1, unitPrice: Number.isInteger(L.unitPrice) && L.unitPrice >= 0 ? L.unitPrice : null,
          lineDiscount: Number.isInteger(L.lineDiscount) && L.lineDiscount > 0 ? L.lineDiscount : null, match: L.productId ? L.match : null, raw: { code: L.code, barcode: L.barcode, name: L.name, brand: L.brand },
          fileTotal: L.lineTotal, candidates: L.candidates || [], conflict: !!L.conflict });
      });
      if (!d.importFile) d.importFile = { name: R.file.name, sha256: R.file.sha256 };
      d.note = (d.note ? d.note + ' — ' : '') + 'خوانده‌شده از ' + (R.file.kind === 'pdf' ? 'PDF' : 'عکس') + ' فاکتور (' + R.file.name + ')';
      A.lsSet(DKEY, d); A.lsSet(LKEY, null);
      UI.toast('پیش‌نویس فاکتور خرید پر شد؛ بررسی و ثبت نهایی در همین صفحه.' + (kept.length ? ' مقادیر قبلی پیش‌نویس حفظ شد: ' + kept.join('، ') : ''), 'ok', 6000);
      A.go('#/purchase');
    }
    if (!had) { go(); return; }
    UI.confirmBox('پیش‌نویس فعلی فاکتور خرید خالی نیست (' + UI.fa(d.items.length) + ' ردیف). ردیف‌های خوانده‌شده به آن اضافه شوند؟ (چیزی از پیش‌نویس فعلی پاک نمی‌شود)', 'افزودن').then(function (ok) { if (ok) go(); });
  }

  function readFile(kind) {
    var key = getKey(); if (!key) { UI.toast('ابتدا کلید API را وارد کنید.', 'bad'); return; }
    if (navigator.onLine === false) { UI.toast('برای خواندن فاکتور اینترنت لازم است. بدون اینترنت از Excel/CSV یا ورود دستی استفاده کنید.', 'bad', 6000); return; }
    UI.pickFile(kind === 'pdf' ? 'application/pdf,.pdf' : 'image/*').then(function (f) {
      if (!f) return;
      var isPdf = kind === 'pdf' || /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
      if (isPdf && f.size > MAX_PDF) { UI.toast('PDF بزرگ‌تر از ۲۰ مگابایت است.', 'bad'); return; }
      UI.confirmBox('تأیید ارسال: فایل «' + f.name + '» برای خواندن به سرویس Claude (شرکت Anthropic) فرستاده می‌شود. فقط همین فایل فرستاده می‌شود؛ هیچ اطلاعات دیگری از برنامه ارسال نمی‌شود.', 'ارسال و خواندن').then(function (ok) {
        if (!ok) return;
        var busy = UI.sheet('در حال خواندن فاکتور…', h('div.stack', h('p', 'چند ثانیه صبر کنید. هیچ چیزی ثبت نمی‌شود.')));
        UI.readFileBytes(f).then(function (bytes) {
          return Promise.all([sha256(bytes), isPdf ? Promise.resolve(toB64(bytes)) : shrinkImage(f)]);
        }).then(function (x) {
          var block = isPdf ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: x[1] } } : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: x[1] } };
          return callClaude(block).then(function (read) { return fromRead(read, { name: f.name, sha256: x[0], kind: isPdf ? 'pdf' : 'image' }); });
        }).then(function (R) { busy.close(); save(R); A.route(); }, function (e) { busy.close(); UI.toast('خواندن ناموفق بود: ' + (e && e.message || e), 'bad', 7000); });
      });
    });
  }

  function keyCard() {
    var k = getKey(), inp = h('input.in.ltr-in', { type: 'password', placeholder: 'sk-ant-…', value: k, autocomplete: 'off' }), rem = h('input', { type: 'checkbox', checked: !!A.lsGet(KKEY) });
    var mdl = h('input.in.ltr-in', { value: model(), placeholder: DEF_MODEL });
    return h('details.card', k ? {} : { open: true }, h('summary', 'تنظیم کلید Claude (API) ' + (k ? '— تنظیم شده ✓' : '— لازم است')),
      h('p.small.muted', 'کلید را از console.anthropic.com بسازید. فقط روی همین دستگاه می‌ماند و در فایل پشتیبان نیست. هزینه هر خواندن از حساب خود شما کم می‌شود.'),
      A.field('کلید API', inp), h('label.check', rem, 'روی این دستگاه به خاطر بسپار'), A.field('مدل', mdl, h('div.hint', 'پیش‌فرض: ' + DEF_MODEL)),
      h('div.grid2', h('button.btn.primary', { onclick: function () {
        var v = inp.value.trim(); mem.key = v; A.lsSet(KKEY, rem.checked && v ? v : null); A.lsSet(MKEY, mdl.value.trim() && mdl.value.trim() !== DEF_MODEL ? mdl.value.trim() : null);
        UI.toast(v ? 'کلید ثبت شد' + (rem.checked ? ' (روی این دستگاه)' : ' (تا بستن برنامه)') + '.' : 'کلید پاک شد.', 'ok'); A.route();
      } }, 'ذخیره'), h('button.btn', { onclick: function () { mem.key = ''; A.lsSet(KKEY, null); UI.toast('کلید پاک شد.', 'ok'); A.route(); } }, 'پاک کردن کلید')));
  }

  function review(R) {
    var S = E.state, sp = R.supplierId && S.suppliers[R.supplierId], sug = !R.supplierId && R.supplierSuggest && S.suppliers[R.supplierSuggest];
    function upd(fn) { fn(); analyse(R); save(R); A.route(); }
    var no = h('input.in', { value: R.no, onchange: function () { upd(function () { R.no = no.value.trim(); }); } });
    var dt = h('input.in', { value: R.date, inputmode: 'numeric', onchange: function () { upd(function () { R.date = dt.value.trim(); }); } });
    var cur = A.sel({ '': '— انتخاب کنید —', toman: 'تومان', rial: 'ریال' }, R.currency || '', { onchange: function () { upd(function () { R.currency = cur.value; }); } });
    function money(k, label) { var m = A.moneyInput(R[k], label); m.input.addEventListener('change', function () { upd(function () { R[k] = n0(m.value()); }); }); return A.field(label, m.input, m.hint); }
    view.appendChild(h('div.alert.warn', h('div.grow', h('b', 'پیش‌نویس — هنوز هیچ چیز ثبت نشده'), h('div.small', 'موارد مشکوک را بررسی و تیک بزنید یا مقدار را اصلاح کنید. سپس «انتقال به فاکتور خرید»؛ ثبت نهایی فقط در آن صفحه و با تأیید شماست.')),
      h('button.btn.sm.ghost', { onclick: function () { UI.confirmBox('نتیجه این خواندن کنار گذاشته شود؟', 'کنار گذاشتن', true).then(function (ok) { if (ok) { A.lsSet(LKEY, null); A.route(); } }); } }, 'کنار گذاشتن')));
    view.appendChild(h('div.card', h('div.small.muted', 'فایل: ' + R.file.name),
      h('div.row', h('div.grow', sp ? h('b', 'تأمین‌کننده: ' + sp.name) : sug ? h('span', 'پیشنهاد: «' + sug.name + '» (هم‌نام با فاکتور)') : h('span.muted', 'تأمین‌کننده: ' + (R.read.supplier_name ? '«' + R.read.supplier_name + '» روی فاکتور' : 'خوانده نشد'))),
        sug ? h('button.btn.sm.primary', { onclick: function () { upd(function () { R.supplierId = sug.id; }); } }, 'همین است') : null,
        h('button.btn.sm', { onclick: function () { A.pickSupplier(function (x) { upd(function () { R.supplierId = x.id; }); }); } }, sp ? 'تغییر' : 'انتخاب / تعریف')),
      h('div.grid2', A.field('شماره فاکتور', no), A.field('تاریخ فاکتور', dt)), A.field('واحد مبالغ', cur, null, true),
      h('div.grid2', money('decSubtotal', 'جمع اقلام (چاپ‌شده)'), money('decPayable', 'قابل پرداخت (چاپ‌شده)')),
      h('div.grid2', money('discount', 'تخفیف کل'), money('vat', 'مالیات بر ارزش افزوده')), money('freight', 'هزینه حمل')));
    var box = h('div.card', { style: { padding: '4px 14px' } });
    R.lines.forEach(function (L, i) {
      var p = L.productId && S.products[L.productId];
      var q = h('input.in', { value: L.qty == null ? '' : UI.fa(L.qty), inputmode: 'numeric', onchange: function () { upd(function () { L.qty = n0(q.value); }); } });
      var pr = A.moneyInput(L.unitPrice, 'فی'); pr.input.addEventListener('change', function () { upd(function () { L.unitPrice = n0(pr.value()); }); });
      var ld = A.moneyInput(L.lineDiscount, 'تخفیف ردیف'); ld.input.addEventListener('change', function () { upd(function () { L.lineDiscount = n0(ld.value()); }); });
      box.appendChild(h('div.line',
        h('div.row', h('div.grow', h('b', UI.fa(L.row || i + 1) + '. ' + (L.name || '— بی‌نام —')), h('div.small.muted', [L.code && 'کد ' + L.code, L.barcode && 'بارکد ' + L.barcode, L.brand].filter(Boolean).join(' · '))),
          h('button.btn.sm.ghost', { 'aria-label': 'حذف ردیف', onclick: function () { UI.confirmBox('این ردیف از پیش‌نویس حذف شود؟', 'حذف', true).then(function (ok) { if (ok) upd(function () { R.lines.splice(i, 1); R.acks = {}; }); }); } }, '✕')),
        h('div.small', p ? h('span.badge.ok', 'کالای انبار: ' + p.name + (p.sku ? ' (' + p.sku + ')' : '')) : L.conflict ? h('span.badge.bad', 'چند کالای هم‌کد') : h('span.badge.warn', 'وصل‌نشده')),
        h('div.grid2', { style: { marginTop: '6px' } }, A.field('تعداد', q), A.field('فی', pr.input, pr.hint)), A.field('تخفیف ردیف', ld.input, ld.hint),
        L.lineTotal != null ? h('div.hint', 'جمع ردیف روی فاکتور: ' + UI.moneyT(L.lineTotal)) : null,
        L.flags.length ? h('label.check', { style: { color: L.ok ? 'var(--ok)' : 'var(--bad)' } }, h('input', { type: 'checkbox', checked: L.ok, onchange: function () { upd(function () { R.acks['L' + i] = !L.ok; }); } }), L.flags.join('؛ ') + ' — بررسی کردم') : null));
    });
    if (!R.lines.length) box.appendChild(h('div.empty', 'ردیفی خوانده نشد.'));
    view.appendChild(h('div.sec-title', 'ردیف‌ها (' + UI.fa(R.lines.length) + ')')); view.appendChild(box);
    var gl = R.flags.filter(function (x) { return x.line == null; });
    if (gl.length) view.appendChild(h('div.card', h('b', 'موارد مشکوک (' + UI.fa(gl.length) + ')'), gl.map(function (x) {
      return h('label.check', { style: { color: x.ok ? 'var(--ok)' : 'var(--bad)' } }, h('input', { type: 'checkbox', checked: x.ok, onchange: function () { upd(function () { R.acks[x.id] = !x.ok; }); } }), x.text + ' — بررسی کردم');
    })));
    var left = R.flags.filter(function (x) { return !x.ok; }).length + (R.currency ? 0 : 1);
    view.appendChild(h('button.btn.primary.block', { disabled: !R.ready, onclick: function () { if (R.ready) apply(R); } }, R.ready ? 'انتقال به پیش‌نویس فاکتور خرید' : UI.fa(left) + ' مورد هنوز بررسی نشده'));
    view.appendChild(h('p.small.muted', 'ردیف‌هایی که کالای انبارشان معلوم نیست در صفحه فاکتور خرید با «انتخاب از انبار» یا «تعریف کالای جدید» تکمیل می‌شوند. ثبت با اختلاف جمع یا فاکتور تکراری فقط با رمز مدیر و ذکر علت ممکن است.'));
  }

  A.routes.invreader = function () {
    A.setTitle('فاکتورخوان خرید', true);
    var R = A.lsGet(LKEY);
    if (R && R.read && R.lines) { analyse(R); review(R); return; }
    view.appendChild(h('div.card', h('h2', 'خواندن عکس یا PDF فاکتور خرید'),
      h('p.small', 'فاکتور خوانده می‌شود و یک پیش‌نویس با فهرست موارد مشکوک ساخته می‌شود. هیچ چیزی خودکار ثبت نمی‌شود؛ هر مورد مبهم از شما پرسیده می‌شود.'),
      h('p.small.muted', 'برای خواندن، اینترنت و کلید API شخصی شما لازم است. فایل فقط پس از تأیید شما به سرویس Claude فرستاده می‌شود.')));
    view.appendChild(keyCard());
    view.appendChild(h('div.grid2', h('button.btn.primary', { onclick: function () { readFile('image'); } }, 'عکس فاکتور'), h('button.btn.primary', { onclick: function () { readFile('pdf'); } }, 'PDF فاکتور')));
    view.appendChild(h('p.small.muted', { style: { marginTop: '10px' } }, 'بدون اینترنت: در صفحه «فاکتور خرید» از Excel/CSV، اسکن یا انتخاب از انبار استفاده کنید.'));
  };
  A.invReader = function () { A.go('#/invreader'); };
})();
