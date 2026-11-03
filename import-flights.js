// =============================================================
//  استيراد جدول الرحلات من Excel / CSV
//  - parseUpload: يقرأ الملف (xlsx أو csv) ويحوّله إلى صفوف بأسماء حقول موحّدة
//  - validateRows: يتحقق من كل صف ويُرجع رحلات جاهزة أو قائمة أخطاء برقم السطر
//  - buildTemplate: نموذج Excel فارغ بالأعمدة المطلوبة + ورقة تعليمات
// =============================================================
const ExcelJS = require('exceljs');

const MAX_ROWS = 2000;

// الأعمدة بالترتيب الموجود في النموذج. required = إلزامي
const COLUMNS = [
  { key: 'no',       title: 'رقم الرحلة',           required: true,  width: 14, example: 'LN401',
    aliases: ['رقمالرحلة', 'الرحلة', 'flight', 'flightno', 'flightnumber', 'no'] },
  { key: 'from',     title: 'من',                   required: true,  width: 10, example: 'MJI',
    aliases: ['من', 'مطارالاقلاع', 'from', 'origin'] },
  { key: 'to',       title: 'إلى',                  required: true,  width: 10, example: 'IST',
    aliases: ['الي', 'to', 'destination', 'مطارالوصول'] },
  { key: 'dep',      title: 'تاريخ ووقت الإقلاع',    required: true,  width: 22, example: '2026-12-01 08:30',
    aliases: ['تاريخووقتالاقلاع', 'الاقلاع', 'departure', 'depart', 'dep'] },
  { key: 'arr',      title: 'تاريخ ووقت الوصول',     required: true,  width: 22, example: '2026-12-01 12:15',
    aliases: ['تاريخووقتالوصول', 'الوصول', 'arrival', 'arrive', 'arr'] },
  { key: 'price',    title: 'السعر',                required: true,  width: 10, example: 950,
    aliases: ['السعر', 'price', 'fare'] },
  { key: 'seats',    title: 'عدد المقاعد',           required: true,  width: 12, example: 40,
    aliases: ['عددالمقاعد', 'المقاعد', 'seats'] },
  { key: 'airline',  title: 'شركة الطيران (اختياري)', required: false, width: 22, example: 'الخطوط الليبية',
    aliases: ['شركةالطيران', 'الشركة', 'airline'] },
  { key: 'currency', title: 'العملة (اختياري)',      required: false, width: 14, example: 'LYD',
    aliases: ['العملة', 'currency'] },
  { key: 'bag',      title: 'الوزن المسموح (اختياري)', required: false, width: 20, example: '23 كغ',
    aliases: ['الوزنالمسموح', 'الوزن', 'الامتعة', 'baggage', 'bag'] },
];

// تطبيع عنوان العمود: بدون مسافات أو تشكيل أو ما بين الأقواس، وتوحيد الألف والياء
const normHeader = s => String(s ?? '').toLowerCase()
  .replace(/\(.*?\)/g, '').replace(/[ً-ْـ]/g, '')
  .replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[\s_\-.:/]+/g, '');
const ALIAS = new Map();
for (const c of COLUMNS) for (const a of [c.title, ...c.aliases]) ALIAS.set(normHeader(a), c.key);

// ---------------------------------------------------------------
// قراءة الملف
// ---------------------------------------------------------------
function decodeText(buf) {
  // Excel يحفظ CSV أحياناً بترميز Windows-1256 (عربي) بدل UTF-8
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1256').decode(buf); }
}

// CSV (RFC 4180): فواصل , أو ; أو Tab — نكتشف الفاصل من السطر الأول
function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// قيمة خلية Excel ← نص/رقم/تاريخ
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.result !== undefined) return cellValue(v.result);          // معادلة
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.text !== undefined) return String(v.text);                // رابط
    return '';
  }
  return v;
}

async function readXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); }
  catch { throw new Error('تعذر قراءة ملف Excel — احفظه بصيغة ‎.xlsx‎ أو ‎.csv‎ ثم أعد المحاولة'); }
  // أول ورقة فيها عنوان «رقم الرحلة»، وإلا أول ورقة
  let ws = wb.worksheets.find(w => [1, 2, 3].some(r => (w.getRow(r).values || []).some(v => ALIAS.get(normHeader(cellValue(v))) === 'no')));
  ws = ws || wb.worksheets[0];
  if (!ws) throw new Error('الملف لا يحتوي على أي ورقة');
  if (ws.rowCount > MAX_ROWS + 5) throw new Error(`الملف أكبر من المسموح (${MAX_ROWS} رحلة كحد أقصى في المرة الواحدة)`);
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (r, n) => { rows[n - 1] = (r.values || []).slice(1).map(cellValue); });
  return Array.from(rows, r => r || []);
}

