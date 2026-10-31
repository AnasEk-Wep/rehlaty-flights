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
//  الإدارة (رمز في الهيدر فقط — Authorization: Bearer أو x-admin-token):
//    GET   /api/bookings             ← كل الحجوزات
//    GET   /api/bookings/:ref        ← حجز واحد (للتذكرة)
//    PATCH /api/bookings/:ref/status ← تأكيد / إلغاء / تم استلام الدفع
//    PUT   /api/settings             ← حفظ الإعدادات { "site_name": "...", "whatsapp": "0912345678" }
//    GET   /api/bookings/export.csv  ← تصدير كل الحجوزات لملف Excel (CSV)
//    GET   /api/health               ← فحص الحالة (لـ Render)
// =============================================================
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { store, DEFAULT_SETTINGS } = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '123456';

if (!process.env.ADMIN_TOKEN || ADMIN_TOKEN.length < 12) {
  console.warn('⚠️  ADMIN_TOKEN ضعيف أو غير مضبوط. استخدم رمزاً طويلاً (12 حرفاً فأكثر) قبل فتح الموقع للعامة.');
}

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
// المدن والرحلات — جدول أسبوعي تُولَّد منه رحلات كل يوم تلقائياً
// (عدّل الأسعار والمواعيد هنا. days: أيام التشغيل، 0 = الأحد … 6 = السبت)
// -------------------------------------------------------------
const AIRPORTS = {
  MJI: { city: 'طرابلس',  name: 'مطار معيتيقة الدولي' },
  BEN: { city: 'بنغازي',  name: 'مطار بنينا الدولي' },
  IST: { city: 'إسطنبول', name: 'مطار إسطنبول' },
  TUN: { city: 'تونس',    name: 'مطار تونس قرطاج' },
  CAI: { city: 'القاهرة', name: 'مطار القاهرة الدولي' },
};

const SCHEDULE = [
  { no: 'LN401', airline: 'الخطوط الليبية',   code: 'LN', color: '#1D5BD8', from: 'MJI', to: 'IST', dep: '08:30', arr: '12:15', dur: 165, stops: 0, via: '',     price: 890,  bag: '23 كغ', days: [0, 2, 4, 6] },
  { no: '8U742', airline: 'الخطوط الأفريقية', code: '8U', color: '#16A34A', from: 'MJI', to: 'IST', dep: '11:00', arr: '14:50', dur: 170, stops: 0, via: '',     price: 960,  bag: '30 كغ', days: [1, 3, 5] },
  { no: 'UZ215', airline: 'البراق للطيران',   code: 'UZ', color: '#7C3AED', from: 'MJI', to: 'IST', dep: '06:15', arr: '13:40', dur: 385, stops: 1, via: 'تونس', price: 760,  bag: '23 كغ', days: [0, 1, 2, 3, 4, 5, 6] },
  { no: 'TK654', airline: 'الخطوط التركية',   code: 'TK', color: '#E11D48', from: 'MJI', to: 'IST', dep: '15:20', arr: '19:05', dur: 165, stops: 0, via: '',     price: 1120, bag: '30 كغ', days: [0, 1, 2, 3, 4, 5, 6] },
  { no: 'LN402', airline: 'الخطوط الليبية',   code: 'LN', color: '#1D5BD8', from: 'IST', to: 'MJI', dep: '13:30', arr: '15:15', dur: 165, stops: 0, via: '',     price: 880,  bag: '23 كغ', days: [0, 2, 4, 6] },
  { no: 'TK655', airline: 'الخطوط التركية',   code: 'TK', color: '#E11D48', from: 'IST', to: 'MJI', dep: '10:40', arr: '12:25', dur: 165, stops: 0, via: '',     price: 1090, bag: '30 كغ', days: [0, 1, 2, 3, 4, 5, 6] },
  { no: 'UZ216', airline: 'البراق للطيران',   code: 'UZ', color: '#7C3AED', from: 'IST', to: 'MJI', dep: '17:20', arr: '23:55', dur: 395, stops: 1, via: 'تونس', price: 740,  bag: '23 كغ', days: [0, 1, 2, 3, 4, 5, 6] },
  { no: '8U530', airline: 'الخطوط الأفريقية', code: '8U', color: '#16A34A', from: 'MJI', to: 'TUN', dep: '09:00', arr: '10:10', dur: 70,  stops: 0, via: '',     price: 420,  bag: '23 كغ', days: [0, 2, 4] },
  { no: '8U531', airline: 'الخطوط الأفريقية', code: '8U', color: '#16A34A', from: 'TUN', to: 'MJI', dep: '12:00', arr: '13:10', dur: 70,  stops: 0, via: '',     price: 410,  bag: '23 كغ', days: [0, 2, 4] },
  { no: 'LN160', airline: 'الخطوط الليبية',   code: 'LN', color: '#1D5BD8', from: 'BEN', to: 'CAI', dep: '07:45', arr: '09:30', dur: 105, stops: 0, via: '',     price: 610,  bag: '23 كغ', days: [1, 3, 5] },
  { no: 'LN161', airline: 'الخطوط الليبية',   code: 'LN', color: '#1D5BD8', from: 'CAI', to: 'BEN', dep: '11:00', arr: '12:45', dur: 105, stops: 0, via: '',     price: 600,  bag: '23 كغ', days: [1, 3, 5] },
  { no: 'TK658', airline: 'الخطوط التركية',   code: 'TK', color: '#E11D48', from: 'BEN', to: 'IST', dep: '14:10', arr: '18:20', dur: 190, stops: 0, via: '',     price: 1180, bag: '30 كغ', days: [2, 5] },
  { no: 'TK659', airline: 'الخطوط التركية',   code: 'TK', color: '#E11D48', from: 'IST', to: 'BEN', dep: '09:20', arr: '11:30', dur: 190, stops: 0, via: '',     price: 1150, bag: '30 كغ', days: [2, 5] },
];
const BOOKING_WINDOW_DAYS = 120; // أقصى مدة للحجز المسبق

