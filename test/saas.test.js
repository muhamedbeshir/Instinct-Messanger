import './helpers.js';
import { CSV } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp, registerJobs } from '../src/server.js';
import { startWorker, stopWorker } from '../src/queue.js';
import { createUser } from '../src/auth.js';
import { setPlatformSettings, listPlans, savePlan, pq, usageOf } from '../src/platform.js';
import { runInTenant } from '../src/tenancy.js';
import { q, getSettings } from '../src/db.js';

let server; let base;
class Client {
  constructor() { this.cookie = ''; }
  async call(method, path, body, headers = {}) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: this.cookie, ...headers }, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  }
  get = (p) => this.call('GET', p); post = (p, b) => this.call('POST', p, b ?? {}); put = (p, b) => this.call('PUT', p, b); patch = (p, b) => this.call('PATCH', p, b); del = (p, b) => this.call('DELETE', p, b ?? {});
}
const A = new Client(); const B = new Client(); const SA = new Client(); const STAFF = new Client();

before(async () => {
  registerJobs(); startWorker();
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
  setPlatformSettings({ ai: { provider: 'mock' } });
  createUser({ email: 'root@platform.test', role: 'superadmin', password: 'rootpass123' });
});
after(() => { stopWorker(); server.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(120); } return null; }

test('تسجيل متجرين: كل واحد بقاعدة بيانات وباقة تجريبية', async () => {
  assert.equal((await A.post('/api/auth/signup', { businessName: 'متجر أ', email: 'a@shop.test', password: '123' })).status, 400); // باسورد ضعيف
  const a = await A.post('/api/auth/signup', { businessName: 'متجر أ', email: 'a@shop.test', password: 'password-a1' });
  assert.equal(a.status, 200); assert.equal(a.data.home, '/app/');
  assert.equal((await B.post('/api/auth/signup', { businessName: 'متجر ب', email: 'b@shop.test', password: 'password-b1' })).status, 200);
  assert.equal((await B.post('/api/auth/signup', { businessName: 'x', email: 'a@shop.test', password: 'password-b1' })).status, 400); // إيميل مكرر
  const me = (await A.get('/api/me')).data;
  assert.equal(me.role, 'owner'); assert.equal(me.tenant.plan.slug, 'trial'); assert.equal(me.tenant.days_left, 14);
  assert.equal((await A.get('/api/settings')).data.business.name, 'متجر أ');
});

test('عزل كامل: داتا متجر ما بتظهرش لمتجر تاني', async () => {
  const cat = (await A.post('/api/categories', { name: 'قسم أ' })).data;
  const p = await A.post('/api/products', { name: 'منتج سري لمتجر أ', price: 10, category_id: cat.id });
  assert.equal(p.status, 200);
  assert.equal((await A.get('/api/products')).data.total, 1);
  assert.equal((await B.get('/api/products')).data.total, 0);
  assert.equal((await B.get(`/api/products/${p.data.id}`)).status, 404);
  assert.equal((await B.get('/api/categories-with-counts')).data.some((c) => c.name === 'قسم أ'), false);
  assert.equal((await B.get('/api/settings')).data.business.name, 'متجر ب');
});

test('إخفاء الحاجات الداخلية عن العميل (بالسيرفر)', async () => {
  const s = (await A.get('/api/settings')).data;
  assert.equal('ai' in s, false); assert.equal('max_tool_rounds' in s.bot, false); assert.equal('debounce_ms' in s.bot, false);
  // محاولة تعديل مخفي: تتجاهل
  await A.put('/api/settings', { ai: { api_key: 'sk-hack', model: 'x' }, bot: { max_tool_rounds: 99 }, business: { name: 'متجر أ (معدّل)' } });
  const tid = pq.get(`SELECT id FROM tenants WHERE name LIKE 'متجر أ%'`).id;
  const stored = runInTenant(tid, () => getSettings());
  assert.equal(stored.business.name, 'متجر أ (معدّل)'); assert.notEqual(stored.ai.api_key, 'sk-hack'); assert.notEqual(stored.bot.max_tool_rounds, 99);
  // البرومبت: القواعد الأمنية مخفية والصحة مبسّطة والسجلات ممنوعة
  const prev = (await A.get('/api/prompt-preview')).data;
  assert.doesNotMatch(prev.prompt, /HARD RULES/); assert.equal('provider' in prev, false);
  const h = (await A.get('/api/health')).data;
  assert.equal('provider' in h, false); assert.equal('recent_errors' in h, false); assert.equal('model' in h, false);
  assert.equal((await A.get('/api/logs')).status, 403);
});

