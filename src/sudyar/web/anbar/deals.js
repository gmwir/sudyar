/* Amiran Yadak — Direct deals (outside physical stock)
 * Adds the missing /deals screen to the v2.10 shell. Direct deal lines are stored
 * in Core's deals ledger and deliberately never create products or stock movements.
 */
(function () {
  'use strict';
  var A = window.App, E = A.E, UI = A.UI, h = A.h, Core = window.Core;
  if (!A || !E) return;
  var field = A.field, moneyInput = A.moneyInput;
  function parseDate(v) { return UI.parseDateInput(v) || Date.now(); }
  function opKey() { return UI.opKey('direct-deal'); }
  function partyName(type, id) {
    var p = type === 'customer' ? E.state.customers[id] : E.state.suppliers[id];
    return p ? p.name : 'طرف حساب';
  }
  function partyPicker(type, onPick) {
    var q = h('input.in', { type: 'search', placeholder: 'نام یا شماره تماس…', autocomplete: 'off' });
    var list = h('div.list');
    function draw() {
      UI.clear(list);
      var rows = E.partyList(type, q.value).slice(0, 60);
      if (!rows.length) list.appendChild(h('div.empty', 'موردی پیدا نشد.'));
      rows.forEach(function (r) {
        list.appendChild(h('button.li', { type: 'button', style: { width: '100%', textAlign: 'right', background: 'none', border: 0 }, onclick: function () { s.close(); onPick(r.party); } },
          h('div.grow', h('div.t', r.name), h('div.s', r.phone || '')), h('span.badge', UI.money(r.balance))));
      });
    }
    q.addEventListener('input', draw);
    var s = UI.sheet(type === 'customer' ? 'انتخاب مشتری' : 'انتخاب همکار / تأمین‌کننده', h('div', h('div.row', q,
      h('button.btn.sm', { onclick: function () {
        s.close();
        if (type === 'customer') A.customerForm(null, onPick, q.value);
        else supplierForm(null, onPick, q.value);
      } }, '+ جدید')), list));
    draw(); setTimeout(function () { q.focus(); }, 60);
  }
  function supplierForm(old, done, preset) {
    old = old || {};
    var name = h('input.in', { value: old.name || preset || '' }), phone = h('input.in.ltr-in', { value: old.phone || '', inputmode: 'tel' });
    var city = h('input.in', { value: old.city || '' });
    var s = UI.sheet('ثبت همکار / تأمین‌کننده', h('div.stack', field('نام', name, null, true), field('تلفن', phone), field('شهر', city),
      h('button.btn.primary.block', { onclick: function () {
        if (!name.value.trim()) { UI.toast('نام الزامی است.', 'bad'); return; }
        A.run(function () { return E.createSupplier({ name: name.value.trim(), phone: phone.value, city: city.value }, A.userCtx()); })
          .then(function (r) { s.close(); done(r.supplier); }, function () {});
      } }, 'ذخیره همکار')));
  }
  function itemRow(rows, redraw) {
    var box = h('div.stack');
    rows.forEach(function (r, i) {
      var name = h('input.in', { value: r.name, placeholder: 'نام کالا / شرح خدمت' });
      var code = h('input.in', { value: r.code || '', placeholder: 'کد کالا (اختیاری)' });
      var qty = h('input.in', { value: String(r.qty), inputmode: 'numeric' });
      var price = moneyInput(r.unitPrice, 'قیمت واحد (تومان)');
      [name, code].forEach(function (x) { x.addEventListener('change', function () { r.name = name.value; r.code = code.value; }); });
      qty.addEventListener('change', function () { r.qty = Math.max(1, UI.parseInt2(qty.value) || 1); redraw(); });
      price.input.addEventListener('change', function () { r.unitPrice = price.value() || 0; redraw(); });
      box.appendChild(h('div.card', h('div.row', h('b.grow', 'قلم ' + UI.fa(i + 1)), h('button.btn.sm.ghost', { onclick: function () { rows.splice(i, 1); redraw(); } }, 'حذف')),
        field('شرح کالا', name, null, true), field('کد کالا', code), h('div.grid2', field('تعداد', qty), field('فی (تومان)', price.input, price.hint))));
    });
    return box;
  }
  function createForm(side, dealId) {
    var isBuy = side === 'buy', partyType = isBuy ? 'supplier' : 'customer';
    var party = null, rows = [{ name: '', code: '', qty: 1, unitPrice: 0 }];
    var invoice = h('input.in', { placeholder: 'شماره فاکتور (اختیاری)' });
    var date = h('input.in', { value: UI.todayStr(), placeholder: '۱۴۰۵/۰۸/۰۹' });
    var discount = moneyInput(0, 'تخفیف کل (تومان)');
    var paid = moneyInput(0, isBuy ? 'مبلغ پرداختی به همکار' : 'مبلغ دریافتی از مشتری');
    var method = A.sel({ cash: 'نقدی', card_transfer: 'کارت‌به‌کارت', pos: 'کارت‌خوان', bank: 'انتقال بانکی', cheque: 'چک' }, 'card_transfer');
    var note = h('textarea.in', { placeholder: 'توضیحات معامله (اختیاری)' });
    var due = h('input.in', { placeholder: 'تاریخ سررسید (اختیاری)' });
    var partyBox = h('div.card.empty', 'هنوز طرف حساب انتخاب نشده است.'), rowsBox = h('div'), totalBox = h('div.tot.grand');
    function calc() {
      var gross = rows.reduce(function (s, r) { return s + (Math.max(0, r.qty) * Math.max(0, r.unitPrice)); }, 0);
      var d = discount.value() || 0; totalBox.textContent = 'جمع ناخالص: ' + UI.moneyT(gross) + ' · تخفیف: ' + UI.moneyT(d) + ' · خالص: ' + UI.moneyT(Math.max(0, gross - d));
    }
    function redraw() { UI.clear(rowsBox); rowsBox.appendChild(itemRow(rows, redraw)); calc(); }
    function chooseParty() {
      partyPicker(partyType, function (p) { party = p; UI.clear(partyBox); partyBox.className = 'card'; partyBox.appendChild(h('div.row', h('div.grow', h('b', p.name), h('div.small.muted', p.phone || '')), h('button.btn.sm', { onclick: chooseParty }, 'تغییر'))); });
    }
    var title = isBuy ? 'خرید مستقیم از همکار' : 'فروش مستقیم به مشتری';
    var content = h('div.stack', h('div.alert.warn', 'این معامله خارج از انبار ثبت می‌شود؛ موجودی و ارزش انبار هیچ تغییری نمی‌کند.'),
      h('div.row', h('div.grow', partyBox), h('button.btn.sm.primary', { onclick: chooseParty }, 'انتخاب طرف حساب')),
      h('div.grid2', field('تاریخ معامله', date), field('شماره فاکتور', invoice)), rowsBox,
      h('button.btn.ghost.block', { onclick: function () { rows.push({ name: '', code: '', qty: 1, unitPrice: 0 }); redraw(); } }, '+ افزودن قلم'),
      totalBox, field('تخفیف کل', discount.input, discount.hint),
      h('div.sec-title', isBuy ? 'پرداخت به همکار' : 'دریافت از مشتری'), field(isBuy ? 'پرداخت همین لحظه' : 'دریافت همین لحظه', paid.input, paid.hint), field('روش پرداخت', method),
      field('سررسید (اختیاری)', due), field('یادداشت', note),
      h('button.btn.primary.block', { onclick: function () {
        if (!party) { UI.toast('طرف حساب را انتخاب کنید.', 'bad'); return; }
        var lines = rows.map(function (r) { return { name: r.name.trim(), code: r.code, qty: Math.max(1, UI.parseInt2(r.qty) || 1), unitPrice: r.unitPrice }; });
        if (lines.some(function (r) { return !r.name || !Number.isSafeInteger(r.unitPrice) || r.unitPrice < 0; })) { UI.toast('شرح کالا و قیمت معتبر هر قلم را وارد کنید.', 'bad'); return; }
        var payload = { opKey: opKey(), dealId: dealId || undefined, side: side, partyId: party.id, ts: parseDate(date.value), invoiceNo: invoice.value,
          lines: lines, discount: discount.value() || 0, note: note.value, dueDate: due.value ? parseDate(due.value) : null,
          pay: (paid.value() || 0) > 0 ? { amount: paid.value(), method: method.value } : null };
        A.runSmart(function (ctx, flags) { payload.duplicateOk = flags.duplicateOk; return function () { return E.postDealLeg(payload, ctx); }; })
          .then(function (r) { UI.toast('معامله خارج از انبار ثبت شد: ' + r.leg.no, 'ok'); A.go('#/deal/' + r.deal.id); }, function () {});
      } }, 'ثبت ' + (isBuy ? 'خرید مستقیم' : 'فاکتور فروش مستقیم')));
    redraw();
    UI.sheet(title, content, { modal: true });
  }
  function pdfInvoice(leg) {
    var party = partyName(leg.partyType, leg.partyId), shop = A.shop(), isSale = leg.side === 'sell';
    var blocks = [
      { type: 'text', text: shop.name || 'امیران یدک', size: 17, bold: true, align: 'center' },
      { type: 'text', text: isSale ? 'فاکتور فروش مستقیم — خارج از انبار' : 'فاکتور خرید مستقیم — خارج از انبار', size: 13, bold: true, align: 'center' },
      { type: 'text', text: 'شماره: ' + (leg.invoiceNo || leg.no) + '     تاریخ: ' + UI.dateFa(leg.ts, true), size: 10 },
      { type: 'text', text: (isSale ? 'خریدار: ' : 'فروشنده: ') + party, size: 11 },
      { type: 'table', headers: ['شرح کالا', 'کد', 'تعداد', 'فی (تومان)', 'مبلغ (تومان)'], rows: leg.lines.map(function (l) { return [l.name, l.code || '—', UI.fa(l.qty), UI.money(l.unitPrice), UI.money(l.qty * l.unitPrice)]; }) },
      { type: 'text', text: 'جمع ناخالص: ' + UI.moneyT(leg.gross) + '    تخفیف: ' + UI.moneyT(leg.discount) + '    مبلغ خالص: ' + UI.moneyT(leg.net), size: 11, bold: true },
      { type: 'text', text: 'توضیحات: ' + (leg.note || '—'), size: 9 }
    ];
    if (window.PDF && PDF.renderFlow) PDF.renderFlow(blocks, { title: 'فاکتور مستقیم ' + (leg.invoiceNo || leg.no), footer: shop.name || 'امیران یدک' })
      .then(function (pdf) { UI.fileSheet(pdf, (leg.invoiceNo || leg.no) + '-direct.pdf', 'application/pdf'); })
      .catch(function () { UI.toast('ساخت PDF ناموفق بود.', 'bad'); });
    else UI.toast('کتابخانه PDF در فایل‌های سایت بارگذاری نشده است.', 'bad');
  }
  A.routes.deals = function (arg, query) {
    if (arg === 'new') { createForm(query.side || query.new || 'sell'); return; }
    A.setTitle('خرید و فروش مستقیم', true, h('button.tb-btn', { onclick: function () { createForm('sell'); } }, '+ فروش'));
    var rows = E.dealsList({}).slice().reverse();
    viewAppend(h('div.alert.ok', 'ثبت این معاملات هیچ اثری بر موجودی فیزیکی انبار ندارد. برای صدور فاکتور فروش مستقیم، فروش جدید را انتخاب کنید.'));
    viewAppend(h('div.grid2', h('button.btn.primary', { onclick: function () { createForm('buy'); } }, '+ خرید از همکار'), h('button.btn.primary', { onclick: function () { createForm('sell'); } }, '+ فروش به مشتری')));
    if (!rows.length) viewAppend(h('div.card.empty', 'هنوز معامله مستقیمی ثبت نشده است.'));
    rows.forEach(function (r) { viewAppend(h('a.li', { href: '#/deal/' + r.id }, h('div.grow', h('div.t', r.title || r.no), h('div.s', r.no + ' · ' + UI.dateFa(r.last, true)), h('div.s', r.legs.map(function (l) { return (l.side === 'buy' ? 'خرید' : 'فروش') + ': ' + partyName(l.partyType, l.partyId); }).join(' | '))), h('div.e', h('b', r.profit == null ? 'سود نامشخص' : UI.moneyT(r.profit)), h('span.badge', r.settle.status === 'settled' ? 'تسویه' : 'باز')))); });
  };
  function viewAppend(node) { document.getElementById('view').appendChild(node); }
  A.routes.deal = function (id) {
    var v = E.dealView(id); if (!v) { A.go('#/deals'); return; }
    var d = v.deal; A.setTitle(d.title || d.no, true);
    viewAppend(h('div.alert.warn', 'این معامله خارج از انبار است؛ هیچ کالا یا موجودی فیزیکی به‌صورت خودکار ایجاد نشده است.'));
    viewAppend(h('div.card', h('b', d.no), h('div.small.muted', UI.dateFa(d.ts, true)), h('div.tot', h('span', 'فروش شناسایی‌شده'), h('b', UI.moneyT(v.income))), h('div.tot', h('span', 'بهای خرید'), h('b', v.cogs == null ? 'نامشخص' : UI.moneyT(v.cogs))), h('div.tot.grand', h('span', 'سود معامله'), h('b', v.profit == null ? 'نامشخص' : UI.moneyT(v.profit)))));
    v.legs.forEach(function (l) {
      var isSale = l.side === 'sell';
      viewAppend(h('div.card', h('div.row', h('div.grow', h('b', (isSale ? 'فروش مستقیم' : 'خرید مستقیم') + ' · ' + l.no), h('div.small.muted', partyName(l.partyType, l.partyId) + ' · ' + UI.dateFa(l.ts, true))), h('span.badge', l.cancelled ? 'ابطال‌شده' : l.type === 'return' ? 'برگشت' : 'ثبت‌شده')),
        l.invoiceNo ? h('div.small', 'شماره فاکتور: ' + l.invoiceNo) : null,
        l.lines.map(function (x) { return h('div.line', h('div.row', h('span.grow', x.name + ' × ' + UI.fa(x.qty)), h('b', UI.moneyT(x.net || x.qty * x.unitPrice)))); }),
        h('div.tot.grand', h('span', 'جمع فاکتور'), h('b', UI.moneyT(l.net || 0))),
        l.side === 'sell' && l.type === 'post' && !l.cancelled ? h('button.btn.primary.block', { onclick: function () { pdfInvoice(l); } }, 'صدور / چاپ فاکتور فروش PDF') : null));
    });
  };
})();
