// =============================================================
//  رحلتي لحجز الطيران — Backend
//  Express + MongoDB Atlas (عند ضبط MONGODB_URI) أو ملفات JSON محلياً — انظر store.js
//
//  عام:
//    GET   /api/config               ← المدن والمسارات والأسعار ورقم واتساب المكتب
//    GET   /api/flights              ← بحث حقيقي: ?from=MJI&to=IST&date=2026-11-12&adults=1&children=0
//    POST  /api/bookings             ← إنشاء حجز
//    GET   /api/track                ← تتبّع حجز: ?ref=TKR-XXXXXX&phone=091XXXXXXX
//    GET   /api/settings             ← رقم واتساب المكتب الحالي (فارغ = غير معيَّن)
//    POST  /api/hold-seat            ← قفل المقاعد 10 دقائق أثناء إدخال البيانات { outboundId, returnId?, adults, children, holdId? }
//    POST  /api/hold-seat/:id/release← تحرير القفل
//  الإدارة (جلسة بعد تسجيل الدخول — كوكي HttpOnly):
//    POST  /api/admin/login · /api/admin/logout · GET /api/admin/me
//    GET   /api/bookings             ← كل الحجوزات
//    GET   /api/bookings/:ref        ← حجز واحد (للتذكرة)
//    PATCH /api/bookings/:ref/status ← تأكيد / إلغاء / تم استلام الدفع
//    PUT   /api/settings             ← حفظ الإعدادات { "site_name", "whatsapp", "fx_usd", "fx_eur", "payment": { sadad, tadawul, bank } }
//    GET/POST        /api/admin/schedules           ← جدول الرحلات وفئات الأسعار
//    PUT/DELETE      /api/admin/schedules/:no       ← تعديل / حذف رحلة
//    GET             /api/admin/schedules/:no/dates ← المقاعد المباعة والمتبقية لكل يوم
//    PUT             /api/admin/schedules/:no/dates/:date ← إقفال يوم / مقاعد بيعت في المكتب
//    GET             /api/admin/flights/template.xlsx ← نموذج Excel فارغ لاستيراد الرحلات
//    POST            /api/admin/flights/import      ← استيراد جدول رحلات من Excel/CSV (?dry=1 معاينة بدون حفظ · &mode=merge|replace)
//    GET   /api/bookings/export.csv  ← تصدير كل الحجوزات لملف Excel (CSV)
//    GET   /api/health               ← فحص الحالة (لـ Render)
// =============================================================
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { store, DEFAULT_SETTINGS } = require('./store');
const flightImport = require('./import-flights');

const app = express();
const PORT = process.env.PORT || 3000;
// ---------- دخول الإدارة: اسم مستخدم + كلمة مرور من متغيرات البيئة ----------
// ADMIN_USER / ADMIN_PASS  ← بيانات الدخول (Render ← Environment)
// SESSION_SECRET           ← مفتاح توقيع الجلسات (اختياري لكن يُنصح به: نص عشوائي طويل)
// للتوافق مع الإعداد القديم: إذا لم تُضبط ADMIN_PASS نستخدم ADMIN_TOKEN كلمةَ مرور للمستخدم admin
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim();
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMIN_TOKEN || '';
const SESSION_HOURS = 12;
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update(`rehlati-session|${ADMIN_USER}|${ADMIN_PASS}`).digest('hex');
if (!process.env.ADMIN_PASS) console.warn('⚠️  ADMIN_PASS غير مضبوط' + (process.env.ADMIN_TOKEN ? ' — نستخدم ADMIN_TOKEN مؤقتاً كلمة مرور للمستخدم admin.' : ' — لوحة التحكم مقفلة حتى تضبط ADMIN_USER و ADMIN_PASS.'));
else if (ADMIN_PASS.length < 10) console.warn('⚠️  ADMIN_PASS قصيرة. استخدم 10 أحرف فأكثر.');
if (!process.env.SESSION_SECRET) console.warn('ℹ️  SESSION_SECRET غير مضبوط — نشتقّه من كلمة المرور (تغيير كلمة المرور يُخرج كل الجلسات).');

// -------------------------------------------------------------
// أدوات عامة
// -------------------------------------------------------------
// تحويل الأرقام العربية (٠-٩) والفارسية (۰-۹) إلى إنجليزية
const toAsciiDigits = s => String(s ?? '')
  .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660)
  .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6F0);

const PHONE_RE = /^09[1-5]\d{7}$/;
// يقبل: 0912345678 · +218912345678 · 00218912345678 · ٠٩١٢٣٤٥٦٧٨
function normalizePhone(raw) {
  let s = toAsciiDigits(raw).replace(/[\s\-()]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^\+?2189[1-5]\d{7}$/.test(s)) s = '0' + s.replace(/^\+?218/, '');
  return PHONE_RE.test(s) ? s : null;
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// -------------------------------------------------------------
// الحماية من إغراق الطلبات (في الذاكرة — بدون مكتبات)
// -------------------------------------------------------------
function rateLimit(max, windowMs, message = 'طلبات كثيرة، حاول بعد قليل') {
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress, t = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < t) { h = { count: 0, reset: t + windowMs }; hits.set(key, h); }
    if (++h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
// محاولات رمز الإدارة الخاطئة: 10 كل 15 دقيقة لكل IP
const badTokenHits = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of badTokenHits) if (v.reset < t) badTokenHits.delete(k); }, 60_000).unref();

