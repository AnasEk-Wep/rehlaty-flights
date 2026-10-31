// =============================================================
//  استيراد الحجوزات والإعدادات من الملفات إلى MongoDB Atlas (مرة واحدة)
//
//  الاستخدام (PowerShell داخل مجلد المشروع):
//    $env:MONGODB_URI="mongodb+srv://..."; npm run import
//
//  • آمن للتكرار: الحجز الموجود مسبقاً (نفس رقم الحجز) يُتخطّى ولا يُكرَّر ولا يُستبدل.
//  • لا يحذف شيئاً: الملفات المحلية تبقى كما هي كنسخة احتياطية.
//  • مسارات اختيارية:  node scripts/import-to-mongo.js path/to/bookings.json path/to/settings.json
// =============================================================
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { normalize, DEFAULT_SETTINGS } = require('../store');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'rehlati';
const root = path.join(__dirname, '..');
const bookingsFile = path.resolve(process.argv[2] || path.join(root, 'bookings.json'));
const settingsFile = path.resolve(process.argv[3] || path.join(root, 'settings.json'));

if (!uri) {
  console.error('❌ ضع رابط الاتصال أولاً، مثال (PowerShell):');
  console.error('   $env:MONGODB_URI="mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/"; npm run import');
  process.exit(1);
}

const readJson = (file, fallback) => {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`❌ الملف ${path.basename(file)} غير صالح: ${e.message}`); process.exit(1); }
};

(async () => {
  const bookings = readJson(bookingsFile, []);
  const settings = readJson(settingsFile, null);
  if (!Array.isArray(bookings)) { console.error('❌ bookings.json يجب أن يحتوي قائمة حجوزات [ ... ]'); process.exit(1); }

  console.log(`📄 ${bookings.length} حجز في ${path.basename(bookingsFile)}${settings ? ' + الإعدادات' : ''}`);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000, appName: 'rehlati-import' });

  try {
    await client.connect();
    const db = client.db(dbName);
    const col = db.collection('bookings');
    await col.createIndex({ ref: 1 }, { unique: true, name: 'ref_unique' });

    // ---- الحجوزات: إضافة الجديد فقط ----
    let added = 0, skipped = 0;
    if (bookings.length) {
      const ops = bookings.map(normalize).filter(b => b && b.ref).map(b => {
        const { _id, ...doc } = b;
        return { updateOne: { filter: { ref: doc.ref }, update: { $setOnInsert: doc }, upsert: true } };
      });
      const r = await col.bulkWrite(ops, { ordered: false });
      added = r.upsertedCount;
      skipped = ops.length - added;
    }
    console.log(`✅ الحجوزات: أُضيف ${added}، ومُتخطّى ${skipped} (موجود مسبقاً)`);

    // ---- الإعدادات: ننقل ما في الملف فقط، دون مسح ما عُدّل في Atlas لاحقاً ----
    if (settings && typeof settings === 'object') {
      const s = {};
      if (settings.site_name) s.site_name = String(settings.site_name);
      if (settings.office_whatsapp !== undefined) s.office_whatsapp = String(settings.office_whatsapp);
      const existing = await db.collection('settings').findOne({ _id: 'site' });
      if (existing) {
        console.log('ℹ️  الإعدادات موجودة مسبقاً في Atlas — لم تُستبدل (عدّلها من لوحة التحكم ← الإعدادات).');
      } else {
        await db.collection('settings').insertOne({ _id: 'site', ...DEFAULT_SETTINGS, ...s });
        console.log(`✅ الإعدادات: الاسم «${s.site_name || DEFAULT_SETTINGS.site_name}» · واتساب ${s.office_whatsapp ? '+' + s.office_whatsapp : '(بدون رقم)'}`);
      }
    }

    const total = await col.countDocuments();
    console.log(`📦 إجمالي الحجوزات في Atlas الآن: ${total}`);
  } catch (e) {
    console.error('❌ فشل الاستيراد:', e.message);
    console.error('   تأكد من الرابط وكلمة المرور، ومن إضافة عنوانك (أو 0.0.0.0/0) في Network Access على Atlas.');
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
