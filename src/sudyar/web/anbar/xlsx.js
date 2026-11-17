/* Minimal, dependency-free ZIP + XLSX writer/reader + CSV (UTF-8 BOM) writer/reader.
   Writer: stored (uncompressed) ZIP entries, shared strings, RTL sheets, bold header, #,##0 numbers.
   Reader: handles stored + deflate entries (DecompressionStream 'deflate-raw', iOS 16.4+), shared/inline strings. */
(function (root) {
  'use strict';
  var te = new TextEncoder();

  // ---------------- CRC32 / ZIP ----------------
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) { // files: [{name, data:Uint8Array|string}]
    var parts = [], central = [], offset = 0, d = new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    files.forEach(function (f) {
      var name = te.encode(f.name), data = typeof f.data === 'string' ? te.encode(f.data) : f.data, crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = central.reduce(function (s, a) { return s + a.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return concat(parts.concat(central, [new Uint8Array(end.buffer)]));
  }
  function concat(arrs) {
    var n = arrs.reduce(function (s, a) { return s + a.length; }, 0), out = new Uint8Array(n), o = 0;
    arrs.forEach(function (a) { out.set(a, o); o += a.length; }); return out;
  }
  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('NO_INFLATE'));
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function unzip(buf) { // -> Promise<{name: Uint8Array}>
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.reject(new Error('فایل ZIP/XLSX معتبر نیست.'));
    var count = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true), jobs = [], out = {};
    var td = new TextDecoder('utf-8');
    for (var k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) return Promise.reject(new Error('ساختار ZIP خراب است.'));
      var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true),
        xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      var name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
      var start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      var data = u8.subarray(start, start + csize);
      (function (name, method, data) {
        if (method === 0) out[name] = data;
        else if (method === 8) jobs.push(inflateRaw(data).then(function (d) { out[name] = d; }));
      })(name, method, data);
      p += 46 + nlen + xlen + clen;
    }
    return Promise.all(jobs).then(function () { return out; });
  }

  // ---------------- XML helpers ----------------
  function esc(s) {
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function unesc(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, e) {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
    });
  }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function colIndex(ref) { var m = /^([A-Z]+)/.exec(ref), n = 0; if (!m) return -1; for (var i = 0; i < m[1].length; i++) n = n * 26 + m[1].charCodeAt(i) - 64; return n - 1; }

  // ---------------- XLSX writer ----------------
  // sheets: [{name, rows:[[cell...]], header:true, widths:[chars], rtl:true}]; cell: string|number|null
  function writeXlsx(sheets) {
    var sst = [], sstMap = {};
    function si(s) { if (sstMap[s] === undefined) { sstMap[s] = sst.length; sst.push(s); } return sstMap[s]; }
    var used = {};
    var sheetXml = sheets.map(function (sh, idx) {
      var rows = sh.rows || [], xml = [];
      xml.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
      xml.push('<sheetViews><sheetView workbookViewId="0"' + (sh.rtl !== false ? ' rightToLeft="1"' : '') + '>' +
        (sh.header !== false && rows.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '') + '</sheetView></sheetViews>');
      var ncol = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
      if (ncol) {
        xml.push('<cols>');
        for (var c = 0; c < ncol; c++) {
          var w = (sh.widths && sh.widths[c]) || Math.min(60, Math.max(8, rows.slice(0, 200).reduce(function (m, r) { return Math.max(m, r[c] == null ? 0 : String(r[c]).length); }, 0) + 2));
          xml.push('<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + w + '" customWidth="1"/>');
        }
        xml.push('</cols>');
      }
      xml.push('<sheetData>');
      rows.forEach(function (r, ri) {
        xml.push('<row r="' + (ri + 1) + '">');
        r.forEach(function (v, ci) {
          if (v == null || v === '') return;
          var ref = colName(ci) + (ri + 1), hdr = sh.header !== false && ri === 0;
          if (typeof v === 'number' && isFinite(v)) xml.push('<c r="' + ref + '"' + (hdr ? ' s="1"' : (Number.isInteger(v) && Math.abs(v) >= 1000 ? ' s="2"' : '')) + '><v>' + v + '</v></c>');
          else xml.push('<c r="' + ref + '" t="s"' + (hdr ? ' s="1"' : '') + '><v>' + si(String(v)) + '</v></c>');
        });
        xml.push('</row>');
      });
      xml.push('</sheetData>');
      if (sh.header !== false && rows.length > 1 && ncol) xml.push('<autoFilter ref="A1:' + colName(ncol - 1) + rows.length + '"/>');
      xml.push('</worksheet>');
      return xml.join('');
    });
    var names = sheets.map(function (sh, i) {
      var n = String(sh.name || ('Sheet' + (i + 1))).replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31) || ('Sheet' + (i + 1));
      while (used[n]) n = n.slice(0, 28) + '_' + i; used[n] = 1; return n;
    });
    var files = [];
    files.push({ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' });
    files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' });
    files.push({ name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Amiran Yadak Inventory</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</dcterms:created></cp:coreProperties>' });
    files.push({ name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Amiran Yadak Inventory</Application></Properties>' });
    files.push({ name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>' +
      names.map(function (n, i) { return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId' + (sheets.length + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>' });
    files.push({ name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Tahoma"/><family val="2"/></font><font><b/><sz val="11"/><name val="Tahoma"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' });
    sheetXml.forEach(function (x, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: x }); });
    files.push({ name: 'xl/sharedStrings.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + sst.length + '" uniqueCount="' + sst.length + '">' +
      sst.map(function (s) { return '<si><t xml:space="preserve">' + esc(s) + '</t></si>'; }).join('') + '</sst>' });
    return zip(files);
  }

  // ---------------- XLSX reader ----------------
  function textOf(xml) { // concatenates <t> contents, skipping phonetic runs
    xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    var out = '', re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g, m;
    while ((m = re.exec(xml))) out += m[1] ? unesc(m[1]) : '';
    return out;
  }
  function attr(s, name) { var m = new RegExp('\\b' + name + '="([^"]*)"').exec(s); return m ? unesc(m[1]) : null; }
  function readXlsx(buf) { // -> Promise<{sheets:[{name, rows}]}>
    return unzip(buf).then(function (files) {
      var td = new TextDecoder('utf-8');
      function f(n) { var k = Object.keys(files).find(function (x) { return x.replace(/^\//, '').toLowerCase() === n.toLowerCase(); }); return k ? td.decode(files[k]) : null; }
      var wb = f('xl/workbook.xml');
      if (!wb) throw new Error('این فایل اکسل (xlsx) معتبر نیست.');
      var rels = f('xl/_rels/workbook.xml.rels') || '', relMap = {}, m, re = /<Relationship\b([^>]*)\/?>/g;
      while ((m = re.exec(rels))) relMap[attr(m[1], 'Id')] = attr(m[1], 'Target');
      var sst = [], sx = f('xl/sharedStrings.xml');
      if (sx) { var sre = /<si>([\s\S]*?)<\/si>|<si\/>/g; while ((m = sre.exec(sx))) sst.push(m[1] ? textOf(m[1]) : ''); }
      var sheets = [], shre = /<sheet\b([^>]*)\/?>/g;
      while ((m = shre.exec(wb))) {
        var name = attr(m[1], 'name'), rid = attr(m[1], 'r:id'), target = relMap[rid] || '';
        var path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
        var xml = f(path); if (!xml) continue;
        sheets.push({ name: name, rows: parseSheet(xml, sst) });
      }
      return { sheets: sheets };
    });
  }
  function parseSheet(xml, sst) {
    var rows = [], rre = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, m, autoRow = 0;
    while ((m = rre.exec(xml))) {
      var rnum = attr(m[1], 'r'); var ri = rnum ? parseInt(rnum, 10) - 1 : autoRow; autoRow = ri + 1;
      var row = [], cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, c, autoCol = 0;
      var body = m[2] || '';
      while ((c = cre.exec(body))) {
        var ref = attr(c[1], 'r'), t = attr(c[1], 't') || 'n', inner = c[2] || '';
        var ci = ref ? colIndex(ref) : autoCol; autoCol = ci + 1;
        var vm = /<v>([\s\S]*?)<\/v>/.exec(inner), v = vm ? unesc(vm[1]) : null, val;
        if (t === 's') val = v == null ? '' : (sst[parseInt(v, 10)] || '');
        else if (t === 'inlineStr') val = textOf((/<is>([\s\S]*?)<\/is>/.exec(inner) || [, ''])[1]);
        else if (t === 'str' || t === 'e') val = v == null ? '' : v;
        else if (t === 'b') val = v === '1';
        else val = v == null ? '' : (isFinite(+v) ? +v : v);
        row[ci] = val;
      }
      for (var i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
      rows[ri] = row;
    }
    for (var k = 0; k < rows.length; k++) if (!rows[k]) rows[k] = [];
    return rows;
  }

  // ---------------- CSV ----------------
  function csvCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return String(v);
    var s = String(v);
    if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) s = "'" + s; // spreadsheet formula injection guard
    return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function writeCsv(rows) { // -> Uint8Array with UTF-8 BOM (Excel shows Persian correctly)
    var body = rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
    return concat([new Uint8Array([0xEF, 0xBB, 0xBF]), te.encode(body)]);
  }
  function decodeText(u8) {
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return new TextDecoder('utf-8').decode(u8.subarray(3));
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch (e) { try { return new TextDecoder('windows-1256').decode(u8); } catch (e2) { return new TextDecoder('utf-8').decode(u8); } }
  }
  function readCsv(buf) {
    var text = decodeText(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    var first = text.split(/\r?\n/)[0] || '', cands = [',', ';', '\t'], delim = ',', best = -1;
    cands.forEach(function (d) { var n = first.split(d).length; if (n > best) { best = n; delim = d; } });
    var rows = [], row = [], cell = '', q = false, i = 0;
    for (; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); })
      .map(function (r) { return r.map(function (c) { return /^'[=+\-@]/.test(c) ? c.slice(1) : c; }); });
  }

  var api = { zip: zip, unzip: unzip, crc32: crc32, writeXlsx: writeXlsx, readXlsx: readXlsx, writeCsv: writeCsv, readCsv: readCsv, decodeText: decodeText, colName: colName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.XLSX = api;
})(typeof self !== 'undefined' ? self : this);