// -------------------------------------------------------------
// الإعدادات — تُقرأ من التخزين مرة عند التشغيل وتُحفظ في الذاكرة (سريع)، وتُحدَّث عند الحفظ من اللوحة
// -------------------------------------------------------------
let SETTINGS = { ...DEFAULT_SETTINGS };
const getSettings = () => SETTINGS;
// بيانات الدفع التي تظهر للزبون (سداد / تداول / تحويل مصرفي) — معلومات عامة يضبطها المكتب من اللوحة
const PAY_EMPTY = { sadad: { number: '', name: '' }, tadawul: { number: '', name: '' }, bank: { bank: '', name: '', account: '', iban: '' } };
const publicPayment = () => {
  const p = getSettings().payment || {};
  return {
    sadad: { ...PAY_EMPTY.sadad, ...(p.sadad || {}) },
    tadawul: { ...PAY_EMPTY.tadawul, ...(p.tadawul || {}) },
    bank: { ...PAY_EMPTY.bank, ...(p.bank || {}) },
  };
};
// IBAN: تحقق الصيغة + رقم التحقق (mod 97) — الآيبان الليبي LY ثم 23 رقماً
function validIban(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('LY') && !/^LY\d{23}$/.test(iban)) return false;
  const s = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let r = 0; for (const ch of s) r = (r * 10 + Number(ch)) % 97;
  return r === 1;
}
function cleanPayment(body) {
  const txt = (v, max) => String(v ?? '').replace(/[\u0000-\u001F<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const num = v => toAsciiDigits(v).replace(/[\s-]/g, '').trim();
  const cur = publicPayment(), b = body || {};
  const out = {
    sadad: { number: num(b.sadad?.number ?? cur.sadad.number), name: txt(b.sadad?.name ?? cur.sadad.name, 80) },
    tadawul: { number: num(b.tadawul?.number ?? cur.tadawul.number), name: txt(b.tadawul?.name ?? cur.tadawul.name, 80) },
    bank: {
      bank: txt(b.bank?.bank ?? cur.bank.bank, 80), name: txt(b.bank?.name ?? cur.bank.name, 80),
      account: num(b.bank?.account ?? cur.bank.account), iban: num(b.bank?.iban ?? cur.bank.iban).toUpperCase(),
    },
  };
  const errs = [];
  for (const [k, label] of [['sadad', 'سداد'], ['tadawul', 'تداول']]) {
    if (out[k].number && !/^\+?\d{6,20}$/.test(out[k].number)) errs.push(`رقم ${label} غير صالح (أرقام فقط، من 6 إلى 20 رقماً)`);
  }
  if (out.bank.account && !/^\d{6,30}$/.test(out.bank.account)) errs.push('رقم الحساب المصرفي غير صالح (أرقام فقط)');
  if (out.bank.iban && !validIban(out.bank.iban)) errs.push('رقم الآيبان غير صحيح — الآيبان الليبي يبدأ بـ LY ثم 23 رقماً، تأكد من نسخه كاملاً');
  return { out, errs };
}
async function saveSettings(next) {
  await store.saveSettings(next);
  SETTINGS = { ...next };
}
const SITE_NAME_MAX = 60;
// اسم آمن للعرض: بدون وسوم HTML أو رموز تحكم
const cleanSiteName = v => String(v ?? '').replace(/[<>\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();

// مسارات async: أي خطأ يذهب لمعالج الأخطاء بدل أن يُسقط السيرفر
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// رقم واتساب بالصيغة الدولية بدون + (مثال: 218911234567)
// يقبل: 0912345678 · +218912345678 · 00218912345678 · ٠٩١٢٣٤٥٦٧٨ · أرقام دول أخرى
function normalizeWhatsapp(raw) {
  let s = toAsciiDigits(raw).replace(/[\s\-()]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (/^09[1-5]\d{7}$/.test(s)) s = '218' + s.slice(1); // رقم ليبي محلي
  return /^[1-9]\d{7,14}$/.test(s) ? s : null;
}

// -------------------------------------------------------------
// المطارات
// -------------------------------------------------------------
const AIRPORTS = {
  MJI: { city: 'طرابلس',     name: 'مطار معيتيقة الدولي', tz: 'Africa/Tripoli' },
  BEN: { city: 'بنغازي',     name: 'مطار بنينا الدولي', tz: 'Africa/Tripoli' },
  MRA: { city: 'مصراتة',     name: 'مطار مصراتة الدولي', tz: 'Africa/Tripoli' },
  SEB: { city: 'سبها',       name: 'مطار سبها', tz: 'Africa/Tripoli' },
  IST: { city: 'إسطنبول',    name: 'مطار إسطنبول', tz: 'Europe/Istanbul' },
  TUN: { city: 'تونس',       name: 'مطار تونس قرطاج', tz: 'Africa/Tunis' },
  CAI: { city: 'القاهرة',    name: 'مطار القاهرة الدولي', tz: 'Africa/Cairo' },
  AMM: { city: 'عمّان',      name: 'مطار الملكة علياء الدولي', tz: 'Asia/Amman' },
  DXB: { city: 'دبي',        name: 'مطار دبي الدولي', tz: 'Asia/Dubai' },
  JED: { city: 'جدة',        name: 'مطار الملك عبدالعزيز الدولي', tz: 'Asia/Riyadh' },
  MLA: { city: 'مالطا',      name: 'مطار مالطا الدولي', tz: 'Europe/Malta' },
};

// -------------------------------------------------------------
// جدول الرحلات — يديره المكتب من لوحة التحكم (الرحلات والأسعار) ويُحفظ في قاعدة البيانات.
// كل رحلة أسبوعية لها: أيام التشغيل، وفئات أسعار (عدد مقاعد × سعر) مثل شركات الطيران:
// تُباع الفئة الأرخص أولاً، وعند نفادها ينتقل السعر تلقائياً للفئة التالية، وعند نفاد الكل تُقفل الرحلة.
// -------------------------------------------------------------
const BOOKING_WINDOW_DAYS = 120; // أقصى مدة للحجز المسبق

const PRICING = {
  TAX_PER_PAX_PER_LEG: 45, // ضرائب ورسوم مطار لكل مسافر (غير الرضيع) لكل رحلة
  SERVICE_FEE: 15,         // رسوم خدمة المكتب لكل حجز
  COD_FEE: 10,             // رسوم التحصيل النقدي
  CHILD_RATE: 0.75,        // الطفل (2–11 سنة) = 75% من سعر مقعده
  INFANT_RATE: 0.10,       // الرضيع (أقل من سنتين، بدون مقعد) = 10%
  MAX_PAX: 9,
};

// يُستخدم مرة واحدة فقط لتعبئة الجدول إذا كان فارغاً (أول تشغيل). بعدها كل التعديل من اللوحة.
const SEED = [
  ['LN401', 'الخطوط الليبية',   'LN', '#1D5BD8', 'MJI', 'IST', '08:30', '12:15', 165, 0, '',     890,  '23 كغ', [0, 2, 4, 6]],
  ['8U742', 'الخطوط الأفريقية', '8U', '#16A34A', 'MJI', 'IST', '11:00', '14:50', 170, 0, '',     960,  '30 كغ', [1, 3, 5]],
  ['UZ215', 'البراق للطيران',   'UZ', '#7C3AED', 'MJI', 'IST', '06:15', '13:40', 385, 1, 'تونس', 760,  '23 كغ', [0, 1, 2, 3, 4, 5, 6]],
  ['TK654', 'الخطوط التركية',   'TK', '#E11D48', 'MJI', 'IST', '15:20', '19:05', 165, 0, '',     1120, '30 كغ', [0, 1, 2, 3, 4, 5, 6]],
  ['LN402', 'الخطوط الليبية',   'LN', '#1D5BD8', 'IST', 'MJI', '13:30', '15:15', 165, 0, '',     880,  '23 كغ', [0, 2, 4, 6]],
  ['TK655', 'الخطوط التركية',   'TK', '#E11D48', 'IST', 'MJI', '10:40', '12:25', 165, 0, '',     1090, '30 كغ', [0, 1, 2, 3, 4, 5, 6]],
  ['UZ216', 'البراق للطيران',   'UZ', '#7C3AED', 'IST', 'MJI', '17:20', '23:55', 395, 1, 'تونس', 740,  '23 كغ', [0, 1, 2, 3, 4, 5, 6]],
  ['8U530', 'الخطوط الأفريقية', '8U', '#16A34A', 'MJI', 'TUN', '09:00', '10:10', 70,  0, '',     420,  '23 كغ', [0, 2, 4]],
  ['8U531', 'الخطوط الأفريقية', '8U', '#16A34A', 'TUN', 'MJI', '12:00', '13:10', 70,  0, '',     410,  '23 كغ', [0, 2, 4]],
  ['LN160', 'الخطوط الليبية',   'LN', '#1D5BD8', 'BEN', 'CAI', '07:45', '09:30', 105, 0, '',     610,  '23 كغ', [1, 3, 5]],
  ['LN161', 'الخطوط الليبية',   'LN', '#1D5BD8', 'CAI', 'BEN', '11:00', '12:45', 105, 0, '',     600,  '23 كغ', [1, 3, 5]],
  ['TK658', 'الخطوط التركية',   'TK', '#E11D48', 'BEN', 'IST', '14:10', '18:20', 190, 0, '',     1180, '30 كغ', [2, 5]],
  ['TK659', 'الخطوط التركية',   'TK', '#E11D48', 'IST', 'BEN', '09:20', '11:30', 190, 0, '',     1150, '30 كغ', [2, 5]],
].map(([no, airline, code, color, from, to, dep, arr, dur, stops, via, price, bag, days]) => ({
  no, airline, code, color, from, to, dep, arr, dur, stops, via, bag, days, currency: 'LYD', active: true,
  // 3 فئات افتراضية: 12 مقعد بالسعر الأساسي، ثم +8%، ثم +18% (عدّلها من اللوحة)
  tiers: [{ seats: 12, price }, { seats: 12, price: Math.round(price * 1.08 / 5) * 5 }, { seats: 12, price: Math.round(price * 1.18 / 5) * 5 }],
  closed_dates: [], offline_sold: {},
}));

// الجدول في الذاكرة (سريع)، ويُحدَّث فوراً عند أي تعديل من اللوحة
let SCHEDULES = [];
const capacityOf = s => s.tiers.reduce((n, t) => n + t.seats, 0);
const FX_KEY = { USD: 'fx_usd', EUR: 'fx_eur' };
// سعر بعملة الرحلة ← دينار. null إذا لم يُضبط سعر الصرف بعد (الرحلة لا تُعرض حتى يُضبط)
function toLYD(amount, currency) {
  if (!currency || currency === 'LYD') return Math.round(amount);
  const rate = Number(getSettings()[FX_KEY[currency]]);
  return rate > 0 ? Math.round(amount * rate) : null;
}
const sellable = s => s.active && (s.currency === 'LYD' || Number(getSettings()[FX_KEY[s.currency]]) > 0);

// أسعار المقاعد التالية بالدينار بدءاً من عدد المباع (كل مقعد بسعر فئته)
function seatPrices(s, sold, n) {
  const out = [];
  let i = 0, cum = 0;
  for (const t of s.tiers) {
    for (let k = 0; k < t.seats; k++, i++) {
      if (i < sold) continue;
      if (out.length >= n) return out;
      out.push(toLYD(t.price, s.currency));
    }
    cum += t.seats;
  }
  return out; // أقل من n = لا توجد مقاعد كافية
}

const flightId = (s, date) => `${s.no}-${date}`;
const dow = date => new Date(date + 'T00:00:00Z').getUTCDay();
// رحلة بتواريخ محددة (مستوردة من Excel): s.dated = { 'YYYY-MM-DD': { dep, arr, dur, tiers } }
// بدلاً من أيام أسبوعية ثابتة. كل تاريخ له وقته وسعره ومقاعده.
const isDated = s => !!s.dated && Object.keys(s.dated).length > 0;
const runsOn = (s, date) => isDated(s) ? !!s.dated[date] : s.days.includes(dow(date)); // بغض النظر عن الإقفال
const operates = (s, date) => runsOn(s, date) && !(s.closed_dates || []).includes(date);
const atDate = (s, date) => (isDated(s) && s.dated[date]) ? { ...s, ...s.dated[date] } : s; // بيانات ذلك اليوم
const hasFuture = s => !isDated(s) || Object.keys(s.dated).some(d => d >= today());

// رحلة يوم معيّن. need = عدد المقاعد المطلوبة (بالغين + أطفال) لحساب السعر بدقة
function flightFor(s, date, soldOnline = 0, need = 1, infants = 0) {
  const sold = soldOnline + (Number((s.offline_sold || {})[date]) || 0);
  const cap = capacityOf(s), left = Math.max(0, cap - sold);
  const prices = seatPrices(s, sold, Math.max(need, 1));
  const price = prices[0] ?? toLYD(s.tiers[s.tiers.length - 1].price, s.currency);
  // كم مقعد باقي في الفئة الحالية؟ (لإظهار "السعر يرتفع قريباً")
  let cum = 0, tierLeft = 0;
  for (const t of s.tiers) { cum += t.seats; if (sold < cum) { tierLeft = cum - sold; break; } }
  const bookable = left >= need;
  return {
    id: flightId(s, date), schedule_no: s.no, flight_no: `${s.no.slice(0, 2)} ${s.no.slice(2)}`, airline: s.airline, airline_code: s.code,
    color: s.color, origin: s.from, destination: s.to, depart_date: date, depart_time: s.dep, arrive_time: s.arr,
    arrive_offset: s.arr < s.dep ? 1 : 0, duration_min: s.dur, stops: s.stops, via: s.via, bag: s.bag,
    price,                                     // سعر المقعد القادم للبالغ (د.ل)
    seat_prices: bookable ? prices : [],       // أسعار المقاعد المطلوبة بالترتيب
    seats_left: left <= 9 ? left : undefined,  // مثل شركات الطيران: نُظهر العدد فقط عند 9 فأقل
    bookable,
    price_rising: bookable && left > tierLeft && tierLeft <= 3,
    infants_ok: infants <= left,
  };
}

// -------------------------------------------------------------
// قفل المقاعد المؤقت (10 دقائق) — في ذاكرة السيرفر (سيرفر واحد على Render)
// المقاعد المقفولة تُحسب كأنها مباعة للزبائن الآخرين حتى يكتمل الحجز أو ينتهي الوقت
// -------------------------------------------------------------
const HOLD_MINUTES = 10;
const HOLDS = new Map(); // holdId → { flights: [id…], seats, expires, ip }
function purgeHolds() { const t = Date.now(); for (const [k, h] of HOLDS) if (h.expires <= t) HOLDS.delete(k); }
setInterval(purgeHolds, 30_000).unref();
function heldSeats(ids, exceptHold) {
  purgeHolds();
  const out = {};
  for (const [k, h] of HOLDS) {
    if (k === exceptHold) continue;
    for (const id of h.flights) if (ids.includes(id)) out[id] = (out[id] || 0) + h.seats;
  }
  return out;
}
// المباع + المقفول مؤقتاً (ما عدا قفل الزبون نفسه)
async function occupied(ids, exceptHold) {
  const sold = await store.seatsSold(ids), held = heldSeats(ids, exceptHold), out = {};
  for (const id of ids) out[id] = (sold[id] || 0) + (held[id] || 0);
  return out;
}

async function findFlights(from, to, date, need = 1, infants = 0, exceptHold) {
  const list = SCHEDULES.filter(s => sellable(s) && s.from === from && s.to === to && operates(s, date));
  const occ = await occupied(list.map(s => flightId(s, date)), exceptHold);
  return list.map(s => flightFor(atDate(s, date), date, occ[flightId(s, date)] || 0, need, infants));
}
async function flightById(id, need = 1, exceptHold) {
  const m = /^([A-Z0-9]{2}\d{1,4})-(\d{4}-\d{2}-\d{2})$/.exec(String(id || ''));
  if (!m || !isDate(m[2])) return null;
  const s = SCHEDULES.find(x => x.no === m[1]);
  if (!s || !sellable(s) || !operates(s, m[2])) return null;
  const occ = await occupied([id], exceptHold);
  return flightFor(atDate(s, m[2]), m[2], occ[id] || 0, need);
}

// تكلفة الحجز: كل مقعد بسعر فئته، الطفل 75% من سعر مقعده، الرضيع 10% من أول مقعد
function calcCost(legs, c, method) {
  let fare_total = 0;
  for (const f of legs) {
    const p = f.seat_prices;
    for (let i = 0; i < c.adults; i++) fare_total += p[i];
    for (let i = 0; i < c.children; i++) fare_total += Math.round(p[c.adults + i] * PRICING.CHILD_RATE);
    fare_total += c.infants * Math.round(p[0] * PRICING.INFANT_RATE);
  }
  const taxes = (c.adults + c.children) * PRICING.TAX_PER_PAX_PER_LEG * legs.length;
  const cod_fee = method === 'cod' ? PRICING.COD_FEE : 0;
  return { fare_total, taxes, service_fee: PRICING.SERVICE_FEE, cod_fee, total: fare_total + taxes + PRICING.SERVICE_FEE + cod_fee };
}

// حجز واحد في كل لحظة: يمنع بيع نفس المقعد مرتين لو وصل طلبان في نفس الثانية
let bookingQueue = Promise.resolve();
function withBookingLock(fn) {
  const run = bookingQueue.then(fn, fn);
  bookingQueue = run.catch(() => {});
  return run;
}

// ---------- التحقق من بيانات رحلة يدخلها المكتب ----------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const clip = (v, n) => String(v ?? '').replace(/[<>\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
function validateSchedule(body, existing) {
  const b = body || {}, errors = [];
  const no = toAsciiDigits(b.no).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9]{2}\d{1,4}$/.test(no)) errors.push('رقم الرحلة غير صالح (حرفان أو رمز الشركة ثم أرقام، مثال: LN401)');
  const airline = clip(b.airline, 40); if (airline.length < 2) errors.push('اسم شركة الطيران مطلوب');
  const code = toAsciiDigits(b.code || no.slice(0, 2)).toUpperCase().slice(0, 2);
  if (!/^[A-Z0-9]{2}$/.test(code)) errors.push('رمز الشركة حرفان (مثال: LN)');
  const color = COLOR_RE.test(b.color) ? b.color : '#2563EB';
  const from = String(b.from || '').toUpperCase(), to = String(b.to || '').toUpperCase();
  if (!AIRPORTS[from] || !AIRPORTS[to] || from === to) errors.push('اختر مطار إقلاع ووصول مختلفين');
  const dep = toAsciiDigits(b.dep), arr = toAsciiDigits(b.arr);
  if (!TIME_RE.test(dep) || !TIME_RE.test(arr)) errors.push('وقت الإقلاع والوصول بصيغة 08:30');
  const dur = parseInt(toAsciiDigits(b.dur)); if (!(dur >= 20 && dur <= 1800)) errors.push('مدة الرحلة بالدقائق غير صالحة');
  const stops = Math.min(Math.max(parseInt(toAsciiDigits(b.stops)) || 0, 0), 3);
  const via = stops ? clip(b.via, 40) : '';
  const bag = clip(b.bag, 30) || '23 كغ';
  const days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
  if (!days.length && !isDated(existing || {})) errors.push('اختر يوم تشغيل واحد على الأقل');
  const currency = ['LYD', 'USD', 'EUR'].includes(b.currency) ? b.currency : 'LYD';
  const tiers = (Array.isArray(b.tiers) ? b.tiers : []).map(t => ({ seats: parseInt(toAsciiDigits(t?.seats)) || 0, price: Number(toAsciiDigits(t?.price)) || 0 }))
    .filter(t => t.seats > 0 || t.price > 0);
  if (!tiers.length) errors.push('أضف فئة أسعار واحدة على الأقل');
  if (tiers.length > 8) errors.push('الحد الأقصى 8 فئات أسعار');
  tiers.forEach((t, i) => {
    if (!(t.seats >= 1 && t.seats <= 500)) errors.push(`عدد مقاعد الفئة ${i + 1} من 1 إلى 500`);
    if (!(t.price > 0 && t.price <= 100000)) errors.push(`سعر الفئة ${i + 1} غير صالح`);
  });
  return {
    errors, data: {
      no, airline, code, color, from, to, dep, arr, dur, stops, via, bag, days, currency, tiers,
      active: b.active !== false,
      closed_dates: existing?.closed_dates || [], offline_sold: existing?.offline_sold || {},
      ...(isDated(existing || {}) ? { days: [], dated: applyToDates(existing, { dep, arr, dur, tiers }) } : {}),
      updated_at: now(),
    },
  };
}

// تعديل رحلة بتواريخ محددة من النافذة: ما تغيّر (الوقت/المدة/الفئات) يُطبَّق على كل تواريخها القادمة،
// وما لم يتغيّر يبقى كما هو في كل تاريخ (يحافظ على أسعار الأيام المختلفة من الاستيراد)
function applyToDates(existing, next) {
  const out = {};
  for (const [d, v] of Object.entries(existing.dated)) {
    if (d < today()) continue;
    const o = { ...v };
    for (const k of ['dep', 'arr', 'dur', 'tiers']) if (JSON.stringify(next[k]) !== JSON.stringify(existing[k])) o[k] = next[k];
    out[d] = o;
  }
  return out;
}

// -------------------------------------------------------------
// التحقق من بيانات الحجز
// -------------------------------------------------------------
const PASSPORT_RE = /^(?=.*\d)[A-Z0-9]{6,9}$/;        // 6–9 حروف/أرقام إنجليزية وفيه رقم واحد على الأقل
const NAME_RE = /^[A-Z]+(?:['-][A-Z]+)*(?: [A-Z]+(?:['-][A-Z]+)*)+$/; // اسم ولقب على الأقل، حروف إنجليزية فقط
const PASSPORT_MIN_MONTHS = 6;                                     // صلاحية الجواز بعد آخر رحلة
const addMonths = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate())); return d.toISOString().slice(0, 10); };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function validateBooking(body) {
  const errors = [];
  const b = body || {};
  const tripType = b.tripType === 'round' ? 'round' : 'oneway';

  const counts = {
    adults: parseInt(toAsciiDigits(b.adults)) || 0,
    children: parseInt(toAsciiDigits(b.children)) || 0,
    infants: parseInt(toAsciiDigits(b.infants)) || 0,
  };
  const need = Math.max(counts.adults + counts.children, 1);
  const holdId = typeof b.holdId === 'string' ? b.holdId : undefined; // مقاعد هذا الزبون المقفولة لا تُحسب ضده
  const out = await flightById(b.outboundId, need, holdId);
  const ret = tripType === 'round' ? await flightById(b.returnId, need, holdId) : null;
  if (!out) errors.push('رحلة الذهاب غير متاحة');
  else if (!out.bookable) errors.push('لا توجد مقاعد كافية على رحلة الذهاب — اختر رحلة أخرى');
  else if (out.depart_date < today()) errors.push('رحلة الذهاب في تاريخ ماضٍ');
  if (tripType === 'round') {
    if (!ret) errors.push('رحلة العودة غير متاحة');
    else if (!ret.bookable) errors.push('لا توجد مقاعد كافية على رحلة العودة — اختر رحلة أخرى');
    else if (out && (ret.origin !== out.destination || ret.destination !== out.origin)) errors.push('رحلة العودة لا تطابق مسار الذهاب');
    else if (out && ret.depart_date < out.depart_date) errors.push('تاريخ العودة قبل تاريخ الذهاب');
  }

  const paxTotal = counts.adults + counts.children + counts.infants;
  if (counts.adults < 1) errors.push('يجب وجود مسافر بالغ واحد على الأقل');
  if (counts.children < 0 || counts.infants < 0) errors.push('عدد المسافرين غير صالح');
  if (paxTotal > PRICING.MAX_PAX) errors.push(`الحد الأقصى ${PRICING.MAX_PAX} مسافرين`);
  if (counts.infants > counts.adults) errors.push('عدد الرضّع لا يتجاوز عدد البالغين');

  const list = Array.isArray(b.passengers) ? b.passengers : [];
  if (list.length !== paxTotal) errors.push('عدد بيانات المسافرين لا يطابق العدد المختار');
  const expected = [...Array(counts.adults).fill('adult'), ...Array(counts.children).fill('child'), ...Array(counts.infants).fill('infant')];
  // الجواز لازم يكون صالحاً 6 أشهر على الأقل بعد آخر رحلة (العودة إن وُجدت)
  const lastTravel = (ret && ret.depart_date) || (out && out.depart_date) || today();
  const minExpiry = addMonths(lastTravel, PASSPORT_MIN_MONTHS);
  const seenPassports = new Set();
  // العمر بالسنوات الكاملة في تاريخ معيّن (لتصنيف بالغ/طفل/رضيع كما تطلبه شركات الطيران)
  const ageOn = (birth, date) => {
    const [by, bm, bd] = birth.split('-').map(Number), [y, m, d] = date.split('-').map(Number);
    return y - by - ((m < bm || (m === bm && d < bd)) ? 1 : 0);
  };
  const firstTravel = (out && out.depart_date) || today();
  const passengers = list.map((p, i) => {
    const fullName = String(p?.fullName ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
    const passport = toAsciiDigits(p?.passport).trim().toUpperCase();
    const passport_expiry = toAsciiDigits(p?.passportExpiry).trim();
    const birth_date = toAsciiDigits(p?.birthDate).trim();
    const type = expected[i] || 'adult';
    if (!isDate(birth_date)) errors.push(`أدخل تاريخ ميلاد المسافر ${i + 1}`);
    else if (birth_date > today()) errors.push(`تاريخ ميلاد المسافر ${i + 1} غير صالح`);
    else {
      // رضيع: أقل من سنتين حتى آخر رحلة · طفل: من سنتين وحتى أقل من 12 · بالغ: 12 فأكثر يوم الإقلاع
      const ageFirst = ageOn(birth_date, firstTravel), ageLast = ageOn(birth_date, lastTravel);
      if (ageFirst > 120) errors.push(`تاريخ ميلاد المسافر ${i + 1} غير صالح`);
      else if (type === 'infant' && ageLast >= 2) errors.push(`المسافر ${i + 1} مسجّل رضيعاً — الرضيع لازم يكون عمره أقل من سنتين يوم الرحلة`);
      else if (type === 'child' && ageLast < 2) errors.push(`المسافر ${i + 1} مسجّل طفلاً لكن عمره أقل من سنتين — سجّله رضيعاً`);
      else if (type === 'child' && ageFirst >= 12) errors.push(`المسافر ${i + 1} مسجّل طفلاً — عمر الطفل من سنتين وحتى أقل من 12 سنة يوم الرحلة`);
      else if (type === 'adult' && ageFirst < 12) errors.push(`المسافر ${i + 1} مسجّل بالغاً لكن عمره أقل من 12 سنة يوم الرحلة`);
    }
    if (fullName.length > 60 || !NAME_RE.test(fullName)) errors.push(`اسم المسافر ${i + 1}: اكتب الاسم واللقب بالحروف الإنجليزية كما في الجواز`);
    if (!PASSPORT_RE.test(passport)) errors.push(`رقم جواز المسافر ${i + 1} غير صالح (6–9 حروف وأرقام إنجليزية)`);
    else if (seenPassports.has(passport)) errors.push(`رقم جواز المسافر ${i + 1} مكرر`);
    seenPassports.add(passport);
    if (!isDate(passport_expiry)) errors.push(`أدخل تاريخ انتهاء جواز المسافر ${i + 1}`);
    else if (passport_expiry < minExpiry) errors.push(`جواز المسافر ${i + 1} لازم يكون صالحاً حتى ${minExpiry} على الأقل (6 أشهر بعد تاريخ الرحلة)`);
    return { fullName, passport, passport_expiry, birth_date, type };
  });

  const contact_phone = normalizePhone(b.contactPhone);
  if (!contact_phone) errors.push('رقم هاتف التواصل غير صالح (091–095 ثم 7 أرقام)');

  const email = String(b.email ?? '').trim();
  if (email && (!EMAIL_RE.test(email) || email.length > 120)) errors.push('البريد الإلكتروني غير صالح');

  const method = b.paymentMethod;
  if (!['sadad', 'tadawul', 'bank', 'cod'].includes(method)) errors.push('طريقة الدفع غير صالحة');

  let phone = null; // هاتف المحفظة — لسداد وتداول فقط
  if (method === 'sadad' || method === 'tadawul') {
    phone = normalizePhone(b.phone);
    if (!phone) errors.push('رقم هاتف المحفظة غير صالح');
  }

  if (b.agree !== true) errors.push('يجب الموافقة على الشروط');

  return { errors, data: { tripType, out, ret, counts, passengers, contact_phone, email, method, phone, holdId } };
}

// رمز تتبّع موقَّع لكل حجز — يوضع في رمز QR على التذكرة ليفتح «تتبّع حجزي» مباشرة بدون إدخال الهاتف
// (لا يمكن تخمينه: HMAC بمفتاح السيرفر، ولا يكشف أرقام الجوازات)
const trackToken = ref => crypto.createHmac('sha256', SESSION_SECRET).update('track:' + ref).digest('base64url').slice(0, 16);
function validTrackToken(ref, t) {
  const a = Buffer.from(String(t || '')), b = Buffer.from(trackToken(ref));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// رقم مرجعي مميز لعملية الدفع (يُكتب في البيان مع كود الحجز) — مثال: PAY-261105-7KQ2M
function newPaymentRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'PAY-' + today().slice(2).replace(/-/g, '') + '-' + Array.from(crypto.randomBytes(5), x => alphabet[x % alphabet.length]).join('');
}
async function newRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const ref = 'TKR-' + Array.from(crypto.randomBytes(6), x => alphabet[x % alphabet.length]).join('');
    if (!(await store.refExists(ref))) return ref;
  }
}

