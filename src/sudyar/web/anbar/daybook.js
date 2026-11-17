/* v2.13 «دفتر روزانه» — daily cash close: the opening and closing balance of every money place (cash box + bank accounts),
   what the app itself recorded that day (receipts / payments), and the user's own rows (expenses / incomes by group) until
   the difference is zero. Personal groups (روزمره، سیگار، آموزش …) never enter the shop's profit. Nothing is guessed: a group is
   only SUGGESTED from earlier rows; the opening balance is only SUGGESTED from yesterday's close — the user confirms.
   Stored in the existing meta store ('dbk:<yyyymmdd>', 'dbkCats', 'dbkLearn', 'dbkPrefs') — no schema change, backups include it.
   A reminder opens at the chosen time (default 23:00) while the app is open; a closed web app cannot wake itself on iPhone,
   so the settings explain the free «Shortcuts» automation that reminds at that time. */
(function (root) {
  'use strict';
  var J = root.Jalali;
  var DEF_CATS = [
    { id: 'daily', name: 'روزمره', kind: 'personal', dir: 'out' }, { id: 'smoke', name: 'سیگار', kind: 'personal', dir: 'out' },
    { id: 'edu', name: 'آموزش', kind: 'personal', dir: 'out' }, { id: 'food', name: 'خوراک و رستوران', kind: 'personal', dir: 'out' },
    { id: 'move', name: 'رفت‌وآمد و سوخت', kind: 'personal', dir: 'out' }, { id: 'bills', name: 'قبوض', kind: 'personal', dir: 'out' },
    { id: 'health', name: 'درمان', kind: 'personal', dir: 'out' }, { id: 'family', name: 'خانواده و خانه', kind: 'personal', dir: 'out' },
    { id: 'shop', name: 'هزینه فروشگاه (اجاره، حمل، پیک…)', kind: 'business', dir: 'out' }, { id: 'staff', name: 'حقوق و دستمزد', kind: 'business', dir: 'out' },
    { id: 'misc', name: 'متفرقه', kind: 'personal', dir: 'out' },
    { id: 'inc_other', name: 'درآمد متفرقه', kind: 'personal', dir: 'in' }, { id: 'inc_shop', name: 'درآمد فروشگاه (ثبت‌نشده در اپ)', kind: 'business', dir: 'in' },
    { id: 'unknown', name: 'اختلاف نامشخص', kind: 'personal', dir: 'both', system: true }];
  var WD = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
  var FA = '۰۱۲۳۴۵۶۷۸۹';
  function fa(s) { return String(s == null ? '' : s).replace(/\d/g, function (d) { return FA[d]; }); }
  function money(n) { var neg = n < 0, s = String(Math.abs(Math.round(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '٬'); return fa((neg ? '−' : '') + s); }
  function norm(t) { return String(t || '').toLowerCase().replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ً-ْ‌]/g, ' ').replace(/[^؀-ۿa-z0-9]+/g, ' ').trim(); }
  function sum(o) { return Object.keys(o || {}).reduce(function (s, k) { return s + (o[k] || 0); }, 0); }
  function keyOf(ms) { return J.fmt(ms).replace(/\//g, ''); }
  function msOf(key) { return J.parse(key); } // local midnight
  function label(key) { return fa(key.slice(0, 4) + '/' + key.slice(4, 6) + '/' + key.slice(6, 8)); }
  function addDays(key, n) { var d = new Date(msOf(key)); d.setDate(d.getDate() + n); d.setHours(12); return keyOf(d.getTime()); }
  function dayRange(key) { var a = msOf(key), d = new Date(a); d.setHours(23, 59, 59, 999); return { from: a, to: d.getTime() }; }

  function meta(E, id) { return E.getMeta(id); }
  function cats(E) { var c = meta(E, 'dbkCats'); return c && c.length ? c : DEF_CATS.slice(); }
  function catById(E) { var m = {}; cats(E).forEach(function (c) { m[c.id] = c; }); return m; }
  function day(E, key) { return meta(E, 'dbk:' + key) || null; }
  function allKeys(E) { return Object.keys(E.state.meta).filter(function (k) { return k.indexOf('dbk:') === 0; }).map(function (k) { return k.slice(4); }).sort(); }
  function prefs(E) { return Object.assign({ on: true, hour: 23, minute: 0 }, meta(E, 'dbkPrefs') || {}); }
  /* v2.13.1: money places are the user's own list (صندوق، کیف پول، چند حساب بانکی …), defined in the book's settings. Never removed,
     only deactivated, so old days keep their names. */
  function allPlaces(E) { var p = prefs(E).places; return p && p.length ? p : [{ id: 'cash', name: 'صندوق' }]; }
  function places(E) { return allPlaces(E).filter(function (x) { return x.active !== false; }); }
  /* the day's figures — ONLY what the user wrote: balance at 00:00 + incomes − expenses − balance at 23:59 (an issued invoice is not money
     received; nothing of the app's documents is assumed). gap > 0: money is missing (an expense not written yet); gap < 0: an income. */
  function calc(E, key) {
    var r = day(E, key) || {}, rin = 0, rout = 0;
    (r.rows || []).forEach(function (x) { if (x.dir === 'in') rin += x.amount; else rout += x.amount; });
    var hasOpen = r.open && Object.keys(r.open).length > 0, hasClose = r.close && Object.keys(r.close).length > 0;
    var openT = sum(r.open), closeT = sum(r.close);
    var gap = hasOpen && hasClose ? openT + rin - rout - closeT : null;
    return { key: key, rec: r, open: openT, close: closeT, hasOpen: hasOpen, hasClose: hasClose, rowsIn: rin, rowsOut: rout, gap: gap, done: !!r.done };
  }
  /* smart group: only a SUGGESTION from the words of earlier rows (the user always taps the group) */
  function tokens(desc) { return norm(desc).split(' ').filter(function (t) { return t.length >= 2; }); }
  function suggest(E, desc, dir) {
    var L = meta(E, 'dbkLearn') || {}, score = {}, cm = catById(E);
    tokens(desc).forEach(function (t) { var m = L[t]; if (m) Object.keys(m).forEach(function (c) { if (cm[c] && (cm[c].dir === dir || cm[c].dir === 'both')) score[c] = (score[c] || 0) + m[c]; }); });
    var n = norm(desc); cats(E).forEach(function (c) { if (c.dir === dir && n && norm(c.name).split(' ').some(function (w) { return w.length >= 3 && n.indexOf(w) >= 0; })) score[c.id] = (score[c.id] || 0) + 1; });
    var best = null; Object.keys(score).forEach(function (c) { if (!best || score[c] > score[best]) best = c; });
    return best;
  }
  function learnFrom(E, desc, catId) {
    var L = Object.assign({}, meta(E, 'dbkLearn') || {});
    tokens(desc).forEach(function (t) { var m = Object.assign({}, L[t] || {}); m[catId] = (m[catId] || 0) + 1; L[t] = m; });
    return L;
  }

  /* ---------- report and behaviour patterns ---------- */
  /* f: {from, to (yyyymmdd), cats: [ids], kind: personal|business, dir: out|in, place: id, q: text, min, max} — all combinable;
     the total is consolidated over every account unless one account is chosen */
  function keep(f, x, cat) {
    if (f.cats && f.cats.length && f.cats.indexOf(cat.id) < 0) return false;
    if (f.kind && cat.kind !== f.kind) return false;
    if (f.dir && x.dir !== f.dir) return false;
    if (f.place && x.place !== f.place) return false;
    if (f.q && norm(x.desc).indexOf(norm(f.q)) < 0 && norm(cat.name).indexOf(norm(f.q)) < 0) return false;
    if (f.min != null && x.amount < f.min) return false;
    if (f.max != null && x.amount > f.max) return false;
    return true;
  }
  function report(E, f) {
    f = f || {}; var cm = catById(E), pm = {}, keys = allKeys(E).filter(function (k) { return (!f.from || k >= f.from) && (!f.to || k <= f.to); });
    allPlaces(E).forEach(function (p) { pm[p.id] = p.name; });
    var rows = [], byCat = {}, byMonth = {}, byWd = [0, 0, 0, 0, 0, 0, 0], wdDays = [0, 0, 0, 0, 0, 0, 0], open = 0, done = 0, unknown = 0, personal = 0, business = 0, inc = 0;
    keys.forEach(function (k) {
      var c = calc(E, k); if (c.done) done++; else open++;
      var wd = new Date(msOf(k)).getDay(); wdDays[wd]++;
      (c.rec.rows || []).forEach(function (x) {
        var cat = cm[x.catId] || { id: x.catId, name: x.catName || 'حذف‌شده', kind: 'personal' }, mk = k.slice(0, 6);
        if (!keep(f, x, cat)) return;
        rows.push({ key: k, date: label(k), dir: x.dir, amount: x.amount, catId: cat.id, cat: cat.name, kind: cat.kind, desc: x.desc || '', place: x.place ? pm[x.place] || '' : '' });
        if (x.dir === 'in') { inc += x.amount; return; }
        if (cat.id === 'unknown') unknown += x.amount;
        var b = byCat[cat.id] || (byCat[cat.id] = { id: cat.id, name: cat.name, kind: cat.kind, total: 0, count: 0, months: {} });
        b.total += x.amount; b.count++; b.months[mk] = (b.months[mk] || 0) + x.amount;
        byMonth[mk] = (byMonth[mk] || 0) + x.amount; byWd[wd] += x.amount;
        if (cat.kind === 'business') business += x.amount; else personal += x.amount;
      });
    });
    var cl = Object.keys(byCat).map(function (k) { return byCat[k]; }).sort(function (a, b) { return b.total - a.total; });
    var total = personal + business, months = Object.keys(byMonth).sort();
    return { keys: keys, rows: rows, cats: cl, months: months, byMonth: byMonth, byWd: byWd, wdDays: wdDays, total: total, personal: personal, business: business, income: inc,
      unknown: unknown, open: open, done: done, insights: insights({ cats: cl, months: months, byMonth: byMonth, byWd: byWd, wdDays: wdDays, total: total, personal: personal, business: business, unknown: unknown, open: open, done: done, days: keys.length }) };
  }
  /* rule-based, explainable suggestions (no hidden model; every sentence says the numbers it is based on) */
  function insights(R) {
    var out = [];
    if (!R.total) { out.push('هنوز هزینه‌ای ثبت نشده است؛ چند روز «دفتر روزانه» را ببندید تا الگوها پیدا شوند.'); return out; }
    if (R.days && R.open) out.push(fa(R.open) + ' روز از ' + fa(R.days) + ' روز بسته نشده است؛ تا وقتی این روزها کامل نشوند، گزارش کامل نیست.');
    var top = R.cats[0]; if (top) out.push('بیشترین هزینه: «' + top.name + '» — ' + money(top.total) + ' تومان (' + fa(Math.round(top.total * 100 / R.total)) + '٪ کل هزینه‌ها، ' + fa(top.count) + ' بار).' +
      (top.total * 100 / R.total >= 30 ? ' اگر ۱۰٪ آن را کم کنید، در همین بازه ' + money(Math.round(top.total / 10)) + ' تومان کمتر خرج می‌شد.' : ''));
    var m = R.months; if (m.length >= 2) {
      var a = m[m.length - 2], b = m[m.length - 1];
      R.cats.forEach(function (c) {
        var x = c.months[a] || 0, y = c.months[b] || 0;
        if (x > 0 && y >= x * 1.25 && y - x >= 200000) out.push('«' + c.name + '» در ماه ' + fa(b.slice(4, 6)) + ' نسبت به ماه ' + fa(a.slice(4, 6)) + ' ' + fa(Math.round((y - x) * 100 / x)) + '٪ بیشتر شده (' + money(x) + ' ← ' + money(y) + ' تومان).');
        else if (x > 0 && y <= x * 0.75 && x - y >= 200000) out.push('«' + c.name + '» نسبت به ماه قبل ' + fa(Math.round((x - y) * 100 / x)) + '٪ کمتر شده است؛ خوب است.');
      });
    }
    var avg = R.byWd.map(function (v, i) { return R.wdDays[i] ? v / R.wdDays[i] : 0; }), all = R.total / Math.max(1, R.days), hi = 0;
    avg.forEach(function (v, i) { if (v > avg[hi]) hi = i; });
    if (R.days >= 14 && avg[hi] > all * 1.4) out.push('روزهای ' + WD[hi] + ' به‌طور میانگین ' + money(Math.round(avg[hi])) + ' تومان خرج می‌کنید؛ بیشتر از میانگین روزانه (' + money(Math.round(all)) + '). برای این روز سقف خرج بگذارید.');
    R.cats.forEach(function (c) { var per = c.total / c.count; if (c.count >= 10 && per < all * 0.3) out.push('«' + c.name + '»: ' + fa(c.count) + ' خرج کوچک با میانگین ' + money(Math.round(per)) + ' تومان، جمعاً ' + money(c.total) + ' تومان — خرج‌های کوچک تکراری جمع زیادی می‌سازند.'); });
    if (R.unknown > 0) out.push(money(R.unknown) + ' تومان «اختلاف نامشخص» ثبت شده (' + fa(Math.round(R.unknown * 100 / R.total)) + '٪). هرچه این کمتر باشد، گزارش دقیق‌تر است؛ رسید خرج‌ها را همان روز ثبت کنید.');
    if (R.business && R.personal) out.push('سهم هزینه شخصی ' + fa(Math.round(R.personal * 100 / R.total)) + '٪ و هزینه فروشگاه ' + fa(Math.round(R.business * 100 / R.total)) + '٪ است. هزینه شخصی را از دخل فروشگاه جدا نگه دارید (حساب جدا یا برداشت ثابت هفتگی).');
    return out;
  }
  function csv(R) {
    var head = [['تاریخ', 'نوع', 'گروه', 'شخصی / فروشگاه', 'حساب', 'شرح', 'مبلغ (تومان)']];
    return head.concat(R.rows.map(function (r) { return [r.date, r.dir === 'in' ? 'درآمد' : 'هزینه', r.cat, r.kind === 'business' ? 'فروشگاه' : 'شخصی', r.place || '', r.desc, r.amount]; }),
      [[]], [['جمع به تفکیک گروه']], R.cats.map(function (c) { return ['', 'هزینه', c.name, c.kind === 'business' ? 'فروشگاه' : 'شخصی', fa(c.count) + ' بار', c.total]; }),
      [[]], [['پیشنهادها']], R.insights.map(function (t) { return [t]; }));
  }
  var core = { DEF_CATS: DEF_CATS, keyOf: keyOf, msOf: msOf, label: label, addDays: addDays, dayRange: dayRange, cats: cats, day: day, allKeys: allKeys, prefs: prefs, places: places,
    calc: calc, allPlaces: allPlaces, suggest: suggest, learnFrom: learnFrom, report: report, insights: insights, csv: csv, sum: sum };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }
  root.Daybook = core;
  if (!root.App) return;

  // ======================= UI =======================
  var A = root.App, E = A.E, UI = root.UI, h = UI.h, view = document.getElementById('view');
  function save(id, v) { return A.run(function () { return E.putMeta(id, v, A.userCtx()); }); }
  function saveDay(key, r) { return save('dbk:' + key, r); }
  function todayKey() { return keyOf(Date.now()); }
  function remindAt(key) { var p = prefs(E), d = new Date(msOf(key)); d.setHours(p.hour, p.minute, 0, 0); return d.getTime(); }

  A.routes.daybook = function (arg, q) {
    var key = (q && /^\d{8}$/.test(q.d)) ? q.d : todayKey(), r = JSON.parse(JSON.stringify(day(E, key) || { rows: [] })), P = places(E);
    r.rows = r.rows || [];
    A.setTitle('دفتر روزانه', true, h('a.tb-btn', { href: '#/daybook-report' }, 'گزارش'));
    var di = h('input.in', { value: label(key), inputmode: 'numeric', 'data-date': 1, style: { maxWidth: '140px', textAlign: 'center' } });
    di.addEventListener('change', function () { var t = UI.parseDateInput(di.value); if (t == null || isNaN(t)) { UI.toast('تاریخ نامعتبر است.', 'bad'); return; } A.go('#/daybook?d=' + keyOf(t)); });
    view.appendChild(h('div.card', h('div.row', { style: { justifyContent: 'space-between', alignItems: 'center' } },
      h('a.btn.sm', { href: '#/daybook?d=' + addDays(key, -1) }, '‹ روز قبل'), h('div', { style: { textAlign: 'center' } }, h('b', WD[new Date(msOf(key)).getDay()]), di),
      key < todayKey() ? h('a.btn.sm', { href: '#/daybook?d=' + addDays(key, 1) }, 'روز بعد ›') : h('span')),
      r.done ? h('div.alert.ok', { style: { marginTop: '8px' } }, 'این روز بسته شده است' + (r.doneAt ? ' (' + UI.dateFa(r.doneAt, true) + ')' : '') + '. با تغییر هر ردیف دوباره باز می‌شود.') : null));
    var gapBox = h('div');
    function persist() { r.done = false; return saveDay(key, r).then(drawGap, function () {}); }
    function balCard(title, field, hint) {
      var card = h('div.card', h('h2', title), hint || null);
      P.forEach(function (p) {
        var mi = A.moneyInput(r[field] && r[field][p.id] != null ? r[field][p.id] : null, 'تومان');
        mi.input.addEventListener('change', function () { var n = mi.value(); if (n != null && (isNaN(n) || n < 0 || !Number.isInteger(n))) { UI.toast('مبلغ نامعتبر است.', 'bad'); return; } r[field] = r[field] || {}; if (n == null) delete r[field][p.id]; else r[field][p.id] = n; persist(); });
        card.appendChild(A.field(p.name, mi.input, mi.hint));
      });
      return card;
    }
    // opening: suggested from the previous closed day, applied only by a tap
    var prevKey = allKeys(E).filter(function (k) { return k < key; }).pop(), prev = prevKey ? day(E, prevKey) : null;
    var sug = prev && prev.close && Object.keys(prev.close).length && !(r.open && Object.keys(r.open).length)
      ? h('button.btn.sm', { onclick: function () { r.open = Object.assign({}, prev.close); persist().then(function () { A.route(); }); } }, 'همان موجودی آخر ' + label(prevKey) + ': ' + money(sum(prev.close)) + ' تومان') : null;
    view.appendChild(balCard('موجودی اول روز (ساعت ۰۰:۰۰)', 'open', h('div', sug, h('p.small.muted', 'حساب‌ها را در «تنظیمات دفتر» تعریف کنید (صندوق، کیف پول، چند حساب بانکی).'))));
    // rows
    var rowsCard = h('div.card'); view.appendChild(rowsCard);
    function drawRows() {
      UI.clear(rowsCard); var cm = catById(E);
      rowsCard.appendChild(h('h2', 'ردیف‌های هزینه و درآمد (' + UI.fa(r.rows.length) + ')'));
      r.rows.forEach(function (x, i) {
        var ct = cm[x.catId];
        rowsCard.appendChild(h('div.line', h('div.row', h('div.grow', h('b', (x.dir === 'in' ? '+ ' : '− ') + UI.money(x.amount)), ' ', h('span.badge' + (ct && ct.kind === 'business' ? '.warn' : ''), ct ? ct.name : (x.catName || '—')),
          (x.desc || x.place) ? h('div.small.muted', [x.desc, x.place ? (allPlaces(E).filter(function (q) { return q.id === x.place; })[0] || {}).name : ''].filter(Boolean).join(' · ')) : null),
          h('button.btn.sm.ghost', { onclick: function () { UI.confirmBox('این ردیف حذف شود؟', 'حذف', true).then(function (ok) { if (!ok) return; r.rows.splice(i, 1); persist().then(drawRows); }); } }, '✕'))));
      });
      rowsCard.appendChild(addForm());
    }
    function addForm() {
      var st = { dir: 'out', cat: null, place: null }, PL = places(E), box = h('div.stack', { style: { marginTop: '10px' } }), am = A.moneyInput(null, 'مبلغ (تومان)'), ds = h('input.in', { placeholder: 'شرح (مثلاً نان، بنزین، کلاس زبان)' }), catBox = h('div'), sT = null;
      function drawCats() {
        UI.clear(catBox); var s = suggest(E, ds.value, st.dir);
        catBox.appendChild(h('div.small.muted', 'گروه' + (s && !st.cat ? ' — پیشنهاد: «' + catById(E)[s].name + '» (برای تأیید بزنید)' : '') + ':'));
        catBox.appendChild(h('div.chips', cats(E).filter(function (c) { return c.active !== false && (c.dir === st.dir || c.dir === 'both'); }).map(function (c) {
          return h('button.chip' + (st.cat === c.id ? '.on' : ''), { type: 'button', style: s === c.id && !st.cat ? { outline: '2px dashed var(--brand-2)' } : null, onclick: function () { st.cat = c.id; drawCats(); } }, c.name + (c.kind === 'business' ? ' (فروشگاه)' : ''));
        }).concat([h('button.chip', { type: 'button', onclick: function () { newCat(st.dir, function (c) { st.cat = c.id; drawCats(); }); } }, '+ گروه جدید')])));
      }
      ds.addEventListener('input', function () { clearTimeout(sT); sT = setTimeout(drawCats, 200); });
      var dirChips = h('div.chips');
      function drawDir() { UI.clear(dirChips); [['out', 'هزینه'], ['in', 'درآمد']].forEach(function (d) { dirChips.appendChild(h('button.chip' + (st.dir === d[0] ? '.on' : ''), { type: 'button', onclick: function () { st.dir = d[0]; st.cat = null; drawDir(); drawCats(); } }, d[1])); }); }
      drawDir(); drawCats();
      box.appendChild(h('div.sec-title', 'ردیف جدید')); box.appendChild(dirChips); box.appendChild(A.field('مبلغ', am.input, am.hint)); box.appendChild(ds); box.appendChild(catBox);
      if (PL.length > 1) { var pc = h('div.chips'); var dp = function () { UI.clear(pc); PL.forEach(function (x) { pc.appendChild(h('button.chip' + (st.place === x.id ? '.on' : ''), { type: 'button', onclick: function () { st.place = st.place === x.id ? null : x.id; dp(); } }, x.name)); }); };
        dp(); box.appendChild(h('div.small.muted', 'از کدام حساب؟ (اختیاری)')); box.appendChild(pc); }
      box.appendChild(h('button.btn.primary.block', { onclick: function () {
        var n = am.value(); if (!(n > 0) || !Number.isInteger(n)) { UI.toast('مبلغ را درست وارد کنید.', 'bad'); return; }
        if (!st.cat) { UI.toast('گروه این ردیف را انتخاب کنید.', 'bad'); return; }
        var ct = catById(E)[st.cat];
        r.rows.push({ id: UI.opKey('dr'), dir: st.dir, amount: n, catId: st.cat, catName: ct ? ct.name : '', desc: ds.value.trim(), place: st.place || undefined, at: Date.now() });
        var steps = [function () { return E.putMeta('dbk:' + key, Object.assign({}, r, { done: false }), A.userCtx()); }];
        if (ds.value.trim()) steps.push(function () { return E.putMeta('dbkLearn', learnFrom(E, ds.value, st.cat), A.userCtx()); });
        r.done = false;
        A.run(A.DB.batch(steps)).then(function () { drawRows(); drawGap(); }, function () {});
      } }, 'افزودن ردیف'));
      return box;
    }
    drawRows();
    view.appendChild(balCard('موجودی آخر روز (ساعت ۲۳:۵۹)', 'close', h('p.small.muted', 'مانده واقعی هر حساب در پایان روز. فاکتور صادرشده تا پولش وصول نشده اینجا اثری ندارد.')));
    view.appendChild(gapBox);
    function drawGap() {
      UI.clear(gapBox); var c = calc(E, key);
      if (c.gap == null) { gapBox.appendChild(h('div.card', h('p.muted', 'برای محاسبه اختلاف، موجودی اول و آخر روز را وارد کنید.'))); return; }
      gapBox.appendChild(h('div.card', h('div.tot', h('span', 'موجودی ۰۰:۰۰ (همه حساب‌ها)'), h('b', UI.moneyT(c.open))), h('div.tot', h('span', '+ درآمدهای ردیف‌شده'), h('b', UI.moneyT(c.rowsIn))),
        h('div.tot', h('span', '− هزینه‌های ردیف‌شده'), h('b', UI.moneyT(c.rowsOut))), h('div.tot', h('span', 'باید بماند'), h('b', UI.moneyT(c.open + c.rowsIn - c.rowsOut))),
        h('div.tot', h('span', 'موجودی ۲۳:۵۹ (همه حساب‌ها)'), h('b', UI.moneyT(c.close))),
        h('div.tot.grand', h('span', c.gap === 0 ? 'اختلاف' : c.gap > 0 ? 'کسری (هزینه ثبت‌نشده)' : 'اضافه (درآمد ثبت‌نشده)'), h('b', { style: { color: c.gap ? 'var(--bad)' : 'var(--ok)' } }, UI.moneyT(Math.abs(c.gap)))),
        c.gap === 0 ? h('button.btn.primary.block', { onclick: function () { r.done = true; r.doneAt = Date.now(); saveDay(key, r).then(function () { UI.toast('روز بسته شد.', 'ok'); A.route(); }, function () {}); } }, r.done ? 'بسته شده ✓' : 'بستن روز')
          : h('div.stack', h('p.small', c.gap > 0 ? UI.moneyT(c.gap) + ' خرج شده که هنوز ردیف ندارد؛ ردیف‌های هزینه را کامل کنید.' : UI.moneyT(-c.gap) + ' پول بیشتر از انتظار هست؛ درآمد ثبت‌نشده را اضافه کنید.'),
            h('button.btn.sm.ghost', { onclick: function () {
              UI.confirmBox('اختلاف ' + UI.moneyT(Math.abs(c.gap)) + ' به‌عنوان «اختلاف نامشخص» ثبت و روز بسته شود؟ در گزارش جدا دیده می‌شود.', 'ثبت و بستن').then(function (ok) {
                if (!ok) return; r.rows.push({ id: UI.opKey('dr'), dir: c.gap > 0 ? 'out' : 'in', amount: Math.abs(c.gap), catId: 'unknown', catName: 'اختلاف نامشخص', desc: '', at: Date.now() });
                r.done = true; r.doneAt = Date.now(); saveDay(key, r).then(function () { A.route(); }, function () {});
              });
            } }, 'نمی‌دانم کجا رفته — ثبت به‌عنوان اختلاف نامشخص'))));
    }
    drawGap();
    view.appendChild(h('div.row', { style: { margin: '8px 4px' } }, h('a.btn.sm', { href: '#/daybook-settings' }, 'تنظیمات یادآوری و گروه‌ها'), h('a.btn.sm', { href: '#/daybook-report' }, 'گزارش و پیشنهاد')));
  };

  function newCat(dir, done) {
    var nm = h('input.in', { placeholder: 'نام گروه (مثلاً باشگاه، هدیه)' }), kind = null, kc = h('div.chips');
    function dk() { UI.clear(kc); [['personal', 'شخصی'], ['business', 'هزینه / درآمد فروشگاه']].forEach(function (k) { kc.appendChild(h('button.chip' + (kind === k[0] ? '.on' : ''), { type: 'button', onclick: function () { kind = k[0]; dk(); } }, k[1])); }); }
    dk();
    var s = UI.sheet('گروه جدید ' + (dir === 'in' ? 'درآمد' : 'هزینه'), h('div.stack', nm, h('div.small.muted', 'این گروه شخصی است یا مربوط به فروشگاه؟'), kc,
      h('button.btn.primary.block', { onclick: function () {
        var n = nm.value.trim(); if (!n) { UI.toast('نام گروه را بنویسید.', 'bad'); return; }
        if (!kind) { UI.toast('شخصی یا فروشگاه را مشخص کنید.', 'bad'); return; }
        var list = cats(E); if (list.some(function (c) { return c.name === n && c.dir === dir; })) { UI.toast('این گروه وجود دارد.', 'bad'); return; }
        var c = { id: 'c' + Date.now().toString(36), name: n, kind: kind, dir: dir }; list.push(c);
        save('dbkCats', list).then(function () { s.close(); done && done(c); }, function () {});
      } }, 'افزودن')));
  }

  A.routes['daybook-settings'] = function () {
    A.setTitle('دفتر روزانه — تنظیمات', true);
    var p = prefs(E), on = h('input', { type: 'checkbox', checked: p.on !== false }), tm = h('input.in', { value: fa(('0' + p.hour).slice(-2) + ':' + ('0' + p.minute).slice(-2)), inputmode: 'numeric', style: { maxWidth: '110px' } });
    view.appendChild(h('div.card', h('h2', 'یادآوری'), h('label.check', on, 'هر شب یادآوری کن'), A.field('ساعت', tm),
      h('p.small.muted', 'وقتی برنامه باز است، سر این ساعت پیام می‌دهد و اگر روز بسته نشده، هر بار که برنامه را باز کنید دفتر همان روز را پیشنهاد می‌کند.'),
      'Notification' in window ? h('button.btn.sm', { onclick: function () { Notification.requestPermission().then(function (x) { UI.toast(x === 'granted' ? 'اجازه اعلان داده شد.' : 'اجازه اعلان داده نشد.', x === 'granted' ? 'ok' : 'bad'); }); } }, 'اجازه اعلان') : null,
      h('div.alert.warn', { style: { marginTop: '8px' } }, h('div.grow', h('b', 'یادآوری وقتی برنامه بسته است: '), 'آیفون اجازه نمی‌دهد برنامه وب بسته خودش بیدار شود. رایگان و بدون سرویس خارجی: برنامه «Shortcuts» ← Automation ← + ← Time of Day ← ساعت ۲۳:۰۰، Daily ← «Run Immediately» ← اکشن «Show Notification» با متن «دفتر روزانه امیران یدک». با دیدن پیام، برنامه را باز کنید؛ دفتر امروز خودش باز می‌شود.'))));
    var PLs = allPlaces(E).map(function (x) { return Object.assign({}, x); }), plBox = h('div.list');
    PLs.forEach(function (x, i) {
      var nm = h('input.in', { value: x.name }); nm.addEventListener('input', function () { PLs[i].name = nm.value; });
      plBox.appendChild(h('div.li', h('div.grow', nm, x.active === false ? h('div.s', 'غیرفعال') : null),
        h('button.btn.sm.ghost', { onclick: function () { PLs[i].active = x.active === false; savePl(); } }, x.active === false ? 'فعال' : 'غیرفعال')));
    });
    function savePl() { if (PLs.some(function (x) { return !String(x.name || '').trim(); })) { UI.toast('نام حساب خالی است.', 'bad'); return; } save('dbkPrefs', Object.assign({}, prefs(E), { places: PLs.map(function (x) { return Object.assign({}, x, { name: x.name.trim() }); }) })).then(A.route, function () {}); }
    view.appendChild(h('div.card', h('h2', 'حساب‌ها (صندوق، کیف پول، حساب‌های بانکی)'), h('p.small.muted', 'موجودی ۰۰:۰۰ و ۲۳:۵۹ برای همین حساب‌ها پرسیده می‌شود. حساب حذف نمی‌شود (روزهای قبل نامش را لازم دارند)؛ غیرفعال کنید.'), plBox,
      h('div.row', h('button.btn.sm', { onclick: function () { UI.promptBox('حساب جدید', 'نام (مثلاً کیف پول، ملت ۱۲۳۴)').then(function (n) { if (!n || !n.trim()) return; PLs.push({ id: 'p' + Date.now().toString(36), name: n.trim() }); savePl(); }); } }, '+ حساب'),
        h('button.btn.sm.primary', { onclick: savePl }, 'ذخیره نام‌ها'))));
    view.appendChild(h('button.btn.primary.block', { onclick: function () {
      var m = /^(\d{1,2}):(\d{2})$/.exec(J.toLatinDigits(tm.value.trim())); if (!m || +m[1] > 23 || +m[2] > 59) { UI.toast('ساعت را مثل ۲۳:۰۰ بنویسید.', 'bad'); return; }
      save('dbkPrefs', Object.assign({}, prefs(E), { on: on.checked, hour: +m[1], minute: +m[2], since: p.since || todayKey() }))
        .then(function () { UI.toast('ذخیره شد.', 'ok'); }, function () {});
    } }, 'ذخیره'));
    var list = cats(E), box = h('div.list');
    list.forEach(function (c, i) {
      if (c.system) return;
      box.appendChild(h('div.li', h('div.grow', h('div.t', c.name), h('div.s', (c.dir === 'in' ? 'درآمد' : 'هزینه') + ' · ' + (c.kind === 'business' ? 'فروشگاه' : 'شخصی') + (c.active === false ? ' · غیرفعال' : ''))),
        h('button.btn.sm', { onclick: function () { UI.promptBox('نام گروه', 'نام', { value: c.name }).then(function (n) { if (!n || !n.trim()) return; list[i] = Object.assign({}, c, { name: n.trim() }); save('dbkCats', list).then(A.route, function () {}); }); } }, 'نام'),
        h('button.btn.sm.ghost', { onclick: function () { list[i] = Object.assign({}, c, { active: c.active === false }); save('dbkCats', list).then(A.route, function () {}); } }, c.active === false ? 'فعال' : 'غیرفعال')));
    });
    view.appendChild(h('div.sec-title', 'گروه‌ها (حذف نمی‌شوند تا گزارش‌های قبلی درست بمانند)'));
    view.appendChild(h('div.row', h('button.btn.sm', { onclick: function () { newCat('out', A.route); } }, '+ گروه هزینه'), h('button.btn.sm', { onclick: function () { newCat('in', A.route); } }, '+ گروه درآمد')));
    view.appendChild(box);
  };

  A.routes['daybook-report'] = function (arg, q) {
    A.setTitle('دفتر روزانه — گزارش', true);
    var t = todayKey(), m0 = t.slice(0, 6) + '01', pm = addDays(m0, -1).slice(0, 6) + '01', st = A.lsGet('ay.dbkRep') || { p: 'm3' };
    var P = { m: ['این ماه', m0, t], pm: ['ماه قبل', pm, addDays(m0, -1)], m3: ['سه ماه اخیر', addDays(t, -92), t], y: ['یک سال اخیر', addDays(t, -365), t], all: ['همه', null, null], c: ['بازه دلخواه', st.from || null, st.to || null] };
    function setS(k, v) { st[k] = v; A.lsSet('ay.dbkRep', st); A.route(); }
    view.appendChild(h('div.chips', Object.keys(P).map(function (k) { return h('button.chip' + (st.p === k ? '.on' : ''), { onclick: function () { setS('p', k); } }, P[k][0]); })));
    // v2.13.1 combinable filters: period, groups, personal / shop, expense / income, account, words in the description, amount range
    var fc = h('div.card'); view.appendChild(fc);
    if (st.p === 'c') {
      var fi = h('input.in', { value: st.from ? label(st.from) : '', 'data-date': 1, inputmode: 'numeric', placeholder: 'از ۱۴۰۵/۰۱/۰۱' }), ti = h('input.in', { value: st.to ? label(st.to) : '', 'data-date': 1, inputmode: 'numeric', placeholder: 'تا ۱۴۰۵/۱۲/۲۹' });
      var rd = function (inp, k) { inp.addEventListener('change', function () { var v = inp.value.trim(); if (!v) { setS(k, null); return; } var x = UI.parseDateInput(v); if (x == null || isNaN(x)) { UI.toast('تاریخ نامعتبر است.', 'bad'); return; } setS(k, keyOf(x)); }); };
      rd(fi, 'from'); rd(ti, 'to'); fc.appendChild(h('div.grid2', fi, ti));
    }
    var chipRow = function (opts, k) { return h('div.chips', opts.map(function (o) { return h('button.chip' + ((st[k] || '') === o[0] ? '.on' : ''), { onclick: function () { setS(k, o[0] || null); } }, o[1]); })); };
    fc.appendChild(chipRow([['', 'هزینه و درآمد'], ['out', 'فقط هزینه'], ['in', 'فقط درآمد']], 'dir'));
    fc.appendChild(chipRow([['', 'شخصی و فروشگاه'], ['personal', 'فقط شخصی'], ['business', 'فقط فروشگاه']], 'kind'));
    var PLa = allPlaces(E); if (PLa.length > 1) fc.appendChild(chipRow([['', 'همه حساب‌ها (تلفیقی)']].concat(PLa.map(function (x) { return [x.id, x.name]; })), 'place'));
    var sel = st.cats || [];
    fc.appendChild(h('div.small.muted', 'گروه‌ها (هیچ = همه):'));
    fc.appendChild(h('div.chips', cats(E).map(function (c) { var on = sel.indexOf(c.id) >= 0; return h('button.chip' + (on ? '.on' : ''), { onclick: function () { setS('cats', on ? sel.filter(function (x) { return x !== c.id; }) : sel.concat([c.id])); } }, c.name); })));
    var qi = h('input.in', { type: 'search', value: st.q || '', placeholder: 'کلمه در شرح (مثلاً بنزین)' }); qi.addEventListener('change', function () { setS('q', qi.value.trim() || null); });
    var mn = A.moneyInput(st.min, 'حداقل مبلغ'), mx = A.moneyInput(st.max, 'حداکثر مبلغ');
    mn.input.addEventListener('change', function () { var v = mn.value(); setS('min', v == null || isNaN(v) ? null : v); }); mx.input.addEventListener('change', function () { var v = mx.value(); setS('max', v == null || isNaN(v) ? null : v); });
    fc.appendChild(qi); fc.appendChild(h('div.grid2', mn.input, mx.input));
    fc.appendChild(h('button.btn.sm.ghost', { onclick: function () { A.lsSet('ay.dbkRep', { p: st.p }); A.route(); } }, 'پاک کردن فیلترها'));
    var R = report(E, { from: P[st.p][1], to: P[st.p][2], cats: sel, kind: st.kind || null, dir: st.dir || null, place: st.place || null, q: st.q || null, min: st.min, max: st.max });
    view.appendChild(h('div.card', h('div.tot', h('span', 'روزهای ثبت‌شده'), h('b', UI.fa(R.keys.length) + ' (' + UI.fa(R.done) + ' بسته)')), h('div.tot.grand', h('span', 'کل هزینه'), h('b', UI.moneyT(R.total))),
      h('div.tot', h('span', 'شخصی'), h('b', UI.moneyT(R.personal))), h('div.tot', h('span', 'فروشگاه'), h('b', UI.moneyT(R.business))), h('div.tot', h('span', 'درآمد ثبت‌شده در دفتر'), h('b', UI.moneyT(R.income))),
      h('div.row', { style: { marginTop: '8px' } }, h('button.btn.sm', { onclick: function () { UI.fileSheet(window.XLSX.writeCsv(csv(R)), 'daybook-' + st.p + '.csv', 'text/csv'); } }, 'CSV'),
        h('button.btn.sm.primary', { onclick: function () { pdf(R, P[st.p][0]); } }, 'PDF'))));
    view.appendChild(h('div.sec-title', 'پیشنهادها برای مدیریت بهتر'));
    view.appendChild(h('div.card', h('ul', R.insights.map(function (x) { return h('li', { style: { marginBottom: '6px' } }, x); }))));
    view.appendChild(h('div.sec-title', 'به تفکیک گروه'));
    view.appendChild(h('div.list', R.cats.map(function (c) { return h('div.li', h('div.grow', h('div.t', c.name), h('div.s', UI.fa(c.count) + ' بار · ' + (c.kind === 'business' ? 'فروشگاه' : 'شخصی'))), h('b', UI.money(c.total) + ' (' + UI.fa(R.total ? Math.round(c.total * 100 / R.total) : 0) + '٪)')); })));
    if (R.months.length) {
      view.appendChild(h('div.sec-title', 'ماه به ماه'));
      view.appendChild(h('div.list', R.months.map(function (m) { return h('div.li', h('div.grow', UI.fa(m.slice(0, 4) + '/' + m.slice(4, 6))), h('b', UI.moneyT(R.byMonth[m]))); })));
    }
  };
  function pdf(R, title) {
    var blocks = [{ type: 'title', text: 'گزارش دخل و خرج روزانه', sub: title, left: [UI.dateFa(Date.now())] },
      { type: 'kv', cols: 2, items: [['روزهای ثبت‌شده', UI.fa(R.keys.length)], ['روزهای بسته‌شده', UI.fa(R.done)], ['کل هزینه', UI.moneyT(R.total)], ['شخصی', UI.moneyT(R.personal)], ['فروشگاه', UI.moneyT(R.business)], ['درآمد دفتر', UI.moneyT(R.income)]] },
      { type: 'text', text: 'پیشنهادها', bold: true, size: 3.6 }];
    R.insights.forEach(function (x) { blocks.push({ type: 'text', text: '• ' + x, size: 3.1 }); });
    blocks.push({ type: 'table', columns: [{ label: 'گروه', w: 2.4 }, { label: 'نوع', w: 1 }, { label: 'تعداد', w: 0.8, align: 'center' }, { label: 'مبلغ (تومان)', w: 1.4, align: 'center' }, { label: 'سهم', w: 0.8, align: 'center' }],
      rows: R.cats.map(function (c) { return [c.name, c.kind === 'business' ? 'فروشگاه' : 'شخصی', UI.fa(c.count), UI.money(c.total), UI.fa(R.total ? Math.round(c.total * 100 / R.total) : 0) + '٪']; }) });
    if (R.months.length) blocks.push({ type: 'table', columns: [{ label: 'ماه', w: 1 }, { label: 'هزینه (تومان)', w: 1.5, align: 'center' }], rows: R.months.map(function (m) { return [UI.fa(m.slice(0, 4) + '/' + m.slice(4, 6)), UI.money(R.byMonth[m])]; }) });
    blocks.push({ type: 'table', columns: [{ label: 'تاریخ', w: 1 }, { label: 'نوع', w: 0.7 }, { label: 'گروه', w: 1.6 }, { label: 'شرح', w: 2.4, wrap: true }, { label: 'مبلغ', w: 1.2, align: 'center' }],
      rows: R.rows.map(function (r) { return [r.date, r.dir === 'in' ? 'درآمد' : 'هزینه', r.cat, r.desc, UI.money(r.amount)]; }) });
    UI.toast('در حال ساخت PDF…');
    window.PDF.renderFlow(blocks, { title: 'دفتر روزانه ' + title, footer: (A.shop().name || '') }).then(function (b) { UI.fileSheet(b, 'daybook.pdf', 'application/pdf'); }, A.showErr);
  }

  /* ---------- reminder ---------- */
  var asked = {};
  function pending() { // days (since the feature was first used) that are not closed, newest first; today only after the reminder time
    var p = prefs(E); if (p.on === false) return [];
    var since = p.since || allKeys(E)[0] || todayKey(), t = todayKey(), out = [];
    for (var k = t, i = 0; k >= since && i < 7; k = addDays(k, -1), i++) {
      if (k === t && Date.now() < remindAt(k)) continue;
      var d = day(E, k); if (!d || !d.done) out.push(k);
    }
    return out;
  }
  A.daybookBanner = function () {
    var p = pending(); if (!p.length) return null;
    return h('a.alert.warn', { href: '#/daybook?d=' + p[0], style: { textDecoration: 'none' } }, h('div.grow', h('b', 'دفتر روزانه: '), p.length === 1 ? 'روز ' + label(p[0]) + ' بسته نشده — موجودی و هزینه‌ها را ثبت کنید.' : UI.fa(p.length) + ' روز بسته نشده (آخرین: ' + label(p[0]) + ').'));
  };
  function tick() {
    var p = prefs(E); if (p.on === false || !E.getMeta('shop')) return;
    var k = todayKey(); if (asked[k] || Date.now() < remindAt(k)) return;
    var d = day(E, k); if (d && d.done) return;
    asked[k] = true;
    var msg = 'وقت ثبت هزینه‌های امروز و موجودی آخر روز است.';
    try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) navigator.serviceWorker.ready.then(function (reg) { reg.showNotification('دفتر روزانه', { body: msg, tag: 'dbk-' + k }); }); } catch (e) { /* optional */ }
    if (!document.hidden && !/^#\/daybook/.test(location.hash)) UI.confirmBox(msg, 'باز کردن دفتر امروز').then(function (ok) { if (ok) A.go('#/daybook?d=' + k); });
  }
  A.startDaybookReminder = function () {
    // nothing is written at start-up: past days are asked only from the first day the user opened «دفتر روزانه»
    setTimeout(tick, 1500); setInterval(tick, 30000); // after the first page has been drawn (a route change closes open sheets) document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  };
})(typeof self !== 'undefined' ? self : this);
