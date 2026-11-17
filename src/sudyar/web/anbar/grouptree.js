/* v2.9 «گروه‌های کالا» as a tree: open / close branches, counts, rename / move (the existing form), MERGE a group into
   another (products and sub-groups move, same-named sub-groups merge too), move selected products, and the groups that
   look like duplicates («قطعات یدکی» / «قطعات یدکی خودرو»). Every move is recorded and can be undone from «سابقه ورود».
   Nothing is guessed: a merge or a move is always shown and confirmed first. */
(function () {
  'use strict';
  var A = window.App, E = A.E, UI = window.UI, h = UI.h, Core = window.Core, view = document.getElementById('view');
  var STOP = { 'خودرو': 1, 'و': 1, 'سیستم': 1, 'قطعات': 1, 'ها': 1, 'های': 1, 'متعلقات': 1 };
  function kids(pid) { return E.list('categories').filter(function (c) { return (c.parentId || null) === (pid || null); }).sort(function (a, b) { return (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'fa'); }); }
  function normName(n) {
    var T = Core.normText(n).replace(/[‌_\-]/g, ' ').split(/\s+/).map(function (t) { return t.length > 3 && t[0] === 'و' && !STOP[t] ? t.slice(1) : t; }).filter(function (t) { return t && !STOP[t]; });
    return T.sort().join(' ');
  }
  function counts() {
    var direct = {}, tot = {}; E.list('products').forEach(function (p) { if (p.active !== false && p.categoryId) direct[p.categoryId] = (direct[p.categoryId] || 0) + 1; });
    E.list('categories').forEach(function (c) { tot[c.id] = E.categoryDescendants(c.id).reduce(function (s, id) { return s + (direct[id] || 0); }, 0); });
    return { direct: direct, tot: tot };
  }
  function openSet() { return A.lsGet('ay.treeOpen') || {}; }
  function record(steps, label, ctx) { steps.push(function (dn) { return E.recordImport({ kind: 'regroup', label: label }, dn, ctx); }); return steps; }

  A.routes.categories = function () {
    A.setTitle('گروه‌های کالا', true, h('button.tb-btn', { onclick: function () { A.categoryForm(null, null); } }, '+ گروه'));
    var C = counts(), open = openSet(), all = E.list('categories');
    if (!all.length) { view.appendChild(h('div.card.empty', 'هنوز گروهی تعریف نشده است. «+ گروه» را بزنید.')); return; }
    // groups that look like duplicates
    var by = {}; all.forEach(function (c) { if (c.active === false) return; var k = normName(c.name) + '|' + (c.parentId ? normName((E.state.categories[c.parentId] || {}).name || '') : ''); (by[k] = by[k] || []).push(c); });
    var dups = Object.keys(by).filter(function (k) { return by[k].length > 1; }).map(function (k) { return by[k]; });
    var noGroup = E.list('products').filter(function (p) { return p.active !== false && !p.categoryId; });
    if (dups.length || noGroup.length) view.appendChild(h('div.card', h('h2', 'نیاز به مرتب‌سازی'),
      noGroup.length ? h('div.line.row', h('div.grow', UI.fa(noGroup.length) + ' کالا بدون گروه'), h('button.btn.sm', { onclick: function () { moveProducts(null, noGroup); } }, 'گروه دادن')) : null,
      dups.map(function (g) {
        return h('div.line', h('div', 'گروه‌های هم‌معنا: ' + g.map(function (c) { return '«' + E.categoryPath(c.id).join(' › ') + '» (' + UI.fa(C.tot[c.id] || 0) + ')'; }).join(' و ')),
          h('div.row', g.map(function (c) { return h('button.btn.sm', { onclick: function () { merge(g.filter(function (x) { return x.id !== c.id; }), c); } }, 'همه در «' + c.name + '»' + (c.parentId ? ' (' + E.state.categories[c.parentId].name + ')' : '')); })));
      })));
    var tree = h('div.list');
    function rowsOf(pid, depth) {
      kids(pid).forEach(function (c) {
        var has = kids(c.id).length > 0, isOpen = !!open[c.id];
        tree.appendChild(h('div.li', { style: { paddingRight: (10 + depth * 18) + 'px', opacity: c.active === false ? 0.5 : 1 } },
          h('button.btn.sm.ghost', { style: { minWidth: '34px', visibility: has ? 'visible' : 'hidden' }, onclick: function () { open[c.id] = !isOpen; A.lsSet('ay.treeOpen', open); A.route(); } }, isOpen ? '▾' : '◂'),
          h('div.grow', h('div.t', c.name), h('div.s', UI.fa(C.tot[c.id] || 0) + ' کالا' + (C.direct[c.id] && has ? ' (' + UI.fa(C.direct[c.id]) + ' مستقیم)' : '') + (c.active === false ? ' · غیرفعال' : ''))),
          h('button.btn.sm', { onclick: function () { menu(c); } }, '⋯')));
        if (has && isOpen) rowsOf(c.id, depth + 1);
      });
    }
    rowsOf(null, 0);
    view.appendChild(h('div.row', { style: { margin: '8px 4px' } },
      h('button.btn.sm', { onclick: function () { all.forEach(function (c) { open[c.id] = true; }); A.lsSet('ay.treeOpen', open); A.route(); } }, 'باز کردن همه'),
      h('button.btn.sm', { onclick: function () { A.lsSet('ay.treeOpen', {}); A.route(); } }, 'بستن همه'),
      h('a.btn.sm', { href: '#/imports' }, 'سابقه و بازگرداندن')));
    view.appendChild(tree);
  };

  function menu(c) {
    var C = counts(), mine = E.list('products').filter(function (p) { return p.categoryId === c.id; });
    var s = UI.sheet('«' + c.name + '»', h('div.stack', h('p.small.muted', E.categoryPath(c.id).join(' › ') + ' — ' + UI.fa(C.tot[c.id] || 0) + ' کالا'),
      h('button.btn.block', { onclick: function () { s.close(); A.categoryForm(null, c.id); } }, '+ زیرگروه'),
      h('button.btn.block', { onclick: function () { s.close(); A.categoryForm(c, null); } }, 'تغییر نام / جابه‌جایی زیر گروه دیگر'),
      h('button.btn.block', { onclick: function () { s.close(); A.pickCategory(c.id, function (t) { if (!t) return; if (t.id === c.id || E.categoryDescendants(c.id).indexOf(t.id) >= 0) { UI.toast('گروه مقصد نمی‌تواند خودش یا زیرگروهش باشد.', 'bad'); return; } merge([c], t); }); } }, 'ادغام در گروه دیگر…'),
      mine.length ? h('button.btn.block', { onclick: function () { s.close(); moveProducts(c, mine); } }, 'انتقال کالاهای این گروه (' + UI.fa(mine.length) + ')') : null,
      h('a.btn.block', { href: '#/saleslist?g=' + encodeURIComponent(c.id) }, 'لیست قیمت همین گروه')));
  }

  /* merge each src into dst: products move; a sub-group with the same meaning merges into dst's, otherwise it moves under dst; src is deactivated */
  function merge(srcs, dst) {
    var steps = [], nP = 0, nG = 0, ctx = A.userCtx(), lines = [];
    function plan(src, to) {
      var items = E.list('products').filter(function (p) { return p.categoryId === src.id; }).map(function (p) { return { id: p.id, categoryId: to.id, reason: 'ادغام گروه «' + src.name + '» در «' + to.name + '»' }; });
      if (items.length) { nP += items.length; steps.push(function () { return E.setProductGroups(items, ctx); }); }
      kids(src.id).forEach(function (k) {
        var same = kids(to.id).filter(function (x) { return normName(x.name) === normName(k.name); })[0];
        if (same) { lines.push('«' + k.name + '» ← «' + same.name + '»'); plan(k, same); }
        else { nG++; steps.push(function () { return E.updateCategory(k.id, { parentId: to.id }, ctx); }); }
      });
      steps.push(function () { return E.updateCategory(src.id, { active: false }, ctx); });
    }
    srcs.forEach(function (s0) { plan(s0, dst); });
    var msg = srcs.map(function (x) { return '«' + E.categoryPath(x.id).join(' › ') + '»'; }).join(' و ') + ' در «' + E.categoryPath(dst.id).join(' › ') + '» ادغام می‌شود: ' + UI.fa(nP) + ' کالا و ' + UI.fa(nG) + ' زیرگروه منتقل می‌شوند' +
      (lines.length ? '؛ زیرگروه‌های هم‌معنا یکی می‌شوند: ' + lines.join('، ') : '') + '. گروه‌های خالی‌شده غیرفعال می‌شوند (حذف نمی‌شوند). با «سابقه و بازگرداندن» برمی‌گردد.';
    UI.confirmBox(msg, 'ادغام').then(function (ok) {
      if (!ok) return;
      A.run(A.DB.batch(record(steps, 'ادغام گروه — ' + srcs.map(function (x) { return x.name; }).join('، ') + ' ← ' + dst.name, ctx))).then(function () { UI.toast('ادغام شد.', 'ok'); A.route(); }, function () {});
    });
  }

  /* move chosen products of a group (or without a group) to another group */
  function moveProducts(c, list) {
    var picks = {}, q = h('input.in', { type: 'search', placeholder: 'فیلتر نام…' }), box = h('div.list'), cnt = h('b');
    function draw() {
      UI.clear(box); var n = Core.normText(q.value);
      list.filter(function (p) { return !n || Core.normText(p.name + ' ' + (p.brand || '')).indexOf(n) >= 0; }).slice(0, 400).forEach(function (p) {
        var ch = h('input', { type: 'checkbox', checked: !!picks[p.id] }); ch.addEventListener('change', function () { picks[p.id] = ch.checked; upd(); });
        box.appendChild(h('label.li', ch, h('div.grow', h('div.t', p.name), h('div.s', [p.brand, p.sku].filter(Boolean).join(' · ')))));
      });
    }
    function upd() { cnt.textContent = UI.fa(Object.keys(picks).filter(function (k) { return picks[k]; }).length) + ' انتخاب'; }
    q.addEventListener('input', draw);
    var s = UI.sheet(c ? 'انتقال از «' + c.name + '»' : 'کالاهای بدون گروه', h('div.stack', q,
      h('div.row', h('button.btn.sm', { onclick: function () { var n = Core.normText(q.value); list.forEach(function (p) { if (!n || Core.normText(p.name + ' ' + (p.brand || '')).indexOf(n) >= 0) picks[p.id] = true; }); draw(); upd(); } }, 'انتخاب همه (فیلترشده)'),
        h('button.btn.sm', { onclick: function () { picks = {}; draw(); upd(); } }, 'هیچ‌کدام'), cnt), box,
      h('button.btn.primary.block', { onclick: function () {
        var ids = Object.keys(picks).filter(function (k) { return picks[k]; }); if (!ids.length) { UI.toast('کالایی انتخاب نشده است.', 'bad'); return; }
        A.pickCategory(c ? c.id : null, function (t) {
          if (!t) return;
          UI.confirmBox(UI.fa(ids.length) + ' کالا به «' + E.categoryPath(t.id).join(' › ') + '» منتقل شود؟', 'انتقال').then(function (ok) {
            if (!ok) return; var ctx = A.userCtx();
            A.run(A.DB.batch(record([function () { return E.setProductGroups(ids.map(function (id) { return { id: id, categoryId: t.id }; }), ctx); }], 'انتقال ' + UI.fa(ids.length) + ' کالا به «' + t.name + '»', ctx)))
              .then(function () { s.close(); UI.toast('منتقل شد.', 'ok'); A.route(); }, function () {});
          });
        });
      } }, 'انتقال به گروه…')));
    draw(); upd();
  }
})();
