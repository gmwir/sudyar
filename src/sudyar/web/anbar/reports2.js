/* v2.11 reports added without touching reports.js (registered into Reports.DEFS):
   - «فروش و سود کالا (انبار + مستقیم)»: per product, warehouse sales (salesLines, FIFO cost) and direct sales (dealsItemPL, average cost of the deal's
     purchases) side by side and summed. Each sale is counted ONCE: a combined invoice's warehouse part is a sale document, its direct part a deal.
     A direct row joins a product only by its stored productId or an EXACT SKU match — never by a guessed name.
   - «سود و زیان کل (انبار + مستقیم)»: Core.profitLoss in rows.
   - «باطل‌شده‌ها»: cancelled invoices / deal rows / account entries, listed apart (they net to zero and are not in the other totals). */
(function (root) {
  'use strict';
  var R = root.Reports, Core = root.Core; if (!R || !Core) return;
  var D = R.DEFS;
  function C(key, label, type, w, extra) { return Object.assign({ key: key, label: label, type: type || 'text', w: w || 1 }, extra || {}); }
  function sumK(rows, k) { var s = 0; for (var i = 0; i < rows.length; i++) s += rows[i][k] || 0; return s; }
  function def(id, o) { o.id = id; D[id] = o; }

  function itemRows(ctx, p) {
    var E = ctx.E, S = ctx.S, f = { from: p.from, to: p.to }, out = [], bySku = {};
    Object.keys(S.products).forEach(function (id) { var k = Core.normSku(S.products[id].sku || ''); if (k) bySku[k] = id; });
    E.salesLines(f).forEach(function (r) { // warehouse: sales, returns, cancellations in another period (same rules as the profit report)
      out.push({ src: 'stock', productId: r.productId, sku: r.sku, name: r.name, brand: r.brand, qty: r.qty, net: r.net, profit: r.costTotal == null ? null : r.net - r.costTotal, customerId: r.customerId, customer: r.customer });
    });
    (E.dealsItemPL ? E.dealsItemPL(f) : []).forEach(function (r) {
      var pid = r.productId && S.products[r.productId] ? r.productId : (r.code && bySku[Core.normSku(r.code)]) || null, pr = pid ? S.products[pid] : null;
      out.push({ src: 'direct', productId: pid, key: pid ? null : r.key, sku: pr ? pr.sku : r.code, name: pr ? pr.name : r.name, brand: pr ? pr.brand : '', qty: r.qty, net: r.income, profit: r.profit, dealId: r.dealId });
    });
    return out;
  }
  def('itemsall', { title: 'فروش و سود کالا (انبار + مستقیم)', group: 'فروش و سود', range: true, rangeInSource: true, link: 'product', landscape: true,
    filters: ['q', 'product', 'category', 'brand', 'car'], groupFilters: ['qty', 'amount'], amountKey: 'net', amountLabel: 'فروش کل', qtyLabel: 'تعداد کل',
    source: itemRows,
    aggregate: function (rows) {
      var m = {};
      rows.forEach(function (r) {
        var k = r.productId || 'x:' + r.key, x = m[k] || (m[k] = { id: r.productId || null, productId: r.productId || null, sku: r.sku || '', name: r.name + (r.productId ? '' : ' (تعریف‌نشده)'), brand: r.brand || '',
          stockQty: 0, directQty: 0, qty: 0, stockNet: 0, directNet: 0, net: 0, stockProfit: 0, directProfit: 0, profit: 0, unknown: 0 });
        x.qty += r.qty; x.net += r.net;
        if (r.src === 'stock') { x.stockQty += r.qty; x.stockNet += r.net; } else { x.directQty += r.qty; x.directNet += r.net; }
        if (r.profit == null) { x.unknown++; return; }
        x.profit += r.profit; if (r.src === 'stock') x.stockProfit += r.profit; else x.directProfit += r.profit;
      });
      return Object.keys(m).map(function (k) { var x = m[k]; x.flag = x.unknown ? 'سود بخشی نامعلوم' : ''; return x; });
    },
    defaultSort: { key: 'qty', dir: -1 },
    columns: [C('sku', 'کد', 'text', 1), C('name', 'کالا', 'text', 2.6, { wrap: true }), C('stockQty', 'تعداد انبار', 'qty', 0.7, { sum: true }), C('directQty', 'تعداد مستقیم', 'qty', 0.7, { sum: true }),
      C('qty', 'تعداد کل', 'qty', 0.7, { sum: true }), C('stockNet', 'فروش انبار', 'money', 1, { sum: true }), C('directNet', 'فروش مستقیم', 'money', 1, { sum: true }), C('net', 'فروش کل', 'money', 1, { sum: true }),
      C('stockProfit', 'سود انبار (معلوم)', 'money', 1, { sum: true, partial: true }), C('directProfit', 'سود مستقیم (قطعی)', 'money', 1, { sum: true, partial: true }), C('profit', 'سود کل', 'money', 1, { sum: true, partial: true }),
      C('flag', 'توضیح', 'text', 0.9)],
    summary: function (rows, ctx, p) {
      var dl = ctx.E.dealsPL({ from: p.from, to: p.to }), ip = sumK(rows, 'profit');
      return [['تعداد کل فروخته‌شده (خالص)', sumK(rows, 'qty'), 'qty'], ['از انبار', sumK(rows, 'stockQty'), 'qty'], ['مستقیم (خارج از انبار)', sumK(rows, 'directQty'), 'qty'],
        ['فروش کل', sumK(rows, 'net'), 'money'], ['سود اقلام (معلوم + قطعی)', ip, 'money'],
        ['هزینه‌های مستقیم معاملات در بازه (به کالا تخصیص نمی‌یابد)', dl.direct, 'money'], ['سود پس از هزینه‌های مستقیم', ip - dl.direct, 'money'],
        ['ردیف‌های با سود نامعلوم', rows.filter(function (r) { return r.unknown; }).length, 'qty']];
    },
    note: 'هر فروش فقط یک بار شمرده می‌شود: بخش انبار فاکتور ترکیبی سند فروش است و بخش مستقیم آن معامله. فروش مستقیم فقط با کالای انتخاب‌شده یا کد کالای دقیقاً برابر به کالای تعریف‌شده وصل می‌شود؛ بقیه با «(تعریف‌نشده)» جدا می‌آیند. سود مستقیم با میانگین بهای خرید همان معامله؛ معامله‌ای که خریدش ثبت نشده «سود نامعلوم» است. فاکتور و ردیفی که در همین بازه ثبت و باطل شده در جمع‌ها نیست. هزینه‌های مستقیم (حمل، پیک…) در سطح معامله‌اند، نه کالا.' });

  def('plall', { title: 'سود و زیان کل (انبار + مستقیم)', group: 'فروش و سود', range: true, rangeInSource: true,
    filters: [],
    source: function (ctx, p) {
      var pl = ctx.E.profitLoss({ from: p.from, to: p.to }), d = pl.deals, st = pl.stock;
      return [
        { label: 'فروش کالای انبار (خالص)', amount: st.sales }, { label: 'سود ناخالص کالای انبار (اقلام با بهای معلوم)', amount: st.profit },
        { label: 'فروش مستقیم (خالص، سود قطعی)', amount: d.income }, { label: 'بهای کالای فروش‌رفته مستقیم', amount: -d.cogs }, { label: 'هزینه‌های مستقیم فروش', amount: -d.direct },
        { label: 'سود معاملات مستقیم', amount: d.profit }, { label: 'سود کل', amount: pl.total, grand: true },
        { label: 'فروش مستقیم با سود نامشخص (در سود بالا نیست)', amount: d.uncertainIncome }];
    },
    columns: [C('label', 'شرح', 'text', 4, { wrap: true }), C('amount', 'مبلغ (تومان)', 'money', 1.4)],
    summary: function (rows, ctx, p) { var pl = ctx.E.profitLoss({ from: p.from, to: p.to }); return [['سود کل', pl.total, 'money'], ['کامل بودن محاسبه', pl.complete ? 'کامل' : 'ناقص (بهای بعضی اقلام یا خرید بعضی معاملات ثبت نشده)']]; },
    note: 'جریان نقد جداست: مبلغ دریافت‌نشده سود هست ولی نقد نیست. فاکتور و معامله‌ای که در همین بازه ثبت و باطل شده، اثری ندارد.' });

  var VK = { sale: 'فاکتور فروش انبار', mix: 'فاکتور ترکیبی', leg: 'ردیف معامله مستقیم', ledger: 'تراکنش حساب', in: 'سند ورود کالا', return: 'مرجوعی' };
  def('voided', { title: 'باطل‌شده‌ها (فاکتور، معامله، تراکنش)', group: 'مالی و مشتری', range: true, link: 'doc', landscape: true,
    filters: ['q', 'customer'],
    source: function (ctx) {
      var E = ctx.E, S = ctx.S, out = [], seenMix = {};
      function pn(t, id) { var x = id && S[t === 'supplier' ? 'suppliers' : 'customers'][id]; return x ? x.name : ''; }
      Object.keys(S.docs).forEach(function (k) {
        var d = S.docs[k]; if (d.status !== 'reversed' || ['out', 'in', 'return'].indexOf(d.kind) < 0) return;
        var w = E.mixedView ? E.mixedView(d.id) : null;
        if (w) { if (seenMix[w.anchor]) return; seenMix[w.anchor] = 1; out.push({ ts: w.ts, kind: VK.mix, no: w.invoiceNo + (w.orderId ? ' / سفارش ' + w.orderId : ''), party: w.customer ? w.customer.name : '', customerId: w.customer ? w.customer.id : null, amount: w.total, revTs: E.revTs(d), reason: d.reverseReason || '', docId: d.id }); return; }
        out.push({ ts: d.ts, kind: d.kind === 'out' ? (d.type === 'sale' ? VK.sale : 'خروج ' + (Core.ISSUE_TYPES && Core.ISSUE_TYPES[d.type] || '')) : VK[d.kind], no: d.invoiceNo || d.no,
          party: d.customerId ? pn('customer', d.customerId) : pn('supplier', d.supplierId), customerId: d.customerId || null, amount: d.total || null, revTs: E.revTs(d), reason: d.reverseReason || '', docId: d.id });
      });
      Object.keys(S.deals).forEach(function (k) {
        var x = S.deals[k]; if (x.rt !== 'leg' || x.type !== 'cancel') return;
        var o = S.deals[x.refLegId]; if (!o) return;
        var w = E.mixedView ? E.mixedView(o.id) : null;
        if (w) { if (seenMix[w.anchor]) return; seenMix[w.anchor] = 1; out.push({ ts: w.ts, kind: VK.mix, no: w.invoiceNo + (w.orderId ? ' / سفارش ' + w.orderId : ''), party: w.customer ? w.customer.name : '', customerId: w.customer ? w.customer.id : null, amount: w.total, revTs: x.ts, reason: x.reason || '' }); return; }
        out.push({ ts: o.ts, kind: VK.leg + (o.type === 'return' ? ' (برگشت)' : o.side === 'sell' ? ' (فروش)' : ' (خرید)'), no: (o.invoiceNo ? o.invoiceNo + ' / ' : '') + o.no, party: pn(o.partyType, o.partyId),
          customerId: o.partyType === 'customer' ? o.partyId : null, amount: o.type === 'return' ? o.net : o.payable, revTs: x.ts, reason: x.reason || '', dealId: o.dealId });
      });
      Object.keys(S.ledger).forEach(function (k) {
        var x = S.ledger[k]; if (x.kind !== 'reversal') return; var o = S.ledger[x.reverses]; if (!o || o.auto) return; // automatic entries of a leg/doc are shown with it
        out.push({ ts: o.ts, kind: VK.ledger + ' — ' + ((E.LG_KINDS || {})[o.kind] || o.kind), no: o.no, party: pn(o.partyType, o.partyId), customerId: o.partyType === 'customer' ? o.partyId : null,
          amount: o.amount, revTs: x.ts, reason: x.note || '' });
      });
      return out;
    },
    defaultSort: { key: 'ts', dir: -1 },
    columns: [C('ts', 'تاریخ سند', 'date', 0.9), C('revTs', 'تاریخ ابطال', 'date', 0.9), C('kind', 'نوع', 'text', 1.4, { wrap: true }), C('no', 'شماره', 'text', 1.2, { wrap: true }),
      C('party', 'طرف حساب', 'text', 1.4, { wrap: true }), C('amount', 'مبلغ سند', 'money', 1), C('reason', 'علت', 'text', 1.6, { wrap: true })],
    summary: function (rows) { return [['تعداد', rows.length, 'qty']]; },
    note: 'این اقلام با سند ابطال خنثی شده‌اند (چیزی حذف نشده) و در گزارش‌های فروش، سود و صورت‌حساب در جمع‌ها نیستند. مبلغ سند فقط برای اطلاع است و جمع زده نمی‌شود. پرداخت واقعیِ انجام‌شده روی سند باطل‌شده در گردش مالی و صورت‌حساب سر جای خودش می‌ماند.' });
})(typeof self !== 'undefined' ? self : this);
