/* v2.11: restored v2.8 screens (deals.js of v2.10 replaced them with a reduced version and is no longer loaded) + v2.11 additions:
   rows linked to defined products (productId, code = SKU), PDF of a direct sale, statement in invoice blocks with PDF, cancelled items in their own section.
   v2.5 screens: «خرید و فروش مستقیم» (deals outside the warehouse) and «حساب اشخاص» (party accounts).
   All money logic is in the engine (core.js); this file only collects input and shows results.
   Nothing here touches products, stock or the existing invoices except through the engine. */
(function () {
  'use strict';
  var A = window.App, E = A.E, UI = window.UI, h = UI.h, view = document.getElementById('view');
  var STATUS = { open: ['باز (کالای فروش‌نرفته)', 'warn'], uncertain: ['سود هنوز قطعی نیست', 'warn'], closed: ['بسته', 'ok'], cancelled: ['ابطال‌شده', 'bad'] };
  var SETTLE = { settled: ['تسویه', 'ok'], partial: ['نیمه‌تسویه', 'warn'], unsettled: ['تسویه‌نشده', 'bad'] };
  var PT = { customer: 'مشتری', supplier: 'تأمین‌کننده' };
  function badge(m, k) { var x = m[k]; return x ? h('span.badge.' + x[1], x[0]) : null; }
  function balTxt(b) { return b > 0 ? UI.moneyT(b) + ' بدهکار' : b < 0 ? UI.moneyT(-b) + ' بستانکار' : 'تسویه'; }
  function balBadge(b) { return h('span.badge' + (b > 0 ? '.bad' : b < 0 ? '.warn' : '.ok'), b ? UI.money(Math.abs(b)) + (b > 0 ? ' بد' : ' بس') : '۰'); }
  function partyName(t, id) { var p = t && id ? E.state[t === 'customer' ? 'customers' : 'suppliers'][id] : null; return p ? p.name : '—'; }
  function dateIn(v, ph) { return h('input.in', { value: v || '', inputmode: 'numeric', 'data-date': 1, placeholder: ph ? ph + ' — ۱۴۰۵/۰۸/۰۱' : '۱۴۰۵/۰۸/۰۱' }); }
  function parseD(inp, end) { var t = UI.parseDateInput(inp.value, end); if (t !== null && isNaN(t)) { UI.toast('تاریخ نامعتبر است.', 'bad'); throw new Error('date'); } return t; }
  function csv(rows, name) { UI.fileSheet(window.XLSX.writeCsv(rows), name + '.csv', 'text/csv'); }
  function methodSel() { return A.sel(A.payMethods(), 'cash'); }
  function kv(pairs) { var dl = h('dl.kv'); pairs.forEach(function (p) { if (p) { dl.appendChild(h('dt', p[0])); dl.appendChild(h('dd', p[1])); } }); return dl; }
  function tot(label, val, grand) { return h('div.tot' + (grand ? '.grand' : ''), h('span', label), h('b', val)); }
  function ctxRun(build) { return A.runSmart(build); }
  function withManager(label, fn) { return A.manager(label).then(function (ctx) { if (!ctx) return null; return A.run(function () { return fn(ctx); }); }); }

  // ======================= deals list =======================
  A.routes.deals = function (arg, q) {
    A.setTitle('خرید و فروش مستقیم', true, h('button.tb-btn', { onclick: function () { newDeal(); } }, '+ معامله'));
    var st = A.lsGet('ay.dealsF') || {};
    var from = dateIn(st.from || ''), to = dateIn(st.to || ''), item = h('input.in', { value: st.item || '', placeholder: 'نام یا کد کالا' });
    function save() { A.lsSet('ay.dealsF', st); }
    function chips(key, opts) {
      return h('div.chips', Object.keys(opts).map(function (k) {
        return h('button.chip' + ((st[key] || '') === k ? '.on' : ''), { onclick: function () { st[key] = k; save(); A.route(); } }, opts[k]);
      }));
    }
    view.appendChild(h('div.alert.warn', h('div.grow', 'این معاملات وارد انبار نمی‌شوند: موجودی و ارزش انبار تغییر نمی‌کند. سود فقط برای کالای فروش‌رفته حساب می‌شود.')));
    var partyBtn = h('button.btn.sm', { onclick: function () {
      var s = UI.sheet('فیلتر طرف حساب', h('div.stack',
        h('button.btn.block', { onclick: function () { s.close(); A.pickCustomer(function (c) { st.party = { t: 'customer', id: c.id }; save(); A.route(); }); } }, 'مشتری'),
        h('button.btn.block', { onclick: function () { s.close(); A.pickSupplier(function (x) { st.party = { t: 'supplier', id: x.id }; save(); A.route(); }); } }, 'تأمین‌کننده'),
        st.party ? h('button.btn.block.ghost', { onclick: function () { s.close(); st.party = null; save(); A.route(); } }, 'حذف فیلتر') : null));
    } }, st.party ? PT[st.party.t] + ': ' + partyName(st.party.t, st.party.id) : 'طرف حساب: همه');
    view.appendChild(h('div.card', h('div.grid2', A.field('از تاریخ', from), A.field('تا تاریخ', to)), A.field('کالا', item),
      h('div.row', partyBtn, h('button.btn.sm.primary', { onclick: function () {
        try { parseD(from); parseD(to, true); } catch (e) { return; }
        st.from = from.value.trim(); st.to = to.value.trim(); st.item = item.value.trim(); save(); A.route();
      } }, 'اعمال'))));
    view.appendChild(chips('status', { '': 'همه', open: 'باز', uncertain: 'سود نامشخص', closed: 'بسته', cancelled: 'ابطال' }));
    view.appendChild(chips('settle', { '': 'هر تسویه', unsettled: 'تسویه‌نشده', partial: 'نیمه', settled: 'تسویه' }));
    view.appendChild(chips('profit', { '': 'هر سود', gain: 'سودده', loss: 'زیان‌ده', uncertain: 'نامشخص' }));
    var f = { from: st.from ? UI.parseDateInput(st.from) : null, to: st.to ? UI.parseDateInput(st.to, true) : null, item: st.item || '', status: st.status || '', settle: st.settle || '', profit: st.profit || '' };
    if (st.party) f[st.party.t === 'customer' ? 'customerId' : 'supplierId'] = st.party.id;
    if (q && (q.new === 'buy' || q.new === 'sell')) setTimeout(function () { legForm({ side: q.new }); }, 50); // v2.8: from the purchase page
    var all = E.dealsList(f), onlyX = f.status === 'cancelled', pl = E.dealsPL({ from: f.from, to: f.to }), cf = E.cashFlow({ from: f.from, to: f.to });
    var list = onlyX ? all : all.filter(function (x) { return x.status !== 'cancelled'; }), voidL = onlyX ? [] : all.filter(function (x) { return x.status === 'cancelled'; }); // v2.11
    function voidSec() { // v2.11: cancelled deals are listed apart; their rows net to zero, so no total changes
      if (!voidL.length) return;
      view.appendChild(h('details.card', h('summary', 'باطل‌شده‌ها (' + UI.fa(voidL.length) + ') — در جمع‌ها و سود اثری ندارند'), h('div.list', voidL.map(function (x) {
        return h('a.li', { href: '#/deal/' + x.id }, h('div.grow', h('div.t', x.no + ' — ' + x.title), h('div.s', UI.dateFa(x.first))), badge(STATUS, x.status));
      }))));
    }
    view.appendChild(h('div.card', h('div.sec-title', 'سود و زیان معاملات مستقیم (در بازه)'),
      tot('درآمد فروش (خالص)', UI.moneyT(pl.income)), tot('بهای کالای فروش‌رفته', UI.moneyT(pl.cogs)), tot('هزینه‌های مستقیم فروش', UI.moneyT(pl.direct)),
      tot('سود قطعی', UI.moneyT(pl.profit), true),
      pl.uncertainDeals ? h('div.alert.warn', 'سود هنوز قطعی نیست: ' + UI.fa(pl.uncertainDeals) + ' معامله با فروش ' + UI.moneyT(pl.uncertainIncome) + ' (خرید آن ثبت/مرتبط نشده) — در سود بالا حساب نشده است.') : null,
      h('div.sec-title', 'جریان نقد واقعی (همه دریافت و پرداخت‌ها در بازه)'),
      tot('ورود وجه', UI.moneyT(cf.cashIn)), tot('خروج وجه', UI.moneyT(cf.cashOut)), tot('خالص', UI.moneyT(cf.net), true),
      h('p.small.muted', 'مبلغ دریافت‌نشده نقد نیست؛ پرداخت بدهی هزینه دوباره نیست. خرید نقدی فاکتورهای انبار فقط وقتی اینجا می‌آید که از «حساب اشخاص» پرداخت ثبت شود.')));
    if (!list.length) { view.appendChild(h('div.card.empty', 'معامله‌ای نیست. با «+ معامله» یک خرید یا فروش مستقیم ثبت کنید.')); voidSec(); return; }
    view.appendChild(h('div.row', h('span.grow.muted', UI.fa(list.length) + ' معامله'), h('button.btn.sm', { onclick: function () {
      csv([['شماره', 'عنوان', 'تاریخ', 'وضعیت', 'درآمد', 'بهای فروش‌رفته', 'هزینه مستقیم', 'سود', 'مانده تسویه']].concat(list.map(function (x) {
        return [x.no, x.title, UI.dateFa(x.first), STATUS[x.status][0], x.income, x.cogs == null ? '' : x.cogs, x.direct, x.profit == null ? 'نامشخص' : x.profit, x.settle.remaining];
      })), 'deals');
    } }, 'CSV')));
    view.appendChild(h('div.list', list.map(function (x) {
      return h('a.li', { href: '#/deal/' + x.id }, h('div.grow', h('div.t', x.no + ' — ' + x.title),
        h('div.s', UI.dateFa(x.first) + ' · ' + (x.profit == null ? 'سود هنوز قطعی نیست' : 'سود ' + UI.money(x.profit)) + (x.settle.remaining ? ' · مانده ' + UI.money(x.settle.remaining) : ''))),
        badge(STATUS, x.status), badge(SETTLE, x.settle.status));
    })));
    voidSec();
  };

  function newDeal() {
    var s = UI.sheet('معامله جدید', h('div.stack', h('p.small.muted', 'معامله با اولین ردیف ساخته می‌شود. فروش بدون خرید هم ممکن است؛ سودش تا ثبت خرید «نامشخص» می‌ماند.'),
      h('button.btn.block.primary', { onclick: function () { s.close(); legForm({ side: 'buy' }); } }, 'خرید از تأمین‌کننده (بدون ورود به انبار)'),
      h('button.btn.block', { onclick: function () { s.close(); legForm({ side: 'sell' }); } }, 'فروش به مشتری (بدون خروج از انبار)')));
  }

  // ======================= leg form (buy / sell) =======================
  function legForm(o) {
    var side = o.side, buy = side === 'buy', key = UI.opKey(buy ? 'dlb' : 'dls'), party = null, lines = [], costs = [];
    var v = o.dealId ? E.dealView(o.dealId) : null;
    var title = h('input.in', { placeholder: 'اختیاری؛ پیش‌فرض: نام اولین کالا' }), inv = h('input.in', { placeholder: 'شماره فاکتور' }), dt = dateIn(UI.todayStr()), due = dateIn('', 'اختیاری');
    var disc = A.moneyInput(null, 'تخفیف (تومان)'), paid = A.moneyInput(null, buy ? 'پرداخت‌شده همین حالا' : 'دریافت‌شده همین حالا'), mt = methodSel(), ref = h('input.in', { placeholder: 'شماره پیگیری / چک' });
    var note = h('input.in', { placeholder: 'توضیح' }), box = h('div.stack'), cbox = h('div.stack'), sum = h('div.card'), pbtn = h('button.btn.block');
    function drawParty() { pbtn.textContent = party ? PT[buy ? 'supplier' : 'customer'] + ': ' + party.name + ' (تغییر)' : '+ انتخاب ' + (buy ? 'تأمین‌کننده (فروشنده)' : 'مشتری'); }
    pbtn.onclick = function () { (buy ? A.pickSupplier : A.pickCustomer)(function (x) { party = x; drawParty(); }); };
    function addLine(p) {
      var L = { productId: p && p.productId || null, name: h('input.in', { value: p && p.name || '', placeholder: 'نام کالا (یا «انتخاب از کالاها»)', autocomplete: 'off' }), code: h('input.in.ltr-in', { value: p && p.code || '', placeholder: 'کد (اختیاری)' }),
        qty: h('input.in', { value: p && p.qty ? UI.fa(p.qty) : '۱', inputmode: 'numeric' }), price: A.moneyInput(p && p.price || null, buy ? 'قیمت خرید واحد' : 'قیمت فروش واحد'),
        cands: [], refCost: undefined, sug: h('div.list'), info: h('div.stack') };
      L.tag = h('div.row.wrap', { style: { gap: '6px', alignItems: 'center' } });
      L.draw = function () { // v2.11: a row is either a product defined in the app (kept by id, code = its SKU) or free text
        UI.clear(L.tag); var pr = L.productId && E.state.products[L.productId];
        if (L.productId && !pr) L.productId = null;
        L.name.readOnly = L.code.readOnly = !!pr;
        L.tag.appendChild(pr ? h('span.badge.ok', 'کالای تعریف‌شده') : h('span.small.muted', 'کالای آزاد (تعریف‌نشده در اپ)'));
        L.tag.appendChild(h('button.btn.sm', { type: 'button', onclick: function () {
          A.pickProduct(buy ? 'کالای خرید مستقیم' : 'کالای فروش مستقیم', function (x) { pick(L, x); }); // v2.12: prices come from the app's data
        } }, pr ? 'تغییر کالا' : 'انتخاب از کالاها'));
        if (pr) L.tag.appendChild(h('button.btn.sm.ghost', { type: 'button', onclick: function () { L.productId = null; L.cands = []; L.refCost = undefined; UI.clear(L.info); L.draw(); } }, 'متن آزاد'));
      };
      L.el = h('div.card', L.tag, L.name, L.sug, h('div.grid2', L.code, L.qty), L.price.input, L.price.hint, L.info,
        h('button.btn.sm.ghost', { onclick: function () { lines.splice(lines.indexOf(L), 1); L.el.remove(); calc(); } }, 'حذف ردیف'));
      [L.qty, L.price.input].forEach(function (i) { i.addEventListener('input', calc); });
      var sT = null; // v2.12: typing a name shows the catalogue items (the same smart search as the sale form)
      L.name.addEventListener('input', function () {
        if (L.productId) return;
        clearTimeout(sT); sT = setTimeout(function () {
          UI.clear(L.sug); var q = L.name.value.trim(); if (q.length < 2) return;
          var r = A.searchSmart(q); r.list.slice(0, 4).forEach(function (pp) {
            L.sug.appendChild(h('button.li', { type: 'button', style: { width: '100%', textAlign: 'right' }, onclick: function () { pick(L, pp); } },
              h('div.grow', h('div.t', pp.name), h('div.s', [pp.brand, pp.sku, pp.sellPrice != null ? 'فروش ' + UI.money(pp.sellPrice) : 'قیمت فروش تعریف نشده'].filter(Boolean).join(' · '))), h('span.small', 'همین است')));
          });
        }, 180);
      });
      lines.push(L); box.appendChild(L.el); L.draw(); calc();
      if (L.productId && E.state.products[L.productId]) pick(L, E.state.products[L.productId], true);
    }
    /* v2.11: purchase prices recorded for a product — the same figures the warehouse uses. Several different ones → the user chooses. */
    function costCands(pp) {
      var c = [], add = function (v, src) { if (v == null || !(v >= 0)) return; var x = c.filter(function (y) { return y.v === v; })[0]; if (x) x.src += ' / ' + src; else c.push({ v: v, src: src }); };
      if (pp.stock > 0) add(E.avgCost(pp), 'بهای خرید موجودی انبار');
      add(pp.buyPrice, 'قیمت خرید تعریف‌شده');
      var rc = E.replacementCost(pp.id, null); if (rc) add(rc.unitCost, 'قیمت خرید امروز (' + UI.dateFa(rc.ts) + ')');
      return c;
    }
    function pick(L, pp, keepPrice) {
      L.productId = pp.id; L.name.value = pp.name + (pp.brand && pp.name.indexOf(pp.brand) < 0 ? ' — ' + pp.brand : ''); L.code.value = pp.sku || ''; UI.clear(L.sug); UI.clear(L.info); L.draw();
      L.cands = costCands(pp); L.refCost = undefined;
      if (pp.stock > 0) L.info.appendChild(h('div.alert.warn', 'این کالا ' + UI.qty(pp.stock) + ' عدد در انبار موجود است. اگر از انبار می‌فروشید از «فروش / خروج» استفاده کنید تا از موجودی کم شود.'));
      if (!buy) {
        if (pp.sellPrice != null) { if (!(keepPrice && L.price.value() != null)) L.price.input.value = UI.fa(UI.group(pp.sellPrice)); L.info.appendChild(h('div.small.muted', 'قیمت فروش تعریف‌شده (همان قیمت فروش از انبار): ' + UI.moneyT(pp.sellPrice))); }
        else L.info.appendChild(h('div.small', { style: { color: 'var(--bad)' } }, 'قیمت فروش این کالا تعریف نشده است؛ قیمت را وارد کنید.'));
        var cb = h('div.stack');
        if (L.cands.length === 1) { L.refCost = L.cands[0]; cb.appendChild(h('div.small.muted', 'بهای خرید برای سود برآوردی: ' + UI.moneyT(L.cands[0].v) + ' (' + L.cands[0].src + ')')); }
        else if (L.cands.length > 1) {
          cb.appendChild(h('div.small', { style: { color: 'var(--warn)' } }, 'این کالا چند قیمت خرید ثبت‌شده دارد؛ کدام برای سود برآوردی حساب شود؟'));
          var chips = h('div.chips'); cb.appendChild(chips);
          var draw = function () { UI.clear(chips); L.cands.concat([{ v: null, src: 'هیچ‌کدام (سود نامشخص بماند)' }]).forEach(function (x) {
            chips.appendChild(h('button.chip' + (L.refCost && L.refCost.v === x.v ? '.on' : ''), { type: 'button', onclick: function () { L.refCost = x; draw(); } }, (x.v != null ? UI.money(x.v) + ' — ' : '') + x.src)); }); };
          draw();
        } else { L.refCost = { v: null, src: '' }; cb.appendChild(h('div.small.muted', 'قیمت خریدی برای این کالا ثبت نشده؛ سود تا ثبت خرید «هنوز قطعی نیست».')); }
        L.info.appendChild(cb);
      } else if (L.cands.length) {
        L.info.appendChild(h('div.small.muted', 'قیمت‌های خرید ثبت‌شده (برای مقایسه؛ قیمت را از فاکتور فروشنده وارد کنید):'));
        L.info.appendChild(h('div.chips', L.cands.map(function (x) { return h('button.chip', { type: 'button', onclick: function () { L.price.input.value = UI.fa(UI.group(x.v)); L.price.input.dispatchEvent(new Event('input')); } }, UI.money(x.v) + ' — ' + x.src); })));
      }
      L.price.input.dispatchEvent(new Event('input')); calc();
    }
    function addCost() {
      var C = { title: h('input.in', { placeholder: buy ? 'مثلاً حمل، باربری' : 'مثلاً پیک، ارسال' }), amount: A.moneyInput(null, 'مبلغ'), party: h('input', { type: 'checkbox' }) };
      C.el = h('div.card', h('div.grid2', C.title, C.amount.input), buy ? h('label.check', C.party, 'روی فاکتور فروشنده است (به بدهی شما به او اضافه شود)') : h('p.small.muted', 'هزینه نقدی؛ همین حالا جداگانه پرداخت شده'),
        h('button.btn.sm.ghost', { onclick: function () { costs.splice(costs.indexOf(C), 1); C.el.remove(); calc(); } }, 'حذف'));
      C.amount.input.addEventListener('input', calc); costs.push(C); cbox.appendChild(C.el); calc();
    }
    function data() {
      return {
        lines: lines.map(function (L) { var o = { name: L.name.value.trim(), code: L.code.value.trim(), qty: UI.parseNum(L.qty.value), unitPrice: L.price.value() }; if (L.productId) o.productId = L.productId;
          if (L.refCost && L.refCost.v != null) { o.refCost = L.refCost.v; o.refCostSrc = L.refCost.src; } return o; }),
        costs: costs.map(function (C) { return { title: C.title.value.trim(), amount: C.amount.value(), payTo: C.party.checked ? 'party' : 'cash' }; }).filter(function (c) { return c.amount; }),
        discount: disc.value() || 0
      };
    }
    function calc() {
      var d = data(), g = 0, pc = 0, cc = 0;
      d.lines.forEach(function (l) { if (l.qty > 0 && l.unitPrice >= 0) g += l.qty * l.unitPrice; });
      d.costs.forEach(function (c) { if (c.payTo === 'party') pc += c.amount; else cc += c.amount; });
      UI.clear(sum).appendChild(h('div', tot('جمع اقلام', UI.moneyT(g)), d.discount ? tot('تخفیف', UI.moneyT(d.discount)) : null,
        pc ? tot('هزینه روی فاکتور فروشنده', UI.moneyT(pc)) : null, tot(buy ? 'مبلغ بدهی به فروشنده' : 'مبلغ طلب از مشتری', UI.moneyT(g - d.discount + pc), true),
        cc ? tot('هزینه نقدی جداگانه', UI.moneyT(cc)) : null));
    }
    [disc.input].forEach(function (i) { i.addEventListener('input', calc); });
    var quick = null;
    if (v && !buy) { // sell from what this deal bought and has not sold yet
      var open = Object.keys(v.items).map(function (k) { return v.items[k]; }).filter(function (x) { return x.openQ > 0; });
      if (open.length) quick = h('div.chips', open.map(function (x) {
        return h('button.chip', { onclick: function () { addLine({ name: x.name, code: x.code, qty: x.openQ, productId: x.productId || null }); } }, x.name + ' (' + UI.fa(x.openQ) + ')');
      }));
    }
    var btn = h('button.btn.primary.block', { onclick: function () {
      if (!party) { UI.toast('طرف حساب را انتخاب کنید.', 'bad'); return; }
      var d = data(), ts, dd;
      if (!d.lines.length) { UI.toast('حداقل یک کالا وارد کنید.', 'bad'); return; }
      if (d.lines.some(function (l) { return !l.name || !(l.qty > 0) || l.unitPrice == null || isNaN(l.unitPrice); })) { UI.toast('نام، تعداد و قیمت هر ردیف را کامل کنید.', 'bad'); return; }
      var undecided = !buy && lines.filter(function (L) { return L.productId && L.refCost === undefined; })[0]; // v2.11: several purchase prices → asked, never picked by guess
      if (undecided) { UI.toast('برای «' + undecided.name.value.trim() + '» مشخص کنید کدام قیمت خرید برای سود برآوردی حساب شود.', 'bad'); undecided.el.scrollIntoView({ block: 'center' }); return; }
      try { ts = parseD(dt); dd = parseD(due, true); } catch (e) { return; }
      var pv = paid.value() || 0; if (isNaN(pv) || pv < 0) { UI.toast('مبلغ ' + (buy ? 'پرداخت‌شده' : 'دریافت‌شده') + ' نامعتبر است.', 'bad'); return; }
      // v2.8: a sold item that is not one of this deal's purchased items is asked, never linked by guess
      var bought = v ? Object.keys(v.items).map(function (k) { return v.items[k]; }).filter(function (x) { return x.boughtQ > 0; }) : [];
      var keyOf = function (l) { var c = Core.normSku(l.code || ''); return c ? 'c:' + c : 'n:' + Core.normText(l.name); };
      var miss = !buy && bought.length ? d.lines.filter(function (l) { return !bought.some(function (x) { return x.key === keyOf(l); }); }) : [];
      if (miss.length && !o.linkOk) { askLink(miss[0], bought, d); return; }
      confirmSummary(d, pv, function () { go(d, ts, dd, pv); });
    } }, 'ثبت ' + (buy ? 'خرید' : 'فروش'));
    function askLink(l, bought, d) {
      var sh = UI.sheet('این کالا همان کالای خرید است؟', h('div.stack',
        h('p', '«' + l.name + (l.code ? ' (' + l.code + ')' : '') + '» با هیچ‌کدام از کالاهای خریدِ این معامله دقیقاً یکی نیست. اگر همان کالاست انتخاب کنید؛ وگرنه سود این فروش «هنوز قطعی نیست» می‌ماند.'),
        bought.map(function (x) { return h('button.btn.block', { onclick: function () { var L = lines.filter(function (y) { return y.name.value.trim() === l.name && y.code.value.trim() === (l.code || ''); })[0]; if (L) { L.name.value = x.name; L.code.value = x.code || ''; L.productId = x.productId || null; L.draw(); } sh.close(); btn.click(); } }, 'همان «' + x.name + (x.code ? ' (' + x.code + ')' : '') + '»'); }),
        h('button.btn.block.ghost', { onclick: function () { o.linkOk = true; sh.close(); btn.click(); } }, 'کالای دیگری است (سود قطعی نمی‌شود)')));
    }
    function confirmSummary(d, pv, ok) { // v2.8: what will be recorded, in words, before posting
      var g = 0, pc = 0, cc = 0; d.lines.forEach(function (l) { g += l.qty * l.unitPrice; }); d.costs.forEach(function (c) { if (c.payTo === 'party') pc += c.amount; else cc += c.amount; });
      var tot = g - d.discount + pc, rest = tot - pv;
      if (pv > tot) { UI.toast('مبلغ ' + (buy ? 'پرداخت‌شده' : 'دریافت‌شده') + ' از جمع فاکتور بیشتر است.', 'bad'); return; }
      var lines2 = [buy ? 'این خرید وارد انبار نمی‌شود (موجودی و ارزش انبار تغییر نمی‌کند).' : 'این فروش از انبار کم نمی‌کند.',
        (buy ? 'جمع فاکتور فروشنده: ' : 'جمع فاکتور مشتری: ') + UI.moneyT(tot),
        (buy ? 'پرداخت‌شده الان: ' : 'دریافت‌شده الان: ') + UI.moneyT(pv),
        rest > 0 ? (buy ? 'بدهی شما به «' + party.name + '»: ' : 'طلب شما از «' + party.name + '»: ') + UI.moneyT(rest) : 'تسویه کامل',
        cc ? 'هزینه نقدی جداگانه (پرداخت‌شده): ' + UI.moneyT(cc) : null].filter(Boolean);
      var sh = UI.sheet('بررسی پیش از ثبت', h('div.stack', h('ul', lines2.map(function (t) { return h('li', t); })),
        h('div.grid2', h('button.btn', { onclick: function () { sh.close(); } }, 'برگشت و اصلاح'), h('button.btn.primary', { onclick: function () { sh.close(); ok(); } }, 'درست است، ثبت شود'))));
    }
    function go(d, ts, dd, pv) {
      btn.disabled = true;
      ctxRun(function (ctx, fl) { return function () {
        return E.postDealLeg({ opKey: key, dealId: o.dealId || null, title: title.value, side: side, partyId: party.id, ts: ts || undefined, invoiceNo: inv.value, lines: d.lines, discount: d.discount,
          costs: d.costs, dueDate: dd, note: note.value, pay: { amount: pv, method: mt.value, ref: ref.value }, duplicateOk: fl.duplicateOk }, ctx);
      }; }).then(function (r) { s.close(); UI.toast('ثبت شد (' + r.leg.no + ').', 'ok'); A.go('#/deal/' + r.leg.dealId); }, function () { btn.disabled = false; });
    }
    var s = UI.sheet((buy ? 'خرید مستقیم' : 'فروش مستقیم') + (v ? ' — ' + v.deal.no : ''), h('div.stack',
      h('div.alert.warn', buy ? 'خرید مستقیم: کالا وارد انبار نمی‌شود. برای خریدی که وارد انبار می‌شود از «ورود کالا» یا «فاکتور خرید» استفاده کنید.' : 'فروش مستقیم: از انبار کم نمی‌شود. برای فروش از انبار از «فروش / خروج» استفاده کنید.'), pbtn, o.dealId ? null : A.field('عنوان معامله', title),
      h('div.grid2', A.field('تاریخ', dt), A.field('شماره فاکتور', inv)), quick, box,
      h('button.btn.sm', { onclick: function () { addLine(); } }, '+ ردیف کالا'),
      A.field('تخفیف کل فاکتور', disc.input, disc.hint), h('div.sec-title', buy ? 'هزینه‌های خرید (حمل و…؛ جزء بهای کالا)' : 'هزینه‌های مستقیم فروش'), cbox,
      h('button.btn.sm', { onclick: addCost }, '+ هزینه'), sum,
      h('div.grid2', A.field(buy ? 'پرداخت‌شده همین حالا' : 'دریافت‌شده همین حالا', paid.input, h('div', paid.hint, h('div.hint', buy ? 'باقی‌مانده، بدهی شما به فروشنده می‌شود.' : 'باقی‌مانده، طلب شما از مشتری می‌شود.'))), A.field('روش', mt)), A.field('شماره پیگیری', ref),
      A.field('سررسید مانده', due, h('div.hint', 'برای گزارش «سررسید گذشته»')), A.field('توضیح', note), btn));
    drawParty(); if (!quick) addLine(); calc();
  }

  // ======================= deal page =======================
  A.routes.deal = function (id) {
    var v = E.dealView(id); if (!v) { view.appendChild(h('div.alert.bad', 'معامله پیدا نشد.')); return; }
    A.setTitle(v.deal.no, true);
    view.appendChild(h('div.card', h('div.row', h('b.grow', v.deal.title), badge(STATUS, v.status), badge(SETTLE, v.settle.status)),
      kv([['تاریخ', UI.dateFa(v.deal.ts)], ['درآمد فروش', UI.moneyT(v.income)], ['بهای کالای فروش‌رفته', v.cogs == null ? 'نامشخص' : UI.moneyT(v.cogs)],
        ['هزینه مستقیم فروش', UI.moneyT(v.direct)], ['سود', v.profit == null ? 'سود هنوز قطعی نیست' : UI.moneyT(v.profit)],
        v.profit == null && v.estProfit != null ? ['سود برآوردی', UI.moneyT(v.estProfit) + ' (با قیمت خرید ثبت‌شده کالا؛ با ثبت خرید واقعی قطعی می‌شود)'] : null, ['مانده تسویه', UI.moneyT(v.settle.remaining)],
        v.deal.note ? ['توضیح', v.deal.note] : null]),
      v.uncertain ? h('div.alert.warn', 'بخشی از فروش این معامله خرید مرتبط ندارد (یا بیش از خرید فروخته شده)؛ با «+ خرید» آن را تکمیل کنید.') : null,
      h('div.row', h('button.btn.sm', { onclick: function () { legForm({ side: 'buy', dealId: id }); } }, '+ خرید'), h('button.btn.sm.primary', { onclick: function () { legForm({ side: 'sell', dealId: id }); } }, '+ فروش'))));
    var items = Object.keys(v.items).map(function (k) { return v.items[k]; });
    view.appendChild(h('div.sec-title', 'کالاها (خارج از انبار)'));
    view.appendChild(h('div.table-wrap', h('table', h('thead', h('tr', ['کالا', 'خرید', 'فروش', 'مانده', 'بها', 'درآمد', 'بهای فروش‌رفته'].map(function (t) { return h('th', t); }))),
      h('tbody', items.map(function (x) {
        return h('tr', h('td', (x.productId && E.state.products[x.productId] ? h('a', { href: '#/product/' + x.productId }, x.name) : x.name), x.code ? ' (' + x.code + ')' : ''), h('td', UI.qty(x.boughtQ)), h('td', UI.qty(x.soldQ)), h('td', UI.qty(x.openQ)),
          h('td', UI.money(x.cost)), h('td', UI.money(x.income)), h('td', x.cogs == null ? 'نامشخص' : UI.money(x.cogs)));
      })))));
    view.appendChild(h('div.sec-title', 'ردیف‌ها (سابقه کامل؛ هیچ ردیفی حذف نمی‌شود)'));
    view.appendChild(h('div.list', v.legs.map(function (l) {
      var kind = l.type === 'cancel' ? 'ابطال ' + (l.refNo || '') : l.type === 'return' ? (l.side === 'buy' ? 'برگشت از خرید' : 'برگشت از فروش') : (l.side === 'buy' ? 'خرید' : 'فروش');
      var amt = l.type === 'cancel' ? '' : UI.money(l.type === 'return' ? l.net : l.payable);
      var acts = [];
      if (l.type === 'post' && !l.cancelled) {
        if (l.side === 'sell') acts.push(h('button.btn.sm.primary', { onclick: function () { legPdf(l); } }, 'PDF فاکتور')); // v2.11
        acts.push(h('button.btn.sm', { onclick: function () { returnForm(l); } }, 'برگشت'));
        if (l.remaining > 0) acts.push(h('button.btn.sm', { onclick: function () { entryForm(l.side === 'buy' ? 'payment' : 'receipt', l.partyType, l.partyId, { t: 'leg', id: l.id, amount: l.remaining }); } }, l.side === 'buy' ? 'پرداخت' : 'دریافت'));
      }
      if (l.type !== 'cancel' && !l.cancelled) acts.push(h('button.btn.sm.ghost', { onclick: function () { cancelForm(l); } }, 'ابطال'));
      return h('div.li', h('div.grow', h('div.t', l.no + ' · ' + kind + (l.invoiceNo ? ' · فاکتور ' + l.invoiceNo : '')),
        h('div.s', UI.dateFa(l.ts) + ' · ' + (l.party ? l.party.name : '—') + (amt ? ' · ' + amt : '') + (l.type === 'post' && !l.cancelled ? ' · مانده ' + UI.money(l.remaining) : '') + (l.reason ? ' · ' + l.reason : '') + (l.cancelled ? ' · ابطال‌شده با ' + l.cancelNo : '')),
        acts.length ? h('div.row', acts) : null));
    })));
  };
  function returnForm(l) {
    var key = UI.opKey('dlr'), qs = l.lines.map(function (L) { return h('input.in', { inputmode: 'numeric', placeholder: '۰ از ' + UI.fa(L.qty) }); }), why = h('input.in', { placeholder: 'علت' }), dt = dateIn(UI.todayStr());
    var btn = h('button.btn.primary.block', { onclick: function () {
      var ts; try { ts = parseD(dt); } catch (e) { return; }
      var ln = qs.map(function (q, i) { return { line: i, qty: UI.parseNum(q.value) || 0 }; }).filter(function (x) { return x.qty > 0; });
      if (!ln.length) { UI.toast('تعداد برگشتی را وارد کنید.', 'bad'); return; }
      btn.disabled = true;
      ctxRun(function (ctx) { return function () { return E.returnDealLeg({ opKey: key, legId: l.id, ts: ts || undefined, lines: ln, reason: why.value }, ctx); }; })
        .then(function () { s.close(); UI.toast('برگشت ثبت شد.', 'ok'); A.route(); }, function () { btn.disabled = false; });
    } }, 'ثبت برگشت');
    var s = UI.sheet('برگشت از ' + l.no, h('div.stack', h('p.small.muted', 'مبلغ برگشت = سهم خالص همان ردیف (پس از تخفیف). هزینه‌های پرداخت‌شده برنمی‌گردند.'),
      l.lines.map(function (L, i) { return A.field(L.name + ' — ' + UI.fa(L.qty) + ' × ' + UI.money(L.unitPrice), qs[i]); }), A.field('تاریخ', dt), A.field('علت', why), btn));
  }
  function cancelForm(l) {
    UI.promptBox('ابطال ' + l.no, 'علت ابطال (الزامی). ردیف حذف نمی‌شود؛ یک ردیف ابطال با تاریخ امروز ثبت می‌شود و پرداخت/هزینه ثبت‌شده همراه آن هم برمی‌گردد.').then(function (why) {
      if (!why || !String(why).trim()) return;
      var key = UI.opKey('dlx');
      withManager('ابطال ردیف معامله', function (ctx) { return E.cancelDealLeg({ opKey: key, legId: l.id, reason: why }, ctx); }).then(function (r) { if (r) { UI.toast('ابطال ثبت شد.', 'ok'); A.route(); } }, function () {});
    });
  }

  // ======================= party accounts =======================
  A.routes.parties = function (arg, q) {
    var t = q && q.t === 'supplier' ? 'supplier' : 'customer';
    A.setTitle('حساب اشخاص', true);
    var s = h('input.in', { type: 'search', placeholder: 'جستجوی نام یا تلفن…', value: A.lsGet('ay.partyQ') || '' }), list = h('div.list');
    view.appendChild(h('div.chips', h('a.chip' + (t === 'customer' ? '.on' : ''), { href: '#/parties?t=customer' }, 'مشتریان'), h('a.chip' + (t === 'supplier' ? '.on' : ''), { href: '#/parties?t=supplier' }, 'تأمین‌کنندگان')));
    view.appendChild(h('div.chips', [['debtors', 'بدهکاران'], ['creditors', 'بستانکاران'], ['overdueRec', 'دریافتنی سررسیدگذشته'], ['overduePay', 'پرداختنی سررسیدگذشته']].map(function (x) {
      return h('a.chip', { href: '#/party-report/' + x[0] }, x[1]);
    })));
    view.appendChild(s); view.appendChild(list);
    function draw() {
      A.lsSet('ay.partyQ', s.value); UI.clear(list);
      var r = E.partyList(t, s.value);
      if (!r.length) list.appendChild(h('div.empty', 'موردی نیست.'));
      r.slice(0, 200).forEach(function (x) { list.appendChild(h('a.li', { href: '#/party/' + x.id + '?t=' + t }, h('div.grow', h('div.t', x.name), h('div.s.ltr', x.phone || '')), balBadge(x.balance))); });
    }
    s.addEventListener('input', draw); draw();
  };
  A.routes['party-report'] = function (kind) {
    var T = { debtors: 'بدهکاران (طلب ما)', creditors: 'بستانکاران (بدهی ما)', overdueRec: 'دریافتنی‌های سررسیدگذشته', overduePay: 'پرداختنی‌های سررسیدگذشته' };
    if (!T[kind]) kind = 'debtors';
    A.setTitle(T[kind], true);
    var r = E.partyReport(kind), over = kind === 'overdueRec' || kind === 'overduePay';
    var total = r.reduce(function (s, x) { return s + (over ? x.overdue : Math.abs(x.balance)); }, 0);
    view.appendChild(h('div.card', tot('جمع', UI.moneyT(total), true), h('button.btn.sm', { onclick: function () {
      csv([['نوع', 'نام', 'تلفن', 'مانده حساب', over ? 'مبلغ سررسیدگذشته' : ''].filter(Boolean)].concat(r.map(function (x) {
        return [PT[x.partyType], x.name, x.phone, x.balance].concat(over ? [x.overdue] : []);
      })), 'party-' + kind);
    } }, 'CSV')));
    if (!r.length) { view.appendChild(h('div.card.empty', 'موردی نیست.')); return; }
    view.appendChild(h('div.list', r.map(function (x) {
      return h('a.li', { href: '#/party/' + x.id + '?t=' + x.partyType }, h('div.grow', h('div.t', x.name + ' · ' + PT[x.partyType]),
        h('div.s', over ? x.items.map(function (o) { return o.no + ' سررسید ' + UI.dateFa(o.dueDate) + ': ' + UI.money(o.remaining); }).join(' · ') : balTxt(x.balance))),
        over ? h('span.badge.bad', UI.money(x.overdue)) : balBadge(x.balance));
    })));
  };
  A.routes.party = function (id, q) {
    var t = q && q.t === 'supplier' ? 'supplier' : 'customer', p = E.state[t === 'customer' ? 'customers' : 'suppliers'][id];
    if (!p) { view.appendChild(h('div.alert.bad', 'طرف حساب پیدا نشد.')); return; }
    A.setTitle(p.name, true);
    var bal = E.partyBalance(t, id), credit = E.partyCredit(t, id), items = E.partyOpenItems(t, id).filter(function (o) { return o.remaining > 0; });
    var acts = [
      h('button.btn.sm.primary', { onclick: function () { entryForm('receipt', t, id); } }, 'دریافت'),
      h('button.btn.sm.primary', { onclick: function () { entryForm('payment', t, id); } }, 'پرداخت'),
      h('button.btn.sm', { onclick: function () { openingForm(t, id); } }, 'مانده اول دوره'),
      t === 'supplier' ? h('button.btn.sm', { onclick: function () { billForm(id); } }, 'بدهی فاکتور خرید انبار') : null,
      credit > 0 ? h('button.btn.sm', { onclick: function () { entryForm('settle', t, id); } }, 'تسویه از پیش‌پرداخت') : null,
      h('button.btn.sm.ghost', { onclick: function () { adjustForm(t, id); } }, 'تعدیل (مدیر)')];
    view.appendChild(h('div.card', h('div.row', h('b.grow', PT[t]), balBadge(bal)), kv([['مانده حساب', balTxt(bal)], credit ? ['پیش‌پرداخت / بستانکاری آزاد', UI.moneyT(credit)] : null, p.phone ? ['تلفن', p.phone] : null]),
      h('p.small.muted', 'مانده حساب ≠ سود و زیان ≠ جریان نقد ≠ موجودی انبار.'), h('div.row.wrap', acts)));
    view.appendChild(h('div.sec-title', 'اقلام باز (فاکتورها و بدهی‌های تسویه‌نشده)'));
    if (!items.length) view.appendChild(h('div.card.empty', 'قلم بازی نیست.'));
    else view.appendChild(h('div.list', items.map(function (o) {
      return h('div.li', h('div.grow', h('div.t', o.no + ' · ' + o.desc + (o.dir > 0 ? ' (طلب ما)' : ' (بدهی ما)')),
        h('div.s', UI.dateFa(o.ts) + (o.dueDate ? ' · سررسید ' + UI.dateFa(o.dueDate) : '') + ' · مبلغ ' + UI.money(o.amount) + ' · مانده ' + UI.money(o.remaining))),
        o.overdue ? h('span.badge.bad', 'سررسید گذشته') : badge(SETTLE, o.status));
    })));
    // statement (v2.11: one block per invoice with its payments; cancelled pairs in their own section; PDF for the customer)
    var st = A.lsGet('ay.stmt') || {}, from = dateIn(st.from || ''), to = dateIn(st.to || ''), box = h('div');
    view.appendChild(h('div.sec-title', 'صورت‌حساب'));
    view.appendChild(h('div.card', h('div.grid2', A.field('از تاریخ', from), A.field('تا تاریخ', to)), h('div.row.wrap', h('button.btn.sm.primary', { onclick: draw }, 'نمایش'),
      h('button.btn.sm', { onclick: function () { var r = stmt(); if (r) stmtPdf(p, t, r, from.value.trim(), to.value.trim()); } }, 'PDF برای ' + (t === 'customer' ? 'مشتری' : 'تأمین‌کننده')),
      h('button.btn.sm', { onclick: function () { var r = stmt(); if (!r) return; csv([['تاریخ', 'نوع سند', 'شماره', 'شرح', 'مرجع', 'بدهکار', 'بستانکار', 'مانده', 'وضعیت']].concat([['', '', '', 'مانده از قبل', '', '', '', r.opening, '']],
        r.live.map(function (x) { return [UI.dateFa(x.ts), x.type, x.no, x.desc, x.ref, x.debit, x.credit, x.bal, '']; }),
        (A.lsGet('ay.showVoid') === true ? r.voided : []).map(function (x) { return [UI.dateFa(x.ts), x.type, x.no, x.desc, x.ref, x.debit, x.credit, '', 'باطل‌شده (در جمع نیست)']; })), 'statement-' + p.name); } }, 'CSV'))));
    view.appendChild(box);
    function stmt() { var f, tt; try { f = parseD(from); tt = parseD(to, true); } catch (e) { return null; } st.from = from.value.trim(); st.to = to.value.trim(); A.lsSet('ay.stmt', st); return stmtModel(E.partyStatement(t, id, { from: f, to: tt })); }
    function draw() {
      var r = stmt(); if (!r) return; UI.clear(box);
      box.appendChild(h('div.card', tot('مانده اول دوره', balTxt(r.opening)), tot('جمع بدهکار', UI.moneyT(r.debit)), tot('جمع بستانکار', UI.moneyT(r.credit)), tot('مانده پایان دوره', balTxt(r.closing), true),
        r.mismatch ? h('div.alert.bad', 'اختلاف در محاسبه مانده؛ گزارش را به پشتیبانی بدهید.') : null));
      if (!r.blocks.length) box.appendChild(h('div.card.empty', 'در این بازه گردشی نیست.'));
      r.blocks.slice().reverse().forEach(function (b) {
        box.appendChild(h('div.card', { style: { padding: '10px 12px' } },
          h('div.row', h('div.grow', h('b', b.title), h('div.small.muted', b.sub)), b.link ? h('a.btn.sm', { href: b.link }, 'باز کردن') : null),
          b.items.length ? h('div.small', { style: { margin: '4px 0' } }, b.items.map(function (it) { return it.name + ' × ' + UI.fa(it.qty) + (it.unitPrice != null ? ' @ ' + UI.money(it.unitPrice) : ''); }).join(' · ')) : null,
          b.rows.map(function (x) { // phone layout: date · type · number / description — amount (بد / بس) and the running balance
            var rev = x.src === 'ledger' && x.kind !== 'reversal' && x.kind !== 'expense' && !x.reversed;
            return h('div.line', { style: { padding: '8px 0' } }, h('div.row', { style: { alignItems: 'flex-start' } },
              h('div.grow', h('div.small.muted', UI.dateFa(x.ts) + ' · ' + x.type + ' · ' + x.no), h('div.small', x.desc + (x.ref ? ' · ' + x.ref : '')),
                rev ? h('button.btn.sm.ghost', { style: { marginTop: '4px' }, onclick: function () { reverseForm(x); } }, 'ابطال') : null),
              h('div', { style: { textAlign: 'left', whiteSpace: 'nowrap' } }, h('b', { style: { color: x.debit ? 'var(--bad)' : 'var(--ok)' } }, x.debit ? 'بد ' + UI.money(x.debit) : 'بس ' + UI.money(x.credit)),
                h('div.small.muted', 'مانده ' + (x.bal > 0 ? UI.money(x.bal) + ' بد' : x.bal < 0 ? UI.money(-x.bal) + ' بس' : '۰')))));
          }),
          h('div.tot', h('span', 'مانده پس از این سند'), h('b', balTxt(b.end)))));
      });
      if (r.voided.length) box.appendChild(h('label.check', { style: { margin: '6px 4px' } }, (function () { var cb = h('input', { type: 'checkbox', checked: A.lsGet('ay.showVoid') === true }); cb.addEventListener('change', function () { A.lsSet('ay.showVoid', cb.checked); draw(); }); return cb; })(),
        'نمایش اسناد باطل‌شده (' + UI.fa(r.vblocks.length) + ') در صفحه، PDF و CSV'));
      if (r.voided.length && A.lsGet('ay.showVoid') === true) box.appendChild(h('details.card', h('summary', 'باطل‌شده‌ها (' + UI.fa(r.vblocks.length) + ') — در جمع‌ها و مانده اثری ندارند'),
        r.vblocks.map(function (b) { return h('div.line', h('div.row', h('b.grow', b.title), h('span.small.muted', b.sub)),
          b.rows.map(function (x) { return h('div.small', UI.dateFa(x.ts) + ' · ' + x.type + ' · ' + x.no + ' · ' + (x.debit ? 'بد ' + UI.money(x.debit) : 'بس ' + UI.money(x.credit))); })); })));
    }
    draw();
  };
  /* v2.11 statement model (UI only; the engine is unchanged): rows of a cancelled document + its cancelling row that sum to 0 inside the range
     go to «باطل‌شده‌ها»; the running balance is recomputed over the rest — opening and closing stay exactly the engine's. */
  function rowType(x) {
    var S = E.state;
    if (x.src === 'sale') return x.refId === x.docId ? (x.amount >= 0 ? 'فاکتور فروش' : 'ابطال فاکتور') : /^ابطال/.test(x.desc) ? 'ابطال مرجوعی' : 'مرجوعی';
    if (x.src === 'payment') return x.amount <= 0 ? 'دریافت' : 'بازپرداخت';
    if (x.src === 'deal') { var g = S.deals[x.refId]; if (!g) return 'معامله'; return g.type === 'cancel' ? 'ابطال' : g.type === 'return' ? 'برگشت' : g.side === 'sell' ? 'فروش مستقیم' : 'خرید مستقیم'; }
    return (E.LG_KINDS && E.LG_KINDS[x.kind]) || x.kind || '';
  }
  function rootLeg(g) { var S = E.state.deals, n = 0; while (g && g.type !== 'post' && g.refLegId && n++ < 5) g = S[g.refLegId]; return g; }
  function blockKey(x) {
    var S = E.state;
    if (x.combo) return 'combo:' + x.combo;
    if (x.src === 'sale' || x.src === 'payment') return 'sale:' + x.docId;
    if (x.src === 'deal') { var g = rootLeg(S.deals[x.refId]); return 'leg:' + (g ? g.id : x.refId); }
    var e = S.ledger[x.refId]; if (e && e.kind === 'reversal' && S.ledger[e.reverses]) e = S.ledger[e.reverses];
    if (e) {
      var lg = e.legId || (e.alloc && e.alloc.length === 1 && e.alloc[0].t === 'leg' ? e.alloc[0].id : null);
      if (lg && S.deals[lg]) { var r = rootLeg(S.deals[lg]); return 'leg:' + (r ? r.id : lg); }
      if (e.alloc && e.alloc.length === 1 && e.alloc[0].t === 'sale') return 'sale:' + e.alloc[0].id;
    }
    return 'ledger:' + x.refId;
  }
  function blockHead(key, first) {
    var S = E.state, i = key.indexOf(':'), k = key.slice(0, i), id = key.slice(i + 1), o = { title: first.desc, sub: UI.dateFa(first.ts), items: [], link: null };
    if (k === 'combo') {
      var w = E.mixedView(id); if (w) { o.title = 'فاکتور ' + w.invoiceNo + (w.status === 'cancelled' ? ' (باطل)' : ''); o.sub = UI.dateFa(w.ts) + (w.orderId ? ' · سفارش ' + w.orderId : '') + (w.channel ? ' (' + w.channel + ')' : '');
        o.items = w.lines.map(function (l) { return { name: l.name, qty: l.qty, unitPrice: l.unitPrice }; }); o.link = '#/mix/' + id; }
    } else if (k === 'sale') {
      var d = S.docs[id]; if (d) { o.title = 'فاکتور فروش ' + (d.invoiceNo || d.no) + (d.status === 'reversed' ? ' (باطل)' : ''); o.sub = UI.dateFa(d.ts);
        o.items = (d.lines || []).map(function (l) { return { name: l.name, qty: l.qty, unitPrice: l.unitPrice }; }); o.link = '#/doc/' + id; }
    } else if (k === 'leg') {
      var g = S.deals[id]; if (g) { var cx = Object.keys(S.deals).some(function (z) { var y = S.deals[z]; return y.rt === 'leg' && y.type === 'cancel' && y.refLegId === g.id; });
        o.title = (g.side === 'sell' ? 'فاکتور فروش مستقیم ' : 'فاکتور خرید مستقیم ') + (g.invoiceNo || g.no) + (cx ? ' (باطل)' : ''); o.sub = UI.dateFa(g.ts) + ' · ' + g.no;
        o.items = (g.lines || []).map(function (l) { return { name: l.name, qty: l.qty, unitPrice: l.unitPrice }; }); o.link = '#/deal/' + g.dealId; }
    } else { o.title = first.type + ' ' + first.no; }
    return o;
  }
  function blocksOf(rows) {
    var order = [], map = {};
    rows.forEach(function (x) { var k = blockKey(x), b = map[k]; if (!b) { b = map[k] = { key: k, rows: [], debit: 0, credit: 0 }; order.push(b); } b.rows.push(x); b.debit += x.debit; b.credit += x.credit; });
    order.forEach(function (b) { Object.assign(b, blockHead(b.key, b.rows[0])); b.end = b.rows[b.rows.length - 1].bal; });
    return order;
  }
  function stmtModel(r) {
    var vg = {}, hide = {};
    r.rows.forEach(function (x) { x.type = rowType(x); if (x.voided) (vg[x.voidKey] = vg[x.voidKey] || []).push(x); });
    Object.keys(vg).forEach(function (k) { if (vg[k].length > 1 && vg[k].reduce(function (s2, x) { return s2 + x.amount; }, 0) === 0) hide[k] = 1; });
    var live = [], voided = [], run = r.opening, dr = 0, cr = 0;
    r.rows.forEach(function (x) {
      if (x.voided && hide[x.voidKey]) { voided.push(x); return; }
      run += x.amount; dr += x.debit; cr += x.credit; live.push(Object.assign({}, x, { bal: run }));
    });
    return { party: r.party, partyType: r.partyType, opening: r.opening, closing: r.closing, mismatch: run !== r.closing, debit: dr, credit: cr, live: live, voided: voided,
      blocks: blocksOf(live), vblocks: blocksOf(voided.map(function (x) { return Object.assign({}, x, { bal: null }); })) };
  }
  function stmtPdf(p, t, r, fromS, toS) {
    var shop = A.shop(), blocks = [{ type: 'title', text: 'صورت‌حساب ' + (t === 'customer' ? 'مشتری' : 'تأمین‌کننده'), sub: shop.name || 'امیران یدک', left: [shop.phone, shop.address].filter(Boolean) }];
    blocks.push({ type: 'kv', cols: 2, items: [['نام', p.name], ['تلفن', p.phone || '—'], ['از تاریخ', fromS || 'ابتدا'], ['تا تاریخ', toS || UI.dateFa(Date.now())],
      ['مانده اول دوره', balTxt(r.opening)], ['مانده پایان دوره', balTxt(r.closing)], ['جمع بدهکار', UI.moneyT(r.debit)], ['جمع بستانکار', UI.moneyT(r.credit)]] });
    var cols = [{ label: 'تاریخ', w: 1 }, { label: 'نوع سند', w: 1.1 }, { label: 'شماره', w: 1 }, { label: 'شرح', w: 3, wrap: true }, { label: 'بدهکار', w: 1, align: 'center' }, { label: 'بستانکار', w: 1, align: 'center' }, { label: 'مانده', w: 1.3, align: 'center' }];
    var bal = function (b) { return b > 0 ? UI.money(b) + ' بد' : b < 0 ? UI.money(-b) + ' بس' : '۰'; };
    blocks.push({ type: 'table', columns: cols, rows: [['', '', '', 'مانده از قبل', '', '', bal(r.opening)]] });
    r.blocks.forEach(function (b) {
      blocks.push({ type: 'band', level: 2, text: b.title, right: b.sub, thead: cols });
      if (b.items.length) blocks.push({ type: 'text', size: 2.8, color: '#333', text: 'اقلام: ' + b.items.map(function (it) { return it.name + ' × ' + UI.fa(it.qty) + (it.unitPrice != null ? ' (فی ' + UI.money(it.unitPrice) + ')' : ''); }).join('، ') });
      blocks.push({ type: 'table', columns: cols, header: false, rows: b.rows.map(function (x) { return [UI.dateFa(x.ts), x.type, x.no, x.desc + (x.ref ? ' · ' + x.ref : ''), x.debit ? UI.money(x.debit) : '', x.credit ? UI.money(x.credit) : '', bal(x.bal)]; }) });
    });
    blocks.push({ type: 'kv', cols: 2, items: [['جمع بدهکار', UI.moneyT(r.debit)], ['جمع بستانکار', UI.moneyT(r.credit)], ['مانده اول دوره', balTxt(r.opening)], ['مانده پایان دوره', balTxt(r.closing)]] });
    if (r.voided.length && A.lsGet('ay.showVoid') === true) { // v2.13: only when the user wants them
      blocks.push({ type: 'band', level: 1, text: 'باطل‌شده‌ها — در جمع‌ها و مانده حساب نشده‌اند' });
      blocks.push({ type: 'table', columns: cols.slice(0, 6), rows: r.voided.map(function (x) { return [UI.dateFa(x.ts), x.type, x.no, x.desc, x.debit ? UI.money(x.debit) : '', x.credit ? UI.money(x.credit) : '']; }) });
    }
    A.accountBlocks().forEach(function (b) { blocks.push(b); });
    UI.toast('در حال ساخت PDF…');
    window.PDF.renderFlow(blocks, { title: 'صورت‌حساب ' + p.name, footer: shop.name || '' }).then(function (pdf) { UI.fileSheet(pdf, 'statement-' + p.name + '.pdf', 'application/pdf'); }, A.showErr);
  }
  /* v2.11 customer copy of a direct sale (no purchase price, no profit, no supplier) */
  function legPdf(l) {
    var shop = A.shop(), c = E.state.customers[l.partyId], sub = 0;
    var blocks = [{ type: 'title', text: 'فاکتور فروش', sub: shop.name || 'امیران یدک', left: [shop.phone, shop.address].filter(Boolean) },
      { type: 'kv', cols: 2, items: [['شماره', l.invoiceNo || l.no], ['تاریخ', UI.dateFa(l.ts, true)], ['مشتری', c ? c.name : '—'], ['تلفن', c && c.phone || '—']] },
      { type: 'table', columns: [{ label: 'ردیف', w: 0.5, align: 'center' }, { label: 'کد', w: 1.1 }, { label: 'شرح کالا', w: 3, wrap: true }, { label: 'تعداد', w: 0.7, align: 'center' }, { label: 'فی (تومان)', w: 1.2, align: 'center' }, { label: 'مبلغ (تومان)', w: 1.3, align: 'center' }],
        rows: l.lines.map(function (x, i) { var a = x.qty * x.unitPrice; sub += a; return [UI.fa(i + 1), x.code || '', x.name, UI.qty(x.qty), UI.money(x.unitPrice), UI.money(a)]; }) }];
    var ret = Math.max(0, l.payable - l.open);
    blocks.push({ type: 'kv', cols: 2, items: [['جمع اقلام', UI.moneyT(sub)], ['تخفیف', UI.moneyT(l.discount || 0)], ['مبلغ این فاکتور', UI.moneyT(l.payable)]].concat(ret ? [['برگشتی', UI.moneyT(ret)]] : [])
      .concat([['دریافت‌شده', UI.moneyT(Math.min(l.allocated || 0, l.open))], ['مانده این فاکتور', UI.moneyT(l.remaining)]]).concat(l.dueDate ? [['سررسید', UI.dateFa(l.dueDate)]] : []) });
    if (!l.cancelled) A.balanceBlocks(A.accountAt('customer', l.partyId, l.ts)).forEach(function (b) { blocks.push(b); }); // v2.13.1: the customer's whole account
    A.accountBlocks().forEach(function (b) { blocks.push(b); });
    if (shop.invoiceNote) blocks.push({ type: 'text', text: shop.invoiceNote, size: 2.9, color: '#444' });
    if (l.note) blocks.push({ type: 'text', text: 'توضیحات: ' + l.note, size: 3 });
    UI.toast('در حال ساخت PDF…');
    window.PDF.renderFlow(blocks, { title: 'فاکتور فروش ' + (l.invoiceNo || l.no), footer: shop.name || '' }).then(function (pdf) { UI.fileSheet(pdf, (l.invoiceNo || l.no) + '.pdf', 'application/pdf'); }, A.showErr);
  }
  function reverseForm(x) {
    UI.promptBox('ابطال ' + x.no, 'علت ابطال (الزامی). تراکنش حذف نمی‌شود؛ یک ابطال با تاریخ امروز ثبت می‌شود.').then(function (why) {
      if (!why || !String(why).trim()) return;
      var key = UI.opKey('lgx');
      withManager('ابطال تراکنش حساب', function (ctx) { return E.reversePartyEntry({ opKey: key, entryId: x.refId, reason: why }, ctx); }).then(function (r) { if (r) { UI.toast('ابطال ثبت شد.', 'ok'); A.route(); } }, function () {});
    });
  }
  /* receipt / payment / settle with automatic (oldest first) or manual allocation */
  function entryForm(kind, t, id, pre) {
    var key = UI.opKey('lg'), dir = kind === 'receipt' ? 1 : kind === 'payment' ? -1 : (t === 'customer' ? 1 : -1);
    var items = E.partyOpenItems(t, id).filter(function (o) { return o.dir === dir && o.remaining > 0; });
    var credit = kind === 'settle' ? E.partyCredit(t, id) : null;
    var am = A.moneyInput(pre ? pre.amount : credit != null ? Math.min(credit, items.reduce(function (s, o) { return s + o.remaining; }, 0)) : null, 'مبلغ');
    var mt = methodSel(), ref = h('input.in', { placeholder: 'شماره پیگیری / چک' }), note = h('input.in', { placeholder: 'توضیح' }), dt = dateIn(UI.todayStr());
    var mode = pre ? 'manual' : null, inputs = {}; // v2.8: no default — the user says what the money is for
    var allocBox = h('div.stack');
    function drawAlloc() {
      UI.clear(allocBox);
      allocBox.appendChild(h('div.chips', h('button.chip' + (mode === 'auto' ? '.on' : ''), { onclick: function () { mode = 'auto'; drawAlloc(); } }, 'خودکار (قدیمی‌ترین اول)'),
        h('button.chip' + (mode === 'manual' ? '.on' : ''), { onclick: function () { mode = 'manual'; drawAlloc(); } }, 'انتخاب دستی'),
        kind !== 'settle' ? h('button.chip' + (mode === 'none' ? '.on' : ''), { onclick: function () { mode = 'none'; drawAlloc(); } }, 'پیش‌پرداخت (بدون تسویه)') : null));
      if (mode === 'manual') items.forEach(function (o) {
        var k = o.t + ':' + o.id, mi = inputs[k] || (inputs[k] = A.moneyInput(pre && pre.t === o.t && pre.id === o.id ? pre.amount : null, 'تا ' + UI.money(o.remaining)));
        allocBox.appendChild(A.field(o.no + ' · ' + o.desc + ' · مانده ' + UI.money(o.remaining) + (o.overdue ? ' · سررسید گذشته' : ''), mi.input, mi.hint));
      });
      if (!items.length) allocBox.appendChild(h('p.small.muted', 'قلم بازی برای تسویه نیست؛ مبلغ به‌عنوان پیش‌پرداخت / بستانکاری ثبت می‌شود.'));
    }
    var btn = h('button.btn.primary.block', { onclick: function () {
      var n = am.value(); if (!(n > 0)) { UI.toast('مبلغ را وارد کنید.', 'bad'); return; }
      if (!mode && items.length) { UI.toast('مشخص کنید این مبلغ بابت کدام فاکتور است (خودکار، دستی یا پیش‌پرداخت).', 'bad'); return; }
      if (!mode) mode = 'none';
      var ts; try { ts = parseD(dt); } catch (e) { return; }
      var alloc = mode === 'auto' ? 'auto' : mode === 'none' ? [] : items.map(function (o) { var mi = inputs[o.t + ':' + o.id]; return { t: o.t, id: o.id, amount: mi ? mi.value() || 0 : 0 }; }).filter(function (a) { return a.amount > 0; });
      btn.disabled = true;
      ctxRun(function (ctx) { return function () {
        return E.postPartyEntry({ opKey: key, kind: kind, partyType: t, partyId: id, amount: n, method: mt.value, ref: ref.value, note: note.value, ts: ts || undefined, alloc: alloc, dir: kind === 'settle' ? dir : undefined }, ctx);
      }; }).then(function (r) { s.close(); UI.toast('ثبت شد (' + r.entry.no + ').', 'ok'); A.route(); }, function () { btn.disabled = false; });
    } }, 'ثبت');
    var s = UI.sheet((kind === 'receipt' ? 'دریافت از ' : kind === 'payment' ? 'پرداخت به ' : 'تسویه از پیش‌پرداخت — ') + partyName(t, id), h('div.stack',
      credit != null ? h('p.small.muted', 'پیش‌پرداخت / بستانکاری آزاد: ' + UI.moneyT(credit)) : null,
      A.field('مبلغ', am.input, am.hint), kind !== 'settle' ? h('div.grid2', A.field('روش', mt), A.field('تاریخ', dt)) : A.field('تاریخ', dt),
      kind !== 'settle' ? A.field('شماره پیگیری', ref) : null, A.field('توضیح', note), h('div.sec-title', 'بابت (تسویه کدام فاکتور)'), allocBox, btn));
    drawAlloc();
  }
  A.partyEntry = entryForm; // v2.11: the customer page receives money through the same form (any open item, or advance)
  function openingForm(t, id) {
    var key = UI.opKey('lgo'), am = A.moneyInput(null, 'مبلغ'), d = A.sel({ '1': 'او به ما بدهکار است', '-1': 'ما به او بدهکاریم' }, t === 'supplier' ? '-1' : '1'), dt = dateIn(UI.todayStr()), due = dateIn('', 'اختیاری'), note = h('input.in');
    var btn = h('button.btn.primary.block', { onclick: function () {
      var n = am.value(), ts, dd; if (!(n > 0)) { UI.toast('مبلغ را وارد کنید.', 'bad'); return; }
      try { ts = parseD(dt); dd = parseD(due, true); } catch (e) { return; }
      btn.disabled = true;
      ctxRun(function (ctx) { return function () { return E.postPartyEntry({ opKey: key, kind: 'opening', partyType: t, partyId: id, amount: n, dir: +d.value, ts: ts || undefined, dueDate: dd, note: note.value }, ctx); }; })
        .then(function () { s.close(); UI.toast('ثبت شد.', 'ok'); A.route(); }, function () { btn.disabled = false; });
    } }, 'ثبت مانده اول دوره');
    var s = UI.sheet('مانده اول دوره — ' + partyName(t, id), h('div.stack', A.field('مبلغ', am.input, am.hint), A.field('جهت', d), h('div.grid2', A.field('تاریخ', dt), A.field('سررسید', due)), A.field('توضیح', note), btn));
  }
  function adjustForm(t, id) {
    var key = UI.opKey('lga'), am = A.moneyInput(null, 'مبلغ'), d = A.sel({ '1': 'افزایش طلب ما (بدهکار کردن)', '-1': 'کاهش طلب / افزایش بدهی ما (بستانکار کردن)' }, '-1'), why = h('input.in', { placeholder: 'علت (الزامی)' });
    var btn = h('button.btn.danger.block', { onclick: function () {
      var n = am.value(); if (!(n > 0) || !why.value.trim()) { UI.toast('مبلغ و علت را وارد کنید.', 'bad'); return; }
      A.manager('تعدیل مانده حساب').then(function (ctx) { if (!ctx) return;
        A.run(function () { return E.postPartyEntry({ opKey: key, kind: 'adjust', partyType: t, partyId: id, amount: n, dir: +d.value, note: why.value }, ctx); }).then(function () { s.close(); UI.toast('تعدیل ثبت شد.', 'ok'); A.route(); }, function () {});
      });
    } }, 'ثبت تعدیل با رمز مدیر');
    var s = UI.sheet('تعدیل مانده — ' + partyName(t, id), h('div.stack', h('p.small.muted', 'فقط برای اصلاح اختلاف‌های کوچک؛ برای خرید/فروش/پرداخت از فرم خودشان استفاده کنید.'), A.field('مبلغ', am.input, am.hint), A.field('جهت', d), A.field('علت', why, null, true), btn));
  }
  /* a stocked purchase (ورود کالا / فاکتور خرید) bought on credit -> the supplier's purchase debt */
  function billForm(id) {
    var docs = E.allDocs().filter(function (d) { return d.kind === 'in' && d.status !== 'reversed' && (!d.supplierId || d.supplierId === id); }).reverse().slice(0, 60);
    var key = UI.opKey('lgb'), pick = A.sel(docs.reduce(function (o, d) { o[d.id] = d.no + (d.supplierDocNo ? ' · فاکتور ' + d.supplierDocNo : '') + ' · ' + UI.dateFa(d.ts); return o; }, { '': 'انتخاب سند ورود…' }), '');
    var am = A.moneyInput(null, 'مبلغ بدهی'), due = dateIn('', 'اختیاری');
    var btn = h('button.btn.primary.block', { onclick: function () {
      var n = am.value(), dd; if (!pick.value || !(n > 0)) { UI.toast('سند و مبلغ را وارد کنید.', 'bad'); return; }
      try { dd = parseD(due, true); } catch (e) { return; }
      btn.disabled = true;
      ctxRun(function (ctx) { return function () { return E.postPartyEntry({ opKey: key, kind: 'bill', partyType: 'supplier', partyId: id, amount: n, docId: pick.value, dueDate: dd }, ctx); }; })
        .then(function () { s.close(); UI.toast('بدهی خرید ثبت شد.', 'ok'); A.route(); }, function () { btn.disabled = false; });
    } }, 'ثبت بدهی');
    var s = UI.sheet('بدهی فاکتور خرید انبار', h('div.stack', h('p.small.muted', 'برای خریدی که کالایش وارد انبار شده و نسیه است. بهای کالا قبلاً در انبار ثبت شده؛ این فقط بدهی به فروشنده است و هزینه دوباره نمی‌سازد.'),
      docs.length ? A.field('سند ورود', pick) : h('div.alert.warn', 'سند ورودی برای این تأمین‌کننده نیست.'), A.field('مبلغ بدهی', am.input, am.hint), A.field('سررسید', due), btn));
  }
})();
