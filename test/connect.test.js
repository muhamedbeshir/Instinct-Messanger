import './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

/** سيرفر Graph API مزيّف: بيسجّل الطلبات ويرد زي ميتا (تبديل الكود، الصفحات، الاشتراك في الـ webhook) */
const calls = [];
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); calls.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname.endsWith('/oauth/access_token')) {
    const code = url.searchParams.get('code');
    if (url.searchParams.get('client_secret') !== 'app-secret') return send({ error: { message: 'bad secret' } }, 400);
    return code === 'bad' ? send({ error: { message: 'Invalid verification code' } }, 400) : send({ access_token: `tok-${code}` });
  }
  if (url.pathname.endsWith('/me/accounts')) {
    return send({ data: [{ id: 'PG1', name: 'صفحة الأناقة', access_token: 'page-token-1', instagram_business_account: { id: 'IG1', username: 'elegance_eg' } }, { id: 'PG2', name: 'صفحة تانية', access_token: 'page-token-2' }] });
  }
  if (url.pathname.endsWith('/subscribed_apps')) return send({ success: true });
  send({ error: { message: 'unexpected ' + url.pathname } }, 404);
});

let server; let base;
class Client {
  constructor() { this.cookie = ''; }
  async call(method, path, body, headers = {}) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: this.cookie, ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  }
  get = (p) => this.call('GET', p); post = (p, b) => this.call('POST', p, b ?? {});
}
const A = new Client(); const B = new Client(); const SA = new Client();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');

before(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.META_GRAPH_BASE = `http://127.0.0.1:${fake.address().port}`;
  const { createApp, registerJobs } = await import('../src/server.js');
  const { createUser } = await import('../src/auth.js');
  const { setPlatformSettings } = await import('../src/platform.js');
  registerJobs();
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
  createUser({ email: 'root@platform.test', role: 'superadmin', password: 'rootpass123' });
  setPlatformSettings({ ai: { provider: 'mock' } });
  const { listPlans, savePlan } = await import('../src/platform.js');
  const trial = listPlans().find((p) => p.slug === 'trial'); savePlan({ ...trial, limits: { ...trial.limits, channels: 3 } }, trial.id);
  await SA.post('/api/auth/login', { email: 'root@platform.test', password: 'rootpass123' });
  await A.post('/api/auth/signup', { businessName: 'متجر أ', email: 'a@c.test', password: 'password-a1' });
  await B.post('/api/auth/signup', { businessName: 'متجر ب', email: 'b@c.test', password: 'password-b1' });
});
after(() => { server.close(); fake.close(); });

test('الربط السريع مقفول لحد ما الأدمن يضبط تطبيق ميتا، وإعدادات ميتا مخفية عن العميل', async () => {
  assert.equal((await A.get('/api/connect/info')).data.available, false);
  assert.equal((await A.post('/api/connect/pages', { code: 'x' })).status, 400);
  assert.equal((await SA.call('PUT', '/api/admin/settings', { meta: { app_id: '1234', app_secret: 'app-secret', config_id_whatsapp: 'cfgW', config_id_messenger: 'cfgM' } })).status, 200);
  const info = (await A.get('/api/connect/info')).data;
  assert.equal(info.available, true); assert.equal(info.app_id, '1234'); assert.equal(info.config_id_whatsapp, 'cfgW');
  assert.equal(JSON.stringify(info).includes('app-secret'), false); // السر ما بيوصلش للعميل
  const admin = (await SA.get('/api/admin/settings')).data;
  assert.equal(admin.meta.app_secret, '__set__'); assert.ok(admin.meta.verify_code);
  await SA.call('PUT', '/api/admin/settings', admin); // حفظ بدون تغيير ما يمسحش السر
  assert.equal((await A.get('/api/connect/info')).data.available, true);
});

