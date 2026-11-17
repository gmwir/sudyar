/* Report engine (pure, testable in Node): every report = source rows → combinable filters → (optional
   aggregation) → sort → totals. The screen, Excel, CSV and PDF all use the SAME result object, so an export
   always equals what is shown (same rows, same order, same totals). Nothing here changes data. */
(function (root) {
  'use strict';
  var Core = root.Core, DAY = 864e5;
  var SETTLE = { settled: 'تسویه', partial: 'پرداخت ناقص', unsettled: 'تسویه‌نشده', credit: 'بستانکار' };
  var KIND = { in: 'ورود', initial: 'موجودی اولیه', out: 'خروج', reversal: 'برگشت', adjust: 'تعدیل', return: 'مرجوعی', cost: 'تکمیل بها' };
  var LEVEL = { high: 'بالا', medium: 'متوسط', low: 'پایین', none: 'بدون داده' };
  var VELOCITY = { top: 'پرفروش', normal: 'عادی', slow: 'کم‌فروش', dead: 'راکد', new: 'جدید', none: 'بدون موجودی و فروش' };
  function docTypeLabel(d) {
    if (!d) return '';
    if (d.kind === 'in') return Core.RECEIPT_TYPES[d.type] || 'ورود';
    if (d.kind === 'out') return Core.ISSUE_TYPES[d.type] || 'خروج';
    if (d.kind === 'adjust') return 'تعدیل موجودی';
    if (d.kind === 'reversal') return 'برگشت / لغو سند';
    if (d.kind === 'return') return 'مرجوعی فروش';
    if (d.kind === 'cost') return 'تکمیل بهای خرید';
    return d.kind;
  }
  function N(s) { return Core.normText(s == null ? '' : String(s)); }
  function fa(x) { return String(x).replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; }); }
  function round1(x) { return Math.round(x * 10) / 10; }
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

  // ---------- cell formatting: screen/PDF (formatted) and Excel/CSV (raw, numbers stay numbers) ----------
  // column types: text | money | qty | date | datetime | pct | rate | level | velocity
  function fmtCell(c, v) {
    var U = root.UI;
    if (v == null || v === '') return c.nullText || '';
    switch (c.type) {
      case 'money': return U ? U.money(v) : String(v);
      case 'qty': return U ? U.qty(v) : String(v);
      case 'date': return U ? U.dateFa(v) : root.Jalali.fmt(v);
      case 'datetime': return U ? U.dateFa(v, true) : root.Jalali.fmt(v, true);
      case 'pct': return fa(Number(v).toFixed(1)).replace('.', '٫') + '٪';
      case 'rate': return fa(Number(v).toFixed(2)).replace('.', '٫');
      case 'level': return LEVEL[v] || String(v);
      case 'velocity': return VELOCITY[v] || String(v);
      default: return String(v);
    }
  }
  function rawCell(c, v) {
    if (v == null || v === '') return c.nullText && (c.type === 'money' || c.type === 'pct') ? c.nullText : '';
    if (c.type === 'date' || c.type === 'datetime') return root.Jalali.fmt(v, c.type === 'datetime');
    if (c.type === 'level') return LEVEL[v] || v;
    if (c.type === 'velocity') return VELOCITY[v] || v;
    if (c.type === 'pct') return round1(v);
    if (c.type === 'rate') return Math.round(v * 100) / 100;
    return v;
  }

  // ---------- date ranges (Jalali presets) ----------
  function jms(y, m, d) { var g = root.Jalali.j2g(y, m, d); return new Date(g[0], g[1] - 1, g[2]).getTime(); }
  function presets(now) {
    now = now || Date.now();
    var nd = new Date(now), d0 = startOfDay(now), j = root.Jalali.g2j(nd.getFullYear(), nd.getMonth() + 1, nd.getDate());
    var pm = j[1] === 1 ? [j[0] - 1, 12] : [j[0], j[1] - 1], dow = (nd.getDay() + 1) % 7; // Saturday = 0
    return { today: ['امروز', d0, null], week: ['این هفته', d0 - dow * DAY, null], month: ['این ماه', jms(j[0], j[1], 1), null],
      last: ['ماه قبل', jms(pm[0], pm[1], 1), jms(j[0], j[1], 1) - 1], d90: ['۹۰ روز اخیر', d0 - 89 * DAY, null], year: ['امسال', jms(j[0], 1, 1), null], all: ['همه', null, null] };
  }
  function parseJ(s, endDay) {
    var t = root.Jalali.parse(String(s || '').trim()); if (t == null) return null;
    return endDay ? t + DAY - 1 : t;
  }
  function resolveRange(st, now) {
    var P = presets(now), k = st.preset || 'all';
    if (k === 'custom') {
      var f = parseJ(st.from, false), t = parseJ(st.to, true);
      return { from: f, to: t, key: k, text: 'از ' + (st.from || '…') + ' تا ' + (st.to || '…'), bad: (st.from && f == null) || (st.to && t == null) || (f != null && t != null && f > t) };
    }
    var x = P[k] || P.all;
    return { from: x[1], to: x[2], key: k, text: x[0] + (x[1] != null ? ' (از ' + fmtCell({ type: 'date' }, x[1]) + (x[2] != null ? ' تا ' + fmtCell({ type: 'date' }, x[2]) : '') + ')' : '') };
  }

  // ---------- context: cached lookups shared by filters during one run ----------
  function makeCtx(E, opts) {
    opts = opts || {};
    var S = E.state, cache = { cat: {} };
    var ctx = {
      E: E, S: S, now: opts.now || Date.now(), opts: opts,
      prod: function (r) { return r.productId ? S.products[r.productId] || null : null; },
      cust: function (r) { return r.customerId ? S.customers[r.customerId] || null : null; },
      labelLog: function () { return cache.ll || (cache.ll = E.getMeta('labelLog') || {}); },
      catSet: function (id) {
        if (!cache.cat[id]) { var o = {}; E.categoryDescendants(id).forEach(function (k) { o[k] = 1; }); cache.cat[id] = o; }
        return cache.cat[id];
      },
      analytics: function () {
        if (!cache.an) cache.an = root.Analytics ? root.Analytics.compute(E, { now: ctx.now, windowDays: opts.windowDays || 90, leadDays: opts.leadDays, coverDays: opts.coverDays, productsOnly: true }) : { byId: {} };
        return cache.an;
      }
    };
    return ctx;
  }

  // ---------- product-level flags (used by several reports) ----------
  var PFLAGS = {
    hasStock: ['دارای موجودی', function (p) { return p.stock > 0; }],
    out: ['ناموجود', function (p) { return p.stock <= 0; }],
    low: ['کم‌موجود (زیر حداقل)', function (p) { return p.minStock > 0 && p.stock <= p.minStock; }],
    unknownCost: ['موجودی بدون بهای خرید', function (p) { return p.stock - (p.costedQty || 0) > 0; }],
    noPrice: ['بدون قیمت فروش', function (p) { return p.sellPrice == null; }],
    missingInfo: ['اطلاعات ناقص (گروه/برند/قیمت فروش)', function (p) { return !p.categoryId || !p.brand || p.sellPrice == null; }],
    noLabel: ['برچسب QR چاپ‌نشده', function (p, ctx) { return !ctx.labelLog()[p.id]; }],
    noBarcode: ['بدون بارکد کارخانه', function (p) { return !(p.barcodes || []).length; }]
  };
  function attrKeys(E) { // all custom attributes defined in any group: {key: label}
    var o = {}; E.list('categories').forEach(function (c) { (c.attrDefs || []).forEach(function (d) { if (!o[d.key]) o[d.key] = d.label; }); }); return o;
  }

  // ---------- filter catalog ----------
  function inNum(x, v) { if (x == null || isNaN(x)) return false; return (v.min == null || x >= v.min) && (v.max == null || x <= v.max); }
  function prodOf(r, ctx) { return ctx.prod(r); }
  var FILTERS = {
    q: { label: 'جستجو', kind: 'text', test: function (r, v, ctx) {
      if (r._q == null) {
        var p = prodOf(r, ctx), c = ctx.cust(r);
        r._q = N([r.sku, r.name, r.label, r.brand, r.customer, r.phone, r.invoiceNo, r.docNo, r.no, r.supplier, r.ref, r.note, r.party,
          p && p.model, p && p.family, p && (p.cars || []).join(' '), p && (p.barcodes || []).join(' '), p && p.location, c && c.city].filter(Boolean).join(' | '));
      }
      if (!ctx.codes) ctx.codes = {};
      if (!(v in ctx.codes)) { var pc = ctx.E.findProductByCode(v); ctx.codes[v] = pc ? pc.id : null; } // scanned QR / barcode → exact product
      if (ctx.codes[v] && r.productId !== undefined) return r.productId === ctx.codes[v];
      var toks = N(v).split(' ').filter(Boolean);
      return toks.every(function (t) { return r._q.indexOf(t) >= 0; });
    } },
    product: { label: 'کالا', kind: 'product', test: function (r, v) { return r.productId === v; },
      show: function (v, ctx) { var p = ctx.S.products[v]; return p ? p.name : '؟'; } },
    category: { label: 'گروه کالا', kind: 'category', test: function (r, v, ctx) {
      var p = prodOf(r, ctx), cid = p ? p.categoryId : null;
      return v === '__none' ? !cid : !!cid && !!ctx.catSet(v)[cid];
    }, show: function (v, ctx) { return v === '__none' ? 'بدون گروه' : ctx.E.categoryPath(v).join(' › ') || '؟'; } },
    brand: { label: 'برند', kind: 'select', options: function (ctx) {
      var o = { __none: '— بدون برند —' }; ctx.E.list('products').forEach(function (p) { if (p.brand && !o[p.brand]) o[p.brand] = p.brand; }); return o;
    }, test: function (r, v, ctx) { var p = prodOf(r, ctx), b = p ? p.brand : r.brand; return v === '__none' ? !b : N(b) === N(v); } },
    car: { label: 'خودرو', kind: 'select', options: function (ctx) { // v2.3: the cars a part fits (a product may fit several)
      var o = { __none: '— بدون خودرو —' }; ctx.E.list('products').forEach(function (p) { (p.cars || []).forEach(function (c) { if (!o[c]) o[c] = c; }); }); return o;
    }, test: function (r, v, ctx) { var p = prodOf(r, ctx), cs = (p && p.cars) || []; return v === '__none' ? !cs.length : cs.some(function (c) { return N(c) === N(v); }); } },
    supplier: { label: 'تأمین‌کننده', kind: 'supplier', test: function (r, v, ctx) {
      var s = r.supplierId !== undefined ? r.supplierId : (prodOf(r, ctx) || {}).supplierId; return v === '__none' ? !s : s === v;
    }, show: function (v, ctx) { return v === '__none' ? 'بدون تأمین‌کننده' : (ctx.S.suppliers[v] || {}).name || '؟'; } },
    customer: { label: 'مشتری', kind: 'customer', test: function (r, v) { return r.customerId === v; }, show: function (v, ctx) { return (ctx.S.customers[v] || {}).name || '؟'; } },
    ctype: { label: 'نوع مشتری', kind: 'select', options: function () { return Core.CUSTOMER_TYPES; }, test: function (r, v, ctx) { var c = ctx.cust(r); return !!c && (c.type || 'other') === v; } },
    op: { label: 'نوع عملیات', kind: 'multi', options: function (ctx, def) { return def.opOptions || {}; }, test: function (r, v) { return v.indexOf(r.op) >= 0; } },
    status: { label: 'وضعیت سند', kind: 'select', options: function () { return { valid: 'فقط معتبر', reversed: 'فقط لغو/برگشت‌خورده' }; },
      test: function (r, v) { return v === 'reversed' ? r.status === 'reversed' : r.status !== 'reversed'; } },
    user: { label: 'کاربر', kind: 'select', options: function () { return { 'مدیر': 'مدیر', 'کاربر': 'کاربر' }; }, test: function (r, v) { return r.user === v; } },
    method: { label: 'روش پرداخت', kind: 'multi', options: function () { var o = {}; Object.keys(Core.PAY_METHODS).forEach(function (k) { o[k] = Core.PAY_METHODS[k]; }); return o; },
      test: function (r, v) { return v.indexOf(r.method) >= 0; } },
    settle: { label: 'وضعیت تسویه', kind: 'multi', options: function () { return { unsettled: 'تسویه‌نشده', partial: 'پرداخت ناقص', settled: 'تسویه', credit: 'بستانکار', overdue: 'سررسید گذشته' }; },
      test: function (r, v) { return v.some(function (k) { return k === 'overdue' ? !!r.overdue : r.settlement === k; }); } },
    due: { label: 'سررسید', kind: 'select', options: function () { return { overdue: 'گذشته و پرداخت‌نشده', soon: 'تا ۷ روز آینده', has: 'دارای سررسید', none: 'بدون سررسید' }; },
      test: function (r, v, ctx) {
        var t0 = startOfDay(ctx.now);
        if (v === 'overdue') return !!r.overdue;
        if (v === 'soon') return r.dueDate != null && r.dueDate >= t0 && r.dueDate <= t0 + 7 * DAY && r.balance > 0;
        if (v === 'has') return r.dueDate != null;
        return r.dueDate == null;
      } },
    qty: { label: 'تعداد', kind: 'numrange', test: function (r, v, ctx, def) { return inNum(r[def.qtyKey || 'qty'], v); } },
    amount: { label: 'مبلغ', kind: 'numrange', test: function (r, v, ctx, def) { return inNum(r[def.amountKey || 'amount'], v); } },
    margin: { label: 'حاشیه سود (٪)', kind: 'numrange', test: function (r, v) { return inNum(r.margin, v); } },
    price: { label: 'قیمت فروش کالا', kind: 'numrange', test: function (r, v, ctx) { var p = prodOf(r, ctx); return !!p && inNum(p.sellPrice, v); } },
    cost: { label: 'میانگین بهای خرید', kind: 'numrange', test: function (r, v, ctx) { var p = prodOf(r, ctx); return !!p && inNum(ctx.E.avgCost(p), v); } },
    pflags: { label: 'وضعیت کالا', kind: 'multi', options: function () { var o = {}; Object.keys(PFLAGS).forEach(function (k) { o[k] = PFLAGS[k][0]; }); return o; },
      test: function (r, v, ctx) { var p = prodOf(r, ctx); return !!p && v.every(function (k) { return PFLAGS[k] && PFLAGS[k][1](p, ctx); }); } },
    rflags: { label: 'ویژگی ردیف', kind: 'multi', options: function (ctx, def) { var o = {}; Object.keys(def.rflags || {}).forEach(function (k) { o[k] = def.rflags[k][0]; }); return o; },
      test: function (r, v, ctx, def) { return v.every(function (k) { return def.rflags[k] && def.rflags[k][1](r, ctx); }); } },
    velocity: { label: 'سرعت فروش (۹۰ روز)', kind: 'multi', options: function () { return VELOCITY; },
      test: function (r, v, ctx) { var x = ctx.analytics().byId[r.productId]; return !!x && v.indexOf(x.velocity) >= 0; } },
    attr: { label: 'مشخصه فنی', kind: 'attr', test: function (r, v, ctx) {
      var p = prodOf(r, ctx), a = p && p.attrs ? p.attrs[v.key] : null;
      if (a == null || a === '') return false;
      return !v.val || N(a).indexOf(N(v.val)) >= 0;
    }, show: function (v, ctx) { var k = attrKeys(ctx.E); return (k[v.key] || v.key) + (v.val ? ': ' + v.val : ' (دارد)'); } },
    warranty: { label: 'گارانتی', kind: 'select', options: function () { return { yes: 'دارای گارانتی', no: 'بدون گارانتی', active: 'گارانتی هنوز فعال (از تاریخ فروش)' }; },
      test: function (r, v, ctx) {
        var p = prodOf(r, ctx), m = p ? p.warrantyMonths || 0 : 0;
        if (v === 'no') return !m; if (!m) return false;
        if (v === 'active' && r.ts != null && r.op === 'sale') return r.ts + m * 30.4375 * DAY >= ctx.now;
        return true;
      } },
    active: { label: 'فعال بودن کالا', kind: 'select', options: function () { return { yes: 'فقط کالاهای فعال', no: 'فقط غیرفعال' }; },
      test: function (r, v, ctx) { var p = prodOf(r, ctx); return !!p && (p.active !== false) === (v === 'yes'); } }
  };
  function isSet(f, v) {
    if (v == null || v === '') return false;
    if (f.kind === 'multi') return Array.isArray(v) && v.length > 0;
    if (f.kind === 'numrange') return v.min != null || v.max != null;
    if (f.kind === 'attr') return !!(v && v.key);
    return true;
  }
  function filterText(id, v, ctx, def) {
    var f = FILTERS[id], lbl = id === 'qty' && def.qtyLabel ? def.qtyLabel : id === 'amount' && def.amountLabel ? def.amountLabel : f.label;
    if (f.show) return lbl + ': ' + f.show(v, ctx, def);
    if (f.kind === 'text') return lbl + ': «' + v + '»';
    if (f.kind === 'numrange') return lbl + ': ' + (v.min != null ? 'از ' + fa(v.min) + ' ' : '') + (v.max != null ? 'تا ' + fa(v.max) : '');
    var opts = f.options ? f.options(ctx, def) : {};
    if (f.kind === 'multi') return lbl + ': ' + v.map(function (k) { return opts[k] || k; }).join('، ');
    return lbl + ': ' + (opts[v] || v);
  }

  // ---------- helpers for definitions ----------
  function sumK(rows, k) { var s = 0; for (var i = 0; i < rows.length; i++) s += rows[i][k] || 0; return s; }
  function C(key, label, type, w, extra) { return Object.assign({ key: key, label: label, type: type || 'text', w: w || 1 }, extra || {}); }
  function overdueOf(d, now) {
    if (!(d.balance > 0) || d.status === 'reversed') return false;
    var t0 = startOfDay(now);
    return d.dueDate ? d.dueDate < t0 : false;
  }
  function opsFrom(obj, prefix) { var o = {}; Object.keys(obj).forEach(function (k) { o[prefix + k] = obj[k]; }); return o; }
  var LINE_FLAGS = {
    unknownCost: ['بهای خرید نامشخص', function (r) { return r.costTotal == null; }],
    loss: ['فروش زیر بهای خرید', function (r) { return r.op === 'sale' && r.costTotal != null && r.net < r.costTotal; }],
    discounted: ['دارای تخفیف', function (r) { return (r.discount || 0) + (r.invDisc || 0) > 0; }]
  };
  function lineMargin(r) {
    // v2.2: profit at TODAY'S purchase price (the latest known purchase price on the sale date) — closer to the real
    // profit when prices rise; FIFO profit (cost of the actual units) stays the accounting figure
    r.replCost = r.replUnit != null ? r.replUnit * r.qty : null; r.replProfit = r.replCost != null ? r.net - r.replCost : null;
    if (r.costTotal == null) { r.cost = null; r.profit = null; r.margin = null; return r; }
    r.cost = r.costTotal; r.profit = r.net - r.costTotal; r.margin = r.net ? round1(r.profit / r.net * 100) : null; return r;
  }
  function categoryRoot(E, id) { var c = E.state.categories[id], seen = {}; while (c && c.parentId && !seen[c.id]) { seen[c.id] = 1; c = E.state.categories[c.parentId]; } return c ? c.id : null; }

  // ---------- report definitions ----------
  var DEFS = {};
  function def(id, o) { o.id = id; DEFS[id] = o; }

  def('stock', { today: true, title: 'موجودی کالاها', group: 'کالا و انبار', link: 'product', landscape: true,
    filters: ['q', 'category', 'brand', 'car', 'supplier', 'active', 'pflags', 'velocity', 'attr', 'warranty', 'qty', 'amount', 'price', 'cost'], defaults: { active: 'yes' },
    qtyKey: 'stock', qtyLabel: 'موجودی', amountKey: 'knownValue', amountLabel: 'ارزش موجودی',
    source: function (ctx) { return ctx.E.stockReport().map(function (r) { r.productId = r.id; return r; }); },
    columns: [C('sku', 'کد کالا', 'text', 1.1), C('name', 'نام کالا', 'text', 2.6, { wrap: true }), C('brand', 'برند', 'text', 1), C('category', 'گروه', 'text', 1.3, { wrap: true }),
      C('unit', 'واحد', 'text', 0.6), C('stock', 'موجودی', 'qty', 0.8, { sum: true }), C('minStock', 'حداقل', 'qty', 0.6), C('location', 'محل', 'text', 0.8),
      C('avgCost', 'میانگین بها', 'money', 1, { nullText: 'نامشخص' }), C('knownValue', 'ارزش (بهای معلوم)', 'money', 1.2, { sum: true }),
      C('unknownCostQty', 'واحد بدون بها', 'qty', 0.8, { sum: true }), C('sellPrice', 'قیمت فروش', 'money', 1),
      C('sellValue', 'ارزش به قیمت فروش', 'money', 1.2, { nullText: 'بی‌قیمت', sum: true, partial: true }), C('replValue', 'ارزش به قیمت خرید روز', 'money', 1.2, { nullText: 'نامشخص', sum: true, partial: true })],
    summary: function (rows) {
      var st = rows.filter(function (r) { return r.stock > 0; });
      return [['تعداد کالا', rows.length, 'qty'], ['جمع موجودی', sumK(rows, 'stock'), 'qty'], ['ارزش موجودی با بهای خرید (معلوم)', sumK(rows, 'knownValue'), 'money'],
        ['ارزش موجودی با قیمت فروش', sumK(st.filter(function (r) { return r.sellValue != null; }), 'sellValue'), 'money'],
        ['ارزش موجودی با قیمت خرید روز', sumK(st.filter(function (r) { return r.replValue != null; }), 'replValue'), 'money'],
        ['سود بالقوه (قیمت فروش − بهای خرید؛ کالاهای کامل)', sumK(st.filter(function (r) { return r.potential != null; }), 'potential'), 'money'],
        ['کالاهای دارای موجودی بدون بهای خرید', rows.filter(function (r) { return r.unknownCostQty > 0; }).length, 'qty'],
        ['کالاهای دارای موجودی بدون قیمت فروش', st.filter(function (r) { return r.sellValue == null; }).length, 'qty']];
    },
    note: 'ارزش با بهای خرید فقط برای واحدهایی است که بهای خریدشان ثبت شده (FIFO). ارزش با قیمت فروش فقط برای کالاهای دارای قیمت فروش. «قیمت خرید روز» = آخرین قیمت خرید معلوم (ورود یا لیست قیمت).' });

  def('low', { today: true, title: 'کم‌موجود، ناموجود و پیشنهاد سفارش', group: 'کالا و انبار', link: 'product', landscape: true,
    filters: ['q', 'category', 'brand', 'car', 'supplier', 'rflags'],
    rflags: { out: ['ناموجود', function (r) { return r.stock <= 0; }], low: ['زیر حداقل', function (r) { return r.minStock > 0 && r.stock <= r.minStock; }],
      risk: ['در خطر اتمام (بر اساس سرعت فروش)', function (r) { return r.atRisk; }], suggest: ['دارای پیشنهاد سفارش', function (r) { return r.reorderQty > 0; }] },
    source: function (ctx) {
      var an = ctx.analytics(), S = ctx.S;
      return an.products.filter(function (x) { return x.active && (x.stock <= 0 || (x.minStock > 0 && x.stock <= x.minStock) || x.atRisk || (x.reorderQty > 0 && x.reorderBasis === 'sales' && x.coverDays != null && x.coverDays <= an.params.leadDays + an.params.coverDays)); })
        .map(function (x) {
          var p = S.products[x.id];
          return { id: x.id, productId: x.id, sku: x.sku, name: x.name, brand: x.brand, supplier: p.supplierId && S.suppliers[p.supplierId] ? S.suppliers[p.supplierId].name : '',
            stock: x.stock, minStock: x.minStock, dailyRate: x.dailyRate || null, coverDays: x.coverDays, reorderQty: x.reorderQty, confidence: x.reorderBasis === 'sales' ? x.confidence : null,
            atRisk: x.atRisk, basis: x.reorderBasis === 'sales' ? 'سرعت فروش' : x.reorderBasis === 'minStock' ? 'حداقل موجودی' : '',
            status: x.stock <= 0 ? 'ناموجود' : x.minStock > 0 && x.stock <= x.minStock ? 'زیر حداقل' : x.atRisk ? 'در خطر اتمام' : 'نزدیک نقطه سفارش' };
        });
    },
    defaultSort: { key: 'coverDays', dir: 1 },
    columns: [C('sku', 'کد', 'text', 1), C('name', 'کالا', 'text', 2.5, { wrap: true }), C('brand', 'برند', 'text', 0.9), C('supplier', 'تأمین‌کننده', 'text', 1.2, { wrap: true }),
      C('stock', 'موجودی', 'qty', 0.7), C('minStock', 'حداقل', 'qty', 0.6), C('dailyRate', 'فروش روزانه', 'rate', 0.7), C('coverDays', 'روز پوشش', 'qty', 0.7),
      C('reorderQty', 'پیشنهاد سفارش', 'qty', 0.8, { sum: true }), C('basis', 'مبنا', 'text', 0.9), C('confidence', 'اطمینان', 'level', 0.7), C('status', 'وضعیت', 'text', 0.9)],
    summary: function (rows, ctx) { var an = ctx.analytics();
      return [['تعداد', rows.length, 'qty'], ['ناموجود', rows.filter(function (r) { return r.stock <= 0; }).length, 'qty'], ['زمان تأمین / موجودی هدف', fa(an.params.leadDays) + ' / ' + fa(an.params.coverDays) + ' روز']]; },
    note: 'مقدار پیشنهادی تخمین است: سرعت فروش ۹۰ روز اخیر × (زمان تأمین + روزهای موجودی هدف) − موجودی؛ برای کالای بدون فروش فقط اگر زیر حداقل باشد تا دو برابر حداقل. فصلی بودن و حداقل سفارش تأمین‌کننده لحاظ نشده؛ قبل از خرید بازبینی کنید.' });

  def('ledger', { title: 'کاردکس کالا', group: 'کالا و انبار', range: true, rangeInSource: true, needs: 'product', link: 'doc', filters: ['op', 'user'],
    opOptions: KIND, defaultSort: null,
    source: function (ctx, p) {
      var S = ctx.S, pr = S.products[p.productId]; if (!pr) return [];
      var all = ctx.E.productLedger(pr.id), run = 0, opening = 0;
      p._opening = 0;
      var rows = [];
      all.forEach(function (m) {
        run += m.qty;
        if (p.from != null && m.ts < p.from) { opening += m.qty; return; }
        if (p.to != null && m.ts > p.to) return;
        var d = S.docs[m.docId];
        rows.push({ ts: m.ts, docNo: m.docNo, op: m.kind, kind: (KIND[m.kind] || m.kind) + (d ? ' — ' + docTypeLabel(d) : ''), inQ: m.qty > 0 ? m.qty : null, outQ: m.qty < 0 ? -m.qty : null,
          bal: run, who: d && d.customerId && S.customers[d.customerId] ? S.customers[d.customerId].name : (d && (d.supplier || d.recipient || d.reason)) || '', docId: m.docId, productId: pr.id, user: m.user });
      });
      p._opening = opening;
      return rows;
    },
    title2: function (p, ctx) { var pr = ctx.S.products[p.productId]; return pr ? 'کاردکس: ' + pr.name + ' (' + pr.sku + ')' : null; },
    columns: [C('ts', 'تاریخ', 'datetime', 1.4), C('docNo', 'سند', 'text', 1.2), C('kind', 'شرح', 'text', 2, { wrap: true }), C('who', 'طرف حساب / علت', 'text', 1.8, { wrap: true }),
      C('inQ', 'وارده', 'qty', 0.8, { sum: true }), C('outQ', 'صادره', 'qty', 0.8, { sum: true }), C('bal', 'مانده', 'qty', 0.8)],
    summary: function (rows, ctx, p) { var pr = ctx.S.products[p.productId]; if (!pr) return [['', 'یک کالا انتخاب کنید']];
      return [['مانده ابتدای دوره', p._opening, 'qty'], ['جمع وارده', sumK(rows, 'inQ'), 'qty'], ['جمع صادره', sumK(rows, 'outQ'), 'qty'], ['موجودی فعلی', pr.stock, 'qty']]; },
    note: 'ستون «مانده» موجودی واقعی پس از هر گردش است (حتی وقتی فیلتر نوع عملیات فعال است).' });

  var MOVE_OPS = Object.assign(opsFrom(Core.RECEIPT_TYPES, 'in:'), { initial: 'موجودی اولیه' }, opsFrom(Core.ISSUE_TYPES, 'out:'), { 'return': 'مرجوعی فروش', 'adjust+': 'تعدیل افزایشی', 'adjust-': 'تعدیل کاهشی', reversal: 'برگشت / لغو سند' });
  def('movements', { title: 'گردش کالا (همه ورود و خروج‌ها)', group: 'کالا و انبار', range: true, link: 'doc', landscape: true,
    filters: ['q', 'product', 'category', 'brand', 'car', 'supplier', 'customer', 'op', 'user', 'qty'], opOptions: MOVE_OPS, qtyKey: 'absQty', qtyLabel: 'تعداد',
    source: function (ctx) {
      var S = ctx.S;
      return ctx.E.list('movements').map(function (m) {
        var d = S.docs[m.docId] || {}, p = S.products[m.productId] || {};
        var op = m.kind === 'in' ? 'in:' + d.type : m.kind === 'out' ? 'out:' + d.type : m.kind === 'adjust' ? (m.qty > 0 ? 'adjust+' : 'adjust-') : m.kind;
        var c = d.customerId ? S.customers[d.customerId] : null;
        return { ts: m.ts, createdAt: m.createdAt, docNo: m.docNo, docId: m.docId, productId: m.productId, sku: p.sku, name: p.name, brand: p.brand, op: op, opLabel: MOVE_OPS[op] || KIND[m.kind] || m.kind,
          inQ: m.qty > 0 ? m.qty : null, outQ: m.qty < 0 ? -m.qty : null, absQty: Math.abs(m.qty), customerId: d.customerId || null,
          party: c ? c.name : d.supplier || d.recipient || d.reason || '', user: m.user };
      });
    },
    defaultSort: { key: 'ts', dir: -1 },
    columns: [C('ts', 'تاریخ', 'datetime', 1.3), C('docNo', 'سند', 'text', 1.1), C('opLabel', 'نوع', 'text', 1.3), C('sku', 'کد', 'text', 1), C('name', 'کالا', 'text', 2.3, { wrap: true }),
      C('inQ', 'وارده', 'qty', 0.7, { sum: true }), C('outQ', 'صادره', 'qty', 0.7, { sum: true }), C('party', 'طرف حساب / علت', 'text', 1.6, { wrap: true }), C('user', 'کاربر', 'text', 0.7)],
    summary: function (rows) { return [['تعداد گردش', rows.length, 'qty'], ['جمع وارده', sumK(rows, 'inQ'), 'qty'], ['جمع صادره', sumK(rows, 'outQ'), 'qty'], ['خالص', sumK(rows, 'inQ') - sumK(rows, 'outQ'), 'qty']]; } });

  /* v2.1: historical rows come from dated events; settlement columns are "as of the end of the range" */
  var EVENT_LABEL = { 'return': 'مرجوعی', sale_cancel: 'لغو فاکتور', return_cancel: 'لغو مرجوعی' };
  function refTime(ctx, p) { return p && p.to != null ? Math.min(p.to, ctx.now) : ctx.now; }
  function salesSource(ctx, p) {
    var t0 = startOfDay(refTime(ctx, p));
    return ctx.E.salesLines({ from: p ? p.from : null, to: p ? p.to : null }).map(function (r) {
      r.op = r.kind; r.settleLabel = EVENT_LABEL[r.kind] || (r.status === 'reversed' ? 'لغوشده' : (SETTLE[r.settlement] || r.settlement));
      r.overdue = r.kind === 'sale' && r.status !== 'reversed' && r.balance > 0 && !!r.dueDate && r.dueDate < t0;
      return lineMargin(r);
    });
  }
  def('sales', { title: 'فروش (ریز اقلام)', group: 'فروش و سود', range: true, link: 'doc', landscape: true,
    filters: ['q', 'product', 'category', 'brand', 'car', 'supplier', 'customer', 'ctype', 'op', 'user', 'settle', 'rflags', 'qty', 'amount', 'margin', 'attr', 'warranty'],
    opOptions: { sale: 'فروش', 'return': 'مرجوعی', sale_cancel: 'لغو فاکتور (بازه دیگر)', return_cancel: 'لغو مرجوعی (بازه دیگر)' }, rflags: LINE_FLAGS, amountKey: 'net', amountLabel: 'مبلغ خالص ردیف', asOf: true,
    source: salesSource, defaultSort: { key: 'ts', dir: -1 },
    columns: [C('ts', 'تاریخ', 'date', 0.9), C('invoiceNo', 'فاکتور', 'text', 1), C('customer', 'مشتری', 'text', 1.5, { wrap: true }), C('sku', 'کد', 'text', 0.9),
      C('name', 'کالا', 'text', 2.2, { wrap: true }), C('qty', 'تعداد', 'qty', 0.6, { sum: true }), C('unitPrice', 'فی', 'money', 0.9), C('discount', 'تخفیف ردیف', 'money', 0.8, { sum: true }),
      C('invDisc', 'سهم تخفیف فاکتور', 'money', 0.8, { sum: true }), C('net', 'مبلغ خالص', 'money', 1, { sum: true }), C('settleLabel', 'وضعیت', 'text', 0.9)],
    summary: function (rows) { var inv = {}; rows.forEach(function (r) { if (r.op === 'sale') inv[r.docId] = 1; });
      return [['تعداد فاکتور', Object.keys(inv).length, 'qty'], ['فروش خالص (پس از تخفیف‌ها و مرجوعی)', sumK(rows, 'net'), 'money'], ['تعداد خالص فروش', sumK(rows, 'qty'), 'qty'],
        ['مرجوعی‌ها', -sumK(rows.filter(function (r) { return r.op === 'return' || r.op === 'return_cancel'; }), 'net'), 'money']]; } });

  def('invoices', { title: 'فاکتورهای فروش و سررسید', group: 'فروش و سود', range: true, link: 'doc', landscape: true,
    filters: ['q', 'customer', 'ctype', 'user', 'status', 'settle', 'due', 'amount', 'rflags'], defaults: { status: 'valid' }, amountKey: 'total', amountLabel: 'مبلغ فاکتور',
    rflags: { hasReturn: ['دارای مرجوعی', function (r) { return r.returned > 0; }], corrected: ['اصلاحیه فاکتور قبلی', function (r) { return !!r.replaces; }] },
    asOf: true,
    source: function (ctx, p) {
      var S = ctx.S, ref = refTime(ctx, p), t0 = startOfDay(ref), st = ctx.E.invoiceStates(p && p.to != null ? p.to : null);
      return ctx.E.allDocs().filter(function (d) { return d.kind === 'out' && d.type === 'sale' && st[d.id]; }).map(function (d) {
        var c = S.customers[d.customerId], x = st[d.id], rev = x.status === 'reversed', od = !rev && x.balance > 0 && !!d.dueDate && d.dueDate < t0;
        return { ts: d.ts, invoiceNo: d.invoiceNo, customer: c ? c.name : '', phone: c ? c.phone : '', customerId: d.customerId, total: rev ? 0 : d.total,
          returned: x.returned, paid: x.paid, balance: x.balance, dueDate: d.dueDate || null, overdue: od,
          overdueDays: od ? Math.floor((t0 - d.dueDate) / DAY) : null, ageDays: Math.floor((ref - d.ts) / DAY), settlement: rev ? '' : x.settlement, status: x.status,
          statusLabel: rev ? 'لغوشده' : (SETTLE[x.settlement] || '') + (od ? ' — سررسید گذشته' : ''), docId: d.id, user: d.user, replaces: d.replaces || null, op: 'sale' };
      });
    },
    defaultSort: { key: 'ts', dir: -1 },
    columns: [C('ts', 'تاریخ', 'datetime', 1.2), C('invoiceNo', 'شماره', 'text', 1), C('customer', 'مشتری', 'text', 1.8, { wrap: true }), C('phone', 'تلفن', 'text', 1.1),
      C('total', 'مبلغ فاکتور', 'money', 1, { sum: true }), C('returned', 'مرجوعی', 'money', 0.9, { sum: true }), C('paid', 'دریافتی خالص', 'money', 1, { sum: true }),
      C('balance', 'مانده', 'money', 1, { sum: true }), C('dueDate', 'سررسید', 'date', 0.9), C('overdueDays', 'روز تأخیر', 'qty', 0.7), C('statusLabel', 'وضعیت', 'text', 1.2, { wrap: true })],
    summary: function (rows) { return [['تعداد', rows.length, 'qty'], ['جمع فروش', sumK(rows, 'total'), 'money'], ['جمع مرجوعی', sumK(rows, 'returned'), 'money'], ['جمع دریافتی', sumK(rows, 'paid'), 'money'],
      ['جمع مانده', sumK(rows, 'balance'), 'money'], ['مانده سررسیدگذشته', sumK(rows.filter(function (r) { return r.overdue; }), 'balance'), 'money']]; } });

  def('profit', { title: 'سود ناخالص (ریز اقلام)', group: 'فروش و سود', range: true, link: 'doc', landscape: true,
    filters: ['q', 'product', 'category', 'brand', 'car', 'supplier', 'customer', 'ctype', 'op', 'rflags', 'margin', 'amount'],
    opOptions: { sale: 'فروش', 'return': 'مرجوعی', sale_cancel: 'لغو فاکتور (بازه دیگر)', return_cancel: 'لغو مرجوعی (بازه دیگر)' }, rflags: LINE_FLAGS, amountKey: 'net', amountLabel: 'فروش خالص ردیف',
    source: function (ctx, p) { return salesSource(ctx, p).map(function (r) { r.kindLabel = EVENT_LABEL[r.op] || 'فروش'; return r; }); },
    defaultSort: { key: 'ts', dir: -1 },
    columns: [C('ts', 'تاریخ', 'date', 0.9), C('invoiceNo', 'فاکتور', 'text', 1), C('kindLabel', 'نوع', 'text', 0.7), C('name', 'کالا', 'text', 2.4, { wrap: true }), C('qty', 'تعداد', 'qty', 0.6, { sum: true }),
      C('net', 'فروش خالص', 'money', 1, { sum: true }), C('cost', 'بهای تمام‌شده', 'money', 1, { nullText: 'نامشخص', sum: true, partial: true }),
      C('profit', 'سود', 'money', 1, { nullText: 'نامشخص', sum: true, partial: true }), C('margin', 'حاشیه', 'pct', 0.7),
      C('replProfit', 'سود به قیمت روز', 'money', 1, { nullText: 'نامشخص', sum: true, partial: true })],
    summary: function (rows) {
      var known = rows.filter(function (r) { return r.profit != null; }), unk = rows.filter(function (r) { return r.profit == null; }), rk = rows.filter(function (r) { return r.replProfit != null; });
      var ks = sumK(known, 'net'), us = sumK(unk, 'net'), tot = ks + us;
      return [['سود ناخالص (اقلام با بهای معلوم)', sumK(known, 'profit'), 'money'], ['سود به قیمت خرید روز', sumK(rk, 'replProfit'), 'money'], ['فروش خالص با بهای معلوم', ks, 'money'], ['فروش خالص با بهای نامشخص', us, 'money'],
        ['پوشش محاسبه سود', tot ? round1(ks / tot * 100) : 100, 'pct'], ['ردیف‌های با بهای نامشخص', unk.length, 'qty']];
    },
    note: 'سود روی مبلغ خالص (پس از تخفیف ردیف و سهم تخفیف فاکتور) و فقط برای اقلامی محاسبه شده که بهای خرید همه واحدهای فروخته‌شده‌شان ثبت شده است (FIFO). مرجوعی‌ها با علامت منفی در تاریخ مرجوعی آمده‌اند. لغو سندی که در بازه دیگری ثبت شده، در تاریخ لغو با علامت مخالف می‌آید. جمع ستون‌های «بهای تمام‌شده» و «سود» فقط ردیف‌های معلوم است.' });

  var GROUP_BY = { product: 'کالا', brand: 'برند', category: 'گروه کالا', root: 'گروه اصلی (رشته کاری)', supplier: 'تأمین‌کننده', customer: 'مشتری', ctype: 'نوع مشتری', month: 'ماه' };
  def('profitgroup', { title: 'سودآوری تجمیعی (کالا، برند، گروه، مشتری…)', group: 'فروش و سود', range: true,
    filters: ['q', 'product', 'category', 'brand', 'car', 'supplier', 'customer', 'ctype'], groupFilters: ['amount', 'margin'], amountKey: 'net', amountLabel: 'فروش خالص گروه',
    options: [{ id: 'by', label: 'تجمیع بر اساس', values: GROUP_BY, def: 'brand' }],
    source: salesSource,
    aggregate: function (rows, ctx, p) {
      var by = (p.opt && p.opt.by) || 'brand', S = ctx.S, E = ctx.E, g = {};
      rows.forEach(function (r) {
        var pr = S.products[r.productId] || {}, k, lbl, link = null;
        if (by === 'product') { k = r.productId; lbl = r.name + (r.sku ? ' (' + r.sku + ')' : ''); link = 'product'; }
        else if (by === 'brand') { k = N(pr.brand || r.brand); lbl = pr.brand || r.brand || '(بدون برند)'; }
        else if (by === 'category') { k = pr.categoryId || ''; lbl = k ? E.categoryPath(k).join(' › ') : '(بدون گروه)'; }
        else if (by === 'root') { k = pr.categoryId ? categoryRoot(E, pr.categoryId) : ''; lbl = k ? S.categories[k].name : '(بدون گروه)'; }
        else if (by === 'supplier') { k = pr.supplierId || ''; lbl = k && S.suppliers[k] ? S.suppliers[k].name : '(بدون تأمین‌کننده)'; }
        else if (by === 'customer') { k = r.customerId || ''; lbl = r.customer || '(بدون مشتری)'; link = 'customer'; }
        else if (by === 'ctype') { var c = S.customers[r.customerId]; k = c ? c.type || 'other' : ''; lbl = Core.CUSTOMER_TYPES[k] || '(نامشخص)'; }
        else { var j = root.Jalali.fromMs(r.ts); k = j[0] + '/' + (j[1] < 10 ? '0' : '') + j[1]; lbl = k; }
        var x = g[k] || (g[k] = { key: k, label: lbl, qty: 0, net: 0, knownNet: 0, cost: 0, profit: 0, lines: 0, unknownLines: 0, linkType: link });
        x.qty += r.qty; x.net += r.net; x.lines++;
        if (r.profit != null) { x.knownNet += r.net; x.cost += r.cost; x.profit += r.profit; } else x.unknownLines++;
      });
      return Object.keys(g).map(function (k) { var x = g[k]; x.margin = x.knownNet > 0 ? round1(x.profit / x.knownNet * 100) : null; x.coverage = x.net > 0 ? round1(x.knownNet / x.net * 100) : (x.net === 0 && !x.unknownLines ? 100 : null);
        if (x.linkType === 'product') x.productId = k; if (x.linkType === 'customer') x.customerId = k; return x; });
    },
    defaultSort: { key: 'profit', dir: -1 },
    columns: function (p) { var by = (p.opt && p.opt.by) || 'brand';
      return [C('label', GROUP_BY[by] || 'عنوان', 'text', 2.6, { wrap: true }), C('qty', 'تعداد خالص', 'qty', 0.8, { sum: true }), C('net', 'فروش خالص', 'money', 1.1, { sum: true }),
        C('knownNet', 'فروش با بهای معلوم', 'money', 1.1, { sum: true }), C('cost', 'بهای تمام‌شده معلوم', 'money', 1.1, { sum: true }), C('profit', 'سود معلوم', 'money', 1.1, { sum: true }),
        C('margin', 'حاشیه', 'pct', 0.7), C('coverage', 'پوشش', 'pct', 0.7)]; },
    summary: function (rows) { var net = sumK(rows, 'net'), kn = sumK(rows, 'knownNet');
      return [['تعداد گروه', rows.length, 'qty'], ['فروش خالص', net, 'money'], ['سود معلوم', sumK(rows, 'profit'), 'money'], ['پوشش محاسبه سود', net ? round1(kn / net * 100) : 100, 'pct']]; },
    note: '«حاشیه» = سود معلوم ÷ فروش با بهای معلوم. «پوشش» نشان می‌دهد چه درصدی از فروش هر گروه سود قابل محاسبه داشته؛ پوشش پایین یعنی نتیجه قابل اتکا نیست.' });

  def('top', { title: 'پرفروش‌ترین کالاها', group: 'فروش و سود', range: true, link: 'product',
    filters: ['q', 'category', 'brand', 'car', 'supplier', 'customer', 'ctype'], groupFilters: ['qty', 'amount'], amountKey: 'amount', amountLabel: 'مبلغ فروش', qtyLabel: 'تعداد فروش',
    source: salesSource,
    aggregate: function (rows) {
      var m = {};
      rows.forEach(function (r) { var x = m[r.productId] || (m[r.productId] = { id: r.productId, productId: r.productId, sku: r.sku, name: r.name, brand: r.brand, qty: 0, amount: 0, invoices: {} }); x.qty += r.qty; x.amount += r.net; if (r.op === 'sale') x.invoices[r.docId] = 1; });
      return Object.keys(m).map(function (k) { var x = m[k]; x.invoiceCount = Object.keys(x.invoices).length; delete x.invoices; return x; });
    },
    defaultSort: { key: 'qty', dir: -1 },
    columns: [C('sku', 'کد', 'text', 1.2), C('name', 'کالا', 'text', 3, { wrap: true }), C('brand', 'برند', 'text', 1), C('invoiceCount', 'تعداد فاکتور', 'qty', 0.8),
      C('qty', 'تعداد فروش', 'qty', 0.9, { sum: true }), C('amount', 'مبلغ فروش', 'money', 1.2, { sum: true })],
    summary: function (rows) { return [['تعداد کالا', rows.length, 'qty'], ['جمع مبلغ', sumK(rows, 'amount'), 'money']]; } });

  def('payments', { title: 'گردش مالی (دریافت، بازپرداخت، انتقال)', group: 'مالی و مشتری', range: true, link: 'doc', landscape: true,
    filters: ['q', 'customer', 'ctype', 'op', 'method', 'user', 'amount'], defaults: { op: ['receive', 'refund'] }, amountKey: 'amount', amountLabel: 'مبلغ',
    opOptions: { receive: 'دریافت از مشتری', refund: 'بازپرداخت به مشتری', transfer: 'انتقال بستانکاری بین فاکتورها' },
    source: function (ctx) {
      return ctx.E.paymentsReport({ includeTransfers: true }).map(function (r) {
        r.op = r.method === 'credit_transfer' ? 'transfer' : r.kind === 'refund' ? 'refund' : 'receive';
        r.kindLabel = r.method === 'credit_transfer' ? (r.kind === 'refund' ? 'انتقال (برداشت)' : 'انتقال (اعمال)') : r.kind === 'refund' ? 'بازپرداخت' : 'دریافت';
        return r;
      });
    },
    defaultSort: { key: 'ts', dir: -1 },
    columns: [C('ts', 'تاریخ', 'datetime', 1.3), C('no', 'شماره', 'text', 1.1), C('kindLabel', 'نوع', 'text', 1), C('customer', 'مشتری', 'text', 1.8, { wrap: true }),
      C('invoiceNo', 'فاکتور', 'text', 1.1), C('methodLabel', 'روش', 'text', 1.1), C('ref', 'پیگیری', 'text', 1), C('signed', 'مبلغ', 'money', 1.2, { sum: true })],
    summary: function (rows) {
      var by = {}; rows.forEach(function (r) { if (r.op !== 'transfer') by[r.methodLabel] = (by[r.methodLabel] || 0) + r.signed; });
      return [['جمع خالص دریافتی (بدون انتقال‌ها)', sumK(rows.filter(function (r) { return r.op !== 'transfer'; }), 'signed'), 'money']].concat(Object.keys(by).map(function (k) { return [k, by[k], 'money']; }));
    },
    note: 'انتقال بستانکاری بین فاکتورها پول جابه‌جا نمی‌کند و در جمع دریافتی حساب نمی‌شود.' });

  def('debtors', { today: true, title: 'بدهکاران و سن بدهی', group: 'مالی و مشتری', link: 'customer', landscape: true,
    filters: ['q', 'customer', 'ctype', 'amount', 'rflags'], amountKey: 'balance', amountLabel: 'مانده بدهی',
    rflags: { overdue: ['دارای بدهی سررسیدگذشته', function (r) { return r.overdueAmt > 0; }], over90: ['بدهی قدیمی‌تر از ۹۰ روز', function (r) { return r.d90p > 0; }] },
    source: function (ctx) {
      var S = ctx.S, t0 = startOfDay(ctx.now), m = {};
      ctx.E.allDocs().forEach(function (d) {
        if (d.kind !== 'out' || d.type !== 'sale' || !d.customerId || !d.balance) return;
        var x = m[d.customerId] || (m[d.customerId] = { customerId: d.customerId, balance: 0, notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0, credit: 0, overdueAmt: 0, oldest: null });
        x.balance += d.balance;
        if (d.balance < 0) { x.credit += d.balance; return; }
        if (d.dueDate && d.dueDate >= t0) { x.notDue += d.balance; return; }
        var age = Math.floor((t0 - startOfDay(d.dueDate || d.ts)) / DAY);
        if (d.dueDate) x.overdueAmt += d.balance;
        if (age <= 30) x.d0_30 += d.balance; else if (age <= 60) x.d31_60 += d.balance; else if (age <= 90) x.d61_90 += d.balance; else x.d90p += d.balance;
        if (x.oldest == null || age > x.oldest) x.oldest = age;
      });
      var lastPay = {}; ctx.E.list('payments').forEach(function (p) { if (p.kind !== 'refund' && p.method !== 'credit_transfer' && (!lastPay[p.customerId] || p.ts > lastPay[p.customerId])) lastPay[p.customerId] = p.ts; });
      // v2.11: «مانده بدهی» is the whole account (same as the customer page); what is not in sale invoices is shown in «سایر»
      var CB = ctx.E.customerBalances();
      Object.keys(CB).forEach(function (k) { if (!m[k]) m[k] = { customerId: k, balance: 0, notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0, credit: 0, overdueAmt: 0, oldest: null }; });
      Object.keys(m).forEach(function (k) { var x = m[k], whole = CB[k] || 0; x.other = whole - x.balance; x.balance = whole; });
      ctx.E.list('ledger').forEach(function (e) { if (e.kind === 'receipt' && e.partyType === 'customer' && (!lastPay[e.partyId] || e.ts > lastPay[e.partyId])) lastPay[e.partyId] = e.ts; });
      return Object.keys(m).map(function (k) { var x = m[k], c = S.customers[k] || {};
        x.name = c.name || ''; x.phone = c.phone || ''; x.typeLabel = Core.CUSTOMER_TYPES[c.type] || ''; x.lastPay = lastPay[k] || null; return x; })
        .filter(function (x) { return x.balance > 0; });
    },
    defaultSort: { key: 'balance', dir: -1 },
    columns: [C('name', 'مشتری', 'text', 2, { wrap: true }), C('phone', 'تلفن', 'text', 1.2), C('balance', 'مانده بدهی', 'money', 1.1, { sum: true }), C('notDue', 'سررسید نشده', 'money', 1, { sum: true }),
      C('d0_30', '۰ تا ۳۰ روز', 'money', 1, { sum: true }), C('d31_60', '۳۱ تا ۶۰', 'money', 1, { sum: true }), C('d61_90', '۶۱ تا ۹۰', 'money', 1, { sum: true }), C('d90p', 'بیش از ۹۰', 'money', 1, { sum: true }),
      C('credit', 'بستانکاری فاکتورها', 'money', 1, { sum: true }), C('other', 'سایر (معامله مستقیم، مانده اول دوره، پیش‌دریافت)', 'money', 1.1, { sum: true }), C('lastPay', 'آخرین دریافت', 'date', 0.9)],
    summary: function (rows) { return [['تعداد بدهکار', rows.length, 'qty'], ['جمع مطالبات', sumK(rows, 'balance'), 'money'], ['سررسیدگذشته', sumK(rows, 'overdueAmt'), 'money'], ['بیش از ۹۰ روز', sumK(rows, 'd90p'), 'money']]; },
    note: 'سن بدهی از تاریخ سررسید (اگر تعیین شده) وگرنه از تاریخ فاکتور حساب می‌شود. مانده بدهی = کل حساب مشتری = ستون‌های سنی + بستانکاری فاکتورها + سایر.' });

  def('receipts', { title: 'ورود کالا / خریدها', group: 'کالا و انبار', range: true, link: 'doc', landscape: true,
    filters: ['q', 'product', 'category', 'brand', 'car', 'supplier', 'op', 'user', 'status', 'rflags', 'qty', 'amount'], defaults: { status: 'valid' },
    opOptions: Object.assign({}, Core.RECEIPT_TYPES), amountKey: 'total', amountLabel: 'مبلغ ردیف',
    rflags: { unknownCost: ['بدون بهای خرید', function (r) { return r.unitCost == null; }] },
    source: function (ctx, p) {
      return ctx.E.receiptLines({ from: p ? p.from : null, to: p ? p.to : null, includeReversed: true }).map(function (r) {
        r.type = r.cancel ? 'لغو رسید ' + (r.reversedNo || '') : (Core.RECEIPT_TYPES[r.op] || r.op) + (r.status === 'reversed' ? ' (برگشت‌خورده)' : '');
        return r;
      });
    },
    defaultSort: { key: 'ts', dir: -1 },
    columns: [C('ts', 'تاریخ', 'date', 0.9), C('no', 'سند', 'text', 1), C('type', 'نوع', 'text', 1.1), C('supplier', 'تأمین‌کننده', 'text', 1.4, { wrap: true }),
      C('sku', 'کد', 'text', 0.9), C('name', 'کالا', 'text', 2.3, { wrap: true }), C('qty', 'تعداد', 'qty', 0.6, { sum: true }), C('unitCost', 'فی خرید', 'money', 1, { nullText: 'نامشخص' }), C('total', 'جمع', 'money', 1, { sum: true })],
    summary: function (rows) { return [['تعداد ردیف', rows.length, 'qty'], ['جمع تعداد', sumK(rows, 'qty'), 'qty'], ['جمع مبلغ (با بهای معلوم)', sumK(rows, 'total'), 'money'],
      ['ردیف‌های بدون بها', rows.filter(function (r) { return r.unitCost == null; }).length, 'qty']]; } });

  def('nonsale', { title: 'خروج‌های غیرفروش (ضایعات، مصرف داخلی، مرجوعی به تأمین‌کننده)', group: 'کالا و انبار', range: true, link: 'doc', landscape: true,
    filters: ['q', 'product', 'category', 'brand', 'car', 'op', 'user', 'qty'], opOptions: (function () { var o = Object.assign({}, Core.ISSUE_TYPES); delete o.sale; return o; })(),
    source: function (ctx, p) { return ctx.E.nonSaleIssues({ from: p ? p.from : null, to: p ? p.to : null }).map(function (r) { r.op = r.type; if (r.cancel) r.typeLabel = 'لغو ' + (r.typeLabel || ''); return r; }); },
    defaultSort: { key: 'ts', dir: -1 },
    columns: [C('ts', 'تاریخ', 'date', 0.9), C('docNo', 'سند', 'text', 1), C('typeLabel', 'نوع', 'text', 1.3), C('recipient', 'تحویل‌گیرنده', 'text', 1.3),
      C('sku', 'کد', 'text', 0.9), C('name', 'کالا', 'text', 2.3, { wrap: true }), C('qty', 'تعداد', 'qty', 0.6, { sum: true }), C('costTotal', 'بهای تمام‌شده', 'money', 1, { nullText: 'نامشخص', sum: true, partial: true }), C('note', 'توضیح', 'text', 1.4, { wrap: true })],
    summary: function (rows) { return [['تعداد ردیف', rows.length, 'qty'], ['جمع تعداد', sumK(rows, 'qty'), 'qty'], ['بهای تمام‌شده معلوم', sumK(rows, 'costTotal'), 'money']]; } });

  def('customers', { title: 'تحلیل مشتریان', group: 'مالی و مشتری', range: true, rangeInSource: true, link: 'customer', landscape: true,
    filters: ['q', 'ctype', 'rflags', 'qty', 'amount'], qtyKey: 'invoices', qtyLabel: 'تعداد فاکتور در بازه', amountKey: 'net', amountLabel: 'خرید خالص در بازه',
    rflags: { debtor: ['بدهکار', function (r) { return r.balance > 0; }], creditor: ['بستانکار', function (r) { return r.balance < 0; }], buyer: ['دارای خرید در بازه', function (r) { return r.invoices > 0; }],
      noBuy: ['بدون خرید در بازه', function (r) { return !r.invoices; }], lapsed: ['بیش از ۹۰ روز بدون خرید', function (r) { return r.daysSince != null && r.daysSince > 90; }] },
    source: function (ctx, p) {
      var S = ctx.S, m = {}, bal = ctx.E.customerBalances(), inR = function (ts) { return (p.from == null || ts >= p.from) && (p.to == null || ts <= p.to); };
      Object.keys(S.customers).forEach(function (k) { var c = S.customers[k]; m[k] = { customerId: k, name: c.name, phone: c.phone, city: c.city, typeLabel: Core.CUSTOMER_TYPES[c.type] || '', invoices: 0, net: 0, knownNet: 0, profit: 0, last: null, balance: bal[k] || 0 }; });
      salesSource(ctx, {}).forEach(function (r) { var x = m[r.customerId]; if (x && r.op === 'sale' && (x.last == null || r.ts > x.last)) x.last = r.ts; });
      salesSource(ctx, p).forEach(function (r) {
        var x = m[r.customerId]; if (!x || !inR(r.ts)) return;
        x.net += r.net; if (r.profit != null) { x.knownNet += r.net; x.profit += r.profit; }
      });
      ctx.E.allDocs().forEach(function (d) { if (d.kind === 'out' && d.type === 'sale' && m[d.customerId] && inR(d.ts)) { var rt = ctx.E.revTs(d); if (rt == null || !inR(rt)) m[d.customerId].invoices++; } });
      return Object.keys(m).map(function (k) { var x = m[k]; x.avg = x.invoices ? Math.round(x.net / x.invoices) : null; x.daysSince = x.last != null ? Math.floor((ctx.now - x.last) / DAY) : null;
        x.margin = x.knownNet > 0 ? round1(x.profit / x.knownNet * 100) : null; return x; });
    },
    defaultSort: { key: 'net', dir: -1 },
    columns: [C('name', 'مشتری', 'text', 2, { wrap: true }), C('typeLabel', 'نوع', 'text', 0.9), C('phone', 'تلفن', 'text', 1.1), C('invoices', 'فاکتور در بازه', 'qty', 0.8, { sum: true }),
      C('net', 'خرید خالص در بازه', 'money', 1.1, { sum: true }), C('avg', 'میانگین فاکتور', 'money', 1), C('profit', 'سود معلوم', 'money', 1, { sum: true }), C('margin', 'حاشیه', 'pct', 0.7),
      C('last', 'آخرین خرید', 'date', 0.9), C('balance', 'مانده حساب (امروز)', 'money', 1, { sum: true })],
    summary: function (rows) { var b = rows.filter(function (r) { return r.invoices > 0; });
      return [['تعداد مشتری', rows.length, 'qty'], ['مشتریان دارای خرید در بازه', b.length, 'qty'], ['خرید تکراری (۲ فاکتور یا بیشتر)', b.length ? round1(b.filter(function (r) { return r.invoices >= 2; }).length / b.length * 100) : null, 'pct'],
        ['جمع خرید خالص', sumK(rows, 'net'), 'money']]; },
    note: '«سود معلوم» فقط از ردیف‌های با بهای خرید معلوم است. مانده حساب: مثبت = بدهکار، منفی = بستانکار.' });

  var PROBLEMS = {
    noCategory: ['بدون گروه', function (p) { return !p.categoryId; }],
    noBrand: ['بدون برند', function (p) { return !p.brand; }],
    noPrice: ['بدون قیمت فروش', function (p) { return p.sellPrice == null; }],
    unknownCost: ['موجودی بدون بهای خرید', function (p) { return p.stock - (p.costedQty || 0) > 0; }],
    noLabel: ['دارای موجودی، بدون برچسب QR و بارکد', function (p, ctx) { return p.stock > 0 && !ctx.labelLog()[p.id] && !(p.barcodes || []).length; }],
    noLocation: ['بدون محل نگهداری', function (p) { return p.stock > 0 && !p.location; }],
    noAttrs: ['مشخصات فنی گروه تکمیل نشده', function (p, ctx) { if (!p.categoryId) return false; var defs = ctx.E.categoryAttrDefs(p.categoryId); return defs.some(function (d) { return !p.attrs || p.attrs[d.key] == null || p.attrs[d.key] === ''; }); }],
    noSupplier: ['بدون تأمین‌کننده', function (p) { return !p.supplierId; }]
  };
  def('quality', { today: true, title: 'کیفیت اطلاعات و برچسب کالاها', group: 'کنترل', link: 'product', filters: ['q', 'category', 'brand', 'car', 'supplier', 'active', 'rflags'], defaults: { active: 'yes' },
    rflags: (function () { var o = {}; Object.keys(PROBLEMS).forEach(function (k) { o[k] = [PROBLEMS[k][0], function (r) { return r.codes.indexOf(k) >= 0; }]; }); return o; })(),
    source: function (ctx) {
      return ctx.E.list('products').map(function (p) {
        var codes = Object.keys(PROBLEMS).filter(function (k) { return PROBLEMS[k][1](p, ctx); });
        return { id: p.id, productId: p.id, sku: p.sku, name: p.name, brand: p.brand, stock: p.stock, codes: codes, problems: codes.map(function (k) { return PROBLEMS[k][0]; }).join('، '), count: codes.length };
      }).filter(function (r) { return r.count > 0 && r.codes.join() !== 'noSupplier'; });
    },
    defaultSort: { key: 'count', dir: -1 },
    columns: [C('sku', 'کد', 'text', 1), C('name', 'کالا', 'text', 2.4, { wrap: true }), C('brand', 'برند', 'text', 0.9), C('stock', 'موجودی', 'qty', 0.7), C('count', 'تعداد مشکل', 'qty', 0.7), C('problems', 'موارد', 'text', 3.2, { wrap: true })],
    summary: function (rows) { var o = [['کالاهای دارای نقص', rows.length, 'qty']];
      Object.keys(PROBLEMS).forEach(function (k) { var n = rows.filter(function (r) { return r.codes.indexOf(k) >= 0; }).length; if (n) o.push([PROBLEMS[k][0], n, 'qty']); }); return o; },
    note: 'این گزارش فقط فهرست می‌دهد و چیزی را تغییر نمی‌دهد. «تأمین‌کننده» اختیاری است و به‌تنهایی نقص حساب نمی‌شود. برای چاپ برچسب کالاهای بدون برچسب از صفحه «برچسب QR» دکمه «بدون برچسب» را بزنید.' });

  def('reconcile', { today: true, title: 'کنترل مغایرت موجودی', group: 'کنترل', filters: [], link: 'product',
    source: function (ctx) { return ctx.E.reconcile().map(function (r) { r.id = r.productId; return r; }); },
    columns: [C('name', 'کالا', 'text', 3), C('stored', 'موجودی ثبت‌شده', 'qty'), C('calculated', 'جمع گردش‌ها', 'qty')],
    summary: function (rows) { return [['نتیجه', rows.length ? fa(rows.length) + ' مغایرت پیدا شد' : 'بدون مغایرت ✓']]; } });

  def('customer', { title: 'صورت‌حساب مشتری', group: 'مالی و مشتری', hidden: true, range: true, rangeInSource: true, needs: 'customer', link: 'doc', filters: [],
    title2: function (p, ctx) { var c = ctx.S.customers[p.customerId]; return c ? 'صورت‌حساب: ' + c.name : null; },
    source: function (ctx, p) {
      var S = ctx.S, c = S.customers[p.customerId]; if (!c) return [];
      // v2.11: the whole account (same rows as «حساب اشخاص»): sale invoices, returns, receipts with what they settled,
      // direct sales, opening balance, adjustments, cancellations — each with its type
      // v2.13: cancelled documents (an invoice and its cancellation, summing to 0) are left out unless «نمایش باطل‌شده‌ها» is on
      var showV = p.showVoid != null ? !!p.showVoid : (function () { try { return root.localStorage && JSON.parse(root.localStorage.getItem('ay.showVoid')) === true; } catch (e) { return false; } })();
      var all = ctx.E.partyStatement('customer', c.id, {}).rows, hidden = all.filter(function (r) { return r.voided; }).length; p._hiddenVoid = showV ? 0 : hidden;
      var run = 0;
      var rows = all.filter(function (r) { return showV || !r.voided; }).map(function (r) { run += r.amount;
        return { ts: r.ts, no: r.no, cat: r.cat || '', desc: r.desc + (r.ref ? ' — پیگیری ' + r.ref : ''), debit: r.debit || null, credit: r.credit || null, bal: run, docId: r.docId || null, id: r.docId || r.refId };
      });
      var opening = 0;
      rows.forEach(function (r) { if (p.from != null && r.ts < p.from) opening = r.bal; });
      p._opening = opening;
      return rows.filter(function (r) { return (p.from == null || r.ts >= p.from) && (p.to == null || r.ts <= p.to); });
    },
    defaultSort: null,
    columns: [C('ts', 'تاریخ', 'datetime', 1.3), C('no', 'شماره', 'text', 1.1), C('cat', 'نوع', 'text', 1.1), C('desc', 'شرح', 'text', 2.6, { wrap: true }), C('debit', 'بدهکار', 'money', 1, { sum: true }), C('credit', 'بستانکار', 'money', 1, { sum: true }), C('bal', 'مانده', 'money')],
    summary: function (rows, ctx, p) { var c = ctx.S.customers[p.customerId]; if (!c) return [];
      return [['مشتری', c.name + (c.phone ? ' — ' + c.phone : '')], ['مانده ابتدای دوره', p._opening, 'money'], ['مانده فعلی امروز (کل حساب مشتری)', ctx.E.partyBalance('customer', c.id), 'money']].concat(p._hiddenVoid ? [['ردیف باطل‌شده (نمایش داده نشده؛ اثری در مانده ندارد)', p._hiddenVoid, 'qty']] : []); } });

  // ---------- run ----------
  function cmp(a, b) {
    if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), 'fa');
  }
  /* st = { preset, from, to, f: {filterId: value}, sort: {key, dir}, opt: {...} }
     params = { productId, customerId, now, windowDays, leadDays, coverDays } */
  function run(E, id, st, params) {
    var d = DEFS[id]; if (!d) throw new Error('UNKNOWN_REPORT');
    st = st || {}; params = params || {};
    var ctx = makeCtx(E, params), f = Object.assign({}, d.defaults || {}, st.f || {});
    var rg = d.range ? resolveRange(st, ctx.now) : { from: null, to: null, text: '' };
    var opt = {}; (d.options || []).forEach(function (o) { opt[o.id] = st.opt && o.values[st.opt[o.id]] ? st.opt[o.id] : o.def; });
    var p = { from: rg.from, to: rg.to, productId: params.productId || null, customerId: params.customerId || null, opt: opt, showVoid: params.showVoid != null ? params.showVoid : null };
    var rows = d.source(ctx, p), sourceCount = rows.length;
    if (d.range && !d.rangeInSource) rows = rows.filter(function (r) { return (p.from == null || r.ts >= p.from) && (p.to == null || r.ts <= p.to); });
    function applyF(list, ids) {
      var act = (ids || []).filter(function (k) { return FILTERS[k] && isSet(FILTERS[k], f[k]); });
      if (!act.length) return list;
      return list.filter(function (r) { for (var i = 0; i < act.length; i++) if (!FILTERS[act[i]].test(r, f[act[i]], ctx, d)) return false; return true; });
    }
    rows = applyF(rows, d.filters);
    if (d.aggregate) { rows = d.aggregate(rows, ctx, p); rows = applyF(rows, d.groupFilters); }
    var columns = typeof d.columns === 'function' ? d.columns(p, ctx) : d.columns;
    var sort = st.sort && st.sort.key && columns.some(function (c) { return c.key === st.sort.key; }) ? st.sort : d.defaultSort;
    if (sort && sort.key) {
      var k = sort.key, dir = sort.dir || 1;
      rows = rows.map(function (r, i) { return [r, i]; }).sort(function (a, b) { var x = a[0][k], y = b[0][k]; if (x == null || y == null) return cmp(x, y) || a[1] - b[1]; return cmp(x, y) * dir || a[1] - b[1]; }).map(function (x) { return x[0]; });
    }
    var totals = null;
    if (columns.some(function (c) { return c.sum; }) && rows.length) {
      totals = {};
      columns.forEach(function (c) { if (c.sum) totals[c.key] = sumK(rows, c.key); });
    }
    var all = (d.filters || []).concat(d.groupFilters || []);
    var ftext = all.filter(function (k) { return FILTERS[k] && isSet(FILTERS[k], f[k]); }).map(function (k) { return { id: k, text: filterText(k, f[k], ctx, d), isDefault: d.defaults && JSON.stringify(d.defaults[k]) === JSON.stringify(f[k]) }; });
    (d.options || []).forEach(function (o) { ftext.unshift({ id: 'opt:' + o.id, text: o.label + ': ' + o.values[opt[o.id]], fixed: true }); });
    return { id: id, def: d, title: (d.title2 && d.title2(p, ctx)) || d.title, columns: columns, rows: rows, totals: totals, sort: sort,
      summary: d.summary ? d.summary(rows, ctx, p) : [['تعداد ردیف', rows.length, 'qty']], note: d.note || null, landscape: !!d.landscape, link: d.link || null,
      range: rg, filters: ftext, filterValues: f, sourceCount: sourceCount, params: p,
      describe: [d.range ? 'بازه: ' + rg.text : null].concat(ftext.map(function (x) { return x.text; })).filter(Boolean).join(' | ') };
  }

  // ---------- exports: same rows/order/totals as the screen ----------
  function totalsRow(res, formatted) {
    if (!res.totals) return null;
    var first = true;
    return res.columns.map(function (c) {
      if (c.sum) return formatted ? fmtCell(c, res.totals[c.key]) : res.totals[c.key];
      if (first && (!c.type || c.type === 'text')) { first = false; return 'جمع'; }
      return '';
    });
  }
  function toMatrix(res, formatted) {
    var head = res.columns.map(function (c) { return c.label; });
    var body = res.rows.map(function (r) { return res.columns.map(function (c) { return formatted ? fmtCell(c, r[c.key]) : rawCell(c, r[c.key]); }); });
    return [head].concat(body);
  }
  function sumRaw(s) { return s.length > 2 && s[2] ? rawCell({ type: s[2] }, s[1]) : s[1]; }
  function sumFmt(s) { return s.length > 2 && s[2] ? fmtCell({ type: s[2] }, s[1]) + (s[2] === 'money' ? ' تومان' : '') : (s[1] == null ? '—' : s[1]); }
  function infoRows(res) {
    return [['گزارش', res.title], res.def.range ? ['بازه', res.range.text] : null, ['فیلترها', res.filters.length ? res.filters.map(function (x) { return x.text; }).join(' | ') : 'بدون فیلتر'],
      ['تعداد ردیف', res.rows.length], ['تهیه‌شده', root.Jalali.fmt(Date.now(), true)]].filter(Boolean);
  }
  function exportXlsx(res) {
    var m = toMatrix(res, false), t = totalsRow(res, false); if (t) m.push(t);
    var info = [['شرح', 'مقدار']].concat(infoRows(res)).concat((res.summary || []).map(function (s) { return [s[0], sumRaw(s)]; })).concat(res.note ? [['توضیح', res.note]] : []);
    return root.XLSX.writeXlsx([{ name: res.title.slice(0, 31).replace(/[\\\/?*\[\]:]/g, ' '), rows: m }, { name: 'خلاصه و فیلترها', rows: info }]);
  }
  function exportCsv(res) { return root.XLSX.writeCsv(toMatrix(res, false)); } // data rows only (machine-readable); totals/filters are in Excel/PDF
  function exportPdf(res, shop, onProgress) {
    var blocks = [{ type: 'title', text: res.title, sub: res.describe || 'بدون فیلتر', left: shop ? [shop] : null }];
    if (res.summary && res.summary.length) blocks.push({ type: 'kv', items: res.summary.map(function (s) { return [s[0], sumFmt(s)]; }), cols: 2 });
    if (res.note) blocks.push({ type: 'text', text: res.note, size: 2.8, color: '#555' });
    blocks.push({ type: 'table', columns: res.columns.map(function (c) { return { label: c.label, w: c.w || 1, wrap: c.wrap, align: c.type && c.type !== 'text' ? 'center' : 'right' }; }),
      rows: res.rows.map(function (r) { return res.columns.map(function (c) { return fmtCell(c, r[c.key]); }); }), foot: totalsRow(res, true) });
    if (!res.rows.length) blocks.push({ type: 'text', text: 'موردی برای نمایش وجود ندارد.' });
    var U = root.UI;
    return root.PDF.renderFlow(blocks, { landscape: res.landscape, title: res.title, footer: 'تهیه‌شده در ' + (U ? U.dateFa(Date.now(), true) : ''), onProgress: onProgress });
  }

  function list() { return Object.keys(DEFS).map(function (k) { return DEFS[k]; }).filter(function (d) { return !d.hidden; }); }
  var api = { DEFS: DEFS, FILTERS: FILTERS, PFLAGS: PFLAGS, GROUP_BY: GROUP_BY, run: run, list: list, isSet: isSet, presets: presets, resolveRange: resolveRange, attrKeys: attrKeys,
    fmtCell: fmtCell, rawCell: rawCell, toMatrix: toMatrix, totalsRow: totalsRow, exportXlsx: exportXlsx, exportCsv: exportCsv, exportPdf: exportPdf,
    docTypeLabel: docTypeLabel, SETTLE: SETTLE, KIND: KIND, LEVEL: LEVEL, VELOCITY: VELOCITY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Reports = api;
})(typeof self !== 'undefined' ? self : this);
