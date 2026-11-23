import './helpers.js';
import { CSV } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/server.js';
import { q, updateSettings } from '../src/db.js';

let server; let base; let cookie = '';
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
};

before(async () => { server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

test('لازم تسجيل دخول، وأول مرة تعمل باسورد', async () => {
  assert.equal((await call('GET', '/api/orders')).status, 401);
  assert.deepEqual((await call('GET', '/api/auth/status')).data, { setup: false, authed: false });
  assert.equal((await call('POST', '/api/auth/setup', { password: '123' })).status, 400);
  assert.equal((await call('POST', '/api/auth/setup', { password: 'secret123' })).status, 200);
  assert.equal((await call('GET', '/api/orders')).status, 200);
  cookie = '';
  assert.equal((await call('POST', '/api/auth/login', { password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { password: 'secret123' })).status, 200);
});

test('الإعدادات: الأسرار بتتخبّى ولا تتمسح لما تحفظ من غير ما تغيّرها', async () => {
  await call('PUT', '/api/settings', { ai: { api_key: 'sk-test-123', model: 'claude-sonnet-5-5' }, business: { name: 'متجر الاختبار' } });
  const s = (await call('GET', '/api/settings')).data;
  assert.equal(s.ai.api_key, '__set__'); assert.equal(s.business.name, 'متجر الاختبار');
  await call('PUT', '/api/settings', s); // حفظ تاني بنفس القيم المخفية
  assert.equal(q.get(`SELECT value FROM settings WHERE key='ai'`).value.includes('sk-test-123'), true);
  await call('PUT', '/api/settings', { ai: { api_key: '' } });
});

test('استيراد من ملف عبر API + تعديل قسم + منتج يدوي', async () => {
  const src = (await call('POST', '/api/sources', { name: 'شيت', type: 'file' })).data;
  assert.equal((await call('POST', `/api/sources/${src.id}/file?name=p.csv`, Buffer.from(CSV), { 'content-type': 'text/csv' })).status, 200);
  const prev = (await call('GET', `/api/sources/${src.id}/preview`)).data;
  assert.equal(prev.total_rows, 4); assert.equal(prev.suggested_mapping.price, 'السعر');
  const sync = (await call('POST', `/api/sources/${src.id}/sync`)).data;
  assert.equal(sync.created, 4);
  const cats = (await call('GET', '/api/categories-with-counts')).data;
  const shoes = cats.find((c) => c.name === 'أحذية');
  await call('PUT', `/api/categories/${shoes.id}`, { instructions: 'اسأل عن المقاس الأوروبي', required_fields: ['المقاس'] });
  const p = (await call('POST', '/api/products', { name: 'منتج يدوي', price: 10, category_id: shoes.id, attributes: { خامة: 'جلد' } })).data;
  assert.equal(p.attributes['خامة'], 'جلد');
  const prompt = (await call('GET', '/api/prompt-preview')).data.prompt;
  assert.match(prompt, /اسأل عن المقاس الأوروبي/); // تعليمات القسم بتدخل البرومبت
});

test('وضع تجريبي: رسالة من المحاكي ترجع برد', async () => {
  updateSettings({ bot: { debounce_ms: 0 }, ai: { provider: 'mock' } });
  const { registerJobs } = await import('../src/server.js'); registerJobs();
  const { startWorker, stopWorker } = await import('../src/queue.js'); startWorker();
  const r = (await call('POST', '/api/sim/message', { session: 'a1', text: 'عايز حذاء' })).data;
  let msgs = [];
  for (let i = 0; i < 40 && msgs.filter((m) => m.direction === 'out').length < 1; i++) {
    await new Promise((x) => setTimeout(x, 150));
    msgs = (await call('GET', `/api/conversations/${r.conversation_id}`)).data.messages;
  }
  assert.ok(msgs.some((m) => m.direction === 'out' && /900/.test(m.text)));
  stopWorker();
});

test('Webhook ميتا: تحقق + توقيع + رسائل ماسنجر وواتساب + منع التكرار', async () => {
  updateSettings({ bot: { enabled: false }, channels: { app_secret: 'shh', verify_code: 'vc1', messenger: { enabled: true }, whatsapp: { enabled: true } } });
  assert.equal((await call('GET', '/webhooks/meta?hub.mode=subscribe&hub.verify_token=vc1&hub.challenge=777')).data, '777');
  assert.equal((await call('GET', '/webhooks/meta?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=777')).status, 403);

  const post = (obj, sign = true) => {
    const raw = JSON.stringify(obj);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'shh').update(raw).digest('hex');
    return call('POST', '/webhooks/meta', raw, sign ? { 'x-hub-signature-256': sig } : {});
  };
  const fb = { object: 'page', entry: [{ messaging: [{ sender: { id: 'PSID1' }, recipient: { id: 'PAGE' }, message: { mid: 'm.1', text: 'مرحبا' } }] }] };
  assert.equal((await post(fb, false)).status, 401);
  assert.equal((await post(fb)).status, 200);
  await post(fb); // نفس الرسالة تاني
  await new Promise((r) => setTimeout(r, 300));
  const conv = q.get(`SELECT * FROM conversations WHERE channel='messenger' AND external_id='PSID1'`);
  assert.ok(conv);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?', conv.id).n, 1); // مفيش تكرار

  const wa = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ wa_id: '201012345678', profile: { name: 'منى' } }], messages: [{ from: '201012345678', id: 'wamid.1', type: 'text', text: { body: 'السلام عليكم' } }] } }] }] };
  assert.equal((await post(wa)).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const wc = q.get(`SELECT * FROM conversations WHERE channel='whatsapp'`);
  assert.equal(wc.display_name, 'منى');
});

test('تصدير الأوردرات CSV / XLSX', async () => {
  const csv = await call('GET', '/api/orders/export.csv');
  assert.equal(csv.status, 200); assert.match(csv.data, /رقم الأوردر/);
  const x = await fetch(base + '/api/orders/export.xlsx', { headers: { cookie } });
  assert.equal(x.status, 200); assert.equal((await x.arrayBuffer()).byteLength > 1000, true);
});