// -------------------------------------------------------------
// تغيير الحالة — كل إجراء يتحقق من الحالة الحالية قبل التنفيذ
// status          = حالة الدفع:  pending_cod | pending_payment | paid
// booking_status  = حالة الحجز:  pending | confirmed | cancelled
// -------------------------------------------------------------
const STATUS_ACTIONS = {
  confirm: {
    check: b => b.booking_status === 'cancelled' ? 'لا يمكن تأكيد حجز ملغي'
              : b.booking_status === 'confirmed' ? 'الحجز مؤكد مسبقاً' : null,
    apply: b => { b.booking_status = 'confirmed'; b.confirmed_at = now(); },
  },
  cancel: {
    check: b => b.booking_status === 'cancelled' ? 'الحجز ملغي مسبقاً' : null,
    apply: b => { b.booking_status = 'cancelled'; b.cancelled_at = now(); },
  },
  mark_paid: {
    check: b => b.booking_status === 'cancelled' ? 'لا يمكن تسجيل دفع لحجز ملغي'
              : b.status === 'paid' ? 'الدفع مسجّل مسبقاً' : null,
    apply: b => { b.status = 'paid'; b.paid_at = now(); },
  },
};

// -------------------------------------------------------------
// صلاحية الإدارة — جلسة موقّعة (JWT · HS256) في كوكي HttpOnly
// JavaScript في المتصفح لا يقرأ الكوكي (حماية من سرقة الجلسة)، و SameSite=Strict يمنع الطلبات من مواقع أخرى
// -------------------------------------------------------------
const COOKIE = 'rh_admin';
const b64u = buf => Buffer.from(buf).toString('base64url');
const passFp = crypto.createHash('sha256').update(ADMIN_USER + '\n' + ADMIN_PASS).digest('base64url').slice(0, 12); // تغيير كلمة المرور يُبطل الجلسات القديمة
function signJwt(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(head + '.' + body).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(head + '.' + body).digest();
  let given; try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p || p.sub !== ADMIN_USER || p.fp !== passFp || !(p.exp > Date.now() / 1000)) return null;
  return p;
}
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function sessionOf(req) {
  const auth = req.get('authorization') || '';
  return verifyJwt(readCookie(req, COOKIE) || (auth.startsWith('Bearer ') ? auth.slice(7) : ''));
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
function requireAdmin(req, res, next) {
  const s = sessionOf(req);
  if (!s) return res.status(401).json({ error: 'انتهت الجلسة أو لم تسجّل الدخول', login: '/login.html' });
  req.admin = s;
  next();
}
// مقارنة ثابتة الزمن (لا تكشف طول أو بداية كلمة المرور)
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

// -------------------------------------------------------------
// التطبيق
// -------------------------------------------------------------
app.set('trust proxy', 1); // خلف النفق أو الاستضافة: لمعرفة IP الزائر الحقيقي
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});
app.use(express.json({ limit: '30kb' }));
app.use('/api', rateLimit(300, 60_000)); // حد عام: 300 طلب في الدقيقة لكل IP
// صفحة اللوحة: بدون جلسة ← صفحة الدخول
app.get(['/admin', '/admin.html'], (req, res, next) => {
  if (!sessionOf(req)) return res.redirect(302, '/login.html');
  res.set('Cache-Control', 'no-store');
  if (req.path === '/admin') return res.redirect(302, '/admin.html');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- دخول / خروج الإدارة ----------
app.post('/api/admin/login', ah(async (req, res) => {
  const key = req.ip, t = Date.now();
  const h = badTokenHits.get(key);
  if (h && h.reset > t && h.count >= 8) {
    res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
    return res.status(429).json({ error: 'محاولات دخول كثيرة، حاول بعد 15 دقيقة' });
  }
  if (!ADMIN_PASS) return res.status(503).json({ error: 'لم تُضبط بيانات الدخول في السيرفر (ADMIN_USER و ADMIN_PASS)' });
  const user = String(req.body?.username ?? '').trim(), pass = String(req.body?.password ?? '');
  const ok = sameSecret(user.toLowerCase(), ADMIN_USER.toLowerCase()) & sameSecret(pass, ADMIN_PASS); // & (وليس &&) حتى يُفحص الاثنان دائماً
  if (!ok) {
    const cur = h && h.reset > t ? h : { count: 0, reset: t + 15 * 60_000 };
    cur.count++; badTokenHits.set(key, cur);
    await new Promise(r => setTimeout(r, 400)); // إبطاء التخمين
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  badTokenHits.delete(key);
  const iat = Math.floor(t / 1000), exp = iat + SESSION_HOURS * 3600;
  setSessionCookie(req, res, signJwt({ sub: ADMIN_USER, fp: passFp, iat, exp }), SESSION_HOURS * 3600);
  console.log(`[admin] login ${ADMIN_USER} from ${key}`);
  res.json({ ok: true, user: ADMIN_USER, expires_at: new Date(exp * 1000).toISOString() });
}));
app.post('/api/admin/logout', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});
app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ user: req.admin.sub, expires_at: new Date(req.admin.exp * 1000).toISOString() });
});