test('ماسنجر + إنستجرام: كود ← صفحات ← ربط، والتوكن ما بيمرّش على المتصفح', async () => {
  assert.equal((await A.post('/api/connect/pages', { code: 'bad' })).status, 400);
  const pg = (await A.post('/api/connect/pages', { code: 'u1' })).data;
  assert.equal(pg.pages.length, 2); assert.equal(pg.pages[0].instagram.username, 'elegance_eg');
  assert.equal(JSON.stringify(pg).includes('page-token'), false);
  assert.equal((await B.post('/api/connect/page', { ticket: pg.ticket, page_id: 'PG1' })).status, 400); // تذكرة متجر تاني ممنوعة
  const r = await A.post('/api/connect/page', { ticket: pg.ticket, page_id: 'PG1' });
  assert.equal(r.status, 200); assert.equal(r.data.messenger, 'صفحة الأناقة'); assert.equal(r.data.instagram, 'elegance_eg');
  assert.ok(calls.some((c) => c.startsWith('POST /v21.0/PG1/subscribed_apps') && c.includes('messages')));
  const links = (await A.get('/api/connect/info')).data.links.map((l) => l.channel).sort();
  assert.deepEqual(links, ['instagram', 'messenger']);
  const st = (await A.get('/api/settings')).data.channels;
  assert.equal(st.messenger.enabled, true); assert.equal(st.messenger.page_access_token, '__set__'); // مخفي حتى عن العميل نفسه
  assert.equal((await A.post('/api/connect/page', { ticket: pg.ticket, page_id: 'PG1' })).status, 400); // التذكرة اتحرقت
});

test('نفس الصفحة ما تتربطش بمتجرين (مفيش خطف)', async () => {
  const pg = (await B.post('/api/connect/pages', { code: 'u2' })).data;
  const r = await B.post('/api/connect/page', { ticket: pg.ticket, page_id: 'PG1' });
  assert.equal(r.status, 400); assert.match(r.data.error, /متجر تاني/);
  assert.equal((await B.get('/api/connect/info')).data.links.length, 0);
});

test('واتساب: Embedded Signup ← تبديل الكود وربط الرقم والاشتراك', async () => {
  assert.equal((await A.post('/api/connect/whatsapp', { code: 'w1' })).status, 400); // بيانات ناقصة
  const r = await A.post('/api/connect/whatsapp', { code: 'w1', waba_id: 'WABA1', phone_number_id: 'PN1' });
  assert.equal(r.status, 200);
  assert.ok(calls.some((c) => c.startsWith('POST /v21.0/WABA1/subscribed_apps')));
  assert.equal((await B.post('/api/connect/whatsapp', { code: 'w2', waba_id: 'W2', phone_number_id: 'PN1' })).status, 400); // الرقم مربوط بمتجر أ
  assert.equal((await B.post('/api/connect/whatsapp', { code: 'w2', waba_id: 'WABA2', phone_number_id: 'PN2' })).status, 200);
});