test('صلاحيات: العميل مش داخل لوحة الأدمن، والموظف محدود', async () => {
  assert.equal((await A.get('/api/admin/stats')).status, 403);
  assert.equal((await new Client().get('/api/admin/stats')).status, 401);
  assert.equal((await new Client().get('/api/orders')).status, 401);
  const t = await A.post('/api/team', { email: 'staff@shop.test', name: 'موظف', password: 'staff-pass-1' });
  assert.equal(t.status, 200); assert.equal(t.data.role, 'staff');
  assert.equal((await A.post('/api/team', { email: 'staff2@shop.test', password: 'staff-pass-2' })).status, 402); // حد الباقة التجريبية = موظف واحد
  assert.equal((await STAFF.post('/api/auth/login', { email: 'staff@shop.test', password: 'staff-pass-1' })).status, 200);
  assert.equal((await STAFF.get('/api/orders')).status, 200);
  assert.equal((await STAFF.get('/api/conversations')).status, 200);
  assert.equal((await STAFF.get('/api/settings')).status, 403);
  assert.equal((await STAFF.post('/api/products', { name: 'x', price: 1 })).status, 403);
  assert.equal((await STAFF.get('/api/team')).status, 403);
  assert.equal((await STAFF.get('/api/billing')).status, 403);
  assert.equal((await STAFF.put('/api/settings', { business: { name: 'اختراق' } })).status, 403);
});

test('حدود الباقة: المنتجات والقنوات', async () => {
  const sa = await SA.post('/api/auth/login', { email: 'root@platform.test', password: 'rootpass123' });
  assert.equal(sa.data.home, '/admin/');
  const trial = listPlans().find((p) => p.slug === 'trial');
  assert.equal((await SA.put(`/api/admin/plans/${trial.id}`, { ...trial, limits: { ...trial.limits, products: 2, ai_replies: 2, channels: 1 } })).status, 200);
  assert.equal((await A.post('/api/products', { name: 'منتج 2', price: 1 })).status, 200);
  const third = await A.post('/api/products', { name: 'منتج 3', price: 1 });
  assert.equal(third.status, 400); assert.match(third.data.error, /أقصى/);
  const ch = await A.put('/api/settings', { channels: { messenger: { enabled: true }, instagram: { enabled: true } } });
  assert.equal(ch.status, 402); assert.match(ch.data.error, /قناة/);
  assert.equal((await A.put('/api/settings', { channels: { messenger: { enabled: true } } })).status, 200);
});

test('كوتا الردود الذكية: بعد الحد البوت يحوّل لك ويتسجل الاستهلاك', async () => {
  const tid = pq.get(`SELECT id FROM tenants WHERE name LIKE 'متجر أ%'`).id;
  const say = async (session, text) => { const r = await A.post('/api/sim/message', { session, text }); return r.data.conversation_id; };
  const c1 = await say('q1', 'سلام');
  assert.ok(await waitFor(async () => (await A.get(`/api/conversations/${c1}`)).data.messages.some((m) => m.direction === 'out')));
  const c2 = await say('q2', 'سلام');
  assert.ok(await waitFor(async () => (await A.get(`/api/conversations/${c2}`)).data.messages.some((m) => m.direction === 'out')));
  assert.equal(usageOf(tid).ai_replies, 2);
  const c3 = await say('q3', 'سلام تاني');
  const got = await waitFor(async () => (await A.get(`/api/conversations/${c3}`)).data);
  await sleep(1500);
  const d = (await A.get(`/api/conversations/${c3}`)).data;
  assert.equal(d.conversation.needs_human, 1); assert.equal(d.conversation.needs_human_reason, 'quota');
  assert.equal(usageOf(tid).ai_replies, 2); // ما اتحسبش رد جديد
  void got;
});

test('الـ trace الداخلي مخفي عن العميل ومعروض للأدمن (الدخول كعميل)', async () => {
  const c = (await A.get('/api/conversations')).data.find((x) => x.external_id === 'q1');
  const mine = (await A.get(`/api/conversations/${c.id}`)).data.messages.find((m) => m.sender === 'bot');
  assert.equal(mine.meta.trace, undefined); assert.equal(mine.meta.provider, undefined);
  const tid = pq.get(`SELECT id FROM tenants WHERE name LIKE 'متجر أ%'`).id;
  const imp = await SA.post(`/api/admin/tenants/${tid}/impersonate`);
  assert.equal(imp.data.home, '/app/');
  const me = (await SA.get('/api/me')).data;
  assert.equal(me.impersonating, true); assert.equal(me.platform_admin, true);
  const adminView = (await SA.get(`/api/conversations/${c.id}`)).data.messages.find((m) => m.sender === 'bot');
  assert.ok(adminView.meta.provider); // الأدمن بيشوف التفاصيل
  assert.equal('ai' in (await SA.get('/api/settings')).data, true);
  const back = await SA.post('/api/auth/stop-impersonating');
  assert.equal(back.data.home, '/admin/');
  assert.equal((await SA.get('/api/admin/stats')).status, 200);
});

