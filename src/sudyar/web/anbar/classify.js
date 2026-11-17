/* v2.3 product groups (offline, no AI, no network).
   Tree: «قطعات یدکی › سیستم › نوع قطعه» (e.g. قطعات یدکی › سیستم تعلیق و جلوبندی › سیبک زیر اکسل) and «متفرقه › نوع کالا» (e.g. متفرقه › مسواک).
   The CARS a part fits are a separate attribute (one part often fits several cars), never a group.
   The app GUESSES the group from the name, the user confirms once per group, and the answer is LEARNED
   (engine learn store, key «g:<part type>» -> category), so the same part type is placed automatically next time. */
(function (root) {
  'use strict';
  var Core = root.Core || (typeof require === 'function' ? require('./core.js') : null);
  var M = root.Match || (typeof require === 'function' ? require('./match.js') : null);
  var SPARE = 'قطعات یدکی', MISC = 'متفرقه', OTHER = 'سایر قطعات', LEGACY = 'یدکی'; // v2.4: the market's usual tree (v2.3 used «یدکی»)
  var SYS = {
    'سیستم تعلیق و جلوبندی': ['سیبک فرمان', 'سیبک زیر اکسل', 'سیبک طبق', 'سیبک تعادل', 'سیبک', 'بوش طبق', 'طبق', 'بوش', 'میل فرمان', 'میل تعادل', 'میل موجگیر',
      'لاستیک موجگیر', 'قرقری', 'جعبه فرمان', 'گردگیر', 'سر پلوس', 'پلوس', 'توپی چرخ', 'بلبرینگ چرخ', 'پمپ هیدرولیک', 'سگدست', 'کمک فنر', 'فنر لول', 'فنر',
      'توپی سر کمک', 'بالشتک کمک', 'ضربه گیر'],
    'سیستم ترمز': ['لنت ترمز', 'دیسک ترمز', 'کاسه چرخ', 'کالیپر', 'سیلندر چرخ', 'پمپ ترمز', 'شیلنگ ترمز', 'کفشک ترمز', 'بوستر ترمز', 'سیم ترمز دستی'],
    'موتور': ['واشر سرسیلندر', 'تسمه تایم', 'تسمه دینام', 'تسمه', 'پمپ روغن', 'دسته موتور', 'شمع', 'کوئل', 'سوپاپ', 'رینگ موتور', 'یاتاقان', 'پیستون', 'واشر'],
    'کلاچ و گیربکس': ['دیسک و صفحه', 'صفحه کلاچ', 'بلبرینگ کلاچ', 'پمپ کلاچ', 'سیم کلاچ', 'دسته دنده', 'کیت کلاچ'],
    'سیستم خنک‌کننده': ['رادیاتور', 'ترموستات', 'شیلنگ آب', 'منبع انبساط', 'فن رادیاتور', 'پمپ آب'],
    'سیستم سوخت‌رسانی': ['پمپ بنزین', 'انژکتور', 'شیلنگ بنزین', 'رگلاتور', 'گیج بنزین'],
    'برق و الکترونیک': ['دینام', 'استارت', 'باتری', 'سنسور', 'لامپ', 'رله', 'فیوز'],
    'فیلترها': ['فیلتر روغن', 'فیلتر هوا', 'فیلتر بنزین', 'فیلتر کابین', 'فیلتر'],
    'بدنه و تزئینات': ['آینه', 'دستگیره', 'قفل در', 'سپر', 'گلگیر', 'چراغ جلو', 'چراغ عقب', 'چراغ', 'شیشه بالابر', 'تیغه برف پاک کن', 'برف پاک کن']
  };
  // other spellings -> the canonical part type
  var ALIAS = { 'لنت': 'لنت ترمز', 'دیسک چرخ': 'دیسک ترمز', 'واتر پمپ': 'پمپ آب', 'واشر سر سیلندر': 'واشر سرسیلندر', 'کمک': 'کمک فنر', 'سیبک فرمون': 'سیبک فرمان' };
  var MISC_T = ['جت فن', 'مسواک', 'خوشبو کننده', 'خوشبوکننده', 'دستمال', 'واکس', 'شامپو', 'کاور', 'روکش', 'زیرپایی', 'کفپوش', 'شارژر', 'هولدر', 'عینک', 'اسپری'];
  var MISC_GROUP = ['متفرقه', 'سایر', 'لوازم جانبی', 'جانبی', 'اکسسوری', 'لوازم مصرفی'];

  var PH = [], SYS_OF = {};
  Object.keys(SYS).forEach(function (s) { SYS[s].forEach(function (t) { SYS_OF[t] = s; PH.push({ t: M.tokens(t), type: t, sys: s }); }); });
  Object.keys(ALIAS).forEach(function (a) { PH.push({ t: M.tokens(a), type: ALIAS[a], sys: SYS_OF[ALIAS[a]] }); });
  MISC_T.forEach(function (x) { PH.push({ t: M.tokens(x), type: x, misc: true }); });
  PH = PH.filter(function (p) { return p.t.length; });

  // ---------- cars ----------
  var PEUGEOT = { 206: 1, 207: 1, 405: 1, 301: 1, 2008: 1, 508: 1, 307: 1, 407: 1, 408: 1 }, PRIDE = { 111: 1, 131: 1, 132: 1, 141: 1, 151: 1 };
  var SINGLE = { 'سمند': 'سمند', 'دنا': 'دنا', 'رانا': 'رانا', 'ساینا': 'ساینا', 'کوییک': 'کوییک', 'ریو': 'ریو', 'اریو': 'آریو', 'زانتیا': 'زانتیا', 'پیکان': 'پیکان',
    'روا': 'روآ', 'نیسان': 'نیسان', 'مزدا': 'مزدا', 'کیا': 'کیا', 'هیوندای': 'هیوندای', 'رنو': 'رنو', 'ساندرو': 'ساندرو', 'سورن': 'سورن', 'هایما': 'هایما',
    'جک': 'جک', 'شاهین': 'شاهین', 'لوگان': 'ال ۹۰' };
  var CAR_WORD = { 'پژو': 1, 'پراید': 1, 'پارس': 1, 'تیبا': 1, 'تندر': 1, 'سایپا': 1, 'وانت': 1 };
  Object.keys(SINGLE).forEach(function (k) { CAR_WORD[k] = 1; });
  function fa(s) { return String(s).replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; }); }
  function isNum(t) { return /^\d+$/.test(t); }
  function carsOf(text) {
    var T = M.tokens(text || ''), out = [], seen = {};
    function add(c) { if (!seen[c]) { seen[c] = 1; out.push(c); } }
    for (var i = 0; i < T.length; i++) {
      var t = T[i], nx = T[i + 1];
      if (t === 'تیپ' || t === 'سری' || t === 'مدل') { i++; continue; } // «تیپ ۵» is a version, not a car
      if (t === 'پژو') { if (nx === 'پارس') { add('پژو پارس'); i++; } else if (nx && PEUGEOT[nx]) { add('پژو ' + fa(nx)); i++; } else add('پژو'); }
      else if (t === 'پارس') add('پژو پارس');
      else if (t === 'پراید') { if (nx && PRIDE[nx]) { add('پراید ' + fa(nx)); i++; } else add('پراید'); }
      else if ((t === 'ال' || t === 'تندر') && nx === '90') { add('ال ۹۰'); i++; }
      else if (t === 'تندر') add('ال ۹۰');
      else if (t === 'تیبا') { if (nx === '2') { add('تیبا ۲'); i++; } else add('تیبا'); }
      else if (t === 'ام' && nx === 'وی' && T[i + 2] === 'ام') { var n = T[i + 3]; if (n && isNum(n)) { add('ام وی ام ' + fa(n)); i += 3; } else { add('ام وی ام'); i += 2; } }
      else if (SINGLE[t]) add(SINGLE[t]);
      else if (isNum(t) && PEUGEOT[t]) add('پژو ' + fa(t));
      else if (isNum(t) && PRIDE[t]) add('پراید ' + fa(t));
    }
    return out;
  }

  // ---------- part type ----------
  function seqAt(T, P) { for (var i = 0; i + P.length <= T.length; i++) { var ok = true; for (var j = 0; j < P.length; j++) if (T[i + j] !== P[j]) { ok = false; break; } if (ok) return i; } return -1; }
  function phraseOf(T) {
    var best = null;
    PH.forEach(function (p) { var i = seqAt(T, p.t); if (i >= 0 && (!best || i < best.i || (i === best.i && p.t.length > best.p.t.length))) best = { i: i, p: p }; });
    return best && best.p;
  }
  var STOPW = { 'چپ': 1, 'راست': 1, 'ست': 1, 'جلو': 1, 'عقب': 1, 'بالا': 1, 'پایین': 1, 'داخلی': 1, 'خارجی': 1, 'تیپ': 1, 'مدل': 1, 'سری': 1, 'اصلی': 1, 'درجه': 1,
    'یک': 1, 'دو': 1, 'کامل': 1, 'طرح': 1, 'نو': 1, 'جدید': 1, 'قدیم': 1, 'دنده': 1, 'اتومات': 1 };
  // unknown part: its first 1–2 words, up to a side/position/car/number word (original spelling kept)
  function leadType(name, brand) {
    var bt = {}; M.tokens(brand || '').forEach(function (t) { bt[t] = 1; });
    var words = Core.normText(name || '').replace(/[()\[\]«»"'،,\-_/\\:;]+/g, ' ').split(' ').filter(Boolean), out = [];
    for (var i = 0; i < words.length && out.length < 2; i++) {
      var T = M.tokens(words[i]); if (!T.length) continue;
      if (T.some(function (t) { return isNum(t) || STOPW[t] || CAR_WORD[t] || bt[t]; })) break;
      out.push(words[i]);
    }
    return out.join(' ');
  }
  function keyOf(type) { return type ? 'g:' + M.compact(type) : null; }
  function isMiscGroup(g) { var n = M.compact(g || ''); return !!n && MISC_GROUP.some(function (x) { return M.compact(x) === n; }); }
  function sysGroup(g) { var n = M.compact(g || ''); var s = null; Object.keys(SYS).forEach(function (k) { if (M.compact(k) === n) s = k; }); return s; }

  function create(E) {
    function pathId(path) { // existing category with exactly this path, else null
      var parent = null;
      for (var i = 0; i < path.length; i++) { var c = E.findCategoryByName(path[i], parent); if (!c) return null; parent = c.id; }
      return parent;
    }
    /* guess the group of a product name. o: {brand, group (price-list header), cars (already known)}.
       -> {path, categoryId (existing or null), type, key (learn key), cars, conf: learned | known | guess} */
    function guess(name, o) {
      o = o || {};
      var T = M.tokens(name || ''), ph = phraseOf(T), grp = o.group && !M.carLike(o.group) ? o.group : null;
      var cars = []; (o.cars || []).concat(carsOf(name), o.group && M.carLike(o.group) ? carsOf(o.group) : []).forEach(function (c) { if (cars.indexOf(c) < 0) cars.push(c); });
      var type = ph ? ph.type : leadType(name, o.brand), key = keyOf(type), res = { type: type, key: key, cars: cars };
      var lc = key ? E.learnedCategory(key) : null;
      if (lc && E.categoryPath(lc)[0] !== LEGACY) { res.categoryId = lc; res.path = E.categoryPath(lc); res.conf = 'learned'; return res; }
      var gs = sysGroup(grp), spare = !!(cars.length || (ph && !ph.misc) || gs || (o.group && M.carLike(o.group)));
      if (ph && ph.misc) { res.path = [MISC, ph.type]; res.conf = 'known'; }
      else if (ph) { res.path = [SPARE, ph.sys, ph.type]; res.conf = 'known'; }
      else if (isMiscGroup(grp) || !spare) { res.path = [MISC, type || 'سایر']; res.conf = 'guess'; }
      else { res.path = [SPARE, gs || OTHER, type || 'سایر']; res.conf = 'guess'; }
      res.categoryId = pathId(res.path);
      return res;
    }
    // a category that belongs to the new tree (under «یدکی» or «متفرقه»)
    function organized(categoryId) { var p = categoryId ? E.categoryPath(categoryId) : []; return p.length > 1 && (p[0] === SPARE || p[0] === MISC); }
    return { guess: guess, pathId: pathId, organized: organized };
  }

  var api = { create: create, carsOf: carsOf, leadType: leadType, keyOf: keyOf, SPARE: SPARE, MISC: MISC, OTHER: OTHER, LEGACY: LEGACY, SYS: SYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Classify = api;
})(typeof self !== 'undefined' ? self : this);
