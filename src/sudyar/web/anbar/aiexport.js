/* AI data package: one ZIP with documented, machine-readable data for analysis by Claude (or any tool).
   - raw/*.jsonl   : the recorded facts (one JSON object per line), stable IDs, ms timestamps, amounts in Toman
   - derived/*     : computed from raw (stock snapshot, sales lines with cost/profit, monthly, aging, analytics…)
   - management_report.md, README.md, data_dictionary.md, schema.json, manifest.json (SHA-256 of every file)
   Customer names/phones/addresses and free-text notes are NOT included unless the user explicitly asks
   (opts.pseudonymize === false). Auth hashes / recovery codes are never exported. Nothing here changes data. */
(function (root) {
  'use strict';
  var FORMAT = 1;
  var T = { s: 'string', i: 'integer', m: 'money (Toman, integer)', ts: 'timestamp (ms since 1970-01-01 UTC)', b: 'boolean', o: 'object', a: 'array' };
  // [field, type, description, sensitive?]  sensitive = only in the full (non-pseudonymized) export
  var SCHEMA = {
    products: { file: 'raw/products.jsonl', pk: 'id', desc: 'کالا / تنوع کالا؛ هر SKU یک ردیف (variant).', fields: [
      ['id', T.s, 'شناسه پایدار و یکتا؛ هرگز تغییر نمی‌کند. محتوای QR داخلی برچسب = "AY:" + id'],
      ['sku', T.s, 'کد داخلی کالا (یکتا)'], ['name', T.s, 'نام کالا'], ['shortName', T.s, 'نام کوتاه برای برچسب'], ['brand', T.s, 'برند'],
      ['model', T.s, 'مدل / خودروی مصرف'], ['family', T.s, 'خانواده / سری'], ['categoryId', 'fk → categories.id | null', 'گروه کالا (درختی)'],
      ['cars', 'string[] | absent', 'v2.4: خودروهایی که این قطعه به آن‌ها می‌خورد (یک قطعه ممکن است به چند خودرو بخورد؛ جدا از گروه)'],
      ['unit', T.s, 'واحد شمارش'], ['packSize', T.i, 'تعداد قطعه در هر واحد'], ['minStock', T.i, 'حداقل موجودی تعیین‌شده'],
      ['stock', T.i, 'موجودی فعلی (واحد) = جمع movements.qty همان کالا'], ['buyPrice', T.m + ' | null', 'آخرین قیمت خرید ثبت‌شده'],
      ['sellPrice', T.m + ' | null', 'قیمت فروش فعلی'], ['costBasis', T.m, 'جمع بهای خرید واحدهای موجود که بهایشان معلوم است (FIFO)'],
      ['costedQty', T.i, 'تعداد واحدهای موجود با بهای معلوم؛ stock − costedQty = واحدهای بدون بها'],
      ['location', T.s, 'محل نگهداری'], ['active', T.b, 'فعال / غیرفعال'], ['supplierId', 'fk → suppliers.id | null', 'تأمین‌کننده اصلی'],
      ['warrantyMonths', T.i + ' | null', 'مدت گارانتی به ماه'], ['attrs', T.o, 'مشخصات فنی سفارشی {key: value}؛ تعریف کلیدها در categories.attrDefs'],
      ['publicCode', T.s + ' | null', 'کد عمومی ۱۰ نویسه‌ای برای QR مشتری؛ اطلاعات حساس از آن قابل استخراج نیست'],
      ['barcodes', T.a, 'بارکدهای کارخانه (EAN/UPC/Code128)'], ['notes', T.s, 'یادداشت آزاد', true],
      ['createdAt', T.ts, 'زمان ایجاد'], ['updatedAt', T.ts, 'زمان آخرین تغییر']] },
    categories: { file: 'raw/categories.jsonl', pk: 'id', desc: 'گروه‌های کالا (درختی، تعریف کاربر). گروه بدون والد = رشته کاری اصلی.', fields: [
      ['id', T.s, 'شناسه پایدار'], ['name', T.s, 'نام گروه'], ['parentId', 'fk → categories.id | null', 'گروه والد'],
      ['path', T.s, '(مشتق) مسیر کامل گروه، مثل «قطعات › لنت»'], ['attrDefs', T.a, 'تعریف مشخصات فنی: [{key, label, type: text|number|select, options}] — زیرگروه‌ها به ارث می‌برند'],
      ['active', T.b, 'فعال'], ['createdAt', T.ts, ''], ['updatedAt', T.ts, '']] },
    suppliers: { file: 'raw/suppliers.jsonl', pk: 'id', desc: 'تأمین‌کنندگان', fields: [
      ['id', T.s, 'شناسه پایدار'], ['name', T.s, 'نام تأمین‌کننده'], ['city', T.s, 'شهر'], ['phone', T.s, 'تلفن', true], ['notes', T.s, 'یادداشت', true],
      ['active', T.b, ''], ['createdAt', T.ts, '']] },
    customers: { file: 'raw/customers.jsonl', pk: 'id', desc: 'مشتریان. در خروجی پیش‌فرض نام واقعی، تلفن، نشانی و یادداشت حذف و با برچسب مستعار جایگزین شده‌اند.', fields: [
      ['id', T.s, 'شناسه پایدار (تصادفی؛ اطلاعات شخصی ندارد)'], ['label', T.s, 'برچسب نمایش؛ در خروجی پیش‌فرض مستعار است مثل «مشتری-0007»'],
      ['type', 'enum', 'mechanic=تعمیرکار، store=فروشگاه/همکار، person=شخصی، company=شرکت، other=سایر'], ['city', T.s, 'شهر'],
      ['name', T.s, 'نام واقعی', true], ['phone', T.s, 'تلفن', true], ['address', T.s, 'نشانی', true], ['notes', T.s, 'یادداشت', true], ['createdAt', T.ts, '']] },
    docs: { file: 'raw/docs.jsonl', pk: 'id', desc: 'سرِ اسناد. هر تغییر موجودی یا مبلغ فقط با سند انجام می‌شود؛ سند ثبت‌شده ویرایش نمی‌شود، بلکه با سند برگشت (reversal) خنثی می‌شود.', fields: [
      ['id', T.s, 'شناسه پایدار'], ['kind', 'enum', 'in=ورود، out=خروج، return=مرجوعی فروش، reversal=سند برگشت/لغو، adjust=تعدیل موجودی'],
      ['type', 'enum', 'in: purchase|initial|other…؛ out: sale|scrap|internal|supplier_return|other؛ return: sale_return؛ reversal؛ adjust'],
      ['no', T.s, 'شماره سند (IN-/OUT-/RET-/REV-/ADJ-)'], ['invoiceNo', T.s, 'شماره فاکتور فروش (INV-)؛ برای مرجوعی = فاکتور مرجع'],
      ['ts', T.ts, 'تاریخ سند (تاریخ اقتصادی)'], ['date_iso', T.s, '(مشتق) تاریخ محلی ISO'], ['date_fa', T.s, '(مشتق) تاریخ شمسی'],
      ['status', 'enum', 'posted=معتبر، reversed=لغو/برگشت‌خورده (اثرش با سند reversal خنثی شده)'],
      ['customerId', 'fk → customers.id | null', ''], ['supplierId', 'fk → suppliers.id | null', ''], ['invoiceId', 'fk → docs.id | null', 'برای مرجوعی: فاکتور اصلی'],
      ['reverses', 'fk → docs.id | null', 'برای سند برگشت: سندی که خنثی شده'], ['reversedBy', 'fk → docs.id | null', 'سند برگشتی که این سند را خنثی کرده'],
      ['reversedAt', T.ts + ' | null', ''], ['replaces', 'fk → docs.id | null', 'فاکتور اصلاحی: فاکتور لغوشده‌ای که جایگزینش شده'],
      ['subtotal', T.m, 'فاکتور: جمع ردیف‌ها پس از تخفیف ردیف'], ['discount', T.m, 'فاکتور: تخفیف کل'], ['total', T.m, 'فاکتور: مبلغ نهایی؛ مرجوعی: مبلغ برگشتی'],
      ['returned', T.m, 'فاکتور: جمع مرجوعی‌های معتبر'], ['paid', T.m, 'فاکتور: جمع دریافت‌ها'], ['refunded', T.m, 'فاکتور: جمع بازپرداخت‌ها'],
      ['balance', T.m, 'فاکتور: مانده = (total − returned؛ صفر اگر لغو شده) − (paid − refunded)؛ منفی = بستانکاری مشتری'],
      ['settlement', 'enum', 'settled|partial|unsettled|credit'], ['dueDate', T.ts + ' | null', 'سررسید پرداخت'],
      ['reason', T.s, 'علت (برای تعدیل، مرجوعی، برگشت)'], ['note', T.s, 'توضیح آزاد', true], ['recipient', T.s, 'تحویل‌گیرنده', true], ['supplierDocNo', T.s, 'شماره فاکتور تأمین‌کننده', true],
      ['user', T.s, 'نقش ثبت‌کننده: مدیر | کاربر'], ['source', T.s, 'منبع ثبت: ui | import | …'], ['createdAt', T.ts, 'زمان واقعی ثبت در برنامه'], ['updatedAt', T.ts, ''],
      ['invoice', 'object | null', 'فاکتور خرید تأمین‌کننده (نسخه ۲٫۱): شماره خام و کلیدها، تاریخ فاکتور، واحد پول، جمع اعلامی/محاسبه‌شده، تخفیف کلی و روش تخصیص، هزینه‌ها و مالیات با روش اعمال (سرشکن/جدا) و انتخاب‌کننده، قابل پرداخت به تومان، تأییدها و عبورهای مدیر', true]] },
    doc_lines: { file: 'raw/doc_lines.jsonl', pk: 'docId + lineNo', desc: 'ردیف‌های اسناد', fields: [
      ['docId', 'fk → docs.id', ''], ['lineNo', T.i, 'شماره ردیف (از ۰)'], ['kind', T.s, 'تکرار docs.kind'], ['type', T.s, 'تکرار docs.type'], ['ts', T.ts, 'تکرار docs.ts'],
      ['productId', 'fk → products.id', ''], ['sku', T.s, 'کد کالا در زمان ثبت'], ['name', T.s, 'نام کالا در زمان ثبت'], ['qty', T.i, 'تعداد (همیشه مثبت؛ جهت از kind معلوم است)؛ تعدیل: تغییر علامت‌دار'],
      ['unitPrice', T.m + ' | null', 'فروش: قیمت واحد؛ فاکتور خرید: فی روی فاکتور (به واحد همان فاکتور)'], ['lineDiscount', T.m + ' | null', 'فاکتور خرید: تخفیف اختصاصی ردیف (به واحد فاکتور)'],
      ['lineNet', T.m + ' | null', 'فاکتور خرید: qty×unitPrice − lineDiscount'], ['charges', T.a, 'فاکتور خرید: سهم این ردیف از هر هزینه/مالیات، هم‌ترتیب با docs.invoice.charges'], ['discount', T.m + ' | null', 'فروش: تخفیف ردیف'], ['lineTotal', T.m + ' | null', 'فروش: qty×unitPrice − discount'],
      ['invDisc', T.m, 'فروش و فاکتور خرید: سهم این ردیف از تخفیف کل فاکتور (بزرگ‌ترین باقیمانده یا تخصیص دستی؛ جمع = تخفیف کل)'], ['net', T.m, 'فروش: مبلغ خالص ردیف = lineTotal − invDisc'],
      ['unitCost', T.m + ' | null', 'ورود: بهای خرید واحد؛ خروج: میانگین بهای FIFO اگر همه واحدها معلوم باشند'],
      ['costTotal', T.m + ' | null', 'خروج/مرجوعی: بهای تمام‌شده FIFO؛ null یعنی دست‌کم یک واحد بهای نامعلوم داشته؛ فاکتور خرید: بهای خالص دقیق ردیف به تومان (پس از تخفیف‌ها و هزینه‌های سرشکن)'],
      ['returnedQty', T.i, 'فروش: تعداد مرجوع‌شده از این ردیف'], ['returnedAmount', T.m, 'فروش: مبلغ مرجوع‌شده از این ردیف'],
      ['amount', T.m, 'مرجوعی: مبلغ برگشتی این ردیف'], ['invoiceLine', T.i, 'مرجوعی: شماره ردیف فاکتور اصلی'], ['before', T.i, 'تعدیل: موجودی قبل'], ['after', T.i, 'تعدیل: موجودی بعد']] },
    payments: { file: 'raw/payments.jsonl', pk: 'id', desc: 'دریافت و بازپرداخت روی فاکتورها. method=credit_transfer یعنی جابه‌جایی بستانکاری بین دو فاکتور یک مشتری (پول جابه‌جا نمی‌شود؛ دو ردیف با pairId مشترک).', fields: [
      ['id', T.s, ''], ['no', T.s, 'PAY-…'], ['docId', 'fk → docs.id', 'فاکتور'], ['customerId', 'fk → customers.id', ''], ['kind', 'enum', 'receipt=دریافت از مشتری، refund=بازپرداخت به مشتری'],
      ['method', 'enum', 'cash|card_transfer|pos|bank|cheque|other|credit_transfer|credit(قدیمی)'], ['amount', T.m, 'همیشه مثبت'], ['signed', T.m, '(مشتق) دریافت مثبت، بازپرداخت منفی'],
      ['ts', T.ts, ''], ['pairId', T.s + ' | null', 'زوج انتقال بستانکاری'], ['returnId', 'fk → docs.id | null', 'بازپرداخت مربوط به این مرجوعی'],
      ['ref', T.s, 'شماره پیگیری / چک', true], ['note', T.s, 'توضیح', true], ['user', T.s, ''], ['createdAt', T.ts, '']] },
    movements: { file: 'raw/movements.jsonl', pk: 'id', desc: 'گردش کالا (کاردکس). جمع qty هر کالا = products.stock (کنترل مغایرت).', fields: [
      ['id', T.s, ''], ['productId', 'fk → products.id', ''], ['docId', 'fk → docs.id', ''], ['docNo', T.s, ''], ['kind', 'enum', 'in|initial|out|return|reversal|adjust'],
      ['qty', T.i, 'تغییر علامت‌دار موجودی (+ ورود، − خروج)'], ['balanceAfter', T.i, 'موجودی کالا بلافاصله پس از این گردش'], ['unitCost', T.m + ' | null', 'ورود: بهای واحد'],
      ['ts', T.ts, 'تاریخ سند'], ['user', T.s, ''], ['createdAt', T.ts, 'زمان واقعی ثبت']] }
  };
  var DERIVED = [
    ['derived/stock_snapshot.csv', 'وضعیت فعلی هر کالا: موجودی، ارزش بهای معلوم، میانگین بها، واحدهای بدون بها، گروه، سرعت فروش و روز پوشش (۹۰ روز).'],
    ['derived/sales_lines.csv', 'همه ردیف‌های فروش و مرجوعی (مرجوعی منفی در تاریخ مرجوعی؛ فاکتور لغوشده حذف). cost/profit فقط وقتی بهای همه واحدها معلوم بوده.'],
    ['derived/monthly.csv', 'خلاصه ماهانه (ماه شمسی): فروش خالص، فروش با بهای معلوم، سود معلوم، حاشیه، پوشش.'],
    ['derived/profit_by_root.csv', 'سودآوری به تفکیک رشته کاری (گروه اصلی).'], ['derived/profit_by_category.csv', 'سودآوری به تفکیک گروه کالا.'],
    ['derived/profit_by_brand.csv', 'سودآوری به تفکیک برند.'], ['derived/customers.csv', 'خلاصه هر مشتری (با برچسب مستعار در خروجی پیش‌فرض).'],
    ['derived/receivables_aging.csv', 'مطالبات به تفکیک سن بدهی.'], ['derived/reorder.csv', 'کالاهای کم‌موجود/ناموجود و پیشنهاد سفارش (تخمینی).'],
    ['derived/data_quality.csv', 'کالاهای دارای اطلاعات ناقص.'], ['derived/analytics.json', 'تحلیل مدیریتی کامل با مبنا، کفایت داده، فرض‌ها، اطمینان و اقدام پیشنهادی هر بخش.'],
    ['derived/health.json', 'نتیجه بررسی سلامت داده (فقط گزارش؛ چیزی را تغییر نمی‌دهد).'],
    ['derived/periods.json', 'دوره‌های مالی: قفل فعلی («بسته تا»)، و برای هر بستن/بازگشایی: تاریخ، نقش کاربر، خلاصه اعداد دوره، اثر انگشت SHA-256 و نوع مدرک ذخیره پشتیبان (علت‌ها فقط در خروجی کامل).']
  ];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoLocal(ms) {
    if (ms == null) return null;
    var d = new Date(ms), off = -d.getTimezoneOffset(), sg = off >= 0 ? '+' : '-', ao = Math.abs(off);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + sg + pad2(Math.floor(ao / 60)) + ':' + pad2(ao % 60);
  }
  function pick(rec, fields, full) {
    var o = {};
    fields.forEach(function (f) { if (f[3] && !full) return; if (rec[f[0]] !== undefined) o[f[0]] = rec[f[0]]; });
    return o;
  }
  function jsonl(rows) { return rows.map(function (r) { return JSON.stringify(r); }).join('\n') + (rows.length ? '\n' : ''); }
  function csvText(rows, keys) { // header = machine keys; dates already converted by caller
    function cell(v) {
      if (v == null) return '';
      var isText = typeof v === 'string';
      if (typeof v === 'object') v = JSON.stringify(v);
      var s = String(v);
      // spreadsheet formula-injection guard (same rule as the app's CSV export): text starting with = + @ tab CR,
      // or "-" that is not a plain number, gets a leading apostrophe. Numbers and Persian text are untouched.
      if (isText && (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)))) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    return '﻿' + [keys.join(',')].concat(rows.map(function (r) { return keys.map(function (k) { return cell(r[k]); }).join(','); })).join('\r\n') + '\r\n';
  }
  function g(n) { return n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function mdTable(cols, rows) {
    if (!rows.length) return '_(موردی نیست)_\n';
    var esc = function (v) { return String(v == null ? '' : v).replace(/\|/g, '/').replace(/\n/g, ' '); };
    return '| ' + cols.map(function (c) { return c[1]; }).join(' | ') + ' |\n|' + cols.map(function () { return '---'; }).join('|') + '|\n' +
      rows.map(function (r) { return '| ' + cols.map(function (c) { var v = r[c[0]]; return esc(typeof v === 'number' && c[2] !== 'raw' ? (c[2] === 'pct' ? v + '٪' : c[2] === 'date' ? root.Jalali.fmt(v) : g(v)) : v); }).join(' | ') + ' |'; }).join('\n') + '\n';
  }

  /* opts: { pseudonymize (default true), now, windowDays, leadDays, coverDays, appVersion, shopName } → Promise<{ bytes, name, manifest, files }> */
  function build(E, opts) {
    opts = opts || {};
    var full = opts.pseudonymize === false, now = opts.now || Date.now(), S = E.state, J = root.Jalali, R = root.Reports, AN = root.Analytics, Core = root.Core;
    var files = [];
    function add(name, text) { files.push({ name: name, data: text }); }
    var params = { now: now, windowDays: opts.windowDays || 90, leadDays: opts.leadDays || 7, coverDays: opts.coverDays || 30 };

    // stable pseudonyms: order of creation (independent of names)
    var custs = E.list('customers').sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0) || (a.id < b.id ? -1 : 1); }), label = {};
    custs.forEach(function (c, i) { label[c.id] = full ? c.name : 'مشتری-' + String(i + 1).padStart(4, '0'); });
    function lbl(id) { return id ? label[id] || 'مشتری-نامشخص' : ''; }

    // ---------- raw ----------
    add(SCHEMA.products.file, jsonl(E.list('products').map(function (p) { return pick(p, SCHEMA.products.fields, full); })));
    add(SCHEMA.categories.file, jsonl(E.list('categories').map(function (c) { var o = pick(c, SCHEMA.categories.fields, full); o.path = E.categoryPath(c.id).join(' › '); return o; })));
    add(SCHEMA.suppliers.file, jsonl(E.list('suppliers').map(function (s) { return pick(s, SCHEMA.suppliers.fields, full); })));
    add(SCHEMA.customers.file, jsonl(custs.map(function (c) { var o = pick(c, SCHEMA.customers.fields, full); o.label = lbl(c.id); return o; })));
    var docs = E.allDocs(), lines = [];
    add(SCHEMA.docs.file, jsonl(docs.map(function (d) {
      var o = pick(d, SCHEMA.docs.fields, full); o.date_iso = isoLocal(d.ts); o.date_fa = J.fmt(d.ts);
      (d.lines || []).forEach(function (l, i) {
        var x = { docId: d.id, lineNo: i, kind: d.kind, type: d.type, ts: d.ts };
        ['productId', 'sku', 'name', 'qty', 'unitPrice', 'discount', 'lineTotal', 'invDisc', 'net', 'unitCost', 'costTotal', 'returnedQty', 'returnedAmount', 'amount', 'before', 'after', 'lineDiscount', 'lineNet', 'charges'].forEach(function (k) { if (l[k] !== undefined) x[k] = l[k]; });
        if (d.kind === 'return') x.invoiceLine = l.line;
        lines.push(x);
      });
      return o;
    })));
    add(SCHEMA.doc_lines.file, jsonl(lines));
    add(SCHEMA.payments.file, jsonl(E.list('payments').sort(function (a, b) { return a.ts - b.ts || (a.createdAt || 0) - (b.createdAt || 0); }).map(function (p) {
      var o = pick(p, SCHEMA.payments.fields, full); o.signed = p.kind === 'refund' ? -p.amount : p.amount; return o; })));
    add(SCHEMA.movements.file, jsonl(E.list('movements').sort(function (a, b) { return a.ts - b.ts || (a.createdAt || 0) - (b.createdAt || 0); }).map(function (m) { return pick(m, SCHEMA.movements.fields, full); })));

    // ---------- derived ----------
    var an = AN.compute(E, params);
    var stock = R.run(E, 'stock', { f: { active: null } }, params).rows;
    add('derived/stock_snapshot.csv', csvText(stock.map(function (r) { var x = an.byId[r.id] || {}; return Object.assign({}, r, { productId: r.id, attrs: r.attrs, cars: ((S.products[r.id] || {}).cars || []).join('؛ '), soldQty90: x.soldQty, dailyRate90: x.dailyRate ? Math.round(x.dailyRate * 1000) / 1000 : 0, coverDays: x.coverDays, velocity: x.velocity, abc: x.abc, confidence: x.confidence }); }),
      ['productId', 'sku', 'name', 'brand', 'model', 'categoryId', 'category', 'cars', 'supplierId', 'unit', 'stock', 'minStock', 'active', 'avgCost', 'knownValue', 'unknownCostQty', 'sellPrice', 'buyPrice', 'warrantyMonths', 'attrs', 'soldQty90', 'dailyRate90', 'coverDays', 'velocity', 'abc', 'confidence']));
    var sl = R.run(E, 'sales', { preset: 'all' }, params).rows.slice().sort(function (a, b) { return a.ts - b.ts; });
    add('derived/sales_lines.csv', csvText(sl.map(function (r) { var p = S.products[r.productId] || {};
      return { date_iso: isoLocal(r.ts), date_fa: J.fmt(r.ts), kind: r.op, docId: r.docId, invoiceNo: r.invoiceNo, customerId: r.customerId, customer: lbl(r.customerId), customerType: r.customerType,
        productId: r.productId, sku: r.sku, name: r.name, brand: r.brand, categoryId: p.categoryId || '', category: p.categoryId ? E.categoryPath(p.categoryId).join(' › ') : '', cars: (p.cars || []).join('؛ '),
        qty: r.qty, unitPrice: r.unitPrice, lineDiscount: r.discount, invoiceDiscountShare: r.invDisc, net: r.net, cost: r.cost, profit: r.profit, marginPct: r.margin, settlement: r.settlement, user: r.user }; }),
      ['date_iso', 'date_fa', 'kind', 'docId', 'invoiceNo', 'customerId', 'customer', 'customerType', 'productId', 'sku', 'name', 'brand', 'categoryId', 'category', 'cars', 'qty', 'unitPrice', 'lineDiscount', 'invoiceDiscountShare', 'net', 'cost', 'profit', 'marginPct', 'settlement', 'user']));
    function grp(by) { return R.run(E, 'profitgroup', { preset: 'all', opt: { by: by } }, params).rows; }
    var gcols = ['key', 'label', 'qty', 'net', 'knownNet', 'cost', 'profit', 'margin', 'coverage', 'lines', 'unknownLines'];
    add('derived/monthly.csv', csvText(grp('month').sort(function (a, b) { return a.key < b.key ? -1 : 1; }), gcols));
    add('derived/profit_by_root.csv', csvText(grp('root'), gcols));
    add('derived/profit_by_category.csv', csvText(grp('category'), gcols));
    add('derived/profit_by_brand.csv', csvText(grp('brand'), gcols));
    add('derived/customers.csv', csvText(R.run(E, 'customers', { preset: 'all' }, params).rows.map(function (r) { return Object.assign({}, r, { label: lbl(r.customerId), last_iso: isoLocal(r.last) }); }),
      ['customerId', 'label', 'typeLabel', 'invoices', 'net', 'avg', 'profit', 'margin', 'last_iso', 'daysSince', 'balance'].concat(full ? ['name', 'phone', 'city'] : [])));
    add('derived/receivables_aging.csv', csvText(R.run(E, 'debtors', {}, params).rows.map(function (r) { return Object.assign({}, r, { label: lbl(r.customerId), lastPay_iso: isoLocal(r.lastPay) }); }),
      ['customerId', 'label', 'typeLabel', 'balance', 'notDue', 'd0_30', 'd31_60', 'd61_90', 'd90p', 'credit', 'overdueAmt', 'lastPay_iso'].concat(full ? ['name', 'phone'] : [])));
    add('derived/reorder.csv', csvText(R.run(E, 'low', {}, params).rows, ['productId', 'sku', 'name', 'brand', 'supplier', 'stock', 'minStock', 'dailyRate', 'coverDays', 'reorderQty', 'basis', 'confidence', 'status']));
    add('derived/data_quality.csv', csvText(R.run(E, 'quality', { f: { active: null } }, params).rows.map(function (r) { return Object.assign({}, r, { codes: r.codes.join(' ') }); }), ['productId', 'sku', 'name', 'stock', 'count', 'codes', 'problems']));
    // analytics with customer names replaced by labels
    var secs = an.sections.map(function (s) {
      return { id: s.id, title: s.title, basis: s.basis, sufficiency: s.sufficiency, confidence: s.confidence, assumptions: s.assumptions, summary: s.summary, action: s.action,
        tables: s.tables.map(function (t) { return { title: t.title, columns: t.cols, link: t.link || null, rows: t.rows.map(function (r) {
          var o = {}; t.cols.forEach(function (c) { o[c] = r[c]; }); var id = r[t.idKey || 'id']; if (t.link) o.ref = id;
          if (t.link === 'customer') { if ('name' in o) o.name = lbl(id); if ('label' in o) o.label = lbl(id); }
          return o; }) }; }) };
    });
    add('derived/analytics.json', JSON.stringify({ params: an.params, sufficiency: an.sufficiency, spanDays: an.spanDays, invoicesInWindow: an.invoices, levels: AN.LEVEL, sufficiencyLabels: AN.SUFF, sections: secs }, null, 1));
    var hc = E.healthCheck();
    add('derived/health.json', JSON.stringify({ ok: hc.ok, critical: hc.critical, warnings: hc.warnings, issues: hc.issues.map(function (i) { return { severity: i.severity, code: i.code, message: i.message }; }) }, null, 1));
    var pi = E.periodInfo();
    add('derived/periods.json', JSON.stringify({ closedThrough: pi.closedThrough, closedThrough_fa: pi.closedThrough != null ? J.fmt(pi.closedThrough) : null, backdateDays: pi.backdateDays,
      history: pi.history.map(function (x) { var o = Object.assign({}, x); if (!full) { delete o.reason; delete o.snapshot; } return o; }) }, null, 1));

    // ---------- management report ----------
    var gp = E.grossProfit({ from: now - 90 * 864e5, to: now }), bal = E.customerBalances(), recv = 0;
    Object.keys(bal).forEach(function (k) { if (bal[k] > 0) recv += bal[k]; });
    var od = R.run(E, 'invoices', { preset: 'all', f: { due: 'overdue' } }, params), q = R.run(E, 'quality', {}, params);
    var invVal = stock.reduce(function (a, r) { return a + (r.knownValue || 0); }, 0), unk = stock.reduce(function (a, r) { return a + (r.unknownCostQty || 0); }, 0);
    var cov = gp.knownSales + gp.unknownSales ? Math.round(gp.knownSales / (gp.knownSales + gp.unknownSales) * 1000) / 10 : 100;
    var md = '# گزارش مدیریتی ' + (opts.shopName || 'امیران یدک') + '\n\nتهیه‌شده: ' + J.fmt(now, true) + ' — بازه تحلیل فروش: ' + params.windowDays + ' روز اخیر — کفایت کلی داده: **' + AN.SUFF[an.sufficiency] + '**\n\n' +
      '> این گزارش خودکار از داده‌های ثبت‌شده در برنامه ساخته شده است. پیشنهادها و پیش‌بینی‌ها **تخمین** هستند، نه قطعیت. سود فقط برای فروش‌هایی حساب شده که بهای خرید همه واحدهایشان ثبت شده است.' + (full ? '' : ' اطلاعات شخصی مشتریان (نام، تلفن، نشانی) در این بسته نیست و مشتریان با برچسب مستعار آمده‌اند.') + '\n\n' +
      '## خلاصه وضعیت\n\n' + mdTable([['k', 'شاخص', 'raw'], ['v', 'مقدار', 'raw']], [
        { k: 'تعداد کالا (فعال / کل)', v: stock.filter(function (r) { return r.active; }).length + ' / ' + stock.length },
        { k: 'ارزش موجودی با بهای معلوم (تومان)', v: g(invVal) }, { k: 'واحدهای موجود بدون بهای خرید', v: g(unk) },
        { k: 'فروش خالص ۹۰ روز اخیر (تومان)', v: g(gp.knownSales + gp.unknownSales) }, { k: 'سود ناخالص معلوم ۹۰ روز (تومان)', v: g(gp.profit) },
        { k: 'پوشش محاسبه سود', v: cov + '٪ از فروش' }, { k: 'مطالبات از مشتریان (تومان)', v: g(recv) },
        { k: 'فاکتورهای سررسیدگذشته', v: od.rows.length + ' فاکتور، ' + g(od.totals ? od.totals.balance : 0) + ' تومان' },
        { k: 'کالاهای دارای اطلاعات ناقص', v: q.rows.length }, { k: 'مشکلات جدی سلامت داده', v: hc.critical }]) + '\n';
    an.sections.forEach(function (s) {
      md += '## ' + s.title + '\n\n- کفایت داده: **' + AN.SUFF[s.sufficiency] + '** — اطمینان: **' + AN.LEVEL[s.confidence] + '**\n- مبنا: ' + s.basis + '\n';
      s.summary.forEach(function (x) { md += '- ' + x[0] + ': ' + (typeof x[1] === 'number' ? g(x[1]) : x[1]) + '\n'; });
      md += '\n';
      secs.filter(function (x) { return x.id === s.id; })[0].tables.forEach(function (t) {
        if (!t.rows.length) return;
        md += '**' + t.title + '** (' + t.rows.length + ' ردیف' + (t.rows.length > 10 ? '، ۱۰ ردیف اول' : '') + ')\n\n' +
          mdTable(t.columns.map(function (c) { var x = AN.COLS[c] || [c, 'text']; return [c, x[0], x[1] === 'pct' ? 'pct' : x[1] === 'date' ? 'date' : x[1] === 'rate' || x[1] === 'text' || x[1] === 'level' || x[1] === 'velocity' ? 'raw' : 'num']; }),
            t.rows.slice(0, 10).map(function (r) { var o = Object.assign({}, r); if (o.confidence) o.confidence = AN.LEVEL[o.confidence] || o.confidence; if (o.velocity) o.velocity = AN.VELOCITY[o.velocity] || o.velocity; if (typeof o.dailyRate === 'number') o.dailyRate = Math.round(o.dailyRate * 100) / 100; return o; })) + '\n';
      });
      md += '- فرض‌ها: ' + s.assumptions.join(' — ') + '\n- **اقدام پیشنهادی:** ' + s.action + '\n\n';
    });
    md += '## کیفیت داده\n\n' + (q.summary.length > 1 ? q.summary.slice(1).map(function (x) { return '- ' + x[0] + ': ' + x[1]; }).join('\n') : '- نقصی دیده نشد.') + '\n\n' +
      '## محدودیت‌ها\n\n- همه اعداد فقط از داده‌های همین برنامه است؛ فروش یا خریدی که ثبت نشده در تحلیل نیست.\n- سرعت فروش و پیشنهاد سفارش از گذشته تخمین زده می‌شود؛ فصلی بودن، تبلیغات و قیمت روز لحاظ نشده است.\n- برای جزئیات و محاسبه دوباره از پوشه‌های raw و derived و فایل data_dictionary.md استفاده کنید.\n';
    add('management_report.md', md);

    // ---------- dictionary, schema, README ----------
    var dict = '# راهنمای داده‌ها (Data dictionary) — قالب بسته نسخه ' + FORMAT + '\n\n## قراردادها\n\n' +
      '- مبالغ: **تومان**، عدد صحیح (ریال نیست).\n- زمان: عدد میلی‌ثانیه از 1970-01-01 UTC؛ منطقه زمانی کسب‌وکار Asia/Tehran. ستون‌های `*_iso` زمان محلی ISO 8601 و `date_fa` تاریخ شمسی‌اند.\n' +
      '- شناسه‌ها (`id`) پایدار و یکتا هستند و با تغییر نام، برند یا قیمت عوض نمی‌شوند؛ برای اتصال جدول‌ها فقط از شناسه استفاده کنید، نه نام.\n' +
      '- داده خام (raw) = واقعیت ثبت‌شده. داده مشتق (derived) = محاسبه‌شده از raw و قابل بازتولید.\n- اسناد ثبت‌شده ویرایش نمی‌شوند؛ اصلاح با سند برگشت (`kind = reversal`) انجام می‌شود و سند اصلی `status = reversed` می‌گیرد. در تحلیل فروش، فاکتورهای `reversed` را کنار بگذارید.\n' +
      '- مرجوعی فروش سند جدا (`kind = return`) با پیوند به فاکتور (`invoiceId`) است و در تاریخ خودش فروش را کم می‌کند.\n- بهای تمام‌شده به روش FIFO لایه‌ای است؛ `costTotal = null` یعنی بهای دست‌کم یک واحد نامعلوم بوده و سود آن ردیف قابل محاسبه نیست (صفر فرض نکنید).\n' +
      '- ستون‌هایی که با «(مشتق)» مشخص شده‌اند در اصل داده ذخیره نمی‌شوند و هنگام خروجی ساخته شده‌اند.\n' +
      '- در فایل‌های CSV، متنی که با = یا + یا @ یا «-» غیرعددی شروع شود، برای جلوگیری از اجرای فرمول در Excel با علامت \' آغاز شده است؛ فایل‌های JSONL مقدار اصلی را بدون تغییر دارند.\n' + (full ? '- این بسته **کامل** است و نام/تلفن/نشانی مشتریان و یادداشت‌ها را دارد؛ با احتیاط به اشتراک بگذارید.\n' : '- ستون‌های حساس (نام واقعی، تلفن، نشانی، یادداشت‌ها، شماره چک/پیگیری) در این بسته **حذف شده‌اند**.\n') +
      '\n## روابط\n\n- products.categoryId → categories.id؛ categories.parentId → categories.id\n- products.supplierId، docs.supplierId → suppliers.id\n- docs.customerId، payments.customerId → customers.id\n- doc_lines.docId، payments.docId، movements.docId → docs.id\n- doc_lines.productId، movements.productId → products.id\n- docs.invoiceId (مرجوعی) / reverses / reversedBy / replaces → docs.id\n\n';
    Object.keys(SCHEMA).forEach(function (k) {
      var t = SCHEMA[k];
      dict += '## ' + k + ' — `' + t.file + '`\n\n' + t.desc + ' (کلید: `' + t.pk + '`)\n\n| فیلد | نوع | توضیح |\n|---|---|---|\n' +
        t.fields.filter(function (f) { return full || !f[3]; }).map(function (f) { return '| `' + f[0] + '` | ' + f[1] + ' | ' + f[2] + (f[3] ? ' **(حساس؛ فقط در خروجی کامل)**' : '') + ' |'; }).join('\n') + '\n\n';
    });
    dict += '## فایل‌های مشتق\n\n' + DERIVED.map(function (d) { return '- `' + d[0] + '`: ' + d[1]; }).join('\n') + '\n';
    add('data_dictionary.md', dict);
    var schema = { format: 'amiran-ai-package', formatVersion: FORMAT, appSchemaVersion: Core.SCHEMA_VERSION, currency: 'IRT (Toman, integer)', timezone: 'Asia/Tehran', timestamps: 'ms since epoch UTC', pseudonymized: !full,
      tables: {}, derived: DERIVED.map(function (d) { return { file: d[0], description: d[1] }; }),
      enums: { customerType: Core.CUSTOMER_TYPES, payMethod: Core.PAY_METHODS, issueType: Core.ISSUE_TYPES, receiptType: Core.RECEIPT_TYPES } };
    Object.keys(SCHEMA).forEach(function (k) { var t = SCHEMA[k]; schema.tables[k] = { file: t.file, primaryKey: t.pk, description: t.desc, fields: t.fields.filter(function (f) { return full || !f[3]; }).map(function (f) { return { name: f[0], type: f[1], description: f[2] }; }) }; });
    add('schema.json', JSON.stringify(schema, null, 1));
    add('README.md', '# بسته داده برای تحلیل با هوش مصنوعی — ' + (opts.shopName || 'امیران یدک') + '\n\n' +
      'این بسته را می‌توانید (کامل، به‌صورت ZIP) در گفت‌وگو با Claude بارگذاری کنید. ابتدا `management_report.md` را بخوانید؛ برای محاسبه دقیق از `raw/` و `derived/` و برای معنای هر ستون از `data_dictionary.md` استفاده کنید.\n\n' +
      '## نمونه درخواست\n\n> این بسته داده انبار و فروش فروشگاه من است. ابتدا README و data_dictionary را بخوان. سپس به فارسی بگو: کدام کالاها سرمایه را راکد کرده‌اند، چه کالاهایی را باید زودتر سفارش بدهم، سود واقعی هر رشته کاری چقدر است (با ذکر پوشش داده)، و چه مشتریانی پیگیری لازم دارند. هرجا داده کافی نیست صریح بگو و عدد حدسی نساز.\n\n' +
      '## نکات مهم\n\n- مبالغ به تومان است. سود فقط با بهای خرید معلوم محاسبه شده است؛ ردیف‌های بدون بها را صفر فرض نکنید.\n- این بسته شامل بهای خرید و سود است؛ فقط با ابزار و افراد مورد اعتماد به اشتراک بگذارید.\n' +
      (full ? '- **هشدار:** این بسته شامل نام و تلفن مشتریان است.\n' : '- اطلاعات شخصی مشتریان حذف شده و برچسب مستعار (مثل «مشتری-0003») دارد؛ همین برچسب در همه فایل‌ها یکسان است.\n') +
      '- `manifest.json` شامل کد کنترلی SHA-256 هر فایل است تا سالم بودن بسته قابل بررسی باشد.\n- این بسته فقط خواندنی است؛ تغییر آن هیچ اثری روی داده‌های برنامه ندارد.\n');

    // ---------- manifest with hashes ----------
    var enc = new TextEncoder(), subtle = (root.crypto || (typeof crypto !== 'undefined' ? crypto : null)).subtle;
    return Promise.all(files.map(function (f) { var b = enc.encode(f.data); f.bytes = b; return subtle.digest('SHA-256', b).then(function (h) { return Array.prototype.map.call(new Uint8Array(h), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); }); }))
      .then(function (hashes) {
        var counts = {}; Object.keys(SCHEMA).forEach(function (k) { counts[k] = (files.filter(function (f) { return f.name === SCHEMA[k].file; })[0].data.match(/\n/g) || []).length; });
        var manifest = { format: 'amiran-ai-package', formatVersion: FORMAT, createdAt: isoLocal(now), createdAt_fa: J.fmt(now, true), app: opts.appVersion || null, appSchemaVersion: Core.SCHEMA_VERSION,
          pseudonymized: !full, analysisParams: params, counts: counts, files: files.map(function (f, i) { return { name: f.name, bytes: f.bytes.length, sha256: hashes[i] }; }) };
        var all = files.map(function (f) { return { name: f.name, data: f.bytes }; }).concat([{ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 1)) }]);
        return { bytes: root.XLSX.zip(all), manifest: manifest, files: all };
      });
  }

  var api = { build: build, SCHEMA: SCHEMA, DERIVED: DERIVED, FORMAT: FORMAT, isoLocal: isoLocal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIExport = api;
})(typeof self !== 'undefined' ? self : this);
