/* v2.1 — Financial period: close (with a mandatory backup the user confirms as saved), lock status, history,
   reopen (manager + reason + safety snapshot). The lock itself is enforced by the engine (core.js). */
(function () {
  'use strict';
  var A = window.App, E = A.E, DB = A.DB, UI = window.UI, h = UI.h, Core = window.Core, J = window.Jalali, view = document.getElementById('view');
  var EVID = { user: 'کاربر اعلام کرد ذخیره کرده است (برنامه ذخیره خارجی را تأیید نکرده است)', verified: 'فایل از محل ذخیره بازخوانی و صحت آن تأیید شد' };
  function money(v) { return UI.moneyT(v); }
  function prevMonthEnd() {
    var d = new Date(), j = J.g2j(d.getFullYear(), d.getMonth() + 1, d.getDate());
    var first = J.parse(j[0] + '/' + j[1] + '/1'); return first == null ? null : first - 1;
  }
  function summaryList(s) {
    return h('dl.kv',
      h('dt', 'فروش خالص (پس از مرجوعی و لغو)'), h('dd', money(s.salesNet)), h('dt', 'مرجوعی‌ها'), h('dd', money(-s.returnsNet)),
      h('dt', 'بهای تمام‌شده فروش (معلوم)'), h('dd', money(s.cogsKnown)), h('dt', 'سود ناخالص (معلوم)'), h('dd', money(s.grossProfitKnown) + (s.unknownCostLines ? ' — ' + UI.fa(s.unknownCostLines) + ' ردیف بدون بها' : '')),
      h('dt', 'خرید / ورود کالا (بهای معلوم)'), h('dd', money(s.purchases)), h('dt', 'دریافت از مشتریان'), h('dd', money(s.received)), h('dt', 'بازپرداخت به مشتریان'), h('dd', money(s.refunded)),
      h('dt', 'مطالبات در پایان دوره'), h('dd', money(s.receivable)), h('dt', 'بستانکاری مشتریان'), h('dd', money(-s.customerCredit)),
      h('dt', 'موجودی در پایان دوره'), h('dd', UI.qty(s.stockQty) + ' واحد — ارزش معلوم ' + money(s.stockValueKnown) + (s.stockIncomplete ? ' (' + UI.fa(s.stockIncomplete) + ' کالا با بهای ناقص)' : '')));
  }

  A.routes.period = function () {
    A.setTitle('دوره مالی', true);
    var info = E.periodInfo(), ct = info.closedThrough;
    var hc = E.healthCheck(), pIssues = hc.issues.filter(function (i) { return /^PERIOD_/.test(i.code); });
    view.appendChild(h('div.card', h('h2', 'وضعیت'),
      h('p', ct == null ? 'هیچ دوره‌ای بسته نشده است؛ همه تاریخ‌ها باز هستند.' : h('span', 'اسناد ', h('b', 'تا ' + UI.dateFa(ct)), ' بسته و قفل‌اند: ثبت، لغو یا اصلاح با تاریخ آن بازه ممکن نیست؛ اصلاح فقط با سند جبرانی در دوره باز.')),
      h('p.small.muted', 'ثبت هر سند یا پرداخت با تاریخ بیش از ' + UI.fa(info.backdateDays) + ' روز گذشته فقط با رمز مدیر ممکن است.'),
      ct == null ? null : pIssues.length ? h('div.alert.bad', pIssues.map(function (i) { return i.message; }).join(' / ')) : h('div.alert.ok', 'اثر انگشت و خلاصه دوره بسته با اطلاعات فعلی یکسان است ✓')));
    view.appendChild(closeCard(ct, hc));
    if (ct != null) view.appendChild(h('div.card', h('h2', 'بازگشایی'), h('p.small.muted', 'فقط برای اصلاح اشتباهی که با سند جبرانی ممکن نیست. با رمز مدیر و ذکر علت؛ پیش از آن یک نسخه داخلی ذخیره می‌شود و پس از اصلاح باید دوباره بست.'),
      h('button.btn.block', { onclick: reopen }, 'بازگشایی دوره (مدیر)')));
    if (info.history.length) view.appendChild(h('div.card', h('h2', 'سابقه'), h('div.list', info.history.slice().reverse().map(function (x) {
      if (x.action === 'reopen') return h('div.li', h('div.grow', h('div.t', 'بازگشایی: ' + UI.dateFa(x.from) + ' ← ' + (x.to == null ? 'همه باز' : UI.dateFa(x.to))), h('div.s', x.by + ' · ' + UI.dateFa(x.at, true) + ' · علت: ' + x.reason)));
      return h('details.li', h('summary', h('b', 'بستن تا ' + UI.dateFa(x.through)), h('div.s', x.by + ' · ' + UI.dateFa(x.at, true) + (x.reason ? ' · ' + x.reason : '') + ' · پشتیبان: ' + (EVID[x.backup && x.backup.evidence] || '—'))), summaryList(x.summary));
    }))));
  };

  function closeCard(ct, hc) {
    var st = { through: null, summary: null, backup: null, evidence: null };
    var def = prevMonthEnd(), dateIn = h('input.in', { inputmode: 'numeric', 'data-date': 1, value: def != null && (ct == null || def > ct) ? UI.fa(J.fmt(def)) : '', placeholder: '۱۴۰۵/۰۶/۳۱' });
    var reason = h('input.in', { placeholder: 'مثلاً پایان شهریور (اختیاری)' });
    var box = h('div'), card = h('div.card', h('h2', 'بستن دوره'), h('p.small.muted', 'همه اسناد تا پایان روز انتخاب‌شده قفل می‌شوند. پیش از بستن: بررسی سلامت، ساخت فایل پشتیبان و تأیید ذخیره آن الزامی است.'),
      A.field('بستن تا تاریخ (شامل همان روز)', dateIn), A.field('توضیح', reason), h('button.btn.block', { onclick: step1 }, '۱) بررسی و نمایش خلاصه'), box);
    function step1() {
      UI.clear(box); st.backup = null; st.evidence = null;
      var t = UI.parseDateInput(dateIn.value, true);
      if (t == null || isNaN(t)) { UI.toast('تاریخ را درست وارد کنید (مثال: ۱۴۰۵/۰۶/۳۱).', 'bad'); return; }
      if (t >= Date.now()) { UI.toast('دوره‌ای که هنوز تمام نشده قابل بستن نیست.', 'bad'); return; }
      if (ct != null && t <= ct) { UI.toast('تا ' + UI.dateFa(ct) + ' قبلاً بسته شده است.', 'bad'); return; }
      var h2 = E.healthCheck();
      if (h2.critical) { box.appendChild(h('div.alert.bad', h('div.grow', h('b', 'بررسی سلامت ' + UI.fa(h2.critical) + ' مشکل جدی نشان می‌دهد؛ تا رفع آن دوره بسته نمی‌شود. '), h('a', { href: '#/health' }, 'جزئیات ←')))); return; }
      var drafts = [['in', 'ورود کالا'], ['out', 'فروش / خروج'], ['purchase', 'فاکتور خرید']].filter(function (k) {
        var d = A.lsGet('ay.draft.' + k[0]); if (!d || !d.items || !d.items.length) return false;
        var ts = d.date ? UI.parseDateInput(d.date) : Date.now(); return ts != null && !isNaN(ts) && ts <= t;
      });
      if (drafts.length) { box.appendChild(h('div.alert.bad', 'پیش‌نویس ' + drafts.map(function (k) { return '«' + k[1] + '»'; }).join(' و ') + ' با تاریخ داخل این دوره باز است؛ ابتدا آن را ثبت یا پاک کنید.')); return; }
      st.through = t; st.summary = E.periodSummary(ct != null ? ct + 1 : null, t); st.negativeOk = null;
      box.appendChild(h('div', h('h3', 'خلاصه دوره ' + (ct != null ? 'از ' + UI.dateFa(ct + 1) + ' ' : '') + 'تا ' + UI.dateFa(t)), summaryList(st.summary),
        h('div.alert.ok', 'بررسی سلامت: بدون مشکل جدی ✓' + (h2.warnings ? ' (' + UI.fa(h2.warnings) + ' هشدار)' : ''))));
      // v2.1.1: negative stock at the end of the period is not closed silently
      var by = E.stockAsOf(t).byProduct, neg = Object.keys(by).filter(function (k) { return by[k].qty < 0; }).map(function (k) { var p = E.state.products[k]; return (p ? p.name + (p.sku ? ' (' + p.sku + ')' : '') : k) + ': ' + UI.qty(by[k].qty); });
      if (neg.length) {
        var why = h('input.in', { placeholder: 'علت (الزامی)' }), chk = h('input', { type: 'checkbox' });
        var goNeg = h('button.btn.block', { onclick: function () {
          if (!why.value.trim()) { UI.toast('علت را بنویسید.', 'bad'); return; }
          if (!chk.checked) { UI.toast('تأیید صریح را بزنید.', 'bad'); return; }
          st.negativeOk = { reason: why.value.trim() }; goNeg.disabled = true; step2();
        } }, 'ادامه با موجودی منفی');
        box.appendChild(h('div.card#neg-stock', h('div.alert.bad', h('div.grow', h('b', 'موجودی ' + UI.fa(neg.length) + ' کالا در پایان این دوره منفی است: '), neg.slice(0, 10).join('، ') + (neg.length > 10 ? '، …' : ''))),
          h('p.small', 'معمولاً یعنی فروشی با تاریخی پیش از تاریخ ثبت ورود همان کالا ثبت شده است (مثلاً کالا زودتر رسیده ولی ورودش دیرتر ثبت شده). لغو آن فروش با تاریخ امروز این موجودی منفی را در پایان این دوره از بین نمی‌برد.'),
          h('p.small.muted', 'اگر کالا واقعاً در آن تاریخ در مغازه بوده، علت را بنویسید و تأیید کنید؛ علت و فهرست کالاها در سابقه بستن دوره ثبت می‌شود. اگر مطمئن نیستید، دوره را نبندید و موضوع را بررسی کنید.'),
          A.field('علت', why, null, true), h('label.check', chk, 'تأیید صریح: موجودی منفی پایان این دوره عمدی است.'), goNeg));
        return;
      }
      step2();
    }
    function step2() {
      var pw = h('input.in', { type: 'password', autocomplete: 'new-password', placeholder: 'اختیاری' }), pw2 = h('input.in', { type: 'password', autocomplete: 'new-password', placeholder: 'تکرار رمز' });
      var status = h('div'), b2 = h('div.card', h('b', '۲) فایل پشتیبان (الزامی)'), A.field('رمز فایل (اختیاری)', pw), A.field('تکرار رمز', pw2), status);
      var mk = h('button.btn.primary.block', { onclick: function () {
        if (pw.value !== pw2.value) { UI.toast('رمز و تکرار آن یکسان نیستند.', 'bad'); return; }
        if (pw.value && pw.value.length < 6) { UI.toast('رمز فایل حداقل ۶ کاراکتر باشد.', 'bad'); return; }
        mk.disabled = true; mk.textContent = 'در حال ساخت…';
        A.run(function () { return E.putMeta('backup', { at: Date.now(), encrypted: !!pw.value, health: 0, forClose: st.through }); }).then(function () {
          var data = E.exportAll(), json = JSON.stringify(data);
          st.backup = { hash: Core.sha256Hex(json), at: Date.now(), version: E.version() }; st.evidence = null;
          return window.Backup.make(data, { app: A.version, password: pw.value || null });
        }).then(function (txt) {
          mk.disabled = false; mk.textContent = 'ساخت دوباره فایل پشتیبان';
          UI.fileSheet(new Blob([txt], { type: 'application/json' }), 'amiran-backup_before-close_' + A.stamp() + (pw.value ? '_locked' : '') + '.json', 'application/json', 'این فایل را در Files، iCloud Drive یا جای امن دیگری ذخیره کنید؛ سپس به همین صفحه برگردید.');
          drawStatus();
        }).catch(function (e) { mk.disabled = false; mk.textContent = 'ساخت فایل پشتیبان'; A.showErr(e); });
      } }, 'ساخت فایل پشتیبان');
      b2.insertBefore(mk, status);
      function drawStatus() {
        UI.clear(status);
        if (!st.backup) return;
        status.appendChild(h('p.small', 'فایل تولید شد (' + UI.dateFa(st.backup.at, true) + ').'));
        if (st.evidence) { status.appendChild(h('div.alert.' + (st.evidence === 'verified' ? 'ok' : 'warn'), EVID[st.evidence])); step3(); return; }
        status.appendChild(h('p', h('b', 'فایل را در Files، iCloud یا جای امن دیگری ذخیره کردید؟')));
        status.appendChild(h('div.grid2', h('button.btn', { onclick: function () { UI.toast('تا ذخیره فایل پشتیبان، دوره بسته نمی‌شود.', 'bad'); } }, 'نه / مطمئن نیستم'),
          h('button.btn.primary', { onclick: function () { st.evidence = 'user'; drawStatus(); } }, 'بله، ذخیره کردم')));
        status.appendChild(h('button.btn.block', { style: { marginTop: '8px' }, onclick: verify }, 'بازخوانی همان فایل از محل ذخیره (قویاً توصیه می‌شود)'));
      }
      function verify() {
        UI.pickFile('.json,application/json,text/plain').then(function (f) {
          if (!f) return;
          return UI.readFileBytes(f).then(function (b) {
            var text = new TextDecoder('utf-8').decode(b);
            var ask = window.Backup.isEncrypted(text) ? UI.promptBox('فایل رمزدار', 'رمز فایل پشتیبان', { ltr: true }) : Promise.resolve(null);
            return ask.then(function (p) { if (window.Backup.isEncrypted(text) && !p) return null; return window.Backup.parse(text, p); });
          }).then(function (r) {
            if (!r) return;
            if (Core.sha256Hex(JSON.stringify(r.data)) !== st.backup.hash) { UI.toast('این فایل با پشتیبانی که همین الان ساخته شد یکی نیست.', 'bad', 5000); return; }
            st.evidence = 'verified'; UI.toast('فایل بازخوانی شد و با اطلاعات فعلی یکسان است.', 'ok'); drawStatus();
          });
        }).catch(A.showErr);
      }
      box.appendChild(b2);
    }
    function step3() {
      if (box.querySelector('#close-go')) return;
      var go = h('button#close-go.btn.danger.block', { onclick: function () {
        A.manager('بستن دوره مالی').then(function (ctx) {
          if (!ctx) return;
          go.disabled = true;
          DB.putSnapshot('pre-close', E.exportAll(), 3).then(function () {
            return A.run(function () { return E.closePeriod({ through: st.through, reason: reason.value.trim(), backup: { hash: st.backup.hash, at: st.backup.at, evidence: st.evidence, version: st.backup.version }, negativeOk: st.negativeOk }, ctx); });
          }).then(function () { UI.toast('دوره تا ' + UI.dateFa(st.through) + ' بسته شد.', 'ok', 4000); A.route(); }, function () { go.disabled = false; });
        });
      } }, '۳) بستن دوره تا ' + UI.dateFa(st.through));
      box.appendChild(h('div.card', h('p.small', 'پس از بستن، هیچ سندی با تاریخ تا ' + UI.dateFa(st.through) + ' ثبت، لغو یا اصلاح نمی‌شود. دریافت وجه و مرجوعی فاکتورهای قدیمی با تاریخ امروز ممکن است و گزارش این دوره را تغییر نمی‌دهد.'), go));
    }
    return card;
  }

  function reopen() {
    var info = E.periodInfo(), ct = info.closedThrough, targets = { '': 'همه دوره‌ها باز شوند' };
    info.history.forEach(function (x) { if (x.action === 'close' && x.through < ct) targets[String(x.through)] = 'بسته تا ' + UI.dateFa(x.through) + ' بماند'; });
    A.manager('بازگشایی دوره مالی').then(function (ctx) {
      if (!ctx) return;
      var to = A.sel(targets, ''), why = h('input.in', { placeholder: 'علت (الزامی)' });
      var s = UI.sheet('بازگشایی دوره', h('div.stack', h('p.small', 'قفل فعلی: تا ' + UI.dateFa(ct)), A.field('پس از بازگشایی', to), A.field('علت', why, null, true),
        h('button.btn.danger.block', { onclick: function () {
          if (!why.value.trim()) { UI.toast('علت بازگشایی را بنویسید.', 'bad'); return; }
          DB.putSnapshot('pre-reopen', E.exportAll(), 3).then(function (sid) {
            return A.run(function () { return E.reopenPeriod({ to: to.value ? Number(to.value) : null, reason: why.value.trim(), snapshot: sid }, ctx); });
          }).then(function () { s.close(); UI.toast('دوره بازگشایی شد؛ پس از اصلاح دوباره ببندید.', 'ok', 4000); A.route(); }, function () {});
        } }, 'بازگشایی')));
    });
  }
})();
