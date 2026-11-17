/* Data safety UI: schema migration at start-up, backup (optionally password-protected), restore with
   verification, data health-check screen, safety snapshots. Nothing here ever "auto-fixes" data. */
(function () {
  'use strict';
  var A = window.App, E = A.E, DB = A.DB, UI = window.UI, h = UI.h, Core = window.Core, J = window.Jalali, view = document.getElementById('view');

  function stamp() { var d = new Date(), j = J.g2j(d.getFullYear(), d.getMonth() + 1, d.getDate()); return j[0] + '-' + ('0' + j[1]).slice(-2) + '-' + ('0' + j[2]).slice(-2) + '_' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2); }
  A.stamp = stamp;

  /* Start-up: read raw data; if it was written by an older schema, (1) save a safety snapshot of the RAW data,
     (2) migrate a copy, (3) verify invariants (ids, stock, invoice money, balances unchanged), (4) save.
     If verification fails nothing is written and the user is told. */
  A.prepareData = function () {
    return DB.readAll().then(function (raw) {
      var v = DB.schemaOf(raw), empty = !raw.products.length && !raw.docs.length && !raw.customers.length;
      if (v === Core.SCHEMA_VERSION) { E.load(raw); return { migrated: false }; }
      if (v > Core.SCHEMA_VERSION) throw Object.assign(new Error('این اطلاعات با نسخه جدیدتر برنامه ذخیره شده است. صفحه را دوباره باز کنید تا نسخه جدید بارگذاری شود.'), { code: 'NEWER_SCHEMA' });
      var m = Core.migrate(raw);
      var diffs = Core.sameInvariants(Core.invariants(raw), Core.invariants(m.data), false);
      var test = Core.createEngine(); test.load(JSON.parse(JSON.stringify(m.data)));
      if (diffs.length) {
        var e = new Error('به‌روزرسانی ساختار داده متوقف شد چون نتیجه با داده‌های قبلی یکسان نبود. هیچ تغییری ذخیره نشد. ' + diffs.slice(0, 3).join(' | '));
        e.code = 'MIGRATION_FAILED'; e.raw = raw; throw e;
      }
      return (empty ? Promise.resolve() : DB.putSnapshot('pre-migrate', raw, 3)).then(function () {
        var meta = m.data.meta.filter(function (x) { return x.id === 'migrations'; })[0];
        var logs = (meta && meta.v) || [];
        logs.push({ at: Date.now(), from: m.from, to: m.to, log: m.log });
        m.data.meta = m.data.meta.filter(function (x) { return x.id !== 'migrations'; }).concat([{ id: 'migrations', v: logs }]);
        return DB.replaceAll(m.data);
      }).then(function () { return { migrated: !empty, from: m.from, to: m.to, log: m.log }; });
    });
  };
  A.emptyData = function () { return Core.migrate({}).data; };

  // ---------------- backup ----------------
  A.backup = function () {
    var pw = h('input.in', { type: 'password', autocomplete: 'new-password', placeholder: 'اختیاری' }), pw2 = h('input.in', { type: 'password', autocomplete: 'new-password', placeholder: 'تکرار رمز' });
    var btn = h('button.btn.primary.block', { onclick: go }, 'ساخت فایل پشتیبان');
    var s = UI.sheet('فایل پشتیبان', h('div',
      h('p.small', 'فایل پشتیبان شامل همه کالاها، اسناد، مشتریان (نام و تلفن) و پرداخت‌هاست. اگر آن را در پیام‌رسان یا فضای ابری ذخیره می‌کنید، برایش رمز بگذارید.'),
      A.field('رمز فایل (اختیاری)', pw), A.field('تکرار رمز', pw2),
      h('p.small.muted', 'رمز را فراموش نکنید؛ بدون آن، فایل رمزدار قابل بازیابی نیست.'), btn));
    function go() {
      if (pw.value !== pw2.value) { UI.toast('رمز و تکرار آن یکسان نیستند.', 'bad'); return; }
      if (pw.value && pw.value.length < 6) { UI.toast('رمز فایل حداقل ۶ کاراکتر باشد.', 'bad'); return; }
      var hc = E.healthCheck();
      btn.disabled = true; btn.textContent = 'در حال ساخت…';
      A.run(function () { return E.putMeta('backup', { at: Date.now(), encrypted: !!pw.value, health: hc.critical }); }).then(function () {
        return window.Backup.make(E.exportAll(), { app: A.version, password: pw.value || null });
      }).then(function (txt) {
        s.close(); A.route();
        UI.fileSheet(new Blob([txt], { type: 'application/json' }), 'amiran-backup_' + stamp() + (pw.value ? '_locked' : '') + '.json', 'application/json',
          (hc.critical ? '⚠ بررسی سلامت ' + UI.fa(hc.critical) + ' مشکل جدی نشان می‌دهد؛ این فایل همان وضعیت را نگه می‌دارد. ' : '') + 'فایل را در Files، iCloud Drive یا پیام‌رسان ذخیره کنید.');
      }).catch(function (e) { btn.disabled = false; btn.textContent = 'ساخت فایل پشتیبان'; A.showErr(e); });
    }
  };
  // ---------------- restore ----------------
  A.restore = function () {
    UI.pickFile('.json,application/json,text/plain').then(function (f) {
      if (!f) return;
      UI.readFileBytes(f).then(function (b) {
        var text = new TextDecoder('utf-8').decode(b);
        var ask = window.Backup.isEncrypted(text) ? UI.promptBox('فایل رمزدار', 'رمز فایل پشتیبان', { ltr: true }) : Promise.resolve(null);
        return ask.then(function (pw) {
          if (window.Backup.isEncrypted(text) && !pw) return null;
          return window.Backup.parse(text, pw);
        }).then(function (r) { if (r) A.confirmRestore({ data: r.data, createdAt: r.createdAt, source: f.name, encrypted: r.encrypted }); });
      }).catch(A.showErr);
    });
  };
  A.confirmRestore = function (o) {
    var m, test, h1;
    try {
      m = Core.migrate(o.data);
      var diffs = Core.sameInvariants(Core.invariants(o.data), Core.invariants(m.data), false);
      if (diffs.length) throw new Error('تبدیل نسخه فایل پشتیبان، اعداد آن را تغییر می‌داد؛ بازیابی متوقف شد.');
      test = Core.createEngine(); test.load(JSON.parse(JSON.stringify(m.data)));
      h1 = test.healthCheck();
    } catch (e) { UI.toast(A.errMsg(e) || 'داده‌های فایل قابل بارگذاری نیست.', 'bad', 6000); return; }
    var d = m.data;
    var s = UI.sheet('بازیابی اطلاعات', h('div.stack', h('p', 'منبع: ', h('b', o.source || '')), h('p.small', 'تاریخ نسخه: ' + UI.dateFa(o.createdAt, true) + (o.encrypted ? ' · رمزدار ✓' : '')),
      h('p.small', UI.fa(d.products.length) + ' کالا، ' + UI.fa(d.customers.length) + ' مشتری، ' + UI.fa(d.docs.length) + ' سند، ' + UI.fa(d.payments.length) + ' پرداخت'),
      m.from < m.to ? h('p.small.muted', 'این فایل از نسخه قدیمی‌تر است و هنگام بازیابی به ساختار جدید تبدیل می‌شود (بدون تغییر موجودی و مبالغ).') : null,
      h1.critical ? h('div.alert.bad', 'بررسی سلامت این فایل ' + UI.fa(h1.critical) + ' مشکل جدی نشان می‌دهد: ' + h1.issues.filter(function (i) { return i.severity === 'critical'; }).slice(0, 3).map(function (i) { return i.message; }).join(' / '))
        : h('div.alert.ok', 'بررسی سلامت فایل: بدون مشکل جدی ✓' + (h1.warnings ? ' (' + UI.fa(h1.warnings) + ' هشدار)' : '')),
      (function () { // v2.1: the period lock travels with the data; moving it back must be explicit
        var cur = E.closedThrough(), pm = (d.meta || []).filter(function (x) { return x.id === 'periods'; })[0], fileLock = pm && pm.v && typeof pm.v.closedThrough === 'number' ? pm.v.closedThrough : null;
        if (cur == null || (fileLock != null && fileLock >= cur)) return fileLock != null ? h('p.small', 'دوره مالی در این فایل تا ' + UI.dateFa(fileLock) + ' بسته است.') : null;
        return h('div.alert.bad', h('b', 'هشدار قفل دوره مالی: '), 'اکنون اسناد تا ' + UI.dateFa(cur) + ' قفل هستند، ولی ' + (fileLock == null ? 'در این فایل هیچ دوره‌ای بسته نیست' : 'این فایل فقط تا ' + UI.dateFa(fileLock) + ' بسته است') + '. با بازیابی، قفل به عقب برمی‌گردد و اسناد آن بازه دوباره قابل تغییر می‌شوند.');
      })(),
      h('div.alert.warn', 'همه اطلاعات فعلی این دستگاه با این نسخه جایگزین می‌شود. یک نسخه داخلی از وضعیت فعلی نگه داشته می‌شود.'),
      h('button.btn.danger.block', { onclick: function () {
        A.manager('بازیابی اطلاعات').then(function (ctx) {
          if (!ctx) return;
          var cur = E.exportAll(), has = cur.products.length + cur.docs.length + cur.customers.length;
          (has ? DB.putSnapshot('pre-restore', cur, 3) : Promise.resolve()).then(function () { return DB.replaceAll(d); }).then(function () {
            s.close(); UI.toast('اطلاعات بازیابی شد.', 'ok', 4000); A.go('#/');
          }).catch(A.showErr);
        });
      } }, 'جایگزینی اطلاعات')));
  };

  // ---------------- health check ----------------
  var SEV = { critical: ['جدی', 'bad'], warning: ['هشدار', 'warn'], info: ['اطلاع', 'ok'] };
  A.routes.health = function () {
    A.setTitle('بررسی سلامت داده‌ها', true);
    var t0 = performance.now(), r = E.healthCheck(), ms = Math.round(performance.now() - t0);
    view.appendChild(h('div.alert.' + (r.critical ? 'bad' : r.warnings ? 'warn' : 'ok'), h('div.grow',
      h('b', r.critical ? UI.fa(r.critical) + ' مشکل جدی' : 'مشکل جدی پیدا نشد ✓'), r.warnings ? ' · ' + UI.fa(r.warnings) + ' هشدار' : '',
      h('div.small', 'موجودی هر کالا با گردش‌ها، لایه‌های بهای خرید، جمع و پرداخت و مانده هر فاکتور، مرجوعی‌ها، شماره‌گذاری اسناد، ارتباط بین کالا/سند/مشتری/پرداخت و بارکدها بررسی شد (' + UI.fa(ms) + ' میلی‌ثانیه). این بررسی هیچ داده‌ای را تغییر نمی‌دهد.'))));
    if (r.critical) view.appendChild(h('div.card', h('b', 'چه باید کرد؟'), h('ol.small', { style: { paddingRight: '18px' } },
      h('li', 'از وضعیت فعلی فایل پشتیبان بگیرید (برای بررسی بعدی).'),
      h('li', 'اگر مشکل پس از بازیابی یک فایل پیدا شد، نسخه داخلی «قبل از بازیابی» را در تنظیمات برگردانید.'),
      h('li', 'مغایرت موجودی را با شمارش واقعی و «اصلاح موجودی» (با علت) برطرف کنید.'),
      h('li', 'فایل پشتیبان و این فهرست را برای پشتیبان فنی بفرستید.'))));
    if (!r.issues.length) return;
    var orphan = r.issues.filter(function (i) { return i.code === 'BILL_ON_REVERSED'; }).length; // v2.11: repair old false supplier debts (by reversal entries, never deletes)
    if (orphan) view.appendChild(h('div.card', h('b', UI.fa(orphan) + ' بدهی خرید کاذب (سند ورود آن برگشت خورده)'),
      h('p.small.muted', 'ترمیم: برای هر کدام یک «ابطال» با تاریخ امروز ثبت می‌شود؛ چیزی حذف نمی‌شود و پرداخت‌های انجام‌شده به‌صورت بستانکاری تأمین‌کننده می‌ماند. فقط با رمز مدیر.'),
      h('button.btn.primary.block', { onclick: function () {
        UI.confirmBox(UI.fa(orphan) + ' بدهی کاذب ابطال شود؟', 'ابطال با سند').then(function (ok) {
          if (!ok) return; var key = UI.opKey('orphanbills');
          A.manager('ترمیم بدهی‌های کاذب خرید').then(function (ctx) { if (!ctx) return;
            A.run(function () { return E.voidOrphanBills({ opKey: key }, ctx); }).then(function () { UI.toast('ترمیم ثبت شد.', 'ok'); A.route(); }, function () {});
          });
        });
      } }, 'ترمیم بدهی‌های کاذب')));
    view.appendChild(h('div.list', r.issues.slice(0, 300).map(function (i) {
      var link = i.ref && i.ref.productId ? '#/product/' + i.ref.productId : i.ref && i.ref.docId ? '#/doc/' + i.ref.docId : null;
      return h(link ? 'a.li' : 'div.li', link ? { href: link } : {}, h('span.badge.' + SEV[i.severity][1], SEV[i.severity][0]), h('div.grow.small', i.message));
    })));
    view.appendChild(h('button.btn.block', { onclick: function () {
      UI.fileSheet(window.XLSX.writeCsv([['شدت', 'کد', 'شرح']].concat(r.issues.map(function (i) { return [SEV[i.severity][0], i.code, i.message]; }))), 'health_' + stamp() + '.csv', 'text/csv');
    } }, 'خروجی فهرست مشکلات (CSV)'));
  };

  // ---------------- snapshots ----------------
  var SNAP = { auto: 'خودکار روزانه', 'pre-restore': 'قبل از بازیابی', 'pre-wipe': 'قبل از حذف', 'pre-migrate': 'قبل از به‌روزرسانی ساختار', 'pre-close': 'قبل از بستن دوره مالی', 'pre-reopen': 'قبل از بازگشایی دوره مالی' };
  A.snapshotsCard = function () {
    var box = h('div.card', h('h2', 'نسخه‌های خودکار روی همین دستگاه'), h('p.small.muted', 'روزی یک بار و قبل از هر بازیابی، حذف یا به‌روزرسانی ساختار، یک نسخه داخلی ذخیره می‌شود. این نسخه‌ها جایگزین فایل پشتیبان نیستند (با حذف برنامه پاک می‌شوند).'));
    DB.listSnapshots().then(function (list) {
      if (!list.length) { box.appendChild(h('p.muted', 'هنوز نسخه‌ای ذخیره نشده.')); return; }
      box.appendChild(h('div.list', list.map(function (s) {
        return h('div.li', h('div.grow', h('div.t', SNAP[s.kind] || s.kind), h('div.s', UI.dateFa(s.ts, true) + ' · ' + UI.fa(Math.round(s.size / 1024)) + ' KB')),
          h('button.btn.sm', { onclick: function () { DB.getSnapshot(s.id).then(function (data) { A.confirmRestore({ data: data, createdAt: s.ts, source: 'نسخه داخلی ' + (SNAP[s.kind] || '') }); }); } }, 'بازگردانی'));
      })));
    });
    return box;
  };
})();
