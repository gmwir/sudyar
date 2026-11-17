/* v2.2 smart matching (offline, no AI, no network): finds the product meant by a damaged / differently written
   name or code (price lists, typed names, search), asks for confirmation, and LEARNS every confirmation or correction
   (stored by the engine in meta 'learn'), so the same text is recognised automatically next time.
   Safety rules: variants that differ in side (چپ/راست/ست), position (جلو/عقب, بالا/پایین), model number (۴۰۵/۲۰۶) or brand
   are never matched automatically. A fuzzy name alone never auto-matches: only an exact code, an exact unique name or
   a learned answer does. */
(function (root) {
  'use strict';
  var Core = root.Core || (typeof require === 'function' ? require('./core.js') : null);

  // ---------- normalization ----------
  var SYN = { peugeot: 'پژو', pegeot: 'پژو', pejo: 'پژو', 'پژوی': 'پژو', pride: 'پراید', samand: 'سمند', pars: 'پارس', tiba: 'تیبا', rio: 'ریو', dena: 'دنا',
    rana: 'رانا', runna: 'رانا', xantia: 'زانتیا', zantia: 'زانتیا', saipa: 'سایپا', 'سایپای': 'سایپا', kia: 'کیا', l: 'ال', tondar: 'تندر', logan: 'لوگان', 'تندر90': 'ال',
    left: 'چپ', lh: 'چپ', right: 'راست', rh: 'راست', front: 'جلو', rear: 'عقب', upper: 'بالا', lower: 'پایین', inner: 'داخلی', outer: 'خارجی',
    set: 'ست', 'جفت': 'ست', 'جفتی': 'ست', 'ستی': 'ست', // «ست» = left + right together (its own product)
    'جلویی': 'جلو', 'عقبی': 'عقب', 'چپی': 'چپ', 'راستی': 'راست', 'بالایی': 'بالا', 'پایینی': 'پایین', 'بیرونی': 'خارجی', 'درونی': 'داخلی',
    'زیراکسل': 'زیر اکسل', 'زیرآکسل': 'زیر اکسل', 'سیبکزیر': 'سیبک زیر', 'لنتترمز': 'لنت ترمز', 'کمکفنر': 'کمک فنر', 'سرپلوس': 'سر پلوس', 'جعبهفرمان': 'جعبه فرمان' };
  var STOP = { 'و': 1, 'با': 1, 'برای': 1, 'از': 1, 'به': 1, 'ی': 1, 'مدل': 1, 'کد': 1, 'عدد': 1, 'اصلی': 0 };
  // mutually exclusive details: a different value means a DIFFERENT product
  var DISC = [['چپ', 'راست', 'ست'], ['جلو', 'عقب'], ['بالا', 'پایین'], ['داخلی', 'خارجی'], ['دنده', 'اتومات'], ['کوتاه', 'بلند'], ['بزرگ', 'کوچک'], ['دیسکی', 'کاسه']];
  var DISC_OF = {}; DISC.forEach(function (g, i) { g.forEach(function (t) { DISC_OF[t] = i; }); });
  function base(s) {
    var t = Core.normText(s).replace(/[أإٱ]/g, 'ا').replace(/آ/g, 'ا').replace(/ؤ/g, 'و').replace(/ئ/g, 'ی').replace(/ـ/g, '')
      .replace(/[\-_\/\\.,:;()\[\]{}'"«»+*#!?،؛|]+/g, ' ');
    return t.replace(/(\d)([^\d\s])/g, '$1 $2').replace(/([^\d\s])(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
  }
  function tokens(s) {
    var out = [];
    base(s).split(' ').forEach(function (w) {
      if (!w) return;
      var m = SYN[w]; (m ? m.split(' ') : [w]).forEach(function (x) { if (!STOP[x]) out.push(x); });
    });
    return out;
  }
  function compact(s) { return tokens(s).join(''); }
  function codeNorm(s) { return Core.normText(s).replace(/[\s\-_.\/\\]+/g, '').toUpperCase(); }
  function isNum(t) { return /^\d+$/.test(t); }
  function lev(a, b, max) { // bounded Levenshtein
    if (a === b) return 0; var la = a.length, lb = b.length; if (Math.abs(la - lb) > max) return max + 1;
    var prev = [], cur = [], i, j; for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) { cur = [i]; var best = i; for (j = 1; j <= lb; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < best) best = cur[j]; } if (best > max) return max + 1; prev = cur; }
    return prev[lb];
  }
  function tokEq(a, b) { // exact for numbers and side/position words; small typos elsewhere
    if (a === b) return true;
    if (isNum(a) || isNum(b) || DISC_OF[a] != null || DISC_OF[b] != null) return false;
    var n = Math.min(a.length, b.length); if (n < 3) return false;
    var max = n >= 7 ? 2 : n >= 4 ? 1 : 0;
    if (max && lev(a, b, max) <= max) return true;
    return n >= 5 && (a.indexOf(b) === 0 || b.indexOf(a) === 0);
  }
  function details(T) { var d = { nums: [], disc: {} }; T.forEach(function (t) { if (isNum(t)) d.nums.push(t); if (DISC_OF[t] != null) d.disc[DISC_OF[t]] = t; }); return d; }
  // conflicts / missing details between two token lists
  function compare(qd, pd) {
    var hard = [], soft = 0;
    Object.keys(qd.disc).forEach(function (g) { if (pd.disc[g] && pd.disc[g] !== qd.disc[g]) hard.push(qd.disc[g] + ' ≠ ' + pd.disc[g]); else if (!pd.disc[g]) soft++; });
    Object.keys(pd.disc).forEach(function (g) { if (!qd.disc[g]) soft++; });
    var A = qd.nums, B = pd.nums, inA = {}, inB = {}; A.forEach(function (x) { inA[x] = 1; }); B.forEach(function (x) { inB[x] = 1; });
    var onlyA = A.filter(function (x) { return !inB[x]; }), onlyB = B.filter(function (x) { return !inA[x]; });
    if (onlyA.length && onlyB.length) hard.push(onlyA.join('،') + ' ≠ ' + onlyB.join('،'));
    else soft += onlyA.length + onlyB.length;
    return { hard: hard, soft: soft };
  }

  function create(E) {
    var IDX = { ver: -1 };
    function index() {
      var v = E.version(); if (IDX.ver === v) return IDX;
      var prods = [], byTok = {}, byCode = {}, byCompact = {}, vocab = {};
      Object.keys(E.state.products).forEach(function (id) {
        var p = E.state.products[id]; if (p.active === false) return;
        var T = tokens([p.name, p.shortName, p.model].join(' ')), BT = tokens(p.brand), all = T.concat(BT);
        var e = { k: prods.length, p: p, T: T, BT: BT, c: compact(p.name), cb: compact(p.name + ' ' + (p.brand || '')), d: details(T) };
        prods.push(e);
        all.forEach(function (t) { (byTok[t] = byTok[t] || []).push(e); vocab[t] = 1; });
        [p.sku].concat(p.barcodes || []).forEach(function (c) { var k = codeNorm(c); if (k) (byCode[k] = byCode[k] || []).push(e); });
        (byCompact[e.c] = byCompact[e.c] || []).push(e);
      });
      var byLen = {}; Object.keys(vocab).forEach(function (w) { (byLen[w.length] = byLen[w.length] || []).push(w); });
      IDX = { ver: v, prods: prods, byTok: byTok, byCode: byCode, byCompact: byCompact, byLen: byLen, near: {} };
      return IDX;
    }
    function nearTokens(ix, t) { // vocabulary tokens equal to t with a small typo (cached per index; only similar lengths are compared)
      if (ix.near[t]) return ix.near[t];
      var out = ix.byTok[t] ? [t] : [];
      if (!isNum(t) && DISC_OF[t] == null && t.length >= 3)
        for (var L = Math.max(3, t.length - 2); L <= t.length + 2; L++) (ix.byLen[L] || []).forEach(function (w) { if (w !== t && tokEq(t, w)) out.push(w); });
      if (t.length >= 5) Object.keys(ix.byLen).forEach(function (L) { if (+L > t.length + 2) ix.byLen[L].forEach(function (w) { if (w.indexOf(t) === 0) out.push(w); }); }); // prefix (جلوبند -> جلوبندی)
      return (ix.near[t] = out);
    }
    /* v2.9: two brand names are the same brand when written alike or when the user said so once (meta 'brandAlias': «S4T» = «اسفورتی») */
    function brandEq(a, b) {
      var x = compact(a), y = compact(b); if (!x || !y) return true; if (x === y || phon(x) === phon(y)) return true; // v2.9: strict — «آفورتیس» is NOT «اسفورتی» (a fuzzy brand match caused wrong list prices)
      var al = (E.getMeta && E.getMeta('brandAlias')) || {}; return !!(al[x] && al[x] === al[y]);
    }
    function scoreOne(q, e) {
      var qT = q.T; if (!qT.length) return null;
      var pT = e.T.concat(e.BT), used = {}, mq = 0, comp = 0, usedBrand = 0;
      qT.forEach(function (t) {
        for (var i = 0; i < pT.length; i++) if (!used[i] && tokEq(t, pT[i])) { used[i] = 1; mq++; if (i >= e.T.length) usedBrand++; return; }
        if (t.length >= 3 && e.cb.indexOf(t) >= 0) comp++; // compound written together / apart
      });
      var mp = Object.keys(used).length, den = e.T.length + (q.brand ? e.BT.length : usedBrand); // brand counts only when the query has one
      var cov = (mq + 0.8 * comp) / qT.length, prec = den ? Math.min(1, (mp + 1.6 * comp) / den) : 0;
      var s = 100 * (0.6 * Math.min(1, cov) + 0.4 * prec);
      if (q.c && (q.c === e.c || q.c === e.cb)) s = 100;
      var why = [], cf = compare(q.d, e.d);
      if (q.brand) { var qb = compact(q.brand), pb = compact(e.p.brand); if (pb && qb && !brandEq(q.brand, e.p.brand)) cf.hard.push('برند ' + q.brand + ' ≠ ' + e.p.brand); else if (pb && qb) s += 3; }
      s -= cf.soft * 6;
      if (cf.hard.length) { s = Math.min(s, 40); why = why.concat(cf.hard); }
      return { product: e.p, score: Math.max(0, Math.min(100, Math.round(s))), conflict: cf.hard.length ? cf.hard : null, why: why, kind: 'name' };
    }
    function learnKeys(q) {
      var keys = [], sid = q.supplierId ? 's:' + q.supplierId + '|' : '';
      var c = q.code ? codeNorm(q.code) : '', n = q.name ? compact(q.name + ' ' + (q.brand || '')) : '';
      if (c) { if (sid) keys.push(sid + 'c:' + c); keys.push('c:' + c); }
      if (n) { if (sid) keys.push(sid + 'n:' + n); keys.push('n:' + n); }
      return keys;
    }
    /* q: {name, code, brand, supplierId}. Returns {decision: auto|confirm|none, best, candidates[≤5]} */
    function match(q, opts) {
      opts = opts || {}; q = q || {};
      var ix = index(), cands = [], seen = {};
      function add(r) { if (!r || seen[r.product.id] && seen[r.product.id].score >= r.score) return; seen[r.product.id] = r; }
      // 1) learned answer (supplier-specific first)
      var keys = learnKeys(q);
      for (var i = 0; i < keys.length; i++) { var L = E.learned(keys[i]); if (L && E.state.products[L.productId]) { var lp = E.state.products[L.productId]; add({ product: lp, score: 100, kind: 'learned', why: ['قبلاً تأیید شده (' + L.n + ' بار)'], conflict: null, key: keys[i] }); break; } }
      // 2) exact code (SKU / factory barcode), then a code with one typo
      if (q.code) {
        var c = codeNorm(q.code);
        (ix.byCode[c] || []).forEach(function (e) { var bc = q.brand && e.p.brand && !brandEq(q.brand, e.p.brand) ? ['برند ' + q.brand + ' ≠ ' + e.p.brand] : null; // v2.9: a code of ANOTHER brand is never automatic
          add({ product: e.p, score: bc ? 60 : 100, kind: 'code', why: ['کد یکسان'].concat(bc || []), conflict: bc }); });
        if (c.length >= 6 && !ix.byCode[c]) Object.keys(ix.byCode).forEach(function (k) { if (Math.abs(k.length - c.length) <= 1 && lev(k, c, 1) <= 1) ix.byCode[k].forEach(function (e) { add({ product: e.p, score: 70, kind: 'code~', why: ['کد شبیه (' + k + ')'], conflict: null }); }); });
      }
      // 3) name
      if (q.name) {
        var Q = { T: tokens(q.name), c: compact(q.name), brand: q.brand || '' }; Q.d = details(Q.T);
        // candidates: products sharing (near-)tokens, weighted by rarity; only the best few are scored in full.
        // Very common words (in >30% of products) do not pick candidates when the query has rarer words.
        var N = ix.prods.length || 1, acc = ix.acc || (ix.acc = new Float64Array(N)), touched = [];
        var lists = []; Q.T.forEach(function (t) { var L = []; nearTokens(ix, t).forEach(function (w) { if (ix.byTok[w]) L.push(ix.byTok[w]); }); if (L.length) lists.push(L); });
        var dfOf = function (L) { return L.reduce(function (s2, x) { return s2 + x.length; }, 0); }, rare = lists.some(function (L) { return dfOf(L) <= N * 0.3; });
        lists.forEach(function (L) {
          var df = dfOf(L); if (rare && df > N * 0.3) return;
          var idf = Math.log(1 + N / df), mark = {};
          L.forEach(function (list) { for (var i = 0; i < list.length; i++) { var k = list[i].k; if (mark[k]) continue; mark[k] = 1; if (!acc[k]) touched.push(k); acc[k] += idf; } });
        });
        (ix.byCompact[Q.c] || []).forEach(function (e) { if (!acc[e.k]) touched.push(e.k); acc[e.k] += 1000; });
        var top = touched.sort(function (a, b) { return acc[b] - acc[a]; }).slice(0, opts.pool || 40).map(function (k) { return ix.prods[k]; });
        touched.forEach(function (k) { acc[k] = 0; });
        var ent = {}; top.forEach(function (e) { ent[e.p.id] = e; });
        Object.keys(ent)
          .forEach(function (id) { var r = scoreOne(Q, ent[id]); if (r && r.score >= (opts.min || 30)) add(r); });
      }
      cands = Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) { return b.score - a.score || (a.product.name < b.product.name ? -1 : 1); }).slice(0, opts.limit || 5);
      var best = cands[0] || null, second = cands[1], decision = 'none';
      if (best) {
        if (best.kind === 'learned' || (best.kind === 'code' && !best.conflict && !(second && second.kind === 'code' && !second.conflict))) decision = 'auto';
        else if (best.kind === 'name' && best.score === 100 && !best.conflict && !(second && second.score >= 90) && (ix.byCompact[compact(q.name)] || []).length === 1) { decision = 'confirm'; best.exact = true; } // v2.8: an exact unique NAME is still asked (only codes and learned answers are automatic)
        else if (best.score >= 55 && !best.conflict) decision = 'confirm';
      }
      return { decision: decision, best: best, candidates: cands, keys: keys };
    }
    // free-text search fallback: names and codes, nothing automatic
    function suggest(text, limit) {
      var r = match({ name: text, code: /\d{4,}|[A-Za-z]+\d|\d+[A-Za-z]/.test(text) ? text : '' }, { limit: limit || 6, min: 35 });
      return r.candidates;
    }
    /* ---------- v2.5 product search: ranked by similarity, typo-tolerant, offline ----------
       Every product field is tokenised the same way as the query (Persian/Arabic letters and digits, half-space,
       آ/ا, letters stuck to numbers «پژو206», synonyms «جفت = ست», «peugeot = پژو»). Each query word is scored against
       the vocabulary once: exact 1 · prefix while typing ~0.9 · same sound (ص/س، ز/ذ/ض/ظ، ت/ط، ح/ه، غ/ق) 0.92 ·
       one typo 0.74 · two typos (long words) 0.6 · inside a compound word 0.6. Numbers (۲۰۶ / ۴۰۵) and side / position
       words (چپ/راست، جلو/عقب…) are never matched fuzzily. Field weight: name 1, brand 0.92, short name 0.9, code 0.9,
       car / model 0.85, group 0.62, others 0.5. Products with ALL words come first («full»), best score first; when a
       word matches nothing, the most similar products are still returned (marked full:false) instead of an empty list. */
    var PH = { 'ذ': 'ز', 'ض': 'ز', 'ظ': 'ز', 'ص': 'س', 'ث': 'س', 'ط': 'ت', 'ح': 'ه', 'غ': 'ق' };
    function phon(w) { return w.replace(/[ذضظصثطحغ]/g, function (c) { return PH[c]; }); }
    var NOISE = { 'ها': 1, 'های': 1, 'ای': 1 };
    var FW = { n: 1, b: 0.92, s: 0.9, c: 0.85, g: 0.62, o: 0.5 };
    var SX = { ver: -1 };
    function sIndex() {
      var v = E.version(); if (SX.ver === v && SX.ents) return SX;
      var ents = [], vocab = {};
      Object.keys(E.state.products).forEach(function (id) {
        var p = E.state.products[id], a = p.attrs || {};
        var path = p.categoryId && E.state.categories[p.categoryId] ? E.categoryPath(p.categoryId).join(' ') : (p.category || '');
        var F = { n: tokens(p.name), b: tokens(p.brand), s: tokens(p.shortName), c: tokens([p.model, (p.cars || []).join(' ')].join(' ')), g: tokens(path),
          o: tokens([p.family, p.location, Object.keys(a).map(function (k) { return a[k]; }).join(' ')].join(' ')) };
        var toks = [];
        ['n', 'b', 's', 'c', 'g', 'o'].forEach(function (f) { F[f].forEach(function (t) { if (NOISE[t]) return; toks.push(t, f); vocab[t] = 1; }); });
        for (var bi2 = 0; bi2 + 1 < F.n.length; bi2++) { var j2 = F.n[bi2] + F.n[bi2 + 1]; if (!isNum(F.n[bi2]) && !isNum(F.n[bi2 + 1]) && j2.length >= 5) { toks.push(j2, 'n'); vocab[j2] = 1; } } // v2.9: «زیر اکسل» is also «زیراکسل» (and its typos)
        ents.push({ p: p, toks: toks, nN: F.n.length, sku: codeNorm(p.sku), codes: (p.barcodes || []).map(codeNorm), cn: compact(p.name), cnb: compact(p.name + ' ' + (p.brand || '')),
          d: details(F.n.concat(F.c)) });
      });
      SX = { ver: v, ents: ents, vocab: Object.keys(vocab), memo: {}, nm: 0 };
      return SX;
    }
    function quality(t, w) {
      if (t === w) return 1;
      var nt = isNum(t), nw = isNum(w);
      if (nt || nw) return nt && nw && w.indexOf(t) === 0 ? 0.75 : 0; // «۲۰» -> «۲۰۶» while typing; ۲۰۶ never matches ۲۰۷
      var lt = t.length, lw = w.length;
      if (w.indexOf(t) === 0) return 0.86 + 0.1 * lt / lw;            // prefix (still typing)
      var pt = phon(t), pw = phon(w);
      if (pt === pw) return 0.92;
      if (lt >= 2 && pw.indexOf(pt) === 0) return 0.8;
      if (DISC_OF[t] != null || DISC_OF[w] != null) return 0;          // چپ ≠ راست, جلو ≠ عقب …
      if (lt >= 3 && w.indexOf(t) > 0) return 0.6;                     // part of a compound word («ترمز» in «لنت‌ترمزی»)
      var mn = Math.min(lt, lw), max = mn >= 7 ? 2 : mn >= 4 ? 1 : 0;
      if (!max) return 0;
      var d = lev(pt, pw, max); if (d <= max) return d === 1 ? 0.74 : 0.6;
      if (lw > lt && lt >= 4 && lev(pt, pw.slice(0, lt), 1) <= 1) return 0.66; // a typo while still typing
      return 0;
    }
    function search(q, opts) {
      opts = opts || {};
      var ix = sIndex(), raw = String(q == null ? '' : q).trim();
      function pick(e) { return opts.includeInactive || e.p.active !== false; }
      function byName(a, b) { return a.product.name.localeCompare(b.product.name, 'fa'); }
      function done(list) { return opts.detail ? list : list.map(function (x) { return x.product; }); }
      if (!Core.normText(raw)) return done(ix.ents.filter(pick).map(function (e) { return { product: e.p, score: 0, full: true }; }).sort(byName));
      var exact = E.findProductByCode ? E.findProductByCode(raw) : null, cq = codeNorm(raw), shortNum = /^\d{1,4}$/.test(cq);
      var qT = tokens(raw).filter(function (t) { return !NOISE[t]; }), n = qT.length, qc = compact(raw), qd = details(n && isNum(qT[n - 1]) ? qT.slice(0, -1) : qT); // v2.9: a number still being typed («۴۰» of ۴۰۵) is not a conflict
      if (ix.nm > 600) { ix.memo = {}; ix.nm = 0; }
      var QM = qT.map(function (t) {
        var m = ix.memo[t]; if (m) return m;
        m = {}; ix.vocab.forEach(function (w) { var x = quality(t, w); if (x > 0) m[w] = x; });
        ix.nm++; return (ix.memo[t] = m);
      });
      var out = [];
      ix.ents.forEach(function (e) {
        if (!pick(e)) return;
        var code = 0;
        if (exact && exact.id === e.p.id) code = 1000;
        else if (cq.length >= 2 && e.sku === cq) code = 900;
        else if (cq.length >= 3 && e.codes.indexOf(cq) >= 0) code = 850;
        else if (!shortNum && cq.length >= 3 && e.sku.indexOf(cq) === 0) code = 600;
        else if (!shortNum && cq.length >= 4 && (e.sku.indexOf(cq) >= 0 || e.codes.some(function (c) { return c.indexOf(cq) >= 0; }))) code = 400;
        var sum = 0, hit = 0, strong = 0, used = {}, pos = [], T = e.toks;
        for (var i = 0; i < n; i++) {
          var m = QM[i], best = 0, bi = -1, raw0 = 0;
          for (var j = 0; j < T.length; j += 2) { var x0 = m[T[j]]; if (x0) { var x = x0 * FW[T[j + 1]]; if (used[j]) x *= 0.5; if (x > best) { best = x; bi = j; raw0 = x0; } } }
          var joined = false;
          if (!best && qT[i].length >= 3 && e.cnb.indexOf(qT[i]) >= 0) { best = 0.55; joined = true; } // written together / apart
          if (best) {
            hit++; sum += best; used[bi] = 1; pos.push(bi);
            // v2.9: «strong» = the word as written (exact, still typing, same sound, written together); a typo is only «similar»
            if (joined || raw0 >= 0.8 || (raw0 === 0.75 && i === n - 1)) strong++;
          }
        }
        if (!code && (!hit || hit * 2 < n)) return;
        var s = n ? 100 * sum / n : 0;
        if (qc.length >= 3) { if (e.cn === qc || e.cnb === qc) s += 30; else if (e.cn.indexOf(qc) === 0) s += 15; else if (e.cnb.indexOf(qc) >= 0) s += 8; }
        if (pos[0] === 0) s += 6;                                                    // the name starts with the first word
        var ord = pos.length > 1; for (var k = 1; k < pos.length; k++) if (pos[k] < pos[k - 1]) ord = false; if (ord) s += 3;
        s -= Math.min(8, Math.max(0, e.nN - hit) * 0.8);                             // closer (shorter) names first
        var cf = compare(qd, e.d); if (cf.hard.length) s -= 30 * cf.hard.length;
        if (e.p.stock > 0) s += 1;
        var full = code > 0 || (hit === n && strong === n && !cf.hard.length);
        out.push({ product: e.p, score: Math.round((code + s) * 10) / 10, full: full, tier: full ? 'exact' : hit === n ? 'similar' : 'partial', conflict: cf.hard.length ? cf.hard : null });
      });
      out.sort(function (a, b) { return (b.full ? 1 : 0) - (a.full ? 1 : 0) || b.score - a.score || byName(a, b); });
      var F = out.filter(function (x) { return x.full; }), P = out.filter(function (x) { return !x.full; });
      P = F.length ? P.filter(function (x) { return x.tier === 'similar' || x.score >= 65; }).slice(0, 12) : P.slice(0, 40);
      return done(F.concat(P));
    }
    return { match: match, suggest: suggest, learnKeys: learnKeys, index: index, search: search, brandEq: brandEq, _quality: quality };
  }

  // ---------- numbers in price lists: Persian/Arabic digits, separators, "ریال/تومان" words ----------
  /* v2.8: a price is read only when it is unambiguous; otherwise {value: null, why} says why (the user is asked, never guessed).
     why: empty | text | ambiguous (e.g. «250.000» or «۱٫۵» — thousands separator or decimal?) | fraction | negative */
  var WHY = { empty: 'خالی', text: 'عدد نیست', ambiguous: 'جداکننده مبهم (هزارگان یا اعشار؟)', fraction: 'عدد اعشاری', negative: 'منفی' };
  function parsePriceInfo(v) {
    if (typeof v === 'number') {
      if (!isFinite(v)) return { value: null, why: 'text' }; if (v < 0) return { value: null, why: 'negative' };
      return Math.round(v) === v ? { value: v, why: null } : { value: null, why: 'fraction' };
    }
    var raw = String(v == null ? '' : v);
    var s = Core.normText(raw).replace(/ریال|تومان|toman|rial|irr|irt/g, '').replace(/\s+/g, ' ').trim();
    if (!s || /^[-–—.]+$/.test(s)) return { value: null, why: 'empty' };
    var mult = 1, mm = s.match(/^(.*?)\s*(هزار|میلیون|k)$/);
    if (mm) { mult = mm[2] === 'میلیون' ? 1e6 : 1e3; s = mm[1].trim(); }
    s = s.replace(/٫/g, '.').replace(/[٬،,\s'’]/g, '');
    if (/^-/.test(s)) return { value: null, why: 'negative' };
    if (/^\d+$/.test(s)) return { value: parseInt(s, 10) * mult, why: null };
    if (/^\d{1,3}([.\/])\d{3}(\1\d{3})+$/.test(s)) return { value: parseInt(s.replace(/[.\/]/g, ''), 10) * mult, why: null }; // 1.250.000 · 1/250/000 · ۱٫۲۵۰٫۰۰۰
    if (/^\d+\.\d+$/.test(s)) { // one separator: «250.000» (thousands?) or «1.5» (decimal?) — only safe with «هزار / میلیون» and a whole result
      if (mult > 1) { var x = parseFloat(s) * mult; return Math.round(x) === x ? { value: x, why: null } : { value: null, why: 'fraction' }; }
      return { value: null, why: 'ambiguous' };
    }
    return { value: null, why: 'text' };
  }
  function parsePrice(v) { return parsePriceInfo(v).value; }

  // ---------- v2.2.1 supplier lists with group headers ("۲۰۶" above all its items) ----------
  var CARS = { 'پژو': 1, 'پراید': 1, 'سمند': 1, 'تیبا': 1, 'دنا': 1, 'رانا': 1, 'پارس': 1, 'ریو': 1, 'ساینا': 1, 'کوییک': 1, 'ال': 1, 'تندر': 1, 'زانتیا': 1, 'آریو': 1, 'اریو': 1,
    'پیکان': 1, 'روآ': 1, 'روا': 1, 'نیسان': 1, 'مزدا': 1, 'کیا': 1, 'هیوندای': 1, 'رنو': 1, 'ساندرو': 1, 'لوگان': 1, 'سایپا': 1, 'وانت': 1, 'شاهین': 1, 'سورن': 1, 'هایما': 1, 'جک': 1, 'ام': 1, 'وی': 1 };
  /* a row that only carries a title (no code, no price, at most 2 filled cells, not a number) is a group header;
     returns the cleaned title or null */
  function headerText(cells, hasCode, hasPrice) {
    if (hasCode || hasPrice) return null;
    var filled = (cells || []).map(function (c) { return String(c == null ? '' : c).trim(); }).filter(Boolean);
    if (!filled.length || filled.length > 2) return null;
    var t = filled.join(' ').replace(/^(سر\s*گروه|گروه|دسته|دسته\s*بندی|خودرو)\s*[:：\-–]?\s*/, '').replace(/[:：\-–_=*#]+$/, '').trim();
    var nt = Core.normText(t);
    if (t.length < 2 || (/^[\d\s.,٬،]+$/.test(nt) && nt.replace(/\D/g, '').length > 4)) return null; // a lone long number is not a title
    return t;
  }
  /* v2.8: how many units a name says the package holds («لنت ترمز ۲ دست» -> 2, «جفت» -> 2); null = the name says nothing */
  var NUMW = { 'یک': 1, 'دو': 2, 'سه': 3, 'چهار': 4, 'پنج': 5, 'شش': 6, 'هشت': 8, 'ده': 10, 'دوازده': 12 };
  function packOf(name) {
    var t = Core.normText(name).replace(/[()\[\]،,]/g, ' ');
    var m = t.match(/(\d+|یک|دو|سه|چهار|پنج|شش|هشت|ده|دوازده)\s*(دست|جفت|عدد|عددی|تایی|تا|ست|پک)(?![\u0600-\u06FF])/);
    if (m) { var n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUMW[m[1]]; if (m[2] === 'جفت') n *= 2; return n > 1 && n <= 100 ? { n: n, text: m[0] } : null; }
    if (/(^|\s)جفت(\s|$)/.test(t)) return { n: 2, text: 'جفت' };
    return null;
  }
  function carLike(group) { var T = tokens(group); return T.some(function (t) { return /^\d+$/.test(t) || CARS[t]; }); }
  /* item name in a group: "سیبک فرمان راست" under "۲۰۶" -> "سیبک فرمان راست ۲۰۶" (only for car/model groups, only when missing) */
  function withGroup(name, group) {
    if (!group || !carLike(group)) return name;
    var have = {}; tokens(name).forEach(function (t) { have[t] = 1; });
    var miss = String(group).trim().split(/\s+/).filter(function (w) { var T = tokens(w); return T.length && T.some(function (t) { return !have[t]; }); });
    return miss.length ? String(name).trim() + ' ' + miss.join(' ') : name;
  }

  var api = { create: create, tokens: tokens, compact: compact, codeNorm: codeNorm, parsePrice: parsePrice, parsePriceInfo: parsePriceInfo, PRICE_WHY: WHY, packOf: packOf, headerText: headerText, withGroup: withGroup, carLike: carLike, _lev: lev, _tokEq: tokEq };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Match = api;
})(typeof self !== 'undefined' ? self : this);