test('الاشتراك: إيقاف العميل يمنع التعديل ويوقف البوت، والدفع يفعّله', async () => {
  const tidB = pq.get(`SELECT id FROM tenants WHERE name LIKE 'متجر ب%'`).id;
  assert.equal((await SA.patch(`/api/admin/tenants/${tidB}`, { status: 'suspended' })).status, 200);
  await sleep(50);
  const { invalidateTenant } = await import('../src/platform.js'); invalidateTenant(tidB);
  const w = await B.post('/api/products', { name: 'x', price: 1 });
  assert.equal(w.status, 402); assert.equal(w.data.code, 'suspended');
  assert.equal((await B.get('/api/orders')).status, 200); // قراءة فقط
  assert.equal((await B.get('/api/me')).data.tenant.status, 'suspended');
  // دفعة مسجّلة ترجّعه
  const starter = listPlans().find((p) => p.slug === 'starter');
  await SA.patch(`/api/admin/tenants/${tidB}`, { status: 'active' });
  const pay = await SA.post(`/api/admin/tenants/${tidB}/payments`, { amount: 299, method: 'InstaPay', reference: 'T1', months: 2, plan_id: starter.id });
  assert.equal(pay.status, 200); assert.equal(pay.data.plan.slug, 'starter'); assert.equal(pay.data.status, 'active');
  assert.ok(pay.data.days_left >= 59);
  assert.equal((await B.post('/api/products', { name: 'منتج بعد الدفع', price: 1 })).status, 200);
});

test('اشتراك منتهي: تجريبي بعد 14 يوم ← expired وبدون ردود', async () => {
  const tid = pq.get(`SELECT id FROM tenants WHERE name LIKE 'متجر أ%'`).id;
  await SA.patch(`/api/admin/tenants/${tid}`, { trial_ends: Date.now() - 1000 });
  const me = (await A.get('/api/me')).data;
  assert.equal(me.tenant.status, 'expired');
  assert.equal((await A.post('/api/products', { name: 'y', price: 1 })).status, 402);
  const up = await A.post('/api/billing/upgrade', { plan_id: listPlans().find((p) => p.slug === 'pro').id, note: 'عايز أرقّي' });
  assert.equal(up.status, 200); // الترقية مسموحة حتى لو منتهي
  assert.equal((await SA.get('/api/admin/upgrade-requests')).data.length >= 1, true);
  await SA.patch(`/api/admin/tenants/${tid}`, { trial_ends: Date.now() + 5 * 86400000 });
});