// ---------- قفل المقاعد المؤقت ----------
const holdLimiter = rateLimit(30, 15 * 60_000, 'محاولات كثيرة، حاول بعد قليل');
app.post('/api/hold-seat', holdLimiter, ah(async (req, res) => {
  await withBookingLock(async () => {
    const b = req.body || {};
    const adults = parseInt(toAsciiDigits(b.adults)) || 0, children = parseInt(toAsciiDigits(b.children)) || 0;
    const seats = adults + children;
    if (adults < 1 || seats > PRICING.MAX_PAX) return res.status(400).json({ error: 'عدد المسافرين غير صالح' });
    const ids = [b.outboundId, b.returnId].filter(Boolean).map(String);
    if (!ids.length || ids.length > 2) return res.status(400).json({ error: 'اختر الرحلة' });
    // تجديد/استبدال قفل سابق لنفس الزبون
    const prev = typeof b.holdId === 'string' && HOLDS.get(b.holdId);
    if (prev && prev.ip !== req.ip) return res.status(403).json({ error: 'قفل غير صالح' });
    // حد أقصى 2 أقفال نشطة لكل جهاز (يمنع حجز الرحلة كلها وهمياً)
    purgeHolds();
    const mine = [...HOLDS.entries()].filter(([k, h]) => h.ip === req.ip && k !== b.holdId);
    if (mine.length >= 2) HOLDS.delete(mine.sort((x, y) => x[1].expires - y[1].expires)[0][0]);
    for (const id of ids) {
      const f = await flightById(id, seats, prev ? b.holdId : undefined);
      if (!f) return res.status(404).json({ error: 'الرحلة غير متاحة' });
      if (!f.bookable) return res.status(409).json({ error: 'عذراً، المقاعد على هذه الرحلة لم تعد كافية — اختر رحلة أخرى', flight: id });
    }
    if (prev) HOLDS.delete(b.holdId);
    const holdId = crypto.randomBytes(16).toString('base64url');
    const expires = Date.now() + HOLD_MINUTES * 60_000;
    HOLDS.set(holdId, { flights: ids, seats, expires, ip: req.ip });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ holdId, expires_at: new Date(expires).toISOString(), seconds: HOLD_MINUTES * 60 });
  });
}));
// تحرير القفل (إغلاق النافذة / مغادرة الصفحة) — POST حتى يعمل مع navigator.sendBeacon
app.post('/api/hold-seat/:id/release', (req, res) => {
  const h = HOLDS.get(req.params.id);
  if (h && h.ip === req.ip) HOLDS.delete(req.params.id);
  res.status(204).end();
});