const PRICING = {
  TAX_PER_PAX_PER_LEG: 45, // ضرائب ورسوم مطار لكل مسافر (غير الرضيع) لكل رحلة
  SERVICE_FEE: 15,         // رسوم خدمة المكتب لكل حجز
  COD_FEE: 10,             // رسوم التحصيل النقدي
  CHILD_RATE: 0.75,        // الطفل (2–11 سنة) = 75% من سعر البالغ
  INFANT_RATE: 0.10,       // الرضيع (أقل من سنتين، بدون مقعد) = 10%
  MAX_PAX: 9,
};

// رحلة يوم معيّن من الجدول. المعرّف ثابت: LN401-2026-11-12
function flightFor(s, date) {
  return {
    id: `${s.no}-${date}`, flight_no: `${s.no.slice(0, 2)} ${s.no.slice(2)}`, airline: s.airline, airline_code: s.code,
    color: s.color, origin: s.from, destination: s.to, depart_date: date, depart_time: s.dep, arrive_time: s.arr,
    arrive_offset: s.arr < s.dep ? 1 : 0, duration_min: s.dur, stops: s.stops, via: s.via, price: s.price, bag: s.bag,
  };
}
function findFlights(from, to, date) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  return SCHEDULE.filter(s => s.from === from && s.to === to && s.days.includes(dow)).map(s => flightFor(s, date));
}
function flightById(id) {
  const m = /^([A-Z0-9]{2}\d{1,4})-(\d{4}-\d{2}-\d{2})$/.exec(String(id || ''));
  if (!m || !isDate(m[2])) return null;
  const s = SCHEDULE.find(x => x.no === m[1]);
  if (!s || !s.days.includes(new Date(m[2] + 'T00:00:00Z').getUTCDay())) return null;
  return flightFor(s, m[2]);
}