test('الـ Webhook المركزي: بيوزّع على المتجر الصح، ويرفض التوقيع الغلط، ويتجاهل الحسابات غير المربوطة', async () => {
  const { runInTenant } = await import('../src/tenancy.js');
  const { q } = await import('../src/db.js');
  const { pq, metaConfig } = await import('../src/platform.js');
  const tA = pq.get(`SELECT id FROM tenants WHERE name='متجر أ'`).id; const tB = pq.get(`SELECT id FROM tenants WHERE name='متجر ب'`).id;
  for (const id of [tA, tB]) runInTenant(id, () => q.run(`INSERT OR REPLACE INTO settings(key,value) VALUES('bot','{"enabled":false}')`));
  const { getSettings } = await import('../src/db.js'); void getSettings;

  const raw = new Client();
  const vc = metaConfig().verify_code;
  assert.equal((await raw.get(`/webhooks/meta?hub.mode=subscribe&hub.verify_token=${vc}&hub.challenge=99`)).data, '99');
  assert.equal((await raw.get('/webhooks/meta?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=99')).status, 403);

  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [
    { field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: '201011111111', profile: { name: 'منى' } }], messages: [{ from: '201011111111', id: 'wamid.A', type: 'text', text: { body: 'مرحبا من أ' } }] } },
    { field: 'messages', value: { metadata: { phone_number_id: 'PN2' }, contacts: [{ wa_id: '201022222222', profile: { name: 'سارة' } }], messages: [{ from: '201022222222', id: 'wamid.B', type: 'text', text: { body: 'مرحبا من ب' } }] } },
    { field: 'messages', value: { metadata: { phone_number_id: 'UNKNOWN' }, messages: [{ from: '2010', id: 'wamid.C', type: 'text', text: { body: 'غريب' } }] } },
  ] }] });
  assert.equal((await raw.call('POST', '/webhooks/meta', body, { 'x-hub-signature-256': 'sha256=bad' })).status, 401);
  assert.equal((await raw.call('POST', '/webhooks/meta', body, { 'x-hub-signature-256': sign(body) })).status, 200);
  await sleep(500);
  const inA = runInTenant(tA, () => q.all(`SELECT text FROM messages`)).map((m) => m.text);
  const inB = runInTenant(tB, () => q.all(`SELECT text FROM messages`)).map((m) => m.text);
  assert.deepEqual(inA, ['مرحبا من أ']); assert.deepEqual(inB, ['مرحبا من ب']); // كل متجر شاف رسالته بس

  const fb = JSON.stringify({ object: 'page', entry: [{ id: 'PG1', messaging: [{ sender: { id: 'PSID1' }, recipient: { id: 'PG1' }, message: { mid: 'm.1', text: 'ماسنجر' } }] }] });
  assert.equal((await raw.call('POST', '/webhooks/meta', fb, { 'x-hub-signature-256': sign(fb) })).status, 200);
  await sleep(400);
  assert.ok(runInTenant(tA, () => q.get(`SELECT 1 FROM conversations WHERE channel='messenger' AND external_id='PSID1'`)));
});

test('فصل القناة: بيمسح التوكن والربط، وبعدها الرسائل بتتجاهل', async () => {
  assert.equal((await A.post('/api/connect/disconnect', { channel: 'whatsapp' })).status, 200);
  assert.equal((await A.get('/api/connect/info')).data.links.some((l) => l.channel === 'whatsapp'), false);
  assert.equal((await A.get('/api/settings')).data.channels.whatsapp.enabled, false);
  assert.equal((await A.post('/api/connect/disconnect', { channel: 'bogus' })).status, 400);
  // الرقم بقى حر: متجر ب يقدر يربطه
  assert.equal((await B.post('/api/connect/whatsapp', { code: 'w3', waba_id: 'WABA3', phone_number_id: 'PN1' })).status, 200);
});

test('الموظف ما يقدرش يربط ولا يفصل', async () => {
  await A.post('/api/team', { email: 's@c.test', name: 's', password: 'staff-pass-1' });
  const S = new Client(); await S.post('/api/auth/login', { email: 's@c.test', password: 'staff-pass-1' });
  assert.equal((await S.get('/api/connect/info')).status, 403);
  assert.equal((await S.post('/api/connect/disconnect', { channel: 'messenger' })).status, 403);
});

test('حد القنوات في الباقة: لو الباقة بتسمح بقناة واحدة، ماسنجر بيتربط وإنستجرام بيتخطّى', async () => {
  const { listPlans, savePlan, invalidateTenant, allTenantIds } = await import('../src/platform.js');
  const trial = listPlans().find((p) => p.slug === 'trial'); savePlan({ ...trial, limits: { ...trial.limits, channels: 1 } }, trial.id);
  for (const id of allTenantIds()) invalidateTenant(id);
  const C = new Client(); await C.post('/api/auth/signup', { businessName: 'متجر ج', email: 'c@c.test', password: 'password-c1' });
  const pg = (await C.post('/api/connect/pages', { code: 'u3' })).data;
  const r = await C.post('/api/connect/page', { ticket: pg.ticket, page_id: 'PG2' });
  assert.equal(r.status, 200); assert.equal(r.data.instagram, null);
  assert.deepEqual((await C.get('/api/connect/info')).data.links.map((l) => l.channel), ['messenger']);
  const w = await C.post('/api/connect/whatsapp', { code: 'w4', waba_id: 'WABA9', phone_number_id: 'PN9' });
  assert.equal(w.status, 400); assert.match(w.data.error, /قناة/);
});