// ---------- الإعدادات العامة للواجهة ----------
app.get('/api/config', (req, res) => {
  const routes = [...new Map(SCHEDULES.filter(s => sellable(s) && hasFuture(s)).map(s => [`${s.from}-${s.to}`, { origin: s.from, destination: s.to }])).values()];
  res.json({ airports: AIRPORTS, routes, pricing: PRICING, whatsapp: getSettings().office_whatsapp, site_name: getSettings().site_name, today: today(), maxDate: addDays(today(), BOOKING_WINDOW_DAYS) });
});

// ---------- الإعدادات العامة (تقرأها الواجهة) ----------
app.get('/api/settings', (req, res) => {
  const s = getSettings();
  res.set('Cache-Control', 'no-store');
  // whatsapp فارغ = لم يُعيَّن رقم ← الواجهة تستخدم «مشاركة عبر واتساب»
  res.json({ site_name: s.site_name, whatsapp: s.office_whatsapp, payment: publicPayment() });
});

// ---------- البحث الحقيقي ----------
app.get('/api/flights', rateLimit(60, 60_000), ah(async (req, res) => {
  const from = String(req.query.from || '').toUpperCase(), to = String(req.query.to || '').toUpperCase();
  const date = toAsciiDigits(req.query.date);
  if (!AIRPORTS[from] || !AIRPORTS[to] || from === to) return res.status(400).json({ error: 'اختر مدينتين مختلفتين' });
  if (!isDate(date)) return res.status(400).json({ error: 'تاريخ غير صالح' });
  if (date < today()) return res.status(400).json({ error: 'لا يمكن البحث في تاريخ ماضٍ' });
  if (date > addDays(today(), BOOKING_WINDOW_DAYS)) return res.status(400).json({ error: `الحجز متاح حتى ${BOOKING_WINDOW_DAYS} يوماً مقدماً` });

  const adults = Math.max(parseInt(toAsciiDigits(req.query.adults)) || 1, 1);
  const children = Math.max(parseInt(toAsciiDigits(req.query.children)) || 0, 0);
  const infants = Math.max(parseInt(toAsciiDigits(req.query.infants)) || 0, 0);
  const need = Math.min(adults + children, PRICING.MAX_PAX);
  const own = typeof req.query.hold === 'string' ? req.query.hold : undefined;
  const flights = (await findFlights(from, to, date, need, infants, own)).sort((a, b) => a.depart_time.localeCompare(b.depart_time));
  // أرخص سعر متاح في الأيام القريبة (±3) لمساعدة الزبون على اختيار يوم أرخص
  const nearby = [];
  for (let i = -3; i <= 3; i++) {
    const d = addDays(date, i);
    if (d < today() || d > addDays(today(), BOOKING_WINDOW_DAYS)) continue;
    const list = (await findFlights(from, to, d, need)).filter(f => f.bookable);
    if (list.length) nearby.push({ date: d, min_price: Math.min(...list.map(f => f.price)) });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ flights, nearby });
}));

