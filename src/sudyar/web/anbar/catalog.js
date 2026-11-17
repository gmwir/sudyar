/* Catalog structure: category tree with per-group custom fields, suppliers, and pickers. */
(function () {
  'use strict';
  var A = window.App, E = A.E, UI = window.UI, h = UI.h, Core = window.Core, view = document.getElementById('view');
  var field = A.field, sel = A.sel;
  var SUGGESTED = [['قطعات یدکی خودرو', ['جلوبندی و تعلیق', 'لنت ترمز', 'فیلتر', 'برق خودرو', 'موتور']], ['جت فن', []], ['مسواک', []], ['لوازم جانبی', []]];

  function children(pid) {
    return E.list('categories').filter(function (c) { return (c.parentId || null) === (pid || null); })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'fa'); });
  }
  function treeRows(pid, depth, out, skip) {
    out = out || [];
    children(pid).forEach(function (c) { if (skip && skip.indexOf(c.id) >= 0) return; out.push({ c: c, depth: depth || 0 }); treeRows(c.id, (depth || 0) + 1, out, skip); });
    return out;
  }
  A.categoryTree = treeRows;
  function productCounts() {
    var direct = {}; E.list('products').forEach(function (p) { if (p.categoryId) direct[p.categoryId] = (direct[p.categoryId] || 0) + 1; });
    var total = {}; E.list('categories').forEach(function (c) { total[c.id] = E.categoryDescendants(c.id).reduce(function (s, id) { return s + (direct[id] || 0); }, 0); });
    return total;
  }
  A.categoryLabel = function (id) { return id && E.state.categories[id] ? E.categoryPath(id).join(' › ') : ''; };

  // ---------- categories screen ----------
  A.routes.categories = function () {
    A.setTitle('گروه‌های کالا', true, h('button.tb-btn', { onclick: function () { categoryForm(null, null); } }, '+ گروه'));
    var rows = treeRows(null), cnt = productCounts();
    view.appendChild(h('p.small.muted', { style: { margin: '0 4px 8px' } }, 'هر تعداد گروه و زیرگروه که لازم دارید بسازید (مثلاً قطعات یدکی › لنت ترمز). برای هر گروه می‌توانید مشخصات اختصاصی (مثل «خودروی سازگار» یا «سایز») تعریف کنید؛ زیرگروه‌ها آن را به ارث می‌برند.'));
    if (!rows.length) {
      view.appendChild(h('div.card', h('p', 'هنوز گروهی تعریف نشده است.'),
        h('button.btn.primary.block', { onclick: addSuggested }, 'ساخت گروه‌های پیشنهادی'), h('p.small.muted', SUGGESTED.map(function (g) { return g[0] + (g[1].length ? ' (' + g[1].join('، ') + ')' : ''); }).join(' · '))));
      return;
    }
    view.appendChild(h('div.list', rows.map(function (r) {
      var c = r.c;
      return h('div.li', { style: { paddingRight: (14 + r.depth * 18) + 'px', opacity: c.active === false ? 0.5 : 1 } },
        h('div.grow', h('div.t', (r.depth ? '└ ' : '') + c.name), h('div.s', UI.fa(cnt[c.id] || 0) + ' کالا' + ((c.attrDefs || []).length ? ' · ' + UI.fa(c.attrDefs.length) + ' مشخصه' : '') + (c.active === false ? ' · غیرفعال' : ''))),
        h('button.btn.sm', { onclick: function () { categoryForm(null, c.id); } }, '+ زیرگروه'),
        h('button.btn.sm', { onclick: function () { categoryForm(c, null); } }, 'ویرایش'));
    })));
  };
  function addSuggested() {
    var fns = [];
    SUGGESTED.forEach(function (g) {
      fns.push(function () { var ex = E.findCategoryByName(g[0], null); return ex ? { category: ex, changes: [] } : E.createCategory({ name: g[0] }, A.userCtx()); });
      var idx = fns.length - 1;
      g[1].forEach(function (sub) { fns.push(function (done) { var pid = done[idx].category.id; return E.findCategoryByName(sub, pid) ? { changes: [] } : E.createCategory({ name: sub, parentId: pid }, A.userCtx()); }); });
    });
    A.run(A.DB.batch(fns)).then(function () { UI.toast('گروه‌ها ساخته شد؛ هر وقت خواستید تغییرشان دهید.', 'ok'); A.route(); }, function () {});
  }
  function categoryForm(cat, parentId) {
    cat = cat || null;
    var name = h('input.in', { value: cat ? cat.name : '' });
    var skip = cat ? E.categoryDescendants(cat.id) : [];
    var parents = { '': '— گروه اصلی —' }; treeRows(null, 0, [], skip).forEach(function (r) { parents[r.c.id] = new Array(r.depth + 1).join('   ') + r.c.name; });
    var parent = sel(parents, cat ? (cat.parentId || '') : (parentId || ''));
    var active = h('input', { type: 'checkbox', checked: !cat || cat.active !== false });
    var defs = cat ? JSON.parse(JSON.stringify(cat.attrDefs || [])) : [], defBox = h('div');
    var inherited = (cat && cat.parentId) || parentId ? E.categoryAttrDefs(cat ? cat.parentId : parentId) : [];
    function drawDefs() {
      UI.clear(defBox);
      if (inherited.length) defBox.appendChild(h('p.small.muted', 'به ارث رسیده از گروه بالاتر: ' + inherited.map(function (d) { return d.label; }).join('، ')));
      defs.forEach(function (d, i) {
        var lab = h('input.in', { value: d.label, placeholder: 'عنوان (مثلاً خودروی سازگار)', oninput: function () { d.label = lab.value; } });
        var typ = sel(Core.ATTR_TYPES, d.type || 'text', { onchange: function () { d.type = typ.value; drawDefs(); } });
        var opts = h('input.in', { value: (d.options || []).join('، '), placeholder: 'گزینه‌ها با ویرگول: جلو، عقب', oninput: function () { d.options = opts.value.split(/[,،]/).map(function (x) { return x.trim(); }).filter(Boolean); } });
        defBox.appendChild(h('div.line', h('div.row', h('div.grow', lab), h('button.btn.sm.ghost', { onclick: function () { defs.splice(i, 1); drawDefs(); } }, '✕')),
          h('div', { style: { marginTop: '6px' } }, typ), d.type === 'select' ? h('div', { style: { marginTop: '6px' } }, opts) : null));
      });
      defBox.appendChild(h('button.btn.sm', { onclick: function () { defs.push({ key: 'f' + Core.randomCode(6).toLowerCase(), label: '', type: 'text', options: [] }); drawDefs(); } }, '+ مشخصه اختصاصی'));
    }
    drawDefs();
    var s = UI.sheet(cat ? 'ویرایش گروه' : 'گروه جدید', h('div', field('نام گروه', name, null, true), field('زیرمجموعه‌ی', parent),
      h('div.card', h('b', 'مشخصات اختصاصی کالاهای این گروه'), defBox), cat ? h('label.check', active, 'فعال') : null,
      h('button.btn.primary.block', { onclick: function () {
        var data = { name: name.value, parentId: parent.value || null, attrDefs: defs.filter(function (d) { return d.label && d.label.trim(); }) };
        A.run(function () { return cat ? E.updateCategory(cat.id, Object.assign(data, { active: active.checked }), A.userCtx()) : E.createCategory(data, A.userCtx()); })
          .then(function () { s.close(); UI.toast('ذخیره شد.', 'ok'); A.route(); }, function () {});
      } }, 'ذخیره'),
      cat ? h('button.btn.ghost.block', { onclick: function () {
        UI.confirmBox('گروه «' + cat.name + '» حذف شود؟ (فقط اگر کالا یا زیرگروه نداشته باشد)', 'حذف', true).then(function (ok) {
          if (ok) A.run(function () { return E.deleteCategory(cat.id, A.userCtx()); }).then(function () { s.close(); A.route(); }, function () {});
        });
      } }, 'حذف گروه') : null));
    setTimeout(function () { if (!cat) name.focus(); }, 80);
  }
  A.categoryForm = categoryForm;
  A.pickCategory = function (current, onPick) {
    var rows = treeRows(null).filter(function (r) { return r.c.active !== false || r.c.id === current; });
    var s = UI.sheet('انتخاب گروه کالا', h('div', h('div.list',
      h('button.li', { type: 'button', style: { width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', textAlign: 'right' }, onclick: function () { s.close(); onPick(null); } }, h('div.grow.t', '— بدون گروه —')),
      rows.map(function (r) {
        return h('button.li', { type: 'button', style: { width: '100%', background: r.c.id === current ? '#eef4fa' : 'none', border: 0, borderBottom: '1px solid var(--line)', textAlign: 'right', paddingRight: (14 + r.depth * 18) + 'px' }, onclick: function () { s.close(); onPick(r.c); } },
          h('div.grow.t', (r.depth ? '└ ' : '') + r.c.name));
      })), h('button.btn.block', { onclick: function () { s.close(); A.go('#/categories'); } }, 'مدیریت گروه‌ها')));
  };

  // ---------- suppliers ----------
  A.supplierForm = function (sp, onSaved, preset) {
    sp = sp || {};
    var name = h('input.in', { value: sp.name || preset || '' }), phone = h('input.in.ltr-in', { value: sp.phone || '', inputmode: 'tel' }), city = h('input.in', { value: sp.city || '' }), notes = h('textarea.in', { value: sp.notes || '' });
    var s = UI.sheet(sp.id ? 'ویرایش تأمین‌کننده' : 'تأمین‌کننده جدید', h('div', field('نام', name, null, true), field('تلفن', phone), field('شهر', city), field('توضیحات', notes),
      h('button.btn.primary.block', { onclick: function () {
        var d = { name: name.value, phone: phone.value, city: city.value, notes: notes.value };
        A.run(function () { return sp.id ? E.updateSupplier(sp.id, d, A.userCtx()) : E.createSupplier(d, A.userCtx()); }).then(function (r) { s.close(); UI.toast('ذخیره شد.', 'ok'); if (onSaved) onSaved(r.supplier); }, function () {});
      } }, 'ذخیره')));
  };
  A.pickSupplier = function (onPick) {
    var q = h('input.in', { type: 'search', placeholder: 'نام تأمین‌کننده…' }), list = h('div.list');
    function draw() {
      UI.clear(list);
      var n = Core.normText(q.value), r = E.list('suppliers').filter(function (x) { return x.active !== false && (!n || Core.normText(x.name).indexOf(n) >= 0); }).sort(function (a, b) { return a.name.localeCompare(b.name, 'fa'); });
      if (!r.length) list.appendChild(h('div.empty', 'تأمین‌کننده‌ای پیدا نشد.'));
      r.forEach(function (x) { list.appendChild(h('button.li', { type: 'button', style: { width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', textAlign: 'right' }, onclick: function () { s.close(); onPick(x); } }, h('div.grow', h('div.t', x.name), h('div.s', [x.phone, x.city].filter(Boolean).join(' · '))))); });
    }
    q.addEventListener('input', draw);
    var s = UI.sheet('انتخاب تأمین‌کننده', h('div', h('div.row', { style: { marginBottom: '8px' } }, q, h('button.btn.sm.primary', { onclick: function () { s.close(); A.supplierForm(null, onPick, q.value); } }, '+ جدید')), list));
    draw();
  };
  A.routes.suppliers = function () {
    A.setTitle('تأمین‌کنندگان', true, h('button.tb-btn', { onclick: function () { A.supplierForm(null, function () { A.route(); }); } }, '+ جدید'));
    var docs = E.list('docs'), r = E.list('suppliers').sort(function (a, b) { return a.name.localeCompare(b.name, 'fa'); });
    if (!r.length) { view.appendChild(h('div.card.empty', 'هنوز تأمین‌کننده‌ای ثبت نشده. هنگام «ورود کالا» هم می‌توانید تأمین‌کننده جدید بسازید.')); return; }
    view.appendChild(h('div.list', r.map(function (x) {
      var n = docs.filter(function (d) { return d.kind === 'in' && d.supplierId === x.id && d.status !== 'reversed'; }).length;
      return h('div.li', h('div.grow', h('div.t', x.name), h('div.s', [x.phone, x.city, UI.fa(n) + ' سند ورود'].filter(Boolean).join(' · '))),
        h('a.btn.sm', { href: '#/report/receipts?s=' + x.id }, 'خریدها'), h('a.btn.sm', { href: '#/party/' + x.id + '?t=supplier' }, 'حساب'), h('button.btn.sm', { onclick: function () { A.supplierForm(x, function () { A.route(); }); } }, 'ویرایش'));
    })));
  };
})();