// يُرجع { rows: [{ _row, no, from, ... }], unknownHeaders }
async function parseUpload(buf, filename = '') {
  if (!buf || !buf.length) throw new Error('الملف فارغ');
  const isZip = buf[0] === 0x50 && buf[1] === 0x4B; // xlsx = ملف zip
  if (/\.xls$/i.test(filename) || (buf[0] === 0xD0 && buf[1] === 0xCF)) throw new Error('صيغة ‎.xls‎ القديمة غير مدعومة — من Excel اختر «حفظ باسم» ← ‎.xlsx‎');
  const grid = isZip ? await readXlsx(buf) : parseCsv(decodeText(buf));

  // سطر العناوين: أول سطر (من أول 5) يحتوي على «رقم الرحلة»
  let h = grid.slice(0, 5).findIndex(r => r.some(v => ALIAS.get(normHeader(v)) === 'no'));
  let map;
  if (h === -1) {
    // بدون عناوين معروفة: نعتمد ترتيب الأعمدة كما في النموذج — بشرط أن يبدو أول عمود كرقم رحلة
    const looksLikeFlight = v => /^[A-Z0-9]{2}\s?\d{1,4}$/i.test(String(v ?? '').trim());
    if (!grid.slice(0, 3).some(r => looksLikeFlight(r[0])))
      throw new Error('لم نتعرّف على محتوى الملف — لا يوجد سطر عناوين (رقم الرحلة، من، إلى…). نزّل النموذج الجاهز واملأه');
    h = -1; map = COLUMNS.map(c => c.key);
  } else {
    map = grid[h].map(v => ALIAS.get(normHeader(v)) || null);
    const missing = COLUMNS.filter(c => c.required && !map.includes(c.key)).map(c => `«${c.title}»`);
    if (missing.length) throw new Error(`أعمدة ناقصة في الملف: ${missing.join('، ')} — استخدم النموذج الجاهز`);
  }
  const rows = [];
  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i] || [];
    if (!r.some(v => String(v ?? '').trim() !== '')) continue; // سطر فارغ
    const o = { _row: i + 1 };
    map.forEach((k, j) => { if (k && o[k] === undefined) o[k] = r[j] ?? ''; });
    rows.push(o);
  }
  if (!rows.length) throw new Error('لا توجد رحلات في الملف — أضف صفاً لكل رحلة تحت سطر العناوين');
  if (rows.length > MAX_ROWS) throw new Error(`الحد الأقصى ${MAX_ROWS} رحلة في الملف الواحد (الملف فيه ${rows.length})`);
  return rows;
}

// ---------------------------------------------------------------
// التواريخ والأوقات
// ---------------------------------------------------------------
const pad = n => String(n).padStart(2, '0');
// تاريخ ووقت محلي (كما يكتبه المكتب) ← { date: 'YYYY-MM-DD', time: 'HH:MM' }
function parseDateTime(v, toAscii) {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // ExcelJS يعيد التاريخ كـ UTC بنفس أرقام الخلية — نقرّب لأقرب دقيقة (Excel يخزن الوقت ككسر)
    const d = new Date(Math.round(v.getTime() / 60000) * 60000);
    return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) { // رقم تسلسلي من Excel
    return parseDateTime(new Date(Math.round((v - 25569) * 864e5)), toAscii);
  }
  let s = toAscii(v).trim().replace(/\s+/g, ' ').replace('T', ' ');
  let pm = null;
  if (/(\bpm\b|م$|مساء)/i.test(s)) pm = true; else if (/(\bam\b|ص$|صباح)/i.test(s)) pm = false;
  s = s.replace(/\s*(am|pm|ص|م|صباحا|صباحاً|مساء|مساءً)\s*$/i, '');
  let y, mo, d, hh, mm;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ ,]+(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) [, y, mo, d, hh, mm] = m;
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[ ,]+(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s))) [, d, mo, y, hh, mm] = m; // يوم/شهر/سنة
  else return null;
  [y, mo, d, hh, mm] = [y, mo, d, hh, mm].map(Number);
  if (pm === true && hh < 12) hh += 12;
  if (pm === false && hh === 12) hh = 0;
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  const chk = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(chk.getTime()) || chk.getUTCMonth() + 1 !== mo || chk.getUTCDate() !== d || hh > 23 || mm > 59) return null;
  return { date, time: `${pad(hh)}:${pad(mm)}` };
}

