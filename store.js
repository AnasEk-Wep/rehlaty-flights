// =============================================================
//  طبقة التخزين — رحلتي لحجز الطيران
//
//  • إذا وُجد المتغير MONGODB_URI  ← MongoDB Atlas (دائم، لا يُمسح مع إعادة تشغيل Render)
//  • إذا لم يوجد                     ← ملفات bookings.json و settings.json (للتجربة على جهازك)
//
//  كل الدوال async وتُرجع نفس شكل البيانات في الحالتين، فلا يتغير شيء في server.js أو الواجهة.
// =============================================================
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BOOKINGS_FILE = process.env.DB_FILE || path.join(ROOT, 'bookings.json');
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(ROOT, 'settings.json');
const SCHEDULES_FILE = process.env.SCHEDULES_FILE || path.join(ROOT, 'schedules.json');

const DEFAULT_SETTINGS = {
  site_name: 'رحلتي لحجز الطيران', // اسم الموقع/المكتب — يظهر في الهيدر والتذكرة ورسائل واتساب
  office_whatsapp: '',
  fx_usd: null, // سعر الدولار بالدينار — مطلوب فقط للرحلات المسعّرة بالدولار
  fx_eur: null, // سعر اليورو بالدينار
};

// المقاعد المحجوزة (البالغين + الأطفال؛ الرضيع بدون مقعد) لكل رحلة-يوم من قائمة حجوزات غير ملغاة
function countSeats(bookings, ids) {
  const want = new Set(ids), out = {};
  for (const b of bookings) {
    if (!b || b.booking_status === 'cancelled') continue;
    const seats = (Number(b.adults) || 0) + (Number(b.children) || 0) || Number(b.pax_count) || 0;
    for (const leg of [b.outbound, b.return]) {
      const id = leg && leg.id;
      if (id && want.has(id)) out[id] = (out[id] || 0) + seats;
    }
  }
  return out;
}

// يكمّل الحجوزات القديمة بالحقول الجديدة حتى لا تتعطل الواجهة أو اللوحة
function normalize(b) {
  if (!b || typeof b !== 'object') return b;
  if (!b.ref) { // من النسخة المبسطة الأولى (passengerName/phone)
    b = {
      id: b.id, ref: 'OLD-' + b.id, flight_id: b.flightId, airline: '—', origin: '—', destination: '—',
      depart_time: '', arrive_time: '', depart_date: null, return_date: null,
      pax_count: Number(b.seats) || 1, passengers: [{ fullName: b.passengerName || '—', passport: '' }],
      contact_phone: b.phone || '', email: b.email || '', payment_method: 'cod', phone: null,
      fare_total: 0, taxes: 0, service_fee: 0, cod_fee: 0, total: 0,
      status: 'pending_cod', booking_status: b.status === 'cancelled' ? 'cancelled' : 'pending',
      created_at: b.createdAt || new Date().toISOString(),
    };
  }
  if (!b.trip_type) b.trip_type = b.return_date ? 'round' : 'oneway';
  if (b.adults == null) { b.adults = b.pax_count || (b.passengers || []).length || 1; b.children = 0; b.infants = 0; }
  return b;
}

// =============================================================
//  1) التخزين في ملفات JSON (الوضع المحلي)
// =============================================================
function jsonStore() {
  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  };
  // كتابة آمنة: ملف مؤقت ثم استبدال، حتى لا يتلف الملف لو انقطع السيرفر أثناء الحفظ
  const writeJson = (file, data) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };
  const all = () => { const d = readJson(BOOKINGS_FILE, []); return Array.isArray(d) ? d.map(normalize) : []; };

  return {
    kind: 'json',
    async init() {
      if (!fs.existsSync(BOOKINGS_FILE)) writeJson(BOOKINGS_FILE, []);
      if (!fs.existsSync(SETTINGS_FILE)) writeJson(SETTINGS_FILE, DEFAULT_SETTINGS);
    },
    async listBookings({ limit = 500, offset = 0 } = {}) {
      const list = all();
      return { items: list.slice(offset, offset + limit), total: list.length };
    },
    async allBookings() { return all(); },
    async findBooking(ref) { return all().find(b => b.ref === ref) || null; },
    async findBookingByRefAndPhone(ref, phone) { return all().find(b => b.ref === ref && b.contact_phone === phone) || null; },
    async refExists(ref) { return all().some(b => b.ref === ref); },
    async insertBooking(booking) {
      const list = all();
      list.unshift(booking); // الأحدث أولاً
      writeJson(BOOKINGS_FILE, list);
    },
    async replaceBooking(booking) {
      const list = all();
      const i = list.findIndex(b => b.ref === booking.ref);
      if (i === -1) return false;
      list[i] = booking;
      writeJson(BOOKINGS_FILE, list);
      return true;
    },
    // حذف نهائي (لوحة التحكم فقط)
    async deleteBooking(ref) {
      const list = all(), next = list.filter(b => b.ref !== ref);
      if (next.length === list.length) return false;
      writeJson(BOOKINGS_FILE, next);
      return true;
    },
    async deleteAllBookings() { const n = all().length; writeJson(BOOKINGS_FILE, []); return n; },
    async getSettings() { return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) }; },
    async saveSettings(settings) { writeJson(SETTINGS_FILE, settings); },
    // ---- جدول الرحلات (يديره المكتب من لوحة التحكم) ----
    async listSchedules() { const d = readJson(SCHEDULES_FILE, []); return Array.isArray(d) ? d : []; },
    async upsertSchedule(s) {
      const list = await this.listSchedules();
      const i = list.findIndex(x => x.no === s.no);
      if (i === -1) list.push(s); else list[i] = s;
      writeJson(SCHEDULES_FILE, list);
    },
    // حفظ عدة رحلات دفعة واحدة (استيراد Excel) — كتابة واحدة للملف
    async upsertSchedules(items) {
      const list = await this.listSchedules();
      for (const s of items) { const i = list.findIndex(x => x.no === s.no); if (i === -1) list.push(s); else list[i] = s; }
      writeJson(SCHEDULES_FILE, list);
    },
    async deleteSchedule(no) {
      const list = await this.listSchedules();
      const next = list.filter(x => x.no !== no);
      writeJson(SCHEDULES_FILE, next);
      return next.length !== list.length;
    },
    async seatsSold(ids) { return ids.length ? countSeats(all(), ids) : {}; },
    describe() { return `ملفات JSON (${path.basename(BOOKINGS_FILE)}) — للتجربة المحلية فقط`; },
  };
}