test('Webhook ميتا لكل متجر: كود التحقق والتوقيع منفصلين', async () => {
  const tA = pq.get(`SELECT slug,id FROM tenants WHERE name LIKE 'متجر أ%'`); const tB = pq.get(`SELECT slug,id FROM tenants WHERE name LIKE 'متجر ب%'`);
  const vcA = runInTenant(tA.id, () => getSettings().channels.verify_code); const vcB = runInTenant(tB.id, () => getSettings().channels.verify_code);
  assert.notEqual(vcA, vcB);
  const raw = new Client();
  assert.equal((await raw.get(`/webhooks/meta/${tA.slug}?hub.mode=subscribe&hub.verify_token=${vcA}&hub.challenge=55`)).data, '55');
  assert.equal((await raw.get(`/webhooks/meta/${tA.slug}?hub.mode=subscribe&hub.verify_token=${vcB}&hub.challenge=55`)).status, 403);
  assert.equal((await raw.get('/webhooks/meta/nope?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status, 404);
  // رسالة ماسنجر لمتجر أ تدخل قاعدته هو بس
  await A.put('/api/settings', { channels: { app_secret: 'shh', messenger: { enabled: true } }, bot: { enabled: false } });
  const body = JSON.stringify({ object: 'page', entry: [{ messaging: [{ sender: { id: 'PSID9' }, recipient: { id: 'P' }, message: { mid: 'm.9', text: 'مرحبا' } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'shh').update(body).digest('hex');
  assert.equal((await raw.call('POST', `/webhooks/meta/${tA.slug}`, body, { 'x-hub-signature-256': 'sha256=bad' })).status, 401);
  assert.equal((await raw.call('POST', `/webhooks/meta/${tA.slug}`, body, { 'x-hub-signature-256': sig })).status, 200);
  assert.ok(await waitFor(() => runInTenant(tA.id, () => q.get(`SELECT 1 FROM conversations WHERE external_id='PSID9'`))));
  assert.equal(runInTenant(tB.id, () => q.get(`SELECT 1 FROM conversations WHERE external_id='PSID9'`)), undefined);
});

test('لوحة الأدمن: إحصائيات، عملاء، إعدادات المنصة (المفتاح مخفي)، إنشاء عميل، حذفه', async () => {
  const st = (await SA.get('/api/admin/stats')).data;
  assert.equal(st.tenants_total, 2); assert.ok(st.usage.ai >= 2); assert.ok(st.mrr >= 299);
  assert.equal((await SA.get('/api/admin/tenants?q=shop.test')).data.length, 2);
  await SA.put('/api/admin/settings', { ai: { api_key: 'sk-platform-secret' }, announcement: { text: 'صيانة الجمعة', level: 'warn' } });
  assert.equal((await SA.get('/api/admin/settings')).data.ai.api_key, '__set__');
  await SA.put('/api/admin/settings', await SA.get('/api/admin/settings').then((r) => r.data)); // حفظ بدون تغيير ما يمسحش المفتاح
  assert.equal(pq.get(`SELECT value FROM pset WHERE key='ai'`).value.includes('sk-platform-secret'), true);
  assert.equal((await A.get('/api/me')).data.announcement.text, 'صيانة الجمعة');
  assert.equal(JSON.stringify((await A.get('/api/me')).data).includes('sk-platform-secret'), false);
  const nt = (await SA.post('/api/admin/tenants', { name: 'متجر جديد', owner_email: 'new@shop.test', owner_password: 'new-pass-123', plan_slug: 'starter' })).data;
  assert.equal(nt.plan.slug, 'starter');
  assert.equal((await SA.del(`/api/admin/tenants/${nt.id}`, { confirm: 'wrong' })).status, 400);
  assert.equal((await SA.del(`/api/admin/tenants/${nt.id}`, { confirm: nt.slug })).status, 200);
  assert.equal((await SA.get('/api/admin/audit')).data.length > 5, true);
  setPlatformSettings({ ai: { api_key: '' } });
});

test('تسجيل مقفول من الأدمن، والباقات العامة بتظهر', async () => {
  setPlatformSettings({ signup: { open: false } });
  assert.equal((await new Client().post('/api/auth/signup', { businessName: 'محاولة', email: 'z@shop.test', password: 'password-z1' })).status, 400);
  setPlatformSettings({ signup: { open: true } });
  const plans = (await new Client().get('/api/plans')).data;
  assert.equal(plans.length, 4); assert.equal(plans.some((p) => 'id' in p), false);
});

test('استيراد منتجات يحترم عزل العميل وحد الباقة', async () => {
  const src = (await B.post('/api/sources', { name: 'شيت', type: 'file' })).data;
  await B.call('POST', `/api/sources/${src.id}/file?name=p.csv`, Buffer.from(CSV), { 'content-type': 'text/csv' });
  const sync = (await B.post(`/api/sources/${src.id}/sync`)).data;
  assert.equal(sync.created, 4);
  assert.equal((await A.get('/api/products?q=حذاء')).data.total, 0);
});

test('الصفحات العامة: هبوط ولوحة المتجر ولوحة الإدارة وملفات التصميم', async () => {
  const raw = new Client();
  const home = await raw.get('/'); assert.equal(home.status, 200); assert.match(home.data, /dir="rtl"/); assert.match(home.data, /\/app\/#\/signup/);
  assert.equal((await raw.get('/app/')).status, 200); assert.equal((await raw.get('/admin/')).status, 200);
  assert.equal((await raw.get('/shared/base.css')).status, 200); assert.equal((await raw.get('/assets/system.css')).status, 200);
  assert.equal((await raw.get('/webhooks/meta')).status, 404);
  const hdr = await fetch(base + '/'); assert.equal(hdr.headers.get('x-frame-options'), 'DENY'); assert.equal(hdr.headers.get('x-content-type-options'), 'nosniff');
});