// وقت محلي في منطقة زمنية ← لحظة UTC (لحساب مدة الرحلة بين مطارين بتوقيتين مختلفين)
function zonedToUtc(date, time, tz) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const offset = t => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - t;
  };
  let t = guess - offset(guess);
  return guess - offset(t); // تصحيح ثانٍ لأيام تغيير التوقيت الصيفي
}

const CURRENCY = { lyd: 'LYD', 'د.ل': 'LYD', دينار: 'LYD', usd: 'USD', $: 'USD', دولار: 'USD', eur: 'EUR', '€': 'EUR', يورو: 'EUR' };

// ---------------------------------------------------------------
// التحقق من الصفوف
// ctx = { AIRPORTS, toAscii, today, maxDate, clip }
// يُرجع { errors: [{ row, msg }], groups: Map(no → { from, to, airline, currency, bag, dates: { date: {dep, arr, dur, tiers} }, rows }) }
// ---------------------------------------------------------------
function validateRows(rows, ctx) {
  const { AIRPORTS, toAscii, today, maxDate, clip } = ctx;
  const errors = [], groups = new Map();
  const byCity = new Map(Object.entries(AIRPORTS).map(([k, a]) => [normHeader(a.city), k]));
  const airport = v => { const s = toAscii(v).trim(); return AIRPORTS[s.toUpperCase()] ? s.toUpperCase() : byCity.get(normHeader(s)) || null; };
  const num = v => { const s = toAscii(v).replace(/[,\s]/g, '').replace(/(د\.?ل|lyd|usd|eur|\$|€)/gi, ''); return s === '' ? NaN : Number(s); };

  for (const r of rows) {
    const err = msg => errors.push({ row: r._row, msg });
    const before = errors.length;
    const no = toAscii(r.no).toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9]{2}\d{1,4}$/.test(no)) err(`رقم الرحلة «${clip(r.no, 12) || 'فارغ'}» غير صالح (مثال: LN401)`);
    const from = airport(r.from), to = airport(r.to);
    if (!from) err(`مطار الإقلاع «${clip(r.from, 20) || 'فارغ'}» غير معروف — استخدم رمز المطار (مثل MJI)`);
    if (!to) err(`مطار الوصول «${clip(r.to, 20) || 'فارغ'}» غير معروف — استخدم رمز المطار (مثل IST)`);
    if (from && to && from === to) err('مطار الإقلاع والوصول متطابقان');
    const dep = parseDateTime(r.dep, toAscii), arr = parseDateTime(r.arr, toAscii);
    if (!dep) err(`تاريخ ووقت الإقلاع «${clip(r.dep instanceof Date ? '' : r.dep, 25) || 'فارغ'}» غير مفهوم — اكتبه هكذا: 2026-12-01 08:30`);
    if (!arr) err(`تاريخ ووقت الوصول «${clip(r.arr instanceof Date ? '' : r.arr, 25) || 'فارغ'}» غير مفهوم — اكتبه هكذا: 2026-12-01 12:15`);
    let dur = 0;
    if (dep && arr && from && to) {
      dur = Math.round((zonedToUtc(arr.date, arr.time, AIRPORTS[to].tz) - zonedToUtc(dep.date, dep.time, AIRPORTS[from].tz)) / 60000);
      if (dur <= 0) err('وقت الوصول يجب أن يكون بعد وقت الإقلاع (بتوقيت كل مطار)');
      else if (dur < 20 || dur > 1800) err(`مدة الرحلة (${dur} دقيقة) غير منطقية — راجع التاريخين`);
      else if (arr.date > dep.date && Date.parse(arr.date) - Date.parse(dep.date) > 864e5) err('الوصول بعد أكثر من يوم من الإقلاع غير مدعوم');
    }
    if (dep && dep.date < today) err(`تاريخ الإقلاع ${dep.date} في الماضي`);
    if (dep && dep.date > maxDate) err(`تاريخ الإقلاع ${dep.date} بعيد جداً (الحد ${maxDate})`);
    const price = num(r.price), seats = num(r.seats);
    if (!(price > 0 && price <= 100000)) err(`السعر «${clip(r.price, 12) || 'فارغ'}» غير صالح`);
    if (!(Number.isInteger(seats) && seats >= 1 && seats <= 500)) err(`عدد المقاعد «${clip(r.seats, 8) || 'فارغ'}» غير صالح (من 1 إلى 500)`);
    const curRaw = normHeader(r.currency);
    const currency = curRaw ? CURRENCY[curRaw] : 'LYD';
    if (!currency) err(`العملة «${clip(r.currency, 8)}» غير مدعومة (LYD أو USD أو EUR)`);
    if (errors.length > before) continue;

    let g = groups.get(no);
    if (!g) groups.set(no, g = { no, from, to, airline: clip(r.airline, 40), currency, bag: clip(r.bag, 30), dates: {}, rows: [] });
    if (g.from !== from || g.to !== to) { err(`الرحلة ${no} مكتوبة بمسار مختلف في سطر سابق (${g.from}→${g.to}) — رقم الرحلة الواحد = مسار واحد`); continue; }
    if (g.currency !== currency) { err(`الرحلة ${no} مكتوبة بعملة مختلفة في سطر سابق (${g.currency})`); continue; }
    if (g.dates[dep.date]) { err(`الرحلة ${no} يوم ${dep.date} مكررة (السطر ${g.dates[dep.date]._row})`); continue; }
    if (!g.airline && r.airline) g.airline = clip(r.airline, 40);
    if (!g.bag && r.bag) g.bag = clip(r.bag, 30);
    g.dates[dep.date] = { dep: dep.time, arr: arr.time, dur, tiers: [{ seats, price }], _row: r._row };
    g.rows.push(r._row);
  }
  return { errors, groups };
}

