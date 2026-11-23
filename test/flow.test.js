import './helpers.js';
import { CSV } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { q, updateSettings, getSetting } from '../src/db.js';
import { parseBuffer, applyImport, autoMapping, googleSheetCsvUrl } from '../src/importer.js';
import { searchProducts } from '../src/catalog.js';
import { quote, matchGovernorate } from '../src/shipping.js';
import { registerJobs } from '../src/server.js';
import { startWorker, stopWorker, drain, enqueueReply } from '../src/queue.js';
import { findOrCreateConversation, addMessage, listMessages, getConversation } from '../src/conversations.js';
import { hydrateAll } from '../src/db.js';
import { setPlatformSettings } from '../src/platform.js';

registerJobs();

test('استيراد الشيت: أعمدة ديناميكية وأقسام تلقائية', async () => {
  const table = await parseBuffer(Buffer.from(CSV), 'x.csv');
  const mapping = autoMapping(table.headers);
  assert.equal(mapping.name, 'اسم المنتج');
  assert.equal(mapping.price, 'السعر');
  assert.equal(mapping.category, 'القسم');
  assert.deepEqual(mapping.attributes, ['المقاس', 'اللون']); // أي عمود تاني = خاصية
  const r = q.run(`INSERT INTO sources(name,type,mapping) VALUES('t','file','{}')`);
  const stats = applyImport({ id: Number(r.lastInsertRowid), mapping, default_category: '', deactivate_missing: 1 }, table);
  assert.equal(stats.created, 4);
  assert.deepEqual(stats.categories_created.sort(), ['إكسسوارات', 'ملابس', 'أحذية'].sort());
  const cats = hydrateAll('categories', q.all('SELECT * FROM categories'));
  const clothes = cats.find((c) => c.name === 'ملابس');
  assert.ok(clothes.required_fields.includes('المقاس'), 'المقاس لازم يتسأل عنه تلقائيًا');
  // تحديث ثاني: مفيش تكرار
  const again = applyImport({ id: Number(r.lastInsertRowid), mapping, deactivate_missing: 1 }, table);
  assert.equal(again.created, 0); assert.equal(again.updated, 4);
  // لو اتشال منتج من الشيت يتوقف
  const smaller = { headers: table.headers, rows: table.rows.slice(0, 3) };
  assert.equal(applyImport({ id: Number(r.lastInsertRowid), mapping, deactivate_missing: 1 }, smaller).deactivated, 1);
  applyImport({ id: Number(r.lastInsertRowid), mapping, deactivate_missing: 1 }, table); // رجّعه
});

