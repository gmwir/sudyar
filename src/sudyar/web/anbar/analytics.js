/* Management analytics — pure (no DOM), testable in Node.
   Every section states: what data it is based on, whether that is enough, the assumptions, a confidence
   level and a suggested action. Forecasts are estimates from past sales only, never facts. */
(function (root) {
  'use strict';
  var DAY = 864e5;
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function sum(a, f) { var s = 0; for (var i = 0; i < a.length; i++) s += f ? (f(a[i]) || 0) : (a[i] || 0); return s; }
  function round1(x) { return Math.round(x * 10) / 10; }
  function g(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  var LEVEL = { high: 'بالا', medium: 'متوسط', low: 'پایین', none: 'بدون داده' };
  var SUFF = { enough: 'کافی', limited: 'محدود', insufficient: 'ناکافی' };
  var CONF_RULE = 'اطمینان هر ردیف: «بالا» = فروش در دست‌کم ۱۰ روز مختلف طی ۳۰ روز یا بیشتر؛ «متوسط» = ۴ تا ۹ روز فروش؛ «پایین» = کمتر از ۴ روز فروش.';

  function compute(E, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), win = opts.windowDays || 90, lead = opts.leadDays == null ? 7 : opts.leadDays, coverT = opts.coverDays || 30;
    var from = now - win * DAY, today = startOfDay(now);
    var products = E.list('products'), docs = E.allDocs(), customers = E.list('customers');
    var lines = E.salesLines({}); // all time, incl. returns as negative lines
    var gp = E.grossProfit({ from: from, to: now }); // sets profit/cost on rows (window)
    var winLines = gp.rows;
    var invoicesAll = docs.filter(function (d) { return d.kind === 'out' && d.type === 'sale' && d.status !== 'reversed'; });
    var invWin = invoicesAll.filter(function (d) { return d.ts >= from; });
    var firstTs = docs.length ? docs[0].ts : now, spanDays = Math.max(0, Math.round((now - firstTs) / DAY));
    var suff = invWin.length >= 50 && spanDays >= 60 ? 'enough' : invWin.length >= 10 && spanDays >= 14 ? 'limited' : 'insufficient';
    var basis = 'بر اساس ' + invWin.length + ' فاکتور در ' + Math.min(win, spanDays) + ' روز گذشته (کل سابقه: ' + spanDays + ' روز).';

    // ---------- per product ----------
    var firstMove = {}, lastMove = {};
    E.list('movements').forEach(function (m) {
      if (firstMove[m.productId] == null || m.ts < firstMove[m.productId]) firstMove[m.productId] = m.ts;
      if (lastMove[m.productId] == null || m.ts > lastMove[m.productId]) lastMove[m.productId] = m.ts;
    });
    var P = {};
    products.forEach(function (p) {
      P[p.id] = { id: p.id, sku: p.sku, name: p.name, brand: p.brand, categoryId: p.categoryId, category: p.categoryId ? E.categoryPath(p.categoryId).join(' › ') : (p.category || ''),
        active: p.active !== false, stock: p.stock, unit: p.unit, minStock: p.minStock || 0, sellPrice: p.sellPrice, avgCost: E.avgCost(p), knownValue: p.costBasis || 0,
        unknownCostQty: Math.max(0, p.stock - (p.costedQty || 0)), soldQty: 0, soldNet: 0, knownNet: 0, costKnown: 0, profitKnown: 0, unknownLines: 0, saleDays: {}, lastSale: null,
        firstMove: firstMove[p.id] || null, lastMove: lastMove[p.id] || null };
    });
    winLines.forEach(function (r) {
      var x = P[r.productId]; if (!x) return;
      x.soldQty += r.qty; x.soldNet += r.net;
      if (r.profit != null) { x.knownNet += r.net; x.costKnown += r.cost; x.profitKnown += r.profit; } else x.unknownLines++;
      if (r.kind === 'sale') { x.saleDays[startOfDay(r.ts)] = 1; if (!x.lastSale || r.ts > x.lastSale) x.lastSale = r.ts; }
    });
    var list = Object.keys(P).map(function (k) { return P[k]; });
    list.forEach(function (x) {
      x.saleDays = Object.keys(x.saleDays).length;
      var age = x.firstMove ? (now - x.firstMove) / DAY : 0;
      x.effDays = Math.max(7, Math.min(win, age));
      x.dailyRate = x.soldQty > 0 ? x.soldQty / x.effDays : 0;
      x.coverDays = x.dailyRate > 0 ? Math.floor(x.stock / x.dailyRate) : null;
      x.confidence = x.saleDays >= 10 && x.effDays >= 30 ? 'high' : x.saleDays >= 4 ? 'medium' : x.saleDays >= 1 ? 'low' : 'none';
      x.margin = x.knownNet > 0 ? round1(x.profitKnown / x.knownNet * 100) : null;
      // velocity class
      if (x.soldQty <= 0) x.velocity = x.stock > 0 ? (age >= win ? 'dead' : 'new') : 'none';
      else x.velocity = x.coverDays != null && x.coverDays > 180 ? 'slow' : 'normal';
      // reorder (only from observed sales; never from assumptions)
      var need = x.dailyRate * (lead + coverT);
      x.reorderQty = x.dailyRate > 0 ? Math.max(0, Math.ceil(need - x.stock)) : (x.minStock > 0 && x.stock <= x.minStock ? Math.max(0, x.minStock * 2 - x.stock) : 0);
      x.reorderBasis = x.dailyRate > 0 ? 'sales' : x.reorderQty > 0 ? 'minStock' : '';
      x.atRisk = x.active && x.stock > 0 && ((x.coverDays != null && x.coverDays <= lead) || (x.minStock > 0 && x.stock <= x.minStock));
      x.out = x.active && x.stock <= 0;
    });
    // ABC by window net revenue
    var sold = list.filter(function (x) { return x.soldNet > 0; }).sort(function (a, b) { return b.soldNet - a.soldNet; }), tot = sum(sold, function (x) { return x.soldNet; }), cum = 0;
    sold.forEach(function (x) { cum += x.soldNet; x.abc = cum / tot <= 0.8 || x === sold[0] ? 'A' : cum / tot <= 0.95 ? 'B' : 'C'; if (x.abc === 'A' && x.velocity === 'normal') x.velocity = 'top'; });
    list.forEach(function (x) { if (!x.abc) x.abc = x.soldNet > 0 ? 'C' : ''; });
    if (opts.productsOnly) return { params: { now: now, windowDays: win, leadDays: lead, coverDays: coverT, from: from }, sufficiency: suff, spanDays: spanDays, invoices: invWin.length, products: list, byId: P };

    var sections = [];
    function S(o) { sections.push(o); return o; }

    // 1. top / slow / dead
    var top = sold.slice(0, 15), dead = list.filter(function (x) { return x.velocity === 'dead' && x.active; }).sort(function (a, b) { return (b.knownValue - a.knownValue) || (b.stock - a.stock); });
    var slow = list.filter(function (x) { return x.velocity === 'slow'; }).sort(function (a, b) { return b.coverDays - a.coverDays; });
    S({ id: 'movers', title: 'پرفروش، کم‌فروش و راکد', basis: basis, sufficiency: suff,
      assumptions: ['«راکد» = موجودی دارد و در ' + win + ' روز گذشته هیچ فروشی نداشته و قدیمی‌تر از این بازه است.', '«کم‌فروش» = با سرعت فروش فعلی، موجودی بیش از ۱۸۰ روز طول می‌کشد.', 'گروه A کالاهایی است که ۸۰٪ فروش ریالی بازه را ساخته‌اند.'],
      confidence: suff === 'enough' ? 'high' : suff === 'limited' ? 'medium' : 'low',
      summary: [['کالاهای دارای فروش', sold.length], ['گروه A', sold.filter(function (x) { return x.abc === 'A'; }).length], ['کم‌فروش', slow.length], ['راکد', dead.length], ['ارزش موجودی راکد (بهای معلوم)', sum(dead, function (x) { return x.knownValue; })]],
      tables: [{ title: 'پرفروش‌ترین‌ها (مبلغ خالص)', rows: top, cols: ['sku', 'name', 'soldQty', 'soldNet', 'abc'], link: 'product' },
        { title: 'راکد', rows: dead.slice(0, 50), cols: ['sku', 'name', 'stock', 'knownValue', 'lastMove'], link: 'product' },
        { title: 'کم‌فروش', rows: slow.slice(0, 50), cols: ['sku', 'name', 'stock', 'dailyRate', 'coverDays'], link: 'product' }],
      action: dead.length ? 'برای کالاهای راکد فروش ویژه، فروش به همکار یا مرجوعی به تأمین‌کننده را بررسی کنید و از خرید دوباره آن‌ها خودداری کنید.' : 'کالای راکدی دیده نشد.' });

    // 2-3. turnover, cover days, stock-out risk
    var risk = list.filter(function (x) { return x.atRisk; }).sort(function (a, b) { return (a.coverDays == null ? 1e9 : a.coverDays) - (b.coverDays == null ? 1e9 : b.coverDays); });
    var outs = list.filter(function (x) { return x.out && (x.soldQty > 0 || x.minStock > 0); });
    S({ id: 'cover', title: 'سرعت فروش، روزهای پوشش و خطر اتمام', basis: basis, sufficiency: suff,
      assumptions: ['سرعت فروش = تعداد فروش خالص در بازه ÷ روزهای بازه (برای کالای جدید از اولین ورود؛ حداقل ۷ روز).', 'روزهای پوشش = موجودی ÷ سرعت فروش؛ فرض: فروش آینده شبیه گذشته است.', 'زمان تأمین: ' + lead + ' روز (در تنظیمات قابل تغییر).', CONF_RULE],
      confidence: suff === 'enough' ? 'medium' : 'low',
      summary: [['در خطر اتمام (پوشش ≤ زمان تأمین یا زیر حداقل)', risk.length], ['ناموجود با سابقه فروش/حداقل', outs.length]],
      tables: [{ title: 'در خطر اتمام', rows: risk.slice(0, 60), cols: ['sku', 'name', 'stock', 'dailyRate', 'coverDays', 'confidence'], link: 'product' }, { title: 'ناموجود', rows: outs.slice(0, 60), cols: ['sku', 'name', 'soldQty', 'lastSale'], link: 'product' }],
      action: risk.length || outs.length ? 'برای این کالاها از بخش «پیشنهاد سفارش» استفاده کنید؛ مقدار پیشنهادی تخمین است و باید با تجربه شما بازبینی شود.' : 'خطر اتمامی دیده نشد.' });

    // 4-5. tied capital & low-yield
    var withVal = list.filter(function (x) { return x.knownValue > 0; }).sort(function (a, b) { return b.knownValue - a.knownValue; });
    var invVal = sum(withVal, function (x) { return x.knownValue; }), unkQty = sum(list, function (x) { return x.unknownCostQty; });
    var lowYield = withVal.filter(function (x) { return x.knownValue >= invVal * 0.01 && (x.velocity === 'dead' || x.velocity === 'slow' || (x.margin != null && x.margin < 5)); });
    S({ id: 'capital', title: 'سرمایه خوابیده و کالاهای کم‌بازده', basis: 'بر اساس بهای خرید ثبت‌شده موجودی فعلی (روش FIFO) و فروش ' + win + ' روز گذشته.', sufficiency: unkQty ? 'limited' : 'enough',
      assumptions: ['ارزش فقط برای واحدهایی محاسبه شده که بهای خریدشان ثبت شده؛ ' + unkQty + ' واحد بدون بهای خرید در این جمع نیست.', 'کم‌بازده = بیش از ۱٪ سرمایه موجودی و (راکد یا کم‌فروش یا حاشیه سود کمتر از ۵٪).'],
      confidence: unkQty ? 'medium' : 'high',
      summary: [['ارزش موجودی (بهای معلوم)', invVal], ['واحدهای بدون بهای خرید', unkQty], ['۱۰ کالای اول، سهم از سرمایه', invVal ? round1(sum(withVal.slice(0, 10), function (x) { return x.knownValue; }) / invVal * 100) + '٪' : '—'], ['کالاهای کم‌بازده', lowYield.length]],
      tables: [{ title: 'بیشترین سرمایه', rows: withVal.slice(0, 20), cols: ['sku', 'name', 'stock', 'knownValue', 'velocity'], link: 'product' }, { title: 'کم‌بازده', rows: lowYield.slice(0, 30), cols: ['sku', 'name', 'knownValue', 'velocity', 'margin'], link: 'product' }],
      action: lowYield.length ? 'خرید کالاهای کم‌بازده را کم کنید و سرمایه را به کالاهای گروه A منتقل کنید.' : 'مورد خاصی دیده نشد.' });

    // 6. unknown cost
    var unk = list.filter(function (x) { return x.unknownCostQty > 0 || x.unknownLines > 0; }).sort(function (a, b) { return b.unknownLines - a.unknownLines || b.unknownCostQty - a.unknownCostQty; });
    var cover = gp.knownSales + gp.unknownSales > 0 ? round1(gp.knownSales / (gp.knownSales + gp.unknownSales) * 100) : 100;
    S({ id: 'unknowncost', title: 'کالاهای بدون بهای خرید / سود نامشخص', basis: 'بر اساس لایه‌های بهای خرید و فروش ' + win + ' روز گذشته.', sufficiency: 'enough',
      assumptions: ['سود هر ردیف فقط وقتی محاسبه می‌شود که بهای خرید همه واحدهای فروخته‌شده معلوم باشد.'], confidence: 'high',
      summary: [['پوشش محاسبه سود در بازه', cover + '٪ از فروش'], ['کالاهای دارای موجودی بدون بها', list.filter(function (x) { return x.unknownCostQty > 0; }).length], ['ردیف‌های فروش با سود نامشخص', gp.unknownLines]],
      tables: [{ title: 'نیازمند ثبت بهای خرید', rows: unk.slice(0, 60), cols: ['sku', 'name', 'unknownCostQty', 'unknownLines'], link: 'product' }],
      action: unk.length ? 'در ورود بعدی این کالاها قیمت خرید را وارد کنید؛ برای موجودی فعلی بدون بها می‌توانید با «اصلاح موجودی» و ذکر بها، واحدهای شمارش‌شده را دوباره ثبت کنید.' : 'سود همه فروش‌ها قابل محاسبه است.' });

    // 7. sales trend by Jalali month (net incl. returns) + period comparison
    var J = root.Jalali, months = {}, order = [];
    lines.forEach(function (r) {
      var j = J ? J.fromMs(r.ts) : [new Date(r.ts).getFullYear(), new Date(r.ts).getMonth() + 1], key = j[0] + '/' + (j[1] < 10 ? '0' : '') + j[1];
      if (!months[key]) { months[key] = { month: key, net: 0, known: 0, profit: 0, invoices: {} }; order.push(key); }
      months[key].net += r.net; if (r.kind === 'sale') months[key].invoices[r.docId] = 1;
    });
    E.grossProfit({}).rows.forEach(function (r) { if (r.profit == null) return; var j = J ? J.fromMs(r.ts) : [0, 0], key = j[0] + '/' + (j[1] < 10 ? '0' : '') + j[1]; if (months[key]) { months[key].profit += r.profit; months[key].known += r.net; } });
    order.sort();
    var trend = order.slice(-12).map(function (k) { var m = months[k]; return { month: m.month, net: m.net, profit: m.profit, knownShare: m.net ? round1(m.known / m.net * 100) : null, invoices: Object.keys(m.invoices).length }; });
    var last30 = sum(lines.filter(function (r) { return r.ts > now - 30 * DAY; }), function (r) { return r.net; }), prev30 = sum(lines.filter(function (r) { return r.ts <= now - 30 * DAY && r.ts > now - 60 * DAY; }), function (r) { return r.net; });
    var chg = prev30 > 0 ? round1((last30 - prev30) / prev30 * 100) : null;
    S({ id: 'trend', title: 'روند فروش و مقایسه دوره‌ها', basis: 'بر اساس همه فاکتورها و مرجوعی‌ها به تفکیک ماه شمسی.', sufficiency: spanDays >= 60 ? 'enough' : spanDays >= 30 ? 'limited' : 'insufficient',
      assumptions: ['فروش خالص = پس از تخفیف‌ها و مرجوعی‌ها؛ فاکتورهای لغوشده حذف شده‌اند.', 'سود ماهانه فقط از ردیف‌های با بهای معلوم است.'], confidence: spanDays >= 60 ? 'high' : 'low',
      summary: [['فروش ۳۰ روز اخیر', last30], ['۳۰ روز قبل از آن', prev30], ['تغییر', chg == null ? 'داده دوره قبل نیست' : chg === 0 ? 'بدون تغییر' : Math.abs(chg) + '٪ ' + (chg > 0 ? 'افزایش' : 'کاهش')]],
      chart: trend, tables: [{ title: 'ماهانه', rows: trend, cols: ['month', 'invoices', 'net', 'profit', 'knownShare'] }],
      action: chg != null && chg < -15 ? 'فروش نسبت به دوره قبل افت محسوسی دارد؛ کالاهای گروه A و مشتریان اصلی را بررسی کنید.' : 'روند را ماهانه دنبال کنید.' });

    // 8. customers
    var C = {};
    invoicesAll.forEach(function (d) { var x = C[d.customerId] || (C[d.customerId] = { id: d.customerId, invoices: 0, invWin: 0, net: 0, netWin: 0, last: 0 }); var net = d.total - (d.returned || 0); x.invoices++; x.net += net; if (d.ts >= from) { x.invWin++; x.netWin += net; } if (d.ts > x.last) x.last = d.ts; });
    var bal = E.customerBalances();
    var crows = Object.keys(C).map(function (k) { var c = E.state.customers[k] || {}; var x = C[k]; return { id: k, name: c.name || '', type: c.type || '', invoices: x.invoices, invWin: x.invWin, net: x.net, netWin: x.netWin, avg: x.invoices ? Math.round(x.net / x.invoices) : 0, last: x.last, daysSince: Math.floor((now - x.last) / DAY), balance: bal[k] || 0 }; })
      .sort(function (a, b) { return b.netWin - a.netWin || b.net - a.net; });
    var active = crows.filter(function (x) { return x.invWin > 0; }), repeat = active.filter(function (x) { return x.invWin >= 2; });
    var lapsed = crows.filter(function (x) { return x.invoices >= 3 && x.daysSince > Math.max(60, win); });
    S({ id: 'customers', title: 'تحلیل مشتریان', basis: 'بر اساس ' + invoicesAll.length + ' فاکتور معتبر از ' + crows.length + ' مشتری.', sufficiency: invoicesAll.length >= 50 ? 'enough' : invoicesAll.length >= 15 ? 'limited' : 'insufficient',
      assumptions: ['مشتری فعال = در ' + win + ' روز گذشته خرید داشته.', 'مشتری قطع‌شده = حداقل ۳ خرید قبلی و بیش از ' + Math.max(60, win) + ' روز بدون خرید.'],
      confidence: invoicesAll.length >= 50 ? 'medium' : 'low',
      summary: [['مشتریان فعال', active.length], ['خرید تکراری در بازه', active.length ? round1(repeat.length / active.length * 100) + '٪' : '—'], ['میانگین مبلغ فاکتور', invoicesAll.length ? Math.round(sum(invoicesAll, function (d) { return d.total - (d.returned || 0); }) / invoicesAll.length) : 0], ['مشتریان قطع‌شده', lapsed.length]],
      tables: [{ title: 'مشتریان برتر بازه', rows: crows.slice(0, 15), cols: ['name', 'invWin', 'netWin', 'avg', 'balance'], link: 'customer' }, { title: 'قطع‌شده (پیگیری کنید)', rows: lapsed.slice(0, 30), cols: ['name', 'invoices', 'net', 'daysSince'], link: 'customer' }],
      action: lapsed.length ? 'با مشتریان قطع‌شده تماس بگیرید؛ این‌ها قبلاً مشتری ثابت بوده‌اند.' : 'مشتری قطع‌شده‌ای دیده نشد.' });

    // 9. anomalies
    var anomalies = [];
    var hc = E.healthCheck();
    if (hc.critical) anomalies.push({ type: 'سلامت داده', detail: hc.critical + ' مشکل جدی در بررسی سلامت', ref: null });
    winLines.forEach(function (r) { if (r.kind === 'sale' && r.profit != null && r.profit < 0) anomalies.push({ type: 'فروش زیر قیمت خرید', detail: r.invoiceNo + ' — ' + r.name + ' (زیان ' + g(-r.profit) + ' تومان)', ref: r.docId }); });
    invWin.forEach(function (d) {
      var gross = sum(d.lines, function (l) { return l.qty * l.unitPrice; }), disc = gross - d.total;
      if (gross > 0 && disc / gross > 0.2) anomalies.push({ type: 'تخفیف زیاد', detail: d.invoiceNo + ' — ' + round1(disc / gross * 100) + '٪', ref: d.id });
      if (d.balance > 0 && ((d.dueDate && d.dueDate < today) || (!d.dueDate && now - d.ts > 60 * DAY))) anomalies.push({ type: 'بدهی معوق', detail: d.invoiceNo + ' — مانده ' + g(d.balance) + ' تومان', ref: d.id });
    });
    docs.forEach(function (d) {
      if (d.ts >= from && d.createdAt && d.ts < d.createdAt - 3 * DAY) anomalies.push({ type: 'سند با تاریخ گذشته', detail: d.no + ' ' + Math.round((d.createdAt - d.ts) / DAY) + ' روز عقب‌تر از ثبت', ref: d.id });
      if (d.kind === 'adjust' && d.ts >= from) { var l = d.lines[0], p = E.state.products[l.productId], c = p ? E.avgCost(p) : null; if (Math.abs(l.qty) >= 10 || (c && Math.abs(l.qty) * c >= 10000000)) anomalies.push({ type: 'اصلاح موجودی بزرگ', detail: d.no + ' — ' + l.name + ' — ' + (l.qty > 0 ? 'افزایش ' : 'کاهش ') + Math.abs(l.qty) + ' واحد (علت: ' + d.reason + ')', ref: d.id }); }
    });
    var revs = docs.filter(function (d) { return d.kind === 'out' && d.type === 'sale' && d.status === 'reversed' && d.ts >= from; }).length, rets = docs.filter(function (d) { return d.kind === 'return' && d.status !== 'reversed' && d.ts >= from; }).length;
    if (invWin.length >= 10 && (revs + rets) / invWin.length > 0.1) anomalies.push({ type: 'لغو/مرجوعی زیاد', detail: (revs + rets) + ' مورد در ' + invWin.length + ' فاکتور', ref: null });
    S({ id: 'anomalies', title: 'مغایرت‌ها و موارد غیرعادی', basis: 'بررسی خودکار همه اسناد ' + win + ' روز گذشته و سلامت داده‌ها.', sufficiency: 'enough',
      assumptions: ['تخفیف زیاد: بیش از ۲۰٪ مبلغ قبل از تخفیف.', 'بدهی معوق: سررسید گذشته، یا بدون سررسید و بیش از ۶۰ روز.', 'اصلاح بزرگ: ۱۰ واحد یا بیشتر یا بیش از ۱۰ میلیون تومان.'],
      confidence: 'high', summary: [['تعداد موارد', anomalies.length]], tables: [{ title: 'موارد', rows: anomalies.slice(0, 100), cols: ['type', 'detail'], link: 'doc', idKey: 'ref' }],
      action: anomalies.length ? 'هر مورد را باز و بررسی کنید؛ این فهرست فقط هشدار است و چیزی را تغییر نمی‌دهد.' : 'مورد غیرعادی دیده نشد.' });

    // 10. reorder suggestions
    var reorder = list.filter(function (x) { return x.active && x.reorderQty > 0 && (x.atRisk || x.out || x.reorderBasis === 'minStock'); })
      .sort(function (a, b) { return (a.coverDays == null ? 1e9 : a.coverDays) - (b.coverDays == null ? 1e9 : b.coverDays); });
    S({ id: 'reorder', title: 'پیشنهاد سفارش مجدد', basis: basis, sufficiency: suff,
      assumptions: ['مقدار = سرعت فروش × (زمان تأمین ' + lead + ' روز + موجودی هدف ' + coverT + ' روز) − موجودی فعلی.', 'برای کالای بدون فروش فقط اگر زیر حداقل موجودی باشد، تا دو برابر حداقل پیشنهاد می‌شود.', 'فصلی بودن، تخفیف تأمین‌کننده و حداقل سفارش لحاظ نشده است.', CONF_RULE],
      confidence: suff === 'enough' ? 'medium' : 'low',
      summary: [['کالاهای پیشنهادی', reorder.length]], tables: [{ title: 'پیشنهاد', rows: reorder.slice(0, 100), cols: ['sku', 'name', 'stock', 'dailyRate', 'coverDays', 'reorderQty', 'confidence'], link: 'product' }],
      action: reorder.length ? 'پیشنهادها را با تجربه خود و قیمت روز بازار تطبیق دهید؛ اطمینان هر ردیف کنار آن آمده است.' : 'فعلاً کالایی نیاز به سفارش ندارد.' });

    // 11. profitability by brand / group / customer
    function groupBy(keyFn, labelFn) {
      var g = {};
      winLines.forEach(function (r) {
        var k = keyFn(r); if (k == null) k = ''; var x = g[k] || (g[k] = { key: k, label: labelFn(k, r), net: 0, known: 0, cost: 0, profit: 0 });
        x.net += r.net; if (r.profit != null) { x.known += r.net; x.cost += r.cost; x.profit += r.profit; }
      });
      return Object.keys(g).map(function (k) { var x = g[k]; x.margin = x.known > 0 ? round1(x.profit / x.known * 100) : null; x.coverage = x.net > 0 ? round1(x.known / x.net * 100) : null; return x; }).sort(function (a, b) { return b.profit - a.profit; });
    }
    var pcat = function (r) { var p = E.state.products[r.productId]; return p ? p.categoryId || '' : ''; };
    var byBrand = groupBy(function (r) { return r.brand || ''; }, function (k) { return k || '(بدون برند)'; });
    var byCat = groupBy(pcat, function (k) { return k ? E.categoryPath(k).join(' › ') : '(بدون گروه)'; });
    var byCust = groupBy(function (r) { return r.customerId; }, function (k, r) { return r.customer || k; });
    var byProd = groupBy(function (r) { return r.productId; }, function (k, r) { return r.name; });
    S({ id: 'profit', title: 'سودآوری بر اساس کالا، برند، گروه و مشتری', basis: 'بر اساس ' + gp.knownLines + ' ردیف فروش با بهای معلوم در ' + win + ' روز گذشته.', sufficiency: cover >= 90 ? 'enough' : cover >= 60 ? 'limited' : 'insufficient',
      assumptions: ['فقط ردیف‌های با بهای خرید معلوم در سود حساب شده‌اند؛ ستون «پوشش» نشان می‌دهد چه سهمی از فروش هر گروه قابل محاسبه بوده است.'], confidence: cover >= 90 ? 'high' : cover >= 60 ? 'medium' : 'low',
      summary: [['سود ناخالص معلوم', gp.profit], ['پوشش', cover + '٪']],
      tables: [{ title: 'برند', rows: byBrand, cols: ['label', 'net', 'profit', 'margin', 'coverage'] }, { title: 'گروه کالا', rows: byCat, cols: ['label', 'net', 'profit', 'margin', 'coverage'] },
        { title: 'مشتری', rows: byCust.slice(0, 30), cols: ['label', 'net', 'profit', 'margin', 'coverage'], link: 'customer', idKey: 'key' }, { title: 'کالا', rows: byProd.slice(0, 30), cols: ['label', 'net', 'profit', 'margin', 'coverage'], link: 'product', idKey: 'key' }],
      action: 'برای گروه‌ها/کالاهای کم‌حاشیه قیمت یا تأمین‌کننده را بازبینی کنید؛ ابتدا پوشش بهای خرید را بالا ببرید تا نتیجه قابل اتکا شود.' });

    // 12. improvement opportunities (rule-based)
    var ops = [], deadVal = sum(dead, function (x) { return x.knownValue; });
    if (deadVal > 0) ops.push({ title: 'آزادسازی سرمایه راکد', detail: 'حدود ' + g(deadVal) + ' تومان (بهای معلوم) در ' + dead.length + ' کالای راکد خوابیده است.', impact: 'نقدینگی' });
    if (cover < 90) ops.push({ title: 'ثبت بهای خرید', detail: 'فقط ' + cover + '٪ فروش سود قابل محاسبه دارد.', impact: 'دقت تصمیم‌گیری' });
    var lowM = byProd.filter(function (x) { return x.margin != null && x.margin < 5 && x.net > 0; });
    if (lowM.length) ops.push({ title: 'بازبینی قیمت کالاهای کم‌حاشیه', detail: lowM.length + ' کالا حاشیه سود کمتر از ۵٪ دارند.', impact: 'سود' });
    var od = sum(anomalies.filter(function (a) { return a.type === 'بدهی معوق'; }).map(function (a) { return E.state.docs[a.ref] ? E.state.docs[a.ref].balance : 0; }));
    if (od > 0) ops.push({ title: 'وصول مطالبات معوق', detail: g(od) + ' تومان از فاکتورهای معوق دریافت نشده است.', impact: 'نقدینگی' });
    var discTot = sum(invWin, function (d) { return sum(d.lines, function (l) { return l.qty * l.unitPrice; }) - d.total; }), grossTot = sum(invWin, function (d) { return sum(d.lines, function (l) { return l.qty * l.unitPrice; }); });
    if (grossTot > 0 && discTot / grossTot > 0.05) ops.push({ title: 'کنترل تخفیف', detail: round1(discTot / grossTot * 100) + '٪ از مبلغ فروش تخفیف داده شده است.', impact: 'سود' });
    if (risk.length) ops.push({ title: 'جلوگیری از فروش ازدست‌رفته', detail: risk.length + ' کالا در خطر اتمام است.', impact: 'درآمد' });
    S({ id: 'opportunities', title: 'فرصت‌های بهبود', basis: 'جمع‌بندی بخش‌های بالا با قواعد ساده و شفاف.', sufficiency: suff, assumptions: ['این پیشنهادها قاعده‌محورند و جایگزین قضاوت شما نیستند.'],
      confidence: suff === 'enough' ? 'medium' : 'low', summary: [['تعداد پیشنهاد', ops.length]], tables: [{ title: 'پیشنهادها', rows: ops, cols: ['title', 'detail', 'impact'] }],
      action: ops.length ? 'از بالاترین اثر روی نقدینگی شروع کنید.' : 'پیشنهاد خاصی نیست.' });

    return { params: { now: now, windowDays: win, leadDays: lead, coverDays: coverT, from: from }, sufficiency: suff, spanDays: spanDays, invoices: invWin.length, products: list, byId: P, sections: sections, LEVEL: LEVEL, SUFF: SUFF };
  }

  // Column labels/types for section tables (shared by screen, Excel and PDF).
  var COLS = {
    sku: ['کد', 'text', 1.1], name: ['کالا', 'text', 2.6], label: ['عنوان', 'text', 2.4], soldQty: ['تعداد فروش', 'qty', 0.8], soldNet: ['فروش خالص', 'money', 1.1],
    abc: ['گروه ABC', 'text', 0.6], stock: ['موجودی', 'qty', 0.8], knownValue: ['ارزش (بهای معلوم)', 'money', 1.2], lastMove: ['آخرین گردش', 'date', 1], lastSale: ['آخرین فروش', 'date', 1],
    dailyRate: ['فروش روزانه', 'rate', 0.8], coverDays: ['روز پوشش', 'qty', 0.8], confidence: ['اطمینان', 'level', 0.8], velocity: ['وضعیت فروش', 'velocity', 0.9],
    margin: ['حاشیه سود', 'pct', 0.8], unknownCostQty: ['واحد بدون بها', 'qty', 0.9], unknownLines: ['فروش با سود نامشخص', 'qty', 0.9],
    month: ['ماه', 'text', 0.8], invoices: ['فاکتور', 'qty', 0.7], net: ['فروش خالص', 'money', 1.1], profit: ['سود معلوم', 'money', 1.1], knownShare: ['پوشش سود', 'pct', 0.8],
    invWin: ['فاکتور در بازه', 'qty', 0.8], netWin: ['خرید در بازه', 'money', 1.1], avg: ['میانگین فاکتور', 'money', 1], balance: ['مانده', 'money', 1], daysSince: ['روز از آخرین خرید', 'qty', 0.9],
    type: ['نوع', 'text', 1.2], detail: ['شرح', 'text', 3], reorderQty: ['پیشنهاد سفارش', 'qty', 0.9], coverage: ['پوشش', 'pct', 0.7], title: ['عنوان', 'text', 1.6], impact: ['اثر', 'text', 0.8]
  };
  var VELOCITY = { top: 'پرفروش', normal: 'عادی', slow: 'کم‌فروش', dead: 'راکد', new: 'جدید', none: 'بدون موجودی و فروش' };

  var api = { compute: compute, LEVEL: LEVEL, SUFF: SUFF, COLS: COLS, VELOCITY: VELOCITY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Analytics = api;
})(typeof self !== 'undefined' ? self : this);