// ---------------------------------------------------------------
// نموذج Excel
// ---------------------------------------------------------------
async function buildTemplate(AIRPORTS) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'لوحة التحكم';
  const ws = wb.addWorksheet('الرحلات', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map(c => ({ header: c.title, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.height = 24;
  head.eachCell((cell, i) => {
    const c = COLUMNS[i - 1];
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FF1D4ED8' : 'FF64748B' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  // أعمدة التاريخ والوقت كنص حتى لا يغيّرها Excel حسب إعدادات الجهاز
  for (const k of ['no', 'from', 'to', 'dep', 'arr', 'currency']) ws.getColumn(k).numFmt = '@';
  // قوائم منسدلة للمطارات والعملة (أول 500 سطر)
  const codes = Object.keys(AIRPORTS).join(',');
  for (let r = 2; r <= 501; r++) {
    ws.getCell(`B${r}`).dataValidation = ws.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${codes}"`] };
    ws.getCell(`I${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"LYD,USD,EUR"'] };
  }

  const help = wb.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
  help.columns = [{ width: 26 }, { width: 70 }];
  const lines = [
    ['طريقة التعبئة', ''],
    ['صف واحد', 'لكل رحلة في يوم معيّن. نفس رقم الرحلة في أيام مختلفة = صف لكل يوم.'],
    ['رقم الرحلة', 'رمز الشركة ثم الأرقام بدون مسافة، مثال: LN401 — رقم الرحلة الواحد له مسار واحد.'],
    ['من / إلى', 'رمز المطار من القائمة: ' + Object.entries(AIRPORTS).map(([k, a]) => `${k} (${a.city})`).join('، ')],
    ['تاريخ ووقت الإقلاع', 'بالتوقيت المحلي لمطار الإقلاع، هكذا: 2026-12-01 08:30'],
    ['تاريخ ووقت الوصول', 'بالتوقيت المحلي لمطار الوصول — مدة الرحلة تُحسب تلقائياً مع فرق التوقيت.'],
    ['السعر', 'سعر التذكرة للبالغ (رقم فقط). العملة دينار ليبي ما لم تكتب USD أو EUR في عمود العملة.'],
    ['عدد المقاعد', 'المقاعد المتاحة للبيع على الموقع في هذه الرحلة (من 1 إلى 500).'],
    ['شركة الطيران', 'اختياري إذا كان رمز الشركة موجوداً مسبقاً في جدول الرحلات.'],
    ['الأعمدة الرمادية', 'اختيارية — الأعمدة الزرقاء إلزامية.'],
    ['', ''],
    ['مثال', ''],
    ...[COLUMNS.map(c => c.title), COLUMNS.map(c => c.example)].map(r => [r.slice(0, 4).join(' | '), r.slice(4).join(' | ')]),
  ];
  lines.forEach((l, i) => {
    const row = help.addRow(l);
    row.alignment = { wrapText: true, vertical: 'top' };
    if (l[1] === '' && l[0]) row.font = { bold: true, size: 13, color: { argb: 'FF1D4ED8' } };
    else row.getCell(1).font = { bold: true };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { parseUpload, validateRows, buildTemplate, COLUMNS, MAX_ROWS, parseDateTime, zonedToUtc };