// ---------- إنشاء حجز ----------
app.post('/api/bookings', rateLimit(10, 15 * 60_000, 'تم إرسال حجوزات كثيرة من هذا الجهاز، حاول بعد 15 دقيقة'), ah(async (req, res) => {
  try {
   await withBookingLock(async () => {
    // التحقق داخل القفل: المقاعد والأسعار تُحسب لحظة الحجز نفسها
    const { errors, data } = await validateBooking(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0], details: errors });
    const { tripType, out, ret, counts, passengers, contact_phone, email, method, phone, holdId } = data;
    const legs = ret ? [out, ret] : [out];
    const booking = {
      id: Date.now(),
      ref: await newRef(),
      payment_ref: newPaymentRef(),
      trip_type: tripType,
      // حقول رحلة الذهاب في المستوى الأعلى — تستخدمها لوحة التحكم والتذكرة
      flight_id: out.id, airline: out.airline, origin: out.origin, destination: out.destination,
      depart_time: out.depart_time, arrive_time: out.arrive_time, depart_date: out.depart_date,
      return_date: ret ? ret.depart_date : null,
      outbound: out, return: ret,
      adults: counts.adults, children: counts.children, infants: counts.infants,
      pax_count: passengers.length, passengers,
      contact_phone, email,
      payment_method: method, phone,
      ...calcCost(legs, counts, method),
      // الدفع الإلكتروني غير مربوط ببوابة حقيقية بعد → "بانتظار الدفع" حتى يؤكده المكتب
      status: method === 'cod' ? 'pending_cod' : 'pending_payment',
      booking_status: 'pending',
      created_at: now(),
    };
    await store.insertBooking(booking);
    if (holdId) HOLDS.delete(holdId); // المقعد صار محجوزاً نهائياً
    console.log(`[new] ${booking.ref} · ${out.origin}→${out.destination}${ret ? ' (ذهاب وعودة)' : ''} · ${booking.pax_count} pax · ${booking.total} LYD · ${method}`);
    res.status(201).json({
      success: true,
      booking: {
        ref: booking.ref, payment_ref: booking.payment_ref, track_token: trackToken(booking.ref), status: booking.status, booking_status: booking.booking_status, trip_type: tripType,
        fare_total: booking.fare_total, taxes: booking.taxes, service_fee: booking.service_fee,
        cod_fee: booking.cod_fee, total: booking.total,
      },
    });
   });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'حدث خطأ في السيرفر، حاول مرة أخرى' });
  }
}));

// ---------- تتبّع الحجز (رقم الحجز + الهاتف) — بدون أرقام الجوازات ----------
app.get('/api/track', rateLimit(20, 15 * 60_000, 'محاولات بحث كثيرة، حاول بعد 15 دقيقة'), ah(async (req, res) => {
  const ref = toAsciiDigits(req.query.ref).trim().toUpperCase();
  const phone = normalizePhone(req.query.phone);
  const tok = String(req.query.t || '');
  const b = phone ? await store.findBookingByRefAndPhone(ref, phone)
    : (tok && /^TKR-[A-Z0-9]{6}$/.test(ref) && validTrackToken(ref, tok)) ? await store.findBooking(ref) : null;
  if (!b) return res.status(404).json({ error: 'لم نجد حجزاً بهذه البيانات. تأكد من رقم الحجز ورقم الهاتف.' });
  const out = b.outbound || { airline: b.airline, origin: b.origin, destination: b.destination, depart_date: b.depart_date, depart_time: b.depart_time, arrive_time: b.arrive_time };
  res.json({
    booking: {
      ref: b.ref, trip_type: b.trip_type, outbound: out, return: b.return || null, return_date: b.return_date,
      passengers: (b.passengers || []).map(p => ({ fullName: p.fullName, type: p.type || 'adult' })),
      adults: b.adults, children: b.children, infants: b.infants,
      status: b.status, booking_status: b.booking_status, payment_method: b.payment_method, payment_ref: b.payment_ref || null,
      track_token: trackToken(b.ref),
      fare_total: b.fare_total, taxes: b.taxes, service_fee: b.service_fee, cod_fee: b.cod_fee, total: b.total,
      created_at: b.created_at,
    },
  });
}));

// ---------- الإدارة ----------
app.get('/api/bookings', requireAdmin, ah(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const { items, total } = await store.listBookings({ limit, offset });
  res.json({ items, bookings: items, total, count: items.length, limit, offset });
}));

// ---------- تصدير الحجوزات إلى Excel (CSV) ----------
const PAY_AR = { sadad: 'سداد', tadawul: 'تداول', bank: 'تحويل مصرفي', cod: 'كاش عند الاستلام' };
const PAY_ST_AR = { pending_cod: 'بانتظار الكاش', pending_payment: 'بانتظار الدفع', paid: 'مدفوع' };
const BOOK_ST_AR = { pending: 'بانتظار التأكيد', confirmed: 'مؤكد', cancelled: 'ملغي' };

app.get('/api/bookings/export.csv', requireAdmin, ah(async (req, res) => {
  const head = ['رقم الحجز', 'تاريخ الحجز', 'وقت الحجز', 'نوع الرحلة', 'شركة الطيران', 'رقم الرحلة', 'من', 'إلى',
    'تاريخ الذهاب', 'وقت الذهاب', 'تاريخ العودة', 'بالغين', 'أطفال', 'رضّع', 'أسماء المسافرين', 'أرقام الجوازات', 'انتهاء الجوازات', 'تواريخ الميلاد',
    'هاتف التواصل', 'البريد', 'طريقة الدفع', 'مرجع الدفع', 'هاتف المحفظة', 'حالة الدفع', 'حالة الحجز', 'تاريخ الدفع',
    'سعر التذاكر', 'الضرائب', 'رسوم الخدمة', 'رسوم التحصيل', 'الإجمالي (د.ل)'];
  // نمنع Excel من تنفيذ خلية تبدأ بـ = + - @ (حماية من حقن الصيغ)
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const local = iso => { // توقيت ليبيا (UTC+2)
    if (!iso) return ['', ''];
    const d = new Date(Date.parse(iso) + 2 * 3600_000).toISOString();
    return [d.slice(0, 10), d.slice(11, 16)];
  };
  const rows = (await store.allBookings()).map(b => {
    const [d, t] = local(b.created_at);
    const pax = b.passengers || [];
    return [b.ref, d, t, b.trip_type === 'round' ? 'ذهاب وعودة' : 'ذهاب فقط', b.airline, b.outbound?.flight_no || '',
      b.origin, b.destination, b.depart_date, b.depart_time, b.return_date || '',
      b.adults ?? pax.length, b.children || 0, b.infants || 0,
      pax.map(p => p.fullName).join(' | '), pax.map(p => p.passport).join(' | '), pax.map(p => p.passport_expiry || '').join(' | '), pax.map(p => p.birth_date || '').join(' | '),
      b.contact_phone, b.email, PAY_AR[b.payment_method] || b.payment_method, b.payment_ref || '', b.phone || '',
      PAY_ST_AR[b.status] || b.status, BOOK_ST_AR[b.booking_status] || b.booking_status, local(b.paid_at)[0],
      b.fare_total, b.taxes, b.service_fee, b.cod_fee || 0, b.total].map(cell).join(',');
  });
  const stamp = local(now())[0];
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="bookings-${stamp}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.send('\uFEFF' + [head.join(','), ...rows].join('\r\n')); // BOM ليظهر العربي صحيحاً في Excel
}));

app.get('/api/bookings/:ref', requireAdmin, ah(async (req, res) => {
  const booking = await store.findBooking(req.params.ref);
  if (!booking) return res.status(404).json({ error: 'الحجز غير موجود' });
  res.json({ booking });
}));

app.patch('/api/bookings/:ref/status', requireAdmin, ah(async (req, res) => {
  const action = req.body?.action;
  if (!STATUS_ACTIONS[action]) return res.status(400).json({ error: 'إجراء غير صالح', allowed: Object.keys(STATUS_ACTIONS) });
  try {
    const booking = await store.findBooking(req.params.ref);
    if (!booking) return res.status(404).json({ error: 'الحجز غير موجود' });
    const problem = STATUS_ACTIONS[action].check(booking);
    if (problem) return res.status(409).json({ error: problem });
    STATUS_ACTIONS[action].apply(booking);
    booking.updated_at = now();
    await store.replaceBooking(booking);
    console.log(`[status] ${booking.ref} → ${action}`);
    res.json({ booking });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'حدث خطأ في السيرفر' });
  }
}));

