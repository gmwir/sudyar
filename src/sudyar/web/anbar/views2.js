/* Screens part 2: bulk import, QR labels, settings + backup/restore, first-run setup, help. */
(function () {
  'use strict';
  var A = window.App, E = A.E, DB = A.DB, UI = window.UI, h = UI.h, Core = window.Core, J = window.Jalali, view = document.getElementById('view');
  var field = A.field, sel = A.sel;

  function stamp() { var d = new Date(), j = J.g2j(d.getFullYear(), d.getMonth() + 1, d.getDate()); return j[0] + '-' + ('0' + j[1]).slice(-2) + '-' + ('0' + j[2]).slice(-2) + '_' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2); }

  // Reports & analytics screens live in reportsui.js

  // ======================= BULK IMPORT =======================
  var COLS = [
    ['sku', 'کد کالا', ['کد', 'کد کالا', 'کد داخلی', 'sku', 'code', 'part', 'part no', 'part number', 'شماره فنی', 'کد قطعه']],
    ['name', 'نام کالا', ['نام', 'نام کالا', 'شرح', 'شرح کالا', 'عنوان', 'name', 'description', 'title', 'کالا', 'قطعه', 'نام قطعه']],
    ['brand', 'برند', ['برند', 'مارک', 'سازنده', 'brand', 'make', 'manufacturer']],
    ['category', 'دسته‌بندی', ['دسته', 'دسته بندی', 'دسته‌بندی', 'گروه', 'category', 'group']],
    ['unit', 'واحد', ['واحد', 'unit']],
    ['packSize', 'تعداد در واحد', ['تعداد در بسته', 'تعداد در واحد', 'pack', 'pack size']],
    ['minStock', 'حداقل موجودی', ['حداقل', 'حداقل موجودی', 'min', 'min stock', 'نقطه سفارش']],
    ['buyPrice', 'قیمت خرید', ['قیمت خرید', 'بهای خرید', 'خرید', 'buy', 'cost', 'buy price', 'فی خرید']],
    ['sellPrice', 'قیمت فروش', ['قیمت فروش', 'فروش', 'قیمت', 'sell', 'price', 'sell price', 'فی فروش']],
    ['stock', 'موجودی اولیه', ['موجودی', 'موجودی اولیه', 'تعداد', 'stock', 'qty', 'quantity']],
    ['location', 'محل نگهداری', ['محل', 'محل نگهداری', 'قفسه', 'location', 'shelf']],
    ['barcode', 'بارکد', ['بارکد', 'barcode', 'ean']],
    ['notes', 'توضیحات', ['توضیحات', 'توضیح', 'notes', 'note', 'ملاحظات']]];
  function normH(s) { return Core.normText(s).replace(/[‌_\-]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function autoMap(header) {
    var map = {};
    COLS.forEach(function (c) {
      var syn = c[2].map(normH), idx = -1;
      header.forEach(function (hd, i) { if (idx < 0 && syn.indexOf(normH(hd)) >= 0 && Object.keys(map).every(function (k) { return map[k] !== i; })) idx = i; });
      if (idx >= 0) map[c[0]] = idx;
    });
    return map;
  }
  function fixFa(s) { return String(s == null ? '' : s).replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim(); }
  A.routes['import'] = function () {
    A.setTitle('ورود دسته‌جمعی کالا', true);
    var st = { rows: null, header: null, map: null, sheet: 0, sheets: null, fileHash: null, rial: false, onExisting: 'skip', allowNameDup: false, fileName: '', catChoice: {}, catText: {} };
    var box = h('div');
    view.appendChild(h('div.card', h('p.small', 'فایل Excel (xlsx) یا CSV کالاها را انتخاب کنید. ردیف اول باید عنوان ستون‌ها باشد. ستون‌های «کد کالا» و «نام کالا» الزامی‌اند.'),
      h('div.grid2', h('button.btn.primary', { onclick: choose }, 'انتخاب فایل'), h('button.btn', { onclick: template }, 'دریافت فایل نمونه'))));
    view.appendChild(box);
    function template() {
      UI.fileSheet(window.XLSX.writeXlsx([{ name: 'کالاها', rows: [COLS.map(function (c) { return c[1]; }),
        ['GMW-2061', 'لنت ترمز جلو پژو ۲۰۶', 'GMW', 'ترمز', 'دست', 1, 2, 850000, 1150000, 10, 'قفسه A2', '6260000000017', ''],
        ['ISK-405-F', 'فیلتر روغن پژو ۴۰۵', 'ایساکو', 'فیلتر', 'عدد', 1, 5, 120000, 165000, 24, 'قفسه B1', '', '']] }]), 'amiran-import-template.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
    function choose() {
      UI.pickFile('.xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').then(function (f) {
        if (!f) return;
        st.fileName = f.name;
        UI.readFileBytes(f).then(function (bytes) {
          var isX = bytes[0] === 0x50 && bytes[1] === 0x4B;
          return UI.sha256hex(Array.prototype.join.call(bytes.subarray(0, 200000), ',') + ':' + bytes.length).then(function (hx) { st.fileHash = hx.slice(0, 24); return isX ? window.XLSX.readXlsx(bytes) : { sheets: [{ name: 'CSV', rows: window.XLSX.readCsv(bytes) }] }; });
        }).then(function (wb) {
          st.sheets = wb.sheets.filter(function (s) { return s.rows.length; }); st.sheet = 0;
          if (!st.sheets.length) throw new Error('فایل خالی است.');
          prepare(); draw();
        }).catch(function (e) {
          if (e && e.message === 'NO_INFLATE') UI.toast('این نسخه iOS فایل xlsx فشرده را باز نمی‌کند؛ فایل را در Excel به CSV (UTF-8) ذخیره کنید یا iOS را به‌روز کنید.', 'bad', 7000);
          else A.showErr(e);
        });
      });
    }
    function prepare() {
      var rows = st.sheets[st.sheet].rows, hi = 0;
      for (var i = 0; i < Math.min(10, rows.length); i++) { if (Object.keys(autoMap(rows[i].map(String))).length >= 2) { hi = i; break; } }
      st.header = (rows[hi] || []).map(function (x) { return String(x); }); st.rows = rows.slice(hi + 1); st.map = autoMap(st.header);
    }
    function val(r, k) { var i = st.map[k]; return i == null ? '' : r[i]; }
    function num(v, money) {
      if (v === '' || v == null) return null;
      var n = typeof v === 'number' ? v : UI.parseNum(v);
      if (n == null) return null; if (isNaN(n)) return NaN;
      if (money && st.rial) n = n / 10;
      return Math.round(n * 1000) / 1000;
    }
    function analyze() {
      var seenSku = {}, seenNB = {}, out = [];
      var group = '', autoN = {}; // v2.2.1: a title row («۲۰۶») is the group of the rows below it; rows without a code get one
      st.rows.forEach(function (r, i) {
        if (!r.some(function (c) { return String(c).trim() !== ''; })) return;
        var hasPrice = ['buyPrice', 'sellPrice', 'stock'].some(function (k) { var v = val(r, k); return v !== '' && v != null && !isNaN(UI.parseNum(String(v))); });
        var lone = r.filter(function (c) { return String(c == null ? '' : c).trim(); }).length === 1, sk0 = fixFa(val(r, 'sku')), skTitle = lone && !fixFa(val(r, 'name')) && /[\u0600-\u06FF]/.test(sk0); // v2.3: a Persian title in the code column
        var hd = window.Match.headerText(r, !!sk0 && !skTitle, hasPrice); if (hd) { group = hd; return; }
        var it = { line: i + 2, sku: fixFa(val(r, 'sku')), name: fixFa(val(r, 'name')), brand: fixFa(val(r, 'brand')), category: fixFa(val(r, 'category')), unit: fixFa(val(r, 'unit')) || 'عدد',
          packSize: num(val(r, 'packSize')), minStock: num(val(r, 'minStock')), buyPrice: num(val(r, 'buyPrice'), true), sellPrice: num(val(r, 'sellPrice'), true), stock: num(val(r, 'stock')),
          location: fixFa(val(r, 'location')), barcode: String(val(r, 'barcode') || '').trim(), notes: fixFa(val(r, 'notes')), errors: [], status: 'new' };
        if (/^\d+(\.0+)?e\+?\d+$/i.test(it.barcode)) it.errors.push('بارکد به‌صورت علمی (E+) ذخیره شده؛ ستون بارکد را در Excel «متن» کنید');
        if (typeof val(r, 'barcode') === 'number') it.barcode = String(Math.round(val(r, 'barcode')));
        if (group && it.name) it.name = window.Match.withGroup(it.name, group); // «سیبک فرمان راست» under «۲۰۶»
        if (it.name) { // v2.3: no group column -> the app proposes «قطعات یدکی › سیستم › نوع قطعه» / «متفرقه › …»; a title row is a car or a hint
          var g = A.classifier().guess(it.name, { brand: it.brand, group: group }); it.cars = g.cars;
          if (!it.category) { it.category = g.path.join(' › '); it.guessed = g; }
        }
        if (!it.sku && it.name) { var base = window.Match.codeNorm(group || 'P').replace(/[^0-9A-Zا-ی]/g, '').slice(0, 8) || 'P', n = autoN[base] || 0, sk;
          do { n++; sk = base + '-' + ('00' + n).slice(-3); } while (E.findProductBySku(sk) || seenSku[Core.normSku(sk)]); autoN[base] = n; it.sku = sk; it.autoSku = true; }
        if (!it.sku) it.errors.push('کد کالا خالی است'); if (!it.name) it.errors.push('نام کالا خالی است');
        ['packSize', 'minStock', 'stock'].forEach(function (k) { if (it[k] != null && (isNaN(it[k]) || it[k] < 0 || !Number.isInteger(it[k]))) it.errors.push('«' + COLS.filter(function (c) { return c[0] === k; })[0][1] + '» باید عدد صحیح باشد'); });
        ['buyPrice', 'sellPrice'].forEach(function (k) { if (it[k] != null && (isNaN(it[k]) || it[k] < 0)) it.errors.push('قیمت نامعتبر'); else if (it[k] != null) it[k] = Math.round(it[k]); });
        if (it.packSize === 0) it.packSize = 1;
        var ks = Core.normSku(it.sku), knb = Core.normText(it.name) + '|' + Core.normText(it.brand);
        if (it.errors.length) it.status = 'error';
        else if (seenSku[ks]) { it.status = 'dupfile'; it.dupOf = seenSku[ks]; }
        else if (E.findProductBySku(it.sku)) { it.status = 'exists'; it.existing = E.findProductBySku(it.sku); }
        else if (seenNB[knb]) { it.status = 'dupfile'; it.dupOf = seenNB[knb]; }
        else if (E.findDuplicates({ name: it.name, brand: it.brand }).some(function (d) { return d.kind === 'name_brand'; })) it.status = 'namedup';
        if (ks && !seenSku[ks]) seenSku[ks] = it.line; if (it.name && !seenNB[knb]) seenNB[knb] = it.line;
        if (it.barcode && it.status === 'new') { var owner = E.findProductByCode(it.barcode); if (owner) { it.status = 'error'; it.errors.push('بارکد قبلاً برای «' + owner.name + '» ثبت شده'); } }
        out.push(it);
      });
      return out;
    }
    var LBL = { new: ['جدید', 'ok'], exists: ['کد تکراری (موجود)', 'warn'], dupfile: ['تکراری در فایل', 'bad'], namedup: ['هم‌نام + هم‌برند موجود', 'warn'], error: ['خطا', 'bad'] };
    // ---- group (category) column -> group tree. Never guesses: only a unique exact match is linked automatically. ----
    var CAT_SEP = /\s*[›>\/\\|]\s*/;
    function catKey(t) { return Core.normText(t); }
    function catPathLabel(id) { return E.categoryPath(id).join(' › '); }
    function importable(it) { return it.status === 'new' || (it.status === 'namedup' && st.allowNameDup) || (it.status === 'exists' && st.onExisting === 'update'); }
    function catInfo(items) { // distinct category texts of importable rows -> resolution + current choice
      var out = [], seen = {};
      items.forEach(function (it) {
        if (!it.category || !importable(it)) return;
        var k = catKey(it.category); if (!k || seen[k]) { if (seen[k]) seen[k].rows++; return; }
        var res = E.resolveCategoryText(it.category);
        if (!(k in st.catChoice)) st.catChoice[k] = res.status === 'exact' ? res.id : it.guessed ? '__create' : ''; // v2.3: a guessed path is proposed (shown below to confirm or change)
        st.catText[k] = it.category;
        seen[k] = { key: k, text: it.category, res: res, rows: 1, guessed: it.guessed }; out.push(seen[k]);
      });
      return out;
    }
    function chosenCat(it) { // -> {id} | {create:true} | null
      if (!it.category) return null;
      var c = st.catChoice[catKey(it.category)];
      if (c === '__create') return { create: true };
      return c && E.state.categories[c] ? { id: c } : null;
    }
    function draw() {
      UI.clear(box);
      if (st.sheets.length > 1) box.appendChild(h('div.card', field('برگه', sel(st.sheets.reduce(function (o, s, i) { o[i] = s.name; return o; }, {}), String(st.sheet), { onchange: function () { st.sheet = +this.value; prepare(); draw(); } }))));
      var mapCard = h('div.card', h('h2', 'تطبیق ستون‌ها'), h('p.small.muted', 'فایل: ' + st.fileName + ' — ' + UI.fa(st.rows.length) + ' ردیف'));
      var opts = { '-1': '— ندارد —' }; st.header.forEach(function (hd, i) { opts[i] = (hd || ('ستون ' + (i + 1))); });
      COLS.forEach(function (c) {
        mapCard.appendChild(h('div.row', { style: { marginBottom: '6px' } }, h('span', { style: { width: '42%', fontSize: '14px' } }, c[1], c[0] === 'sku' || c[0] === 'name' ? h('i', { style: { color: 'var(--bad)', fontStyle: 'normal' } }, ' *') : null),
          sel(opts, st.map[c[0]] == null ? '-1' : String(st.map[c[0]]), { onchange: function () { if (this.value === '-1') delete st.map[c[0]]; else st.map[c[0]] = +this.value; draw(); } })));
      });
      mapCard.appendChild(h('label.check', h('input', { type: 'checkbox', checked: st.rial, onchange: function () { st.rial = this.checked; draw(); } }), 'قیمت‌های فایل به ریال است (تقسیم بر ۱۰)'));
      box.appendChild(mapCard);
      if (st.map.sku == null || st.map.name == null) { box.appendChild(h('div.alert.bad', 'ستون «کد کالا» و «نام کالا» را مشخص کنید.')); return; }
      var items = analyze(), cnt = {}; items.forEach(function (it) { cnt[it.status] = (cnt[it.status] || 0) + 1; });
      var optCard = h('div.card', h('h2', 'پیش‌نمایش'), h('div.row.wrap', Object.keys(LBL).filter(function (k) { return cnt[k]; }).map(function (k) { return h('span.badge.' + LBL[k][1], LBL[k][0] + ': ' + UI.fa(cnt[k])); })));
      if (cnt.exists) optCard.appendChild(field('برای کدهایی که قبلاً ثبت شده‌اند', sel({ skip: 'نادیده بگیر (پیشنهادی)', update: 'به‌روزرسانی نام/قیمت/مشخصات (بدون تغییر موجودی)' }, st.onExisting, { onchange: function () { st.onExisting = this.value; draw(); } })));
      if (cnt.namedup) optCard.appendChild(h('label.check', h('input', { type: 'checkbox', checked: st.allowNameDup, onchange: function () { st.allowNameDup = this.checked; draw(); } }), 'کالاهای هم‌نام و هم‌برند هم به‌عنوان کالای جدا ثبت شوند'));
      optCard.appendChild(h('p.small.muted', 'موجودی اولیه فقط برای کالاهای جدید ثبت می‌شود (در یک سند «موجودی اولیه»). ورود دوباره همین فایل، موجودی را دوباره اضافه نمی‌کند.'));
      box.appendChild(optCard);
      var cats = catInfo(items);
      if (cats.length) {
        var active = E.list('categories').filter(function (c) { return c.active !== false; }).sort(function (a, b) { return catPathLabel(a.id).localeCompare(catPathLabel(b.id), 'fa'); });
        var linked = cats.filter(function (c) { return st.catChoice[c.key]; }).length;
        var catCard = h('div.card', { id: 'imp-cats' }, h('h2', 'گروه‌های کالا در فایل'),
          h('p.small.muted', 'فقط نامی که دقیقاً با یک گروه موجود یکی است خودکار وصل می‌شود. نام مبهم (چند گروه هم‌نام) یا ناموجود وصل نمی‌شود تا خودتان انتخاب کنید؛ در غیر این صورت کالا «بدون گروه» ثبت و متن ستون نگه داشته می‌شود. برای کالاهای موجود، گروه فقط وقتی تنظیم می‌شود که هنوز گروهی نداشته باشند. مسیر را می‌توانید با › یا > یا / بنویسید (مثل «قطعات یدکی › لنت ترمز»).'),
          h('div.row.wrap', { style: { gap: '6px', marginBottom: '8px' } }, h('span.badge.ok', 'متصل: ' + UI.fa(linked)), cats.length - linked ? h('span.badge.warn', 'بدون اتصال: ' + UI.fa(cats.length - linked)) : null));
        cats.forEach(function (c) {
          var r = c.res, ch = st.catChoice[c.key], o = { '': '— بدون گروه (فقط متن نگه داشته می‌شود) —' };
          (r.candidates.concat(r.suggestions)).forEach(function (id) { if (E.state.categories[id]) o[id] = (r.status === 'none' ? 'پیشنهاد: ' : '') + catPathLabel(id); });
          if (r.status === 'none') o.__create = '+ ساخت گروه «' + c.text.split(CAT_SEP).filter(Boolean).join(' › ') + '» (سطح‌های موجود استفاده می‌شوند)';
          active.forEach(function (x) { if (!(x.id in o)) o[x.id] = catPathLabel(x.id); });
          var badge = c.guessed && ch === '__create' ? h('span.badge.' + (c.guessed.conf === 'guess' ? 'warn' : 'ok'), c.guessed.conf === 'guess' ? '؟ حدس اپ از نام — بررسی کنید' : 'پیشنهاد اپ (گروه جدید)')
            : ch && ch !== (r.status === 'exact' ? r.id : null) ? h('span.badge.ok', '✓ انتخاب شما')
            : r.status === 'exact' ? h('span.badge.ok', '✓ متصل خودکار') : r.status === 'ambiguous' ? h('span.badge.warn', '⚠ مبهم: ' + UI.fa(r.candidates.length) + ' گروه هم‌نام — انتخاب کنید') : h('span.badge.bad', '✗ گروهی با این نام نیست');
          catCard.appendChild(h('div', { 'data-cat': c.text, style: { borderTop: '1px solid var(--line)', padding: '8px 0' } },
            h('div.row.wrap', { style: { gap: '6px', marginBottom: '6px' } }, h('b', c.text), badge, h('span.small.muted', UI.fa(c.rows) + ' ردیف')),
            sel(o, ch || '', { onchange: function () { st.catChoice[c.key] = this.value; draw(); } })));
        });
        box.appendChild(catCard);
      }
      function catCell(it) {
        if (!it.category) return '';
        var c = chosenCat(it);
        if (c && c.id) return catPathLabel(c.id);
        if (c && c.create) return 'گروه جدید: ' + it.category;
        return h('span', { style: { color: 'var(--warn)' } }, '⚠ ' + it.category + ' (بدون اتصال)');
      }
      var tbl = h('table.t', h('thead', h('tr', h('th', 'ردیف'), h('th', 'وضعیت'), h('th', 'کد'), h('th', 'نام'), h('th', 'برند'), h('th', 'گروه'), h('th', 'موجودی'), h('th', 'خرید'), h('th', 'فروش'))),
        h('tbody', items.slice(0, 300).map(function (it) {
          return h('tr', h('td.n', UI.fa(it.line)), h('td', h('span.badge.' + LBL[it.status][1], LBL[it.status][0]), it.errors.length ? h('div.small', { style: { color: 'var(--bad)' } }, it.errors.join('؛ ')) : it.dupOf ? h('div.small.muted', 'مشابه ردیف ' + UI.fa(it.dupOf)) : null),
            h('td', it.sku), h('td', it.name), h('td', it.brand), h('td', catCell(it)), h('td.n', it.stock == null ? '' : UI.qty(it.stock)), h('td.n', UI.money(it.buyPrice)), h('td.n', UI.money(it.sellPrice)));
        })));
      box.appendChild(h('div.table-wrap', tbl));
      var willNew = items.filter(function (it) { return it.status === 'new' || (it.status === 'namedup' && st.allowNameDup); });
      var btn = h('button.btn.primary.block', { disabled: !willNew.length && !(cnt.exists && st.onExisting === 'update'), onclick: function () { doImport(items, btn); } }, 'ثبت ' + UI.fa(willNew.length) + ' کالای جدید' + (cnt.exists && st.onExisting === 'update' ? ' و به‌روزرسانی موجودها' : ''));
      box.appendChild(h('div.sticky-act', btn));
    }
    function doImport(items, btn) {
      var fresh = items.filter(function (it) { return it.status === 'new' || (it.status === 'namedup' && st.allowNameDup); });
      var upd = st.onExisting === 'update' ? items.filter(function (it) { return it.status === 'exists'; }) : [];
      btn.disabled = true; btn.textContent = 'در حال ثبت…';
      var fns = [], created = [], planned = {}, levels = [];
      fresh.concat(upd.filter(function (it) { var cur = E.state.products[it.existing.id]; return cur && !cur.categoryId; })).forEach(function (it) {
        var c = chosenCat(it); if (!c || !c.create) return;
        var parts = it.category.split(CAT_SEP).map(function (x) { return x.trim(); }).filter(Boolean), pk = null;
        parts.forEach(function (name, i) {
          var key = parts.slice(0, i + 1).map(Core.normText).join('\u0001');
          if (!planned[key]) { planned[key] = { id: null }; levels.push({ key: key, name: name, parentKey: pk }); }
          pk = key;
        });
        it.catLeaf = pk;
      });
      levels.forEach(function (lv) {
        fns.push(function () {
          var parentId = lv.parentKey ? planned[lv.parentKey].id : null, ex = E.findCategoryByName(lv.name, parentId);
          if (ex) { planned[lv.key].id = ex.id; return { changes: [] }; }
          var r = E.createCategory({ name: lv.name, parentId: parentId }, A.userCtx()); planned[lv.key].id = r.category.id; return r;
        });
      });
      function catIdFor(it) { var c = chosenCat(it); return !c ? null : c.id ? c.id : (it.catLeaf && planned[it.catLeaf].id) || null; }
      fresh.forEach(function (it) {
        fns.push(function () {
          var r = E.createProduct({ sku: it.sku, name: it.name, brand: it.brand, category: it.category, categoryId: catIdFor(it), cars: it.cars, unit: it.unit, packSize: it.packSize || 1, minStock: it.minStock || 0,
            buyPrice: it.buyPrice, sellPrice: it.sellPrice, location: it.location, notes: it.notes, barcodes: it.barcode ? [it.barcode] : [], allowDuplicate: true });
          created.push({ p: r.product, it: it }); return r;
        });
      });
      upd.forEach(function (it) {
        fns.push(function () {
          var patch = { name: it.name }; ['brand', 'category', 'location', 'notes'].forEach(function (k) { if (it[k]) patch[k] = it[k]; });
          if (st.map.unit != null && it.unit) patch.unit = it.unit; ['packSize', 'minStock', 'buyPrice', 'sellPrice'].forEach(function (k) { if (it[k] != null) patch[k] = it[k]; });
          var cur = E.state.products[it.existing.id], cid = catIdFor(it);
          if (cid && cur && !cur.categoryId) patch.categoryId = cid; // never moves a product that already has a group
          if (cur && !(cur.cars || []).length && it.cars && it.cars.length) patch.cars = it.cars; // v2.3
          if (cur && cur.categoryId) delete patch.category;
          return E.updateProduct(it.existing.id, patch);
        });
      });
      fns.push(function () { // v2.3: the confirmed / chosen group of each guessed part type is learned
        var by = {}; fresh.forEach(function (it) { var id = catIdFor(it); if (it.guessed && it.guessed.key && id) by[it.guessed.key] = id; });
        var L = Object.keys(by).map(function (k) { return { key: k, categoryId: by[k] }; });
        return L.length ? E.learn(L, A.userCtx()) : { changes: [] };
      });
      fns.push(function () {
        var lines = created.filter(function (x) { return x.it.stock > 0; }).map(function (x) { return { productId: x.p.id, qty: x.it.stock, unitCost: x.it.buyPrice }; });
        if (!lines.length) return { changes: [] };
        return E.postReceipt({ opKey: 'import:' + st.fileHash + ':' + st.sheet, type: 'initial', items: lines, note: 'ورود دسته‌جمعی از فایل ' + st.fileName }, A.userCtx());
      });
      fns.push(function (dn) { return E.recordImport({ kind: 'products', label: 'ورود دسته‌جمعی کالا — ' + st.fileName, file: { name: st.fileName, sha256: st.fileHash } }, dn, A.userCtx()); }); // v2.2.2: can be undone
      DB.run(DB.batch(fns)).then(function (res) {
        var rc = res[res.length - 1];
        UI.toast(UI.fa(created.length) + ' کالا ثبت شد' + (upd.length ? '، ' + UI.fa(upd.length) + ' کالا به‌روز شد' : '') + '.', 'ok', 4000);
        UI.clear(box).appendChild(h('div.card', h('h2', 'ورود انجام شد ✓'), h('p', UI.fa(created.length) + ' کالای جدید' + (rc && rc.doc ? '، سند موجودی اولیه ' + rc.doc.no : '') + (upd.length ? '، ' + UI.fa(upd.length) + ' به‌روزرسانی' : '')),
          h('div.grid2', h('a.btn.primary', { href: '#/products' }, 'مشاهده کالاها'), h('a.btn', { href: '#/labels?new=1' }, 'چاپ برچسب'))));
        A.state.lastImported = created.map(function (x) { return x.p.id; });
      }, function (e) {
        btn.disabled = false; btn.textContent = 'تلاش دوباره';
        var fi = e.batchIndex != null ? e.batchIndex - levels.length : null;
        UI.toast('هیچ کالایی ثبت نشد. ' + A.errMsg(e) + (fi != null && fresh[fi] ? ' (ردیف ' + UI.fa(fresh[fi].line) + ')' : ''), 'bad', 7000);
      });
    }
  };

  // ======================= LABELS =======================
  A.routes.labels = function (arg, query) {
    A.setTitle('چاپ برچسب QR', true);
    var st = A.lsGet('ay.labels') || { size: '40', price: false, border: true, skip: 0, items: [], qr: 'internal' };
    if (!st.qr) st.qr = 'internal';
    if (query.p && E.state.products[query.p] && !st.items.some(function (x) { return x.id === query.p; })) st.items.push({ id: query.p, n: 1 });
    if (query.new && A.state.lastImported) { A.state.lastImported.forEach(function (id) { if (!st.items.some(function (x) { return x.id === id; })) st.items.push({ id: id, n: 1 }); }); A.state.lastImported = null; }
    st.items = st.items.filter(function (x) { return E.state.products[x.id]; });
    function save() { A.lsSet('ay.labels', st); }
    save();
    var T = window.PDF.LABELS, g = window.PDF.labelGrid(T[st.size]);
    var sizes = {}; Object.keys(T).forEach(function (k) { var gg = window.PDF.labelGrid(T[k]); sizes[k] = T[k].w + '×' + T[k].h + ' میلی‌متر (' + UI.fa(gg.perPage) + ' عدد در A4)'; });
    view.appendChild(h('div.card', field('اندازه برچسب', sel(sizes, st.size, { onchange: function () { st.size = this.value; st.skip = 0; save(); A.route(); } })),
      field('نوع QR', sel({ internal: 'داخلی انبار (برای اسکن در همین برنامه)', public: 'عمومی مشتری (نشانی وب ثابت؛ برای آینده)' }, st.qr, { onchange: function () { st.qr = this.value; save(); A.route(); } })),
      st.qr === 'public' ? h('div.alert.warn', h('div.grow', 'QR عمومی فقط یک نشانی وب با کد ثابت کالا (' + A.publicBase() + '/p/…) دارد؛ قیمت خرید، موجودی و اطلاعات داخلی در آن نیست و تغییر نام یا قیمت آن را عوض نمی‌کند. ',
        h('b', 'صفحه عمومی این نشانی هنوز راه‌اندازی نشده است'), '؛ اسکن آن با دوربین گوشی مشتری فعلاً به صفحه‌ای نمی‌رسد، ولی در همین برنامه کالا را پیدا می‌کند و پس از راه‌اندازی سایت نیاز به چاپ دوباره نیست.')) : null,
      h('label.check', h('input', { type: 'checkbox', checked: st.price, onchange: function () { st.price = this.checked; save(); } }), 'چاپ قیمت فروش روی برچسب'),
      h('label.check', h('input', { type: 'checkbox', checked: st.border, onchange: function () { st.border = this.checked; save(); } }), 'خط برش دور برچسب‌ها'),
      field('شروع از خانه شماره (برای برگه نیمه‌مصرف)', h('input.in', { inputmode: 'numeric', value: UI.fa(st.skip + 1), onchange: function () { var n = UI.parseInt2(this.value); st.skip = n && n > 0 ? Math.min(n - 1, g.perPage - 1) : 0; save(); } }))));
    var listBox = h('div');
    function drawList() {
      UI.clear(listBox);
      var total = st.items.reduce(function (s, x) { return s + x.n; }, 0);
      listBox.appendChild(h('div.row.between', { style: { margin: '10px 4px' } }, h('b', UI.fa(st.items.length) + ' کالا — ' + UI.fa(total) + ' برچسب'),
        h('div.row', h('button.btn.sm', { onclick: function () { A.pickProduct('افزودن به برچسب‌ها', function (p) { if (!st.items.some(function (x) { return x.id === p.id; })) st.items.push({ id: p.id, n: 1 }); save(); drawList(); }); } }, '+ کالا'),
          h('button.btn.sm', { onclick: function () {
            UI.confirmBox('برای همه کالاهای دارای موجودی، به تعداد موجودی برچسب اضافه شود؟').then(function (ok) {
              if (!ok) return; st.items = Object.keys(E.state.products).map(function (k) { return E.state.products[k]; }).filter(function (p) { return p.active !== false && p.stock > 0; }).map(function (p) { return { id: p.id, n: Math.min(p.stock, 500) }; }); save(); drawList();
            });
          } }, 'همه موجودی'),
          h('button.btn.sm', { onclick: function () {
            var log = E.getMeta('labelLog') || {};
            var miss = E.list('products').filter(function (p) { return p.active !== false && !log[p.id] && !(p.barcodes || []).length; });
            if (!miss.length) { UI.toast('همه کالاها برچسب یا بارکد کارخانه دارند.'); return; }
            miss.forEach(function (p) { if (!st.items.some(function (x) { return x.id === p.id; })) st.items.push({ id: p.id, n: Math.max(1, Math.min(p.stock, 500)) }); }); save(); drawList();
          } }, 'بدون برچسب'),
          st.items.length ? h('button.btn.sm.ghost', { onclick: function () { st.items = []; save(); drawList(); } }, 'پاک') : null)));
      if (!st.items.length) { listBox.appendChild(h('div.card.empty', 'کالایی انتخاب نشده است.')); return; }
      listBox.appendChild(h('div.card', { style: { padding: '4px 14px' } }, st.items.map(function (x, i) {
        var p = E.state.products[x.id];
        var lg = (E.getMeta('labelLog') || {})[p.id];
        return h('div.line.row', h('div.grow', h('b', p.name), h('div.small.muted', p.sku + ' · موجودی ' + UI.qty(p.stock) + (lg ? ' · قبلاً ' + UI.fa(lg.n) + ' برچسب (' + UI.dateFa(lg.at) + ')' : ' · بدون برچسب قبلی'))),
          A.stepper(x.n, function (v) { x.n = v; save(); }), h('button.btn.sm.ghost', { onclick: function () { st.items.splice(i, 1); save(); drawList(); } }, '✕'));
      })));
    }
    drawList();
    view.appendChild(listBox);
    var btn = h('button.btn.primary.block', { onclick: function () {
      var items = [];
      st.items.forEach(function (x) {
        var p = E.state.products[x.id], pub = st.qr === 'public';
        for (var i = 0; i < x.n; i++) items.push({ payload: pub ? A.publicBase() + '/p/' + p.publicCode : 'AY:' + p.id, ecl: pub ? 'M' : 'H', title: p.shortName || p.name, brand: p.brand,
          sku: pub ? p.publicCode : p.sku, price: st.price && p.sellPrice != null ? UI.money(p.sellPrice) + ' تومان' : '' });
      });
      if (!items.length) { UI.toast('کالایی انتخاب نشده.', 'bad'); return; }
      if (items.length > 3000) { UI.toast('حداکثر ۳۰۰۰ برچسب در هر نوبت.', 'bad'); return; }
      btn.disabled = true; btn.textContent = 'در حال ساخت PDF…';
      window.PDF.renderLabels(items, { size: st.size, border: st.border, skip: st.skip }).then(function (r) {
        btn.disabled = false; btn.textContent = 'ساخت PDF برچسب‌ها';
        // record that labels were generated (does NOT touch stock or identities)
        var log = E.getMeta('labelLog') || {}, t = Date.now();
        st.items.forEach(function (x) { var o = log[x.id] || { n: 0 }; log[x.id] = { n: o.n + x.n, at: t, qr: st.qr }; });
        A.run(function () { return E.putMeta('labelLog', log); }).catch(function () {});
        UI.fileSheet(r.pdf, 'labels-' + st.size + 'mm_' + stamp() + '.pdf', 'application/pdf', UI.fa(r.pages) + ' صفحه A4. هنگام چاپ «Actual size / 100%» را انتخاب کنید (نه Fit to page).');
      }, function (e) { btn.disabled = false; btn.textContent = 'ساخت PDF برچسب‌ها'; A.showErr(e); });
    } }, 'ساخت PDF برچسب‌ها');
    view.appendChild(h('div.sticky-act', btn));
  };

  // ======================= SETTINGS / BACKUP =======================
  A.routes.settings = function () {
    A.setTitle('تنظیمات و پشتیبان‌گیری', true);
    var shop = A.shop();
    var nm = h('input.in', { value: shop.name || '' }), ph = h('input.in.ltr-in', { value: shop.phone || '', inputmode: 'tel' }), ad = h('input.in', { value: shop.address || '' }), note = h('textarea.in', { value: shop.invoiceNote || '', placeholder: 'مثلاً: کالای فروخته‌شده با فاکتور تا ۷ روز قابل مرجوع است.' });
    // v2.8.1: accounts for payment (printed on invoices / proformas) + the proforma footer and validity
    var accs = (shop.accounts || []).map(function (x) { return Object.assign({}, x); }), accBox = h('div.stack');
    var qn = h('textarea.in', { value: shop.quoteNote != null ? shop.quoteNote : A.QUOTE_NOTE }), qh = h('input.in', { inputmode: 'numeric', value: UI.fa(shop.quoteHours || 48) });
    function drawAcc() {
      UI.clear(accBox);
      accs.forEach(function (x, i) {
        var bank = h('input.in', { value: x.bank || '', placeholder: 'بانک' }), own = h('input.in', { value: x.owner || '', placeholder: 'به نام' });
        var iban = h('input.in.ltr-in', { value: x.iban || '', placeholder: 'IR000000000000000000000000' }), card = h('input.in.ltr-in', { value: x.card || '', inputmode: 'numeric', placeholder: 'شماره کارت (اختیاری)' });
        var show = h('input', { type: 'checkbox', checked: x.show !== false });
        [bank, own, iban, card].forEach(function (el) { el.addEventListener('input', function () { x.bank = bank.value; x.owner = own.value; x.iban = iban.value; x.card = card.value; }); });
        show.addEventListener('change', function () { x.show = show.checked; });
        accBox.appendChild(h('div.card', h('div.grid2', bank, own), iban, card, h('label.check', show, 'نمایش در فاکتور و پیش‌فاکتور'),
          h('button.btn.sm.ghost', { onclick: function () { accs.splice(i, 1); drawAcc(); } }, 'حذف حساب')));
      });
    }
    drawAcc();
    view.appendChild(h('div.card', h('h2', 'اطلاعات فروشگاه (سربرگ فاکتور)'), field('نام فروشگاه', nm), field('تلفن', ph), field('نشانی', ad), field('متن پایین فاکتور', note),
      h('div.sec-title', 'حساب‌های واریز (برای خریدار در فاکتور و پیش‌فاکتور)'), accBox,
      h('button.btn.sm', { onclick: function () { accs.push({ show: true }); drawAcc(); } }, '+ حساب'),
      h('div.sec-title', 'پیش‌فاکتور'), field('اعتبار پیش‌فرض (ساعت)', qh), field('متن پایین پیش‌فاکتور', qn),
      h('button.btn.primary.block', { onclick: function () {
        var out = [], bad = null;
        accs.forEach(function (x) {
          var iban = A.normIban(x.iban), card = String(x.card || '').replace(/[^0-9۰-۹]/g, '').replace(/[۰-۹]/g, function (c) { return c.charCodeAt(0) - 1776; });
          if (!iban && !card && !String(x.bank || '').trim() && !String(x.owner || '').trim()) return; // an empty row
          if (iban && !A.ibanOk(iban)) bad = bad || 'شماره شبا «' + x.iban + '» درست نیست (IR و ۲۴ رقم، با رقم کنترل).';
          if (card && !A.cardOk(card)) bad = bad || 'شماره کارت «' + x.card + '» درست نیست.';
          if (!iban && !card) bad = bad || 'برای حساب «' + (x.bank || x.owner || '') + '» شبا یا شماره کارت را بنویسید.';
          out.push({ bank: String(x.bank || '').trim(), owner: String(x.owner || '').trim(), iban: iban, card: card, show: x.show !== false });
        });
        if (bad) { UI.toast(bad, 'bad', 6000); return; }
        var hrs = UI.parseNum(qh.value); if (!(hrs >= 1 && hrs <= 24 * 90 && Number.isInteger(hrs))) { UI.toast('اعتبار پیش‌فاکتور (ساعت) نامعتبر است.', 'bad'); return; }
        A.run(function () { return E.putMeta('shop', Object.assign({}, A.shop(), { name: nm.value.trim() || 'امیران یدک', phone: ph.value.trim(), address: ad.value.trim(), invoiceNote: note.value.trim(),
          accounts: out, quoteNote: qn.value.trim(), quoteHours: hrs })); }).then(function () { UI.toast('ذخیره شد.', 'ok'); A.route(); }, function () {});
      } }, 'ذخیره')));

    var pr = E.getMeta('prefs') || {}, sp = A.lsGet('ay.scanPrefs') || { fast: true, debug: false };
    var base = h('input.in.ltr-in', { value: pr.publicBase || 'https://amiran-yadak.ir', inputmode: 'url' }), lead = h('input.in', { inputmode: 'numeric', value: UI.fa(pr.leadDays || 7) });
    var cover = h('input.in', { inputmode: 'numeric', value: UI.fa(pr.coverDays || 30) });
    view.appendChild(h('div.card', h('h2', 'تنظیمات کاری'),
      field('زمان تأمین کالا از سفارش تا رسیدن (روز)', lead, h('div.hint', 'برای هشدار اتمام موجودی و پیشنهاد سفارش.')),
      field('موجودی هدف پس از سفارش (روز فروش)', cover),
      field('نشانی پایه QR عمومی', base, h('div.hint', 'فقط برای برچسب‌های QR عمومی (آینده). پس از چاپ برچسب‌ها تغییرش ندهید.')),
      h('button.btn.primary.block', { onclick: function () {
        var l = UI.parseInt2(lead.value), c = UI.parseInt2(cover.value), b = base.value.trim().replace(/\/+$/, '');
        if (!(l >= 0 && l <= 365) || !(c >= 1 && c <= 365)) { UI.toast('عددها را درست وارد کنید (۰ تا ۳۶۵).', 'bad'); return; }
        if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(b)) { UI.toast('نشانی باید با https:// شروع شود.', 'bad'); return; }
        A.run(function () { return E.putMeta('prefs', Object.assign({}, E.getMeta('prefs') || {}, { leadDays: l, coverDays: c, publicBase: b }), A.userCtx()); }).then(function () { UI.toast('ذخیره شد.', 'ok'); }, function () {});
      } }, 'ذخیره'),
      h('label.check', h('input', { type: 'checkbox', checked: sp.debug, onchange: function () { sp.debug = this.checked; A.lsSet('ay.scanPrefs', sp); } }), 'نمایش آمار زنده هنگام اسکن (برای سنجش سرعت)'),
      h('div.grid2', h('a.btn', { href: '#/scanstats' }, 'آمار سرعت اسکن'), h('a.btn', { href: '#/categories' }, 'گروه‌های کالا')),
      h('a.btn.block', { href: '#/suppliers', style: { marginTop: '8px' } }, 'تأمین‌کنندگان')));

    var bk = E.getMeta('backup');
    var counts = { products: 'کالا', customers: 'مشتری', docs: 'سند', payments: 'پرداخت' };
    // v2.2: optional online text reading of box labels (the key stays on this phone only; never in backups)
    (function () {
      var c = A.lsGet('ay.ocr') || {}, key = h('input.in', { value: c.key || '', placeholder: 'کلید Google Cloud Vision (API key)', autocomplete: 'off', class: 'ltr-in' });
      var on = h('input', { type: 'checkbox', checked: c.on !== false });
      view.appendChild(h('div.card', h('h2', 'خواندن نام کالا با اینترنت (اختیاری)'),
        h('p.small.muted', 'وقتی در اسکنر از جعبه‌ای بدون بارکد عکس می‌گیرید و گوشی به اینترنت وصل است، فقط همان عکس برچسب برای خواندن متن به Google Cloud Vision فرستاده می‌شود (فارسی را می‌خواند؛ ۱۰۰۰ عکس اول هر ماه رایگان). اطلاعات فاکتور، مشتری یا قیمت فرستاده نمی‌شود. بدون اینترنت، برنامه از روی برچسب‌هایی که قبلاً تأیید کرده‌اید تشخیص می‌دهد. کلید فقط روی همین گوشی می‌ماند و در فایل پشتیبان نیست.'),
        field('کلید', key), h('label.check', on, 'استفاده از خواندن متن با اینترنت'),
        h('div.grid2', h('button.btn.primary', { onclick: function () { var k = key.value.trim(); A.lsSet('ay.ocr', k ? { provider: 'google', key: k, on: on.checked } : null); UI.toast(k ? 'ذخیره شد.' : 'کلید حذف شد.', 'ok'); } }, 'ذخیره'),
          h('button.btn', { onclick: function () { A.lsSet('ay.ocr', null); key.value = ''; UI.toast('کلید حذف شد.'); } }, 'حذف کلید')),
        h('div.small.muted', { style: { marginTop: '6px' } }, 'برچسب‌های یادگرفته‌شده: ' + UI.fa(Object.keys(E.visualMemory()).length) + ' کالا')));
    })();
    view.appendChild(h('div.card', h('h2', 'پشتیبان‌گیری'),
      h('p.small', 'اطلاعات فقط روی همین آیفون ذخیره می‌شود. حداقل هفته‌ای یک بار فایل پشتیبان بگیرید و آن را در Files / iCloud / تلگرام ذخیره کنید. با حذف برنامه از صفحه اصلی، اطلاعات هم پاک می‌شود.'),
      h('p.small.muted', Object.keys(counts).map(function (k) { return UI.fa(Object.keys(E.state[k]).length) + ' ' + counts[k]; }).join(' · ')),
      h('p.small', 'آخرین پشتیبان: ', h('b', bk ? UI.dateFa(bk.at, true) : 'هرگز')),
      h('div.grid2', h('button.btn.primary', { onclick: A.backup }, 'دریافت فایل پشتیبان'), h('button.btn', { onclick: A.restore }, 'بازیابی از فایل')),
      h('a.btn.block', { href: '#/health', style: { marginTop: '8px' } }, 'بررسی سلامت داده‌ها')));

    var ct = E.closedThrough();
    view.appendChild(h('div.card', h('h2', 'دوره مالی'), h('p.small', ct == null ? 'هیچ دوره‌ای بسته نشده است؛ همه تاریخ‌ها باز هستند.' : 'اسناد تا ' + UI.dateFa(ct) + ' بسته و قفل شده‌اند.'),
      h('p.small.muted', 'ثبت با تاریخ بیش از ' + UI.fa(E.BACKDATE_DAYS) + ' روز گذشته فقط با رمز مدیر ممکن است.'), h('a.btn.block', { href: '#/period' }, 'بستن دوره / سابقه')));
    view.appendChild(A.snapshotsCard());

    var auth = E.getMeta('auth');
    view.appendChild(h('div.card', h('h2', 'رمز مدیر'), h('p.small.muted', 'برای برگشت سند، اصلاح موجودی، بازپرداخت، بازیابی و حذف اطلاعات لازم است.'),
      h('p', auth && auth.hash ? 'رمز مدیر تعیین شده است.' : 'رمز مدیر تعیین نشده است.'),
      h('div.grid2', h('button.btn', { onclick: function () { setPin(!!(auth && auth.hash)).then(function () { A.route(); }); } }, auth && auth.hash ? 'تغییر رمز' : 'تعیین رمز'),
        auth && auth.hash ? h('button.btn', { onclick: function () { A.manager('حذف رمز مدیر').then(function (ctx) { if (ctx) A.run(function () { return E.putMeta('auth', {}); }).then(function () { UI.toast('رمز حذف شد.'); A.route(); }); }); } }, 'حذف رمز') : h('span'))));

    var stor = h('p.small.muted', 'در حال بررسی…');
    view.appendChild(h('div.card', h('h2', 'وضعیت حافظه و برنامه'), stor,
      h('div.grid2', h('button.btn', { onclick: function () { if (A.checkUpdate) A.checkUpdate().then(function () { UI.toast('بررسی شد؛ اگر نسخه جدید باشد پیام به‌روزرسانی نمایش داده می‌شود.'); }); else UI.toast('به‌روزرسانی فقط روی HTTPS فعال است.'); } }, 'بررسی به‌روزرسانی'),
        h('a.btn', { href: '#/report/reconcile' }, 'کنترل مغایرت'))));
    Promise.all([DB.estimate(), navigator.storage && navigator.storage.persisted ? navigator.storage.persisted().catch(function () { return null; }) : Promise.resolve(null)]).then(function (r) {
      var est = r[0], per = r[1], standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
      stor.textContent = 'نسخه ' + UI.fa(A.version) + ' · ' + (standalone ? 'اجرا به‌صورت برنامه نصب‌شده' : 'اجرا داخل مرورگر') + (est && est.usage != null ? ' · حجم داده: ' + UI.fa((est.usage / 1048576).toFixed(1)) + ' مگابایت' : '') +
        (per === true ? ' · حافظه ماندگار ✓' : per === false ? ' · حافظه ماندگار تأیید نشده (پشتیبان‌گیری منظم مهم است)' : '');
    });

    view.appendChild(h('div.card', h('h2', 'حذف همه اطلاعات'), h('p.small.muted', 'قبل از حذف، یک نسخه داخلی ذخیره می‌شود. بهتر است اول فایل پشتیبان بگیرید.'),
      h('button.btn.danger.block', { onclick: wipe }, 'حذف همه اطلاعات این دستگاه')));
  };
  function recoveryCode() {
    var A32 = '23456789ABCDEFGHJKMNPQRSTUVWXYZ', b = new Uint8Array(12), out = '';
    crypto.getRandomValues(b); for (var i = 0; i < 12; i++) out += A32[b[i] % A32.length] + (i % 4 === 3 && i < 11 ? '-' : '');
    return out;
  }
  A.setPin = function (hasOld) { return setPin(hasOld); };
  function setPin(hasOld) {
    var go = function () {
      return UI.pinPad('رمز جدید مدیر', '۴ تا ۸ رقم').then(function (p1) {
        if (!p1) return;
        return UI.pinPad('تکرار رمز جدید').then(function (p2) {
          if (p2 !== p1) { UI.toast('دو رمز یکسان نیستند؛ رمز ذخیره نشد.', 'bad'); return; }
          var salt = UI.opKey('s'), code = recoveryCode();
          return Promise.all([UI.sha256hex(salt + ':' + p1), UI.sha256hex(salt + ':rec:' + A.normRecovery(code))])
            .then(function (hx) { return A.run(function () { return E.putMeta('auth', { salt: salt, hash: hx[0], rec: hx[1], at: Date.now() }); }); })
            .then(function () {
              return new Promise(function (res) {
                var s = UI.sheet('کد بازیابی رمز', h('div.stack', h('p', 'رمز مدیر ذخیره شد. اگر رمز را فراموش کنید، فقط با این کد می‌توانید رمز جدید بگذارید. آن را روی کاغذ یادداشت کنید و جای امن نگه دارید:'),
                  h('div.card', { style: { textAlign: 'center', fontSize: '24px', fontWeight: 700, letterSpacing: '2px' } }, h('span.ltr#rec-code', code)),
                  h('button.btn.primary.block', { onclick: function () { s.close(); } }, 'یادداشت کردم')), { modal: true, onClose: res });
              });
            });
        });
      });
    };
    if (hasOld) return A.manager('تغییر رمز مدیر').then(function (ctx) { if (ctx) return go(); });
    return go();
  }
  function wipe() {
    A.manager('حذف همه اطلاعات').then(function (ctx) {
      if (!ctx) return;
      UI.promptBox('حذف همه اطلاعات', 'برای تأیید، کلمه «حذف» را بنویسید').then(function (v) {
        if (Core.normText(v) !== 'حذف') return;
        DB.putSnapshot('pre-wipe', E.exportAll(), 3).then(function () { return DB.replaceAll(A.emptyData()); }).then(function () {
          ['in', 'out', 'purchase'].forEach(function (k) { A.lsSet('ay.draft.' + k, null); }); A.lsSet('ay.labels', null);
          UI.toast('همه اطلاعات حذف شد.'); A.go('#/setup');
        }).catch(A.showErr);
      });
    });
  }

  // ======================= FIRST RUN =======================
  A.routes.setup = function () {
    A.setTitle('شروع', false);
    if (E.getMeta('shop')) { A.go('#/'); return; }
    var nm = h('input.in', { value: 'امیران یدک' }), ph = h('input.in.ltr-in', { inputmode: 'tel', placeholder: 'اختیاری' });
    var restoreBtn = h('button.btn.block', { onclick: function () { A.restore(); } }, 'بازیابی از فایل پشتیبان');
    view.appendChild(h('div.card', h('h2', 'به برنامه انبار امیران یدک خوش آمدید'),
      h('p.small', 'همه اطلاعات روی همین گوشی و بدون نیاز به اینترنت ذخیره می‌شود.'), field('نام فروشگاه', nm), field('تلفن فروشگاه', ph),
      h('button.btn.primary.block', { onclick: function () {
        A.run(function () { return E.putMeta('shop', { name: nm.value.trim() || 'امیران یدک', phone: ph.value.trim(), createdAt: Date.now() }); }).then(function () {
          UI.confirmBox('برای عملیات حساس (برگشت سند، اصلاح موجودی، بازیابی) رمز مدیر تعیین می‌کنید؟ (پیشنهاد می‌شود)', 'تعیین رمز').then(function (ok) {
            (ok ? setPin(false) : Promise.resolve()).then(function () { A.go('#/'); });
          });
        }, function () {});
      } }, 'شروع')));
    view.appendChild(h('div.card', h('b', 'اطلاعات قبلی دارید؟'), h('p.small.muted', 'اگر از قبل فایل پشتیبان گرفته‌اید، آن را بازیابی کنید.'), restoreBtn));
    A.routes.help(null, null, true);
  };

  // ======================= SCAN SPEED STATS (measured on THIS device) =======================
  A.routes.scanstats = function () {
    A.setTitle('آمار سرعت اسکن', true, h('button.tb-btn', { onclick: function () { A.lsSet('ay.scanStats', []); A.route(); } }, 'پاک کردن'));
    var all = A.lsGet('ay.scanStats') || [], scans = all.filter(function (e) { return e.type === 'scan' && e.format !== 'manual' && e.format !== 'search'; }), sess = all.filter(function (e) { return e.type === 'session'; });
    function med(a) { if (!a.length) return null; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }
    function p90(a) { if (!a.length) return null; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.min(b.length - 1, Math.floor(b.length * 0.9))]; }
    function ms(v) { return v == null ? '—' : UI.fa(Math.round(v)) + ' ms'; }
    var cm = all.filter(function (e) { return e.type === 'commit'; });
    view.appendChild(h('div.alert.ok', h('div.grow', 'این اعداد روی همین گوشی و با دوربین واقعی اندازه‌گیری شده‌اند (' + UI.fa(scans.length) + ' اسکن، ' + UI.fa(sess.length) + ' نوبت باز کردن دوربین). برای سنجش دقیق، «نمایش آمار زنده» را در تنظیمات روشن کنید.')));
    view.appendChild(h('div.card', h('dl.kv',
      h('dt', 'باز شدن دوربین'), h('dd', ms(med(sess.map(function (e) { return e.openMs; }).filter(function (x) { return x != null; })))),
      h('dt', 'تا اولین تصویر'), h('dd', ms(med(sess.map(function (e) { return e.firstFrameMs; }).filter(function (x) { return x != null; })))),
      h('dt', 'رمزگشایی هر تصویر (میانه جلسات)'), h('dd', ms(med(sess.map(function (e) { return e.avgDecodeMs; }).filter(function (x) { return x != null; })))),
      h('dt', 'رمزگشایی تصویر موفق (میانه / ۹۰٪)'), h('dd', ms(med(scans.map(function (e) { return e.decodeMs; }))) + ' / ' + ms(p90(scans.map(function (e) { return e.decodeMs; })))),
      h('dt', 'از تشخیص تا نمایش نتیجه (میانه / ۹۰٪)'), h('dd', ms(med(scans.map(function (e) { return e.displayMs; }))) + ' / ' + ms(p90(scans.map(function (e) { return e.displayMs; })))),
      h('dt', 'از باز شدن دوربین تا اولین تشخیص'), h('dd', ms(med(scans.map(function (e) { return e.sinceStart; }).filter(function (x) { return x != null; })))),
      h('dt', 'ثبت نهایی سند (میانه)'), h('dd', ms(med(cm.map(function (e) { return e.ms; })))),
      h('dt', 'موتور رمزگشایی'), h('dd', (sess[sess.length - 1] || {}).engine || '—'))));
    if (scans.length) view.appendChild(h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'زمان'), h('th', 'نوع'), h('th', 'رمزگشایی'), h('th', 'نمایش'), h('th', 'عمل'))),
      h('tbody', scans.slice(-40).reverse().map(function (e) { return h('tr', h('td', UI.dateFa(e.at, true)), h('td', e.format), h('td.n', ms(e.decodeMs)), h('td.n', ms(e.displayMs)), h('td', e.action || '')); })))));
  };

  // ======================= HELP =======================
  A.routes.help = function (arg, q, inline) {
    if (!inline) A.setTitle('راهنما', true);
    function sec(t, items) { return h('div.card', h('h2', t), h('ol', { style: { paddingRight: '18px', margin: 0 } }, items.map(function (x) { return h('li', { style: { marginBottom: '6px', fontSize: '14.5px' } }, x); }))); }
    view.appendChild(sec('نصب روی آیفون', ['برنامه را در Safari با نشانی HTTPS باز کنید (Chrome آیفون برای نصب مناسب نیست).', 'دکمه اشتراک‌گذاری (مربع با فلش رو به بالا) ← Add to Home Screen ← Add.',
      'از این به بعد فقط از آیکون «امیران یدک» روی صفحه اصلی وارد شوید؛ اطلاعات Safari و برنامه نصب‌شده جدا هستند.', 'بار اول که «اسکن» را می‌زنید، اجازه دسترسی به دوربین را بدهید (Allow).']));
    view.appendChild(sec('کار روزانه', ['تعریف کالا: کالاها ← + یا ورود دسته‌جمعی از Excel.', 'چاپ برچسب QR: بیشتر ← چاپ برچسب ← PDF ← چاپ با اندازه واقعی (100%).',
      'ورود سریع کالا: خانه ← ورود کالا ← اسکن. بارکد ناشناخته فقط بار اول نام (و برند) می‌خواهد؛ بعد از آن هر اسکن همان کالا خودکار +۱ می‌کند (بین دو اسکن، دوربین را حدود ۲ ثانیه از روی بارکد بردارید یا دکمه + را بزنید). بعد از اسکن همه کالاها، در همان فهرست بهای خرید و قیمت فروش را وارد کنید و «ثبت ورود» را بزنید؛ فهرست تا ثبت ذخیره می‌ماند. بهای خرید بعد از ثبت اضافه نمی‌شود و بدون آن سود فروش «نامشخص» است.',
      'فروش: خانه ← فروش/خروج ← انتخاب مشتری ← اسکن کالاها ← قیمت و تعداد ← دریافت وجه (کامل/ناقص) ← ثبت فاکتور ← PDF فاکتور.',
      'خروج غیرفروش (ضایعات، مصرف داخلی، مرجوعی به تأمین‌کننده): در فرم خروج، نوع خروج را تغییر دهید.', 'دریافت بدهی: مشتریان ← مشتری ← دریافت وجه (به ترتیب قدیمی‌ترین فاکتورها تسویه می‌شود).',
      'فاکتور اشتباه شد؟ فاکتور را باز کنید ← «اصلاح فاکتور» (لغو و فاکتور جدید با انتقال پرداخت‌ها در یک مرحله) یا «لغو فاکتور». برگشت بخشی از کالا: «مرجوعی کالا». همه با رمز مدیر؛ سند اصلی پاک نمی‌شود و سابقه می‌ماند.', 'اسکن پشت‌سرهم: در صفحه اسکن دکمه پایین را روی «حالت: سریع» بگذارید؛ هر کالای جدید با یک اسکن اضافه می‌شود و اسکن تکراری همان کالا فقط با تأیید شما تعداد را زیاد می‌کند. در پایان «پایان» و سپس ثبت.', 'شمارش انبار: صفحه کالا ← اصلاح موجودی (با علت و رمز مدیر).']));
    view.appendChild(sec('تعداد، لیست قیمت و یادگیری', ['واحد هر کالا همان «تنوع» است که می‌فروشید: یک جعبهٔ دوتایی = ۱، یک ست = ۱. هر اسکن بارکد = ۱. «تعداد داخل هر جعبه» فقط مشخصه است؛ در ورود لیست قیمت، قیمت هر عدد × این تعداد = قیمت تنوع.',
      '«ست» (چپ + راست با هم) کالای جداست و هیچ‌وقت با چپ یا راست یکی گرفته نمی‌شود.',
      'لیست قیمت: بیشتر ← لیست قیمت ← انتخاب فایل Excel/CSV ← نوع (خرید یا فروش)، ریال/تومان ← تطبیق. کد یکسان یا ردیفی که قبلاً تأیید کرده‌اید خودکار است؛ نام‌های شبیه را تأیید کنید. برنامه انتخاب شما را یاد می‌گیرد.',
      'بهای خرید خالی: از نزدیک‌ترین لیست قیمت خرید پر می‌شود (اول همان تأمین‌کننده، بعد آخرین لیست پیش از تاریخ ورود، وگرنه اولین لیست بعد از آن)؛ ورودهای قبلیِ بی‌قیمت هنگام بارگذاری لیست تکمیل می‌شوند (با رمز مدیر). ردیف‌هایی از لیست که در برنامه نیستند، با سرگروه (مثلاً «۲۰۶») به‌عنوان گروه، کالای جدید تعریف می‌شوند. بیشتر ← تکمیل بهای خرید برای ورود دستی.',
      'گزارش موجودی: ارزش با بهای خرید، با قیمت فروش و با قیمت خرید روز. گزارش سود: ستون «سود به قیمت روز» برای دوران تورم.',
      'جستجو: اگر کالا با نوشته شما پیدا نشد، نزدیک‌ترین‌ها پیشنهاد می‌شود؛ انتخاب شما یاد گرفته می‌شود.']));
    view.appendChild(sec('گروه، خودرو، قیمت فروش و اسکن (۲٫۴)', ['ساختار گروه‌ها: «قطعات یدکی › سیستم › نوع قطعه» (مثل قطعات یدکی › سیستم تعلیق و جلوبندی › سیبک زیر اکسل) و «متفرقه › نوع کالا».',
      'خودرو جدا از گروه روی هر کالا ثبت می‌شود و یک قطعه می‌تواند چند خودرو داشته باشد (مثل پژو ۴۰۵، زانتیا، پژو پارس). در گزارش‌ها فیلتر «خودرو» دارید.',
      'در لیست قیمت و ورود دسته‌جمعی، اپ گروه را از نام حدس می‌زند؛ موارد «؟» را بررسی یا «تغییر» دهید. با ثبت، انتخاب شما یاد گرفته می‌شود. سرگروهی مثل «پژو ۲۰۶» خودروی ردیف‌های زیرش است.',
      'کالاهای قبلی: بیشتر ← مرتب‌سازی گروه‌ها ← بررسی ← انتقال. اگر اشتباه شد: بیشتر ← سابقه ورود از فایل ← بازگرداندن.',
      'قیمت فروش از لیست خرید: بیشتر ← لیست قیمت ← دکمه «قیمت فروش» کنار هر لیست ← درصد سود هر برند (و در صورت نیاز هر گروه) ← ثبت. قیمت رو به بالا تا ۱٬۰۰۰ تومان گرد می‌شود و قابل بازگرداندن است.',
      'اسکن ورود: دوربین بعد از هر کالا باز می‌ماند (بوق + چشمک سبز). با بستن دوربین، اپ ثبت رسید را می‌پرسد تا موجودی اضافه شود. اسکن از صفحه اصلی هم با «ورود» یا «خروج» بدون بستن دوربین ادامه پیدا می‌کند.',
      'بارکد آسیب‌دیده: اگر بخشی از بارکد یکی از کالاهای شما خوانده شود، اپ «شاید این کالاست؟» می‌پرسد. اسکن کد فنی (کد داخلی / مدل) هم کالا را پیدا می‌کند.']));
    view.appendChild(sec('فاکتور خرید و دوره مالی', ['فاکتور خرید: بیشتر ← فاکتور خرید ← تأمین‌کننده، شماره و تاریخ فاکتور ← اقلام (اسکن، انتخاب یا Excel) ← تخفیف و هزینه‌ها (حمل، مالیات و…) ← پیش‌نمایش ← ثبت. پیش‌نویس روی همین گوشی می‌ماند تا ثبت شود.',
      'برای مالیات بر ارزش افزوده در هر فاکتور صریحاً انتخاب کنید که جزو بهای کالا شود یا جدا نگه داشته شود؛ پیش‌فرض ذخیره‌شده‌ای وجود ندارد.', 'فاکتور تکراری (همان تأمین‌کننده و شماره) ثبت نمی‌شود؛ موارد مشابه هشدار می‌دهند. ثبت با وجود هشدار فقط با رمز مدیر و ذکر علت ممکن است.',
      'تاریخ واقعی دریافت/پرداخت وجه جدا از تاریخ فاکتور است و پیش‌فرض آن امروز است.', 'بستن دوره: بیشتر ← دوره مالی ← بررسی سلامت ← دریافت و ذخیره پشتیبان ← تأیید ← رمز مدیر. اسناد دوره بسته تغییر نمی‌کنند؛ اصلاح با سند جبرانی در دوره باز انجام می‌شود.',
      'بازگشایی دوره فقط با رمز مدیر و ذکر علت انجام می‌شود و سابقه آن می‌ماند.', 'گزارش‌های بازه‌ای وضعیت پرداخت را «تا پایان بازه» نشان می‌دهند؛ گزارش‌هایی که «وضعیت امروز» دارند برچسب خورده‌اند.']));
    view.appendChild(sec('گزارش و تحلیل', ['گزارش‌ها: بازه زمانی را انتخاب کنید، «فیلترها» را بزنید و هر ترکیبی از گروه، برند، مشتری، تأمین‌کننده، نوع سند، وضعیت پرداخت، مبلغ و… را بگذارید. روی عنوان ستون بزنید تا مرتب شود.', 'Excel، CSV و PDF دقیقاً همان ردیف‌ها و جمع روی صفحه را می‌دهند؛ فیلترهای پرکاربرد را با «ذخیره این فیلتر» نگه دارید.',
      'تحلیل مدیریتی (گزارش‌ها ← تحلیل مدیریتی): پرفروش و راکد، سرمایه خوابیده، خطر اتمام و پیشنهاد سفارش، سودآوری، مشتریان و موارد غیرعادی. کنار هر بخش «کفایت داده» و «اطمینان» آمده؛ پیشنهادها تخمین‌اند.', 'سود فقط برای فروش کالاهایی حساب می‌شود که قیمت خریدشان ثبت شده؛ برای دقت بیشتر، قیمت خرید را در ورود کالا وارد کنید.',
      'بسته داده برای هوش مصنوعی (پایین صفحه گزارش‌ها): یک ZIP برای بارگذاری در گفت‌وگو با Claude؛ نام و تلفن مشتریان به‌طور پیش‌فرض در آن نیست.']));
    view.appendChild(sec('ایمنی اطلاعات', ['هر عملیات یا کامل ثبت می‌شود یا اصلاً ثبت نمی‌شود؛ دوبار زدن دکمه یا اسکن تکراری، سند تکراری نمی‌سازد.', 'خروج بیشتر از موجودی امکان‌پذیر نیست.',
      'هفته‌ای یک بار: تنظیمات ← دریافت فایل پشتیبان ← ذخیره در Files یا ارسال برای خودتان.', 'اگر برنامه را از صفحه اصلی حذف کنید، اطلاعات آن هم پاک می‌شود؛ قبلش حتماً پشتیبان بگیرید.']));
  };
})();
