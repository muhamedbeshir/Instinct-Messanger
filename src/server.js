import path from 'node:path';
import express from 'express';
import { ROOT, PORT, DATA_DIR } from './config.js';
import { tenantDir, runInTenant } from './tenancy.js';
import { q, getSetting } from './db.js';
import * as logger from './logger.js';
import * as auth from './auth.js';
import { authRouter } from './routes/auth.js';
import { admin } from './routes/admin.js';
import { api } from './routes/api.js';
import { registerHandler, startWorker, queueStats } from './queue.js';
import { respond, replyFailed } from './ai/agent.js';
import { platformAiStatus } from './ai/config.js';
import { retrySend, deliver } from './channels/index.js';
import { handleWebhook, verifySignature, verifyChallenge } from './channels/meta.js';
import { notifyOrder, exportOrder, alertOwner } from './notify.js';
import { startSourceScheduler } from './importer.js';
import { getOrder } from './orders.js';
import { tenantBySlug, tenantInfo, metaConfig, tenantForLink } from './platform.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    next();
  });
  app.use(express.json({ limit: '5mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // صور المنتجات: عامة (ميتا لازم توصلها) لكن كل عميل في مجلده
  app.get('/media/:tid/:file', (req, res) => {
    const tid = Number(req.params.tid);
    if (!Number.isInteger(tid) || tid < 1) return res.status(404).end();
    res.sendFile(path.basename(req.params.file), { root: path.join(tenantDir(tid), 'uploads'), maxAge: '7d', dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  // Webhook مركزي واحد (تطبيق ميتا المنصة): بيوزّع كل حدث على المتجر صاحب الصفحة/الحساب/رقم واتساب
  app.get('/webhooks/meta', (req, res) => {
    const m = metaConfig();
    return req.query['hub.mode'] === 'subscribe' && m.verify_code && req.query['hub.verify_token'] === m.verify_code ? res.status(200).send(String(req.query['hub.challenge'])) : res.sendStatus(403);
  });
  app.post('/webhooks/meta', (req, res) => {
    const m = metaConfig();
    if (!m.app_secret || !verifySignature(req.rawBody || Buffer.from(''), req.get('x-hub-signature-256'), m.app_secret)) return res.sendStatus(401);
    res.sendStatus(200);
    routeCentralWebhook(req.body).catch((e) => logger.error('webhook', e.message, e));
  });

  // Meta webhook: لكل متجر رابط خاص بيه (/webhooks/meta/<slug>) وبياناته وتوكناته الخاصة
  app.get('/webhooks/meta/:slug', (req, res) => {
    const t = tenantBySlug(req.params.slug);
    if (!t) return res.sendStatus(404);
    runInTenant(t.id, () => {
      const challenge = verifyChallenge(req.query);
      challenge !== null ? res.status(200).send(challenge) : res.sendStatus(403);
    });
  });
  app.post('/webhooks/meta/:slug', (req, res) => {
    const t = tenantBySlug(req.params.slug);
    if (!t) return res.sendStatus(404);
    runInTenant(t.id, () => {
      if (!verifySignature(req.rawBody || Buffer.from(''), req.get('x-hub-signature-256'))) return res.sendStatus(401);
      res.sendStatus(200); // نرد بسرعة، والشغل بيتم في الخلفية (Meta بتعيد الإرسال لو اتأخرنا)
      handleWebhook(req.body).catch((e) => logger.error('webhook', e.message, e));
    });
  });

  app.use('/api', auth.attach);
  app.use('/api', authRouter);
  app.use('/api/admin', admin);
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  app.get('/signup', (req, res) => res.redirect('/app/#/signup'));
  app.get('/login', (req, res) => res.redirect('/app/'));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  return app;
}

/** يقسّم الحدث لكل متجر ويشغّله جوه سياقه. أي حساب مش مربوط بيتجاهل. */
export async function routeCentralWebhook(body) {
  const channel = { page: 'messenger', instagram: 'instagram', whatsapp_business_account: 'whatsapp' }[body?.object];
  if (!channel) return;
  for (const entry of body.entry || []) {
    const parts = channel === 'whatsapp'
      ? (entry.changes || []).map((ch) => ({ id: ch.value?.metadata?.phone_number_id, entry: { ...entry, changes: [ch] } }))
      : [{ id: entry.id, entry }];
    for (const part of parts) {
      const tid = part.id ? tenantForLink(channel, part.id) : null;
      if (tid == null) { logger.info('webhook', `حدث لحساب غير مربوط (${channel} ${part.id})`); continue; }
      await runInTenant(tid, () => handleWebhook({ object: body.object, entry: [part.entry] }));
    }
  }
}

export function registerJobs() {
  registerHandler('reply', (_p, job) => respond(job.conversation_id), { onFail: replyFailed, timeoutMs: 180000 });
  registerHandler('send', (p) => retrySend(p), { onFail: (p) => { logger.error('send', `إرسال الرسالة ${p.message_id} فشل نهائيًا`); alertOwner(`⚠️ رسالة ما اتبعتش للعميل (id ${p.message_id}). راجع صفحة الحالة.`); } });
  registerHandler('order_notify', (p) => notifyOrder(p));
  registerHandler('order_export', (p) => exportOrder(p), { onFail: (p) => alertOwner(`⚠️ تعذّر إرسال الأوردر ${getOrder(p.order_id)?.number} للـ webhook/الشيت. تقدر تعيد المحاولة من صفحة الطلبات.`) });
  registerHandler('alert_owner', (p) => alertOwner(p.text));
  registerHandler('status_notify', async (p) => {
    const o = getOrder(p.order_id);
    const tpl = getSetting('notifications.status_messages', {})[o?.status];
    if (o?.conversation_id && tpl) await deliver(o.conversation_id, { text: tpl.replace('{number}', o.number), sender: 'bot' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  auth.ensureSuperadmin((m) => logger.warn('boot', m));
  registerJobs();
  startWorker();
  startSourceScheduler();
  createApp().listen(PORT, () => {
    logger.info('server', `شغال على http://localhost:${PORT}  (بيانات: ${DATA_DIR})`);
    const ai = platformAiStatus();
    if (ai.provider === 'mock') logger.warn('server', 'مفيش مفتاح Claude على المنصة: الوضع التجريبي فقط. ضيف المفتاح من /admin ← إعدادات المنصة.');
  });
  process.on('unhandledRejection', (e) => logger.error('process', `unhandledRejection: ${e?.message || e}`, e));
}
void q; void queueStats; void tenantInfo;