function calcCost(legs, c, method) {
  let fare_total = 0;
  for (const f of legs) {
    fare_total += c.adults * f.price + c.children * Math.round(f.price * PRICING.CHILD_RATE) + c.infants * Math.round(f.price * PRICING.INFANT_RATE);
  }
  const taxes = (c.adults + c.children) * PRICING.TAX_PER_PAX_PER_LEG * legs.length;
  const cod_fee = method === 'cod' ? PRICING.COD_FEE : 0;
  return { fare_total, taxes, service_fee: PRICING.SERVICE_FEE, cod_fee, total: fare_total + taxes + PRICING.SERVICE_FEE + cod_fee };
}

// -------------------------------------------------------------
// التحقق من بيانات الحجز
// -------------------------------------------------------------
const PASSPORT_RE = /^[A-Z0-9]{6,9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateBooking(body) {
  const errors = [];
  const b = body || {};
  const tripType = b.tripType === 'round' ? 'round' : 'oneway';

  const out = flightById(b.outboundId);
  const ret = tripType === 'round' ? flightById(b.returnId) : null;
  if (!out) errors.push('رحلة الذهاب غير متاحة');
  else if (out.depart_date < today()) errors.push('رحلة الذهاب في تاريخ ماضٍ');
  if (tripType === 'round') {
    if (!ret) errors.push('رحلة العودة غير متاحة');
    else if (out && (ret.origin !== out.destination || ret.destination !== out.origin)) errors.push('رحلة العودة لا تطابق مسار الذهاب');
    else if (out && ret.depart_date < out.depart_date) errors.push('تاريخ العودة قبل تاريخ الذهاب');
  }

  const counts = {
    adults: parseInt(toAsciiDigits(b.adults)) || 0,
    children: parseInt(toAsciiDigits(b.children)) || 0,
    infants: parseInt(toAsciiDigits(b.infants)) || 0,
  };
  const paxTotal = counts.adults + counts.children + counts.infants;
  if (counts.adults < 1) errors.push('يجب وجود مسافر بالغ واحد على الأقل');
  if (counts.children < 0 || counts.infants < 0) errors.push('عدد المسافرين غير صالح');
  if (paxTotal > PRICING.MAX_PAX) errors.push(`الحد الأقصى ${PRICING.MAX_PAX} مسافرين`);
  if (counts.infants > counts.adults) errors.push('عدد الرضّع لا يتجاوز عدد البالغين');

  const list = Array.isArray(b.passengers) ? b.passengers : [];
  if (list.length !== paxTotal) errors.push('عدد بيانات المسافرين لا يطابق العدد المختار');
  const expected = [...Array(counts.adults).fill('adult'), ...Array(counts.children).fill('child'), ...Array(counts.infants).fill('infant')];
  const passengers = list.map((p, i) => {
    const fullName = String(p?.fullName ?? '').trim().replace(/\s+/g, ' ');
    const passport = toAsciiDigits(p?.passport).trim().toUpperCase();
    if (fullName.length < 3 || fullName.length > 100) errors.push(`اسم المسافر ${i + 1} غير صالح`);
    if (!PASSPORT_RE.test(passport)) errors.push(`رقم جواز المسافر ${i + 1} غير صالح (6–9 حروف أو أرقام إنجليزية)`);
    return { fullName, passport, type: expected[i] || 'adult' };
  });

  const contact_phone = normalizePhone(b.contactPhone);
  if (!contact_phone) errors.push('رقم هاتف التواصل غير صالح (091–095 ثم 7 أرقام)');

  const email = String(b.email ?? '').trim();
  if (email && (!EMAIL_RE.test(email) || email.length > 120)) errors.push('البريد الإلكتروني غير صالح');

  const method = b.paymentMethod;
  if (!['sadad', 'tadawul', 'cod'].includes(method)) errors.push('طريقة الدفع غير صالحة');

  let phone = null; // هاتف المحفظة — لسداد وتداول فقط
  if (method === 'sadad' || method === 'tadawul') {
    phone = normalizePhone(b.phone);
    if (!phone) errors.push('رقم هاتف المحفظة غير صالح');
  }

  if (b.agree !== true) errors.push('يجب الموافقة على الشروط');

  return { errors, data: { tripType, out, ret, counts, passengers, contact_phone, email, method, phone } };
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
// صلاحية الإدارة — الرمز في الهيدر فقط (أُزيل ?token= لأنه يُحفظ في سجل المتصفح والسيرفرات)
// -------------------------------------------------------------
function readToken(req) {
  const auth = req.get('authorization') || '';
  return (auth.startsWith('Bearer ') ? auth.slice(7) : '') || req.get('x-admin-token') || '';
}
function requireAdmin(req, res, next) {
  const key = req.ip, t = Date.now();
  const h = badTokenHits.get(key);
  if (h && h.reset > t && h.count >= 10) {
    res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
    return res.status(429).json({ error: 'محاولات دخول كثيرة، حاول بعد 15 دقيقة' });
  }
  const a = Buffer.from(String(readToken(req))), b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const cur = h && h.reset > t ? h : { count: 0, reset: t + 15 * 60_000 };
    cur.count++; badTokenHits.set(key, cur);
    return res.status(401).json({ error: 'رمز الإدارة غير صحيح' });
  }
  next();
}

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
app.use(express.static(path.join(__dirname, 'public')));

// ---------- الإعدادات العامة للواجهة ----------
app.get('/api/config', (req, res) => {
  const routes = [...new Map(SCHEDULE.map(s => [`${s.from}-${s.to}`, { origin: s.from, destination: s.to }])).values()];
  res.json({ airports: AIRPORTS, routes, pricing: PRICING, whatsapp: getSettings().office_whatsapp, site_name: getSettings().site_name, today: today(), maxDate: addDays(today(), BOOKING_WINDOW_DAYS) });
});

// ---------- الإعدادات العامة (تقرأها الواجهة) ----------
app.get('/api/settings', (req, res) => {
  const s = getSettings();
  res.set('Cache-Control', 'no-store');
  // whatsapp فارغ = لم يُعيَّن رقم ← الواجهة تستخدم «مشاركة عبر واتساب»
  res.json({ site_name: s.site_name, whatsapp: s.office_whatsapp });
});

// ---------- البحث الحقيقي ----------
app.get('/api/flights', rateLimit(60, 60_000), (req, res) => {
  const from = String(req.query.from || '').toUpperCase(), to = String(req.query.to || '').toUpperCase();
  const date = toAsciiDigits(req.query.date);
  if (!AIRPORTS[from] || !AIRPORTS[to] || from === to) return res.status(400).json({ error: 'اختر مدينتين مختلفتين' });
  if (!isDate(date)) return res.status(400).json({ error: 'تاريخ غير صالح' });
  if (date < today()) return res.status(400).json({ error: 'لا يمكن البحث في تاريخ ماضٍ' });
  if (date > addDays(today(), BOOKING_WINDOW_DAYS)) return res.status(400).json({ error: `الحجز متاح حتى ${BOOKING_WINDOW_DAYS} يوماً مقدماً` });

  const flights = findFlights(from, to, date).sort((a, b) => a.depart_time.localeCompare(b.depart_time));
  // أرخص سعر في الأيام القريبة (±3) لمساعدة الزبون على اختيار يوم أرخص
  const nearby = [];
  for (let i = -3; i <= 3; i++) {
    const d = addDays(date, i);
    if (d < today()) continue;
    const list = findFlights(from, to, d);
    if (list.length) nearby.push({ date: d, min_price: Math.min(...list.map(f => f.price)) });
  }
  res.json({ flights, nearby });
});

// ---------- إنشاء حجز ----------
app.post('/api/bookings', rateLimit(10, 15 * 60_000, 'تم إرسال حجوزات كثيرة من هذا الجهاز، حاول بعد 15 دقيقة'), ah(async (req, res) => {
  const { errors, data } = validateBooking(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], details: errors });

  try {
    const { tripType, out, ret, counts, passengers, contact_phone, email, method, phone } = data;
    const legs = ret ? [out, ret] : [out];
    const booking = {
      id: Date.now(),
      ref: await newRef(),
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
    console.log(`[new] ${booking.ref} · ${out.origin}→${out.destination}${ret ? ' (ذهاب وعودة)' : ''} · ${booking.pax_count} pax · ${booking.total} LYD · ${method}`);
    res.status(201).json({
      success: true,
      booking: {
        ref: booking.ref, status: booking.status, booking_status: booking.booking_status, trip_type: tripType,
        fare_total: booking.fare_total, taxes: booking.taxes, service_fee: booking.service_fee,
        cod_fee: booking.cod_fee, total: booking.total,
      },
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
  const b = phone ? await store.findBookingByRefAndPhone(ref, phone) : null;
  if (!b) return res.status(404).json({ error: 'لم نجد حجزاً بهذه البيانات. تأكد من رقم الحجز ورقم الهاتف.' });
  const out = b.outbound || { airline: b.airline, origin: b.origin, destination: b.destination, depart_date: b.depart_date, depart_time: b.depart_time, arrive_time: b.arrive_time };
  res.json({
    booking: {
      ref: b.ref, trip_type: b.trip_type, outbound: out, return: b.return || null, return_date: b.return_date,
      passengers: (b.passengers || []).map(p => ({ fullName: p.fullName, type: p.type || 'adult' })),
      adults: b.adults, children: b.children, infants: b.infants,
      status: b.status, booking_status: b.booking_status, payment_method: b.payment_method,
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
const PAY_AR = { sadad: 'سداد', tadawul: 'تداول', cod: 'كاش عند الاستلام' };
const PAY_ST_AR = { pending_cod: 'بانتظار الكاش', pending_payment: 'بانتظار الدفع', paid: 'مدفوع' };
const BOOK_ST_AR = { pending: 'بانتظار التأكيد', confirmed: 'مؤكد', cancelled: 'ملغي' };

app.get('/api/bookings/export.csv', requireAdmin, ah(async (req, res) => {
  const head = ['رقم الحجز', 'تاريخ الحجز', 'وقت الحجز', 'نوع الرحلة', 'شركة الطيران', 'رقم الرحلة', 'من', 'إلى',
    'تاريخ الذهاب', 'وقت الذهاب', 'تاريخ العودة', 'بالغين', 'أطفال', 'رضّع', 'أسماء المسافرين', 'أرقام الجوازات',
    'هاتف التواصل', 'البريد', 'طريقة الدفع', 'هاتف المحفظة', 'حالة الدفع', 'حالة الحجز', 'تاريخ الدفع',
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
      pax.map(p => p.fullName).join(' | '), pax.map(p => p.passport).join(' | '),
      b.contact_phone, b.email, PAY_AR[b.payment_method] || b.payment_method, b.phone || '',
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

// ---------- تعديل الإعدادات (الإدارة) ----------
app.put('/api/settings', requireAdmin, ah(async (req, res) => {
  const body = req.body || {};
  const settings = { ...getSettings() };
  if (body.site_name !== undefined) {
    const name = cleanSiteName(body.site_name);
    if (name.length < 2 || name.length > SITE_NAME_MAX) return res.status(400).json({ error: `اسم الموقع من 2 إلى ${SITE_NAME_MAX} حرفاً` });
    settings.site_name = name;
  }
  if (body.whatsapp !== undefined) {
    const wa = normalizeWhatsapp(body.whatsapp);
    if (wa === null) return res.status(400).json({ error: 'رقم واتساب غير صالح. مثال: 0912345678 أو ‎+218912345678' });
    settings.office_whatsapp = wa;
  }
  await saveSettings(settings);
  console.log(`[settings] site_name → ${settings.site_name} · office_whatsapp → ${settings.office_whatsapp || '(بدون رقم — وضع المشاركة)'}`);
  res.json({ site_name: settings.site_name, whatsapp: settings.office_whatsapp });
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