// ---------- حذف نهائي (الإدارة فقط) ----------
// حذف حجز واحد: يجب إرسال { confirm: "<رقم الحجز>" } حتى لا يُحذف شيء بالخطأ
app.delete('/api/bookings/:ref', requireAdmin, ah(async (req, res) => {
  const ref = String(req.params.ref || '').trim().toUpperCase();
  if (String(req.body?.confirm || '').trim().toUpperCase() !== ref) return res.status(400).json({ error: 'تأكيد الحذف غير مطابق لرقم الحجز' });
  await withBookingLock(async () => {
    const ok = await store.deleteBooking(ref);
    if (!ok) return res.status(404).json({ error: 'الحجز غير موجود' });
    console.log(`[delete] ${ref} حُذف نهائياً بواسطة ${req.admin?.sub || 'admin'}`);
    res.json({ deleted: ref });
  });
}));
// تصفير سجل الحجوزات بالكامل: يجب إرسال { confirm: "حذف الكل" }
app.delete('/api/bookings', requireAdmin, ah(async (req, res) => {
  if (String(req.body?.confirm || '').trim() !== 'حذف الكل') return res.status(400).json({ error: 'اكتب «حذف الكل» لتأكيد تصفير السجل' });
  await withBookingLock(async () => {
    const n = await store.deleteAllBookings();
    HOLDS.clear(); // لا مقاعد معلّقة بعد التصفير
    console.log(`[delete-all] حُذف ${n} حجزاً بواسطة ${req.admin?.sub || 'admin'}`);
    res.json({ deleted: n });
  });
}));

// ---------- تعديل الإعدادات (الإدارة) ----------
app.put('/api/settings', requireAdmin, ah(async (req, res) => {
  const body = req.body || {};
  const settings = { ...getSettings() };
  if (body.site_name !== undefined) {
    const name = cleanSiteName(body.site_name);
    if (name.length < 2 || name.length > SITE_NAME_MAX) return res.status(400).json({ error: `اسم الموقع من 2 إلى ${SITE_NAME_MAX} حرفاً` });
    settings.site_name = name;
  }
  for (const [k, label] of [['fx_usd', 'الدولار'], ['fx_eur', 'اليورو']]) {
    if (body[k] === undefined) continue;
    const raw = toAsciiDigits(body[k]).trim();
    if (raw === '') { settings[k] = null; continue; }
    const v = Number(raw);
    if (!(v > 0 && v < 1000)) return res.status(400).json({ error: `سعر ${label} غير صالح` });
    settings[k] = Math.round(v * 10000) / 10000;
  }
  if (body.payment !== undefined) {
    const { out, errs } = cleanPayment(body.payment);
    if (errs.length) return res.status(400).json({ error: errs[0], details: errs });
    settings.payment = out;
  }
  if (body.whatsapp !== undefined) {
    const wa = normalizeWhatsapp(body.whatsapp);
    if (wa === null) return res.status(400).json({ error: 'رقم واتساب غير صالح. مثال: 0912345678 أو ‎+218912345678' });
    settings.office_whatsapp = wa;
  }
  await saveSettings(settings);
  console.log(`[settings] site_name → ${settings.site_name} · office_whatsapp → ${settings.office_whatsapp || '(بدون رقم — وضع المشاركة)'}`);
  res.json({ site_name: settings.site_name, whatsapp: settings.office_whatsapp, fx_usd: settings.fx_usd, fx_eur: settings.fx_eur, payment: publicPayment() });
}));

// ---------- الرحلات والأسعار (الإدارة) ----------
app.get('/api/admin/schedules', requireAdmin, (req, res) => {
  const s = getSettings();
  res.set('Cache-Control', 'no-store');
  res.json({
    schedules: SCHEDULES.map(x => ({ ...x, capacity: capacityOf(x), sellable: sellable(x) })),
    airports: AIRPORTS, fx_usd: s.fx_usd, fx_eur: s.fx_eur,
  });
});

app.post('/api/admin/schedules', requireAdmin, ah(async (req, res) => {
  const { errors, data } = validateSchedule(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], details: errors });
  if (SCHEDULES.some(x => x.no === data.no)) return res.status(409).json({ error: `الرحلة ${data.no} موجودة مسبقاً — عدّلها بدل إضافتها` });
  data.created_at = now();
  await store.upsertSchedule(data);
  SCHEDULES.push(data);
  console.log(`[schedule] + ${data.no} ${data.from}→${data.to}`);
  res.status(201).json({ schedule: data });
}));

app.put('/api/admin/schedules/:no', requireAdmin, ah(async (req, res) => {
  const cur = SCHEDULES.find(x => x.no === req.params.no);
  if (!cur) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  const { errors, data } = validateSchedule({ ...req.body, no: cur.no }, cur); // رقم الرحلة ثابت (تعتمد عليه الحجوزات)
  if (errors.length) return res.status(400).json({ error: errors[0], details: errors });
  data.created_at = cur.created_at;
  await store.upsertSchedule(data);
  SCHEDULES[SCHEDULES.indexOf(cur)] = data;
  console.log(`[schedule] ~ ${data.no}`);
  res.json({ schedule: data });
}));

app.delete('/api/admin/schedules/:no', requireAdmin, ah(async (req, res) => {
  const cur = SCHEDULES.find(x => x.no === req.params.no);
  if (!cur) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  await store.deleteSchedule(cur.no);
  SCHEDULES = SCHEDULES.filter(x => x !== cur);
  console.log(`[schedule] - ${cur.no}`);
  res.json({ ok: true }); // الحجوزات السابقة تبقى كما هي (تحتفظ بنسخة من بيانات رحلتها)
}));

// مواعيد الرحلة القادمة: المباع والمتبقي والسعر الحالي لكل يوم تشغيل
app.get('/api/admin/schedules/:no/dates', requireAdmin, ah(async (req, res) => {
  const s = SCHEDULES.find(x => x.no === req.params.no);
  if (!s) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  const days = Math.min(Math.max(parseInt(req.query.days) || 60, 7), BOOKING_WINDOW_DAYS);
  const dates = [];
  if (isDated(s)) dates.push(...Object.keys(s.dated).filter(d => d >= today()).sort().slice(0, 366));
  else for (let i = 0; i <= days; i++) { const d = addDays(today(), i); if (s.days.includes(dow(d))) dates.push(d); }
  const sold = await store.seatsSold(dates.map(d => flightId(s, d)));
  res.set('Cache-Control', 'no-store');
  res.json({
    capacity: capacityOf(s), currency: s.currency, dated: isDated(s),
    dates: dates.map(d => {
      const sd = atDate(s, d), cap = capacityOf(sd);
      const online = sold[flightId(s, d)] || 0, offline = Number((s.offline_sold || {})[d]) || 0;
      const f = flightFor(sd, d, online, 1);
      return { date: d, dep: sd.dep, capacity: cap, online, offline, left: Math.max(0, cap - online - offline), price: f.price, closed: (s.closed_dates || []).includes(d) };
    }),
  });
}));

// تعديل يوم معيّن: إقفاله، أو تسجيل مقاعد بيعت خارج الموقع (في المكتب مثلاً)
app.put('/api/admin/schedules/:no/dates/:date', requireAdmin, ah(async (req, res) => {
  const cur = SCHEDULES.find(x => x.no === req.params.no);
  const date = req.params.date;
  if (!cur) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  if (!isDate(date) || !runsOn(cur, date)) return res.status(400).json({ error: 'الرحلة لا تعمل في هذا التاريخ' });
  const s = { ...cur, closed_dates: [...(cur.closed_dates || [])], offline_sold: { ...(cur.offline_sold || {}) } };
  if (req.body?.closed !== undefined) {
    s.closed_dates = s.closed_dates.filter(d => d !== date && d >= today());
    if (req.body.closed) s.closed_dates.push(date);
  }
  if (req.body?.offline !== undefined) {
    const n = parseInt(toAsciiDigits(req.body.offline)) || 0;
    if (n < 0 || n > capacityOf(atDate(s, date))) return res.status(400).json({ error: 'عدد المقاعد المباعة خارج الموقع غير صالح' });
    if (n) s.offline_sold[date] = n; else delete s.offline_sold[date];
  }
  // تنظيف الأيام الماضية
  for (const d of Object.keys(s.offline_sold)) if (d < today()) delete s.offline_sold[d];
  s.updated_at = now();
  await store.upsertSchedule(s);
  SCHEDULES[SCHEDULES.indexOf(cur)] = s;
  res.json({ ok: true });
}));

