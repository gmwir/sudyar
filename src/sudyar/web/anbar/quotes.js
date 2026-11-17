/* v2.8 «پیش‌فاکتور» (proforma / quote): prices for a customer with NO effect on stock, accounts, profit, cash or periods.
   A new price list never changes a quote by itself: open quotes show «قیمت جدید آمده» with the difference of each row and
   update only the rows the user picks. Converting opens the normal sale form (stock checks, payments, discount) filled
   from the quote; posting that invoice marks the quote «تبدیل‌شده» in the same transaction. */
(function () {
  'use strict';
  var A = window.App, E = A.E, UI = window.UI, h = UI.h, view = document.getElementById('view');
  var ST = { open: ['باز', 'ok'], converted: ['تبدیل به فاکتور', 'ok'], cancelled: ['لغو', 'bad'] };
  function badge(k) { var x = ST[k]; return x ? h('span.badge.' + x[1], x[0]) : null; }
  function dateIn(v, ph) { return h('input.in', { value: v || '', inputmode: 'numeric', 'data-date': 1, placeholder: ph ? ph + ' — ۱۴۰۵/۰۸/۱۵' : '۱۴۰۵/۰۸/۱۵' }); }
  function footNote() { var s = A.shop(); return s.quoteNote != null && s.quoteNote !== '' ? s.quoteNote : A.QUOTE_NOTE; }
  function hours() { var n = A.shop().quoteHours; return n >= 1 ? n : 48; }
  function custName(q) { return q.customer ? q.customer.name : q.customerName || 'بدون نام'; }

  A.routes.quotes = function (arg, q) {
    var f = q && q.f || 'open';
    A.setTitle('پیش‌فاکتور', true, h('a.tb-btn', { href: '#/quote/new' }, '+ جدید'));
    view.appendChild(h('div.chips', [['open', 'باز'], ['converted', 'تبدیل‌شده'], ['cancelled', 'لغو'], ['all', 'همه']].map(function (x) {
      return h('a.chip' + (f === x[0] ? '.on' : ''), { href: '#/quotes?f=' + x[0] }, x[1]);
    })));
    view.appendChild(h('p.small.muted', 'پیش‌فاکتور روی موجودی، حساب مشتری، سود و دوره مالی اثری ندارد.'));
    var L = E.quotesList(f === 'all' ? {} : { status: f });
    if (!L.length) { view.appendChild(h('div.card.empty', 'پیش‌فاکتوری نیست.')); return; }
    view.appendChild(h('div.list', L.map(function (x) {
      return h('a.li', { href: '#/quote/' + x.id }, h('div.grow', h('div.t', x.no + ' — ' + custName(x)), h('div.s', UI.dateFa(x.ts) + ' · ' + UI.moneyT(x.total) + (x.validUntil ? ' · اعتبار تا ' + UI.dateFa(x.validUntil) : ''))),
        x.changed ? h('span.badge.warn', 'قیمت جدید آمده') : null, x.expired ? h('span.badge.bad', 'منقضی') : null, badge(x.status));
    })));
  };

  // ---------- editor (new or an open quote) ----------
  function editor(src) {
    var key = UI.opKey('pf'), st = { customerId: src ? src.customerId : null, items: src ? src.lines.map(function (l) { return { productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount }; }) : [] };
    var cname = h('input.in', { value: src ? src.customerName || '' : '', placeholder: 'نام مشتری (اگر در فهرست مشتریان نیست)' });
    var valid = dateIn(src && src.validUntil ? UI.dateFa(src.validUntil) : '', 'خالی = ' + UI.fa(hours()) + ' ساعت از ثبت'), note = h('input.in', { value: src ? src.note || '' : '', placeholder: 'توضیح' });
    var disc = A.moneyInput(src ? src.discount || null : null, 'تخفیف کل'), cbtn = h('button.btn.block'), box = h('div'), sum = h('div.card');
    function drawC() { var c = st.customerId && E.state.customers[st.customerId]; cbtn.textContent = c ? 'مشتری: ' + c.name + ' (تغییر)' : '+ انتخاب مشتری (اختیاری)'; }
    cbtn.onclick = function () { A.pickCustomer(function (c) { st.customerId = c.id; drawC(); }); };
    function draw() {
      UI.clear(box);
      st.items.forEach(function (it, i) {
        var p = E.state.products[it.productId]; if (!p) return;
        var qn = h('input.in', { value: UI.fa(it.qty), inputmode: 'numeric' }), pr = A.moneyInput(it.unitPrice, 'قیمت'), dc = A.moneyInput(it.discount || null, 'تخفیف ردیف');
        qn.addEventListener('input', function () { it.qty = UI.parseNum(qn.value); total(); });
        pr.input.addEventListener('input', function () { it.unitPrice = pr.value(); total(); });
        dc.input.addEventListener('input', function () { it.discount = dc.value() || 0; total(); });
        box.appendChild(h('div.card', h('div.row', h('b.grow', p.name + (p.brand ? ' — ' + p.brand : '')), h('button.btn.sm.ghost', { onclick: function () { st.items.splice(i, 1); draw(); } }, 'حذف')),
          h('div.grid3', A.field('تعداد', qn), A.field('قیمت واحد', pr.input, pr.hint), A.field('تخفیف ردیف', dc.input)),
          p.sellPrice == null ? h('div.small', { style: { color: 'var(--warn)' } }, 'این کالا قیمت فروش ندارد؛ قیمت را خودتان بنویسید.') : null));
      });
      total();
    }
    function total() {
      var t = 0; st.items.forEach(function (it) { if (it.qty > 0 && it.unitPrice >= 0) t += it.qty * it.unitPrice - (it.discount || 0); });
      var d = disc.value() || 0, miss = st.items.filter(function (it) { return it.unitPrice == null || isNaN(it.unitPrice); }).length;
      UI.clear(sum).appendChild(h('div', h('div.tot', h('span', 'جمع اقلام'), h('b', UI.moneyT(t))), d ? h('div.tot', h('span', 'تخفیف'), h('b', UI.moneyT(d))) : null,
        h('div.tot.grand', h('span', 'مبلغ پیش‌فاکتور' + (miss ? ' (ناقص)' : '')), h('b', UI.moneyT(t - d))), miss ? h('div.small', { style: { color: 'var(--warn)' } }, UI.fa(miss) + ' ردیف قیمت ندارد.') : null));
    }
    disc.input.addEventListener('input', total);
    function add() {
      A.pickProduct('افزودن به پیش‌فاکتور', function (p) {
        var it = st.items.filter(function (x) { return x.productId === p.id; })[0];
        if (it) it.qty += 1; else st.items.push({ productId: p.id, qty: 1, unitPrice: p.sellPrice != null ? p.sellPrice : null, discount: 0 }); // no sale price -> the user writes it (never guessed)
        draw();
      });
    }
    var btn = h('button.btn.primary.block', { onclick: function () {
      if (!st.items.length) { UI.toast('کالایی اضافه کنید.', 'bad'); return; }
      if (st.items.some(function (it) { return !(it.qty > 0) || it.unitPrice == null || isNaN(it.unitPrice); })) { UI.toast('تعداد و قیمت همه ردیف‌ها را بنویسید.', 'bad'); return; }
      var vu = UI.parseDateInput(valid.value, true); if (vu !== null && isNaN(vu)) { UI.toast('تاریخ اعتبار نامعتبر است.', 'bad'); return; }
      if (vu === null) vu = src && src.validUntil ? src.validUntil : Date.now() + hours() * 3600e3; // v2.8.1: default validity (48 h)
      btn.disabled = true;
      A.run(function () { return E.saveQuote({ opKey: key, id: src ? src.id : null, customerId: st.customerId, customerName: cname.value, validUntil: vu, items: st.items, discount: disc.value() || 0, note: note.value }, A.userCtx()); })
        .then(function (r) { UI.toast('ذخیره شد (' + r.quote.no + ').', 'ok'); A.go('#/quote/' + r.quote.id); }, function () { btn.disabled = false; });
    } }, 'ذخیره پیش‌فاکتور');
    A.setTitle(src ? 'ویرایش ' + src.no : 'پیش‌فاکتور جدید', true);
    view.appendChild(h('div.card', h('p.small.muted', 'روی موجودی و حساب مشتری اثری ندارد.'), cbtn, A.field('نام مشتری (متن)', cname), h('div.grid2', A.field('اعتبار تا', valid), A.field('توضیح', note))));
    view.appendChild(box);
    view.appendChild(h('button.btn.block', { onclick: add, style: { margin: '8px 0' } }, '+ افزودن کالا'));
    view.appendChild(h('div.card', A.field('تخفیف کل', disc.input, disc.hint)));
    view.appendChild(sum); view.appendChild(h('div.sticky-act', btn));
    drawC(); draw();
  }

  A.routes.quote = function (id) {
    if (id === 'new') { editor(null); return; }
    var q = E.quoteView(id); if (!q) { view.appendChild(h('div.alert.bad', 'پیش‌فاکتور پیدا نشد.')); return; }
    if (A.state.editQuote === id) { A.state.editQuote = null; editor(q); return; }
    A.setTitle(q.no, true);
    if (q.changed) view.appendChild(h('div.alert.warn', h('div.grow', h('b', 'قیمت جدید آمده: '), UI.fa(q.changed) + ' ردیف با قیمت فعلی کالا فرق دارد. خودکار عوض نمی‌شود.'), h('button.btn.sm', { onclick: function () { updatePrices(q); } }, 'بررسی')));
    if (q.expired) view.appendChild(h('div.alert.bad', 'تاریخ اعتبار این پیش‌فاکتور گذشته است.'));
    view.appendChild(h('div.card', h('div.row', h('b.grow', custName(q)), badge(q.status)),
      h('dl.kv', h('dt', 'تاریخ'), h('dd', UI.dateFa(q.ts)), q.validUntil ? [h('dt', 'اعتبار تا'), h('dd', UI.dateFa(q.validUntil, true))] : null,
        q.revision > 1 ? [h('dt', 'ویرایش'), h('dd', UI.fa(q.revision))] : null, q.note ? [h('dt', 'توضیح'), h('dd', q.note)] : null,
        q.status === 'converted' ? [h('dt', 'فاکتور'), h('dd', h('a', { href: '#/doc/' + q.docId }, q.invoiceNo || 'فاکتور'))] : null,
        q.status === 'cancelled' && q.cancelReason ? [h('dt', 'علت لغو'), h('dd', q.cancelReason)] : null)));
    view.appendChild(h('div.card', { style: { padding: '4px 14px' } }, q.lines.map(function (l) {
      return h('div.line', h('div.row', h('b.grow', l.name), h('span', '× ' + UI.qty(l.qty))),
        h('div.small.muted', 'فی ' + UI.money(l.unitPrice) + (l.discount ? ' − تخفیف ' + UI.money(l.discount) : '') + ' = ' + UI.money(l.lineTotal)),
        l.changed ? h('div.small', { style: { color: 'var(--warn)' } }, 'قیمت فعلی کالا: ' + UI.money(l.current)) : null);
    })));
    view.appendChild(h('div.card', h('div.tot', h('span', 'جمع اقلام'), h('b', UI.moneyT(q.subtotal))), q.discount ? h('div.tot', h('span', 'تخفیف'), h('b', UI.moneyT(q.discount))) : null,
      h('div.tot.grand', h('span', 'مبلغ پیش‌فاکتور'), h('b', UI.moneyT(q.total)))));
    var acts = [h('button.btn', { onclick: function () { pdf(q); } }, 'PDF')];
    if (q.status === 'open') acts.push(
      h('button.btn.primary', { onclick: function () { convert(q); } }, 'تبدیل به فاکتور فروش'),
      h('button.btn', { onclick: function () { A.state.editQuote = q.id; A.route(); } }, 'ویرایش'),
      h('button.btn.ghost', { onclick: function () {
        UI.promptBox('لغو ' + q.no, 'علت (اختیاری)').then(function (why) {
          if (why == null) return;
          A.run(function () { return E.cancelQuote({ opKey: UI.opKey('pfx'), id: q.id, reason: why }, A.userCtx()); }).then(function () { UI.toast('لغو شد.', 'ok'); A.route(); }, function () {});
        });
      } }, 'لغو'));
    view.appendChild(h('p.small.muted', footNote()));
    view.appendChild(h('div.grid2', acts));
  };

  /* rows whose product price changed: the user ticks what to update (nothing is ticked by default) */
  function updatePrices(q) {
    var ch = q.lines.filter(function (l) { return l.changed; }), picks = ch.map(function () { return h('input', { type: 'checkbox' }); });
    var s = UI.sheet('به‌روز کردن قیمت‌ها — ' + q.no, h('div.stack', h('p.small.muted', 'فقط ردیف‌هایی که تیک بزنید به قیمت جدید تغییر می‌کنند.'),
      ch.map(function (l, i) { return h('label.check', picks[i], l.name + ': ' + UI.money(l.unitPrice) + ' ← ' + UI.money(l.current)); }),
      h('button.btn.primary.block', { onclick: function () {
        var any = false, items = q.lines.map(function (l) { var j = ch.indexOf(l), up = j >= 0 && picks[j].checked; if (up) any = true; return { productId: l.productId, qty: l.qty, unitPrice: up ? l.current : l.unitPrice, discount: l.discount }; });
        if (!any) { UI.toast('ردیفی انتخاب نشد.'); return; }
        A.run(function () { return E.saveQuote({ opKey: UI.opKey('pfu'), id: q.id, customerId: q.customerId, customerName: q.customerName, validUntil: q.validUntil, items: items, discount: q.discount, note: q.note }, A.userCtx()); })
          .then(function () { s.close(); UI.toast('قیمت‌ها به‌روز شد.', 'ok'); A.route(); }, function () {});
      } }, 'به‌روز کردن ردیف‌های انتخاب‌شده')));
  }

  /* convert: rows whose price changed are asked one by one (no default), then the normal sale form opens filled in */
  function convert(q) {
    var ch = q.lines.filter(function (l) { return l.changed; }), ans = {};
    function next() {
      if (!q.customerId) { // a sale invoice needs a customer
        A.pickCustomer(function (c) { q.customerId = c.id; next(); }); return;
      }
      var items = q.lines.map(function (l) { return { productId: l.productId, qty: l.qty, unitCost: null, unitPrice: ans[l.productId] != null ? ans[l.productId] : l.unitPrice, discount: l.discount || null }; });
      var nd = A.newDraft('out'); nd.type = 'sale'; nd.customerId = q.customerId; nd.items = items; nd.discount = q.discount || null; nd.note = q.note || ''; nd.quoteId = q.id;
      A.saveDraft(nd); A.go('#/out');
    }
    if (!ch.length) { next(); return; }
    var rows = ch.map(function (l) {
      var a = h('input', { type: 'radio', name: 'q' + l.productId }), b = h('input', { type: 'radio', name: 'q' + l.productId });
      return { l: l, a: a, b: b, el: h('div.line', h('b', l.name), h('label.check', a, 'قیمت پیش‌فاکتور ' + UI.money(l.unitPrice)), h('label.check', b, 'قیمت فعلی ' + UI.money(l.current))) };
    });
    var s = UI.sheet('قیمت کدام ردیف‌ها؟', h('div.stack', h('p.small.muted', 'قیمت این ردیف‌ها از زمان پیش‌فاکتور تغییر کرده؛ برای هر ردیف انتخاب کنید.'), rows.map(function (r) { return r.el; }),
      h('button.btn.primary.block', { onclick: function () {
        if (rows.some(function (r) { return !r.a.checked && !r.b.checked; })) { UI.toast('برای همه ردیف‌ها انتخاب کنید.', 'bad'); return; }
        rows.forEach(function (r) { ans[r.l.productId] = r.b.checked ? r.l.current : r.l.unitPrice; });
        s.close(); next();
      } }, 'ادامه')));
  }

  function pdf(q) {
    var shop = A.shop(), c = q.customer;
    var blocks = [{ type: 'title', text: 'پیش‌فاکتور', sub: shop.name || 'امیران یدک', left: [shop.phone, shop.address].filter(Boolean) }];
    var kv = [['شماره', q.no], ['تاریخ', UI.dateFa(q.ts)], ['مشتری', custName(q)]]; if (c && c.phone) kv.push(['تلفن', c.phone]); if (q.validUntil) kv.push(['اعتبار تا', UI.dateFa(q.validUntil, true)]);
    blocks.push({ type: 'kv', items: kv, cols: 2 });
    blocks.push({ type: 'table', columns: [{ label: 'ردیف', w: 0.5, align: 'center' }, { label: 'کد', w: 1.1 }, { label: 'شرح کالا', w: 3, wrap: true }, { label: 'تعداد', w: 0.7, align: 'center' },
      { label: 'فی (تومان)', w: 1.2, align: 'center' }, { label: 'تخفیف', w: 1, align: 'center' }, { label: 'مبلغ', w: 1.3, align: 'center' }],
      rows: q.lines.map(function (l, i) { return [UI.fa(i + 1), l.sku, l.name + (l.brand ? ' — ' + l.brand : ''), UI.qty(l.qty), UI.money(l.unitPrice), l.discount ? UI.money(l.discount) : '', UI.money(l.lineTotal)]; }) });
    var tot = [['جمع اقلام', UI.moneyT(q.subtotal)]]; if (q.discount) tot.push(['تخفیف', UI.moneyT(q.discount)]); tot.push(['مبلغ پیش‌فاکتور', UI.moneyT(q.total)]);
    blocks.push({ type: 'kv', items: tot, cols: 2 });
    A.accountBlocks().forEach(function (b) { blocks.push(b); }); // v2.8.1: where to pay
    if (q.note) blocks.push({ type: 'text', text: 'توضیحات: ' + q.note, size: 3 });
    blocks.push({ type: 'text', text: 'این پیش‌فاکتور است و فاکتور فروش نیست. ' + footNote(), size: 3.3 }); // v2.8.1: at the end of the sheet
    UI.toast('در حال ساخت PDF…');
    window.PDF.renderFlow(blocks, { title: 'پیش‌فاکتور ' + q.no, footer: shop.name || '' }).then(function (b) { UI.fileSheet(b, q.no + '.pdf', 'application/pdf'); }, A.showErr);
  }
})();