// =============================================================
//  2) التخزين في MongoDB Atlas (الإنتاج)
// =============================================================
function mongoStore(uri) {
  const { MongoClient } = require('mongodb');
  const dbName = process.env.MONGODB_DB || 'rehlati';
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
    maxPoolSize: 10,
    appName: 'rehlati-booking',
  });
  let bookings, settings, schedules;
  const NO_ID = { projection: { _id: 0 } };
  const strip = d => { if (!d) return d; const { _id, ...rest } = d; return rest; };

  return {
    kind: 'mongo',
    async init() {
      await client.connect();
      const db = client.db(dbName);
      bookings = db.collection('bookings');
      settings = db.collection('settings');
      schedules = db.collection('schedules');
      await schedules.createIndex({ no: 1 }, { unique: true, name: 'no_unique' });
      await bookings.createIndexes([
        { key: { ref: 1 }, unique: true, name: 'ref_unique' },
        { key: { created_at: -1 }, name: 'newest_first' },
        { key: { ref: 1, contact_phone: 1 }, name: 'track_lookup' },
        { key: { 'outbound.id': 1 }, name: 'seats_out' },
        { key: { 'return.id': 1 }, name: 'seats_ret', sparse: true },
      ]);
    },
    async listBookings({ limit = 500, offset = 0 } = {}) {
      const [items, total] = await Promise.all([
        bookings.find({}, NO_ID).sort({ created_at: -1, id: -1 }).skip(offset).limit(limit).toArray(),
        bookings.countDocuments(),
      ]);
      return { items: items.map(normalize), total };
    },
    async allBookings() {
      return (await bookings.find({}, NO_ID).sort({ created_at: -1, id: -1 }).toArray()).map(normalize);
    },
    async findBooking(ref) { return normalize(await bookings.findOne({ ref }, NO_ID)); },
    async findBookingByRefAndPhone(ref, phone) { return normalize(await bookings.findOne({ ref, contact_phone: phone }, NO_ID)); },
    async refExists(ref) { return (await bookings.countDocuments({ ref }, { limit: 1 })) > 0; },
    async insertBooking(booking) { await bookings.insertOne({ ...booking }); }, // نسخة حتى لا يُضاف _id للكائن الأصلي
    async replaceBooking(booking) {
      const r = await bookings.replaceOne({ ref: booking.ref }, strip(booking));
      return r.matchedCount === 1;
    },
    async deleteBooking(ref) { return (await bookings.deleteOne({ ref })).deletedCount === 1; },
    async deleteAllBookings() { return (await bookings.deleteMany({})).deletedCount; },
    async getSettings() {
      const doc = await settings.findOne({ _id: 'site' });
      return { ...DEFAULT_SETTINGS, ...strip(doc || {}) };
    },
    async saveSettings(s) { await settings.replaceOne({ _id: 'site' }, strip(s), { upsert: true }); },
    async listSchedules() { return schedules.find({}, NO_ID).sort({ no: 1 }).toArray(); },
    async upsertSchedule(s) { await schedules.replaceOne({ no: s.no }, strip(s), { upsert: true }); },
    // حفظ عدة رحلات دفعة واحدة (استيراد Excel) — طلب bulkWrite واحد إلى Atlas
    async upsertSchedules(items) {
      if (!items.length) return;
      await schedules.bulkWrite(items.map(s => ({ replaceOne: { filter: { no: s.no }, replacement: strip(s), upsert: true } })), { ordered: true });
    },
    async deleteSchedule(no) { return (await schedules.deleteOne({ no })).deletedCount === 1; },
    async seatsSold(ids) {
      if (!ids.length) return {};
      const docs = await bookings.find(
        { booking_status: { $ne: 'cancelled' }, $or: [{ 'outbound.id': { $in: ids } }, { 'return.id': { $in: ids } }] },
        { projection: { _id: 0, adults: 1, children: 1, pax_count: 1, booking_status: 1, 'outbound.id': 1, 'return.id': 1 } },
      ).toArray();
      return countSeats(docs, ids);
    },
    describe() { return `MongoDB Atlas (قاعدة: ${dbName}) — دائم`; },
    client,
  };
}

const store = process.env.MONGODB_URI ? mongoStore(process.env.MONGODB_URI) : jsonStore();

module.exports = { store, normalize, DEFAULT_SETTINGS, BOOKINGS_FILE, SETTINGS_FILE, SCHEDULES_FILE };
