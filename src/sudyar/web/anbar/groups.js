/* v2.3 product groups on screen: the proposals card (the app guesses -> the user confirms once per group -> learned)
   and the «مرتب‌سازی گروه‌ها» page that moves existing products into «قطعات یدکی › سیستم › نوع قطعه» / «متفرقه › نوع کالا»
   and fills their cars. Nothing but the group and the cars of a product changes; the move is undone from the import history. */
(function () {
  'use strict';
  var A = window.App, E = A.E, DB = A.DB, UI = window.UI, h = UI.h, view = document.getElementById('view');
  var SEP = /\s*[›>\/\\|]\s*/;
  function pathTxt(p) { return (p || []).join(' › '); }
  var BADGE = { learned: ['یادگرفته', 'ok'], known: ['پیشنهاد اپ', 'ok'], guess: ['؟ حدس — بررسی کنید', 'warn'], user: ['انتخاب شما', 'ok'] };

  function buckets(items) {
    var by = {}, out = [];
    items.forEach(function (it) {
      var c = it.cls; if (!c || !c.path) return;
      var k = (c.key || '') + '|' + pathTxt(c.path), b = by[k];
      if (!b) { b = by[k] = { key: k, cls: c, items: [], on: true }; out.push(b); }
      b.items.push(it);
    });
    return out.sort(function (a, b) { return (a.cls.conf === 'guess' ? 0 : 1) - (b.cls.conf === 'guess' ? 0 : 1) || pathTxt(a.cls.path).localeCompare(pathTxt(b.cls.path), 'fa'); });
  }
  // change the group of a whole bucket (all items of one part type)
  function change(b, done) {
    var set = function (path, id) {
      b.items.forEach(function (it) { it.cls = Object.assign({}, it.cls, { path: path, categoryId: id || null, conf: 'user', changed: true }); });
      done();
    };
    var s = UI.sheet('گروه «' + (b.cls.type || pathTxt(b.cls.path)) + '»', h('div.stack',
      h('p.small.muted', 'برای همه ' + UI.fa(b.items.length) + ' کالای این دسته. انتخاب شما یاد گرفته می‌شود.'),
      h('button.btn.block', { onclick: function () { s.close(); A.pickCategory(b.cls.categoryId, function (c) { if (c) set(E.categoryPath(c.id), c.id); }); } }, 'انتخاب از گروه‌های موجود'),
      h('button.btn.block', { onclick: function () {
        s.close();
        UI.promptBox('مسیر گروه', 'سطح‌ها را با › جدا کنید', { value: pathTxt(b.cls.path) }).then(function (v) {
          var path = String(v || '').split(SEP).map(function (x) { return x.trim(); }).filter(Boolean);
          if (path.length) set(path, A.classifier().pathId(path));
        });
      } }, 'نوشتن مسیر (مثلاً قطعات یدکی › سیستم ترمز › لنت ترمز)')));
  }
  /* the proposals card. items: [{name, cls}] (cls from A.classifier().guess). opts.select: a checkbox per bucket */
  A.groupCard = function (items, onChange, opts) {
    opts = opts || {};
    var B = buckets(items), card = h('div.card');
    var nGuess = B.filter(function (b) { return b.cls.conf === 'guess'; }).length;
    card.appendChild(h('h2', (opts.title || 'گروه کالاها') + ' (' + UI.fa(B.length) + ' دسته)'));
    card.appendChild(h('p.small.muted', 'اپ گروه هر کالا را از نامش حدس زده است. موارد «؟» را بررسی و در صورت نیاز «تغییر» دهید؛ با ثبت، انتخاب‌ها یاد گرفته می‌شوند و دفعه بعد خودکار اعمال می‌شوند. خودرو جدا از گروه ذخیره می‌شود.'));
    if (nGuess) card.appendChild(h('div.small', { style: { color: 'var(--warn)', marginBottom: '6px' } }, '⚠ ' + UI.fa(nGuess) + ' دسته حدسی است.'));
    B.forEach(function (b) {
      var bd = BADGE[b.cls.conf] || BADGE.known, names = b.items.map(function (it) { return it.name; });
      var chk = opts.select ? h('input', { type: 'checkbox', checked: b.items.every(function (it) { return it.on !== false; }) }) : null;
      if (chk) chk.addEventListener('change', function () { b.items.forEach(function (it) { it.on = chk.checked; }); if (opts.onToggle) opts.onToggle(); });
      card.appendChild(h('div', { style: { borderTop: '1px solid var(--line)', padding: '8px 0' } },
        h('div.row', chk, h('div.grow', h('b', pathTxt(b.cls.path)), ' ', h('span.badge.' + bd[1], bd[0]), b.cls.categoryId ? null : h('span.small.muted', ' (گروه جدید)')),
          h('button.btn.sm', { type: 'button', onclick: function () { change(b, onChange); } }, 'تغییر')),
        h('div.small.muted', UI.fa(names.length) + ' کالا: ' + names.slice(0, 3).join('، ') + (names.length > 3 ? '…' : ''))));
    });
    return card;
  };
  /* batch steps for the groups of these items: creates missing paths (one step each) and, at the end, learns every
     confirmed part type. -> {catId(it, dn), learnStep} */
  A.planGroups = function (items, steps, ctx) {
    var idx = {};
    items.forEach(function (it) {
      var c = it.cls; if (!c || !c.path) return;
      var k = pathTxt(c.path); if (idx[k]) return;
      var ex = c.categoryId && E.state.categories[c.categoryId] ? c.categoryId : A.classifier().pathId(c.path);
      if (ex) idx[k] = { id: ex };
      else { idx[k] = { step: steps.length }; var path = c.path.slice(); steps.push(function () { return E.ensureCategoryPath(path, ctx); }); }
    });
    function catId(it, dn) { var c = it.cls, o = c && c.path && idx[pathTxt(c.path)]; return !o ? null : o.id || (dn[o.step] && dn[o.step].category ? dn[o.step].category.id : null); }
    function learnStep(dn) {
      var by = {};
      items.forEach(function (it) { var c = it.cls; if (!c || !c.key || it.on === false || (c.conf === 'learned' && !c.changed)) return; var id = catId(it, dn); if (id) by[c.key] = id; });
      var L = Object.keys(by).map(function (k) { return { key: k, categoryId: by[k] }; });
      return L.length ? E.learn(L, ctx) : { changes: [] };
    }
    return { catId: catId, learnStep: learnStep };
  };
  A.parseCars = function (text) { return String(text || '').split(/[،,;؛\n]+/).map(function (x) { return x.trim(); }).filter(Boolean); };

  // ======================= regroup existing products =======================
  A.routes.regroup = function () {
    A.setTitle('مرتب‌سازی گروه‌ها', true);
    var C = A.classifier(), all = E.list('products').filter(function (p) { return p.active !== false; });
    var items = [], kept = 0;
    all.forEach(function (p) {
      if (C.organized(p.categoryId)) { kept++; return; }
      var cur = p.categoryId ? E.categoryPath(p.categoryId) : [], curTxt = cur.join(' ');
      var carCat = curTxt && window.Match.carLike(curTxt); // an old car-named group («پژو ۲۰۶») becomes the car
      var legacy = cur[0] === window.Classify.LEGACY; // v2.4: the v2.3 default tree «یدکی › …» moves to «قطعات یدکی › …»
      var cls = C.guess(p.name, { brand: p.brand, group: carCat ? curTxt : (cur[cur.length - 1] || ''), cars: p.cars });
      items.push({ p: p, name: p.name, cls: cls, on: !p.categoryId || carCat || legacy, cur: cur.join(' › '), legacy: legacy });
    });
    var box = h('div');
    // v2.4: empty old groups (car-named ones and the v2.3 «یدکی» tree) can be removed in one tap, deepest first
    var used = {}; E.list('products').forEach(function (p) { if (p.categoryId) used[p.categoryId] = 1; });
    var oldEmpty = E.list('categories').filter(function (c) {
      var pth = E.categoryPath(c.id), d = E.categoryDescendants(c.id);
      return (pth[0] === window.Classify.LEGACY || window.Match.carLike(pth.join(' '))) && !d.some(function (x) { return used[x]; });
    }).sort(function (a, b) { return E.categoryPath(b.id).length - E.categoryPath(a.id).length; });
    if (oldEmpty.length) view.appendChild(h('div.card', h('div.row', h('div.grow.small', UI.fa(oldEmpty.length) + ' گروه قدیمی خالی است (مثل «' + E.categoryPath(oldEmpty[0].id).join(' › ') + '»).'),
      h('button.btn.sm', { onclick: function () {
        UI.confirmBox(UI.fa(oldEmpty.length) + ' گروه خالی قدیمی حذف شود؟ کالایی در آن‌ها نیست.', 'حذف گروه‌های خالی', true).then(function (ok) {
          if (ok) A.run(DB.batch(oldEmpty.map(function (c) { return function () { return E.deleteCategory(c.id, A.userCtx()); }; }))).then(function () { UI.toast('حذف شد.', 'ok'); A.route(); }, function () {});
        });
      } }, 'حذف گروه‌های خالی'))));
    view.appendChild(h('div.card', h('p.small', 'کالاهایی که هنوز در ساختار «قطعات یدکی › سیستم › نوع قطعه» یا «متفرقه › نوع کالا» نیستند. اپ برای هر کالا گروه و خودروهایش را پیشنهاد می‌دهد؛ گروه‌های قدیمی که نام خودرو دارند (مثل «پژو ۲۰۶») به مشخصه «خودرو» تبدیل می‌شوند. فقط گروه و خودرو تغییر می‌کند (نه موجودی، قیمت یا اسناد) و از «سابقه ورود از فایل» قابل بازگرداندن است.'),
      h('div.small.muted', UI.fa(kept) + ' کالا از قبل مرتب است.')));
    view.appendChild(box);
    if (!items.length) { box.appendChild(h('div.card.empty', 'همه کالاها مرتب هستند.')); return; }
    function draw() {
      UI.clear(box);
      var other = items.filter(function (it) { return it.cur && !it.legacy && !window.Match.carLike(it.cur.replace(/›/g, ' ')); });
      if (other.length) box.appendChild(h('div.card.small', UI.fa(other.length) + ' کالا گروه دیگری دارند (مثل «' + other[0].cur + '»)؛ این‌ها تیک نخورده‌اند تا خودتان تصمیم بگیرید.'));
      box.appendChild(A.groupCard(items, draw, { select: true, title: 'پیشنهاد گروه', onToggle: foot }));
      var withCars = items.filter(function (it) { return it.cls.cars.length; }).length;
      box.appendChild(h('div.card.small.muted', 'خودرو برای ' + UI.fa(withCars) + ' کالا از نام یا گروه قبلی پیدا شد (روی صفحه هر کالا قابل ویرایش است).'));
      var act = h('div.sticky-act'); box.appendChild(act);
      function foot() {
        UI.clear(act);
        var n = items.filter(function (it) { return it.on !== false; }).length;
        act.appendChild(h('button.btn.primary.block', { disabled: !n, onclick: apply }, 'انتقال ' + UI.fa(n) + ' کالا'));
      }
      foot();
    }
    function apply() {
      var sel = items.filter(function (it) { return it.on !== false; }); if (!sel.length) return;
      var ctx = A.userCtx(), steps = [], G = A.planGroups(sel, steps, ctx);
      steps.push(function (dn) {
        return E.setProductGroups(sel.map(function (it) {
          var cars = it.cls.cars.slice(); (it.p.cars || []).forEach(function (c) { if (cars.indexOf(c) < 0) cars.push(c); });
          return { id: it.p.id, categoryId: G.catId(it, dn), cars: cars };
        }), ctx);
      });
      steps.push(G.learnStep);
      steps.push(function (dn) { return E.recordImport({ kind: 'regroup', label: 'مرتب‌سازی گروه‌ها — ' + UI.fa(sel.length) + ' کالا' }, dn, ctx); });
      A.run(DB.batch(steps)).then(function () { UI.toast(UI.fa(sel.length) + ' کالا منتقل شد؛ گروه‌ها یاد گرفته شد.', 'ok', 3500); A.route(); }, function () {});
    }
    draw();
  };
})();
