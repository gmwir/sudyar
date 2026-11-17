/* v2.13.1 «خلاصه ماه کسب‌وکار»: at the end of each Jalali month the app says, in sentences, what earned most — e.g. «پرسودترین کالای
   این ماه: لنت پارس — ۱۰ عدد، سود …» — from the SAME figures as the report «فروش و سود کالا (انبار + مستقیم)» (warehouse FIFO cost +
   definite direct-deal profit). Items whose cost is unknown are named and never counted as profit. PDF and CSV. */
(function (root) {
  'use strict';
  var J = root.Jalali, FA = '۰۱۲۳۴۵۶۷۸۹';
  function fa(s) { return String(s == null ? '' : s).replace(/\d/g, function (d) { return FA[d]; }); }
  function money(n) { var neg = n < 0, s = String(Math.abs(Math.round(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '٬'); return fa((neg ? '−' : '') + s); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function bounds(y, m) {
    var from = J.parse(y + '/' + pad(m) + '/01'), ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1, next = J.parse(ny + '/' + pad(nm) + '/01');
    return { from: from, to: next - 1, fromS: J.fmt(from), toS: J.fmt(next - 1), label: J.MONTHS ? J.MONTHS[m - 1] + ' ' + fa(y) : fa(y + '/' + pad(m)) };
  }
  function prevYm(y, m) { return m === 1 ? [y - 1, 12] : [y, m - 1]; }
  function items(E, R, b) {
    var r = R.run(E, 'itemsall', { preset: 'custom', from: b.fromS, to: b.toS });
    return r.rows.filter(function (x) { return x.qty > 0 || x.net; });
  }
  function summary(E, R, y, m) {
    var b = bounds(y, m), rows = items(E, R, b), py = prevYm(y, m), pb = bounds(py[0], py[1]), prow = items(E, R, pb);
    var known = rows.filter(function (x) { return !x.unknown; }), sales = 0, profit = 0, pprofit = 0;
    rows.forEach(function (x) { sales += x.net; profit += x.profit || 0; }); prow.forEach(function (x) { pprofit += x.profit || 0; });
    var byProfit = known.slice().sort(function (a, c) { return c.profit - a.profit; }), byQty = rows.slice().sort(function (a, c) { return c.qty - a.qty; });
    var loss = known.filter(function (x) { return x.profit < 0; }), unknown = rows.filter(function (x) { return x.unknown; });
    var S = [];
    if (!rows.length) S.push('در ' + b.label + ' فروشی ثبت نشده است.');
    else {
      var t = byProfit[0];
      if (t) S.push('پرسودترین کالای ' + b.label + ': «' + t.name + '» — ' + fa(t.qty) + ' عدد فروش، ' + money(t.net) + ' تومان فروش و ' + money(t.profit) + ' تومان سود' + (profit > 0 ? ' (' + fa(Math.round(t.profit * 100 / profit)) + '٪ سود کل ماه)' : '') + '.');
      if (byProfit[1]) S.push('بعدی‌ها: ' + byProfit.slice(1, 4).map(function (x) { return '«' + x.name + '» ' + money(x.profit); }).join('، ') + ' تومان سود.');
      if (byQty[0] && (!t || byQty[0].name !== t.name)) S.push('پرفروش‌ترین (تعداد): «' + byQty[0].name + '» — ' + fa(byQty[0].qty) + ' عدد.');
      S.push('جمع ماه: فروش ' + money(sales) + ' تومان، سود معلوم ' + money(profit) + ' تومان' + (pprofit ? ' (' + (profit >= pprofit ? '+' : '−') + fa(Math.abs(Math.round((profit - pprofit) * 100 / Math.abs(pprofit)))) + '٪ نسبت به ' + pb.label + ')' : '') + '.');
      if (loss.length) S.push('زیان‌ده: ' + loss.slice(0, 3).map(function (x) { return '«' + x.name + '» ' + money(x.profit); }).join('، ') + ' تومان — قیمت فروش این‌ها را بررسی کنید.');
      if (unknown.length) S.push(fa(unknown.length) + ' کالا بهای خرید کامل ندارد و سودش حساب نشده (مثلاً «' + unknown[0].name + '»)؛ از «تکمیل بهای خرید» ثبت کنید.');
    }
    return { y: y, m: m, label: b.label, prevLabel: pb.label, rows: rows, byProfit: byProfit, byQty: byQty, loss: loss, unknown: unknown, sales: sales, profit: profit, prevProfit: pprofit, sentences: S };
  }
  function csv(s) {
    return [['کالا', 'کد', 'تعداد', 'فروش (تومان)', 'سود (تومان)', 'توضیح']].concat(s.byQty.map(function (x) { return [x.name, x.sku || '', x.qty, x.net, x.unknown ? '' : x.profit, x.unknown ? 'سود نامعلوم' : '']; }),
      [[]], s.sentences.map(function (t) { return [t]; }));
  }
  var core = { bounds: bounds, summary: summary, csv: csv };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }
  root.BizMonth = core;
  if (!root.App) return;

  var A = root.App, E = A.E, UI = root.UI, h = UI.h, view = document.getElementById('view');
  function ymNow() { var j = J.fromMs(Date.now()); return [j[0], j[1]]; }
  A.routes.month = function (arg, q) {
    var now = ymNow(), y = q && +q.y || now[0], m = q && +q.m || now[1], p = prevYm(y, m), n = m === 12 ? [y + 1, 1] : [y, m + 1];
    A.setTitle('خلاصه ماه کسب‌وکار', true);
    var s = summary(E, root.Reports, y, m);
    view.appendChild(h('div.card', h('div.row', { style: { justifyContent: 'space-between', alignItems: 'center' } },
      h('a.btn.sm', { href: '#/month?y=' + p[0] + '&m=' + p[1] }, '‹ ماه قبل'), h('b', s.label),
      (y < now[0] || (y === now[0] && m < now[1])) ? h('a.btn.sm', { href: '#/month?y=' + n[0] + '&m=' + n[1] }, 'ماه بعد ›') : h('span'))));
    view.appendChild(h('div.card', h('ul', s.sentences.map(function (t) { return h('li', { style: { marginBottom: '6px' } }, t); })),
      h('div.row', h('button.btn.sm', { onclick: function () { UI.fileSheet(window.XLSX.writeCsv(csv(s)), 'month-' + y + '-' + m + '.csv', 'text/csv'); } }, 'CSV'),
        h('button.btn.sm.primary', { onclick: function () { pdf(s); } }, 'PDF'),
        h('a.btn.sm', { href: '#/report/itemsall' }, 'گزارش کامل با فیلتر'))));
    view.appendChild(h('div.sec-title', 'پرسودترین کالاها'));
    view.appendChild(h('div.list', s.byProfit.slice(0, 15).map(function (x) {
      return h(x.productId ? 'a.li' : 'div.li', x.productId ? { href: '#/product/' + x.productId } : null, h('div.grow', h('div.t', x.name), h('div.s', UI.fa(x.qty) + ' عدد · فروش ' + UI.money(x.net))), h('b', { style: { color: x.profit < 0 ? 'var(--bad)' : 'var(--ok)' } }, UI.money(x.profit)));
    })));
    if (s.unknown.length) { view.appendChild(h('div.sec-title', 'سود نامعلوم (بهای خرید ناقص)')); view.appendChild(h('div.list', s.unknown.slice(0, 15).map(function (x) { return h('div.li', h('div.grow', h('div.t', x.name), h('div.s', UI.fa(x.qty) + ' عدد · فروش ' + UI.money(x.net)))); }))); }
  };
  function pdf(s) {
    var blocks = [{ type: 'title', text: 'خلاصه ماه کسب‌وکار', sub: s.label, left: [A.shop().name || ''] }];
    s.sentences.forEach(function (t) { blocks.push({ type: 'text', text: '• ' + t, size: 3.2 }); });
    blocks.push({ type: 'table', columns: [{ label: 'کالا', w: 3, wrap: true }, { label: 'تعداد', w: 0.7, align: 'center' }, { label: 'فروش (تومان)', w: 1.3, align: 'center' }, { label: 'سود (تومان)', w: 1.3, align: 'center' }],
      rows: s.byProfit.concat(s.unknown).map(function (x) { return [x.name, UI.qty(x.qty), UI.money(x.net), x.unknown ? 'نامعلوم' : UI.money(x.profit)]; }) });
    UI.toast('در حال ساخت PDF…');
    window.PDF.renderFlow(blocks, { title: 'خلاصه ماه ' + s.label, footer: A.shop().name || '' }).then(function (b) { UI.fileSheet(b, 'month.pdf', 'application/pdf'); }, A.showErr);
  }
  /* home: on the last day of the month (from 18:00) this month's summary; on days 1–5 the previous month's */
  A.monthBanner = function () {
    var j = J.fromMs(Date.now()), y = j[0], m = j[1], d = j[2];
    var lastDay = J.fromMs(Date.now() + 864e5)[2] === 1;
    var ym = lastDay && new Date().getHours() >= 18 ? [y, m] : d <= 5 ? prevYm(y, m) : null; if (!ym) return null;
    var s; try { s = summary(E, root.Reports, ym[0], ym[1]); } catch (e) { return null; } if (!s.rows.length) return null;
    return h('a.alert.ok', { href: '#/month?y=' + ym[0] + '&m=' + ym[1], style: { textDecoration: 'none' } }, h('div.grow', h('b', 'خلاصه ' + s.label + ': '), s.sentences[0]));
  };
})(typeof self !== 'undefined' ? self : this);
