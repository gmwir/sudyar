/* v2.5 — Consumer sale price list (بیشتر ← لیست قیمت فروش).
   Builds Amiran Yadak's price list for consumers from the products in the app: choose a group (any level, e.g.
   «لنت ترمز» or a whole system), and the list is laid out group › brand › the brand's variants with their price.
   Layout comes from a FORMAT: the built-in one uses the app's own colours; the user can change it (title, colour,
   font size, orientation, columns, note…), save the change, or save it as new formats. Formats live in meta
   'saleListFormats' (so they are in the backup). Output: on-screen preview, PDF (A4) and Excel. Read-only on data.
   v2.6: «خروجی برای استودیو» — the same products as the list on screen, as a small JSON file for the catalog &
   price-list studio (studioexport.js; whitelist only: no purchase price, stock, customer or document data). */
(function () {
  'use strict';
  var A = window.App, E = A.E, UI = window.UI, h = UI.h, view = document.getElementById('view');
  var field = A.field, sel = A.sel, LS = 'ay.saleslist', META = 'saleListFormats';
  var XMIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var COLS = [['idx', 'ردیف'], ['name', 'نام کالا'], ['cars', 'خودرو'], ['sku', 'کد کالا'], ['unit', 'واحد'], ['price', 'قیمت (تومان)'], ['carton', 'قیمت کارتن']];
  var PW = { idx: 0.42, name: 3.1, cars: 1.55, sku: 1.05, unit: 0.6, price: 1.2, carton: 1.45 };
  var SIZES = { s: ['کوچک', 2.55], m: ['متوسط', 2.95], l: ['بزرگ', 3.4] };
  var PRESETS = [['رنگ برنامه', '#1d3b53'], ['آبی', '#1f4f9a'], ['سبز', '#1f6b4a'], ['زرشکی', '#8a1c2b'], ['نارنجی', '#a24f00'], ['خاکستری', '#3b3f45']];
  var OTHER = 'سایر کالاها', NOBRAND = 'بدون برند';

  function defFormat() {
    return { id: 'default', name: 'پیش‌فرض برنامه', title: 'لیست قیمت مصرف‌کننده', sub: '', color: '#1d3b53', size: 'm', landscape: false,
      cols: { idx: true, name: true, cars: true, sku: false, unit: false, price: true, carton: false },
      note: 'قیمت‌ها به تومان است و ممکن است بدون اطلاع قبلی تغییر کند.', date: true, contact: true, zebra: true, count: true };
  }
  function norm(f) { var d = defFormat(); return Object.assign(d, f || {}, { cols: Object.assign({}, d.cols, (f && f.cols) || {}) }); }
  function stored() { var m = E.getMeta(META); return m && Array.isArray(m.list) ? m.list : []; }
  function formats() { // the built-in format first (an edited copy of it replaces it), then the user's own
    var L = stored(), def = L.filter(function (f) { return f.id === 'default'; })[0];
    return [norm(def || null)].concat(L.filter(function (f) { return f.id !== 'default'; }).map(norm));
  }
  function saveFormats(list) { return A.run(function () { return E.putMeta(META, { list: list }); }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // colours of a format: the main colour + light tints of it for the table header / brand bars
  function mix(hex, t) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#e8eef4';
    var n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    function c(x) { var v = Math.round(x + (255 - x) * t); return ('0' + v.toString(16)).slice(-2); }
    return '#' + c(r) + c(g) + c(b);
  }
  function theme(F) { var c = /^#[0-9a-f]{6}$/i.test(F.color) ? F.color : '#1d3b53'; return { brand: c, head: mix(c, 0.86), band2: mix(c, 0.91), zebra: F.zebra ? '#f7f8f9' : null, ink: '#111111' }; }

  // ---------- data ----------
  function under(cid, root) { for (var c = cid, g = 0; c && g < 60; g++) { if (c === root) return true; var x = E.state.categories[c]; c = x ? x.parentId : null; } return false; }
  function priceOf(p, key) { return key && key !== 'base' && p.prices && p.prices[key] != null ? p.prices[key] : p.sellPrice; }
  function carsOf(p) { return (p.cars || []).join('، ') || p.model || ''; }
  var cmp = function (a, b) { return String(a).localeCompare(String(b), 'fa', { numeric: true }); };
  /* v2.9: ONE builder for the screen, PDF, Excel and the studio file (so they can never disagree).
     st: {groups: [ids] (none = all), brands: [], stock, noPrice, sets: all|only|none, setsTogether, layout: group|brand|car, sort: name|price|priceDesc|sku}
     Returns sections › subs › items and what was left out (ex) with the reason, so nothing disappears silently. */
  var SETS = 'ست‌ها (همه ست‌ها زیر هم)', NOCAR = 'سایر خودروها';
  function isSet(p) { return /(^|[\s(،])ست([\s)،]|$)/.test(Core.normText(p.name)); }
  function groupsOf(st) { var g = (st.groups || (st.group ? [st.group] : [])).filter(function (id) { return E.state.categories[id]; }); return g; }
  function build(st) {
    var G = groupsOf(st), one = G.length === 1 ? G[0] : null, oneDepth = one ? E.categoryPath(one).length : 0, lay = st.layout || 'group';
    var secs = {}, brandsAll = {}, total = 0, ex = { inactive: 0, group: 0, price: 0, stock: 0, brand: 0, set: 0 };
    Object.keys(E.state.products).forEach(function (k) {
      var p = E.state.products[k]; if (p.active === false) { ex.inactive++; return; }
      if (G.length && !G.some(function (g) { return under(p.categoryId, g); })) { ex.group++; return; }
      var sset = isSet(p);
      if (st.sets === 'only' && !sset || st.sets === 'none' && sset) { ex.set++; return; }
      var price = priceOf(p, st.price);
      if (price == null && !st.noPrice) { ex.price++; return; }
      if (st.stock && !(p.stock > 0)) { ex.stock++; return; }
      var b = String(p.brand || '').trim() || NOBRAND;
      brandsAll[b] = (brandsAll[b] || 0) + 1;
      if (st.brands && st.brands.length && st.brands.indexOf(b) < 0) { ex.brand++; return; }
      var path = p.categoryId && E.state.categories[p.categoryId] ? E.categoryPath(p.categoryId) : null, g;
      if (!path) g = OTHER;
      else if (one) { var rel = path.slice(oneDepth); g = rel.length ? rel.join(' › ') : path[path.length - 1]; }
      else g = path.length > 1 ? path.slice(1).join(' › ') : path[0];
      if (st.setsTogether && sset) g = SETS;
      var car = (p.cars && p.cars[0]) || p.model || NOCAR;
      var sec = lay === 'brand' ? b : lay === 'car' ? car : g, sub = lay === 'brand' ? g : lay === 'car' ? g + ' — ' + b : b;
      var S0 = secs[sec] || (secs[sec] = { label: sec, count: 0, brands: {} });
      (S0.brands[sub] = S0.brands[sub] || []).push({ p: p, price: price, set: sset });
      S0.count++; total++;
    });
    var last = function (x) { return x === OTHER || x === NOBRAND || x === NOCAR ? 2 : x === SETS ? 1 : 0; };
    var srt = st.sort === 'price' ? function (x, y) { return (x.price == null) - (y.price == null) || x.price - y.price || cmp(x.p.name, y.p.name); }
      : st.sort === 'priceDesc' ? function (x, y) { return (x.price == null) - (y.price == null) || y.price - x.price || cmp(x.p.name, y.p.name); }
      : st.sort === 'sku' ? function (x, y) { return cmp(x.p.sku || '', y.p.sku || ''); } : function (x, y) { return cmp(x.p.name, y.p.name); };
    var sections = Object.keys(secs).sort(function (a, b) { return last(a) - last(b) || cmp(a, b); }).map(function (k) {
      var s0 = secs[k];
      return { label: s0.label, count: s0.count, brands: Object.keys(s0.brands).sort(function (a, b) { return last(a) - last(b) || cmp(a, b); }).map(function (bn) {
        return { name: bn, items: s0.brands[bn].sort(srt) };
      }) };
    });
    return { sections: sections, total: total, brandsAll: brandsAll, ex: ex, layout: lay };
  }
  function exText(ex, st) {
    var L = [];
    if (ex.price) L.push(UI.fa(ex.price) + ' بدون قیمت فروش' + (st.noPrice ? '' : ' (گزینه «بدون قیمت» را بزنید تا بیایند)'));
    if (ex.group) L.push(UI.fa(ex.group) + ' بیرون از گروه‌های انتخابی');
    if (ex.brand) L.push(UI.fa(ex.brand) + ' برندهای انتخاب‌نشده');
    if (ex.set) L.push(UI.fa(ex.set) + ' به خاطر فیلتر ست');
    if (ex.stock) L.push(UI.fa(ex.stock) + ' ناموجود');
    if (ex.inactive) L.push(UI.fa(ex.inactive) + ' غیرفعال');
    return L.length ? 'کنار گذاشته شد: ' + L.join('، ') : 'هیچ کالایی کنار گذاشته نشد.';
  }
  function cell(key, it, n, forXlsx) {
    var p = it.p;
    switch (key) {
      case 'idx': return forXlsx ? n : UI.fa(n);
      case 'name': return p.name;
      case 'cars': return carsOf(p);
      case 'sku': return p.sku || '';
      case 'unit': return p.unit || '';
      case 'price': return it.price == null ? (forXlsx ? '' : 'تماس بگیرید') : forXlsx ? it.price : UI.money(it.price);
      case 'carton': return p.cartonQty > 1 && it.price != null ? (forXlsx ? it.price * p.cartonQty : UI.money(it.price * p.cartonQty) + ' (' + UI.fa(p.cartonQty) + ' عددی)') : (forXlsx ? '' : '—');
    }
    return '';
  }
  function colsOf(F) { var c = COLS.filter(function (x) { return F.cols[x[0]]; }); return c.length ? c : COLS.filter(function (x) { return x[0] === 'name' || x[0] === 'price'; }); }
  function groupName(st) { var G = groupsOf(st); return G.length ? G.map(function (g) { return E.categoryPath(g).join(' › '); }).join(' + ') : 'همه گروه‌ها'; }
  function subtitle(F) { var shop = A.shop(); return [F.sub || shop.name || 'امیران یدک', F.date ? 'تاریخ: ' + UI.dateFa(Date.now()) : ''].filter(Boolean).join(' — '); }

  // ---------- PDF ----------
  function pdfBlocks(data, F, opt) {
    opt = opt || {};
    var shop = A.shop(), cols = colsOf(F), fs = (SIZES[F.size] || SIZES.m)[1];
    var columns = cols.map(function (c) { var k = c[0]; return { label: c[1], w: PW[k], align: k === 'price' || k === 'carton' ? 'left' : k === 'idx' ? 'center' : 'right', wrap: k === 'name' || k === 'cars', bold: k === 'price' }; });
    var blocks = [{ type: 'title', text: F.title || 'لیست قیمت', sub: subtitle(F), left: F.contact ? [shop.phone, shop.address].filter(Boolean) : null }], n = 0;
    if (data.layout === 'car' && data.sections.length > 1) { // v2.9: index of cars first — the buyer finds his car, then the part
      blocks.push({ type: 'band', level: 2, text: 'فهرست خودروها' });
      blocks.push({ type: 'kv', items: data.sections.map(function (sec) { return [sec.label, UI.fa(sec.count) + ' قلم']; }), cols: 3 });
      blocks.push({ type: 'page' });
    }
    var bc = PRESETS.map(function (x) { return x[1]; });
    data.sections.forEach(function (sec, si) {
      if (data.layout === 'brand' && opt.brandPage && si > 0) blocks.push({ type: 'page' }); // v2.9: each brand on its own page
      blocks.push({ type: 'band', level: 1, text: (data.layout === 'brand' ? 'برند ' : '') + sec.label, right: F.count ? UI.fa(sec.count) + ' قلم' : null, keep: 24,
        big: data.layout === 'brand', color: data.layout === 'brand' ? bc[si % bc.length] : null });
      blocks.push({ type: 'table', columns: columns, rows: [], after: 0, fontSize: fs, headAlign: true }); // the column titles once per group (repeated after a page break)
      sec.brands.forEach(function (b) {
        blocks.push({ type: 'band', level: 2, text: b.name, right: F.count ? UI.fa(b.items.length) + ' تنوع' : null, thead: columns, fs: fs, headAlign: true });
        blocks.push({ type: 'table', header: false, columns: columns, rows: b.items.map(function (it) { n++; return cols.map(function (c) { return cell(c[0], it, n); }); }), after: 1.5, fontSize: fs, headAlign: true });
      });
      blocks.push({ type: 'gap', h: 2.5 });
    });
    if (F.note) blocks.push({ type: 'text', text: F.note, size: 2.9, color: '#444444' });
    return blocks;
  }
  function stamp() { var d = new Date(); return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2); }

  // ---------- screen ----------
  A.routes.saleslist = function (arg, q) {
    A.setTitle('لیست قیمت فروش', true);
    var st = Object.assign({ groups: [], fmt: 'default', price: 'base', stock: false, noPrice: false, brands: [], sets: 'all', setsTogether: false, layout: 'group', sort: 'name', brandPage: false }, A.lsGet(LS) || {});
    if (st.group && !(st.groups || []).length) st.groups = [st.group]; delete st.group; // v2.9: several groups
    if (q && q.g && E.state.categories[q.g]) { st.groups = [q.g]; st.brands = []; }
    var all = formats(), F = clone(all.filter(function (f) { return f.id === st.fmt; })[0] || all[0]); st.fmt = F.id;
    function keep() { A.lsSet(LS, st); }

    // --- what goes in the list ---
    var gBtn = h('button.btn.block', { type: 'button', onclick: pickGroup });
    var pg = { base: 'قیمت فروش (پیش‌فرض)' }; E.priceGroups().forEach(function (g) { pg[g.id] = 'قیمت گروه «' + g.name + '»'; });
    var priceSel = sel(pg, pg[st.price] ? st.price : 'base', { onchange: function () { st.price = priceSel.value; keep(); redraw(); } });
    var cStock = h('input', { type: 'checkbox', checked: st.stock, onchange: function () { st.stock = cStock.checked; keep(); redraw(); } });
    var cNo = h('input', { type: 'checkbox', checked: st.noPrice, onchange: function () { st.noPrice = cNo.checked; keep(); redraw(); } });
    var brandBox = h('div');
    var setSel = sel({ all: 'همه کالاها', only: 'فقط ست‌ها', none: 'بدون ست‌ها' }, st.sets || 'all', { onchange: function () { st.sets = setSel.value; keep(); redraw(); } });
    var cTog = h('input', { type: 'checkbox', checked: !!st.setsTogether, onchange: function () { st.setsTogether = cTog.checked; keep(); redraw(); } });
    var laySel = sel({ group: 'گروه › برند (پیش‌فرض)', brand: 'برند › گروه (هر برند جدا و متمایز)', car: 'خودرو › گروه › برند (با فهرست خودروها)' }, st.layout || 'group', { onchange: function () { st.layout = laySel.value; keep(); drawBP(); redraw(); } });
    var sortSel = sel({ name: 'نام کالا', price: 'قیمت (ارزان به گران)', priceDesc: 'قیمت (گران به ارزان)', sku: 'کد کالا' }, st.sort || 'name', { onchange: function () { st.sort = sortSel.value; keep(); redraw(); } });
    var cBP = h('input', { type: 'checkbox', checked: !!st.brandPage, onchange: function () { st.brandPage = cBP.checked; keep(); } }), bpBox = h('div');
    function drawBP() { UI.clear(bpBox); if (st.layout === 'brand') bpBox.appendChild(h('label.check', cBP, 'در PDF هر برند از صفحه جدید شروع شود')); }
    drawBP();
    view.appendChild(h('div.card', h('h2', 'محتوای لیست'),
      field('گروه کالا (یک یا چند)', gBtn, h('div.hint', 'می‌توانید چند گروه را با هم انتخاب کنید (مثلاً ترمز + تعلیق). بدون انتخاب = همه.')),
      h('div.grid2', field('ست‌ها', setSel), field('ترتیب ردیف‌ها', sortSel)), h('label.check', cTog, 'همه ست‌ها زیر هم در یک بخش جدا'),
      field('چیدمان لیست', laySel), bpBox,
      Object.keys(pg).length > 1 ? field('کدام قیمت', priceSel) : null,
      h('label.check', cStock, 'فقط کالاهای موجود در انبار'), h('label.check', cNo, 'کالاهای بدون قیمت فروش هم بیایند («تماس بگیرید»)'),
      brandBox));

    // --- format (layout) ---
    var fSel = h('select.in'), fBody = h('div');
    function fillFormatSel() { UI.clear(fSel); formats().forEach(function (f) { fSel.appendChild(h('option', { value: f.id, selected: f.id === F.id }, f.name)); }); }
    fSel.addEventListener('change', function () { var x = formats().filter(function (f) { return f.id === fSel.value; })[0]; if (!x) return; F = clone(x); st.fmt = F.id; keep(); drawFormat(); redraw(); });
    var fmtCard = h('details.card', h('summary', { style: { fontWeight: 700, cursor: 'pointer' } }, 'قالب و ظاهر لیست'), h('div', { style: { marginTop: '8px' } }, field('قالب', fSel), fBody));
    view.appendChild(fmtCard);
    function txt(key, label, ph, area) {
      var i = h(area ? 'textarea.in' : 'input.in', { value: F[key] || '', placeholder: ph || '' });
      i.addEventListener('input', function () { F[key] = i.value; soon(); });
      return field(label, i);
    }
    function chk(key, label) { var c = h('input', { type: 'checkbox', checked: !!F[key], onchange: function () { F[key] = c.checked; soon(); } }); return h('label.check', c, label); }
    function drawFormat() {
      UI.clear(fBody); fillFormatSel();
      var color = h('input', { type: 'color', value: theme(F).brand, style: { width: '52px', height: '40px', border: 0, background: 'none', padding: 0 }, oninput: function () { F.color = color.value; soon(); } });
      var chips = h('div.chips', { style: { flexWrap: 'wrap', paddingBottom: '2px' } }, PRESETS.map(function (pr) {
        return h('button.chip', { type: 'button', style: { borderColor: pr[1] }, onclick: function () { F.color = pr[1]; color.value = pr[1]; soon(); } }, h('span', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: pr[1], marginLeft: '5px' } }), pr[0]);
      }));
      var sizeO = {}; Object.keys(SIZES).forEach(function (k) { sizeO[k] = SIZES[k][0]; });
      var size = sel(sizeO, F.size, { onchange: function () { F.size = size.value; soon(); } });
      var orient = sel({ p: 'عمودی (A4)', l: 'افقی (A4)' }, F.landscape ? 'l' : 'p', { onchange: function () { F.landscape = orient.value === 'l'; soon(); } });
      var colBox = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px' } }, COLS.map(function (c) {
        var x = h('input', { type: 'checkbox', checked: !!F.cols[c[0]], onchange: function () { F.cols[c[0]] = x.checked; soon(); } }); return h('label.check', x, c[1]);
      }));
      var isDef = F.id === 'default', edited = isDef && stored().some(function (f) { return f.id === 'default'; });
      fBody.appendChild(h('div',
        txt('title', 'عنوان لیست', 'لیست قیمت مصرف‌کننده'), txt('sub', 'زیرعنوان', A.shop().name || 'نام فروشگاه'),
        h('label.f', h('span', 'رنگ اصلی'), h('div.row', color, h('div.grow', chips))),
        h('div.grid2', field('اندازه نوشته', size), field('جهت صفحه', orient)),
        h('div.f', h('span', { style: { fontWeight: 700, display: 'block', marginBottom: '4px' } }, 'ستون‌ها'), colBox),
        chk('count', 'تعداد قلم کنار هر گروه و برند'), chk('date', 'تاریخ روز زیر عنوان'), chk('contact', 'تلفن و نشانی فروشگاه'), chk('zebra', 'ردیف‌های یک‌درمیان رنگی'),
        txt('note', 'یادداشت پایین لیست', 'مثلاً: قیمت‌ها به تومان است', true),
        h('div.grid2', { style: { marginTop: '8px' } },
          h('button.btn', { type: 'button', onclick: saveHere }, isDef ? 'ذخیره به‌عنوان پیش‌فرض' : 'ذخیره تغییرات قالب'),
          h('button.btn', { type: 'button', onclick: saveNew }, 'ذخیره به‌عنوان قالب جدید')),
        isDef ? (edited ? h('button.btn.ghost.block', { type: 'button', onclick: resetDef }, 'بازگشت به ظاهر اولیه برنامه') : null)
          : h('button.btn.ghost.block', { type: 'button', style: { color: 'var(--bad)' }, onclick: delFmt }, 'حذف این قالب')));
    }
    function saveHere() {
      var L = stored().filter(function (f) { return f.id !== F.id; }); L.push(clone(F));
      saveFormats(L).then(function () { UI.toast('قالب «' + F.name + '» ذخیره شد.', 'ok'); drawFormat(); }, function () {});
    }
    function saveNew() {
      UI.promptBox('قالب جدید', 'نام قالب', { value: F.id === 'default' ? 'قالب ' + UI.fa(stored().length + 1) : F.name + ' (کپی)' }).then(function (nm) {
        nm = String(nm || '').trim(); if (!nm) return;
        var nf = clone(F); nf.id = 'f' + Date.now().toString(36); nf.name = nm;
        saveFormats(stored().concat([nf])).then(function () { F = nf; st.fmt = nf.id; keep(); drawFormat(); UI.toast('قالب «' + nm + '» ساخته شد.', 'ok'); }, function () {});
      });
    }
    function delFmt() {
      UI.confirmBox('قالب «' + F.name + '» حذف شود؟', 'حذف', true).then(function (ok) {
        if (!ok) return;
        saveFormats(stored().filter(function (f) { return f.id !== F.id; })).then(function () { F = formats()[0]; st.fmt = F.id; keep(); drawFormat(); redraw(); }, function () {});
      });
    }
    function resetDef() {
      saveFormats(stored().filter(function (f) { return f.id !== 'default'; })).then(function () { F = defFormat(); st.fmt = 'default'; keep(); drawFormat(); redraw(); }, function () {});
    }

    // --- output ---
    var info = h('div.small.muted'), prev = h('div');
    var pdfBtn = h('button.btn.primary', { onclick: exportPdf }, 'خروجی PDF'), xBtn = h('button.btn', { onclick: exportXlsx }, 'خروجی Excel');
    var sBtn = h('button.btn.block', { onclick: exportStudio, style: { marginTop: '8px' } }, 'خروجی برای استودیو');
    view.appendChild(h('div.card', h('div.row', h('div.grow', h('b', 'پیش‌نمایش'), info)), h('div.grid2', { style: { marginTop: '8px' } }, pdfBtn, xBtn), sBtn,
      h('p.small.muted', { style: { marginTop: '6px' } }, 'فایل کوچک برای استودیو کاتالوگ و لیست قیمت: همین کالاها و قیمت‌های فروش، بدون قیمت خرید و اطلاعات مشتری.')));
    view.appendChild(prev);

    var tmr = null; function soon() { clearTimeout(tmr); tmr = setTimeout(redraw, 250); }
    function drawBrands(data) {
      UI.clear(brandBox);
      var names = Object.keys(data.brandsAll).sort(function (a, b) { return (a === NOBRAND) - (b === NOBRAND) || cmp(a, b); });
      if (names.length < 2) return;
      st.brands = (st.brands || []).filter(function (b) { return data.brandsAll[b]; });
      brandBox.appendChild(h('div.small.muted', { style: { margin: '6px 0 2px' } }, 'برندها (بدون انتخاب = همه):'));
      brandBox.appendChild(h('div.chips', { style: { flexWrap: 'wrap' } }, names.map(function (b) {
        var on = st.brands.indexOf(b) >= 0;
        return h('button.chip' + (on ? '.on' : ''), { type: 'button', onclick: function () { if (on) st.brands = st.brands.filter(function (x) { return x !== b; }); else st.brands.push(b); keep(); redraw(); } }, b + ' ' + UI.fa(data.brandsAll[b]));
      })));
    }
    function redraw() {
      gBtn.textContent = groupName(st);
      var data = build(st), th = theme(F), cols = colsOf(F), MAX = 400, shown = 0, n = 0;
      var tw = cols.reduce(function (s2, c) { return s2 + PW[c[0]]; }, 0), wid = function (k) { return (100 * PW[k] / tw).toFixed(1) + '%'; };
      drawBrands(data);
      info.textContent = UI.fa(data.total) + ' قلم در ' + UI.fa(data.sections.length) + ' بخش · ' + exText(data.ex, st);
      pdfBtn.disabled = xBtn.disabled = sBtn.disabled = !data.total;
      UI.clear(prev);
      if (!data.total) { prev.appendChild(h('div.card.empty', 'کالایی با قیمت فروش در این انتخاب نیست.')); return; }
      var shop = A.shop(), fz = { s: '12px', m: '13.5px', l: '15px' }[F.size] || '13.5px';
      var page = h('div.pl-prev', { style: { fontSize: fz } },
        h('div.pl-head', { style: { borderBottom: '2px solid ' + th.brand } }, h('div.grow', h('div.pl-title', F.title || 'لیست قیمت'), h('div.small.muted', subtitle(F))),
          F.contact ? h('div.small.muted', { style: { textAlign: 'left' } }, [shop.phone, shop.address].filter(Boolean).map(function (x) { return h('div', x); })) : null));
      if (data.layout === 'car' && data.sections.length > 1) page.appendChild(h('div.chips', { style: { flexWrap: 'wrap', margin: '6px 0' } }, data.sections.map(function (sec) { return h('span.chip', sec.label + ' ' + UI.fa(sec.count)); }))); // v2.9: index of cars
      data.sections.forEach(function (sec, si) {
        if (shown >= MAX) { n += sec.count; return; }
        page.appendChild(h('div.pl-g', { style: { background: data.layout === 'brand' ? PRESETS[si % PRESETS.length][1] : th.brand, fontSize: data.layout === 'brand' ? '1.15em' : null } }, h('span', (data.layout === 'brand' ? 'برند ' : '') + sec.label), F.count ? h('small', UI.fa(sec.count) + ' قلم') : null));
        sec.brands.forEach(function (b) {
          if (shown >= MAX) { n += b.items.length; return; }
          page.appendChild(h('div.pl-b', { style: { background: th.band2, color: th.brand, borderRightColor: th.brand } }, h('span', b.name), F.count ? h('small', UI.fa(b.items.length) + ' تنوع') : null));
          var tb = h('tbody');
          b.items.forEach(function (it, i) {
            n++; if (shown >= MAX) return; shown++;
            tb.appendChild(h('tr', { style: { background: F.zebra && i % 2 ? '#f7f8f9' : '#fff' } }, cols.map(function (c) {
              var k = c[0]; return h('td' + (k === 'price' || k === 'carton' ? '.n' : k === 'idx' ? '.c' : ''), { style: k === 'price' ? { fontWeight: 700 } : null }, cell(k, it, n));
            })));
          });
          page.appendChild(h('table.pl-t', h('thead', h('tr', { style: { background: th.head } }, cols.map(function (c) { var k = c[0]; return h('th', { style: { width: wid(k), textAlign: k === 'price' || k === 'carton' ? 'left' : k === 'idx' ? 'center' : 'right' } }, c[1]); }))), tb));
        });
      });
      if (F.note) page.appendChild(h('p.small.muted', { style: { marginTop: '10px' } }, F.note));
      if (data.total > shown) page.appendChild(h('div.alert', 'پیش‌نمایش ' + UI.fa(shown) + ' ردیف اول؛ فایل PDF و Excel همه ' + UI.fa(data.total) + ' ردیف را دارد.'));
      prev.appendChild(page);
    }
    function exportPdf() {
      var data = build(st); if (!data.total) return;
      pdfBtn.disabled = true; var old = pdfBtn.textContent; pdfBtn.textContent = 'در حال ساخت PDF…';
      window.PDF.renderFlow(pdfBlocks(data, F, { brandPage: !!st.brandPage }), { landscape: !!F.landscape, title: F.title || 'لیست قیمت', theme: theme(F), footer: A.shop().name || 'امیران یدک',
        onProgress: function (i, t) { pdfBtn.textContent = 'صفحه ' + UI.fa(i) + ' از ' + UI.fa(t); } })
        .then(function (pdf) { UI.fileSheet(pdf, 'amiran-pricelist_' + stamp() + '.pdf', 'application/pdf', 'لیست قیمت ' + groupName(st) + ' — ' + UI.fa(data.total) + ' قلم'); },
          function (e) { A.showErr(e); })
        .then(function () { pdfBtn.disabled = false; pdfBtn.textContent = old; });
    }
    function exportXlsx() {
      var data = build(st); if (!data.total) return;
      var cols = colsOf(F).filter(function (c) { return c[0] !== 'idx'; }), hd = data.layout === 'brand' ? ['برند', 'گروه'] : data.layout === 'car' ? ['خودرو', 'گروه — برند'] : ['گروه', 'برند'], rows = [['ردیف'].concat(hd, cols.map(function (c) { return c[1]; }))], n = 0;
      data.sections.forEach(function (sec) { sec.brands.forEach(function (b) { b.items.forEach(function (it) { n++; rows.push([n, sec.label, b.name].concat(cols.map(function (c) { return cell(c[0], it, n, true); }))); }); }); });
      UI.fileSheet(window.XLSX.writeXlsx([{ name: 'لیست قیمت', rows: rows }]), 'amiran-pricelist_' + stamp() + '.xlsx', XMIME);
    }
    function exportStudio() {
      var data = build(st); if (!data.total || !window.StudioExport) return;
      var ids = new Set(); data.sections.forEach(function (sec) { sec.brands.forEach(function (b) { b.items.forEach(function (it) { ids.add(it.p.id); }); }); });
      sBtn.disabled = true;
      window.StudioExport.make(E.exportAll(), { ids: ids, groupId: groupsOf(st).length === 1 ? groupsOf(st)[0] : null, groupPath: groupName(st), app: A.version })
        .then(function (txt) {
          UI.fileSheet(new Blob([txt], { type: 'application/json' }), 'amiran-studio-export_' + stamp() + '.json', 'application/json',
            UI.fa(ids.size) + ' کالا از «' + groupName(st) + '». فقط نام، کد، برند، خودرو، گروه، مشخصات و قیمت‌های فروش؛ قیمت خرید، موجودی و مشتریان در این فایل نیست. ' +
            'در استودیو: کالاها ← از اپ انبار ← همین فایل.');
        }, function (e) { A.showErr(e); })
        .then(function () { sBtn.disabled = false; });
    }
    function pickGroup() { // v2.9: tick one or more groups
      var C = E.state.categories, kids = {}, pick = {}; groupsOf(st).forEach(function (g) { pick[g] = 1; });
      Object.keys(C).forEach(function (id) { var c = C[id]; if (c.active === false) return; var pid = c.parentId && C[c.parentId] ? c.parentId : ''; (kids[pid] = kids[pid] || []).push(c); });
      var rows = []; (function walk(pid, d) { (kids[pid] || []).sort(function (a, b) { return cmp(a.name, b.name); }).forEach(function (c) { rows.push({ c: c, d: d }); walk(c.id, d + 1); }); })('', 0);
      var s = UI.sheet('گروه‌های لیست قیمت', h('div.stack', h('div.list', rows.map(function (r) {
          var ch = h('input', { type: 'checkbox', checked: !!pick[r.c.id] }); ch.addEventListener('change', function () { if (ch.checked) pick[r.c.id] = 1; else delete pick[r.c.id]; });
          return h('label.li', { style: { paddingRight: (12 + r.d * 16) + 'px' } }, ch, h('div.grow.t', (r.d ? '└ ' : '') + r.c.name));
        })),
        h('div.grid2', h('button.btn', { onclick: function () { s.close(); st.groups = []; st.brands = []; keep(); redraw(); } }, 'همه گروه‌ها'),
          h('button.btn.primary', { onclick: function () { s.close(); st.groups = Object.keys(pick); st.brands = []; keep(); redraw(); } }, 'اعمال'))));
    }
    drawFormat(); redraw();
  };
})();