// ---------- استيراد جدول الرحلات من Excel / CSV ----------
// نموذج Excel فارغ بالأعمدة المطلوبة
app.get('/api/admin/flights/template.xlsx', requireAdmin, ah(async (req, res) => {
  const buf = await flightImport.buildTemplate(AIRPORTS);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="flights-template.xlsx"; filename*=UTF-8''${encodeURIComponent('نموذج-جدول-الرحلات.xlsx')}`,
    'Cache-Control': 'no-store',
  });
  res.send(buf);
}));

const IMPORT_COLORS = ['#1D5BD8', '#E11D48', '#0E7490', '#7C3AED', '#059669', '#D97706', '#DB2777', '#334155'];
const colorForCode = code => {
  const known = SCHEDULES.find(x => x.code === code);
  if (known) return known.color;
  let h = 0; for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return IMPORT_COLORS[h % IMPORT_COLORS.length];
};

// الملف يُرسل كما هو في جسم الطلب (application/octet-stream) — بعد التحقق من جلسة الأدمن
// ?filename=…  &mode=merge (افتراضي: يضيف/يحدّث التواريخ) | replace (يستبدل الرحلات بنفس الرقم)  &dry=1 (معاينة بدون حفظ)
app.post('/api/admin/flights/import', requireAdmin,
  express.raw({ type: () => true, limit: '5mb' }),
  ah(async (req, res) => {
    const mode = req.query.mode === 'replace' ? 'replace' : 'merge';
    const dry = req.query.dry === '1' || req.query.dry === 'true';
    const filename = clip(req.query.filename, 120);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'لم يصل أي ملف' });

    let rows;
    try { rows = await flightImport.parseUpload(req.body, filename); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const maxDate = addDays(today(), 365);
    const { errors, groups } = flightImport.validateRows(rows, { AIRPORTS, toAscii: toAsciiDigits, today: today(), maxDate, clip });

    // تحويل كل مجموعة (رقم رحلة) إلى رحلة في الجدول، ومقارنتها بالموجود
    const items = [], created = [], updated = [], warnings = [];
    for (const g of groups.values()) {
      const first = g.rows[0];
      const cur = SCHEDULES.find(x => x.no === g.no);
      const code = g.no.slice(0, 2);
      const airline = g.airline || cur?.airline || SCHEDULES.find(x => x.code === code)?.airline || '';
      if (!airline) { errors.push({ row: first, msg: `اكتب اسم شركة الطيران للرحلة ${g.no} في عمود «شركة الطيران» (الرمز ${code} غير موجود في الجدول)` }); continue; }
      if (cur && mode === 'merge') {
        if (!isDated(cur)) { errors.push({ row: first, msg: `الرحلة ${g.no} موجودة في الجدول كرحلة أسبوعية — اختر «استبدال الرحلات الموجودة» أو استخدم رقماً آخر` }); continue; }
        if (cur.from !== g.from || cur.to !== g.to) { errors.push({ row: first, msg: `الرحلة ${g.no} موجودة بمسار ${cur.from}→${cur.to} وليس ${g.from}→${g.to}` }); continue; }
      }
      const fresh = Object.fromEntries(Object.entries(g.dates).map(([d, v]) => [d, { dep: v.dep, arr: v.arr, dur: v.dur, tiers: v.tiers }]));
      const keepOld = cur && mode === 'merge' ? Object.fromEntries(Object.entries(cur.dated).filter(([d]) => d >= today())) : {};
      const dated = { ...keepOld, ...fresh };
      const firstDate = Object.keys(dated).sort()[0];
      const keepDay = d => !!dated[d];
      items.push({
        no: g.no, airline, code, color: cur?.color || colorForCode(code),
        from: g.from, to: g.to, ...dated[firstDate],
        stops: cur?.stops || 0, via: cur?.via || '', bag: g.bag || cur?.bag || '23 كغ',
        days: [], dated, currency: g.currency, active: cur ? cur.active : true,
        // الأيام المقفولة والمقاعد المباعة في المكتب تبقى للتواريخ التي ما زالت في الجدول
        closed_dates: (cur?.closed_dates || []).filter(keepDay),
        offline_sold: Object.fromEntries(Object.entries(cur?.offline_sold || {}).filter(([d]) => keepDay(d))),
        source: 'import', created_at: cur?.created_at || now(), updated_at: now(),
      });
      (cur ? updated : created).push(g.no);
      if (g.currency !== 'LYD' && !(Number(getSettings()[FX_KEY[g.currency]]) > 0))
        warnings.push(`الرحلة ${g.no} بعملة ${g.currency} ولن تظهر للزبائن حتى تضبط سعر الصرف في الإعدادات`);
    }

    // تنبيه: تاريخ مقاعده الجديدة أقل من المحجوز فعلاً
    if (items.length) {
      const ids = items.flatMap(s => Object.keys(s.dated).map(d => flightId(s, d)));
      const sold = await store.seatsSold(ids);
      for (const s of items) for (const [d, v] of Object.entries(s.dated)) {
        const n = (sold[flightId(s, d)] || 0) + (Number(s.offline_sold[d]) || 0), cap = capacityOf(v);
        if (n > cap) warnings.push(`${s.no} يوم ${d}: المقاعد (${cap}) أقل من المحجوز فعلاً (${n}) — لن تُباع مقاعد إضافية`);
      }
    }

    errors.sort((a, b) => a.row - b.row);
    const totalDates = [...groups.values()].reduce((n, g) => n + Object.keys(g.dates).length, 0);
    const summary = { rows: rows.length, flights: items.length, dates: totalDates, created, updated, mode };
    const preview = [...groups.values()].flatMap(g => Object.entries(g.dates).map(([d, v]) => ({
      row: v._row, no: g.no, from: g.from, to: g.to, date: d, dep: v.dep, arr: v.arr, dur: v.dur,
      price: v.tiers[0].price, seats: v.tiers[0].seats, currency: g.currency,
    }))).sort((a, b) => a.row - b.row).slice(0, 200);

    // أي خطأ = لا يُحفظ شيء (الملف كله أو لا شيء)
    if (errors.length) return res.status(422).json({ ok: false, error: `في الملف ${errors.length} خطأ — صحّحها ثم أعد الرفع`, errors: errors.slice(0, 300), warnings, summary, preview });
    if (dry) return res.json({ ok: true, dry: true, summary, warnings, preview });

    await withBookingLock(async () => {
      await store.upsertSchedules(items);
      for (const it of items) {
        const i = SCHEDULES.findIndex(x => x.no === it.no);
        if (i === -1) SCHEDULES.push(it); else SCHEDULES[i] = it;
      }
    });
    console.log(`[import] ${filename || 'file'} · ${mode} · ${created.length} جديدة · ${updated.length} محدّثة · ${totalDates} تاريخ`);
    res.json({ ok: true, dry: false, summary, warnings });
  }));

app.get('/api/health', ah(async (req, res) => {
  await store.refExists('__health__'); // يتأكد أن قاعدة البيانات ترد
  res.json({ ok: true, storage: store.kind, time: now() });
}));

app.get('/api/admin/bookings', (req, res) => res.redirect(307, '/api/bookings'));
app.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'بيانات غير صالحة' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'الطلب أكبر من المسموح' });
  console.error(err);
  res.status(500).json({ error: 'حدث خطأ في السيرفر' });
});

// -------------------------------------------------------------
// التشغيل: نتصل بالتخزين أولاً، ثم نفتح السيرفر
// -------------------------------------------------------------
async function start() {
  try {
    await store.init();
    SETTINGS = await store.getSettings();
    SCHEDULES = await store.listSchedules();
    if (!SCHEDULES.length) { // أول تشغيل: جدول افتراضي يعدّله المكتب من اللوحة
      for (const s of SEED) await store.upsertSchedule({ ...s, created_at: now(), updated_at: now() });
      SCHEDULES = await store.listSchedules();
      console.log(`🗓  تمت تعبئة جدول الرحلات الافتراضي (${SCHEDULES.length} رحلة) — عدّله من لوحة التحكم ← الرحلات والأسعار`);
    }
  } catch (e) {
    console.error('❌ تعذر الاتصال بقاعدة البيانات:', e.message);
    console.error('   تأكد من MONGODB_URI، ومن كلمة مرور المستخدم، ومن إضافة 0.0.0.0/0 في Network Access على Atlas.');
    process.exit(1); // Render يعيد المحاولة تلقائياً
  }
  const server = app.listen(PORT, () => {
    console.log(`\n===========================================`);
    console.log(`✅ السيرفر يعمل بنجاح!`);
    console.log(`🌐 الموقع: http://localhost:${PORT}`);
    console.log(`📊 لوحة التحكم: http://localhost:${PORT}/admin.html`);
    console.log(`💾 التخزين: ${store.describe()}`);
    const wa = getSettings().office_whatsapp;
    console.log(`💬 واتساب المكتب: ${wa ? '+' + wa : 'غير معيَّن — زر واتساب يعمل كمشاركة (عيّنه من لوحة التحكم ← الإعدادات)'}`);
    console.log(`===========================================\n`);
  });
  // إيقاف نظيف (Render يرسل SIGTERM قبل إعادة التشغيل)
  const stop = () => server.close(async () => { try { await store.client?.close(); } finally { process.exit(0); } });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
start();