test('رابط جوجل شيت يتحول لتصدير CSV', () => {
  assert.equal(googleSheetCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit#gid=77'), 'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=77');
});

test('البحث بالعربي (همزات/ال التعريف/تاء مربوطة)', () => {
  assert.equal(searchProducts({ query: 'عايز الحذاء الرياضي' })[0].name, 'حذاء رياضي');
  assert.equal(searchProducts({ query: 'بنطلون' })[0].sku, 'JN-1');
  assert.equal(searchProducts({ query: '', category: 'احذية' }).length, 1);
});

test('الشحن بالمحافظة وكتابات مختلفة', () => {
  assert.equal(matchGovernorate('القاهره').governorate, 'القاهرة');
  assert.equal(matchGovernorate('اسكندريه').governorate, 'الإسكندرية');
  assert.equal(matchGovernorate('cairo').governorate, 'القاهرة');
  assert.equal(quote('بلد مش موجودة').known, false);
  q.run(`UPDATE shipping_rates SET price=45 WHERE governorate='القاهرة'`);
  q.run(`UPDATE shipping_rates SET price=75 WHERE governorate='أسيوط'`);
  assert.equal(quote('القاهرة').price, 45);
});

async function say(conv, text) {
  addMessage(conv.id, { direction: 'in', sender: 'customer', text });
  enqueueReply(conv.id, 0);
  await drain();
  const msgs = listMessages(conv.id).filter((m) => m.direction === 'out');
  return msgs[msgs.length - 1]?.text || '';
}

test('محادثة كاملة: بحث ← مقاس ← بيانات ← ملخص ← تأكيد ← أوردر', async () => {
  startWorker();
  updateSettings({ bot: { debounce_ms: 0 } }); setPlatformSettings({ ai: { provider: 'mock' } });
  const conv = findOrCreateConversation('simulator', 't1', 'اختبار');
  assert.match(await say(conv, 'سلام عليكم'), /أهلاً/);
  assert.match(await say(conv, 'عايز حذاء رياضي'), /900/);
  assert.match(await say(conv, 'عايز اطلب'), /المقاس/);
  assert.match(await say(conv, '44'), /المقاس/); // مقاس مش موجود → يعيد السؤال بالمتاح
  assert.match(await say(conv, '42'), /الاسم/);
  assert.match(await say(conv, 'أحمد علي'), /موبايل/);
  assert.match(await say(conv, '123'), /مش صحيح/);
  assert.match(await say(conv, '01012345678'), /المحافظة/);
  assert.match(await say(conv, 'بلد مجهولة'), /المحافظة|الشحن/);
  assert.match(await say(conv, 'القاهرة'), /العنوان/);
  const summary = await say(conv, 'مدينة نصر شارع عباس العقاد عمارة 5');
  assert.match(summary, /ملخص/);
  assert.match(summary, /945/); // 900 + 45 شحن
  const done = await say(conv, 'ايوه أكد');
  assert.match(done, /ORD-1001/);
  const order = hydrateAll('orders', q.all('SELECT * FROM orders'))[0];
  assert.equal(order.total, 945); assert.equal(order.shipping, 45); assert.equal(order.phone, '01012345678');
  assert.equal(order.items[0].options['المقاس'], '42');
  assert.equal(q.get(`SELECT stock FROM products WHERE sku='SH-1'`).stock, 2); // المخزون نزل
  assert.equal(getConversation(conv.id).cart.length, 0);
  stopWorker();
});

test('الأوردر ما يتحفظش بدون ملخص معروض (حماية)', async () => {
  const { cartAdd, createOrder, saveCustomerFields } = await import('../src/cart.js');
  const conv = findOrCreateConversation('simulator', 't2', '');
  const p = searchProducts({ query: 'شنطة' })[0];
  assert.ok(cartAdd(conv.id, { product_id: p.id, quantity: 1 }).ok);
  saveCustomerFields(conv.id, { name: 'س', phone: '01112345678', governorate: 'القاهرة', address: 'عنوان تجريبي طويل' });
  const r = createOrder(conv.id, {});
  assert.match(r.error, /order_summary/);
});

test('المخزون مش بيسمح بكمية أكتر من المتاح', async () => {
  const { cartAdd } = await import('../src/cart.js');
  const conv = findOrCreateConversation('simulator', 't3', '');
  const p = searchProducts({ query: 'بنطلون' })[0];
  const r = cartAdd(conv.id, { product_id: p.id, quantity: 9, options: { 'المقاس': '32' } });
  assert.match(r.error, /مش متاحة/);
});

test('خصم الاحتفاظ: مرة واحدة فقط وبالوضع المسموح بس', async () => {
  const { cartAdd } = await import('../src/cart.js');
  const { executeTool } = await import('../src/ai/tools.js');
  const mode = q.get(`SELECT * FROM modes WHERE name LIKE 'بيع نشط%'`);
  const normalMode = q.get(`SELECT * FROM modes ORDER BY id LIMIT 1`);
  const conv = findOrCreateConversation('simulator', 't4', '');
  const p = searchProducts({ query: 'شنطة' })[0];
  cartAdd(conv.id, { product_id: p.id, quantity: 1 });
  const ctx = (m) => ({ convId: conv.id, channel: 'simulator', mode: m, outbox: [], conv: getConversation(conv.id) });
  assert.equal((await executeTool('check_discounts', {}, ctx(normalMode))).available.length, 0); // الوضع العادي = ممنوع
  const a = await executeTool('check_discounts', {}, ctx(mode));
  assert.equal(a.available.length, 1);
  const ok = await executeTool('apply_discount', { rule_id: a.available[0].rule_id }, ctx(mode));
  assert.equal(ok.ok, true); assert.equal(ok.discount_amount, 45); // 10% من 450
  assert.match((await executeTool('apply_discount', { rule_id: a.available[0].rule_id }, ctx(mode))).error, /already/);
});

test('التعلم: إجابتك على سؤال معلّق تتحول لمعرفة ويستخدمها البوت', async () => {
  const { learn, searchKnowledge } = await import('../src/knowledge.js');
  learn('هل فيه ضمان على الحذاء', 'ضمان 6 شهور ضد عيوب الصناعة', { explicit: true });
  assert.equal(searchKnowledge('الحذاء عليه ضمان؟')[0].answer, 'ضمان 6 شهور ضد عيوب الصناعة');
  updateSettings({ learning: { mode: 'review' } });
  learn('سؤال تاني عن الغسيل', 'غسيل على 30 درجة');
  assert.equal(searchKnowledge('الغسيل').length, 0); // لسه pending لحد ما توافق
  assert.equal(q.get(`SELECT COUNT(*) AS n FROM knowledge WHERE status='pending'`).n, 1);
});
